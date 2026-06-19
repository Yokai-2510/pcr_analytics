# Apex Relative-Strength Engine

**NIFTY 50 FnO — Market-Neutral Intraday Strategy**
Strategy Logic Specification · v1.0 (Detailed)

---

## 1. Objective

Generate intraday alpha by ranking the NIFTY 50 FnO universe on **idiosyncratic
strength** and trading a **beta-neutral long/short book** — long the strongest names,
short the weakest — so returns depend on relative selection skill rather than market
direction. Each position is expressed through the instrument (futures, ITM option, or
spread) that maximises edge net of transaction cost.

---

## 2. Universe & Data

| Item | Specification |
|------|---------------|
| Universe | All liquid NIFTY 50 FnO stocks $i \in \{1,\dots,N\}$ + NIFTY futures (market) + sector proxies |
| Feed | Upstox tick-by-tick WebSocket: LTP, bid/ask, traded volume, OI |
| Reference | Per-stock futures for VWAP/beta; index futures for market beta |
| Session | 09:15–15:30 IST; all state resets at session open |
| Clock | Signals updated per tick; ranking/rebalance on a fixed micro-interval $\Delta t$ |

---

## 3. Mathematical Preliminaries

These primitives are used by every signal.

**Log return** over interval ending at $t$:

$$r_t = \ln\!\left(\frac{P_t}{P_{t-1}}\right)$$

**EWMA** (exponential moving average) of a series $x_t$ with smoothing $\alpha\in(0,1)$:

$$\mathrm{EWMA}_\alpha(x)_t = \alpha\,x_t + (1-\alpha)\,\mathrm{EWMA}_\alpha(x)_{t-1}$$

The smoothing is derived from a **half-life** $h$ (in bars), which is itself made
adaptive to volatility (§3.1):

$$\alpha = 1 - \exp\!\left(\frac{-\ln 2}{h}\right), \qquad
N_{\text{eff}} = \frac{2-\alpha}{\alpha}$$

**Robust z-score** (outlier-safe; resists stale ITM prints) using rolling median and
median-absolute-deviation (MAD):

$$z_{\text{rob}}(x_t) = \frac{x_t - \mathrm{median}(x)}{1.4826\,\mathrm{MAD}(x) + \epsilon},
\qquad \mathrm{MAD}(x) = \mathrm{median}\big(|x - \mathrm{median}(x)|\big)$$

**Cross-sectional z-score** across the live universe of $N$ stocks at time $t$:

$$z^{\times}(x_i) = \frac{x_i - \mu_t^{\times}}{\sigma_t^{\times}}, \quad
\mu_t^{\times} = \frac{1}{N}\sum_j x_j, \quad
\sigma_t^{\times} = \sqrt{\tfrac{1}{N}\sum_j (x_j - \mu_t^{\times})^2}$$

### 3.1 Adaptive half-life

Window length breathes with volatility so memory shortens in fast tapes:

$$h_t = h_0 \cdot \frac{\sigma_{\text{ref}}}{\hat\sigma_t}, \qquad
\hat\sigma_t = \sqrt{\mathrm{EWMA}_{\alpha_v}(r_t^2)}$$

where $\sigma_{\text{ref}}$ is the stock's trailing-session median volatility.

---

## 4. Signal Stack (Alpha)

Each stock receives a composite alpha from five low-correlation signals. All raw
signals are robust z-scored, then blended by recent predictive skill.

### 4.1 S1 — Residual (idiosyncratic) momentum

Removes market and sector beta so only stock-specific trend remains.

**Step 1 — rolling betas** via EWMA covariance against market return $r^m$ and sector
return $r^s$:

$$\beta^m_{i,t} = \frac{\mathrm{EWMA}_\alpha\!\big(r_i r^m\big)_t - \bar r_i \bar r^m}
{\mathrm{EWMA}_\alpha\!\big((r^m)^2\big)_t - (\bar r^m)^2}, \qquad
\beta^s_{i,t} \text{ defined analogously on } r^s$$

**Step 2 — residual return** (the idiosyncratic component):

$$e_{i,t} = r_{i,t} - \beta^m_{i,t}\,r^m_t - \beta^s_{i,t}\,r^s_t$$

**Step 3 — volatility-normalised residual momentum** (a t-statistic of trend):

$$M_{i,t} = \frac{\mathrm{EWMA}_{\alpha_f}(e_i)_t}{\hat\sigma_{e_i,t}\,/\,\sqrt{N_{\text{eff}}}},
\qquad \hat\sigma_{e_i,t} = \sqrt{\mathrm{EWMA}_{\alpha_v}(e_{i}^2)_t}$$

$$\boxed{\,s^{(1)}_i = z_{\text{rob}}(M_{i})\,}$$

### 4.2 S2 — Options order-flow (informed positioning)

Isolates premium movement **not** explained by the underlying move, then nets calls
against puts — the intraday risk-reversal of informed flow.

**Step 1 — delta-residual** per option contract $k$ (call set $\mathcal C$, put set
$\mathcal P$), where $\delta_k$ is the option delta and $\Delta S$ the underlying move:

$$\rho_k = \Delta \pi_k - \delta_k\,\Delta S$$

Option delta from Black–Scholes (or chain-implied):

$$\delta_{\text{call}} = \Phi(d_1),\quad \delta_{\text{put}} = \Phi(d_1)-1, \quad
d_1 = \frac{\ln(S/K) + (r + \tfrac12\sigma^2)\tau}{\sigma\sqrt{\tau}}$$

**Step 2 — contract weight** combining liquidity and freshness ($a_k$ = seconds since
last trade):

$$w_k = \underbrace{\frac{V_k}{\sum_j V_j}}_{\text{volume share}} \cdot
\underbrace{\big(1+\mathrm{OI}_k\big)^{\gamma}}_{\text{open-interest}} \cdot
\underbrace{e^{-a_k/\tau}}_{\text{freshness}}$$

**Step 3 — signed aggressor flow** (Lee–Ready / tick rule), $\text{sgn}_k=+1$ if trade
at/above ask, $-1$ if at/below bid:

$$F^{\text{OFI}}_i = \sum_{k\in\mathcal C} \text{sgn}_k V_k - \sum_{k\in\mathcal P} \text{sgn}_k V_k$$

**Step 4 — composite flow** (risk-reversal of residual + order-flow imbalance):

$$\Psi_i = \Big(\sum_{k\in\mathcal C} w_k \rho_k - \sum_{k\in\mathcal P} w_k \rho_k\Big)
+ \lambda_{\text{ofi}}\, z_{\text{rob}}\!\big(F^{\text{OFI}}_i\big)$$

$$\boxed{\,s^{(2)}_i = z_{\text{rob}}(\Psi_i)\,}$$

### 4.3 S3 — Cross-sectional relative strength

Ranks each stock's idiosyncratic move against the universe and its sector.

**Cumulative residual return** since session open:

$$C_{i,t} = \sum_{u=\text{open}}^{t} e_{i,u}$$

**Relative strength** = blend of universe-relative and sector-relative standardised scores:

$$\mathrm{RS}_i = \theta\, z^{\times}_{\text{universe}}(C_i) + (1-\theta)\, z^{\times}_{\text{sector}}(C_i)$$

$$\boxed{\,s^{(3)}_i = z^{\times}(\mathrm{RS}_i)\,}$$

### 4.4 S4 — VWAP location & slope

Provides timing and mean-reversion context.

**Anchored (session) VWAP**:

$$\mathrm{VWAP}_t = \frac{\sum_{u=\text{open}}^{t} P_u V_u}{\sum_{u=\text{open}}^{t} V_u}$$

**Standardised displacement** (bands self-calibrate via rolling scale of the
displacement $D$):

$$D_{i,t} = P_{i,t} - \mathrm{VWAP}_{i,t}, \qquad
\mathrm{VWAPz}_i = \frac{D_{i,t}}{\mathrm{scale}_{\text{roll}}(D_i)}$$

**VWAP slope** (trend of the anchor):

$$g_i = \mathrm{EWMA}_\alpha\!\big(\mathrm{VWAP}_{i,t}-\mathrm{VWAP}_{i,t-1}\big)$$

**Bounded, alignment-aware score** ($\mathrm{sgn\_align}=+1$ when displacement, slope and
momentum agree, else $-1$):

$$\boxed{\,s^{(4)}_i = \tanh\!\big(\mathrm{VWAPz}_i\big)\cdot \mathrm{sgn\_align}(g_i, M_i)\,}$$

### 4.5 S5 — Implied-volatility / volatility state

Gates the **expression** (how to trade) rather than direction.

**Realised volatility** (Yang–Zhang, robust intraday estimator) and **IV rank** as the
percentile of current ATM implied vol in its trailing distribution:

$$\mathrm{IVrank}_i = \mathrm{pct}\big(\sigma^{\text{IV,ATM}}_{i,t}\ \big|\ \text{trailing window}\big) \in [0,1]$$

**Risk-reversal skew** (25-delta) and **variance-risk premium**:

$$\mathrm{Skew}_i = \sigma^{\text{IV}}_{25\Delta\text{P}} - \sigma^{\text{IV}}_{25\Delta\text{C}},
\qquad \mathrm{VRP}_i = \big(\sigma^{\text{IV,ATM}}_i\big)^2 - \big(\sigma^{\text{RV}}_i\big)^2$$

$$\boxed{\,s^{(5)}_i = \big(\mathrm{IVrank}_i,\ z_{\text{rob}}(\mathrm{Skew}_i),\ z_{\text{rob}}(\mathrm{VRP}_i)\big)\,}$$

$s^{(5)}$ is a state vector consumed by §7 (expression), not added to the directional sum.

### 4.6 Composite alpha

Directional signals $j\in\{1,2,3,4\}$ are weighted by **rolling skill** — the
information coefficient (Spearman rank correlation of the signal with realised forward
residual return $e^{\text{fwd}}$ over horizon $H$):

$$\mathrm{IC}_{j,t} = \mathrm{EWMA}_\alpha\!\Big(\mathrm{corr}_{\text{rank}}\big(s^{(j)}_{t-H}, e^{\text{fwd}}_t\big)\Big)$$

$$w_{j,t} = \frac{\max(\mathrm{IC}_{j,t},\,0)}{\sum_{k}\max(\mathrm{IC}_{k,t},\,0)}$$

$$\boxed{\,\alpha_i = \tanh\!\Big(\textstyle\sum_{j=1}^{4} w_{j,t}\, s^{(j)}_i\Big) \in [-1,+1]\,}$$

---

## 5. Regime Classification

Determines whether to **ride** strength (momentum) or **fade** it (mean-reversion),
measured per stock and for the index.

**Kaufman efficiency ratio** (path cleanliness over lookback $n$ = signal half-life):

$$\mathrm{ER}_t = \frac{|P_t - P_{t-n}|}{\sum_{u=t-n+1}^{t} |P_u - P_{u-1}|} \in [0,1]$$

**Variance ratio** ($q$-bar vs 1-bar dispersion):

$$\mathrm{VR}(q) = \frac{\mathrm{Var}\!\big(\sum_{l=1}^{q} r_{t-l}\big)}{q\,\mathrm{Var}(r_t)}$$

$$\boxed{\,\mathrm{Regime}_i = z\big(a\,\mathrm{ER}_i + b\,(\mathrm{VR}_i-1)\big)\,}$$

| Regime | Behaviour | Expression bias |
|--------|-----------|-----------------|
| $\mathrm{Regime} > 0$ (trend) | Momentum: long high-$\alpha$, short low-$\alpha$ | Futures / ITM debit |
| $\approx 0$ (structureless) | Reduce gross / stand aside | Cash |
| $\mathrm{Regime} < 0$ (revert) | Fade extremes toward VWAP | Credit spread / sell rich premium |

---

## 6. Portfolio Construction

**Selection.** Rank by alpha percentile; long top decile $\mathcal L$, short bottom
decile $\mathcal S$.

**Raw volatility-targeted weight**:

$$\tilde w_i = \frac{\alpha_i}{\hat\sigma_i}$$

**Beta neutrality.** Choose leg scalars so net market beta vanishes:

$$\sum_{i\in\mathcal L}\beta^m_i w_i \;=\; \sum_{i\in\mathcal S}\beta^m_i |w_i|
\quad\Longrightarrow\quad \sum_i \beta^m_i w_i = 0$$

**Correlation shrink** (down-size crowded names; $\bar\rho_i$ = mean pairwise correlation
to the rest of the book, $n_c$ = cluster size):

$$w_i \leftarrow \frac{w_i}{1 + \bar\rho_i\,(n_c - 1)}$$

**Constraints.** Per-name cap, per-sector cap, and gross cap:

$$|w_i|\le c_{\text{name}}, \quad \sum_{i\in\text{sector }g}|w_i|\le c_{\text{sector}},
\quad \sum_i |w_i| \le \mathrm{GrossCap}$$

---

## 7. Instrument Selection (Expression)

Given direction $\alpha_i$ and vol state $s^{(5)}$, pick the structure that maximises
edge net of cost.

| Condition | Expression | Rationale |
|-----------|------------|-----------|
| Trend, low/normal IVrank | Futures or deep-ITM option ($\delta\approx0.8$) | Minimal theta/vega; clean delta |
| Trend, high IVrank | Debit spread (buy ITM / sell OTM) | Cuts vega & theta drag |
| Revert, high IVrank | Credit spread / sell rich side | Time decay works in favour |
| Weak / uncertain | No trade | Cost not covered by edge |

**Expected edge vs cost (hard gate)** — expected directional P&L of the structure over
expected hold must clear total frictions:

$$\mathbb E[\text{edge}]_i = |\alpha_i|\cdot \hat\sigma^{S}_i \cdot \sqrt{H}\cdot |\delta_{\text{struct}}|$$

$$\mathrm{Cost}_i = \tfrac12\,\text{spread} + \Theta_{\text{struct}}\,H + \text{STT} + \text{slippage}$$

$$\boxed{\ \text{trade only if}\quad \mathbb E[\text{edge}]_i \;>\; k_{\text{cost}}\cdot \mathrm{Cost}_i\ }$$

---

## 8. Entry Rules

**Thrust (acceleration)** of conviction:

$$\dot\alpha_{i,t} = \alpha_{i,t} - \alpha_{i,t-1}$$

**Adaptive entry gate** — a live quantile of today's own alpha distribution (self-throttles
with breadth, $p$ tightens as more names fire):

$$G_t = Q_p\big(|\alpha|\ \text{over trailing window}\big)$$

**Entry condition (trend regime):**

$$|\alpha_i| > G_t \ \ \text{and}\ \ \dot\alpha_i \ \text{agrees in sign with}\ \alpha_i
\ \ \text{and}\ \ \mathrm{Regime}_i > 0$$

Prefer fills on a retrace toward anchored VWAP ($\mathrm{VWAPz}_i \to 0$) while $|\alpha_i|>G_t$
holds; stagger entries across correlated names.

---

## 9. Exit & Risk Management

| Control | Rule | Formula |
|---------|------|---------|
| Volatility stop | Adverse excursion beyond vol band | exit if $\text{MAE}_i > k\,\hat\sigma^{S}_i\sqrt{H}$ |
| Signal-decay | Conviction faded | exit if $\alpha_{i,t} < \beta_d\,\alpha_{i,\text{entry}}$ |
| Regime-flip | Trend died | exit if $\mathrm{sgn}(\mathrm{Regime}_i)$ flips against position |
| Reversal (CUSUM) | Statistical change-point | see below |
| Time stop | Held past persistence | exit if $\text{hold} > m\,\tau_{1/2}$ |
| Profit scaling | Lock gains | trim at R-multiples of the vol stop |
| Per-trade cap | Bounded loss | risk $\le \kappa\cdot$ equity per name |
| Daily kill-switch | Survival | halt all trading if daily P&L $\le -L_{\max}$ |

**CUSUM reversal detector** on the standardised momentum series (drift $\nu$, control
limit $H_t$ scaling with noise):

$$g^{+}_t = \max\!\big(0,\ g^{+}_{t-1} + (M_t - \nu)\big), \qquad
g^{-}_t = \min\!\big(0,\ g^{-}_{t-1} + (M_t + \nu)\big)$$

$$\text{reversal if } g^{+}_t > H_t \ \text{or}\ g^{-}_t < -H_t, \qquad H_t = c\,\hat\sigma_{M,t}$$

**Signal half-life** $\tau_{1/2}$ from the AR(1) decay of the conviction series
($\phi$ = autocorrelation):

$$\tau_{1/2} = \frac{\ln 2}{-\ln \phi}$$

---

## 10. Position Sizing & Capital

**Volatility-targeted size** (constant risk per trade in vol units):

$$q_i = \frac{R_{\text{trade}}\cdot |\alpha_i|}{\hat\sigma^{S}_i \cdot k_{\text{stop}}}$$

**Fractional-Kelly book scaler** (expand when winning, contract otherwise; capped well
below full Kelly):

$$f = \mathrm{clip}\!\left(\frac{\hat\mu_{\text{edge}}}{\hat\sigma^2_{\text{edge}}},\ 0,\ f_{\max}\right)$$

**Constraints:** net beta $\approx 0$; gross $\le \mathrm{GrossCap}$; per-sector $\le c_{\text{sector}}$.

---

## 11. Parameter Policy

| Element | Mode | Reason |
|---------|------|--------|
| Lookback / half-life $h_t$ | Dynamic | Market speed varies intraday |
| Signal weights $w_j$ | Dynamic (rolling IC) | Emphasise predictive signals |
| Normalisation | Dynamic (robust z, cross-sectional) | Outlier & beta robust |
| Entry gate $G_t$ | Dynamic (live quantile) | Self-throttle with breadth |
| Stops / time-stops | Dynamic (vol / half-life) | Self-scale across names & regimes |
| Per-trade risk $\kappa$ | Fixed | Risk discipline must not drift |
| Daily kill-switch $L_{\max}$ | Fixed | Survival rule |
| Net-beta target ($\approx 0$) | Fixed | Structural identity of the book |
| Cost gate $k_{\text{cost}}$ | Fixed | Guardrail, not an optimisation knob |

---

## 12. Validation Protocol

1. **Walk-forward** — calibrate on past, evaluate on untouched forward data, roll.
2. **Cost-honest backtest** — charge full spread, slippage, STT, theta.
3. **Per-regime expectancy** — report edge separately for trend, revert, flat.
4. **IC & decay monitoring** — track $\mathrm{corr}(\alpha, e^{\text{fwd}})$; retire signals as IC fades.
5. **Capacity testing** — confirm sizing respects single-stock option liquidity.
6. **Paper / micro-live** — validate live microstructure before scaling.

---

## 13. Daily Operating Sequence

1. **09:15** — reset state; anchor VWAP; seed $\beta$, $\hat\sigma$, $\sigma_{\text{ref}}$.
2. **Per cycle $\Delta t$** — update signals $s^{(1)}\!\dots s^{(5)}$ → compute $\alpha_i$ →
   classify $\mathrm{Regime}_i$ → rank universe → build beta-neutral book → select expression →
   manage entries/exits → enforce caps and kill-switch.
3. **Continuous** — monitor gross/sector exposure, CUSUM reversals, IC decay.
4. **15:30** — flatten; log fills and per-signal performance for validation.

---

## Appendix A — Symbol Glossary

| Symbol | Meaning |
|--------|---------|
| $r_t$ | Log return over one bar |
| $e_{i,t}$ | Idiosyncratic (beta-removed) return of stock $i$ |
| $\beta^m,\beta^s$ | Market / sector beta |
| $\hat\sigma$ | EWMA volatility estimate |
| $\alpha_i$ | Composite directional conviction, $[-1,+1]$ |
| $s^{(j)}$ | Standardised signal $j$ |
| $w_j$ | Skill weight of signal $j$ (rolling IC) |
| $\rho_k$ | Delta-residual premium change of option $k$ |
| $\delta_k$ | Option delta |
| $\Psi_i$ | Composite options order-flow |
| $\mathrm{Regime}_i$ | Trend ($>0$) vs revert ($<0$) score |
| $G_t$ | Adaptive entry gate (live quantile) |
| $\tau_{1/2}$ | Signal half-life |
| $H$ | Forward horizon / expected hold |
| $k_{\text{cost}}$ | Cost-gate multiple |
| $L_{\max}$ | Daily loss kill-switch |
