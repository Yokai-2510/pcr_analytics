# Trade Engine

The trade subsystem (`backend/trade/`) turns analytics signals into orders. It
runs as a 1-second loop **inside the worker process** — the same process that
writes market data — so every write is single-threaded and lock-free.

```
trade/
  __init__.py     start/stop the engine thread; snapshot the daily report
  engine.py       the 1s loop: exits pass, then entries pass
  strikes.py      resolve a signal side → the exact option leg (strike, token, LTP)
  broker.py       Broker protocol + PaperBroker + LiveBroker
  persistence.py  trade_configs / orders / positions / order_audit tables
  api.py          /api/trade/* read routes + config writes
  reports.py      per-date PnL report snapshots
```

## The 1-second tick

Each tick (`run_tick`) does two passes against the single active config:

1. **Exits pass** — every open position is checked against the exit rules in
   priority order; first match closes it.
2. **Entries pass** — for each enabled instrument × signal source, the latest
   signal is checked against the entry gates; if it passes, a leg is opened.

Both passes share one `Broker` instance chosen from `config["mode"]`
(`paper` or `live`).

## Signals & sources

A position is opened from a **directional signal** produced by the analytics
layer. The active sources are chosen by `config["signal_mode"]`
(`_active_sources`):

| source   | signal comes from |
|----------|-------------------|
| `oi`     | OI-crossover (PCR / ΔOI direction flip) |
| `volume` | cumulative CE/PE volume-diff sign flip |
| `vwap`   | VWAP band signal |
| `ltp`    | LTP-strength signal |
| `optvol` | option-flow (Net Delta / Flow Ratio) — the Option Volume strategy |

`signal_mode` accepts single sources (`oi_only`), combinations
(`oi,volume,vwap`), and legacy aliases (`both`). Each open position remembers
**its own source**, and exits/re-entries are evaluated against that same source.

A `BUY` signal buys a **CE**; a `SELL` signal buys a **PE** (`_decide_side`).
The exact strike is resolved by `strikes.resolve` from `oi_snapshots` (no broker
call) using `strike_mode` (`atm` / `itm_1` / `itm_2` / `custom_steps`).

## Entry gates (all must pass)

Applied per instrument × source in `_evaluate_one_entry_source`:

1. **Signal freshness** — ignore signals older than ~90 s.
2. **Duplicate guard** — never re-enter on a signal already acted on.
3. **`no_entry_after`** — stop opening *new* positions this late (default 15:25);
   existing positions are still managed.
4. **Cooldown** — `cooldown_minutes` per instrument+source.
5. **Max positions/day** — `max_positions_per_day` cap across the session.
6. **Strike resolve** — the leg must exist in the current chain.

On pass, the engine sizes the order (`lot_size × lots`), calls
`broker.place_entry`, and on a successful fill records the order + open position
with SL/target frozen as absolute prices at the fill price.

## Exit rules (priority order — first match wins)

Evaluated each tick in `_evaluate_one_exit`:

| # | rule | condition |
|---|------|-----------|
| 0 | **Forced** (manual / EOD square-off) | checked first, before any data gate |
| 1 | **Peak trail** | in profit and premium retraces below `peak_trail_pct`% of its peak |
| 2 | **Time exit** | now ≥ `time_exit_at` |
| 3 | **Counter-crossover** | the opposite signal on the position's **own source** fires (SELL closes a CE, BUY closes a PE); the entries pass may re-open the new side the same tick |
| 4 | **Stop loss** | LTP ≤ frozen `sl_price` (`stop_loss_pct` below entry) |
| 5 | **Target** | LTP ≥ frozen `target_price` (`target_pct` above entry) |
| 6 | **Trailing SL** | ratchets the stop up as profit grows (state only, no exit this tick) |

## Order placement — Paper vs Live

The engine talks to a two-method `Broker` protocol and never knows which
implementation it's using. `broker.get_broker(mode, config)` dispatches:

### PaperBroker (`mode="paper"`, default)
Simulates an **atomic fill at the reference LTP** the engine read from the
latest snapshot. No external IO. This is the default and the safe mode.

### LiveBroker (`mode="live"`)
Places **real Upstox orders** and **blocks until each is fill-confirmed**, which
is what preserves the engine's synchronous "an `OrderResult` means it filled"
contract. Flow for both entry (BUY) and exit (SELL):

1. **Place** — `broker_api.place_order` → `POST /v2/order/place` with the
   configured product/order-type/validity; returns a broker `order_id`.
   A placement error (rejection, auth failure) surfaces the Upstox `errors[]`
   message verbatim and returns `success=False`.
2. **Poll to a terminal state** — `broker_api.get_order_details` every
   `fill_poll_interval_seconds` up to `fill_timeout_seconds`:
   - **complete** → return the **actual average fill price**.
   - **rejected / cancelled** → `success=False` with the reason. The engine
     records nothing (no phantom open position).
   - **timeout still open** → **cancel the order** (`cancel_order`) so it can't
     fill after the engine has given up, then return `success=False`.

Order parameters are config-driven (see below); a LIMIT order uses the signal
LTP as its price, a MARKET order sends price 0.

**Failure safety:** a failed or unconfirmed order can never become an open
position — `open_position_atomic` only runs after a successful, price-bearing
fill. Every outcome (fill, reject, timeout, error) is written to `order_audit`.

### Live order config (in the trade config)

| key                          | default   | meaning |
|------------------------------|-----------|---------|
| `mode`                       | `paper`   | `paper` or `live` |
| `order_type`                 | `MARKET`  | `MARKET` or `LIMIT` (LIMIT prices at the signal LTP) |
| `order_product`              | `I`       | `I` intraday / `D` delivery |
| `order_validity`             | `DAY`     | `DAY` or `IOC` |
| `fill_timeout_seconds`       | `8`       | cancel an order that hasn't filled by then |
| `fill_poll_interval_seconds` | `0.3`     | how often to poll order status |

> **Going live:** set `mode: "live"` (and `auto_execute: true`) in the Configs
> tab. Real orders then fire with full fill confirmation. Everything else —
> signals, gates, exits, sizing — is identical to paper.

## Broker API surface (`broker_api.py`)

- `place_order(instrument_token, quantity, transaction_type, order_type, product, price, validity, tag)` → `order_id`
- `get_order_details(order_id)` → `{status, average_price, filled_quantity, …}`
- `cancel_order(order_id)` — best-effort DELETE of an open order
- (existing) `get_option_chain`, `get_option_contracts`, `resolve_expiry`,
  `get_user_profile`, `get_exchange_status`

All calls carry the cached Upstox bearer token and retry once on a 401 after
invalidating the token.
