// pages/data.js — Snapshots data explorer (3-tab: OI Analytics / OI Logs / All Logs)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, fmtSigned, fmtPct, icon, Select, DateSelect } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let activeTab = 'oi-analytics'; // 'oi-analytics' | 'oi-logs' | 'all-logs'
let pollTimer = null;

// Per-tab instrument/date state so each tab remembers its own selection
const tabState = {
  'oi-analytics': { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'oi-logs':      { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'all-logs':     { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
};

const state = {
  page: 1,
  page_size: 100,
  sort: [{ column: 'timestamp', dir: 'desc' }],
};

// ── Helpers ────────────────────────────────────────────────────────────
async function fetchAvailableDates(instrument) {
  try {
    const res = await api.dataDistinct('date', `?instrument=${instrument}&limit=5000`);
    const dates = (res.values || []).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    if (!dates.includes(today)) dates.unshift(today);
    return dates.sort().reverse();
  } catch { return [new Date().toISOString().slice(0, 10)]; }
}

function resampleData(rows) {
  if (resampleInterval === 'raw') return rows;
  const ms = { '1min': 6e4, '5min': 3e5, '15min': 9e5, '30min': 18e5, '1hr': 36e5 }[resampleInterval];
  if (!ms) return rows;
  const buckets = new Map();
  rows.forEach(r => {
    const ts = r.timestamp || r.date;
    if (!ts) return;
    const key = Math.floor(new Date(ts).getTime() / ms) * ms;
    const existing = buckets.get(key);
    if (!existing) { buckets.set(key, { ...r, _c: 1 }); return; }
    Object.keys(r).forEach(k => {
      if (typeof r[k] === 'number' && typeof existing[k] === 'number')
        existing[k] = ((existing[k] * existing._c) + r[k]) / (existing._c + 1);
    });
    existing._c++;
  });
  return [...buckets.values()].map(({ _c, ...rest }) => rest);
}

function getActive() { return tabState[activeTab]; }

// ── Mount ──────────────────────────────────────────────────────────────
export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page data-page' });
  container.appendChild(page);

  // Load column catalog
  if (!columnsCatalog) {
    try {
      columnsCatalog = await api.dataColumns();
      selectedCols = [...(columnsCatalog.default_columns || ['timestamp', 'instrument', 'strike', 'pcr', 'underlying_spot_price'])];
    } catch (e) {
      page.appendChild(el('div', { class: 'empty-state' }, 'Failed to load column catalog.', el('span', { class: 'text-xs mono dim' }, e.message)));
      return;
    }
  }

  // ── Top-level Tab bar ──
  const tabBar = el('div', { class: 'tabs', style: { marginBottom: '12px' } });
  const tabs = [
    { id: 'oi-analytics', label: 'OI Analytics' },
    { id: 'oi-logs', label: 'OI Logs' },
    { id: 'all-logs', label: 'All Logs' },
  ];
  const tabEls = {};
  tabs.forEach(t => {
    const btn = el('button', {
      class: 'tab' + (activeTab === t.id ? ' active' : ''),
      onclick: () => switchTab(t.id),
    }, t.label);
    tabEls[t.id] = btn;
    tabBar.appendChild(btn);
  });
  page.appendChild(tabBar);

  // ── Shared refs for content panels ──
  const oiAnalyticsPanel = el('div', { class: 'tab-panel' });
  const oiLogsPanel = el('div', { class: 'tab-panel' });
  const allLogsPanel = el('div', { class: 'tab-panel' });

  page.appendChild(oiAnalyticsPanel);
  page.appendChild(oiLogsPanel);
  page.appendChild(allLogsPanel);

  // ── State ──
  let currentResult = null;
  let allRows = [];

  // ── Build a tab panel: toolbar (instrument+date) + content ──
  function buildTabToolbar(panel, tabId, extraControls) {
    const toolbar = el('div', { class: 'data-toolbar', style: { marginBottom: '8px' } });
    const controls = el('div', { class: 'data-controls' });

    const ts = tabState[tabId];

    const insSel = Select({
      options: ['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() })),
      value: ts.instrument,
      width: '130px',
      onChange: v => {
        ts.instrument = v;
        ts.date = new Date().toISOString().slice(0, 10);
        dateSelect.refresh(v);
        if (tabId === 'all-logs') { state.page = 1; runQuery(); }
        else if (tabId === 'oi-analytics') renderOiAnalytics();
        else if (tabId === 'oi-logs') renderOiLogs();
      },
    });

    const dateSelect = DateSelect({
      instrument: ts.instrument,
      apiDistinctFn: fetchAvailableDates,
      onChange: v => {
        ts.date = v;
        if (tabId === 'all-logs') { state.page = 1; runQuery(); }
        else if (tabId === 'oi-analytics') renderOiAnalytics();
        else if (tabId === 'oi-logs') renderOiLogs();
      },
      placeholder: 'All dates',
      width: '150px',
    });

    controls.append(
      el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Instrument'), insSel.el),
      el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Date'), dateSelect.el),
    );

    if (extraControls) extraControls(controls);

    toolbar.appendChild(controls);
    panel.appendChild(toolbar);
    return { insSel, dateSelect, toolbar };
  }

  // ── Tab switching ──
  function switchTab(tabId) {
    activeTab = tabId;
    Object.entries(tabEls).forEach(([id, btn]) => btn.classList.toggle('active', id === tabId));
    oiAnalyticsPanel.style.display = tabId === 'oi-analytics' ? '' : 'none';
    oiLogsPanel.style.display = tabId === 'oi-logs' ? '' : 'none';
    allLogsPanel.style.display = tabId === 'all-logs' ? '' : 'none';
    if (tabId === 'all-logs') renderBody();
    else if (tabId === 'oi-analytics') renderOiAnalytics();
    else if (tabId === 'oi-logs') renderOiLogs();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OI ANALYTICS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const oiAnalyticsContent = el('div');
  buildTabToolbar(oiAnalyticsPanel, 'oi-analytics');
  oiAnalyticsPanel.appendChild(oiAnalyticsContent);

  async function renderOiAnalytics() {
    oiAnalyticsContent.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
    const ts = tabState['oi-analytics'];
    if (!ts.instrument || !ts.date) {
      oiAnalyticsContent.innerHTML = '<div class="empty-state">Select a date to view OI Analytics.</div>';
      return;
    }
    try {
      const data = await _fetchOiData(ts.instrument, ts.date);
      if (!data) { oiAnalyticsContent.innerHTML = '<div class="empty-state">No OI data for this date.</div>'; return; }
      const { summaryRows, instData } = data;
      const baselines = instData?.baselines || {};
      const latest = summaryRows[summaryRows.length - 1];
      const pcr = latest.total_pe_oi && latest.total_ce_oi ? (latest.total_pe_oi / latest.total_ce_oi) : 0;
      const deltaPcr = instData?.delta_pcr ?? null;

      // ── Top summary strip ──
      const summaryStrip = el('div', { class: 'card', style: { display: 'flex', gap: '28px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '16px' } },
        el('div', {},
          el('span', { class: 'text-xs muted' }, 'PCR'),
          el('div', { class: `mono ${pcr >= 1 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '18px' } }, fmtNum(pcr, 3)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'ΔPCR'),
          el('div', { class: `mono ${deltaPcr != null ? (deltaPcr >= 1 ? 'bull' : 'bear') : ''}`, style: { fontWeight: '700', fontSize: '18px' } }, deltaPcr != null ? fmtNum(deltaPcr, 3) : '—'),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Ticks'),
          el('div', { class: 'mono', style: { fontWeight: '600' } }, String(summaryRows.length)),
        ),
      );

      // ── Two cards: CE and PE ──
      const ceCard = buildOiCard('CE', latest.total_ce_oi, baselines);
      const peCard = buildOiCard('PE', latest.total_pe_oi, baselines);
      const cardsRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } }, ceCard, peCard);

      oiAnalyticsContent.innerHTML = '';
      oiAnalyticsContent.appendChild(summaryStrip);
      oiAnalyticsContent.appendChild(cardsRow);
    } catch (e) {
      oiAnalyticsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OI LOGS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const oiLogsContent = el('div');
  buildTabToolbar(oiLogsPanel, 'oi-logs');
  oiLogsPanel.appendChild(oiLogsContent);

  async function renderOiLogs() {
    oiLogsContent.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
    const ts = tabState['oi-logs'];
    if (!ts.instrument || !ts.date) {
      oiLogsContent.innerHTML = '<div class="empty-state">Select a date to view OI Logs.</div>';
      return;
    }
    try {
      const data = await _fetchOiData(ts.instrument, ts.date);
      if (!data) { oiLogsContent.innerHTML = '<div class="empty-state">No OI data for this date.</div>'; return; }
      const { summaryRows, instData } = data;
      const baselines = instData?.baselines || {};
      // Reverse so latest timestamp is at top
      const rows = [...summaryRows].reverse();
      const latest = rows[0];
      const first = rows[rows.length - 1];
      const pc = baselines.prev_close || {};
      const baseCe = pc.ce_oi ?? first.total_ce_oi;
      const basePe = pc.pe_oi ?? first.total_pe_oi;

      // ── Quick summary cards ──
      const pcr = latest.total_pe_oi && latest.total_ce_oi ? (latest.total_pe_oi / latest.total_ce_oi) : 0;

      const miniSummary = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' } },
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Latest CE OI'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, fmtCompact(latest.total_ce_oi)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Latest PE OI'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, fmtCompact(latest.total_pe_oi)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'PCR'),
          el('div', { class: `mono ${pcr >= 1 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, fmtNum(pcr, 3)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Ticks'),
          el('div', { class: 'mono', style: { fontWeight: '600' } }, String(rows.length)),
        ),
      );

      // ── Time-series table (latest at top) ──
      const t = el('table', { class: 'data' });
      const cols = ['Time', 'CE OI', 'PE OI', 'PCR', 'ΔPCR', 'CE Δ', 'PE Δ'];
      const thead = el('thead');
      const hr = el('tr');
      cols.forEach(c => hr.appendChild(el('th', {}, c)));
      thead.appendChild(hr);
      t.appendChild(thead);

      const tbody = el('tbody');
      // Walk rows top-down (latest first), compute deltas against previous row (which is the next in the original sorted array)
      const origSorted = [...summaryRows]; // ascending
      const origIdx = (r) => origSorted.indexOf(r);

      rows.forEach((r, displayIdx) => {
        const oi = origIdx(r);
        const rowPcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const prevCe = oi > 0 ? origSorted[oi - 1].total_ce_oi : r.total_ce_oi;
        const prevPe = oi > 0 ? origSorted[oi - 1].total_pe_oi : r.total_pe_oi;
        const cΔ = r.total_ce_oi - prevCe;
        const pΔ = r.total_pe_oi - prevPe;
        const rowΔce = r.total_ce_oi - baseCe;
        const rowΔpe = r.total_pe_oi - basePe;
        const rowDeltaPcr = (rowΔce !== 0 && baseCe != null && basePe != null) ? (rowΔpe / rowΔce) : null;
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_ce_oi)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_pe_oi)));
        tr.appendChild(el('td', { class: `mono ${rowPcr >= 1 ? 'bull' : 'bear'}` }, fmtNum(rowPcr, 3)));
        tr.appendChild(el('td', { class: `mono ${rowDeltaPcr != null ? (rowDeltaPcr >= 1 ? 'bull' : 'bear') : ''}` }, rowDeltaPcr != null ? fmtNum(rowDeltaPcr, 3) : '—'));
        tr.appendChild(el('td', { class: `mono ${cΔ >= 0 ? 'bull' : 'bear'}` }, (cΔ >= 0 ? '+' : '') + fmtCompact(cΔ)));
        tr.appendChild(el('td', { class: `mono ${pΔ >= 0 ? 'bull' : 'bear'}` }, (pΔ >= 0 ? '+' : '') + fmtCompact(pΔ)));
        tbody.appendChild(tr);
      });
      t.appendChild(tbody);

      oiLogsContent.innerHTML = '';
      oiLogsContent.appendChild(miniSummary);
      oiLogsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      oiLogsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ALL LOGS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const allLogsContent = el('div');
  const allLogsTableWrap = el('div', { class: 'data-grid-wrap' });
  const allLogsTable = el('table', { class: 'data' });
  allLogsTableWrap.appendChild(allLogsTable);
  const allLogsPag = el('div', { class: 'data-pagination' });

  // Build toolbar with extra controls
  buildTabToolbar(allLogsPanel, 'all-logs', (controls) => {
    const resampleSel = Select({
      options: [
        { value: 'raw', label: 'Raw' },
        { value: '1min', label: '1m' },
        { value: '5min', label: '5m' },
        { value: '15min', label: '15m' },
        { value: '30min', label: '30m' },
        { value: '1hr', label: '1h' },
      ],
      value: resampleInterval,
      width: '90px',
      onChange: v => { resampleInterval = v; renderBody(); },
    });

    const searchInput = el('input', {
      type: 'search',
      placeholder: 'Search…',
      class: 'data-search',
      value: searchQuery,
    });
    searchInput.addEventListener('input', () => { searchQuery = searchInput.value; renderBody(); });

    const filterBtn = el('button', { class: 'btn ghost sm', onclick: () => openFilterDialog(f => { filters.push(f); rebuild(); }) }, icon('plus'), 'Filter');
    const colsBtn = el('button', { class: 'btn ghost sm', onclick: () => openColumnsDialog(() => rebuild()) }, 'Columns');
    const refreshBtn = el('button', { class: 'btn ghost sm', onclick: runQuery, title: 'Refresh' }, icon('refresh'));
    const exportBtn = el('button', { class: 'btn secondary sm', onclick: exportCSV }, 'Export CSV');

    controls.append(
      el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Interval'), resampleSel.el),
      searchInput,
      el('div', { class: 'data-sep' }),
      filterBtn, colsBtn, refreshBtn,
      el('div', { class: 'spacer' }),
      exportBtn,
    );
  });

  // Filter chips row
  const chipRow = el('div', { class: 'data-chips' });
  allLogsPanel.appendChild(chipRow);
  allLogsPanel.appendChild(allLogsContent);
  allLogsContent.appendChild(allLogsTableWrap);
  allLogsContent.appendChild(allLogsPag);

  // ── Table rendering (All Logs) ──
  function renderBody() {
    if (activeTab !== 'all-logs') return;
    const tbody = allLogsTable.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let rows = allRows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
    }
    rows = resampleData(rows);

    renderPag(currentResult, rows.length);

    rows.forEach(row => {
      const tr = el('tr');
      (currentResult?.columns || []).forEach(c => {
        const col = typeof c === 'string' ? c : c.id;
        let v = row[col];
        if (col === 'timestamp' && v) {
          tr.appendChild(el('td', { class: 'mono' }, fmtDateIST(v)));
          tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(v)));
          return;
        }
        if (v == null) v = '—';
        else if (typeof v === 'number') v = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4);
        tr.appendChild(el('td', {}, String(v)));
      });
      tbody.appendChild(tr);
    });
  }

  // ── Pagination ──
  function renderPag(res, filteredCount) {
    if (!res) { allLogsPag.innerHTML = ''; return; }
    const total = filteredCount ?? res.total;
    const from = (res.page - 1) * res.page_size + 1;
    const to = Math.min(res.total, res.page * res.page_size);

    allLogsPag.innerHTML = '';
    allLogsPag.appendChild(el('span', { class: 'dim' }, `${from}–${to} of ${res.total.toLocaleString()}`));
    if (total !== res.total) allLogsPag.appendChild(el('span', { class: 'dim text-xs' }, ` (${total} filtered)`));
    allLogsPag.appendChild(el('div', { class: 'spacer' }));

    allLogsPag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page <= 1,
      onclick: () => { state.page = 1; runQuery(); }, title: 'First page',
    }, '⟨⟨'));
    allLogsPag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page <= 1,
      onclick: () => { state.page = res.page - 1; runQuery(); },
    }, '⟨'));
    allLogsPag.appendChild(el('span', { class: 'mono text-sm' }, `${res.page} / ${res.pages}`));
    allLogsPag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page >= res.pages,
      onclick: () => { state.page = res.page + 1; runQuery(); },
    }, '⟩'));
    allLogsPag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page >= res.pages,
      onclick: () => { state.page = res.pages; runQuery(); }, title: 'Last page',
    }, '⟩⟩'));

    const sizeSel = el('select', { class: 'data-pagesize' },
      ...[50, 100, 200, 500].map(n => el('option', { value: n, selected: res.page_size === n }, `${n}/page`))
    );
    sizeSel.addEventListener('change', () => { state.page_size = Number(sizeSel.value); state.page = 1; runQuery(); });
    allLogsPag.appendChild(sizeSel);
  }

  // ── Rebuild chips + table ──
  function rebuild() { renderChips(); runQuery(); }

  function renderChips() {
    chipRow.innerHTML = '';
    filters.forEach((f, i) => {
      chipRow.appendChild(el('span', {
        class: 'chip removable',
        onclick: () => { filters.splice(i, 1); rebuild(); },
      }, `${f.column} ${f.op} ${JSON.stringify(f.value)}`, icon('close')));
    });
  }

  // ── Main query (All Logs) ──
  async function runQuery() {
    allLogsTable.innerHTML = '<tbody><tr><td colspan="20" class="dim">Loading…</td></tr></tbody>';
    const ts = tabState['all-logs'];
    const body = {
      instrument: ts.instrument,
      date: ts.date || undefined,
      columns: selectedCols,
      filters,
      sort: state.sort,
      page: state.page,
      page_size: state.page_size,
    };
    try {
      const res = await api.dataQuery(body);
      currentResult = res;
      allRows = res.rows || [];

      // Build header
      allLogsTable.innerHTML = '';
      const thead = el('thead');
      const headRow = el('tr');
      (res.columns || []).forEach(c => {
        const col = typeof c === 'string' ? c : c.id;
        const label = typeof c === 'string' ? c : (c.label || c.id);
        if (col === 'timestamp') {
          headRow.appendChild(el('th', { class: 'sortable', onclick: () => toggleSort('timestamp') }, 'Date'));
          headRow.appendChild(el('th', { class: 'sortable', onclick: () => toggleSort('timestamp') }, 'Time'));
        } else {
          headRow.appendChild(el('th', { class: 'sortable', onclick: () => toggleSort(col) }, label));
        }
      });
      thead.appendChild(headRow);
      allLogsTable.appendChild(thead);
      allLogsTable.appendChild(el('tbody'));

      renderChips();
      renderBody();
    } catch (e) {
      allLogsTable.innerHTML = '';
      allLogsTableWrap.innerHTML = `<div class="empty-state"><span class="bear">Query failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  function toggleSort(col) {
    const cur = state.sort[0];
    const dir = cur?.column === col && cur?.dir === 'asc' ? 'desc' : 'asc';
    state.sort = [{ column: col, dir }];
    runQuery();
  }

  // ── Shared: fetch + aggregate OI data ──
  async function _fetchOiData(instrument, date) {
    if (!instrument || !date) return null;
    const [oiData, dashData] = await Promise.all([
      api.totalOi(instrument, date),
      api.dashboard(60),
    ]);
    const rows = Array.isArray(oiData) ? oiData : (oiData.data || oiData.rows || []);
    if (!rows.length) return null;
    const timeMap = new Map();
    rows.forEach(r => {
      const ts = r.timestamp || r.time || r.date;
      if (!ts) return;
      const existing = timeMap.get(ts);
      if (existing) {
        existing.total_ce_oi += (r.total_ce_oi || r.ce_oi || 0);
        existing.total_pe_oi += (r.total_pe_oi || r.pe_oi || 0);
      } else {
        timeMap.set(ts, { timestamp: ts, total_ce_oi: r.total_ce_oi || r.ce_oi || 0, total_pe_oi: r.total_pe_oi || r.pe_oi || 0 });
      }
    });
    const summaryRows = [...timeMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const instData = (dashData.instruments || []).find(i => i.instrument === instrument);
    return { summaryRows, instData };
  }

  // ── Build a single OI card (CE or PE) with all baseline data inside ──
  function buildOiCard(type, currentOi, baselines) {
    const isCE = type === 'CE';
    const color = isCE ? 'var(--bull)' : 'var(--bear)';
    const emoji = isCE ? '📈' : '📉';
    const label = isCE ? 'Call OI (CE)' : 'Put OI (PE)';
    const oiKey = isCE ? 'ce_oi' : 'pe_oi';
    const chgKey = isCE ? 'ce_oi_change' : 'pe_oi_change';

    const pc = baselines.prev_close || {};
    const mo = baselines.market_open || {};
    const ps = baselines.post_settlement || {};

    const baseOi = pc[oiKey];
    const totalΔ = baseOi != null ? currentOi - baseOi : null;

    const blSection = (name, oiVal, Δval, timestamp) => {
      const rows = [];
      rows.push(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' } },
        el('div', {},
          el('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, name),
          timestamp ? el('div', { class: 'text-xs dim', style: { marginTop: '2px' } }, timestamp) : null,
        ),
        el('div', { style: { textAlign: 'right' } },
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '15px' } }, oiVal != null ? fmtCompact(oiVal) : '—'),
          Δval != null ? el('div', { class: `mono text-xs ${Δval >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } }, (Δval >= 0 ? '+' : '') + fmtCompact(Δval)) : null,
        ),
      ));
      return rows;
    };

    const pcΔ = null;
    const moΔ = mo[chgKey] ?? null;
    const psΔ = ps[chgKey] ?? null;

    return el('div', { class: 'card oi-card', style: { padding: '20px' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', paddingBottom: '14px', borderBottom: '2px solid var(--border)' } },
        el('div', { style: { fontSize: '16px', fontWeight: '700', color } }, `${emoji}  ${label}`),
        el('div', { style: { textAlign: 'right' } },
          el('div', { class: 'dim text-xs', style: { marginBottom: '2px' } }, 'Current OI'),
          el('div', { class: 'mono', style: { fontWeight: '800', fontSize: '24px', color } }, fmtCompact(currentOi)),
        ),
      ),
      totalΔ != null ? el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', marginBottom: '16px' } },
        el('span', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Total Δ from Prev Close'),
        el('span', { class: `mono ${totalΔ >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, (totalΔ >= 0 ? '+' : '') + fmtCompact(totalΔ)),
      ) : null,
      el('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' } }, 'Baselines'),
      ...blSection('Previous Close', pc[oiKey], pcΔ, null),
      ...blSection('Market Open', mo[oiKey], moΔ, null),
      ...blSection('Post Settlement', ps[oiKey], psΔ, null),
    );
  }

  // ── Export CSV ──
  async function exportCSV() {
    if (!currentResult) return;
    toast('Exporting…', 'info');
    const rows = [];
    const cols = currentResult.columns || selectedCols;
    const ts = tabState['all-logs'];
    for (let p = 1; p <= (currentResult.pages || 1); p++) {
      const res = await api.dataQuery({
        instrument: ts.instrument, date: ts.date || undefined,
        columns: selectedCols, filters, sort: state.sort, page: p, page_size: 500,
      });
      (res.rows || []).forEach(r => {
        const row = {};
        cols.forEach(c => {
          const col = typeof c === 'string' ? c : c.id;
          if (col === 'timestamp') { row.date = fmtDateIST(r.timestamp); row.time = fmtTimeIST(r.timestamp); }
          else row[col] = r[col];
        });
        rows.push(row);
      });
    }
    const headers = cols.flatMap(c => (typeof c === 'string' ? c : c.id) === 'timestamp' ? ['date', 'time'] : [typeof c === 'string' ? c : c.id]);
    const csv = [headers.join(',')];
    rows.forEach(r => csv.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(',')));
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ts.instrument}-${ts.date || 'data'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${rows.length} rows`, 'success');
  }

  // ── Filter dialog ──
  function openFilterDialog(onAdd) {
    const cols = columnsCatalog?.columns || [];
    const colSel = el('select', {}, ...cols.map(c => el('option', { value: c.id }, c.label || c.id)));
    const opSel = el('select', {});
    const valInput = el('input', { type: 'text', placeholder: 'Value' });
    function refreshOps() {
      const c = cols.find(c => c.id === colSel.value);
      opSel.innerHTML = '';
      (c?.operators || ['eq']).forEach(o => opSel.appendChild(el('option', { value: o }, o)));
    }
    colSel.addEventListener('change', refreshOps);
    refreshOps();
    import('../components.js').then(({ modal }) => {
      const m = modal(el('div', {},
        el('h2', {}, 'Add filter'),
        el('div', { class: 'field' }, el('span', { class: 'label' }, 'Column'), colSel),
        el('div', { class: 'field' }, el('span', { class: 'label' }, 'Operator'), opSel),
        el('div', { class: 'field' }, el('span', { class: 'label' }, 'Value'), valInput),
        el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
          el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
          el('button', { class: 'btn primary', onclick: () => {
            let value = valInput.value;
            if (opSel.value === 'between' || opSel.value === 'in') value = value.split(',').map(s => isNaN(+s) ? s.trim() : Number(s));
            else if (!isNaN(+value) && value !== '') value = Number(value);
            onAdd({ column: colSel.value, op: opSel.value, value });
            m.close();
          } }, 'Add'))
      ));
    });
  }

  // ── Columns dialog ──
  function openColumnsDialog(onChange) {
    const cols = columnsCatalog?.columns || [];
    const groups = cols.reduce((acc, c) => { (acc[c.group || 'other'] = acc[c.group || 'other'] || []).push(c); return acc; }, {});
    const list = el('div', { style: { maxHeight: '60vh', overflowY: 'auto' } });
    for (const [g, items] of Object.entries(groups)) {
      list.appendChild(el('div', { class: 'group-head' }, g));
      items.forEach(c => {
        list.appendChild(el('label', { class: 'metric-row' },
          el('input', { type: 'checkbox', value: c.id, checked: selectedCols.includes(c.id) }),
          el('div', {}, el('strong', {}, c.label || c.id), el('span', { class: 'desc' }, c.type || ''))
        ));
      });
    }
    import('../components.js').then(({ modal }) => {
      const m = modal(el('div', {},
        el('h2', {}, 'Columns'),
        list,
        el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
          el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
          el('button', { class: 'btn primary', onclick: () => {
            selectedCols = [...list.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
            m.close();
            onChange();
          } }, 'Apply'))
      ));
    });
  }

  // ── Initial load ──
  switchTab(activeTab);
  pollTimer = setInterval(() => {
    if (activeTab === 'all-logs') runQuery();
    else if (activeTab === 'oi-analytics') renderOiAnalytics();
    else if (activeTab === 'oi-logs') renderOiLogs();
  }, 60000);
}

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
