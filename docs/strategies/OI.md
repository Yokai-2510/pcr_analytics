# Open Interest (OI)

Trades the shift in **standing positions** — where traders are committing money,
not where they are merely active.

---

## Data required

| Input | Detail |
|---|---|
| Call & Put open interest | Every strike in the ATM ± 5 band |
| Baseline | **Post-settlement snapshot** (taken ~5 min after the settlement window, before the open) |
| Refresh | Every 5 seconds |

Everything is measured as **change from the post-settlement baseline**, not
absolute OI. Absolute OI carries yesterday's positions and says nothing about today.

---

## Entry setup

Two running totals, both since baseline:

```
Call OI built   = total CE open interest − baseline
Put OI built    = total PE open interest − baseline

OI Difference   = Put OI built − Call OI built
```

**Reading it:** a rising put OI means traders are *writing puts* — they are
willing to be forced to buy at that level, i.e. they see support. That is
**bullish**. Heavy call writing is the reverse.

| OI Difference | Meaning | Signal | Side |
|---|---|---|---|
| **Positive** — puts built more | Put writers active → support | **BUY** | **CE** |
| **Negative** — calls built more | Call writers active → resistance | **SELL** | **PE** |

**Entry fires only when OI Difference crosses zero.**

- First reading of the day: sign of OI Difference sets the initial side.
- Thereafter: entry only when it flips sign (positive → negative, or vice versa).
- Staying positive all day = **one** trade, not many.

---

## Instrument selection

- Strike: per `strike_mode` (default `itm_2` — 2 steps in-the-money).
- Quantity: `lot size × lots`.
- ATM tracked live; the strike is chosen at the moment of entry.

---

## Nuances

- **Slowest of the five.** Open interest reflects considered positioning, so it
  changes gradually. Expect very few trades — often one or two a day.
- **Contrarian by construction.** It buys Calls when *put* activity builds. If you
  expect "puts rising = bearish", this will read backwards to you. It is not.
- **Baseline choice matters.** The post-settlement baseline is used so that
  overnight and pre-open positioning is excluded. A wrong or missing baseline
  makes every reading meaningless.
- **Blind to price.** It never looks at the index level or option premiums — only
  at commitment. It can be positioned against a sharp move for a while.
- **Not a scalper.** It will not catch fast intraday swings, by design.

---

## Exit conditions

Per-strategy settings; first trigger wins.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | OI Difference flips back across zero → exit and enter the opposite side |
| **Stop loss** | Premium −`stop_loss_pct` |
| **Target** | Premium +`target_pct` |
| **Peak trail** | Premium falls to `peak_trail_pct` of its peak |
| **Trailing stop** | Arms after `trailing_sl_trigger_pct`, follows in `trailing_sl_step_pct` steps |
| **Time exit** | At `time_exit_at` |
| **End of day** | Always flat overnight |

After any exit, the strategy waits for the **next zero-cross** before re-entering.
It will not re-enter the same side.
