# LTP (Option Strength)

Trades **only when calls and puts move in opposite directions** — the cleanest
sign of genuine one-way conviction. The most selective of the five.

---

## Data required

| Input | Detail |
|---|---|
| Call & Put premiums | ATM + 3 in-the-money strikes on each side |
| Reference | Each option's price at the **09:15 open** |
| Rolling window | Same premiums **5 minutes ago** |
| Index spot + session VWAP | For the final confirmation |
| Refresh | Every 5 seconds |

Strikes used (ATM tracked live):
- **Calls:** ATM, ATM−1, ATM−2, ATM−3 steps
- **Puts:** ATM, ATM+1, ATM+2, ATM+3 steps

---

## Entry setup

Four measures, all computed since the 09:15 open:

```
Call Strength   = Σ (call premiums now − call premiums at open)
Put Strength    = Σ (put premiums now  − put premiums at open)
Directional     = Call Strength − Put Strength
Rolling (5 min) = same difference, measured over the last 5 minutes
```

**BUY a Call** requires **all five** to be true at once:

1. Call Strength **> 0** — calls worth more than at the open
2. Put Strength **< 0** — puts worth less than at the open
3. Directional **> 0** — calls winning by a clear margin
4. Rolling **> 0** — the move is *continuing*, not a one-tick blip
5. Spot **above** session VWAP

**SELL (buy a Put)** requires the exact mirror: calls down, puts up, directional
negative, rolling negative, spot below VWAP.

If any single condition disagrees → **no signal**. Entry still only fires on a
**flip** of the resulting direction.

---

## Instrument selection

- Strike: per `strike_mode` (default `itm_2`).
- Quantity: `lot size × lots`.

---

## Nuances

- **The opposite-direction requirement is the point.** When calls *and* puts both
  rise together, the market is simply pricing in more uncertainty — that says
  nothing about direction. This strategy is built to sit out exactly that state
  (it reports it as *"IV Expansion / Wait"*).
- **Fewest signals of the five.** Requiring five simultaneous confirmations means
  it will miss moves the faster strategies catch. That is the intended trade-off:
  fewer trades, higher conviction.
- **The rolling check kills one-tick noise.** A momentary spike will pass
  conditions 1–3 but fail the 5-minute check.
- **Two exits, not one.** Both stop-loss and target are commonly disabled for this
  strategy, leaving the directional flip as the sole exit — it is designed to ride
  a confirmed move, not to scalp it.

---

## ⚠️ Known issue — blind on strongly trending days

**Confirmed bug. Unfixed.** This is not the strategy "deciding" not to trade.

**Symptom:** on a day when an index trends hard, this strategy can take **zero
trades** while the LTP screen simultaneously displays valid signals. The screen and
the trading engine disagree.

**Cause:** the strategy prices today's near-the-money options against **what those
same options were worth at 09:15**. When the index trends, the at-the-money strikes
drift several steps. Those strikes were **deep in-the-money at the open** — and
deep in-the-money options barely trade, so their opening prices are **stale
prints**. Measured against a stale baseline, the numbers come out nonsensical, and
the strategy parks in *"IV Expansion / Wait"* for the rest of the session.

**Worked example — BANKNIFTY, 13 Jul 2026:**

| | |
|---|---|
| Index move | Rallied ~530 points; ATM drifted 57,500 → 58,100 (6 strikes) |
| What the maths concluded | **Puts gained value while the index rallied 530 points** — impossible |
| Result | Zero trades all day. NIFTY and SENSEX (ATM barely moved) traded normally |
| The screen | Showed a valid BUY at 10:33:55 that the engine never acted on |

**Why it matters:** the failure is worst **precisely when the strategy is most
valuable** — a hard, clean trend is the setup it exists to capture.

**Fix:** compare each option against its own first *reliable* price rather than a
single 09:15 snapshot that is stale for strikes far from the opening ATM. The LTP
screen already does this correctly — which is why it sees signals the engine
cannot. Aligning the engine with the screen resolves it.

---

## Exit conditions

Per-strategy settings; first trigger wins.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | Direction flips → exit and enter the opposite side. Primary (often the only) exit. |
| **Stop loss** | Premium −`stop_loss_pct` |
| **Target** | Premium +`target_pct` |
| **Peak trail** | Premium falls to `peak_trail_pct` of its peak |
| **Trailing stop** | Arms after `trailing_sl_trigger_pct`, follows in `trailing_sl_step_pct` steps |
| **Time exit** | At `time_exit_at` |
| **End of day** | Always flat overnight |

After an exit, waits for the **next directional flip** before re-entering.
