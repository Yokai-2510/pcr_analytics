# Option Volume

Trades **aggressive order flow** — separating who was the impatient party in each
trade. The fastest and most sensitive of the five.

> Metric definitions (Net Delta, Delta Velocity, Delta Acceleration, Flow Ratio)
> are in [../OPTION_VOLUME.md](../OPTION_VOLUME.md).

---

## Data required

| Input | Detail |
|---|---|
| Live trade stream | Websocket — every trade as it prints, not 5-second snapshots |
| Bid / ask quotes | Required to tell aggressive buying from aggressive selling |
| Band | ATM ± strikes, ATM recomputed live |

**This is the only strategy that does not run off periodic snapshots.** It needs
the live feed; if the websocket is down, it produces nothing.

---

## Entry setup

Raw volume cannot tell you who was in a hurry — every trade has a buyer *and* a
seller. This strategy infers it from **where the trade printed**:

| Trade printed at | Who was aggressive |
|---|---|
| The **ask** (or above) | The **buyer** reached up and took it |
| The **bid** (or below) | The **seller** hit the bid |
| In between | Assigned to the nearer side |

That splits volume into aggressive buying vs aggressive selling, on each side:

```
Call Delta = aggressive call buying − aggressive call selling
Put Delta  = aggressive put buying  − aggressive put selling
Net Delta  = Call Delta − Put Delta
```

| Condition | Signal | Side |
|---|---|---|
| Call Delta leads | Urgent buying in calls | **BUY** | **CE** |
| Put Delta leads | Urgent buying in puts | **SELL** | **PE** |

**Entry fires only when the leading side flips.** The first directional reading
seeds the side; after that, only genuine reversals trade.

### Conviction filter (optional but recommended)

Because the feed is fast and noisy, an entry can be gated on the imbalance being
*big enough*:

| Setting | Effect |
|---|---|
| `optvol_min_net_delta` | Net Delta must exceed this size (in contracts). Blocks entries driven by a handful of small orders. |
| `optvol_min_net_delta_ratio` | Net Delta must be at least this fraction of the larger side's flow. Blocks entries where both sides are huge and the *difference* is incidental. |

Set to `0` = filter off. **With both off, this strategy will trade noise.**

---

## Instrument selection

- Strike: per `strike_mode` (default `itm_2`).
- Quantity: `lot size × lots`.

---

## Nuances

- **Leads price.** It sees pressure building before it shows up in the index —
  earliest of the five to turn. That also means it is earliest to be *wrong*.
- **The conviction filter is not optional in practice.** Without it, a few small
  aggressive orders can flip the signal. This is the main tuning knob.
- **Signals appear in the Entry Signals tab even when filtered out.** Signal count
  will exceed trade count — by design, so you can see what the filter is rejecting.
- **Different from the Volume strategy.** Volume counts contracts traded; this
  counts *who was impatient*. They can point opposite ways: heavy call volume with
  aggressive **selling** into it is bearish, and only this strategy sees that.
- **Depends on quote quality.** If bid/ask are wide or stale, the buy/sell split
  degrades toward a coin flip.

---

## Exit conditions

Per-strategy settings; first trigger wins.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | Leading side flips → exit and enter the opposite side |
| **Stop loss** | Premium −`stop_loss_pct` |
| **Target** | Premium +`target_pct` |
| **Peak trail** | Premium falls to `peak_trail_pct` of its peak |
| **Trailing stop** | Arms after `trailing_sl_trigger_pct`, follows in `trailing_sl_step_pct` steps |
| **Time exit** | At `time_exit_at` |
| **End of day** | Always flat overnight |

After an exit, waits for the **next flow reversal** before re-entering — it will
not re-enter the same side.
