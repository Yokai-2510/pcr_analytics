# Apex Relative-Strength Engine

**NIFTY 50 FnO — Market-Neutral Intraday Strategy**
Strategy Logic Specification · v1.0

---

## 1. Objective

Generate intraday alpha by ranking the NIFTY 50 FnO universe on idiosyncratic
strength and trading a **beta-neutral long/short book** — long the strongest names,
short the weakest — so that returns depend on relative selection skill rather than
market direction. Each position is expressed through the instrument (futures, ITM
option, or spread) that maximises edge after transaction cost.

---

## 2. Universe & Data

| Item | Specification |
|------|---------------|
| Universe | All liquid NIFTY 50 FnO stocks + NIFTY futures (beta reference) |
| Feed | Upstox tick-by-tick WebSocket (LTP, bid/ask, traded volume, OI) |
| Reference | Per-stock futures for VWAP and beta; index futures for market beta |
| Session | 09:15–15:30 IST; state resets at session open |
| Cycle | Signals recomputed every tick; ranking/rebalance on a fixed micro-interval |

---

## 3. Edge Thesis

Among liquid single-stock FnO names, **idiosyncratic intraday strength persists over
short horizons** (minutes to ~1 hour) and is led by informed options positioning.
Ranking stocks cross-sectionally on this strength, then holding a beta-neutral
long/short spread, isolates the persistence effect from market drift.

---

## 4. Signal Stack (Alpha)

Each stock receives an alpha score from five standardised, low-correlation signals.
All signals are robust z-scored (median / MAD) against their own rolling history.

| Signal | Definition | Captures |
|--------|------------|----------|
| **S1 Residual momentum** | Stock return with NIFTY/sector beta removed | Idiosyncratic trend, not market drift |
| **S2 Options order-flow** | Risk-reversal of delta-residual premium + signed volume/OI | Informed call-vs-put positioning |
| **S3 Relative strength** | Return vs sector and vs index | Cross-sectional ranking |
| **S4 VWAP location** | Displacement from anchored VWAP + VWAP slope | Entry timing / mean-reversion context |
| **S5 IV / volatility state** | IV rank, skew and term vs realised | Determines the trade expression |

```
s_j      = robust_z(raw_j)                       # outlier-safe standardisation
w_j      = max(IC_j, 0) / Σ max(IC_k, 0)         # weight by rolling predictive skill
alpha_i  = tanh( Σ_j w_j · s_j )                 # bounded composite in [-1, +1]
```

**S2 construction:** for each option, `residual = ΔPremium − delta·dS`. The call-minus-put
residual, weighted by traded volume/OI and a freshness factor `exp(−age/τ)`, yields the
flow signal. Stale strikes contribute near zero.

---

## 5. Regime Classification

The strategy switches behaviour by regime, measured per stock and for the index.

```
ER = |P_t − P_{t−n}| / Σ|P_k − P_{k−1}|          # Kaufman efficiency ratio
VR = Var(q-bar returns) / (q · Var(1-bar returns))# variance ratio
Regime = z(a·ER + b·(VR−1))                       # n = measured signal half-life
```

| Regime | Behaviour | Expression bias |
|--------|-----------|-----------------|
| Trending (Regime > 0) | Momentum: long high-alpha, short low-alpha | Futures / ITM debit |
| Structureless | Reduce gross or stand aside | Cash |
| Mean-reverting (Regime < 0) | Fade extremes toward VWAP | Credit spread / sell rich premium |

---

## 6. Portfolio Construction

- **Selection:** rank the universe by alpha percentile; long the top decile, short the bottom decile.
- **Beta neutrality:** size legs so net NIFTY beta ≈ 0 — `Σ(beta_i·w_i)_long ≈ Σ(beta_i·w_i)_short`.
- **Sector caps:** bounded exposure per sector to prevent a disguised sector bet.
- **Correlation shrink:** down-size names with high pairwise correlation.
- **Liquidity gate:** a name enters only if its chosen instrument clears the cost test (§7).

```
w_i = alpha_i / sigma_i                           # volatility-targeted leg weight
w   = w · adjustments(net-beta = 0, sector caps, correlation shrink, gross cap)
```

---

## 7. Instrument Selection (Expression)

The instrument is chosen per position to maximise edge after cost.

| Condition | Expression | Rationale |
|-----------|------------|-----------|
| Trend, IV low/normal | Futures or deep-ITM option (delta ≈ 0.8) | Minimal theta/vega; clean delta |
| Trend, IV high | Debit spread (buy ITM / sell OTM) | Cuts vega and theta drag |
| Mean-revert, IV high | Credit spread / sell the rich side | Time decay works in favour |
| Weak / uncertain | No trade | Cost not covered by edge |

```
ExpectedEdge = alpha_i · sigma_underlying · √hold · |delta_struct|
Cost         = half_spread + theta_over_hold + STT + slippage
Trade only if  ExpectedEdge > k_cost · Cost       # hard cost gate
```

---

## 8. Entry Rules

- Arm on alpha crossing its live entry gate **with positive thrust** (acceleration), not after full maturation.
- In a confirmed trend, prefer fills on a retrace toward anchored VWAP while alpha holds.
- Stagger entries across correlated names to limit simultaneous slippage.
- The entry gate is a **live quantile** of the day's alpha distribution, self-throttling with breadth.

---

## 9. Exit & Risk Management

| Control | Rule | Unit |
|---------|------|------|
| Volatility stop | Adverse move > k · σ · √hold | Volatility units |
| Signal-decay exit | alpha reverts below β · alpha_entry | Fraction of entry conviction |
| Regime-flip exit | Regime sign turns against the position | Immediate |
| Reversal (CUSUM) | Cumulative drift exceeds noise-scaled limit H = c · σ | Change-point |
| Time stop | Hold > m · signal half-life | Adaptive |
| Profit scaling | Trim at R-multiples of the volatility stop | — |
| Per-trade cap | Risk ≤ fixed % of equity per name | Hard |
| Daily kill-switch | Halt all trading at the daily loss limit | Hard |

---

## 10. Position Sizing & Capital

```
q_i = (TargetRiskPerTrade · |alpha_i|) / (sigma_i · stop_mult)   # vol-targeted size
f   = clip(realised_edge / realised_variance, 0, f_max)          # fractional Kelly book scaler
Constraints: net beta ≈ 0 ; gross ≤ GrossCap ; per-sector ≤ SectorCap
```

Risk per trade is held constant in volatility units. The book scaler expands exposure
when realised edge is positive and contracts it otherwise, capped below full Kelly.

---

## 11. Parameter Policy

| Element | Mode | Reason |
|---------|------|--------|
| Lookback windows | Dynamic (EWMA, vol-scaled half-life) | Market speed varies intraday |
| Signal weights | Dynamic (rolling IC) | Emphasise currently-predictive signals |
| Normalisation | Dynamic (robust z, cross-sectional percentile) | Outlier and beta robust |
| Entry gate | Dynamic (live quantile) | Self-throttle with breadth |
| Stops / time-stops | Dynamic (volatility / half-life units) | Self-scale across names and regimes |
| Per-trade risk % | Fixed | Risk discipline must not drift |
| Daily kill-switch | Fixed | Survival rule |
| Net-beta target (≈ 0) | Fixed | Structural identity of the book |
| Cost gate `k_cost` | Fixed | Guardrail, not an optimisation knob |

---

## 12. Validation Protocol

1. **Walk-forward testing** — calibrate on past data, evaluate on untouched forward data, roll.
2. **Cost-honest backtest** — charge full spread, slippage, STT and theta.
3. **Per-regime expectancy** — report edge separately for trend, revert and flat regimes.
4. **IC and decay monitoring** — track `corr(alpha, forward return)`; retire signals as IC fades.
5. **Capacity testing** — confirm sizing respects single-stock option liquidity.
6. **Paper / micro-live** — verify live microstructure before scaling capital.

---

## 13. Daily Operating Sequence

1. **09:15** — initialise session: reset state, anchor VWAP, seed beta and volatility estimates.
2. **Intraday** — per cycle: update signals → compute alpha → classify regime → rank universe →
   construct beta-neutral book → select expression → manage entries/exits → enforce risk caps.
3. **Continuous** — monitor kill-switch, gross/sector caps and signal decay.
4. **15:30** — flatten positions, log fills and per-signal performance for validation.
