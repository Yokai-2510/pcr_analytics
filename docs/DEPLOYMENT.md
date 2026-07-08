# Deployment

## Hosts

| piece    | where |
|----------|-------|
| Backend  | EC2 `65.0.104.1`, path `~/index_pcr/backend`, venv `~/index_pcr/.venv` |
| Frontend | Vercel — `pcranalytics.vercel.app`, auto-deploys from `main` |
| Domain   | API reachable via `pcr-analytics.duckdns.org` → `65.0.104.1` |

**The backend on the EC2 is not a git checkout** — it's deployed by copying
files. The GitHub repo (`Yokai-2510/pcr_analytics`) is the source of record and
what Vercel builds the frontend from.

## systemd services (EC2)

| unit | command | lifecycle |
|------|---------|-----------|
| `index-pcr-api`  | `.venv/bin/python api.py` (uvicorn on :8000) | always on |
| `index-pcr-worker` | `.venv/bin/python main.py` | **runs pre-open → 15:30 IST, then exits** (snapshots the daily report); restarted daily |
| `index-pcr-daily-prep.timer` | Playwright token refresh + worker restart | 08:45 IST, Mon–Fri (see `backend/deploy_systemd_README.md`) |

> The worker being **inactive after 15:30 IST is correct** — it's a
> run-until-close process, not a daemon. The daily-prep timer starts it fresh
> before the next open. Don't "fix" it by making it restart-always.

```bash
# health / state
systemctl is-active index-pcr-api index-pcr-worker
curl -s localhost:8000/api/status          # market_state, next_fetch, running flags
journalctl -u index-pcr-worker -f          # live worker log
```

## Deploy procedure (backend)

Since the EC2 backend is scp-deployed, not git-pulled:

```bash
KEY=~/.ssh/pcra_backend.pem
# 1. back up the files you're about to replace
ssh -i $KEY ubuntu@65.0.104.1 'cd ~/index_pcr/backend && cp <files> ~/deploy_backup/'
# 2. copy the changed files
scp -i $KEY backend/<file>.py ubuntu@65.0.104.1:~/index_pcr/backend/<file>.py
# 3. compile-check with the venv, then restart
ssh -i $KEY ubuntu@65.0.104.1 'cd ~/index_pcr && .venv/bin/python -m py_compile backend/<file>.py'
ssh -i $KEY ubuntu@65.0.104.1 'sudo systemctl restart index-pcr-api'   # + worker if in-session
# 4. commit the same change to git so the repo stays in sync with the EC2
git commit -am "..."; git push origin main
```

Line endings on the EC2 are CRLF; a byte-diff against a fresh git checkout looks
huge but is usually just `\r`. Compare with `tr -d '\r'` before assuming drift.

## Frontend

The frontend is a static React app whose files live at the **repo root**
(`store.js`, `api.js`, `pages/`, `index.html`, …), not in a `frontend/` subdir.
Push to `main` → Vercel builds automatically. The API base is set in `store.js`
(`apiBase`, default `https://pcr-analytics.duckdns.org` → `65.0.104.1`; also
overridable via `localStorage.apiBase`).

## Credentials

`backend/source/credentials.json` holds `api_key`, `api_secret`, `redirect_uri`,
`mobile_no`, `pin`, `totp_key`, and the daily-minted `access_token`. The
daily-prep timer refreshes the token via Playwright + pyotp; nothing else needs
touching day to day.
