# Option Volume & Flow Metrics

The websocket engine (`ws_engine.py`) classifies executed option volume by
aggressor side and derives the flow metrics that power the Option Volume tab
and the `optvol` trading strategy.

## Aggressor classification (the quote rule)

Upstox ticks don't label the aggressor, so each tick's **incremental** traded
volume is classified by where the last price sits relative to the quote:

For each option leg, per tick:

1. `dv = volume_now − volume_prev_tick` — the quantity that traded this tick
   (the broker's `volume` is cumulative-for-the-day; we diff it). Skip if `dv ≤ 0`,
   and only count strikes within the ATM± band.
2. Classify:
   - `ltp ≥ ask (>0)` → **buy** (trade lifted the offer)
   - `bid (>0) ≥ ltp` → **sell** (trade hit the bid)
   - otherwise → midpoint tiebreak (`ltp ≥ (bid+ask)/2` → buy, else sell)
3. Accumulate **raw contracts** into the bucket:
   `ce_buy / ce_sell / pe_buy / pe_sell += dv`.

> The buckets hold **contract volume**, not premium notional — the whole tick's
> `dv` goes to exactly one bucket, and they accumulate across the session. The
> 1-minute logger writes a running-total snapshot to `option_volume_logs`, so
> the columns grow monotonically through the day.

## Derived metrics

| metric | formula | reading |
|--------|---------|---------|
| **CE Delta** | `ce_buy − ce_sell` | net call-buying pressure |
| **PE Delta** | `pe_buy − pe_sell` | net put-buying pressure |
| **Net Delta (ND)** | `CE Delta − PE Delta` | overall bullishness; > 0 → CE side |
| **Delta Velocity (DV)** | `ΔND / Δt` (per second) | fresh flow — how fast ND is moving now |
| **Delta Acceleration (DA)** | `ΔDV / Δt` | whether the flow is strengthening |
| **Flow Ratio (FR)** | `(CE buy + PE sell) ÷ (CE sell + PE buy)` | bullish flow ÷ bearish flow; > 1 bullish |

`Net Delta = CE Delta − PE Delta` (subtraction, not addition): a gainer's calls
being bought (CE Δ up) and its puts being sold (PE Δ down) both push ND up, so
the sign is the CE-vs-PE lead — a zero-cross is a genuine side flip.

## The `optvol` strategy

The Option Volume strategy trades the side whose flow leads: on a Flow-Ratio /
Net-Delta directional flip it enters (BUY→CE, SELL→PE) and manages the position
with the same exit stack as every other source. Signals are generated **live
per tick**; only the 1-minute log rows are persisted.

## Strike band

Classification counts strikes within `ATM ± strike_count` (symmetric, per the
instrument config), separate from the wider websocket **subscription** window
(ATM ± strike_count + safe strikes). The Volume Logs tab's totals use a
different window (1 ITM + ATM + 5 OTM), so the two tabs are not directly
comparable — one is aggressor-classified contracts in the ATM± band, the other
is raw chain volume over the ITM/OTM band.
