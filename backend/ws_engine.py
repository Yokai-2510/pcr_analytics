"""Universal websocket market-data engine.

Replaces the REST option-chain polling as the PRIMARY market-data source:

  * One Upstox MarketDataStreamerV3 connection carries the index spots plus
    every subscribed option leg for all three instruments (nifty, banknifty,
    sensex). Dynamic window: ATM ± strike_count PLUS `SAFE_STRIKES` extra
    strikes each side; when the ATM drifts outside the covered center the
    window re-subscribes around the new ATM (held legs stay covered by the
    safety margin).
  * The in-memory book is exposed in the SAME payload shape the old REST
    fetch produced (`chain_payload`), so data_engine / compute / charts are
    untouched — only the transport changed. REST remains as (a) the
    once-per-boot strike/instrument-key map, (b) an automatic fallback when
    the socket is not yet live, and (c) a slow enricher for fields the feed
    does not carry (prev_oi).
  * Option Volume strategy state: every tick classifies the traded volume
    delta by the quote rule (ltp >= ask -> buyer-initiated, ltp <= bid ->
    seller-initiated, else midpoint) into per-instrument CE/PE buy & sell
    accumulators over the ATM band. Buckets hold RAW CONTRACT VOLUME (the
    per-tick increment in traded quantity), not premium notional, so they
    are directly comparable to the Volume Logs tab. Signals (which side's
    DELTA leads) are TRANSITION-based and recorded live per tick; the
    1-minute logger writes the rank-momentum-style table to
    `option_volume_logs`.

Trade signals are generated live per tick; persistence logging is 1-minute.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import closing
from typing import Any

import broker_api
import data_processor
import utilities as utils

logger = logging.getLogger(__name__)

SAFE_STRIKES = 3          # extra strikes beyond the configured window, each side
RESUB_DRIFT_STEPS = 2     # re-center once ATM drifts this many steps from center
LOG_INTERVAL_S = 60       # option-volume table cadence (1 minute)
REST_ENRICH_S = 300       # slow REST pass for prev_oi/close gaps
STALE_AFTER_S = 20        # book considered stale for chain_payload after this


class _Leg:
    __slots__ = ("instrument", "strike", "side", "key", "static", "ltp", "oi",
                 "prev_oi", "volume", "bid", "bid_qty", "ask", "ask_qty",
                 "iv", "delta", "gamma", "theta", "vega", "ts")

    def __init__(self, instrument: str, strike: float, side: str, key: str,
                 static: dict[str, Any]):
        self.instrument, self.strike, self.side, self.key = instrument, strike, side, key
        self.static = static
        md = utils.option_market_data(static, side) or {}
        gk = utils.option_greeks(static, side) or {}
        self.ltp = utils.safe_float(md.get("ltp"), 0.0) or 0.0
        self.oi = utils.safe_float(md.get("oi"), 0.0) or 0.0
        self.prev_oi = utils.safe_float(md.get("prev_oi"))
        self.volume = utils.safe_float(md.get("volume"), 0.0) or 0.0
        self.bid = utils.safe_float(md.get("bid_price"), 0.0) or 0.0
        self.bid_qty = utils.safe_float(md.get("bid_qty"), 0.0) or 0.0
        self.ask = utils.safe_float(md.get("ask_price"), 0.0) or 0.0
        self.ask_qty = utils.safe_float(md.get("ask_qty"), 0.0) or 0.0
        self.iv = utils.safe_float(gk.get("iv"))
        self.delta = utils.safe_float(gk.get("delta"))
        self.gamma = utils.safe_float(gk.get("gamma"))
        self.theta = utils.safe_float(gk.get("theta"))
        self.vega = utils.safe_float(gk.get("vega"))
        self.ts = 0.0


class WsEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._legs: dict[str, _Leg] = {}                # instrument_key -> leg
        self._by_instrument: dict[str, dict[float, dict[str, _Leg]]] = {}
        self._spot: dict[str, float] = {}
        self._spot_keys: dict[str, str] = {}
        self._raw_rows: dict[str, list[dict[str, Any]]] = {}  # full REST strike rows
        self._expiries: dict[str, str] = {}
        self._center: dict[str, float] = {}
        self._last_frame: float = 0.0
        self._streamer: Any = None
        self._started = False
        # Option-volume strategy state (per instrument)
        self.optvol: dict[str, dict[str, Any]] = {}
        self._stop = threading.Event()

    # ── Lifecycle ──────────────────────────────────────────────────────
    def start(self, expiries: dict[str, str]) -> bool:
        with self._lock:
            if self._started:
                return True
            self._expiries = dict(expiries)
        try:
            self._bootstrap_from_rest()
            self._connect()
        except Exception:
            logger.exception("ws_engine: start failed; REST fallback stays active")
            return False
        threading.Thread(target=self._minute_logger, daemon=True,
                         name="ws_optvol_logger").start()
        threading.Thread(target=self._maintenance, daemon=True,
                         name="ws_maintenance").start()
        with self._lock:
            self._started = True
        logger.info("ws_engine: started (%d legs, %d instruments)",
                    len(self._legs), len(self._by_instrument))
        return True

    def is_live(self) -> bool:
        return self._started and (time.time() - self._last_frame) < STALE_AFTER_S

    # ── Bootstrap: REST once for keys/static, pick windows ─────────────
    def _bootstrap_from_rest(self) -> None:
        for instrument, cfg in utils.instruments_config().items():
            expiry = self._expiries.get(instrument)
            if not expiry:
                continue
            rows = broker_api.get_option_chain(str(cfg["instrument_key"]), str(expiry))
            with self._lock:
                self._raw_rows[instrument] = rows
                self._spot_keys[instrument] = str(cfg["instrument_key"])
                spot = 0.0
                for r in rows:
                    spot = utils.safe_float(r.get("underlying_spot_price"), 0.0) or spot
                self._spot[instrument] = spot
                self.optvol.setdefault(instrument, {
                    "ce_buy": 0.0, "ce_sell": 0.0, "pe_buy": 0.0, "pe_sell": 0.0,
                    "prev_state": None, "transitions": [],
                })
            self._build_window(instrument)

    def _build_window(self, instrument: str) -> list[str]:
        cfg = utils.instruments_config()[instrument]
        step = float(cfg["strike_step"])
        count = int(cfg["strike_count"]) + SAFE_STRIKES
        with self._lock:
            rows = self._raw_rows.get(instrument) or []
            spot = self._spot.get(instrument) or 0.0
            strikes = sorted({utils.safe_float(r.get("strike_price"), 0.0) or 0.0
                              for r in rows})
            if not strikes or spot <= 0:
                return []
            atm = min(strikes, key=lambda x: abs(x - spot))
            lo, hi = atm - count * step, atm + count * step
            table = self._by_instrument.setdefault(instrument, {})
            keys: list[str] = []
            for r in rows:
                k = utils.safe_float(r.get("strike_price"), 0.0) or 0.0
                if k < lo or k > hi:
                    continue
                slot = table.setdefault(k, {})
                for side in ("CE", "PE"):
                    payload = utils.option_payload(r, side) or {}
                    ikey = payload.get("instrument_key")
                    if not ikey:
                        continue
                    sd = side
                    if sd not in slot:
                        leg = _Leg(instrument, k, sd, str(ikey), r)
                        slot[sd] = leg
                        self._legs[str(ikey)] = leg
                    keys.append(str(ikey))
            self._center[instrument] = atm
        return keys

    # ── Websocket ──────────────────────────────────────────────────────
    def _connect(self) -> None:
        import upstox_client  # lazy: only the WS path needs the SDK

        token = broker_api.get_token()
        config = upstox_client.Configuration()
        config.access_token = token
        client = upstox_client.ApiClient(config)
        keys = list(self._legs.keys()) + list(self._spot_keys.values())
        streamer = upstox_client.MarketDataStreamerV3(client, keys, "full")
        streamer.on("message", self._on_message)
        streamer.on("error", lambda e: logger.error("ws_engine socket error: %s", e))
        threading.Thread(target=streamer.connect, daemon=True, name="ws_streamer").start()
        self._streamer = streamer

    def _on_message(self, message: dict[str, Any]) -> None:
        try:
            feeds = (message or {}).get("feeds") or {}
            now = time.time()
            self._last_frame = now
            for ikey, feed in feeds.items():
                ff = (feed.get("fullFeed") or {})
                mff = ff.get("marketFF") or ff.get("indexFF") or {}
                ltpc = mff.get("ltpc") or {}
                ltp = utils.safe_float(ltpc.get("ltp"))
                # Index spot?
                for instrument, skey in self._spot_keys.items():
                    if ikey == skey and ltp:
                        with self._lock:
                            self._spot[instrument] = float(ltp)
                        break
                leg = self._legs.get(str(ikey))
                if leg is None:
                    continue
                self._apply_leg(leg, mff, ltp, now)
        except Exception:
            logger.exception("ws_engine: frame handling failed")

    def _apply_leg(self, leg: _Leg, mff: dict[str, Any], ltp: float | None,
                   now: float) -> None:
        bidask = None
        depth = ((mff.get("marketLevel") or {}).get("bidAskQuote")) or []
        if depth:
            bidask = depth[0]
        prev_vol = leg.volume
        with self._lock:
            if ltp:
                leg.ltp = float(ltp)
            vtt = utils.safe_float(mff.get("vtt"))
            if vtt is not None:
                leg.volume = float(vtt)
            oi = utils.safe_float(mff.get("oi"))
            if oi is not None:
                leg.oi = float(oi)
            if bidask:
                leg.bid = utils.safe_float(bidask.get("bidP") or bidask.get("bidPrice"), leg.bid) or leg.bid
                leg.ask = utils.safe_float(bidask.get("askP") or bidask.get("askPrice"), leg.ask) or leg.ask
                leg.bid_qty = utils.safe_float(bidask.get("bidQ") or bidask.get("bidQty"), leg.bid_qty) or leg.bid_qty
                leg.ask_qty = utils.safe_float(bidask.get("askQ") or bidask.get("askQty"), leg.ask_qty) or leg.ask_qty
            gk = mff.get("optionGreeks") or {}
            if gk:
                leg.iv = utils.safe_float(gk.get("iv"), leg.iv)
                leg.delta = utils.safe_float(gk.get("delta"), leg.delta)
            leg.ts = now
            # Aggressor-classified volume delta (quote rule) — LIVE, per tick.
            # dv is the raw traded-quantity increment; we accumulate CONTRACTS
            # (not dv*ltp premium notional) so the buckets are true buy/sell
            # volume, comparable to the Volume Logs tab.
            dv = leg.volume - prev_vol
            if dv > 0:
                ov = self.optvol.get(leg.instrument)
                if ov is not None and self._in_band(leg):
                    if leg.ltp >= leg.ask > 0:
                        buyer = True
                    elif 0 < leg.bid >= leg.ltp:
                        buyer = False
                    else:
                        mid = (leg.bid + leg.ask) / 2 if (leg.bid and leg.ask) else leg.ltp
                        buyer = leg.ltp >= mid
                    fld = f"{leg.side.lower()}_{'buy' if buyer else 'sell'}"
                    ov[fld] = ov.get(fld, 0.0) + dv
                    self._check_transition(leg.instrument, ov)

    def _in_band(self, leg: _Leg) -> bool:
        cfg = utils.instruments_config().get(leg.instrument) or {}
        step = float(cfg.get("strike_step") or 50)
        count = int(cfg.get("strike_count") or 5)
        center = self._center.get(leg.instrument) or leg.strike
        return abs(leg.strike - center) <= count * step

    def _check_transition(self, instrument: str, ov: dict[str, Any]) -> None:
        """Option-volume signal: trade the side whose DELTA (buy - sell) leads.
        CE delta > PE delta -> BUY (enter CE); PE leads -> SELL (enter PE).
        Transition-based: seed on the first directional reading, then only on
        genuine flips — never re-emitted while the same side stays ahead."""
        ce_d = ov["ce_buy"] - ov["ce_sell"]
        pe_d = ov["pe_buy"] - ov["pe_sell"]
        diff = ce_d - pe_d
        state = "BUY" if diff > 0 else "SELL" if diff < 0 else None
        if state is not None and state != ov.get("prev_state"):
            ov["prev_state"] = state
            ov["transitions"].append({
                "timestamp": utils.iso_now(),
                "signal": state,
                "ce_delta": round(ce_d, 2),
                "pe_delta": round(pe_d, 2),
                "net_delta": round(diff, 2),
            })
            del ov["transitions"][:-50]
            logger.info("optvol %s transition -> %s (ceΔ=%.0f peΔ=%.0f)",
                        instrument, state, ce_d, pe_d)

    # ── Consumers ──────────────────────────────────────────────────────
    def chain_payload(self, instrument: str) -> dict[str, Any] | None:
        """REST-shaped payload built from the live book (drop-in replacement
        for market_data.fetch_option_chains rows)."""
        if not self.is_live():
            return None
        with self._lock:
            table = self._by_instrument.get(instrument)
            spot = self._spot.get(instrument) or 0.0
            expiry = self._expiries.get(instrument)
            if not table or spot <= 0:
                return None
            strikes_out = []
            for strike in sorted(table):
                slot = table[strike]
                row: dict[str, Any] = {
                    "strike_price": strike,
                    "underlying_spot_price": spot,
                    "expiry": expiry,
                    "underlying_key": self._spot_keys.get(instrument),
                    "pcr": None,
                }
                for side, node in (("CE", "call_options"), ("PE", "put_options")):
                    leg = slot.get(side)
                    if leg is None:
                        continue
                    row[node] = {
                        "instrument_key": leg.key,
                        "market_data": {
                            "ltp": leg.ltp, "oi": leg.oi, "prev_oi": leg.prev_oi,
                            "volume": leg.volume, "close_price": None,
                            "bid_price": leg.bid, "bid_qty": leg.bid_qty,
                            "ask_price": leg.ask, "ask_qty": leg.ask_qty,
                        },
                        "option_greeks": {
                            "iv": leg.iv, "delta": leg.delta, "gamma": leg.gamma,
                            "theta": leg.theta, "vega": leg.vega, "pop": None,
                        },
                    }
                strikes_out.append(row)
        return {
            "timestamp": utils.iso_now(),
            "instrument": instrument,
            "instrument_key": self._spot_keys.get(instrument),
            "expiry": expiry,
            "strikes": strikes_out,
            "source": "websocket",
        }

    def optvol_state(self, instrument: str) -> dict[str, Any] | None:
        ov = self.optvol.get(instrument)
        if ov is None:
            return None
        with self._lock:
            ce_d = ov["ce_buy"] - ov["ce_sell"]
            pe_d = ov["pe_buy"] - ov["pe_sell"]
            return {
                "ce_buy": ov["ce_buy"], "ce_sell": ov["ce_sell"], "ce_delta": ce_d,
                "pe_buy": ov["pe_buy"], "pe_sell": ov["pe_sell"], "pe_delta": pe_d,
                "net_delta": ce_d - pe_d,
                "transitions": list(ov["transitions"]),
            }

    # ── Background threads ─────────────────────────────────────────────
    def _minute_logger(self) -> None:
        """Every minute: persist the option-volume table (rank-momentum style)."""
        while not self._stop.wait(LOG_INTERVAL_S):
            try:
                if utils.market_session_state() != "live":
                    continue
                for instrument in list(self.optvol):
                    st = self.optvol_state(instrument)
                    if not st or (st["ce_buy"] + st["pe_buy"] + st["ce_sell"]
                                  + st["pe_sell"]) <= 0:
                        continue
                    with closing(data_processor.connect()) as conn, conn:
                        conn.execute(
                            "INSERT INTO option_volume_logs (timestamp, instrument,"
                            " ce_buy, ce_sell, ce_delta, pe_buy, pe_sell, pe_delta,"
                            " net_delta) VALUES (?,?,?,?,?,?,?,?,?)",
                            (utils.iso_now(), instrument,
                             st["ce_buy"], st["ce_sell"], st["ce_delta"],
                             st["pe_buy"], st["pe_sell"], st["pe_delta"],
                             st["net_delta"]),
                        )
            except Exception:
                logger.exception("ws_engine: minute logger failed")

    def _maintenance(self) -> None:
        """ATM re-centering + slow REST enrich (prev_oi) + reconnect guard."""
        last_enrich = 0.0
        while not self._stop.wait(5):
            try:
                for instrument in list(self._by_instrument):
                    cfg = utils.instruments_config()[instrument]
                    step = float(cfg["strike_step"])
                    with self._lock:
                        spot = self._spot.get(instrument) or 0.0
                        center = self._center.get(instrument) or 0.0
                    if spot <= 0 or center <= 0:
                        continue
                    if abs(spot - center) >= RESUB_DRIFT_STEPS * step:
                        logger.info("ws_engine: %s ATM drift (%.0f -> spot %.0f);"
                                    " re-centering", instrument, center, spot)
                        rows = broker_api.get_option_chain(
                            str(cfg["instrument_key"]),
                            str(self._expiries.get(instrument)))
                        with self._lock:
                            self._raw_rows[instrument] = rows
                        new_keys = self._build_window(instrument)
                        if self._streamer is not None and new_keys:
                            try:
                                self._streamer.subscribe(new_keys, "full")
                            except Exception:
                                logger.exception("ws_engine: resubscribe failed")
                if time.time() - last_enrich > REST_ENRICH_S:
                    last_enrich = time.time()
                    for instrument, cfg in utils.instruments_config().items():
                        expiry = self._expiries.get(instrument)
                        if not expiry:
                            continue
                        try:
                            rows = broker_api.get_option_chain(
                                str(cfg["instrument_key"]), str(expiry))
                        except Exception:
                            continue
                        with self._lock:
                            self._raw_rows[instrument] = rows
                            for r in rows:
                                for side in ("CE", "PE"):
                                    payload = utils.option_payload(r, side) or {}
                                    leg = self._legs.get(str(payload.get("instrument_key")))
                                    if leg is not None:
                                        md = utils.option_market_data(r, side) or {}
                                        leg.prev_oi = utils.safe_float(
                                            md.get("prev_oi"), leg.prev_oi)
            except Exception:
                logger.exception("ws_engine: maintenance failed")


ENGINE = WsEngine()
