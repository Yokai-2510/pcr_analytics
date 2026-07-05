// api.js — typed helpers around the backend
import { store } from './store.js';
import { toast } from './components.js';

const DEFAULT_TIMEOUT = 30000; // 30s — whole-day analytics endpoints (entry
                               // signals, dashboard) legitimately grow with the
                               // session's 5s-tick count toward late afternoon.
const AUTH_TIMEOUT = 10000;    // 10s for auth

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s — backend may be down`);
    }
    throw err;
  }
}

export async function fetchJson(path, opts = {}) {
  const url = `${store.apiBase.replace(/\/+$/, '')}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (store.adminToken) headers['X-Admin-Token'] = store.adminToken;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const isAuth = path.includes('/auth/') || path.includes('/login');
  const timeout = isAuth ? AUTH_TIMEOUT : (opts.timeoutMs || DEFAULT_TIMEOUT);

  let res;
  try {
    res = await fetchWithTimeout(url, { ...opts, headers }, timeout);
  } catch (err) {
    store.connected = false;
    throw new Error(err.message || `Network error`);
  }
  if (!res.ok) {
    const text = await res.text();
    const msg = `HTTP ${res.status}: ${text || res.statusText}`;
    if (opts.silent !== true) toast(msg, 'error');
    throw new Error(msg);
  }
  return res.json();
}

// ---- typed helpers
export const api = {
  status: () => fetchJson('/api/status'),
  exchangeStatus: (ex) => fetchJson(`/api/exchange-status/${ex}`),
  dashboard: (sparkPoints = 60, date) => fetchJson(`/api/dashboard/summary?spark_points=${sparkPoints}${date ? `&date=${date}` : ''}`),
  snapshots: (ins, params = '') => fetchJson(`/api/snapshots/${ins}${params}`),
  pcr: (ins) => fetchJson(`/api/pcr/${ins}`),
  totalOi: (ins, date) => fetchJson(`/api/total-oi/${ins}${date ? `?date=${date}` : ''}`),
  totalVolume: (ins, date) => fetchJson(`/api/total-volume/${ins}${date ? `?date=${date}` : ''}`),
  optionChain: (ins, date) => fetchJson(`/api/option-chain/${ins}${date ? `?date=${date}` : ''}`),
  optionVolume: (ins, date) => fetchJson(`/api/option-volume/${ins}${date ? `?date=${date}` : ''}`),
  ltpStrength: (ins, date) => fetchJson(`/api/ltp-strength/${ins}${date ? `?date=${date}` : ''}`),
  ltpStrengthSnapshot: (ins, date) => fetchJson(`/api/ltp-strength-snapshot/${ins}${date ? `?date=${date}` : ''}`),
  srHistory: (ins, date) => fetchJson(`/api/sr-history/${ins}${date ? `?date=${date}` : ''}`),
  oiChange: (ins) => fetchJson(`/api/oi-change/${ins}`),
  history: (ins = '') => fetchJson(ins ? `/api/history/${ins}` : '/api/history'),

  chartMetrics: () => fetchJson('/api/chart/metrics'),
  chartPresets: () => fetchJson('/api/chart/presets'),
  chartTypes: () => fetchJson('/api/chart/types'),
  chartContext: (ins) => fetchJson(`/api/chart/context/${ins}`),
  chartData: (body) => fetchJson('/api/chart-data', { method: 'POST', body: JSON.stringify(body) }),

  listCharts: () => fetchJson('/api/charts'),
  createChart: (body) => fetchJson('/api/charts', { method: 'POST', body: JSON.stringify(body) }),
  updateChart: (id, body) => fetchJson(`/api/charts/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteChart: (id) => fetchJson(`/api/charts/${id}`, { method: 'DELETE' }),

  computedTicks: (ins, date) => fetchJson(`/api/computed-ticks/${ins}${date ? `?date=${date}` : ''}`),
  dataColumns: () => fetchJson('/api/data/columns'),
  dataDistinct: (col, qs = '') => fetchJson(`/api/data/distinct/${col}${qs}`),
  dataQuery: (body) => fetchJson('/api/data/query', { method: 'POST', body: JSON.stringify(body) }),

  events: (limit = 100, level = '') => fetchJson(`/api/events/recent?limit=${limit}${level ? `&level=${level}` : ''}`),

  config: () => fetchJson('/api/config'),
  configSchema: () => fetchJson('/api/config/schema'),
  patchConfig: (body) => fetchJson('/api/config', { method: 'PATCH', body: JSON.stringify(body) }),
  patchInstrument: (ins, body) => fetchJson(`/api/config/${ins}`, { method: 'PATCH', body: JSON.stringify(body) }),

  credentials: () => fetchJson('/api/credentials'),
  credentialsReveal: () => fetchJson('/api/credentials/reveal'),
  testUpstox: () => fetchJson('/api/upstox/test', { method: 'POST', silent: true }),
  refreshUpstoxToken: () => fetchJson('/api/upstox/refresh-token', { method: 'POST', silent: true, timeoutMs: 120000 }),

  // ---- Trade subsystem (paper trading) ----
  getTradeConfig: () => fetchJson('/api/trade/config'),
  putTradeConfig: (config) => fetchJson('/api/trade/config', {
    method: 'PUT', body: JSON.stringify({ config }),
  }),
  tradePositions: (params = '') => fetchJson(`/api/trade/positions${params}`),
  tradeOrders: (date) => fetchJson(`/api/trade/orders${date ? `?date=${date}` : ''}`),
  tradeSummary: (date) => fetchJson(`/api/trade/summary${date ? `?date=${date}` : ''}`),
  tradeManualExit: (positionId) => fetchJson(`/api/trade/positions/${positionId}/exit`, { method: 'POST' }),
  tradeReportDates: () => fetchJson('/api/trade/reports'),
  tradeReport: (date) => fetchJson(`/api/trade/reports/${date}`),
  patchUpstox: (body) => fetchJson('/api/credentials/upstox', { method: 'PATCH', body: JSON.stringify(body) }),
  patchAdmin: (body) => fetchJson('/api/credentials/admin', { method: 'PATCH', body: JSON.stringify(body) }),
  rotateAdmin: () => fetchJson('/api/credentials/admin/rotate', { method: 'POST' }),
  installScheduler: () => fetchJson('/api/admin/scheduler/install', { method: 'POST' }),

  // ---- auth + persisted user prefs (new endpoints) ----
  login: (username, password) => fetchJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    silent: true,
  }),
  verifyAuth: () => fetchJson('/api/auth/verify', { silent: true }),
  preferences: () => fetchJson('/api/preferences'),
  putPreferences: (body) => fetchJson('/api/preferences', { method: 'PUT', body: JSON.stringify(body) }),
};
