"""The 1-second execution loop for paper trading.

Two passes per tick:
  Pass 1 — exits: every open position is evaluated against the exit rules
           in priority order, first match wins.
  Pass 2 — entries: every enabled instrument is evaluated against the
           entry gates; on green light, a position is opened on the side
           the entry-router rule picks.

State lives entirely in SQLite. The engine has zero in-memory state
between ticks. Loop body is wrapped in a broad except so a single bad
tick can never kill the thread.
"""

from __future__ import annotations

from contextlib import closing
import logging
from datetime import datetime, time as dt_time, timedelta
from typing import Any

import data_processor
import utilities as utils

from trade import broker as broker_mod
from trade import persistence, strikes

logger = logging.getLogger(__name__)


# ── Public entry point ────────────────────────────────────────────────


def tick() -> None:
    """Run one engine tick. Called by the thread loop every 1s.
    Catches any exception inside the work so the thread keeps ticking."""
    try:
        config = persistence.get_active_config()
        now = utils.now_ist()
        today = utils.today_ist()
        b = broker_mod.get_broker(config.get("mode", "paper"))
        _evaluate_exits(config, today, now, b)
        _evaluate_entries(config, today, now, b)
    except Exception as exc:  # noqa: BLE001
        logger.exception("engine tick failed")
        persistence.audit("engine_error", message=f"tick failed: {exc}")


# ── Pass 1: exits ─────────────────────────────────────────────────────


def _evaluate_exits(
    config: dict[str, Any],
    today: str,
    now: datetime,
    b: broker_mod.Broker,
) -> None:
    for position in persistence.open_positions():
        try:
            _evaluate_one_exit(position, config, today, now, b)
        except Exception as exc:  # noqa: BLE001
            logger.exception("exit evaluation failed for position %s", position.get("id"))
            persistence.audit(
                "engine_error",
                position_id=position.get("id"),
                instrument=position.get("instrument"),
                message=f"exit eval failed: {exc}",
            )


def _evaluate_one_exit(
    position: dict[str, Any],
    config: dict[str, Any],
    today: str,
    now: datetime,
    b: broker_mod.Broker,
) -> None:
    pid = int(position["id"])
    instrument = position["instrument"]
    side = position["option_type"]
    strike = float(position["strike"])
    entry_price = float(position["entry_price"])
    qty = int(position["qty"])

    ltp = strikes.latest_ltp(instrument, strike, side, today)

    # Priority 0/1: forced closes (manual + end-of-day) must fire even if the
    # live LTP feed has already stopped (e.g. right after 15:30) — otherwise a
    # position can be left dangling OPEN past the close. Fall back to the entry
    # price (neutral 0 P&L) when no quote is available.
    manual = int(position.get("manual_exit_requested") or 0) == 1
    market_close = _parse_hhmm(str(config.get("market_close_time") or "15:30"))
    eod_force = _at_or_after(now, _shift(market_close, seconds=-5))
    if manual or eod_force:
        px = ltp if ltp is not None else entry_price
        _close(position, "exit_manual" if manual else "exit_eod", px, b)
        return

    if ltp is None:
        # Normal pre-market / data-gap — skip the non-forced exit checks.
        return

    # Priority 2: configured time-based exit
    if config.get("time_exit_enabled") and config.get("time_exit_at"):
        time_exit = _parse_hhmm(str(config["time_exit_at"]))
        if _at_or_after(now, time_exit):
            _close(position, "exit_time", ltp, b)
            return

    # Priority 3: counter-crossover. The opposite-direction signal closes the
    # leg: SELL closes CE (because we entered CE on a BUY crossover), BUY
    # closes PE (because we entered PE on a SELL crossover). Pass 2 (entries)
    # will then re-open on the new side in the same tick.
    #
    # Counter-crossover closes the leg. Each position exits on a crossover of
    # its OWN source — an OI position flips on an OI counter-crossover, a
    # volume position on a volume counter-crossover. Pass 2 then re-opens that
    # source's new leg in the same tick.
    if config.get("exit_on_counter_crossover", True):
        counter = "SELL" if side == "CE" else "BUY"
        source = position.get("source") or "oi"
        latest = _source_signal(
            source, instrument, today, after_iso=position["entry_time"],
        )
        if latest and latest.get("signal") == counter:
            _close(position, "exit_crossover", ltp, b)
            return

    # Priority 4: stop loss
    sl_price = position.get("sl_price")
    if sl_price is not None and ltp <= float(sl_price):
        _close(position, "exit_sl", ltp, b)
        return

    # Priority 5: target
    target_price = position.get("target_price")
    if target_price is not None and ltp >= float(target_price):
        _close(position, "exit_target", ltp, b)
        return

    # Priority 6: trailing SL update (no exit this tick, just state)
    if config.get("trailing_sl_enabled"):
        _maybe_ratchet_tsl(position, ltp, entry_price, config)


def position_is_long_side(side: str) -> bool:
    # Paper trading buys options outright — always long. Kept as a helper in
    # case we ever support short legs.
    return True


def _oi_signal(
    instrument: str,
    date: str,
    after_iso: str | None = None,
) -> dict[str, Any] | None:
    """Latest OI crossover (BUY/SELL) for the day from computed_ticks.

    BUY  = OI diff (PE_cumm - CE_cumm) flipped -ve -> +ve  -> enter CE
    SELL = OI diff flipped +ve -> -ve                       -> enter PE
    In this engine every non-null signal IS a crossover (crossover = 1).
    after_iso restricts to crossovers strictly after that timestamp.
    """
    query = """
        SELECT timestamp, signal, oi_difference, pcr,
               ce_oi_cumm_change, pe_oi_cumm_change
        FROM computed_ticks
        WHERE instrument = ?
          AND substr(timestamp, 1, 10) = ?
          AND signal IN ('BUY', 'SELL')
          AND crossover = 1
    """
    params: list[Any] = [instrument, date]
    if after_iso:
        query += " AND timestamp > ?"
        params.append(after_iso)
    query += " ORDER BY timestamp DESC LIMIT 1"
    with closing(data_processor.connect()) as conn:
        row = conn.execute(query, tuple(params)).fetchone()
    return dict(row) if row else None


def _volume_signal(
    instrument: str,
    date: str,
    after_iso: str | None = None,
) -> dict[str, Any] | None:
    """Latest volume crossover — matches the Volume Logs tab exactly.

    get_total_volume_series returns the cross-strike day-cumulative CE/PE
    volume at each 15s fetch (total_ce_volume = CEcum(t), monotonic). The
    crossover is the sign flip of the single cumulative difference:
        vol_diff(t) = PEcum(t) - CEcum(t)
        flip to >= 0  ->  PE volume overtakes CE  -> bullish -> BUY (enter CE)
        flip to <= 0  ->  CE volume overtakes PE  -> bearish -> SELL (enter PE)
    This is sampling-independent (same at 15s or 1min) and identical to the
    Volume Logs "Vol Diff (PE-CE)" crossover column. Returns the latest flip
    (optionally restricted to after after_iso).
    """
    series = data_processor.get_total_volume_series(instrument, date)
    prev_diff: float | None = None
    last_flip: dict[str, Any] | None = None
    for row in series:
        ce_cum = utils.safe_float(row.get("total_ce_volume"), 0.0) or 0.0
        pe_cum = utils.safe_float(row.get("total_pe_volume"), 0.0) or 0.0
        vol_diff = pe_cum - ce_cum
        if prev_diff is not None:
            if prev_diff < 0 <= vol_diff:
                last_flip = {"timestamp": row["timestamp"], "signal": "BUY",
                             "vol_difference": vol_diff}
            elif prev_diff > 0 >= vol_diff:
                last_flip = {"timestamp": row["timestamp"], "signal": "SELL",
                             "vol_difference": vol_diff}
        prev_diff = vol_diff
    if last_flip is None:
        return None
    if after_iso and str(last_flip["timestamp"]) <= str(after_iso):
        return None
    # Normalise to the OI-signal shape so downstream ctx handling is uniform
    last_flip.setdefault("oi_difference", None)
    last_flip.setdefault("pcr", None)
    last_flip.setdefault("ce_oi_cumm_change", None)
    last_flip.setdefault("pe_oi_cumm_change", None)
    return last_flip


def _vwap_signal(
    instrument: str,
    date: str,
    after_iso: str | None = None,
) -> dict[str, Any] | None:
    """Latest VWAP-based directional signal for (instrument, date).

    VWAP is session-anchored at 09:15 IST and resets daily. We use the
    total-volume series (get_total_volume_series) which already holds per-tick
    CE+PE cumulative volumes and the underlying spot price at each fetch:
        TP(t) = underlying_spot_price(t)          (H=L=C=spot at tick level)
        Vol(t) = ΔCE_vol(t) + ΔPE_vol(t)        (per-tick incremental volume)
        VWAP(t) = Σ TP(i)·Vol(i) / Σ Vol(i)      (session cumulative)

    Signal (live from 09:15:00 — no warm-up gate; the first tick has
    VWAP == spot so it naturally sits inside the band → NEUTRAL):
        spot > VWAP + 0.05%  →  BUY   (enter CE)
        spot < VWAP − 0.05%  →  SELL  (enter PE)
        else                 →  NEUTRAL (no signal)

    Returns the most recent BUY or SELL state (not a flip — the current
    directional position), optionally restricted to signals after after_iso.
    This mirrors how the trade engine reads OI: "what is the current signal
    direction?" rather than "when did it last flip?".
    """
    BAND_PCT = 0.0005    # 0.05% band around VWAP

    series = data_processor.get_total_volume_series(instrument, date)
    if not series:
        return None

    cum_pv = 0.0
    cum_vol = 0.0
    prev_ce_cum: float | None = None
    prev_pe_cum: float | None = None
    last_signal: dict[str, Any] | None = None

    for row in series:
        ts = row.get("timestamp") or ""
        hhmm = ts[11:16] if len(ts) >= 16 else ""
        if hhmm < "09:15":
            continue

        spot = utils.safe_float(row.get("underlying_spot_price"), 0.0) or 0.0
        ce_cum_raw = utils.safe_float(row.get("total_ce_volume"), 0.0) or 0.0
        pe_cum_raw = utils.safe_float(row.get("total_pe_volume"), 0.0) or 0.0

        # Per-tick incremental volume (series returns day-cumulative per row)
        ce_delta = max(0.0, ce_cum_raw - prev_ce_cum) if prev_ce_cum is not None else ce_cum_raw
        pe_delta = max(0.0, pe_cum_raw - prev_pe_cum) if prev_pe_cum is not None else pe_cum_raw
        prev_ce_cum = ce_cum_raw
        prev_pe_cum = pe_cum_raw

        tick_vol = ce_delta + pe_delta
        if spot > 0 and tick_vol > 0:
            cum_pv += spot * tick_vol
            cum_vol += tick_vol

        if cum_vol <= 0 or spot <= 0:
            continue

        vwap = cum_pv / cum_vol

        band = vwap * BAND_PCT
        if spot > vwap + band:
            sig = "BUY"
        elif spot < vwap - band:
            sig = "SELL"
        else:
            continue  # NEUTRAL — no active directional position

        candidate = {
            "timestamp": ts,
            "signal": sig,
            "vwap": vwap,
            "spot": spot,
            "band": band,
            "oi_difference": None,
            "pcr": None,
            "ce_oi_cumm_change": None,
            "pe_oi_cumm_change": None,
        }
        # Keep updating: we want the MOST RECENT directional state
        last_signal = candidate

    if last_signal is None:
        return None
    if after_iso and str(last_signal["timestamp"]) <= str(after_iso):
        return None
    return last_signal


def _ltp_signal(
    instrument: str,
    date: str,
    after_iso: str | None = None,
) -> dict[str, Any] | None:
    """Latest LTP-Based Option Strength signal (Dr. Vijay's spec STEP 12/13).

    Computes only the latest tick's strict signal (not the whole-day series)
    so the per-second engine stays fast:
        BUY (→CE)  iff CE_SUM>0 & PE_SUM<0 & DirStrength>0 & Rolling>0 & spot>VWAP
        SELL (→PE) iff CE_SUM<0 & PE_SUM>0 & DirStrength<0 & Rolling<0 & spot<VWAP
    Otherwise None (market-state quadrant, no actionable trade).
    """
    step = data_processor._strike_step(instrument)
    with closing(data_processor.connect()) as conn:
        latest = conn.execute(
            "SELECT MAX(timestamp) AS ts FROM oi_snapshots "
            "WHERE instrument=? AND substr(timestamp,1,10)=? "
            "AND substr(timestamp,12,5)>='09:15' AND substr(timestamp,12,5)<='15:30'",
            (instrument, date),
        ).fetchone()
        ts = latest["ts"] if latest else None
        if not ts:
            return None
        head = conn.execute(
            "SELECT atm_strike, underlying_spot_price FROM oi_snapshots "
            "WHERE instrument=? AND timestamp=? LIMIT 1",
            (instrument, ts),
        ).fetchone()
        if not head or head["atm_strike"] is None:
            return None
        atm = float(head["atm_strike"])
        spot = utils.safe_float(head["underlying_spot_price"], 0.0) or 0.0

        ce_strikes = [atm - k * step for k in range(4)]   # ATM + 3 ITM (lower)
        pe_strikes = [atm + k * step for k in range(4)]   # ATM + 3 ITM (higher)
        strikes = sorted(set(ce_strikes + pe_strikes))
        ph = ",".join("?" for _ in strikes)

        def fetch_at(stamp: str) -> dict[float, Any]:
            if not stamp:
                return {}
            return {
                r["strike"]: r
                for r in conn.execute(
                    f"SELECT strike, ce_ltp, pe_ltp FROM oi_snapshots "
                    f"WHERE instrument=? AND timestamp=? AND strike IN ({ph})",
                    (instrument, stamp, *strikes),
                ).fetchall()
            }

        cur = fetch_at(ts)
        first_ts = conn.execute(
            "SELECT MIN(timestamp) AS ts FROM oi_snapshots "
            "WHERE instrument=? AND substr(timestamp,1,10)=? AND substr(timestamp,12,5)>='09:15'",
            (instrument, date),
        ).fetchone()["ts"]
        ref = fetch_at(first_ts)

        try:
            t5 = (datetime.fromisoformat(ts) - timedelta(minutes=5)).strftime("%H:%M:%S")
        except ValueError:
            t5 = None
        ts5 = None
        if t5:
            row5 = conn.execute(
                "SELECT MAX(timestamp) AS ts FROM oi_snapshots "
                "WHERE instrument=? AND substr(timestamp,1,10)=? AND substr(timestamp,12,8)<=?",
                (instrument, date, t5),
            ).fetchone()
            ts5 = row5["ts"] if row5 else None
        ago = fetch_at(ts5) if ts5 else {}

    def _ltp(d: dict, strike: float, col: str):
        r = d.get(strike)
        return utils.safe_float(r[col], None) if r else None

    def sess(strikes_list, col):
        tot = 0.0
        for s in strikes_list:
            c = _ltp(cur, s, col)
            rf = _ltp(ref, s, col)
            if c is not None and rf is not None:
                tot += c - rf
        return tot

    def roll(strikes_list, col):
        if not ago:
            return 0.0
        tot = 0.0
        for s in strikes_list:
            c = _ltp(cur, s, col)
            a = _ltp(ago, s, col)
            if c is not None and a is not None:
                tot += c - a
        return tot

    ce_sum = sess(ce_strikes, "ce_ltp")
    pe_sum = sess(pe_strikes, "pe_ltp")
    dir_strength = ce_sum - pe_sum
    rolling_strength = roll(ce_strikes, "ce_ltp") - roll(pe_strikes, "pe_ltp")

    # VWAP at latest (same session-anchored formula as the volume tab).
    vwap = 0.0
    cum_pv = cum_vol = 0.0
    pce = ppe = None
    for vr in data_processor.get_total_volume_series(instrument, date):
        ce = vr.get("total_ce_volume") or 0.0
        pe = vr.get("total_pe_volume") or 0.0
        sp = vr.get("underlying_spot_price") or 0.0
        cd = max(0.0, ce - pce) if pce is not None else ce
        pd = max(0.0, pe - ppe) if ppe is not None else pe
        pce, ppe = ce, pe
        tv = cd + pd
        if sp > 0 and tv > 0:
            cum_pv += sp * tv
            cum_vol += tv
    if cum_vol > 0:
        vwap = cum_pv / cum_vol

    signal, _state = data_processor._ltp_decide(
        ce_sum, pe_sum, dir_strength, rolling_strength, spot, vwap
    )
    if signal is None:
        return None
    if after_iso and str(ts) <= str(after_iso):
        return None
    return {
        "timestamp": ts,
        "signal": signal,
        "ce_sum": ce_sum,
        "pe_sum": pe_sum,
        "directional_strength": dir_strength,
        "rolling_strength": rolling_strength,
        "vwap": vwap,
        "spot": spot,
        "oi_difference": None,
        "pcr": None,
        "ce_oi_cumm_change": None,
        "pe_oi_cumm_change": None,
    }


def _maybe_ratchet_tsl(
    position: dict[str, Any],
    ltp: float,
    entry_price: float,
    config: dict[str, Any],
) -> None:
    trigger_pct = float(config.get("trailing_sl_trigger_pct") or 0)
    step_pct = float(config.get("trailing_sl_step_pct") or 0)
    if trigger_pct <= 0 or step_pct <= 0:
        return
    hwm = position.get("high_watermark")
    if hwm is None or ltp > float(hwm):
        hwm = ltp
    armed = hwm >= entry_price * (1 + trigger_pct / 100.0)
    if not armed:
        # update HWM only
        if position.get("high_watermark") is None or hwm > float(position["high_watermark"]):
            persistence.update_position_tsl(
                int(position["id"]),
                high_watermark=hwm,
                sl_price=float(position.get("sl_price") or 0),
            )
        return
    new_sl = hwm * (1 - step_pct / 100.0)
    current_sl = float(position.get("sl_price") or 0)
    if new_sl > current_sl:
        persistence.update_position_tsl(int(position["id"]), high_watermark=hwm, sl_price=new_sl)
        persistence.audit(
            "tsl_ratchet",
            position_id=int(position["id"]),
            instrument=position.get("instrument"),
            message=f"hwm={hwm:.2f} sl={new_sl:.2f}",
        )


def _close(
    position: dict[str, Any],
    reason: str,
    ltp: float,
    b: broker_mod.Broker,
) -> None:
    result = b.place_exit(position=position, intent=reason, ref_price=ltp)
    if not result.success:
        persistence.audit(
            "engine_error",
            position_id=int(position["id"]),
            instrument=position.get("instrument"),
            message=f"broker exit failed: {result.error}",
        )
        return
    exit_order_id = persistence.close_position_atomic(
        position_id=int(position["id"]),
        exit_order_fields=dict(
            client_order_ref=result.client_order_ref,
            broker_order_id=result.broker_order_id,
            instrument=position["instrument"],
            instrument_token=position["instrument_token"],
            strike=position["strike"],
            option_type=position["option_type"],
            transaction_type="SELL",
            qty=position["qty"],
            lots=position["lots"],
            price=result.price,
            status="filled",
            intent=reason,
            parent_position_id=int(position["id"]),
            mode=position["mode"],
            signal_timestamp=None,
            placed_at=utils.iso_now(),
            error=None,
        ),
        exit_price=float(result.price or ltp),
        exit_reason=reason,
        entry_price=float(position["entry_price"]),
        qty=int(position["qty"]),
    )
    if exit_order_id is not None:
        persistence.audit(
            "exit_placed",
            position_id=int(position["id"]),
            instrument=position.get("instrument"),
            client_order_ref=result.client_order_ref,
            message=f"reason={reason} price={result.price}",
        )


# ── Pass 2: entries ───────────────────────────────────────────────────


def _evaluate_entries(
    config: dict[str, Any],
    today: str,
    now: datetime,
    b: broker_mod.Broker,
) -> None:
    if not config.get("auto_execute"):
        return
    # Entry cutoff: stop opening NEW positions in the run-up to close. Without
    # this the engine kept entering at 15:29:55–58 only to EOD-square-off the
    # same position a few seconds later at +0 P&L (pointless churn) — and an
    # entry in the final tick could even escape the square-off entirely.
    # A hard floor of market_close-5s also applies so a misconfig can't reopen
    # the window where the EOD force-close is already firing.
    market_close = _parse_hhmm(str(config.get("market_close_time") or "15:30"))
    cutoff = _shift(market_close, seconds=-5)
    no_entry_after = str(config.get("no_entry_after") or "").strip()
    if no_entry_after:
        try:
            cfg_cutoff = _parse_hhmm(no_entry_after)
            if cfg_cutoff < cutoff:
                cutoff = cfg_cutoff
        except (ValueError, TypeError):
            pass
    if _at_or_after(now, cutoff):
        return  # silent — no new entries this close to the bell
    instruments = list(config.get("instruments") or [])
    if not instruments:
        return
    # Cheap whole-config check: have we already hit the daily cap?
    if persistence.count_entries_today(today) >= int(config.get("max_positions_per_day") or 0 or 999):
        # Don't audit per-instrument when capped — would flood the log.
        return
    for instrument in instruments:
        try:
            _evaluate_one_entry(instrument, config, today, now, b)
        except Exception as exc:  # noqa: BLE001
            logger.exception("entry evaluation failed for %s", instrument)
            persistence.audit(
                "engine_error",
                instrument=instrument,
                message=f"entry eval failed: {exc}",
            )


def _active_sources(signal_mode: str) -> list[str]:
    """Which strategies are active for the configured mode.

    signal_mode is a string OR a comma-joined list of sources:
        'oi_only'    / 'oi'     -> ['oi']
        'volume_only'/ 'volume' -> ['volume']
        'vwap_only'  / 'vwap'   -> ['vwap']
        'both' / 'combined'     -> ['oi', 'volume']      (legacy)
        'oi,volume'             -> ['oi', 'volume']
        'oi,vwap'               -> ['oi', 'vwap']
        'volume,vwap'           -> ['volume', 'vwap']
        'oi,volume,vwap'        -> ['oi', 'volume', 'vwap']
    """
    mode = str(signal_mode or "oi_only").strip()
    # Legacy single-word aliases
    aliases = {
        "oi_only": ["oi"],
        "volume_only": ["volume"],
        "vwap_only": ["vwap"],
        "ltp_only": ["ltp"],
        "both": ["oi", "volume"],
        "combined": ["oi", "volume"],
    }
    if mode in aliases:
        return aliases[mode]
    # Comma-separated list of sources e.g. "oi,vwap,ltp"
    parts = [p.strip() for p in mode.split(",") if p.strip() in ("oi", "volume", "vwap", "ltp")]
    return parts if parts else ["oi"]


def _source_signal(source: str, instrument: str, date: str, after_iso: str | None = None):
    """Latest direction signal for a single source ('oi', 'volume', 'vwap', 'ltp')."""
    if source == "volume":
        return _volume_signal(instrument, date, after_iso)
    if source == "vwap":
        return _vwap_signal(instrument, date, after_iso)
    if source == "ltp":
        return _ltp_signal(instrument, date, after_iso)
    return _oi_signal(instrument, date, after_iso)


def _evaluate_one_entry(
    instrument: str,
    config: dict[str, Any],
    today: str,
    now: datetime,
    b: broker_mod.Broker,
) -> None:
    # In 'both' mode the OI and volume strategies are evaluated independently,
    # so one instrument can carry an OI position AND a volume position at once.
    signal_mode = str(config.get("signal_mode") or "oi_only")
    for source in _active_sources(signal_mode):
        _evaluate_one_entry_source(instrument, source, config, today, now, b)


def _evaluate_one_entry_source(
    instrument: str,
    source: str,
    config: dict[str, Any],
    today: str,
    now: datetime,
    b: broker_mod.Broker,
) -> None:
    # Gate: one open position per (instrument, source) — no pyramiding within
    # a source, but OI and volume each get their own independent leg.
    if persistence.has_open_for_instrument_source(instrument, source):
        return  # silent; we'd flood the audit log otherwise

    # Gate: cooldown (per instrument+source)
    cooldown_min = int(config.get("cooldown_minutes") or 0)
    if cooldown_min > 0:
        last_ts = persistence.last_entry_time_for_instrument_source(instrument, source, today)
        if last_ts and _iso_seconds_ago(last_ts, now) < cooldown_min * 60:
            return  # silent

    # Latest crossover for THIS source. Direction -> leg is fixed:
    # BUY -> CE, SELL -> PE.
    signal = _source_signal(source, instrument, today)

    if not signal:
        return  # no fresh signal — silent

    # Gate: stale signal (engine running too far behind)
    stale_s = _iso_seconds_ago(signal["timestamp"], now)
    if stale_s > 90:
        return  # silent — would log every tick otherwise

    # Don't re-enter on a signal we've already acted on (per source)
    if _entry_already_exists(instrument, source, signal["timestamp"]):
        return  # silent

    side = _decide_side(signal.get("signal"))
    if side is None:
        persistence.audit(
            "gate_reject", instrument=instrument, gate="UNKNOWN_SIGNAL",
            message=f"unrecognised signal={signal.get('signal')}",
        )
        return

    # Resolve the leg to trade
    leg = strikes.resolve(
        instrument=instrument,
        side=side,
        strike_mode=str(config.get("strike_mode") or "atm"),
        custom_steps=config.get("custom_steps"),
        date=today,
    )
    if leg is None:
        persistence.audit(
            "gate_reject", instrument=instrument, gate="STRIKE_RESOLVE",
            message=f"could not resolve {side} for {instrument}",
        )
        return

    # Compute qty
    lot_size = _lot_size(instrument)
    lots = max(1, int(config.get("lots") or 1))
    qty = lot_size * lots

    # Place via broker
    result = b.place_entry(
        instrument=instrument,
        instrument_token=leg["token"],
        strike=leg["strike"],
        option_type=side,
        qty=qty,
        lots=lots,
        signal_timestamp=signal["timestamp"],
        ref_price=leg["ltp"],
    )
    if not result.success:
        persistence.audit(
            "engine_error", instrument=instrument,
            message=f"broker entry failed: {result.error}",
        )
        return

    fill_price = float(result.price or leg["ltp"])

    # Compute SL / target as absolute prices, frozen at entry
    sl_price = (
        round(fill_price * (1 - float(config["stop_loss_pct"]) / 100.0), 2)
        if config.get("stop_loss_enabled") and config.get("stop_loss_pct")
        else None
    )
    target_price = (
        round(fill_price * (1 + float(config["target_pct"]) / 100.0), 2)
        if config.get("target_enabled") and config.get("target_pct")
        else None
    )

    opened = persistence.open_position_atomic(
        order_fields=dict(
            client_order_ref=result.client_order_ref,
            broker_order_id=result.broker_order_id,
            instrument=instrument,
            instrument_token=leg["token"],
            strike=leg["strike"],
            option_type=side,
            transaction_type="BUY",
            qty=qty,
            lots=lots,
            price=fill_price,
            status="filled",
            intent="entry",
            parent_position_id=None,
            mode=b.mode,
            signal_timestamp=signal["timestamp"],
            placed_at=utils.iso_now(),
            error=None,
            source=source,
        ),
        position_fields=dict(
            instrument=instrument,
            instrument_token=leg["token"],
            strike=leg["strike"],
            option_type=side,
            qty=qty,
            lots=lots,
            entry_price=fill_price,
            entry_time=utils.iso_now(),
            status="open",
            high_watermark=fill_price,
            sl_price=sl_price,
            target_price=target_price,
            mode=b.mode,
            signal_timestamp=signal["timestamp"],
            source=source,
            ctx_oi_difference=utils.safe_float(signal.get("oi_difference")),
            ctx_pcr=utils.safe_float(signal.get("pcr")),
            ctx_ce_cumm=utils.safe_float(signal.get("ce_oi_cumm_change")),
            ctx_pe_cumm=utils.safe_float(signal.get("pe_oi_cumm_change")),
            ctx_margin=abs(
                (utils.safe_float(signal.get("pe_oi_cumm_change")) or 0)
                - (utils.safe_float(signal.get("ce_oi_cumm_change")) or 0)
            ),
        ),
    )
    if opened is None:
        # The UNIQUE constraint caught a duplicate — already audited downstream
        return
    persistence.audit(
        "entry_placed", instrument=instrument,
        client_order_ref=result.client_order_ref,
        message=f"source={source} side={side} strike={leg['strike']} price={fill_price} qty={qty}",
    )


def _decide_side(signal: str | None) -> str | None:
    """Map data_engine signal direction to the option leg to buy.

    The data_engine emits BUY when the diff (PE_cumm - CE_cumm) flips
    -ve -> +ve, and SELL when it flips +ve -> -ve. Both are entry triggers
    in the trade engine:
        BUY  -> enter CE
        SELL -> enter PE
    """
    if signal == "BUY":
        return "CE"
    if signal == "SELL":
        return "PE"
    return None


def _entry_already_exists(instrument: str, source: str, signal_timestamp: str) -> bool:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT 1 FROM orders
            WHERE instrument = ?
              AND source = ?
              AND signal_timestamp = ?
              AND intent = 'entry'
            LIMIT 1
            """,
            (instrument, source, signal_timestamp),
        ).fetchone()
    return row is not None


def _lot_size(instrument: str) -> int:
    cfg = utils.instrument_config(instrument)
    # The backend config doesn't yet carry lot sizes; fall back to a sane default.
    explicit = cfg.get("lot_size")
    if explicit:
        return int(explicit)
    defaults = {"nifty": 75, "banknifty": 30, "sensex": 20}
    return defaults.get(instrument, 1)


# ── Time helpers ──────────────────────────────────────────────────────


def _parse_hhmm(value: str) -> dt_time:
    h, m = value.split(":")
    return dt_time(int(h), int(m), 0)


def _shift(t: dt_time, *, seconds: int) -> dt_time:
    total = t.hour * 3600 + t.minute * 60 + t.second + seconds
    total = max(0, min(86399, total))
    return dt_time(total // 3600, (total % 3600) // 60, total % 60)


def _at_or_after(now: datetime, t: dt_time) -> bool:
    return (now.hour, now.minute, now.second) >= (t.hour, t.minute, t.second)


def _iso_seconds_ago(iso_ts: str, now: datetime) -> float:
    try:
        ts = datetime.fromisoformat(iso_ts)
    except (TypeError, ValueError):
        return 1e9
    if ts.tzinfo is None:
        # Treat as IST naïve — match the rest of the codebase
        ts = ts.replace(tzinfo=now.tzinfo)
    return (now - ts).total_seconds()
