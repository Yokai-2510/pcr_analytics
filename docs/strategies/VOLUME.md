# Volume

Trades the side that is **being traded harder right now** — activity, not commitment.

---

## Data required

| Input | Detail |
|---|---|
| Call & Put traded volume | Per strike |
| Band | ATM ± 5 strikes, **ATM recomputed every tick** |
| Refresh | Every 5 seconds |

The band follows the index. As the index moves, the strikes under watch move with
it, so the strategy is always reading the strikes that currently matter.

---

## Entry setup

Volume is summed on each side of the money:

```
Call volume  = calls from ATM upward   (ATM … ATM+5)
Put volume   = puts from ATM downward  (ATM−5 … ATM)

VOL DIFF     = Put volume − Call volume
```

| VOL DIFF | Meaning | Signal | Side |
|---|---|---|---|
| **Negative** — calls traded heavier | Crowd is hitting calls | **BUY** | **CE** |
| **Positive** — puts traded heavier | Crowd is hitting puts | **SELL** | **PE** |

**Entry fires only when VOL DIFF changes sign.**

- First directional reading of the day (typically ~09:15:05) seeds the side.
- After that, entry only on a genuine flip.
- The condition staying true does **not** re-trigger — so a position is never
  reopened simply because calls are still busier.

---

## Instrument selection

- Strike: per `strike_mode` (default `itm_2`).
- Quantity: `lot size × lots`.

---

## Nuances

- **Directional, not contrarian.** Unlike the OI strategy, heavy call volume here
  means **buy calls**. Volume measures where the crowd is going; OI measures where
  it is committed. They will sometimes disagree — that is expected.
- **Noisier than OI.** Volume spikes on news, expiry positioning, and single large
  orders. Some of those flips lead nowhere.
- **Volume is cumulative through the day**, so the comparison is between the two
  sides' totals, not per-tick bursts. A big early skew can take time to unwind.
- **Cannot tell buyer from seller.** A traded call could be someone buying it or
  someone writing it — volume alone does not distinguish. If you want that
  distinction, use the **Option Volume** strategy, which does.
- Reacts well once a move is underway; weaker at catching the very first turn.

---

## Exit conditions

Per-strategy settings; first trigger wins.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | VOL DIFF flips sign → exit and enter the opposite side |
| **Stop loss** | Premium −`stop_loss_pct` |
| **Target** | Premium +`target_pct` |
| **Peak trail** | Premium falls to `peak_trail_pct` of its peak |
| **Trailing stop** | Arms after `trailing_sl_trigger_pct`, follows in `trailing_sl_step_pct` steps |
| **Time exit** | At `time_exit_at` |
| **End of day** | Always flat overnight |

After an exit, waits for the **next sign flip** before re-entering.
