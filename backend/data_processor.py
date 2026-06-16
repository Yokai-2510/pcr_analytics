"""Raw CSV logging, ATM filtering, SQLite writes, and query helpers."""

from __future__ import annotations

import csv
import logging
import sqlite3
from contextlib import closing
from typing import Any

import utilities as utils

logger = logging.getLogger(__name__)

CSV_COLUMNS = [
    "timestamp",
    "instrument",
    "expiry",
    "underlying_key",
    "underlying_spot_price",
    "strike",
    "strike_pcr",
    "option_type",
    "option_instrument_key",
    "ltp",
    "oi",
    "prev_oi",
    "volume",
    "close_price",
    "bid_price",
    "bid_qty",
    "ask_price",
    "ask_qty",
    "iv",
    "delta",
    "gamma",
    "theta",
    "vega",
    "pop",
]

OPTION_FIELD_SUFFIXES = [
    "instrument_key",
    "ltp",
    "oi",
    "prev_oi",
    "volume",
    "close_price",
    "bid_price",
    "bid_qty",
    "ask_price",
    "ask_qty",
    "iv",
    "delta",
    "gamma",
    "theta",
    "vega",
    "pop",
]

SNAPSHOT_COLUMNS = [
    "timestamp",
    "instrument",
    "expiry",
    "strike",
    "underlying_key",
    "underlying_spot_price",
    "atm_strike",
    "pcr",
    *[f"ce_{suffix}" for suffix in OPTION_FIELD_SUFFIXES],
    *[f"pe_{suffix}" for suffix in OPTION_FIELD_SUFFIXES],
]

BASELINE_COLUMNS = [
    "date",
    "baseline_type",
    "snapshot_timestamp",
    *[column for column in SNAPSHOT_COLUMNS if column != "timestamp"],
]

TEXT_COLUMNS = {
    "timestamp",
    "date",
    "baseline_type",
    "snapshot_timestamp",
    "instrument",
    "expiry",
    "underlying_key",
    "ce_instrument_key",
    "pe_instrument_key",
}

NOT_NULL_COLUMNS = {
    "timestamp",
    "date",
    "baseline_type",
    "instrument",
    "expiry",
    "strike",
}


def connect() -> sqlite3.Connection:
    utils.db_path().parent.mkdir(parents=True, exist_ok=True)
    # timeout: Python-level busy handler so concurrent writers wait instead of
    # raising "database is locked" instantly (was the worker crash-loop cause).
    conn = sqlite3.connect(utils.db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    # WAL lets many readers run concurrently with a single writer; the prior
    # "delete" journal serialized every access (fetch 5s + trade 1s + compute +
    # API all collided). busy_timeout is belt-and-suspenders with the connect
    # timeout. synchronous=NORMAL is the safe/fast pairing for WAL.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _column_type(column: str) -> str:
    return "TEXT" if column in TEXT_COLUMNS else "REAL"


def _column_def(column: str, *, allow_not_null: bool) -> str:
    suffix = " NOT NULL" if allow_not_null and column in NOT_NULL_COLUMNS else ""
    return f"{column} {_column_type(column)}{suffix}"


def _create_columns_sql(columns: list[str]) -> str:
    column_defs = ["id INTEGER PRIMARY KEY AUTOINCREMENT"]
    column_defs.extend(_column_def(column, allow_not_null=True) for column in columns)
    return ",\n                ".join(column_defs)


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: list[str]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for column in columns:
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {_column_def(column, allow_not_null=False)}")


COMPUTED_TICK_COLUMNS = [
    "timestamp",
    "instrument",
    "spot_price",
    "atm_strike",
    "total_ce_oi",
    "total_pe_oi",
    "pcr",
    "ce_oi_change",
    "pe_oi_change",
    "ce_oi_cumm_change",
    "pe_oi_cumm_change",
    "oi_difference",
    "delta_pcr",
    "signed_pcr",
    "volume_pcr",
    "ce_volume",
    "pe_volume",
    "ce_iv_avg",
    "pe_iv_avg",
    "signal",
    "crossover",
]

COMPUTED_TICK_TEXT_COLUMNS = {"timestamp", "instrument", "signal"}


def initialize_storage() -> None:
    with closing(connect()) as conn, conn:
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS oi_snapshots (
                {_create_columns_sql(SNAPSHOT_COLUMNS)}
            );

            CREATE INDEX IF NOT EXISTS idx_oi_snapshots_lookup
                ON oi_snapshots (instrument, timestamp, strike);

            CREATE TABLE IF NOT EXISTS daily_baselines (
                {_create_columns_sql(BASELINE_COLUMNS)},
                UNIQUE(date, baseline_type, instrument, expiry, strike)
            );

            CREATE INDEX IF NOT EXISTS idx_daily_baselines_lookup
                ON daily_baselines (date, baseline_type, instrument, expiry, strike);

            CREATE TABLE IF NOT EXISTS chart_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                config_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chart_configs_updated
                ON chart_configs (updated_at);

            CREATE TABLE IF NOT EXISTS computed_ticks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                instrument TEXT NOT NULL,
                spot_price REAL,
                atm_strike REAL,
                total_ce_oi REAL,
                total_pe_oi REAL,
                pcr REAL,
                ce_oi_change REAL,
                pe_oi_change REAL,
                ce_oi_cumm_change REAL,
                pe_oi_cumm_change REAL,
                oi_difference REAL,
                delta_pcr REAL,
                signed_pcr REAL,
                volume_pcr REAL,
                ce_volume REAL,
                pe_volume REAL,
                ce_iv_avg REAL,
                pe_iv_avg REAL,
                signal TEXT,
                crossover INTEGER,
                UNIQUE(timestamp, instrument)
            );

            CREATE INDEX IF NOT EXISTS idx_computed_ticks_lookup
                ON computed_ticks (instrument, timestamp);
            """
        )
        _ensure_columns(conn, "oi_snapshots", SNAPSHOT_COLUMNS)
        _ensure_columns(conn, "daily_baselines", BASELINE_COLUMNS)
        # Ensure computed_ticks columns are up-to-date
        _ensure_computed_tick_columns(conn)
        # Trade subsystem tables (orders, positions, configs, audit, reports)
        try:
            import trade
            trade.init_schema(conn)
        except Exception:
            logger.exception("trade.init_schema failed; continuing without trade tables")
    logger.info("SQLite initialized at %s", utils.db_path())


def _ensure_computed_tick_columns(conn: sqlite3.Connection) -> None:
    """Add any missing columns to computed_ticks table."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(computed_ticks)").fetchall()}
    for column in COMPUTED_TICK_COLUMNS:
        if column not in existing:
            col_type = "TEXT" if column in COMPUTED_TICK_TEXT_COLUMNS else "REAL"
            if column == "crossover":
                col_type = "INTEGER"
            conn.execute(f"ALTER TABLE computed_ticks ADD COLUMN {column} {col_type}")


def _csv_path(instrument: str, timestamp: str) -> Any:
    return utils.logs_dir() / f"{timestamp[:10]}_{instrument}.csv"


def append_raw_csv(raw_data: dict[str, dict[str, Any] | None]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for instrument, payload in raw_data.items():
        if not payload:
            counts[instrument] = 0
            continue

        timestamp = str(payload["timestamp"])
        expiry = str(payload["expiry"])
        rows: list[dict[str, Any]] = []
        for strike_row in payload.get("strikes") or []:
            if not isinstance(strike_row, dict):
                continue
            rows.append(
                utils.format_option_csv_row(
                    timestamp=timestamp,
                    instrument=instrument,
                    expiry=expiry,
                    strike_row=strike_row,
                    option_type="CE",
                )
            )
            rows.append(
                utils.format_option_csv_row(
                    timestamp=timestamp,
                    instrument=instrument,
                    expiry=expiry,
                    strike_row=strike_row,
                    option_type="PE",
                )
            )

        if rows:
            path = _csv_path(instrument, timestamp)
            path.parent.mkdir(parents=True, exist_ok=True)
            write_header = not path.exists() or path.stat().st_size == 0
            with path.open("a", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
                if write_header:
                    writer.writeheader()
                writer.writerows(rows)
        counts[instrument] = len(rows)
    return counts


def build_filtered_snapshots(
    raw_data: dict[str, dict[str, Any] | None],
) -> dict[str, dict[str, Any] | None]:
    filtered: dict[str, dict[str, Any] | None] = {}
    for instrument, payload in raw_data.items():
        if not payload:
            filtered[instrument] = None
            continue
        filtered_payload = utils.filter_atm_window(payload)
        if not filtered_payload:
            logger.error("Missing spot price for %s; skipping SQLite snapshot", instrument)
        filtered[instrument] = filtered_payload
    return filtered


def _option_db_values(strike_row: dict[str, Any], option_type: str) -> list[Any]:
    payload = utils.option_payload(strike_row, option_type)
    market_data = utils.option_market_data(strike_row, option_type)
    greeks = utils.option_greeks(strike_row, option_type)
    return [
        payload.get("instrument_key"),
        utils.safe_float(market_data.get("ltp")),
        utils.safe_float(market_data.get("oi")),
        utils.safe_float(market_data.get("prev_oi")),
        utils.safe_float(market_data.get("volume")),
        utils.safe_float(market_data.get("close_price")),
        utils.safe_float(market_data.get("bid_price")),
        utils.safe_float(market_data.get("bid_qty")),
        utils.safe_float(market_data.get("ask_price")),
        utils.safe_float(market_data.get("ask_qty")),
        utils.safe_float(greeks.get("iv")),
        utils.safe_float(greeks.get("delta")),
        utils.safe_float(greeks.get("gamma")),
        utils.safe_float(greeks.get("theta")),
        utils.safe_float(greeks.get("vega")),
        utils.safe_float(greeks.get("pop")),
    ]


def _snapshot_db_row(instrument: str, payload: dict[str, Any], strike_row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        payload["timestamp"],
        instrument,
        strike_row.get("expiry") or payload["expiry"],
        utils.safe_float(strike_row.get("strike_price")),
        strike_row.get("underlying_key"),
        utils.safe_float(strike_row.get("underlying_spot_price")),
        utils.safe_float(payload.get("atm_strike")),
        utils.safe_float(strike_row.get("pcr")),
        *_option_db_values(strike_row, "CE"),
        *_option_db_values(strike_row, "PE"),
    )


def write_snapshot(filtered_data: dict[str, dict[str, Any] | None]) -> dict[str, int]:
    rows: list[tuple[Any, ...]] = []
    counts: dict[str, int] = {}

    for instrument, payload in filtered_data.items():
        if not payload:
            counts[instrument] = 0
            continue
        row_count = 0
        for strike_row in payload.get("strikes") or []:
            rows.append(_snapshot_db_row(instrument, payload, strike_row))
            row_count += 1
        counts[instrument] = row_count

    if rows:
        columns = ", ".join(SNAPSHOT_COLUMNS)
        placeholders = ", ".join("?" for _ in SNAPSHOT_COLUMNS)
        with closing(connect()) as conn, conn:
            conn.executemany(
                f"INSERT INTO oi_snapshots ({columns}) VALUES ({placeholders})",
                rows,
            )
    return counts


def persist_market_data(raw_data: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    csv_counts = append_raw_csv(raw_data)
    filtered = build_filtered_snapshots(raw_data)
    snapshot_counts = write_snapshot(filtered)
    summary = {
        "csv_counts": csv_counts,
        "snapshot_counts": snapshot_counts,
        "filtered_counts": {
            instrument: len(payload.get("strikes") or []) if payload else 0
            for instrument, payload in filtered.items()
        },
    }
    logger.info("Persisted market data: %s", summary)
    return summary


def count_baseline_rows(baseline_type: str, date: str) -> dict[str, int]:
    """Return how many baseline rows already exist per instrument."""
    counts: dict[str, int] = {}
    with closing(connect()) as conn, conn:
        for instrument in utils.instrument_names():
            row = conn.execute(
                "SELECT COUNT(*) AS rows FROM daily_baselines "
                "WHERE date = ? AND baseline_type = ? AND instrument = ?",
                (date, baseline_type, instrument),
            ).fetchone()
            counts[instrument] = int(row["rows"]) if row else 0
    return counts


def save_baseline(baseline_type: str, date: str | None = None) -> dict[str, int]:
    if baseline_type not in {"post_settlement", "prev_close", "market_open"}:
        raise ValueError("baseline_type must be post_settlement, prev_close, or market_open")

    baseline_date = date or utils.today_ist()
    counts: dict[str, int] = {}
    with closing(connect()) as conn, conn:
        for instrument in utils.instrument_names():
            if baseline_type in ("post_settlement", "market_open"):
                existing = conn.execute(
                    """
                    SELECT COUNT(*) AS rows
                    FROM daily_baselines
                    WHERE date = ? AND baseline_type = ? AND instrument = ?
                    """,
                    (baseline_date, baseline_type, instrument),
                ).fetchone()["rows"]
                if existing:
                    counts[instrument] = int(existing)
                    logger.info(
                        "Baseline %s/%s already exists for %s; preserving it",
                        baseline_type,
                        instrument,
                        baseline_date,
                    )
                    continue

            latest = conn.execute(
                """
                SELECT MAX(timestamp) AS timestamp
                FROM oi_snapshots
                WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
                """,
                (instrument, baseline_date),
            ).fetchone()["timestamp"]
            if not latest:
                counts[instrument] = 0
                logger.warning(
                    "No snapshot available for baseline %s/%s on %s",
                    baseline_type,
                    instrument,
                    baseline_date,
                )
                continue

            snapshot_columns = ", ".join(SNAPSHOT_COLUMNS)
            rows = conn.execute(
                f"""
                SELECT {snapshot_columns}
                FROM oi_snapshots
                WHERE instrument = ? AND timestamp = ?
                """,
                (instrument, latest),
            ).fetchall()
            baseline_columns = ", ".join(BASELINE_COLUMNS)
            placeholders = ", ".join("?" for _ in BASELINE_COLUMNS)
            source_columns = [column for column in SNAPSHOT_COLUMNS if column != "timestamp"]
            conn.executemany(
                f"INSERT OR REPLACE INTO daily_baselines ({baseline_columns}) VALUES ({placeholders})",
                [
                    (
                        baseline_date,
                        baseline_type,
                        row["timestamp"],
                        *(row[column] for column in source_columns),
                    )
                    for row in rows
                ],
            )
            counts[instrument] = len(rows)
    logger.info("Baseline %s frozen for %s: %s", baseline_type, baseline_date, counts)
    return counts


def _query(query: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    with closing(connect()) as conn, conn:
        return utils.row_dicts(conn.execute(query, params).fetchall())


# Raw fetch happens every 30s but the UI is meant to operate on 1-minute bars.
# This subquery picks the latest raw snapshot within each minute for one
# instrument + date. Callers add `AND <ts> IN (MINUTE_FILTER_SQL)` and append
# (instrument, date) to the params.
MINUTE_FILTER_SQL = """
    SELECT MAX(timestamp) FROM oi_snapshots
    WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
    GROUP BY substr(timestamp, 1, 16)
"""


def floor_ts_to_minute(ts: str) -> str:
    """Truncate seconds on an ISO-8601 timestamp string.

    Used by read endpoints so the UI always sees clean :00 minute boundaries
    even though raw fetches at 30s land at :30 and drift over time.
    """
    if not ts or len(ts) < 19:
        return ts
    return ts[:17] + "00" + ts[19:]


def _floor_rows(rows: list[dict[str, Any]], key: str = "timestamp") -> list[dict[str, Any]]:
    for row in rows:
        if key in row and isinstance(row[key], str):
            row[key] = floor_ts_to_minute(row[key])
    return rows


def get_pcr_series(instrument: str, date: str) -> list[dict[str, Any]]:
    return _floor_rows(_query(
        f"""
        SELECT
            timestamp,
            CASE WHEN SUM(COALESCE(ce_oi, 0)) > 0
                THEN SUM(COALESCE(pe_oi, 0)) / SUM(COALESCE(ce_oi, 0))
                ELSE NULL
            END AS pcr_value,
            AVG(underlying_spot_price) AS underlying_spot_price
        FROM oi_snapshots
        WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
          AND timestamp IN ({MINUTE_FILTER_SQL})
        GROUP BY timestamp
        ORDER BY timestamp
        """,
        (instrument, date, instrument, date),
    ))


def get_total_oi_series(instrument: str, date: str) -> list[dict[str, Any]]:
    return _floor_rows(_query(
        f"""
        SELECT
            timestamp,
            SUM(COALESCE(ce_oi, 0)) AS total_ce_oi,
            SUM(COALESCE(pe_oi, 0)) AS total_pe_oi,
            AVG(underlying_spot_price) AS underlying_spot_price
        FROM oi_snapshots
        WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
          AND timestamp IN ({MINUTE_FILTER_SQL})
        GROUP BY timestamp
        ORDER BY timestamp
        """,
        (instrument, date, instrument, date),
    ))


def _sr_pair(spot: float | None, strikes: list[dict[str, Any]]) -> tuple[dict, dict] | None:
    if spot is None or not strikes:
        return None
    lower = None
    upper = None
    for s in strikes:  # strikes is pre-sorted ascending
        if s["strike"] <= spot:
            lower = s
        elif upper is None and s["strike"] > spot:
            upper = s
            break
    if lower is None or upper is None:
        return None
    return lower, upper


def _sr_scan(strikes: list[dict[str, Any]], start_strike: float, side: str) -> list[dict[str, Any]]:
    start_idx = next((i for i, s in enumerate(strikes) if s["strike"] == start_strike), -1)
    if start_idx < 0:
        return []
    step = 1 if side == "CE" else -1
    out = []
    for i in range(5):
        idx = start_idx + i * step
        if 0 <= idx < len(strikes):
            out.append(strikes[idx])
    return out


def _sr_primary(scan: list[dict[str, Any]], side: str) -> tuple[float | None, bool]:
    """Returns (primary_strike, is_weak_outward)."""
    if not scan:
        return None, False
    if side == "CE":
        oi_vals = [s["ce_oi"] or 0 for s in scan]
        vol_vals = [s["ce_volume"] or 0 for s in scan]
        chg_vals = [max(0, s["ce_chg_oi"] or 0) for s in scan]
    else:
        oi_vals = [s["pe_oi"] or 0 for s in scan]
        vol_vals = [s["pe_volume"] or 0 for s in scan]
        chg_vals = [max(0, s["pe_chg_oi"] or 0) for s in scan]
    max_oi = max(oi_vals) or 0
    max_vol = max(vol_vals) or 0
    max_chg = max(chg_vals) or 0
    rows = []
    for i, s in enumerate(scan):
        oi_pct = oi_vals[i] / max_oi * 100 if max_oi else 0.0
        vol_pct = vol_vals[i] / max_vol * 100 if max_vol else 0.0
        chg_pct = chg_vals[i] / max_chg * 100 if max_chg else 0.0
        combined = (oi_pct + vol_pct + chg_pct) / 3
        rows.append((s["strike"], oi_pct, vol_pct, chg_pct, combined))
    primary_idx = max(range(len(rows)), key=lambda i: rows[i][4])
    is_weak = False
    if primary_idx + 1 < len(rows):
        nxt = rows[primary_idx + 1]
        nxt_avg = (nxt[1] + nxt[2] + nxt[3]) / 3
        is_weak = nxt_avg > 75
    return rows[primary_idx][0], is_weak


def get_sr_history(instrument: str, date: str) -> list[dict[str, Any]]:
    """Replay every minute of the day and return the chronological list of
    Support/Resistance shifts (only rows where any of S/R/WTB/WTT changed).

    Uses a single ORDER BY query and groups by minute in Python — avoids the
    slow JOIN pattern while still producing one snapshot per minute.
    """
    with closing(connect()) as conn, conn:
        rows = conn.execute(
            """
            SELECT timestamp, strike, underlying_spot_price,
                   ce_oi, ce_prev_oi, ce_volume,
                   pe_oi, pe_prev_oi, pe_volume
            FROM oi_snapshots
            WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
              AND substr(timestamp, 12, 5) >= '09:15'
              AND substr(timestamp, 12, 5) <= '15:30'
            ORDER BY timestamp, strike
            """,
            (instrument, date),
        ).fetchall()
    if not rows:
        return []

    # Group into minute buckets in Python; within each minute keep the latest
    # timestamp per strike (rows are time-ordered so last wins naturally).
    # key = HH:MM (16-char prefix), value = {strike: row}
    minute_buckets: dict[str, dict[float, Any]] = {}
    minute_order: list[str] = []
    for r in rows:
        minute = r["timestamp"][:16]   # "YYYY-MM-DDTHH:MM"
        if minute not in minute_buckets:
            minute_buckets[minute] = {}
            minute_order.append(minute)
        minute_buckets[minute][r["strike"]] = r  # later ts overwrites earlier

    history: list[dict[str, Any]] = []
    prev: dict[str, Any] | None = None
    for minute in minute_order:
        bucket = minute_buckets[minute]
        strikes = sorted(
            [{
                "strike": r["strike"],
                "underlying_spot_price": r["underlying_spot_price"],
                "ce_oi": r["ce_oi"] or 0,
                "ce_chg_oi": (r["ce_oi"] or 0) - (r["ce_prev_oi"] or 0),
                "ce_volume": r["ce_volume"] or 0,
                "pe_oi": r["pe_oi"] or 0,
                "pe_chg_oi": (r["pe_oi"] or 0) - (r["pe_prev_oi"] or 0),
                "pe_volume": r["pe_volume"] or 0,
            } for r in bucket.values()],
            key=lambda s: s["strike"],
        )
        ts = minute + ":00"  # representative timestamp for this minute
        spot = next((s["underlying_spot_price"] for s in strikes if s["underlying_spot_price"] is not None), None)
        pair = _sr_pair(spot, strikes)
        if not pair:
            continue
        lower, upper = pair
        ce_scan = _sr_scan(strikes, lower["strike"], "CE")
        pe_scan = _sr_scan(strikes, upper["strike"], "PE")
        resistance, wtt = _sr_primary(ce_scan, "CE")
        support, wtb = _sr_primary(pe_scan, "PE")
        snap = {
            "timestamp": ts,
            "spot": spot,
            "pairLow": lower["strike"],
            "pairHigh": upper["strike"],
            "support": support,
            "resistance": resistance,
            "wtb": wtb,
            "wtt": wtt,
        }
        if prev is None:
            snap["direction"] = "Init"
            history.append(snap)
            prev = snap
            continue
        # Skip if nothing changed
        if (snap["support"] == prev["support"] and snap["resistance"] == prev["resistance"]
                and snap["wtb"] == prev["wtb"] and snap["wtt"] == prev["wtt"]):
            continue
        sup_up = snap["support"] is not None and prev["support"] is not None and snap["support"] > prev["support"]
        sup_dn = snap["support"] is not None and prev["support"] is not None and snap["support"] < prev["support"]
        res_up = snap["resistance"] is not None and prev["resistance"] is not None and snap["resistance"] > prev["resistance"]
        res_dn = snap["resistance"] is not None and prev["resistance"] is not None and snap["resistance"] < prev["resistance"]
        if (sup_up and res_up) or (sup_up and not res_dn) or (not sup_dn and res_up):
            direction = "Bullish"
        elif (sup_dn and res_dn) or (sup_dn and not res_up) or (not sup_up and res_dn):
            direction = "Bearish"
        else:
            direction = "Range"
        snap["direction"] = direction
        history.append(snap)
        prev = snap
    return history


def get_option_chain_latest(instrument: str, date: str) -> dict[str, Any] | None:
    """Return the latest per-strike option-chain snapshot for the date.

    Powers the Support/Resistance tab: callers need every strike's current
    OI / day-cumulative Volume / Chg OI (vs prev-day close) plus the live
    spot, all at the most recent tick. The per-strike ``ce_volume`` field
    in oi_snapshots is already broker-reported day cumulative — no SUM
    needed across timestamps.
    """
    with closing(connect()) as conn, conn:
        latest = conn.execute(
            "SELECT MAX(timestamp) AS ts FROM oi_snapshots "
            "WHERE instrument = ? AND substr(timestamp, 1, 10) = ?",
            (instrument, date),
        ).fetchone()
        if not latest or not latest["ts"]:
            return None
        ts = latest["ts"]
        rows = conn.execute(
            "SELECT strike, underlying_spot_price, "
            "       ce_oi, ce_prev_oi, ce_volume, "
            "       pe_oi, pe_prev_oi, pe_volume "
            "FROM oi_snapshots "
            "WHERE instrument = ? AND timestamp = ? "
            "ORDER BY strike",
            (instrument, ts),
        ).fetchall()
        if not rows:
            return None
        spot = next((r["underlying_spot_price"] for r in rows if r["underlying_spot_price"] is not None), None)
        strikes = [{
            "strike": r["strike"],
            "ce_oi": r["ce_oi"] or 0,
            "ce_prev_oi": r["ce_prev_oi"] or 0,
            "ce_chg_oi": (r["ce_oi"] or 0) - (r["ce_prev_oi"] or 0),
            "ce_volume": r["ce_volume"] or 0,
            "pe_oi": r["pe_oi"] or 0,
            "pe_prev_oi": r["pe_prev_oi"] or 0,
            "pe_chg_oi": (r["pe_oi"] or 0) - (r["pe_prev_oi"] or 0),
            "pe_volume": r["pe_volume"] or 0,
        } for r in rows]
        return {
            "timestamp": ts,
            "spot_price": spot,
            "strikes": strikes,
        }


_VOL_SERIES_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_VOL_SERIES_TTL_S = 2.0


def _date_bounds(date: str) -> tuple[str, str]:
    """(date, next_date) for sargable timestamp-range filters.

    ISO timestamps sort lexically, so `timestamp >= date AND timestamp < next`
    selects exactly one day via the (instrument, timestamp) index — far faster
    than `substr(timestamp,1,10)=date`, which is non-sargable and scans the
    instrument's entire multi-day history (the table holds millions of rows)."""
    from datetime import datetime, timedelta
    try:
        nxt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    except ValueError:
        nxt = date + "~"  # '~' sorts after 'T...'; still bounds the day
    return date, nxt


def get_total_volume_series(instrument: str, date: str) -> list[dict[str, Any]]:
    """Per-fetch total CE/PE volume across all strikes.

    Cached for a couple of seconds: volume/VWAP/LTP signals each call this on
    every 1s engine tick, but the underlying data only changes every 5s. The
    TTL cache collapses those redundant full-day scans without affecting the
    5s strategy cadence.

    Unlike the OI series (1-minute bars via MINUTE_FILTER_SQL), volume is
    returned at the full raw fetch cadence (every 15s) and is NOT floored to
    the minute — the user wants volume logs at 15-second granularity while
    OI stays minute-level. Each raw fetch lands one timestamp; grouping by
    timestamp aggregates that fetch's strikes.
    """
    import time as _time
    ck = (instrument, date)
    cached = _VOL_SERIES_CACHE.get(ck)
    now = _time.monotonic()
    if cached is not None and (now - cached[0]) < _VOL_SERIES_TTL_S:
        return cached[1]

    # Restrict to market hours (09:15–15:30 IST). oi_snapshots also holds a
    # pre-open prev_close baseline fetch (~00:00) whose cumulative volume would
    # otherwise pollute the first row — the frontend strips it too, but doing
    # it here keeps the trade engine's volume crossover identical to the tab.
    # ATM ± 5-OTM band, dynamic per fetch (atm_strike is stored per row):
    #   CE  = ATM .. ATM+5  (OTM calls)   -> strike in [atm, atm + 5*step]
    #   PE  = ATM-5 .. ATM  (OTM puts)    -> strike in [atm - 5*step, atm]
    # total_* keep ALL strikes (used by VWAP); atm_* are the scanner volumes
    # (CE/PE Vol columns, VOL DIFF, Volume PCR, and the volume crossover signal).
    band = 5 * _strike_step(instrument)
    result = _query(
        """
        SELECT
            timestamp,
            SUM(COALESCE(ce_volume, 0)) AS total_ce_volume,
            SUM(COALESCE(pe_volume, 0)) AS total_pe_volume,
            SUM(CASE WHEN atm_strike IS NOT NULL
                      AND strike >= atm_strike AND strike <= atm_strike + ?
                     THEN COALESCE(ce_volume, 0) ELSE 0 END) AS atm_ce_volume,
            SUM(CASE WHEN atm_strike IS NOT NULL
                      AND strike <= atm_strike AND strike >= atm_strike - ?
                     THEN COALESCE(pe_volume, 0) ELSE 0 END) AS atm_pe_volume,
            AVG(underlying_spot_price) AS underlying_spot_price,
            MAX(atm_strike) AS atm_strike
        FROM oi_snapshots
        WHERE instrument = ? AND timestamp >= ? AND timestamp < ?
          AND substr(timestamp, 12, 5) >= '09:15'
          AND substr(timestamp, 12, 5) <= '15:30'
        GROUP BY timestamp
        ORDER BY timestamp
        """,
        (band, band, instrument, *_date_bounds(date)),
    )
    _VOL_SERIES_CACHE[ck] = (now, result)
    return result


# ── LTP-Based Option Strength engine (Dr. Vijay's spec) ──────────────────

_STRIKE_STEP_DEFAULTS = {"nifty": 50, "banknifty": 100, "sensex": 100}


def _strike_step(instrument: str) -> int:
    try:
        cfg = utils.instrument_config(instrument) or {}
        step = int(cfg.get("strike_step") or 0)
        if step > 0:
            return step
    except Exception:
        pass
    return _STRIKE_STEP_DEFAULTS.get(instrument, 50)


def _sod(ts: str) -> int:
    """Seconds-of-day from an ISO timestamp (HH:MM:SS slice)."""
    try:
        return int(ts[11:13]) * 3600 + int(ts[14:16]) * 60 + int(ts[17:19])
    except (ValueError, IndexError):
        return 0


def _ltp_decide(ce_sum: float, pe_sum: float, dir_strength: float,
                rolling_strength: float, spot: float, vwap: float):
    """Return (signal, market_state) per spec STEP 11–13.

    signal: 'BUY' (→CE) / 'SELL' (→PE) / None — the strict actionable signal.
    market_state: the looser STEP 11 quadrant label.
    """
    above_vwap = vwap > 0 and spot > vwap
    below_vwap = vwap > 0 and spot < vwap
    # STEP 12 — strict BUY CE
    if ce_sum > 0 and pe_sum < 0 and dir_strength > 0 and rolling_strength > 0 and above_vwap:
        return "BUY", "BUY CE"
    # STEP 13 — strict BUY PE
    if ce_sum < 0 and pe_sum > 0 and dir_strength < 0 and rolling_strength < 0 and below_vwap:
        return "SELL", "BUY PE"
    # STEP 11 — market state quadrants
    if ce_sum > 0 and pe_sum < 0:
        return None, "BUY CE (unconfirmed)"
    if ce_sum < 0 and pe_sum > 0:
        return None, "BUY PE (unconfirmed)"
    if ce_sum > 0 and pe_sum > 0:
        return None, "IV Expansion / Wait"
    if ce_sum < 0 and pe_sum < 0:
        return None, "IV Crush / Avoid"
    return None, "Neutral"


def _ltp_build(instrument: str, date: str, *, itm_depth: int = 3):
    """Compute the LTP-strength series + return the loaded structures so the
    snapshot view can also build a per-strike bucket breakdown without a
    second scan. Returns (series, by_ts, order, ref_ce, ref_pe, step)."""
    step = _strike_step(instrument)
    # The strategy only ever needs ATM ± itm_depth strikes. ATM shifts a little
    # intraday, so restrict the (expensive) per-strike scan to the day's ATM
    # range padded by itm_depth steps — ~10 strikes instead of ~100.
    band = _query(
        """
        SELECT MIN(atm_strike) AS lo, MAX(atm_strike) AS hi FROM oi_snapshots
        WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
          AND substr(timestamp, 12, 5) >= '09:15' AND substr(timestamp, 12, 5) <= '15:30'
          AND atm_strike IS NOT NULL
        """,
        (instrument, date),
    )
    if not band or band[0]["lo"] is None:
        return [], {}, [], {}, {}, step
    lo = float(band[0]["lo"]) - itm_depth * step
    hi = float(band[0]["hi"]) + itm_depth * step
    rows = _query(
        """
        SELECT timestamp, strike, atm_strike, underlying_spot_price, ce_ltp, pe_ltp
        FROM oi_snapshots
        WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
          AND substr(timestamp, 12, 5) >= '09:15'
          AND substr(timestamp, 12, 5) <= '15:30'
          AND strike >= ? AND strike <= ?
        ORDER BY timestamp, strike
        """,
        (instrument, date, lo, hi),
    )
    if not rows:
        return [], {}, [], {}, {}, step

    # Group per timestamp: { ts: {atm, spot, ce:{strike:ltp}, pe:{strike:ltp}} }
    by_ts: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for r in rows:
        ts = r["timestamp"]
        d = by_ts.get(ts)
        if d is None:
            d = {"atm": r["atm_strike"], "spot": r["underlying_spot_price"], "ce": {}, "pe": {}}
            by_ts[ts] = d
            order.append(ts)
        if r["ce_ltp"] is not None:
            d["ce"][r["strike"]] = r["ce_ltp"]
        if r["pe_ltp"] is not None:
            d["pe"][r["strike"]] = r["pe_ltp"]

    # Reference LTP per (side, strike) = first market tick it appears in.
    ref_ce: dict[float, float] = {}
    ref_pe: dict[float, float] = {}
    for ts in order:
        for k, v in by_ts[ts]["ce"].items():
            ref_ce.setdefault(k, v)
        for k, v in by_ts[ts]["pe"].items():
            ref_pe.setdefault(k, v)

    # VWAP per timestamp (same formula as the volume tab / trade engine).
    vwap_by_ts: dict[str, float] = {}
    vol_series = get_total_volume_series(instrument, date)
    cum_pv = cum_vol = 0.0
    pce = ppe = None
    for vr in vol_series:
        ce = vr.get("total_ce_volume") or 0.0
        pe = vr.get("total_pe_volume") or 0.0
        spot = vr.get("underlying_spot_price") or 0.0
        cd = max(0.0, ce - pce) if pce is not None else ce
        pd = max(0.0, pe - ppe) if ppe is not None else pe
        pce, ppe = ce, pe
        tv = cd + pd
        if spot > 0 and tv > 0:
            cum_pv += spot * tv
            cum_vol += tv
        vwap_by_ts[vr["timestamp"]] = (cum_pv / cum_vol) if cum_vol > 0 else 0.0

    sods = [_sod(ts) for ts in order]

    # Two-pointer indices for "5 min ago" and "1 min ago".
    out: list[dict[str, Any]] = []
    dir_vals: list[float] = []
    j5 = j1 = 0
    for i, ts in enumerate(order):
        d = by_ts[ts]
        atm = d["atm"]
        spot = d["spot"] or 0.0
        if atm is None:
            continue
        ce_strikes = [atm - k * step for k in range(itm_depth + 1)]  # ATM + ITM (lower)
        pe_strikes = [atm + k * step for k in range(itm_depth + 1)]  # ATM + ITM (higher)

        def sess(side_now, side_ref, strike):
            cur = side_now.get(strike)
            rf = side_ref.get(strike)
            return (cur - rf) if (cur is not None and rf is not None) else 0.0

        ce_sum = sum(sess(d["ce"], ref_ce, s) for s in ce_strikes)
        pe_sum = sum(sess(d["pe"], ref_pe, s) for s in pe_strikes)
        dir_strength = ce_sum - pe_sum

        # Rolling 5-min strength: ΣΔ(CE) − ΣΔ(PE) vs the tick ~5 min ago.
        while j5 < i and sods[j5] < sods[i] - 300:
            j5 += 1
        ref5 = by_ts[order[j5]] if j5 < i else None
        if ref5 is not None:
            r_ce = sum((d["ce"].get(s, 0) or 0) - (ref5["ce"].get(s, 0) or 0) for s in ce_strikes)
            r_pe = sum((d["pe"].get(s, 0) or 0) - (ref5["pe"].get(s, 0) or 0) for s in pe_strikes)
            rolling_strength = r_ce - r_pe
        else:
            rolling_strength = 0.0

        vwap = vwap_by_ts.get(ts, 0.0)
        signal, market_state = _ltp_decide(ce_sum, pe_sum, dir_strength, rolling_strength, spot, vwap)

        # Momentum of directional strength.
        mom_5s = dir_strength - dir_vals[i - 1] if i >= 1 else 0.0
        while j1 < i and sods[j1] < sods[i] - 60:
            j1 += 1
        mom_1m = dir_strength - dir_vals[j1] if (j1 < i and dir_vals) else 0.0

        dir_vals.append(dir_strength)
        out.append({
            "timestamp": ts,
            "atm": atm,
            "spot": round(spot, 2),
            "ce_sum": round(ce_sum, 2),
            "pe_sum": round(pe_sum, 2),
            "directional_strength": round(dir_strength, 2),
            "rolling_strength": round(rolling_strength, 2),
            "momentum_5s": round(mom_5s, 2),
            "momentum_1m": round(mom_1m, 2),
            "vwap": round(vwap, 2) if vwap else None,
            "vwap_status": ("Above" if vwap and spot > vwap else "Below" if vwap and spot < vwap else "—"),
            "market_state": market_state,
            "signal": signal,
        })
    return out, by_ts, order, ref_ce, ref_pe, step


def get_ltp_strength_series(instrument: str, date: str, *, itm_depth: int = 3) -> list[dict[str, Any]]:
    """Whole-day LTP-strength series (used for CSV export)."""
    return _ltp_build(instrument, date, itm_depth=itm_depth)[0]


def get_ltp_strength_snapshot(instrument: str, date: str, *, itm_depth: int = 3) -> dict[str, Any] | None:
    """Latest LTP-strength state + per-strike bucket breakdown that builds
    CE_SUM / PE_SUM. For each of ATM + itm_depth ITM strikes per side:
    reference LTP (09:15 baseline), current LTP, session change, rolling change.

    Latest-only: a few single-timestamp lookups (not the whole-day series), so
    cost is O(1) in tick count. The series build grew to ~11s by mid-session for
    the heavier instruments — far too slow for the LTP tab's 5s auto-refresh.
    """
    from datetime import datetime, timedelta
    step = _strike_step(instrument)
    lo, hi = _date_bounds(date)  # sargable day range (uses the timestamp index)
    rows = _query(
        "SELECT MAX(timestamp) AS ts FROM oi_snapshots WHERE instrument=? "
        "AND timestamp>=? AND timestamp<? AND substr(timestamp,12,5)>='09:15' "
        "AND substr(timestamp,12,5)<='15:30'",
        (instrument, lo, hi),
    )
    ts = rows[0]["ts"] if rows else None
    if not ts:
        return None
    head = _query(
        "SELECT atm_strike, underlying_spot_price FROM oi_snapshots "
        "WHERE instrument=? AND timestamp=? LIMIT 1",
        (instrument, ts),
    )
    if not head or head[0]["atm_strike"] is None:
        return None
    atm = float(head[0]["atm_strike"])
    spot = utils.safe_float(head[0]["underlying_spot_price"], 0.0) or 0.0

    ce_strikes = [atm - k * step for k in range(itm_depth + 1)]  # ATM + ITM (lower)
    pe_strikes = [atm + k * step for k in range(itm_depth + 1)]  # ATM + ITM (higher)
    all_strikes = sorted(set(ce_strikes + pe_strikes))
    ph = ",".join("?" for _ in all_strikes)

    def fetch_at(stamp: str | None) -> dict[float, Any]:
        if not stamp:
            return {}
        return {
            r["strike"]: r
            for r in _query(
                f"SELECT strike, ce_ltp, pe_ltp FROM oi_snapshots "
                f"WHERE instrument=? AND timestamp=? AND strike IN ({ph})",
                (instrument, stamp, *all_strikes),
            )
        }

    def tick_at_or_before(hms: str | None) -> str | None:
        if not hms:
            return None
        r = _query(
            "SELECT MAX(timestamp) AS ts FROM oi_snapshots WHERE instrument=? "
            "AND timestamp>=? AND timestamp<? AND substr(timestamp,12,8)<=?",
            (instrument, lo, hi, hms),
        )
        return r[0]["ts"] if r and r[0]["ts"] else None

    def hms_minus(stamp: str, **kw) -> str | None:
        try:
            return (datetime.fromisoformat(stamp) - timedelta(**kw)).strftime("%H:%M:%S")
        except ValueError:
            return None

    first_ts = _query(
        "SELECT MIN(timestamp) AS ts FROM oi_snapshots WHERE instrument=? "
        "AND timestamp>=? AND timestamp<? AND substr(timestamp,12,5)>='09:15'",
        (instrument, lo, hi),
    )[0]["ts"]
    prev = _query(
        "SELECT MAX(timestamp) AS ts FROM oi_snapshots WHERE instrument=? "
        "AND timestamp>=? AND timestamp<? AND substr(timestamp,12,5)>='09:15'",
        (instrument, lo, ts),
    )
    prev_ts = prev[0]["ts"] if prev and prev[0]["ts"] else None
    ts5 = tick_at_or_before(hms_minus(ts, minutes=5))
    ts1 = tick_at_or_before(hms_minus(ts, minutes=1))

    cur = fetch_at(ts)
    ref = fetch_at(first_ts)
    ago5 = fetch_at(ts5) if (ts5 and ts5 != ts) else {}
    ago1 = fetch_at(ts1) if (ts1 and ts1 != ts) else {}
    agoP = fetch_at(prev_ts) if (prev_ts and prev_ts != ts) else {}

    def _ltp(d: dict, s: float, col: str):
        r = d.get(s)
        return utils.safe_float(r[col], None) if r else None

    def sess(strikes: list[float], col: str, src: dict) -> float:
        tot = 0.0
        for s in strikes:
            c = _ltp(src, s, col)
            rf = _ltp(ref, s, col)
            if c is not None and rf is not None:
                tot += c - rf
        return tot

    def roll(strikes: list[float], col: str, ago: dict) -> float:
        if not ago:
            return 0.0
        tot = 0.0
        for s in strikes:
            c = _ltp(cur, s, col)
            a = _ltp(ago, s, col)
            if c is not None and a is not None:
                tot += c - a
        return tot

    ce_sum = sess(ce_strikes, "ce_ltp", cur)
    pe_sum = sess(pe_strikes, "pe_ltp", cur)
    dir_strength = ce_sum - pe_sum
    rolling_strength = roll(ce_strikes, "ce_ltp", ago5) - roll(pe_strikes, "pe_ltp", ago5)

    def dir_at(src: dict):
        if not src:
            return None
        return sess(ce_strikes, "ce_ltp", src) - sess(pe_strikes, "pe_ltp", src)

    dir_prev = dir_at(agoP)
    dir_1m = dir_at(ago1)
    momentum_5s = (dir_strength - dir_prev) if dir_prev is not None else 0.0
    momentum_1m = (dir_strength - dir_1m) if dir_1m is not None else 0.0

    # Session VWAP (same formula as the series / volume tab). The volume series
    # is aggregated + TTL-cached, so this stays cheap.
    vwap = 0.0
    cum_pv = cum_vol = 0.0
    pce = ppe = None
    for vr in get_total_volume_series(instrument, date):
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

    signal, market_state = _ltp_decide(ce_sum, pe_sum, dir_strength, rolling_strength, spot, vwap)

    def bucket(col: str, strikes: list[float], ago: dict) -> list[dict[str, Any]]:
        out = []
        for i, s in enumerate(strikes):
            c = _ltp(cur, s, col)
            rf = _ltp(ref, s, col)
            a5 = _ltp(ago, s, col)
            out.append({
                "label": "ATM" if i == 0 else f"{i} ITM",
                "strike": s,
                "ref_ltp": round(rf, 2) if rf is not None else None,
                "cur_ltp": round(c, 2) if c is not None else None,
                "session_change": round(c - rf, 2) if (c is not None and rf is not None) else None,
                "rolling_change": round(c - a5, 2) if (c is not None and a5 is not None) else None,
            })
        return out

    cnt = _query(
        "SELECT COUNT(DISTINCT timestamp) AS n FROM oi_snapshots WHERE instrument=? "
        "AND timestamp>=? AND timestamp<? AND substr(timestamp,12,5)>='09:15' "
        "AND substr(timestamp,12,5)<='15:30'",
        (instrument, lo, hi),
    )
    ticks = cnt[0]["n"] if cnt else 0

    return {
        "timestamp": ts,
        "atm": atm,
        "spot": round(spot, 2),
        "ce_sum": round(ce_sum, 2),
        "pe_sum": round(pe_sum, 2),
        "directional_strength": round(dir_strength, 2),
        "rolling_strength": round(rolling_strength, 2),
        "momentum_5s": round(momentum_5s, 2),
        "momentum_1m": round(momentum_1m, 2),
        "vwap": round(vwap, 2) if vwap else None,
        "vwap_status": ("Above" if vwap and spot > vwap else "Below" if vwap and spot < vwap else "—"),
        "market_state": market_state,
        "signal": signal,
        "ticks": ticks,
        "ce_bucket": bucket("ce_ltp", ce_strikes, ago5),
        "pe_bucket": bucket("pe_ltp", pe_strikes, ago5),
    }


def get_oi_change_series(instrument: str, date: str, baseline: str) -> list[dict[str, Any]]:
    return _floor_rows(_query(
        f"""
        SELECT
            s.timestamp,
            SUM(COALESCE(s.ce_oi, 0) - COALESCE(b.ce_oi, 0)) AS ce_oi_change,
            SUM(COALESCE(s.pe_oi, 0) - COALESCE(b.pe_oi, 0)) AS pe_oi_change,
            AVG(s.underlying_spot_price) AS underlying_spot_price
        FROM oi_snapshots s
        LEFT JOIN daily_baselines b
            ON b.date = ?
            AND b.baseline_type = ?
            AND b.instrument = s.instrument
            AND b.expiry = s.expiry
            AND b.strike = s.strike
        WHERE s.instrument = ? AND substr(s.timestamp, 1, 10) = ?
          AND s.timestamp IN ({MINUTE_FILTER_SQL})
        GROUP BY s.timestamp
        ORDER BY s.timestamp
        """,
        (date, baseline, instrument, date, instrument, date),
    ))


def get_snapshots(instrument: str, date: str, strike: float | None = None) -> list[dict[str, Any]]:
    if strike is None:
        return _query(
            """
            SELECT *
            FROM oi_snapshots
            WHERE instrument = ? AND substr(timestamp, 1, 10) = ?
            ORDER BY timestamp, strike
            """,
            (instrument, date),
        )
    return _query(
        """
        SELECT *
        FROM oi_snapshots
        WHERE instrument = ? AND substr(timestamp, 1, 10) = ? AND strike = ?
        ORDER BY timestamp, strike
        """,
        (instrument, date, strike),
    )


def get_history_summary(instrument: str | None = None) -> list[dict[str, Any]]:
    params: tuple[Any, ...]
    where = ""
    if instrument:
        where = "WHERE instrument = ?"
        params = (instrument,)
    else:
        params = ()
    return _query(
        f"""
        SELECT
            instrument,
            substr(timestamp, 1, 10) AS date,
            MIN(timestamp) AS first_timestamp,
            MAX(timestamp) AS last_timestamp,
            COUNT(*) AS snapshot_rows,
            COUNT(DISTINCT timestamp) AS ticks,
            COUNT(DISTINCT strike) AS strikes
        FROM oi_snapshots
        {where}
        GROUP BY instrument, substr(timestamp, 1, 10)
        ORDER BY date DESC, instrument
        """,
        params,
    )
