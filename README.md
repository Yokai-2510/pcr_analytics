# Index PCR Analytics

Real-time option-analytics and intraday trading for **NIFTY, BANKNIFTY, and
SENSEX**. A websocket engine streams live option-chain data into SQLite;
analytics engines derive PCR / OI / volume / VWAP / LTP-strength / option-flow
signals; a 1-second trade engine executes those signals as **paper or live**
orders; and a FastAPI + React stack serves the screens, charts, and dashboards.

## At a glance

- **Two processes** — a `worker` (market data + analytics + trade engine,
  runs each session until 15:30 IST) and an always-on `api` (FastAPI on :8000).
- **Websocket-first data** — one Upstox `MarketDataStreamerV3` connection feeds
  every subscribed leg across all three indices; REST is only a fallback.
- **Five signal sources** — `oi`, `volume`, `vwap`, `ltp`, and `optvol`
  (aggressor-classified option flow), each an independent strategy with its own
  strike selection, sizing, and exit rules.
- **Paper or live** — the trade engine speaks to a `Broker` protocol; `paper`
  simulates fills, `live` places real Upstox orders and blocks until each is
  fill-confirmed (cancels on timeout).

## Layout

```
backend/
  main.py            worker entry — one market session (data + analytics + trades)
  api.py             FastAPI read/write layer (:8000)
  ws_engine.py       websocket market-data engine (primary source)
  data_engine.py     60s compute layer → computed_ticks
  data_processor.py  raw CSV/SQLite writes, ATM filtering, query helpers
  market_data.py     fetch-cycle helpers (REST fallback)
  chart_engine.py    declarative chart catalog + saved charts
  dashboard_engine.py dashboard summary + flexible data browser
  broker_api.py      all Upstox API calls (market data + ORDER PLACEMENT)
  utilities.py       shared helpers + JSON-backed runtime config
  trade/             the trade subsystem — see docs/TRADE_ENGINE.md
  source/            credentials.json + runtime config
store.js  api.js  pages/  index.html  …   React frontend (repo root; Vercel)
docs/                this documentation
```

## Documentation

| doc | covers |
|-----|--------|
| [docs/STRATEGIES.md](docs/STRATEGIES.md) | **plain-English guide to all 5 strategies** — what each one watches, when it buys, when it exits |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | processes, data flow, DB tables, instruments |
| [docs/TRADE_ENGINE.md](docs/TRADE_ENGINE.md) | signals, entry gates, exit rules, **live order placement** |
| [docs/OPTION_VOLUME.md](docs/OPTION_VOLUME.md) | aggressor classification + ND/DV/DA/FR metrics |
| [docs/CONFIG.md](docs/CONFIG.md) | the trade config schema (global + per-strategy) |
| [docs/API.md](docs/API.md) | every HTTP endpoint |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | EC2 layout, services, deploy procedure |
| [backend/deploy_systemd_README.md](backend/deploy_systemd_README.md) | daily token-refresh timer |

## Going live

1. Confirm credentials are valid (Settings → Test Upstox).
2. In **Trade → Configs**, set the Global `mode` to **live** and turn on
   **auto-execute**; tune order type / product / fill timeout as needed.
3. Real orders then fire with full fill confirmation. Everything else —
   signals, gates, exits, sizing — is identical to paper mode.

The default is **paper**. See [docs/TRADE_ENGINE.md](docs/TRADE_ENGINE.md) for
exactly how live orders are placed and confirmed.
