# VWAP

Trades the index against its **volume-weighted average price for the session**.
The only strategy that reads the index itself rather than the option chain.

---

## Data required

| Input | Detail |
|---|---|
| Index spot price | Every tick |
| Traded volume | Calls + puts, used to weight the average |
| Anchor | **09:15 IST** — resets every day |
| Refresh | Every 5 seconds |

---

## Entry setup

The session average is built up tick by tick, weighting each price by how much
trading happened there:

```
VWAP = Σ (spot × volume traded at that tick) ÷ Σ (volume traded)
```

Direction is decided by which side of that average the index is on. A **0.05%
buffer** sits around the line — the index must clear it, not merely touch it.

| Condition | Signal | Side |
|---|---|---|
| Spot **above** VWAP + 0.05% | **BUY** | **CE** |
| Spot **below** VWAP − 0.05% | **SELL** | **PE** |
| Inside the buffer | Neutral — no signal | — |

**Entry fires only on a fresh cross** of the band, not while the index simply
remains on one side.

- Live from 09:15 — no warm-up period.
- At the first tick VWAP equals spot, so the strategy starts neutral and naturally
  waits for the first genuine cross.

---

## Instrument selection

- Strike: per `strike_mode` (default `itm_2`).
- Quantity: `lot size × lots`.

---

## Nuances

- **The buffer is the whole design.** Without it, an index sitting exactly on its
  average would cross back and forth constantly and generate a stream of losing
  trades. The 0.05% band is what makes this tradeable in chop.
- **Trend-following.** Clean and reliable on a day that picks a direction and
  holds it. On a sideways day it will still get chopped — the buffer reduces that,
  it does not eliminate it.
- **VWAP is anchored, not rolling.** It is the average since 09:15, so it gets
  *heavier* as the day goes on — late-session ticks move it less. Early crosses are
  easier to trigger; late ones require a real move.
- **Volume-weighted, so it respects where the money traded**, not merely where
  price went. A fast move on thin volume shifts VWAP less than a grind on heavy
  volume.
- **Says nothing about the option chain.** It will happily signal when option
  positioning disagrees. Pairing it with an option-based strategy is a reasonable
  cross-check.

---

## Exit conditions

Per-strategy settings; first trigger wins.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | Index crosses back through the band the other way → exit and enter the opposite side |
| **Stop loss** | Premium −`stop_loss_pct` |
| **Target** | Premium +`target_pct` |
| **Peak trail** | Premium falls to `peak_trail_pct` of its peak |
| **Trailing stop** | Arms after `trailing_sl_trigger_pct`, follows in `trailing_sl_step_pct` steps |
| **Time exit** | At `time_exit_at` |
| **End of day** | Always flat overnight |

After an exit, waits for the **next band cross** before re-entering.
