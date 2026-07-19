"""Persistence for the trade subsystem.

Owns four tables — ``trade_configs``, ``orders``, ``positions``,
``order_audit`` — plus the read/write helpers the engine and API use.

All writes happen inside the worker process (engine thread); the API
process is read-only against these tables. Schema is initialised
idempotently and is safe to run on every worker start.
"""

from __future__ import annotations

import json
from contextlib import closing
import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Iterable

import data_processor
import utilities as utils

logger = logging.getLogger(__name__)


# ── Schema ─────────────────────────────────────────────────────────────


_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS trade_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        json_blob TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_trade_configs_active ON trade_configs(active)",
    """
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_order_ref TEXT NOT NULL UNIQUE,
        broker_order_id TEXT,
        instrument TEXT NOT NULL,
        instrument_token TEXT NOT NULL,
        strike REAL NOT NULL,
        option_type TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        qty INTEGER NOT NULL,
        lots INTEGER NOT NULL,
        price REAL NOT NULL,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        parent_position_id INTEGER,
        mode TEXT NOT NULL,
        signal_timestamp TEXT,
        placed_at TEXT NOT NULL,
        error TEXT,
        source TEXT NOT NULL DEFAULT 'oi',
        UNIQUE(instrument, source, signal_timestamp, intent)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at)",
    "CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders(intent)",
    """
    CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument TEXT NOT NULL,
        instrument_token TEXT NOT NULL,
        strike REAL NOT NULL,
        option_type TEXT NOT NULL,
        qty INTEGER NOT NULL,
        lots INTEGER NOT NULL,
        entry_order_id INTEGER NOT NULL,
        exit_order_id INTEGER,
        entry_price REAL NOT NULL,
        exit_price REAL,
        entry_time TEXT NOT NULL,
        exit_time TEXT,
        status TEXT NOT NULL,
        high_watermark REAL,
        peak_profit REAL,
        peak_profit_at TEXT,
        breakeven_armed INTEGER NOT NULL DEFAULT 0,
        sl_price REAL,
        target_price REAL,
        exit_reason TEXT,
        mode TEXT NOT NULL,
        signal_timestamp TEXT,
        pnl REAL,
        ctx_oi_difference REAL,
        ctx_pcr REAL,
        ctx_ce_cumm REAL,
        ctx_pe_cumm REAL,
        ctx_margin REAL,
        manual_exit_requested INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'oi'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, instrument)",
    "CREATE INDEX IF NOT EXISTS idx_positions_entry_time ON positions(entry_time)",
    """
    CREATE TABLE IF NOT EXISTS order_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        instrument TEXT,
        client_order_ref TEXT,
        position_id INTEGER,
        gate TEXT,
        message TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_order_audit_ts ON order_audit(ts)",
    """
    CREATE TABLE IF NOT EXISTS daily_trade_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        generated_at TEXT NOT NULL,
        json_blob TEXT NOT NULL
    )
    """,
]


def init_schema(conn: sqlite3.Connection) -> None:
    """Create trade tables if they don't exist, then migrate. Idempotent."""
    for stmt in _SCHEMA:
        conn.execute(stmt)
    _migrate_source_columns(conn)
    conn.commit()
    logger.info("trade.persistence: schema initialised")


def _migrate_source_columns(conn: sqlite3.Connection) -> None:
    """Add the `source` tag ('oi'|'volume') to positions/orders on pre-existing
    DBs and rebuild the orders UNIQUE to be source-aware, so OI and volume
    strategies can each hold their own position per instrument. Idempotent."""
    # PRAGMA table_info columns: (cid, name, type, notnull, dflt_value, pk);
    # index by position so this works regardless of the connection row_factory.
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(positions)").fetchall()}
    if "source" not in pcols:
        conn.execute("ALTER TABLE positions ADD COLUMN source TEXT NOT NULL DEFAULT 'oi'")
    for _ddl in (
        "ALTER TABLE positions ADD COLUMN peak_profit REAL",
        "ALTER TABLE positions ADD COLUMN peak_profit_at TEXT",
        "ALTER TABLE positions ADD COLUMN breakeven_armed INTEGER NOT NULL DEFAULT 0",
    ):
        try:
            conn.execute(_ddl)
        except Exception:
            pass   # column already present

    ocols = {r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()}
    if "source" not in ocols:
        # orders carries an inline UNIQUE(instrument, signal_timestamp, intent)
        # that must become source-aware — SQLite needs a table rebuild for that.
        conn.execute("ALTER TABLE orders RENAME TO _orders_old")
        for stmt in _SCHEMA:
            if "CREATE TABLE IF NOT EXISTS orders" in stmt:
                conn.execute(stmt)
                break
        conn.execute(
            """
            INSERT INTO orders (
                id, client_order_ref, broker_order_id, instrument, instrument_token,
                strike, option_type, transaction_type, qty, lots, price, status,
                intent, parent_position_id, mode, signal_timestamp, placed_at, error, source
            )
            SELECT
                id, client_order_ref, broker_order_id, instrument, instrument_token,
                strike, option_type, transaction_type, qty, lots, price, status,
                intent, parent_position_id, mode, signal_timestamp, placed_at, error, 'oi'
            FROM _orders_old
            """
        )
        conn.execute("DROP TABLE _orders_old")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders(intent)")
        logger.info("trade.persistence: migrated orders to source-aware UNIQUE")


# ── Config ─────────────────────────────────────────────────────────────


# The concrete per-strategy configuration every source starts with —
# exactly the values the system was running before segregation.
_DEFAULT_SOURCE_BLOCK: dict[str, Any] = {
    "strike_mode": "atm",
    "custom_steps": 0,
    "lots": 1,
    "cooldown_minutes": 0,
    "no_entry_after": "15:25",
    "exit_on_counter_crossover": True,
    "stop_loss_enabled": True,
    "stop_loss_pct": 30,
    "trailing_sl_enabled": False,
    "trailing_sl_trigger_pct": 20,
    "trailing_sl_step_pct": 10,
    "target_enabled": True,
    "target_pct": 50,
    "peak_trail_enabled": False,
    "peak_trail_pct": 80,
    # Dynamic TSL trails the PEAK PROFIT, not the peak price: exit when
    # current profit <= peak_profit * (1 - dynamic_tsl_drawdown_pct/100).
    # Unlike peak_trail (price-based) this retains a defined FRACTION OF THE
    # PROFIT regardless of entry price - e.g. entry 100, peak 200, 20%:
    # price-trail exits at 160 (keeps 60% of the gain), profit-trail exits at
    # 180 (keeps 80%). Ships disabled so behaviour only changes when asked.
    "dynamic_tsl_enabled": False,
    "dynamic_tsl_drawdown_pct": 20,
    # Once profit reaches this %, the stop is raised to entry (risk removed).
    # 0 disables.
    "breakeven_trigger_pct": 0,
    "time_exit_enabled": True,
    "time_exit_at": "15:15",
    # Option-Volume conviction gate (optvol source only; 0 = off). The websocket
    # engine still emits every Net-Delta flip to the Entry Signals monitor —
    # these only decide which flips become TRADES, so signals > trades.
    "optvol_min_net_delta": 0,        # min |Net Delta| (contracts) to trade
    "optvol_min_net_delta_ratio": 0,  # min |ND| as a fraction of the larger CE/PE delta (0–1)
}

DEFAULT_CONFIG: dict[str, Any] = {
    "mode": "paper",
    "auto_execute": False,
    # Live order placement (used only when mode == "live").
    "order_type": "MARKET",          # MARKET | LIMIT (LIMIT uses the signal LTP)
    "order_product": "I",            # I=intraday, D=delivery
    "order_validity": "DAY",         # DAY | IOC
    "fill_timeout_seconds": 8,       # cancel an order that hasn't filled by then
    "fill_poll_interval_seconds": 0.3,
    "signal_mode": "oi_only",   # "oi_only" | "volume_only" | "vwap_only" | "both" (independent)
    "cooldown_minutes": 0,
    "instruments": ["nifty"],
    "strike_mode": "atm",
    "custom_steps": 0,
    "lots": 1,
    "exit_on_counter_crossover": True,
    "stop_loss_enabled": True,
    "stop_loss_pct": 30,
    "trailing_sl_enabled": False,
    "trailing_sl_trigger_pct": 20,
    "trailing_sl_step_pct": 10,
    "target_enabled": True,
    "target_pct": 50,
    "peak_trail_enabled": False,
    "peak_trail_pct": 80,   # once in profit, exit if premium falls below this % of its peak
    # Dynamic TSL trails the PEAK PROFIT, not the peak price: exit when
    # current profit <= peak_profit * (1 - dynamic_tsl_drawdown_pct/100).
    # Unlike peak_trail (price-based) this retains a defined FRACTION OF THE
    # PROFIT regardless of entry price - e.g. entry 100, peak 200, 20%:
    # price-trail exits at 160 (keeps 60% of the gain), profit-trail exits at
    # 180 (keeps 80%). Ships disabled so behaviour only changes when asked.
    "dynamic_tsl_enabled": False,
    "dynamic_tsl_drawdown_pct": 20,
    # Once profit reaches this %, the stop is raised to entry (risk removed).
    # 0 disables.
    "breakeven_trigger_pct": 0,
    "time_exit_enabled": True,
    "time_exit_at": "15:15",
    "no_entry_after": "15:25",   # stop opening NEW positions this late (intraday
                                 # churn guard); existing positions still managed
    "max_positions_per_day": 3,
    # Each strategy owns its FULL configuration — there is no universal
    # per-strategy system. The blocks below are seeded with the values the
    # system ran with before segregation; the legacy top-level keys above
    # remain only as a fallback for configs saved before this change.
    "strategies": {
        src: dict(_DEFAULT_SOURCE_BLOCK) for src in ("oi", "volume", "vwap", "ltp", "optvol")
    },
}

PER_SOURCE_KEYS = (
    "cooldown_minutes", "strike_mode", "custom_steps", "lots",
    "exit_on_counter_crossover", "stop_loss_enabled", "stop_loss_pct",
    "trailing_sl_enabled", "trailing_sl_trigger_pct", "trailing_sl_step_pct",
    "target_enabled", "target_pct", "peak_trail_enabled", "peak_trail_pct",
    "dynamic_tsl_enabled", "dynamic_tsl_drawdown_pct", "breakeven_trigger_pct",
    "time_exit_enabled", "time_exit_at", "no_entry_after",
)


def source_cfg(config: dict[str, Any], source: str) -> dict[str, Any]:
    """Effective config for ONE strategy: legacy top-level values overridden
    by that strategy's own `strategies.{source}` block."""
    merged = dict(config)
    override = (config.get("strategies") or {}).get(source) or {}
    for key, value in override.items():
        if value is not None and value != "":
            merged[key] = value
    return merged


def get_active_config() -> dict[str, Any]:
    """Return the currently active config merged onto defaults. Always returns
    a usable dict even if no config has been saved yet."""
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            "SELECT json_blob FROM trade_configs WHERE active = 1 LIMIT 1"
        ).fetchone()
    if not row:
        return dict(DEFAULT_CONFIG)
    try:
        saved = json.loads(row["json_blob"])
        if not isinstance(saved, dict):
            saved = {}
    except (ValueError, TypeError):
        saved = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update(saved)
    # Every strategy block is fully populated: defaults <- saved overrides,
    # so each strategy is complete and concrete on its own.
    strategies = {k: dict(_DEFAULT_SOURCE_BLOCK) for k in DEFAULT_CONFIG["strategies"]}
    for src, blk in (saved.get("strategies") or {}).items():
        if isinstance(blk, dict):
            strategies.setdefault(src, dict(_DEFAULT_SOURCE_BLOCK)).update(blk)
    merged["strategies"] = strategies
    return merged


def save_config(new_blob: dict[str, Any]) -> dict[str, Any]:
    """Insert a new config row and mark it active, deactivating any previous
    row. Returns the persisted (defaults-merged) config."""
    merged = dict(DEFAULT_CONFIG)
    merged.update(new_blob or {})
    payload = json.dumps(merged, sort_keys=True)
    now = utils.iso_now()
    with closing(data_processor.connect()) as conn:
        conn.execute("UPDATE trade_configs SET active = 0 WHERE active = 1")
        conn.execute(
            "INSERT INTO trade_configs (created_at, json_blob, active) VALUES (?, ?, 1)",
            (now, payload),
        )
        conn.commit()
    logger.info("trade.persistence: config saved")
    return merged


# ── Orders ─────────────────────────────────────────────────────────────


def insert_order(conn: sqlite3.Connection, fields: dict[str, Any]) -> int:
    """Insert an orders row. Returns the new row id. Caller must hold the
    transaction. UNIQUE(instrument, signal_timestamp, intent) and
    UNIQUE(client_order_ref) raise sqlite3.IntegrityError on duplicate —
    callers must handle this."""
    columns = [
        "client_order_ref", "broker_order_id",
        "instrument", "instrument_token", "strike", "option_type",
        "transaction_type", "qty", "lots", "price",
        "status", "intent", "parent_position_id", "mode",
        "signal_timestamp", "placed_at", "error", "source",
    ]
    values = tuple(fields.get(c, "oi" if c == "source" else None) for c in columns)
    placeholders = ", ".join("?" for _ in columns)
    col_sql = ", ".join(columns)
    cur = conn.execute(
        f"INSERT INTO orders ({col_sql}) VALUES ({placeholders})",
        values,
    )
    return int(cur.lastrowid)


def orders_for_date(date: str) -> list[dict[str, Any]]:
    with closing(data_processor.connect()) as conn:
        rows = conn.execute(
            """
            SELECT * FROM orders
            WHERE substr(placed_at, 1, 10) = ?
            ORDER BY placed_at DESC
            """,
            (date,),
        ).fetchall()
    return [dict(r) for r in rows]


def last_entry_time_for_instrument(instrument: str, date: str) -> str | None:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT MAX(placed_at) AS ts FROM orders
            WHERE instrument = ? AND intent = 'entry'
              AND substr(placed_at, 1, 10) = ?
            """,
            (instrument, date),
        ).fetchone()
    return row["ts"] if row and row["ts"] else None


def count_entries_today(date: str) -> int:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM orders
            WHERE intent = 'entry' AND substr(placed_at, 1, 10) = ?
            """,
            (date,),
        ).fetchone()
    return int(row["n"] or 0)


# ── Positions ──────────────────────────────────────────────────────────


def insert_position(conn: sqlite3.Connection, fields: dict[str, Any]) -> int:
    columns = [
        "instrument", "instrument_token", "strike", "option_type",
        "qty", "lots", "entry_order_id", "entry_price", "entry_time",
        # peak_profit / peak_profit_at / breakeven_armed are deliberately NOT
        # inserted here: they are nullable-or-defaulted in the DDL and written
        # by the engine as the trade runs. Listing them would pass an explicit
        # None for breakeven_armed, which is NOT NULL DEFAULT 0 — that would
        # fail every insert. Reads use SELECT *, so they surface regardless.
        "status", "high_watermark", "sl_price", "target_price",
        "mode", "signal_timestamp", "source",
        "ctx_oi_difference", "ctx_pcr", "ctx_ce_cumm", "ctx_pe_cumm", "ctx_margin",
    ]
    values = tuple(fields.get(c, "oi" if c == "source" else None) for c in columns)
    placeholders = ", ".join("?" for _ in columns)
    col_sql = ", ".join(columns)
    cur = conn.execute(
        f"INSERT INTO positions ({col_sql}) VALUES ({placeholders})",
        values,
    )
    return int(cur.lastrowid)


def open_positions() -> list[dict[str, Any]]:
    with closing(data_processor.connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM positions WHERE status = 'open' ORDER BY entry_time"
        ).fetchall()
    return [dict(r) for r in rows]


def has_open_for_instrument(instrument: str) -> bool:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT 1 FROM positions
            WHERE instrument = ? AND status IN ('open', 'exiting')
            LIMIT 1
            """,
            (instrument,),
        ).fetchone()
    return row is not None


def has_open_for_instrument_source(instrument: str, source: str) -> bool:
    """True if there's an open position for (instrument, source). The OI and
    volume strategies each hold at most one leg per instrument, independently."""
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT 1 FROM positions
            WHERE instrument = ? AND source = ? AND status IN ('open', 'exiting')
            LIMIT 1
            """,
            (instrument, source),
        ).fetchone()
    return row is not None


def last_entry_time_for_instrument_source(instrument: str, source: str, date: str) -> str | None:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT MAX(placed_at) AS ts FROM orders
            WHERE instrument = ? AND source = ? AND intent = 'entry'
              AND substr(placed_at, 1, 10) = ?
            """,
            (instrument, source, date),
        ).fetchone()
    return row["ts"] if row and row["ts"] else None


def last_entry_side_for_instrument_source(instrument: str, source: str, date: str) -> str | None:
    """option_type ('CE'/'PE') of the most recent ENTRY order for
    (instrument, source) today, or None if no entry has been taken yet.

    The LTP engine uses this to define the current *directional regime* it last
    traded (CE => BUY regime, PE => SELL regime). A new position is only opened
    when the live signal flips to the OPPOSITE regime (a genuine crossover), so
    the same side is never re-entered between crossovers — including after an
    early stop-loss exit, where we wait for the next crossover before re-entering."""
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            """
            SELECT option_type FROM orders
            WHERE instrument = ? AND source = ? AND intent = 'entry'
              AND substr(placed_at, 1, 10) = ?
            ORDER BY placed_at DESC
            LIMIT 1
            """,
            (instrument, source, date),
        ).fetchone()
    return row["option_type"] if row and row["option_type"] else None


def positions_for_date(date: str, status: str | None = None) -> list[dict[str, Any]]:
    where = ["substr(entry_time, 1, 10) = ?"]
    params: list[Any] = [date]
    if status:
        where.append("status = ?")
        params.append(status)
    with closing(data_processor.connect()) as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM positions
            WHERE {' AND '.join(where)}
            ORDER BY entry_time DESC
            """,
            tuple(params),
        ).fetchall()
    return [dict(r) for r in rows]


def update_position_tsl(position_id: int, high_watermark: float, sl_price: float) -> None:
    with closing(data_processor.connect()) as conn:
        conn.execute(
            """
            UPDATE positions
            SET high_watermark = ?, sl_price = ?
            WHERE id = ? AND status = 'open'
            """,
            (high_watermark, sl_price, position_id),
        )
        conn.commit()


def update_position_high_watermark(position_id: int, high_watermark: float) -> None:
    """Track the peak LTP since entry (= highest profit reached), independent of
    the trailing-SL config."""
    with closing(data_processor.connect()) as conn:
        conn.execute(
            "UPDATE positions SET high_watermark = ? WHERE id = ? AND status = 'open'",
            (high_watermark, position_id),
        )
        conn.commit()


def update_position_peak(position_id: int, high_watermark: float,
                         peak_profit: float, peak_profit_at: str) -> None:
    """Record a new peak: peak LTP, the rupee profit at that peak, and WHEN it
    happened. The timestamp is what makes the peak reviewable after the fact -
    without it you can see how much you gave back but not when it turned."""
    with closing(data_processor.connect()) as conn:
        conn.execute(
            "UPDATE positions SET high_watermark = ?, peak_profit = ?, "
            "peak_profit_at = ? WHERE id = ? AND status = 'open'",
            (high_watermark, peak_profit, peak_profit_at, position_id),
        )
        conn.commit()


def arm_breakeven(position_id: int, sl_price: float) -> None:
    """Raise the stop to break-even and latch it so it never re-arms."""
    with closing(data_processor.connect()) as conn:
        conn.execute(
            "UPDATE positions SET sl_price = ?, breakeven_armed = 1 "
            "WHERE id = ? AND status = 'open'",
            (sl_price, position_id),
        )
        conn.commit()


def request_manual_exit(position_id: int) -> bool:
    """Flag a position for manual exit on the engine's next tick.
    Returns True if a still-open position was flagged."""
    with closing(data_processor.connect()) as conn:
        cur = conn.execute(
            """
            UPDATE positions
            SET manual_exit_requested = 1
            WHERE id = ? AND status = 'open' AND manual_exit_requested = 0
            """,
            (position_id,),
        )
        conn.commit()
    return cur.rowcount > 0


# ── Atomic open / close transactions ───────────────────────────────────


def open_position_atomic(
    *,
    order_fields: dict[str, Any],
    position_fields: dict[str, Any],
) -> tuple[int, int] | None:
    """Insert the entry order and matching position in one transaction.

    Returns ``(order_id, position_id)`` on success. Returns ``None`` when
    the UNIQUE(instrument, signal_timestamp, intent) constraint blocks the
    duplicate — the engine logs and moves on.
    """
    client_ref = order_fields.setdefault("client_order_ref", uuid.uuid4().hex)
    with closing(data_processor.connect()) as conn:
        try:
            conn.execute("BEGIN")
            order_id = insert_order(conn, order_fields)
            position_fields["entry_order_id"] = order_id
            position_id = insert_position(conn, position_fields)
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            logger.warning(
                "open_position blocked by integrity constraint (likely duplicate signal): %s",
                exc,
            )
            return None
    logger.info(
        "Position opened: id=%s instrument=%s side=%s strike=%s entry_price=%s qty=%s ref=%s",
        position_id,
        position_fields.get("instrument"),
        position_fields.get("option_type"),
        position_fields.get("strike"),
        position_fields.get("entry_price"),
        position_fields.get("qty"),
        client_ref,
    )
    return order_id, position_id


def close_position_atomic(
    *,
    position_id: int,
    exit_order_fields: dict[str, Any],
    exit_price: float,
    exit_reason: str,
    entry_price: float,
    qty: int,
) -> int | None:
    """Mark the position exiting, insert the exit order, mark closed with pnl.

    Returns the exit order id on success, ``None`` if the position was
    already closed (race) or the order insert failed.
    """
    exit_order_fields.setdefault("client_order_ref", uuid.uuid4().hex)
    pnl = (exit_price - entry_price) * qty
    now = utils.iso_now()
    with closing(data_processor.connect()) as conn:
        try:
            conn.execute("BEGIN")
            cur = conn.execute(
                """
                UPDATE positions
                SET status = 'exiting'
                WHERE id = ? AND status = 'open'
                """,
                (position_id,),
            )
            if cur.rowcount == 0:
                conn.rollback()
                logger.info(
                    "close_position: position id=%s already not-open, skipping",
                    position_id,
                )
                return None
            exit_order_id = insert_order(conn, exit_order_fields)
            conn.execute(
                """
                UPDATE positions
                SET status = 'closed',
                    exit_order_id = ?,
                    exit_price = ?,
                    exit_time = ?,
                    exit_reason = ?,
                    pnl = ?,
                    manual_exit_requested = 0
                WHERE id = ?
                """,
                (exit_order_id, exit_price, now, exit_reason, pnl, position_id),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            logger.warning("close_position integrity error: %s", exc)
            return None
    logger.info(
        "Position closed: id=%s reason=%s exit_price=%s pnl=%.2f",
        position_id, exit_reason, exit_price, pnl,
    )
    return exit_order_id


# ── Audit log ──────────────────────────────────────────────────────────


def audit(
    kind: str,
    *,
    instrument: str | None = None,
    client_order_ref: str | None = None,
    position_id: int | None = None,
    gate: str | None = None,
    message: str | None = None,
) -> None:
    """Append an audit row. Never raises — audit failures must not break
    the engine."""
    try:
        with closing(data_processor.connect()) as conn:
            conn.execute(
                """
                INSERT INTO order_audit
                    (ts, kind, instrument, client_order_ref, position_id, gate, message)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (utils.iso_now(), kind, instrument, client_order_ref, position_id, gate, message),
            )
            conn.commit()
    except Exception:
        logger.exception("audit log write failed")


def recent_audit(limit: int = 200) -> list[dict[str, Any]]:
    with closing(data_processor.connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM order_audit ORDER BY ts DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Daily trade reports ────────────────────────────────────────────────


def save_daily_report(date: str, report: dict[str, Any]) -> None:
    payload = json.dumps(report, default=str, sort_keys=True)
    with closing(data_processor.connect()) as conn:
        conn.execute(
            """
            INSERT INTO daily_trade_reports (date, generated_at, json_blob)
            VALUES (?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                generated_at = excluded.generated_at,
                json_blob = excluded.json_blob
            """,
            (date, utils.iso_now(), payload),
        )
        conn.commit()


def get_daily_report(date: str) -> dict[str, Any] | None:
    with closing(data_processor.connect()) as conn:
        row = conn.execute(
            "SELECT date, generated_at, json_blob FROM daily_trade_reports WHERE date = ?",
            (date,),
        ).fetchone()
    if not row:
        return None
    try:
        body = json.loads(row["json_blob"])
    except (ValueError, TypeError):
        body = {}
    body["date"] = row["date"]
    body["generated_at"] = row["generated_at"]
    return body


def list_report_dates() -> list[str]:
    """Every date for which we have either a snapshotted report OR positions."""
    with closing(data_processor.connect()) as conn:
        a = conn.execute("SELECT date FROM daily_trade_reports").fetchall()
        b = conn.execute(
            "SELECT DISTINCT substr(entry_time, 1, 10) AS d FROM positions"
        ).fetchall()
    dates = {r["date"] for r in a} | {r["d"] for r in b if r["d"]}
    return sorted(dates, reverse=True)
