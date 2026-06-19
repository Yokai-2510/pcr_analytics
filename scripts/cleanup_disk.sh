#!/usr/bin/env bash
# Disk-retention cleanup for the PCR analytics EC2 box.
#
# Why: the box writes ~900MB/day of raw CSV logs + ~700MB/day of oi_snapshots
# rows and nothing pruned them, so the 15G volume filled up. A full disk makes
# every SQLite write throw "disk I/O error" -> the worker crash-loops and the
# API returns 500 ("Could not reach backend" / "Failed to fetch").
#
# This runs daily (pre-market, when the worker is idle) and bounds usage:
#   - Raw CSV logs: keep CSV_KEEP_DAYS days. Nothing reads them — the DB holds
#     the structured data and CSV export is generated client-side.
#   - oi_snapshots rows: keep DB_KEEP_DAYS days. Deleted per-instrument so the
#     (instrument, timestamp) index is used (ISO timestamps sort lexically).
#
# Install (on the box):
#   cp cleanup_disk.sh /home/ubuntu/index_pcr/ && chmod +x /home/ubuntu/index_pcr/cleanup_disk.sh
#   ( crontab -l 2>/dev/null; echo '0 22 * * * /home/ubuntu/index_pcr/cleanup_disk.sh >> /home/ubuntu/index_pcr/logs/cleanup.log 2>&1' ) | crontab -
#   # 22:00 UTC = 03:30 IST, before the 08:45 daily-prep / 09:15 market open.
set -uo pipefail

BASE="${PCR_BASE:-/home/ubuntu/index_pcr}"
DB="$BASE/data/oi_data.db"
CSV_KEEP_DAYS="${CSV_KEEP_DAYS:-1}"
DB_KEEP_DAYS="${DB_KEEP_DAYS:-4}"
ts() { date '+%F %T'; }

echo "[$(ts)] cleanup start (csv_keep=${CSV_KEEP_DAYS}d db_keep=${DB_KEEP_DAYS}d)"

# 1) Old raw CSV logs
n=$(find "$BASE/logs" -maxdepth 1 -name '20*_*.csv' -mtime +"$CSV_KEEP_DAYS" -print -delete 2>/dev/null | wc -l)
echo "[$(ts)] deleted $n CSV log file(s) older than ${CSV_KEEP_DAYS} days"

# 2) Prune old oi_snapshots rows (per-instrument -> index range delete)
CUTOFF="$(date -d "${DB_KEEP_DAYS} days ago" +%Y-%m-%d)"
before=$(sqlite3 "$DB" "SELECT COUNT(*) FROM oi_snapshots;" 2>/dev/null || echo '?')
for ins in nifty banknifty sensex; do
  sqlite3 "$DB" "PRAGMA busy_timeout=120000; DELETE FROM oi_snapshots WHERE instrument='${ins}' AND timestamp < '${CUTOFF}';" >/dev/null 2>&1 || true
done
after=$(sqlite3 "$DB" "SELECT COUNT(*) FROM oi_snapshots;" 2>/dev/null || echo '?')
echo "[$(ts)] oi_snapshots pruned (< ${CUTOFF}): ${before} -> ${after} rows"

# 3) VACUUM to reclaim the file slack (DELETE alone never shrinks the .db).
# Guarded: VACUUM builds a full copy, so only run when free space exceeds the
# current DB size — otherwise it would itself fill the disk. Skips silently when
# the disk is too tight (the usual case until CSV logging is reduced/disk grown).
db_bytes=$(stat -c %s "$DB" 2>/dev/null || echo 0)
avail_bytes=$(( $(df -k --output=avail / | tail -1) * 1024 ))
if [ "$avail_bytes" -gt "$(( db_bytes + 524288000 ))" ]; then
  sqlite3 "$DB" "PRAGMA busy_timeout=120000; VACUUM;" >/dev/null 2>&1 && \
    echo "[$(ts)] VACUUM ok ($(stat -c %s "$DB") bytes)" || echo "[$(ts)] VACUUM failed"
else
  echo "[$(ts)] VACUUM skipped (need >$(( (db_bytes+524288000)/1048576 ))M free, have $(( avail_bytes/1048576 ))M)"
fi

df -h / | awk -v t="$(ts)" 'NR==2{print "["t"] disk: "$5" used, "$4" free"}'
echo "[$(ts)] cleanup done"
