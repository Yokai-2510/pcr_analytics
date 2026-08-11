"""Tests for the tiered trail resolver, and the ladder measured on real trades.

Two failure modes matter most: a malformed config entry must not stop an exit
from being evaluated, and a disabled or empty ladder must leave the flat
parameter untouched.
"""
import sqlite3
import sys

sys.path.insert(0, "/home/ubuntu/index_pcr/backend")
from trade.engine import _tier_value          # noqa: E402

fails = []


def check(name, cond, detail=""):
    print("%-4s %s%s" % ("ok" if cond else "FAIL", name,
                         ("  -- " + detail) if (detail and not cond) else ""))
    if not cond:
        fails.append(name)


L = [{"min_peak_profit": 6000, "drawdown_pct": 25},
     {"min_peak_profit": 3000, "drawdown_pct": 20},
     {"min_peak_profit": 1000, "drawdown_pct": 15},
     {"min_peak_profit": 0, "drawdown_pct": 12}]

check("below all tiers -> lowest", _tier_value(L, 500, "drawdown_pct", 99) == 12)
check("exactly on a boundary", _tier_value(L, 1000, "drawdown_pct", 99) == 15)
check("between tiers", _tier_value(L, 2999, "drawdown_pct", 99) == 15)
check("top tier", _tier_value(L, 50000, "drawdown_pct", 99) == 25)
check("negative peak -> fallback-free lowest",
      _tier_value(L, -500, "drawdown_pct", 99) == 99,
      "got %s" % _tier_value(L, -500, "drawdown_pct", 99))

check("empty list -> flat", _tier_value([], 5000, "drawdown_pct", 20) == 20)
check("None -> flat", _tier_value(None, 5000, "drawdown_pct", 20) == 20)
check("not a list -> flat", _tier_value(42, 5000, "drawdown_pct", 20) == 20)
check("wrong key -> flat", _tier_value(L, 5000, "trail_pct", 80) == 80)

MESSY = [{"min_peak_profit": "3000", "drawdown_pct": "20"},   # strings coerce
         {"min_peak_profit": None, "drawdown_pct": 5},
         "not a dict",
         {"drawdown_pct": 30},                                 # no threshold -> 0
         {"min_peak_profit": 9999}]                            # no value
check("string numbers coerce", _tier_value(MESSY, 4000, "drawdown_pct", 99) == 20)
# Two MESSY entries resolve to threshold 0: None coerces to 0, and the entry
# with no threshold defaults to 0. On a tie the first listed wins -- arbitrary
# but deterministic. The requirement is only that junk never raises and never
# stops the exit being evaluated.
check("junk entries skipped, still resolves",
      _tier_value(MESSY, 100, "drawdown_pct", 99) == 5,
      "got %s" % _tier_value(MESSY, 100, "drawdown_pct", 99))
check("tier missing its value falls through",
      _tier_value(MESSY, 100000, "drawdown_pct", 99) == 20,
      "got %s" % _tier_value(MESSY, 100000, "drawdown_pct", 99))

check("unsorted ladder still picks the highest match",
      _tier_value(list(reversed(L)), 4000, "drawdown_pct", 99) == 20)

print()

# ---- measure the shipped ladder against the real trade record -------------
DB = "/home/ubuntu/index_pcr/data/oi_data.db"
try:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT peak_profit, pnl FROM positions "
        "WHERE status='closed' AND source='oi' AND peak_profit IS NOT NULL"
    ).fetchall()
except Exception as exc:
    print("could not read the trade DB: %s" % exc)
    rows = []

if rows:
    def banked(dd_for):
        tot = 0.0
        for r in rows:
            pk, pn = r["peak_profit"] or 0, r["pnl"] or 0
            if pk <= 0:
                tot += pn
                continue
            dd = dd_for(pk)
            floor = pk * (1 - dd / 100.0)
            tot += max(pn, floor) if pn < floor else pn
        return tot

    actual = sum((r["pnl"] or 0) for r in rows)
    SHIPPED = [{"min_peak_profit": 6000, "drawdown_pct": 25},
               {"min_peak_profit": 3000, "drawdown_pct": 20},
               {"min_peak_profit": 1000, "drawdown_pct": 15},
               {"min_peak_profit": 0, "drawdown_pct": 12}]
    BACKWARDS = [{"min_peak_profit": 3000, "drawdown_pct": 15},
                 {"min_peak_profit": 1000, "drawdown_pct": 25},
                 {"min_peak_profit": 0, "drawdown_pct": 40}]
    print("=== on %d closed OI positions ===" % len(rows))
    print("  %-34s %12s %14s" % ("scheme", "banked", "vs actual"))
    print("  %-34s %12.0f %14s" % ("actual realised", actual, "-"))
    for name, fn in (
        ("flat 20% give-back", lambda pk: 20),
        ("flat 15%", lambda pk: 15),
        ("flat 10%", lambda pk: 10),
        ("SHIPPED ladder (tightens on small)",
         lambda pk: _tier_value(SHIPPED, pk, "drawdown_pct", 20)),
        ("ladder that widens on small peaks",
         lambda pk: _tier_value(BACKWARDS, pk, "drawdown_pct", 20)),
    ):
        t = banked(fn)
        print("  %-34s %12.0f %+14.0f" % (name, t, t - actual))

print()
print("FAILURES: %d %s" % (len(fails), fails if fails else ""))
sys.exit(1 if fails else 0)
