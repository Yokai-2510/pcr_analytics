# HTTP API

FastAPI app (`backend/api.py`) served by uvicorn on **:8000**. All routes are
under `/api`. Auth is an admin-token gate (`/api/auth/login` → token);
read routes are public behind it, writes are admin-only. `{instrument}` is
`nifty` | `banknifty` | `sensex`.

## Analytics (read)

| route | returns |
|-------|---------|
| `GET /api/pcr/{instrument}` | PCR series |
| `GET /api/oi-change/{instrument}` | ΔOI (per-strike / totals) |
| `GET /api/total-oi/{instrument}` | total CE/PE OI |
| `GET /api/total-volume/{instrument}` | total CE/PE volume |
| `GET /api/ltp-strength/{instrument}` · `.../ltp-strength-snapshot/{instrument}` | LTP-strength signal |
| `GET /api/option-volume/{instrument}?date=` | 1-min aggressor CE/PE buy/sell + ND/DV/DA/FR |
| `GET /api/option-chain/{instrument}` | current chain (websocket-fed) |
| `GET /api/sr-history/{instrument}` | support/resistance history |
| `GET /api/computed-ticks/{instrument}` | raw computed-tick rows |
| `GET /api/snapshots/{instrument}` · `GET /api/history[/{instrument}]` | snapshot archive |

## Charts

`GET /api/chart/metrics` · `/chart/presets` · `/chart/types` ·
`/chart/context/{instrument}` — the declarative chart catalog.
`POST /api/chart-data` — render a chart config to series.
`GET/POST /api/charts`, `GET /api/charts/{id}` — saved charts.

## Dashboard & data browser

`GET /api/dashboard/summary` — one-shot cards for all instruments.
`GET /api/data/columns` · `/data/distinct/{column}` · `POST /api/data/query` —
the flexible data browser. `GET /api/events/recent` — recent event feed.

## Trade (`/api/trade/*`, router in `trade/api.py`)

| route | purpose |
|-------|---------|
| `GET /api/trade/config` | current active config; `POST` (admin) to save |
| `GET /api/trade/positions` | open + closed positions |
| `GET /api/trade/orders` | order history (entries + exits, paper/live) |
| `GET /api/trade/summary` | today's counts + PnL |
| `GET /api/trade/reports` · `/reports/{date}` | per-date PnL reports |
| `GET /api/trade/audit` | the append-only `order_audit` event log |

## System / auth / credentials

`GET /api/status` — worker/collector/market state + next fetch time.
`GET /api/exchange-status/{exchange}` — live Upstox exchange status.
`GET /api/config` · `/config/schema` — runtime config + its schema.
`GET /api/credentials[/reveal]`, `POST /api/upstox/refresh-token`,
`POST /api/upstox/test`, `POST /api/credentials/admin/rotate` — credential mgmt.
`POST /api/admin/scheduler/install` — install the daily-prep systemd units.
`POST /api/auth/login` · `GET /api/auth/verify` — admin token.
`GET /api/preferences` — frontend prefs.
