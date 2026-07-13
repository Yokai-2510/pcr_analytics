# Strategies

PCR Analytics runs **five independent strategies**. Each one watches the option
chain in a different way and reaches its own opinion about which direction the
index is about to move.

Every strategy answers the same question — *"is the market leaning up or down
right now?"* — and acts the same way once it decides:

- Leaning **up** → buy a **Call (CE)**
- Leaning **down** → buy a **Put (PE)**

We only ever **buy** options. We never sell them. So the most we can lose on a
trade is the premium we paid.

You can run one strategy or several at once. They don't talk to each other —
each keeps its own position, so the OI strategy can be holding a Call at the same
time the Volume strategy is holding a Put.

---

## The one rule they all share: trade the *turn*, not the *state*

This is the single most important idea in the whole system, and it applies to
every strategy.

A strategy does **not** enter simply because conditions look bullish. It enters
only at the **moment the market flips** from one side to the other — the turn
itself. Once it has taken that side, it will not take that same side again. It
sits and waits for the market to flip the *other* way.

**Why?** Otherwise, on a strongly bullish day the "bullish" condition would be
true all day long, and the system would keep buying Calls over and over —
piling into a move that's already happened, buying at worse and worse prices.

A few consequences worth knowing:

- **The first clear reading of the day counts as a turn.** That's usually how the
  first trade of the morning gets taken.
- **A flat/undecided reading changes nothing.** The strategy remembers whichever
  side it last traded and keeps waiting for the genuine opposite signal.
- **After an exit, it stays out.** If a trade is stopped out, the strategy does
  *not* jump straight back into the same side. It waits for the next real flip.
- **A flip is both the exit and the entry.** When the market genuinely turns
  against an open position, that turn closes the trade and opens the opposite
  one.

The practical effect: **a small number of decent trades per day, not dozens of
churny ones.** On a quiet, directionless day you may get no trades at all — and
that is the system working correctly, not failing.

---

## 1. Open Interest (OI)

**What it watches:** how many contracts traders are *holding* — their standing
commitments — and how that's shifting through the day.

**The idea:** Open interest tells you where money is being committed. If traders
are steadily building up positions on the put side and unwinding on the call
side, that's a meaningful tell about where they expect the index to go.

The strategy tracks the running tug-of-war between the two sides. What matters
isn't which side is bigger — it's the moment the balance **tips from one side to
the other**.

**It buys a Call** when the balance tips from favouring puts to favouring calls.
**It buys a Put** when it tips the other way.

**Character:** the slowest and steadiest of the five. Open interest reflects
considered positioning rather than moment-to-moment noise, so this strategy
trades rarely and tends to pick up bigger, more deliberate shifts. It will not
catch a fast intraday scalp.

---

## 2. Volume

**What it watches:** how many contracts are actually **changing hands right now**
around the money — a band of strikes just around the current index level.

**The idea:** Volume is activity, not commitment. If far more calls are being
traded than puts, attention and urgency are on the upside.

The strategy compares call activity against put activity in that band and takes
whichever side is being hit harder.

**It buys a Call** when call volume is clearly the heavier side.
**It buys a Put** when put volume is the heavier side.

Because the band follows the index as it moves, the strategy is always looking at
the strikes that actually matter, not ones the market has left behind.

**Character:** faster and noisier than Open Interest. It reacts to where the crowd
is piling in *today*. Good at catching a move as it gets going; more prone to
being faked out by a short burst of activity that doesn't lead anywhere.

---

## 3. VWAP

**What it watches:** the index price against its **average price for the day**,
where the average is weighted by how much trading happened at each level.

**The idea:** the volume-weighted average is a fair estimate of "what the market
has agreed today's price is." Trading above it means buyers are in control;
below it, sellers are.

The strategy waits for the index to cross that line. It ignores tiny wobbles
right at the line — the index has to clear it by a small margin before the cross
counts, so a price hovering right on the average doesn't trigger a flurry of
trades.

**It buys a Call** when the index crosses decisively above its average.
**It buys a Put** when it crosses decisively below.

**Character:** the simplest and most intuitive of the five, and the only one that
looks at the index price itself rather than the option chain. Clean in a trending
market. In a choppy, sideways market the index can drift back and forth across
its average, so the small buffer around the line matters — it's what stops the
strategy from being whipsawed.

---

## 4. LTP (Option Strength)

**What it watches:** the **prices of the options themselves** — what calls and
puts have actually done in the market since the opening bell.

**The idea:** this is the most demanding strategy, and the most confirmation-
hungry. It won't act on a single hint. Before it buys a Call, it wants to see
**five things agree at once**:

1. Calls are **worth more** than they were at the open.
2. Puts are **worth less** than they were at the open.
3. Calls are winning by a clear margin, not a hair.
4. The move has been **continuing over the last few minutes** — not a single blip.
5. The index is trading **above its average price** for the day.

If even one of those disagrees, it does nothing. Buying a Put requires the exact
mirror image — puts up, calls down, over several minutes, index below its average.

**Character:** the most selective. Calls and puts moving in *opposite* directions
is the cleanest sign of genuine one-way conviction — when both rise together it
usually just means the market is getting nervous and pricing everything up, which
tells you nothing about direction. That's precisely the situation this strategy
is designed to sit out.

**Trade-off:** it will miss moves that the faster strategies catch. That's the
intended bargain — fewer trades, higher conviction.

> ⚠️ **Known issue — see "Known Issue" at the end of this document.** On days
> when an index trends hard in one direction, this strategy can go completely
> blind and take no trades at all, even while the LTP screen displays valid
> signals. This is a bug, not a design choice. BANKNIFTY on 13 Jul 2026 is a
> worked example.

---

## 5. Option Volume

**What it watches:** the **live order flow**, trade by trade, as it happens — and
critically, *who was the aggressor* in each trade.

**The idea:** every trade has a buyer and a seller, so raw volume alone can't tell
you which side was in a hurry. But you can infer it: a trade that goes through at
the *asking* price means the buyer reached up and took it — that buyer was
impatient. A trade at the *bid* means the seller hit it and *they* were the
impatient one.

By separating aggressive buying from aggressive selling, this strategy measures
genuine urgency rather than mere activity.

It tracks the aggressive flow into calls versus puts and takes whichever side is
being pushed harder.

**It buys a Call** when aggressive call buying is leading.
**It buys a Put** when aggressive put buying is leading.

**Character:** the fastest and most sensitive of the five — the only one reading
live streaming trades rather than periodic snapshots. It sees pressure building
before it shows up in price. The flip side is that it picks up noise, which is
why it has an optional **conviction filter**: you can require the imbalance to
reach a minimum size before it's allowed to trade, so a handful of small orders
can't trigger an entry.

---

## How a trade is closed

Once a strategy is in a position, it's watched continuously and closed by
whichever of these happens first:

| Exit | What it means |
|---|---|
| **Opposite signal** | The strategy's own reading flips against the position. This is the primary exit — the market turned, so we're out (and typically straight into the other side). |
| **Stop loss** | The option has lost more than your set percentage. Cuts the loser. |
| **Target** | The option has gained your set percentage. Takes the win. |
| **Peak trail** | The option ran up, then gave back too much of its best level. Protects a profit that's slipping away rather than riding it back to zero. |
| **Trailing stop** | Once the trade is nicely ahead, the stop follows it up, locking in gains as it goes. |
| **Time exit** | Closes at a set time regardless — typically well before the bell. |
| **End of day** | Nothing is ever carried overnight. |

Each strategy has its **own** exit settings — the Volume strategy can run a tight
stop while the LTP strategy runs a wide one. Any exit can be switched off.

---

## Choosing which strategies to run

They deliberately disagree with each other. That's the point — they're looking at
different things.

| Strategy | Speed | Trades | Best in |
|---|---|---|---|
| **Open Interest** | Slowest | Fewest | Deliberate, positioning-driven days |
| **Volume** | Fast | More | Active days with a clear crowd |
| **VWAP** | Medium | Medium | Clean trending days |
| **LTP** | Medium | Fewest | Strong one-way conviction |
| **Option Volume** | Fastest | Most | Fast-moving days; needs its filter |

A sensible way to start: run them all in **paper mode** for a few weeks and
compare. The reports break results down per strategy, so you can see which ones
actually suit the way each index behaves before putting real money behind any of
them.

---

## Known Issue — LTP strategy on strongly trending days

**Status:** confirmed bug, not yet fixed. Documented here so nobody mistakes it
for the strategy "deciding" not to trade.

**Symptom:** on a day when an index trends hard in one direction, the LTP strategy
can take **no trades at all**, while the LTP screen simultaneously shows perfectly
valid signals. The screen and the trading engine disagree.

**Worked example — BANKNIFTY, 13 Jul 2026:**

- BankNifty rallied about **530 points**, so the strikes "around the money" moved
  up by six.
- The strategy compares today's near-the-money options against **what those same
  options were worth at 9:15 that morning**.
- But at 9:15, those strikes were **500–800 points deep in the money** — and deep
  in-the-money options barely trade, so their opening prices were **stale, days-old
  quotes**.
- Measured against a stale baseline, the numbers came out nonsensical: the maths
  claimed the **puts had gained value while the index rallied 530 points**, which
  cannot happen.
- That nonsense reading parked the strategy in a permanent "wait" state for the
  whole session.

NIFTY and SENSEX were unaffected that day because their near-the-money strikes
barely moved, so their morning baseline stayed honest — and both traded normally.

**Why it matters:** the failure is worst *exactly when the strategy would be most
valuable* — a hard, clean trend is the setup it's supposed to capture.

**The fix:** compare each option against its own first *reliable* price, rather
than against a single morning snapshot that may be stale for strikes far from
where the index opened. The LTP screen already does this correctly — which is why
it shows signals the engine can't see. Bringing the engine in line with the screen
resolves it.
