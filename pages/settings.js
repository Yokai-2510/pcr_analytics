// pages/settings.js — sub-tabs at top, connection embedded in Credentials
import { el, toast, passwordInput, icon, WeekdayPicker, parseWeekdays, serializeWeekdays } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let subTab = 'config';

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  const subtabs = el('div', { class: 'subtabs' });
  ['config', 'credentials', 'scheduler', 'danger'].forEach(id => {
    subtabs.appendChild(el('button', { class: 'subtab' + (subTab === id ? ' active' : ''), onclick: () => { subTab = id; render(); } }, id[0].toUpperCase() + id.slice(1)));
  });
  page.appendChild(subtabs);

  const body = el('div', {});
  page.appendChild(body);

  async function render() {
    subtabs.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === subTab));
    body.innerHTML = '';
    if (subTab === 'config') await renderConfig(body);
    else if (subTab === 'credentials') await renderCredentials(body);
    else if (subTab === 'scheduler') await renderScheduler(body);
    else renderDanger(body);
  }

  await render();
}

export function unmount() {}

function renderConnectionCard() {
  const apiInput = el('input', { type: 'text', value: store.apiBase });
  const { wrap: tokWrap, input: tokInput } = passwordInput('adminToken');
  tokInput.value = store.adminToken;
  return el('div', { class: 'card settings-section' },
    el('h3', {}, 'Connection'),
    el('div', { class: 'kv-grid' },
      el('span', { class: 'label' }, 'API base URL'), apiInput,
      el('span', { class: 'label' }, 'Admin token'), tokWrap,
    ),
    el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
      el('button', { class: 'btn primary sm', onclick: async () => {
        store.apiBase = apiInput.value.replace(/\/+$/, '');
        store.adminToken = tokInput.value;
        toast('Saved', 'success');
        try {
          await api.status();
          toast('Connected', 'success');
          try { await api.credentials(); toast('Admin token verified', 'success'); }
          catch (e) { toast('Admin token failed', 'warn'); }
        } catch (e) { toast('Connection failed', 'error'); }
      } }, 'Save & Test')
    )
  );
}

// ---- Config ----
async function renderConfig(root) {
  let cfg;
  try { cfg = await api.config(); store.config = cfg; }
  catch (e) {
    root.appendChild(el('div', { class: 'empty-state' }, 'Could not load config.', el('span', { class: 'text-xs mono dim' }, e.message)));
    return;
  }

  function section(title, fields, onSave) {
    const card = el('div', { class: 'card settings-section' });
    card.appendChild(el('h3', {}, title));
    const grid = el('div', { class: 'kv-grid' });
    fields.forEach(f => { grid.appendChild(el('span', { class: 'label' }, f.label)); grid.appendChild(f.input); });
    card.appendChild(grid);
    card.appendChild(el('div', { class: 'row mt-12', style: { justifyContent: 'flex-end' } },
      el('button', { class: 'btn primary sm', onclick: onSave }, 'Save')
    ));
    return card;
  }

  const tzInput = el('input', { type: 'text', value: cfg.timezone || 'Asia/Kolkata' });
  const fetchInt = el('input', { type: 'number', min: '1', max: '3600', value: cfg.fetch_interval_seconds ?? 60 });
  const mStart = el('input', { type: 'text', placeholder: 'HH:MM', value: cfg.market_start_time || '09:15' });
  const mClose = el('input', { type: 'text', placeholder: 'HH:MM', value: cfg.market_close_time || '15:30' });
  root.appendChild(section('Timing', [
    { label: 'Timezone', input: tzInput },
    { label: 'Fetch interval (sec)', input: fetchInt },
    { label: 'Market start', input: mStart },
    { label: 'Market close', input: mClose },
  ], async () => {
    try { await api.patchConfig({ timezone: tzInput.value, fetch_interval_seconds: Number(fetchInt.value), market_start_time: mStart.value, market_close_time: mClose.value }); toast('Timing saved', 'success'); } catch (e) {}
  }));

  const apiHost = el('input', { type: 'text', value: cfg.api?.host || '0.0.0.0' });
  const apiPort = el('input', { type: 'number', value: cfg.api?.port ?? 8000, min: 1, max: 65535 });
  root.appendChild(section('API server', [
    { label: 'Host', input: apiHost },
    { label: 'Port', input: apiPort },
  ], async () => {
    try { await api.patchConfig({ api: { host: apiHost.value, port: Number(apiPort.value) } }); toast('API saved', 'success'); } catch (e) {}
  }));

  const httpTimeout = el('input', { type: 'number', value: cfg.http?.timeout_seconds ?? 30 });
  root.appendChild(section('HTTP', [{ label: 'Timeout (sec)', input: httpTimeout }], async () => {
    try { await api.patchConfig({ http: { timeout_seconds: Number(httpTimeout.value) } }); toast('HTTP saved', 'success'); } catch (e) {}
  }));

  const baseUrl = el('input', { type: 'text', value: cfg.upstox_base_url || '' });
  const tokenUrl = el('input', { type: 'text', value: cfg.upstox_token_url || '' });
  root.appendChild(section('Upstox URLs', [
    { label: 'Base URL', input: baseUrl },
    { label: 'Token URL', input: tokenUrl },
  ], async () => {
    try { await api.patchConfig({ upstox_base_url: baseUrl.value, upstox_token_url: tokenUrl.value }); toast('Upstox URLs saved', 'success'); } catch (e) {}
  }));

  const instCard = el('div', { class: 'card settings-section' });
  instCard.appendChild(el('h3', {}, 'Instruments'));
  const tbl = el('table', { class: 'data' });
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Name'), el('th', {}, 'Instrument key'), el('th', {}, 'Strike step'), el('th', {}, 'Strike count'), el('th', {}, '')
  )));
  const tbody = el('tbody');
  for (const [name, item] of Object.entries(cfg.instruments || {})) {
    const keyI = el('input', { type: 'text', value: item.instrument_key || '' });
    const stepI = el('input', { type: 'number', value: item.strike_step ?? 50 });
    const countI = el('input', { type: 'number', min: 0, max: 100, value: item.strike_count ?? 5 });
    const tr = el('tr');
    tr.appendChild(el('td', {}, name));
    tr.appendChild(el('td', {}, keyI));
    tr.appendChild(el('td', {}, stepI));
    tr.appendChild(el('td', {}, countI));
    tr.appendChild(el('td', {},
      el('button', { class: 'btn primary sm', onclick: async () => {
        try { await api.patchInstrument(name, { instrument_key: keyI.value, strike_step: Number(stepI.value), strike_count: Number(countI.value) }); toast(`${name} saved`, 'success'); } catch (e) {}
      } }, 'Save')
    ));
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  instCard.appendChild(tbl);
  root.appendChild(instCard);
}

// ---- Credentials (with embedded connection) ----
async function renderCredentials(root) {
  root.appendChild(renderConnectionCard());

  let creds;
  try { creds = await api.credentials(); store.credentials = creds; }
  catch (e) {
    root.appendChild(el('div', { class: 'card empty-state' }, 'Could not load credentials. Make sure your admin token is set.', el('span', { class: 'text-xs mono dim' }, e.message)));
    return;
  }

  const upstox = creds.upstox || {};
  const upCard = el('div', { class: 'card settings-section' });
  upCard.appendChild(el('h3', {}, 'Upstox credentials'));

  const groups = [
    { title: 'App keys', fields: [
      { name: 'api_key', secret: false },
      { name: 'api_secret', secret: true },
      { name: 'redirect_uri', secret: false },
    ]},
    { title: 'Auth tokens', fields: [
      { name: 'access_token', secret: true },
      { name: 'analytics_token', secret: true },
      { name: 'token', secret: true },
      { name: 'auth_code', secret: false },
      { name: 'code', secret: false },
    ]},
    { title: 'User + device', fields: [
      { name: 'mobile_no', secret: false },
      { name: 'pin', secret: true },
      { name: 'totp_key', secret: true },
    ]},
    { title: 'Network', fields: [
      { name: 'staticip1', secret: false },
      { name: 'staticip2', secret: false },
    ]},
  ];
  const allInputs = {};
  groups.forEach(g => {
    const gTitle = el('h4', { class: 'cred-group-title' }, g.title);
    const grid = el('div', { class: 'kv-grid' });
    g.fields.forEach(f => {
      grid.appendChild(el('span', { class: 'label' }, f.name));
      const preview = upstox[f.name]?.preview || '';
      const configured = upstox[f.name]?.configured;
      const placeholder = configured ? `••• ${preview}` : 'not configured';
      if (f.secret) {
        const { wrap, input } = passwordInput(f.name, placeholder);
        allInputs[f.name] = input;
        grid.appendChild(wrap);
      } else {
        const input = el('input', { type: 'text', placeholder });
        allInputs[f.name] = input;
        grid.appendChild(input);
      }
    });
    upCard.appendChild(gTitle);
    upCard.appendChild(grid);
  });
  upCard.appendChild(el('div', { class: 'row mt-12', style: { justifyContent: 'flex-end' } },
    el('button', { class: 'btn primary sm', onclick: async () => {
      const body = {};
      for (const [k, inp] of Object.entries(allInputs)) if (inp.value) body[k] = inp.value;
      if (!Object.keys(body).length) { toast('Nothing to save', 'warn'); return; }
      try { await api.patchUpstox(body); toast('Upstox saved', 'success'); for (const inp of Object.values(allInputs)) inp.value = ''; renderCredentials(root); } catch (e) {}
    } }, 'Save Upstox')
  ));
  root.appendChild(upCard);

  const admin = creds.admin?.api_key || {};
  const adminCard = el('div', { class: 'card settings-section' });
  adminCard.appendChild(el('h3', {}, 'Admin API key'));
  adminCard.appendChild(el('div', { class: 'muted text-sm mb-8' }, admin.configured ? `Configured · preview: ${admin.preview || '…'}` : 'Not configured'));
  const { wrap, input: newKey } = passwordInput('new_admin', 'min length 20');
  adminCard.appendChild(el('div', { class: 'kv-grid' }, el('span', { class: 'label' }, 'New key'), wrap));
  adminCard.appendChild(el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
    el('button', { class: 'btn secondary sm', onclick: async () => {
      if (!confirm('Rotate admin key now? Your current session will use the new key.')) return;
      try { const res = await api.rotateAdmin(); store.adminToken = res.api_key; toast('Rotated. localStorage updated.', 'success'); renderCredentials(root); } catch (e) {}
    } }, 'Rotate'),
    el('button', { class: 'btn primary sm', onclick: async () => {
      if (newKey.value.length < 20) { toast('Min 20 chars', 'warn'); return; }
      try { await api.patchAdmin({ api_key: newKey.value }); store.adminToken = newKey.value; toast('Admin key updated', 'success'); newKey.value = ''; renderCredentials(root); } catch (e) {}
    } }, 'Set key')
  ));
  root.appendChild(adminCard);
}

async function renderScheduler(root) {
  let cfg;
  try { cfg = await api.config(); } catch (e) { root.appendChild(el('div', { class: 'empty-state' }, 'Could not load.')); return; }
  const sch = cfg.schedule || {};
  const card = el('div', { class: 'card settings-section' });
  card.appendChild(el('h3', {}, 'Scheduler'));
  const weekdaysValue = parseWeekdays(sch.weekdays);
  const wkPicker = WeekdayPicker({ value: weekdaysValue });
  const daily = el('input', { type: 'text', placeholder: 'HH:MM', value: sch.daily_restart_time || '' });
  const wStart = el('input', { type: 'text', placeholder: 'HH:MM', value: sch.worker_start_time || '' });
  const wStop = el('input', { type: 'text', placeholder: 'HH:MM', value: sch.worker_stop_time || '' });
  const apiMode = el('input', { type: 'text', value: sch.api_mode || 'always', disabled: true });
  card.appendChild(el('div', { class: 'kv-grid' },
    el('span', { class: 'label' }, 'Weekdays'), wkPicker.el,
    el('span', { class: 'label' }, 'Daily restart'), daily,
    el('span', { class: 'label' }, 'Worker start'), wStart,
    el('span', { class: 'label' }, 'Worker stop'), wStop,
    el('span', { class: 'label' }, 'API mode'), apiMode,
  ));
  card.appendChild(el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
    el('button', { class: 'btn secondary sm', onclick: async () => {
      try { const r = await api.installScheduler(); toast('Scheduler installed', 'success'); card.appendChild(el('pre', { class: 'mono text-xs dim mt-12', style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(r, null, 2))); } catch (e) {}
    } }, 'Install / refresh systemd'),
    el('button', { class: 'btn primary sm', onclick: async () => {
      try { await api.patchConfig({ schedule: { weekdays: serializeWeekdays(wkPicker.getValue()), daily_restart_time: daily.value, worker_start_time: wStart.value, worker_stop_time: wStop.value } }); toast('Saved', 'success'); } catch (e) {}
    } }, 'Save'),
  ));
  root.appendChild(card);
}

function renderDanger(root) {
  const card = el('div', { class: 'card settings-section' });
  card.appendChild(el('h3', {}, 'Danger zone'));
  card.appendChild(el('div', { class: 'flex-col gap-12' },
    el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('div', {},
        el('div', { style: { fontWeight: '500' } }, 'Clear local settings'),
        el('div', { class: 'dim text-sm' }, 'Wipes localStorage and reloads the page.')),
      el('button', { class: 'btn danger sm', onclick: () => { localStorage.clear(); location.reload(); } }, 'Clear')
    ),
    el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('div', {},
        el('div', { style: { fontWeight: '500' } }, 'Reset config to defaults'),
        el('div', { class: 'dim text-sm' }, 'Sends a PATCH with built-in defaults.')),
      el('button', { class: 'btn danger sm', onclick: async () => {
        if (!confirm('Reset all config to defaults?')) return;
        try { await api.patchConfig({ timezone: 'Asia/Kolkata', fetch_interval_seconds: 60, market_start_time: '09:15', market_close_time: '15:30' }); toast('Defaults applied', 'success'); } catch (e) {}
      } }, 'Reset')
    ),
  ));
  root.appendChild(card);
}
