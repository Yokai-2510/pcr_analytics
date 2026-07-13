# Strategies — Index

Five independent strategies. Each reads the option chain differently, forms its
own view of direction, and holds its own position. They do not coordinate — the
OI strategy can hold a Call while the Volume strategy holds a Put.

All strategies **buy options only** (never sell). Max loss per trade = premium paid.

| Strategy | Reads | Speed | Trade count | Doc |
|---|---|---|---|---|
| **Open Interest** | Contracts held (positioning) | Slowest | Fewest | [strategies/OI.md](strategies/OI.md) |
| **Volume** | Contracts traded (activity) | Fast | More | [strategies/VOLUME.md](strategies/VOLUME.md) |
| **VWAP** | Index vs its session average | Medium | Medium | [strategies/VWAP.md](strategies/VWAP.md) |
| **LTP** | Option premiums (5-way confirmation) | Medium | Fewest | [strategies/LTP.md](strategies/LTP.md) |
| **Option Volume** | Live aggressive order flow | Fastest | Most | [strategies/OPTION_VOLUME.md](strategies/OPTION_VOLUME.md) |

Direction → side is the same everywhere:
- **BUY** = bullish → buy a **Call (CE)**
- **SELL** = bearish → buy a **Put (PE)**

---

## Shared rule: entries fire on the flip, not the state

Applies to all five. An entry fires **only when direction changes** — never
because a condition merely remains true.

- First directional reading of the day = the seed flip → first trade.
- A neutral/undecided reading does **not** reset direction; the last traded side
  is remembered.
- After any exit (stop-loss, target, trail), the strategy stays **flat** — it does
  not re-enter the same side. It waits for the opposite flip.
- A flip against an open position is both the **exit** and the **entry** into the
  opposite side.

Consequence: a handful of trades per day, not dozens. **Zero trades on a
directionless day is correct behaviour.**

---

## Shared: instrument selection

| Index | Strike step | Lot size | Strikes captured |
|---|---|---|---|
| NIFTY | 50 | 75 | ATM ± 5 |
| BANKNIFTY | 100 | 30 | ATM ± 5 |
| SENSEX | 100 | 20 | ATM ± 5 |

ATM is recomputed every tick and follows the index.

**Strike selection** (`strike_mode`, per strategy):

| Mode | Strike picked |
|---|---|
| `atm` | At the money |
| `itm_1` | 1 step in-the-money (CE: ATM−step · PE: ATM+step) |
| `itm_2` | 2 steps in-the-money |
| `custom_steps: N` | N steps in-the-money; **negative N = out-of-the-money** |

Quantity = `lot size × lots`.

---

## Shared: exit conditions

Evaluated continuously; first to trigger wins. Each is optional and configured
**per strategy**.

| Exit | Trigger |
|---|---|
| **Counter-crossover** | Strategy's own direction flips against the position. Primary exit. |
| **Stop loss** | Premium falls `stop_loss_pct` below entry. |
| **Target** | Premium rises `target_pct` above entry. |
| **Peak trail** | Premium falls to `peak_trail_pct` of its highest point since entry. |
| **Trailing stop** | After `trailing_sl_trigger_pct` gain, stop follows price up in `trailing_sl_step_pct` steps. |
| **Time exit** | Force-close at `time_exit_at`. |
| **End of day** | Nothing carried overnight. |

---

## Shared: execution settings

| Setting | Value / meaning |
|---|---|
| `mode` | `paper` (simulated) or `live` (real orders) |
| `auto_execute` | Master switch — off = signals only, no orders |
| `max_positions_per_day` | Cap across all strategies |
| `no_entry_after` | No new entries past this time (default 15:25) |
| `cooldown_minutes` | Minimum gap between entries for a strategy |
| `order_type` | MARKET |
| `order_product` | Intraday |
| `order_validity` | DAY |

---

## Known issues

- **LTP on strongly trending days** — can go blind and take zero trades while the
  LTP screen shows valid signals. Confirmed bug, unfixed.
  See [strategies/LTP.md](strategies/LTP.md).
