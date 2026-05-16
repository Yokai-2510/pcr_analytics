// indicators.js — Compute technical indicators from Signed PCR series
// All indicators are computed client-side for instant parameter changes.

/**
 * Build Signed PCR time series from OI summary rows.
 * Returns [{ timestamp, signedPcr, ceOi, peOi, ceDelta, peDelta }]
 */
export function buildSignedPcrSeries(summaryRows) {
  const series = [];
  for (let i = 0; i < summaryRows.length; i++) {
    const r = summaryRows[i];
    const prev = i > 0 ? summaryRows[i - 1] : null;
    if (!prev) {
      series.push({ timestamp: r.timestamp, signedPcr: null, ceOi: r.total_ce_oi, peOi: r.total_pe_oi, ceDelta: 0, peDelta: 0 });
      continue;
    }
    const cΔ = r.total_ce_oi - prev.total_ce_oi;
    const pΔ = r.total_pe_oi - prev.total_pe_oi;
    const absCe = Math.abs(cΔ);
    const absPe = Math.abs(pΔ);
    let signedPcr = null;
    if (absCe > 0) {
      const pcrMag = absPe / absCe;
      let sign;
      if ((pΔ >= 0 && cΔ >= 0) || (pΔ <= 0 && cΔ <= 0)) {
        sign = pcrMag > 1 ? 1 : -1;
      } else {
        sign = pΔ >= 0 ? 1 : -1;
      }
      signedPcr = sign * pcrMag;
    }
    series.push({ timestamp: r.timestamp, signedPcr, ceOi: r.total_ce_oi, peOi: r.total_pe_oi, ceDelta: cΔ, peDelta: pΔ });
  }
  return series;
}

// ── Utility ──────────────────────────────────────────────────────────

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] != null) { sum += values[j]; count++; }
    }
    out[i] = count === period ? sum / period : null;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let seedSum = 0, seedCount = 0;
  for (let i = 0; i < period && i < values.length; i++) {
    if (values[i] != null) { seedSum += values[i]; seedCount++; }
  }
  if (seedCount < period) return out;
  out[period - 1] = seedSum / period;
  for (let i = period; i < values.length; i++) {
    if (values[i] != null && out[i - 1] != null) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

function stddev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = [];
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] != null) slice.push(values[j]);
    }
    if (slice.length < period) continue;
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// ── Indicators ───────────────────────────────────────────────────────

/**
 * RSI — Relative Strength Index
 * Config: { period: 14 }
 * Returns array of { timestamp, value, signal }
 */
export function computeRSI(series, config = {}) {
  const period = config.period || 14;
  const values = series.map(d => d.signedPcr);
  const rsi = new Array(values.length).fill(null);

  // Compute gains and losses
  const gains = new Array(values.length).fill(0);
  const losses = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    if (values[i] != null && values[i - 1] != null) {
      const diff = values[i] - values[i - 1];
      if (diff > 0) gains[i] = diff;
      else losses[i] = Math.abs(diff);
    }
  }

  // First RSI uses simple average
  if (values.length > period) {
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    // Subsequent RSIs use smoothed average
    for (let i = period + 1; i < values.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
  }

  return series.map((d, i) => {
    const val = rsi[i];
    let signal = null;
    if (val != null) {
      if (val >= 70) signal = 'Overbought';
      else if (val <= 30) signal = 'Oversold';
      else signal = 'Neutral';
    }
    return { timestamp: d.timestamp, value: val, signal };
  });
}

/**
 * Z-Score — Standard deviations from rolling mean
 * Config: { period: 20 }
 */
export function computeZScore(series, config = {}) {
  const period = config.period || 20;
  const values = series.map(d => d.signedPcr);
  const ma = sma(values, period);
  const sd = stddev(values, period);

  return series.map((d, i) => {
    if (values[i] == null || ma[i] == null || sd[i] == null || sd[i] === 0) {
      return { timestamp: d.timestamp, value: null, signal: null };
    }
    const z = (values[i] - ma[i]) / sd[i];
    let signal = null;
    if (z >= 2) signal = 'Extreme High';
    else if (z >= 1) signal = 'High';
    else if (z <= -2) signal = 'Extreme Low';
    else if (z <= -1) signal = 'Low';
    else signal = 'Normal';
    return { timestamp: d.timestamp, value: z, signal };
  });
}

/**
 * SMA — Simple Moving Average of Signed PCR
 * Config: { period: 20 }
 */
export function computeSMA(series, config = {}) {
  const period = config.period || 20;
  const values = series.map(d => d.signedPcr);
  const result = sma(values, period);
  return series.map((d, i) => ({
    timestamp: d.timestamp, value: result[i], signal: null,
  }));
}

/**
 * EMA — Exponential Moving Average of Signed PCR
 * Config: { period: 20 }
 */
export function computeEMA(series, config = {}) {
  const period = config.period || 20;
  const values = series.map(d => d.signedPcr);
  const result = ema(values, period);
  return series.map((d, i) => ({
    timestamp: d.timestamp, value: result[i], signal: null,
  }));
}

/**
 * Bollinger Bands
 * Config: { period: 20, multiplier: 2 }
 * Returns { upper, middle, lower } arrays, each with { timestamp, value, signal }
 */
export function computeBollinger(series, config = {}) {
  const period = config.period || 20;
  const mult = config.multiplier || 2;
  const values = series.map(d => d.signedPcr);
  const ma = sma(values, period);
  const sd = stddev(values, period);

  const upper = series.map((d, i) => {
    if (ma[i] == null || sd[i] == null) return { timestamp: d.timestamp, value: null, signal: null };
    return { timestamp: d.timestamp, value: ma[i] + mult * sd[i], signal: null };
  });
  const middle = series.map((d, i) => ({
    timestamp: d.timestamp, value: ma[i], signal: null,
  }));
  const lower = series.map((d, i) => {
    if (ma[i] == null || sd[i] == null) return { timestamp: d.timestamp, value: null, signal: null };
    return { timestamp: d.timestamp, value: ma[i] - mult * sd[i], signal: null };
  });

  // Signal: where is current value relative to bands?
  const signals = series.map((d, i) => {
    if (values[i] == null || upper[i].value == null || lower[i].value == null) return null;
    if (values[i] >= upper[i].value) return 'Above Upper';
    if (values[i] <= lower[i].value) return 'Below Lower';
    return 'Inside Bands';
  });

  return { upper, middle, lower, signals };
}

/**
 * Standard Deviation Bands (wider than Bollinger)
 * Config: { period: 20, multiplier: 1 }
 */
export function computeStdDevBands(series, config = {}) {
  return computeBollinger(series, { period: config.period || 20, multiplier: config.multiplier || 1 });
}

// ── Indicator Registry ───────────────────────────────────────────────

export const INDICATOR_DEFS = [
  {
    id: 'rsi',
    name: 'RSI',
    description: 'Relative Strength Index on Signed PCR. Overbought >70, Oversold <30.',
    compute: computeRSI,
    configs: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 100, default: 14 },
    ],
    hasSignal: true,
    outputType: 'single', // single series
  },
  {
    id: 'zscore',
    name: 'Z-Score',
    description: 'Standard deviations from rolling mean. |Z|>2 is extreme.',
    compute: computeZScore,
    configs: [
      { key: 'period', label: 'Lookback', type: 'number', min: 2, max: 200, default: 20 },
    ],
    hasSignal: true,
    outputType: 'single',
  },
  {
    id: 'sma',
    name: 'SMA',
    description: 'Simple Moving Average of Signed PCR.',
    compute: computeSMA,
    configs: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 200, default: 20 },
    ],
    hasSignal: false,
    outputType: 'single',
  },
  {
    id: 'ema',
    name: 'EMA',
    description: 'Exponential Moving Average of Signed PCR. More responsive to recent changes.',
    compute: computeEMA,
    configs: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 200, default: 20 },
    ],
    hasSignal: false,
    outputType: 'single',
  },
  {
    id: 'bollinger',
    name: 'Bollinger Bands',
    description: 'Moving average ± N standard deviations. Breakouts indicate extreme moves.',
    compute: computeBollinger,
    configs: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 200, default: 20 },
      { key: 'multiplier', label: 'Std Dev Multiplier', type: 'number', min: 0.5, max: 5, step: 0.5, default: 2 },
    ],
    hasSignal: true,
    outputType: 'bands', // upper/middle/lower
  },
  {
    id: 'stddev_bands',
    name: 'σ Bands',
    description: 'Standard deviation bands (1σ default). Narrower than Bollinger for tighter signals.',
    compute: computeStdDevBands,
    configs: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 200, default: 20 },
      { key: 'multiplier', label: 'Std Dev Multiplier', type: 'number', min: 0.5, max: 5, step: 0.5, default: 1 },
    ],
    hasSignal: true,
    outputType: 'bands',
  },
];

/**
 * Compute all enabled indicators for a given series.
 * params: { rsi: { period: 14 }, zscore: { period: 20 }, ... }
 * Returns { rsi: [...], zscore: [...], ... }
 */
export function computeAll(series, params = {}) {
  const results = {};
  for (const def of INDICATOR_DEFS) {
    const cfg = params[def.id] || {};
    // Apply defaults
    const fullCfg = {};
    for (const c of def.configs) {
      fullCfg[c.key] = cfg[c.key] ?? c.default;
    }
    results[def.id] = def.compute(series, fullCfg);
  }
  return results;
}
