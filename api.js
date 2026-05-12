// api.js — typed helpers around the backend
import { store } from './store.js';
import { toast } from './components.js';

export async function fetchJson(path, opts = {}) {
  const url = `${store.apiBase.replace(/\/+$/, '')}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (store.adminToken) headers['X-Admin-Token'] = store.adminToken;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (err) {
    store.connected = false;
    throw new Error(`Network error: ${err.message}`);
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
  dashboard: (sparkPoints = 60) => fetchJson(`/api/dashboard/summary?spark_points=${sparkPoints}`),
  snapshots: (ins, params = '') => fetchJson(`/api/snapshots/${ins}${params}`),
  pcr: (ins) => fetchJson(`/api/pcr/${ins}`),
  totalOi: (ins, date) => fetchJson(`/api/total-oi/${ins}${date ? `?date=${date}` : ''}`),
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

  dataColumns: () => fetchJson('/api/data/columns'),
  dataDistinct: (col, qs = '') => fetchJson(`/api/data/distinct/${col}${qs}`),
  dataQuery: (body) => fetchJson('/api/data/query', { method: 'POST', body: JSON.stringify(body) }),

  events: (limit = 100, level = '') => fetchJson(`/api/events/recent?limit=${limit}${level ? `&level=${level}` : ''}`),

  config: () => fetchJson('/api/config'),
  configSchema: () => fetchJson('/api/config/schema'),
  patchConfig: (body) => fetchJson('/api/config', { method: 'PATCH', body: JSON.stringify(body) }),
  patchInstrument: (ins, body) => fetchJson(`/api/config/${ins}`, { method: 'PATCH', body: JSON.stringify(body) }),

  credentials: () => fetchJson('/api/credentials'),
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
