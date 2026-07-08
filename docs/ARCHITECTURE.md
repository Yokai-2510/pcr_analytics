# Index PCR Analytics — Architecture

A live NIFTY / BANKNIFTY / SENSEX option-analytics and intraday trading system.
A websocket market-data engine feeds real-time option-chain data into a SQLite
store; analytics engines derive PCR / OI / volume / VWAP / LTP-strength /
option-flow signals; a 1-second trade engine turns those signals into paper or
live orders; and a FastAPI layer serves it all to a React frontend.

```
                         ┌──────────────────────────────────────────┐
   Upstox                │              worker process (main.py)      │
   MarketDataStreamerV3  │                                            │
        │  ticks         │   ws_engine ─► oi_snapshots (SQLite)       │
        └───────────────►│      │                │                    │
                         │      ▼                ▼                    │
                         │  option_flow      data_engine (60s)        │
                         │  (ND/DV/DA/FR)    ─► computed_ticks         │
                         │      │                │                    │
                         │      └──────┬─────────┘                    │
                         │             ▼                              │
                         │        trade/engine (1s loop)              │
                         │        signals ─► entries/exits            │
                         │             │                              │
                         │        trade/broker (Paper | Live)         │
                         │             │                              │
                         └─────────────┼──────────────────────────────┘
                                       ▼  (live mode only)
                                Upstox /v2/order/place  ──► real orders

   api process (uvicorn) ── FastAPI ── reads SQLite ──► React frontend (Vercel)
```

## Two processes

The backend runs as **two independent OS processes** managed by systemd, both
rooted at `/home/ubuntu/index_pcr/backend`:

| systemd unit            | entry           | role |
|-------------------------|-----------------|------|
| `index-pcr-worker`      | `main.py`       | Market-data collector + analytics + trade engine. **Runs from pre-open until 15:30 IST, then exits cleanly** (snapshots the daily report on the way out). Restarted daily by the prep timer. |
| `index-pcr-api`         | uvicorn `api:app` | Stateless FastAPI read/write layer. Always on. |
| `index-pcr-daily-prep.timer` | `upstox_auth` | 08:45 IST weekdays: Playwright login → fresh `access_token` → restart the worker. See `backend/deploy_systemd_README.md`. |

Only the **worker** writes to the database (the trade engine thread owns all
writes); the **api** only reads (plus config/credential writes that the worker
picks up on its next tick). This keeps SQLite single-writer and lock-free.

## The worker: what runs each session

`main.py` drives one market session (`run_market_session`):

1. **Pre-open prep** — refresh token, resolve nearest expiry per instrument,
   capture the previous-close baseline, take the post-settlement snapshot.
2. **Websocket engine** (`ws_engine.py`) — a single `MarketDataStreamerV3`
   connection streams index spots + every subscribed option leg (ATM ± band +
   safe strikes) for all three instruments. This is the **primary** market-data
   source; REST is only a fallback. Each tick updates an in-memory book and,
   once per minute, writes `oi_snapshots` + `option_volume_logs`.
3. **Compute thread** (`data_engine.py`) — every 60 s, aggregates raw snapshots
   into pre-computed `computed_ticks` (PCR, ΔOI, volume diff, VWAP, LTP strength).
4. **Option-flow** — aggressor-classified CE/PE buy/sell volume → Net Delta,
   Delta Velocity, Delta Acceleration, Flow Ratio (see [OPTION_VOLUME.md](OPTION_VOLUME.md)).
5. **Trade engine** (`trade/engine.py`) — a 1-second loop that evaluates exits
   then entries against the active config (see [TRADE_ENGINE.md](TRADE_ENGINE.md)).

## Data layers

| table                 | writer         | what |
|-----------------------|----------------|------|
| `oi_snapshots`        | ws_engine      | Per-strike raw archive (OI, volume, LTP, bid/ask, greeks). |
| `option_volume_logs`  | ws_engine      | 1-min aggressor-classified CE/PE buy/sell volume + ND/DV/DA/FR. |
| `computed_ticks`      | data_engine    | Pre-aggregated per-minute metrics (the analytics layer). |
| `daily_baselines`     | main           | Previous-close reference per instrument. |
| `chart_configs`       | api            | Saved custom charts. |
| `trade_configs`       | api/engine     | The single active trade configuration (JSON blob). |
| `orders`              | engine         | Every entry/exit order (paper or live) with fill price + status. |
| `positions`           | engine         | Open + closed positions, PnL, high-watermark. |
| `order_audit`         | engine         | Append-only event log (gate rejects, fills, errors). |
| `daily_trade_reports` | engine         | End-of-day per-date PnL snapshot. |

## Instruments

Three indices, configured in `utilities.py` (`instrument_config`): **nifty**
(step 50), **banknifty** (step 100), **sensex** (step 100). Each has its own
`instrument_key`, strike step, and ATM± subscription window.

## Related docs

- [TRADE_ENGINE.md](TRADE_ENGINE.md) — signals, entries, exits, and **live order placement**.
- [OPTION_VOLUME.md](OPTION_VOLUME.md) — aggressor classification and the flow metrics.
- [API.md](API.md) — every HTTP endpoint.
- [DEPLOYMENT.md](DEPLOYMENT.md) — EC2 layout, services, and the deploy procedure.
- [CONFIG.md](CONFIG.md) — the trade config schema.
