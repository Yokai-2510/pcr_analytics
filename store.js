// store.js — minimal reactive store
const subs = new Set();

const initial = {
  apiBase: localStorage.getItem('apiBase') || 'https://pcr-analytics.duckdns.org',
  adminToken: localStorage.getItem('adminToken') || '',
  isLoggedIn: !!localStorage.getItem('adminToken'),
  connected: false,
  status: null,
  marketState: null,
  dashboard: null,
  chartCatalog: null,
  chartPresets: null,
  chartTypes: null,
  savedCharts: [],
  columns: null,
  events: null,
  config: null,
  configSchema: null,
  credentials: null,
  currentPage: location.hash.replace('#', '') || 'dashboard',
  preferences: null,
};

export const store = new Proxy(initial, {
  set(target, key, value) {
    target[key] = value;
    if (key === 'apiBase') localStorage.setItem('apiBase', value);
    if (key === 'adminToken') {
      localStorage.setItem('adminToken', value);
      target.isLoggedIn = !!value;
    }
    subs.forEach(fn => { try { fn(key, value); } catch (e) { console.error(e); } });
    return true;
  }
});

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
