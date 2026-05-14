// pages/data.js — Snapshots data explorer (3-tab: All Logs / OI Analytics / OI Logs)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, fmtSigned, fmtPct, icon, Select, DateSelect } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let activeTab = 'all-logs'; // 'all-logs' | 'oi-analytics' | 'oi-logs'

const state = {
  instrument: 'nifty',
  date: new Date().toISOString().slice(0, 10),
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

  // ── Toolbar ──
  const toolbar = el('div', { class: 'data-toolbar' });
  const controls = el('div', { class: 'data-controls' });

  const insSel = Select({
    options: ['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() })),
    value: state.instrument,
    width: '130px',
    onChange: v => { state.instrument = v; state.page = 1; dateSelect.refresh(v); runQuery(); },
  });

  const dateSelect = DateSelect({
    instrument: state.instrument,
    apiDistinctFn: fetchAvailableDates,
    onChange: v => { state.date = v; state.page = 1; runQuery(); },
    placeholder: 'All dates',
    width: '150px',
  });

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
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Instrument'), insSel.el),
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Date'), dateSelect.el),
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Interval'), resampleSel.el),
    searchInput,
    el('div', { class: 'data-sep' }),
    filterBtn, colsBtn, refreshBtn,
    el('div', { class: 'spacer' }),
    exportBtn,
  );
  toolbar.appendChild(controls);

  // ── Tab bar ──
  const tabBar = el('div', { class: 'subtabs', style: { marginBottom: '0' } });
  const tabs = [
    { id: 'all-logs', label: 'All Logs' },
    { id: 'oi-analytics', label: 'OI Analytics' },
    { id: 'oi-logs', label: 'OI Logs' },
  ];
  const tabEls = {};
  tabs.forEach(t => {
    const btn = el('button', {
      class: 'subtab' + (activeTab === t.id ? ' active' : ''),
      onclick: () => switchTab(t.id),
    }, t.label);
    tabEls[t.id] = btn;
    tabBar.appendChild(btn);
  });
  toolbar.appendChild(tabBar);

  // Row 2: filter chips
  const chipRow = el('div', { class: 'data-chips' });
  toolbar.appendChild(chipRow);

  page.appendChild(toolbar);

  // ── Content areas ──
  const tableWrap = el('div', { class: 'data-grid-wrap' });
  const table = el('table', { class: 'data' });
  tableWrap.appendChild(table);
  page.appendChild(tableWrap);

  const oiAnalyticsWrap = el('div', { class: 'oi-analytics-panel', style: { display: 'none' } });
  page.appendChild(oiAnalyticsWrap);

  const oiLogsWrap = el('div', { class: 'oi-logs-panel', style: { display: 'none' } });
  page.appendChild(oiLogsWrap);

  // ── Pagination ──
  const pag = el('div', { class: 'data-pagination' });
  page.appendChild(pag);

  // ── State ──
  let currentResult = null;
  let allRows = [];

  // ── Tab switching ──
  function switchTab(tabId) {
    activeTab = tabId;
    Object.entries(tabEls).forEach(([id, btn]) => btn.classList.toggle('active', id === tabId));
    // Hide all
    tableWrap.style.display = 'none';
    oiAnalyticsWrap.style.display = 'none';
    oiLogsWrap.style.display = 'none';
    pag.style.display = 'none';
    // Show selected
    if (tabId === 'all-logs') {
      tableWrap.style.display = '';
      pag.style.display = '';
      renderBody();
    } else if (tabId === 'oi-analytics') {
      oiAnalyticsWrap.style.display = '';
      renderOiAnalytics();
    } else if (tabId === 'oi-logs') {
      oiLogsWrap.style.display = '';
      renderOiLogs();
    }
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

  // ── Table rendering (All Logs) ──
  function renderBody() {
    if (activeTab !== 'all-logs') return;
    const tbody = table.querySelector('tbody');
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
    if (!res) { pag.innerHTML = ''; return; }
    const total = filteredCount ?? res.total;
    const from = (res.page - 1) * res.page_size + 1;
    const to = Math.min(res.total, res.page * res.page_size);

    pag.innerHTML = '';
    pag.appendChild(el('span', { class: 'dim' }, `${from}–${to} of ${res.total.toLocaleString()}`));
    if (total !== res.total) pag.appendChild(el('span', { class: 'dim text-xs' }, ` (${total} filtered)`));
    pag.appendChild(el('div', { class: 'spacer' }));

    pag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page <= 1,
      onclick: () => { state.page = 1; runQuery(); }, title: 'First page',
    }, '⟨⟨'));
    pag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page <= 1,
      onclick: () => { state.page = res.page - 1; runQuery(); },
    }, '⟨'));
    pag.appendChild(el('span', { class: 'mono text-sm' }, `${res.page} / ${res.pages}`));
    pag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page >= res.pages,
      onclick: () => { state.page = res.page + 1; runQuery(); },
    }, '⟩'));
    pag.appendChild(el('button', {
      class: 'btn ghost sm', disabled: res.page >= res.pages,
      onclick: () => { state.page = res.pages; runQuery(); }, title: 'Last page',
    }, '⟩⟩'));

    const sizeSel = el('select', { class: 'data-pagesize' },
      ...[50, 100, 200, 500].map(n => el('option', { value: n, selected: res.page_size === n }, `${n}/page`))
    );
    sizeSel.addEventListener('change', () => { state.page_size = Number(sizeSel.value); state.page = 1; runQuery(); });
    pag.appendChild(sizeSel);
  }

  // ── Main query ──
  async function runQuery() {
    table.innerHTML = '<tbody><tr><td colspan="20" class="dim">Loading…</td></tr></tbody>';
    const body = {
      instrument: state.instrument,
      date: state.date || undefined,
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
      table.innerHTML = '';
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
      table.appendChild(thead);
      table.appendChild(el('tbody'));

      renderChips();
      renderBody();
    } catch (e) {
      table.innerHTML = '';
      tableWrap.innerHTML = `<div class="empty-state"><span class="bear">Query failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  function toggleSort(col) {
    const cur = state.sort[0];
    const dir = cur?.column === col && cur?.dir === 'asc' ? 'desc' : 'asc';
    state.sort = [{ column: col, dir }];
    runQuery();
  }

  // ── Shared: fetch + aggregate OI data ──
  async function _fetchOiData() {
    const instrument = state.instrument;
    const date = state.date;
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

  // ── Baseline row helper ──
  function baselineRow(label, ce, pe, ceChg, peChg) {
    return el('tr',
      el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, label),
      el('td', { class: 'mono' }, ce != null ? fmtCompact(ce) : '—'),
      el('td', { class: 'mono' }, pe != null ? fmtCompact(pe) : '—'),
      el('td', { class: `mono ${(ceChg ?? 0) >= 0 ? 'bull' : 'bear'}` },
        ceChg != null ? ((ceChg >= 0 ? '+' : '') + fmtCompact(ceChg)) : '—'),
      el('td', { class: `mono ${(peChg ?? 0) >= 0 ? 'bull' : 'bear'}` },
        peChg != null ? ((peChg >= 0 ? '+' : '') + fmtCompact(peChg)) : '—'),
    );
  }

  // ── OI Analytics (cards + baseline table + summary) ──
  async function renderOiAnalytics() {
    oiAnalyticsWrap.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
    if (!state.instrument || !state.date) {
      oiAnalyticsWrap.innerHTML = '<div class="empty-state">Select a date to view OI Analytics.</div>';
      return;
    }
    try {
      const data = await _fetchOiData();
      if (!data) { oiAnalyticsWrap.innerHTML = '<div class="empty-state">No OI data for this date.</div>'; return; }
      const { summaryRows, instData } = data;
      const baselines = instData?.baselines || {};
      const latest = summaryRows[summaryRows.length - 1];
      const first = summaryRows[0];
      const pcr = latest.total_pe_oi && latest.total_ce_oi ? (latest.total_pe_oi / latest.total_ce_oi) : 0;
      const deltaPcr = instData?.delta_pcr ?? null;
      const pc = baselines.prev_close || {};
      const mo = baselines.market_open || {};
      const ps = baselines.post_settlement || {};

      // ── Summary bar ──
      const summaryBar = el('div', { class: 'card', style: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '16px' } },
        el('div', {},
          el('span', { class: 'text-xs muted' }, 'PCR'),
          el('div', { class: `mono ${pcr >= 1 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '18px' } }, fmtNum(pcr, 3)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'ΔPCR (OI Change)'),
          el('div', { class: `mono ${deltaPcr != null ? (deltaPcr >= 1 ? 'bull' : 'bear') : ''}`, style: { fontWeight: '700', fontSize: '18px' } }, deltaPcr != null ? fmtNum(deltaPcr, 3) : '—'),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Total CE OI'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '18px' } }, fmtCompact(latest.total_ce_oi)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Total PE OI'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '18px' } }, fmtCompact(latest.total_pe_oi)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Ticks'),
          el('div', { class: 'mono', style: { fontWeight: '600' } }, String(summaryRows.length)),
        ),
      );

      // ── CE Card (full detail) ──
      const ceCard = el('div', { class: 'card oi-card', style: { padding: '20px' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
          el('div', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--bull)' } }, '📈  Call OI (CE)'),
          el('div', { class: 'mono', style: { fontWeight: '800', fontSize: '22px' } }, fmtCompact(latest.total_ce_oi)),
        ),
        // Baseline comparison table
        el('table', { class: 'data', style: { marginTop: '0' } },
          el('thead', el('tr',
            el('th', {}, 'Baseline'),
            el('th', {}, 'CE OI'),
            el('th', {}, 'Δ CE OI'),
          )),
          el('tbody',
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Previous Close'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, pc.ce_oi != null ? fmtCompact(pc.ce_oi) : '—'),
              el('td', { class: 'dim' }, '—'),
            ),
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Market Open'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, mo.ce_oi != null ? fmtCompact(mo.ce_oi) : '—'),
              el('td', { class: `mono ${(mo.ce_oi_change ?? 0) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } },
                mo.ce_oi_change != null ? ((mo.ce_oi_change >= 0 ? '+' : '') + fmtCompact(mo.ce_oi_change)) : '—'),
            ),
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Post Settlement'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, ps.ce_oi != null ? fmtCompact(ps.ce_oi) : '—'),
              el('td', { class: `mono ${(ps.ce_oi_change ?? 0) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } },
                ps.ce_oi_change != null ? ((ps.ce_oi_change >= 0 ? '+' : '') + fmtCompact(ps.ce_oi_change)) : '—'),
            ),
          ),
        ),
        // Current vs baselines
        el('div', { style: { marginTop: '14px', padding: '10px 12px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' } },
          el('div', { class: 'text-xs muted', style: { marginBottom: '6px' } }, 'Current vs Previous Close'),
          el('div', { class: `mono ${(latest.total_ce_oi - (pc.ce_oi ?? latest.total_ce_oi)) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } },
            fmtSigned(latest.total_ce_oi - (pc.ce_oi ?? latest.total_ce_oi))),
        ),
      );

      // ── PE Card (full detail) ──
      const peCard = el('div', { class: 'card oi-card', style: { padding: '20px' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
          el('div', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--bear)' } }, '📉  Put OI (PE)'),
          el('div', { class: 'mono', style: { fontWeight: '800', fontSize: '22px' } }, fmtCompact(latest.total_pe_oi)),
        ),
        el('table', { class: 'data', style: { marginTop: '0' } },
          el('thead', el('tr',
            el('th', {}, 'Baseline'),
            el('th', {}, 'PE OI'),
            el('th', {}, 'Δ PE OI'),
          )),
          el('tbody',
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Previous Close'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, pc.pe_oi != null ? fmtCompact(pc.pe_oi) : '—'),
              el('td', { class: 'dim' }, '—'),
            ),
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Market Open'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, mo.pe_oi != null ? fmtCompact(mo.pe_oi) : '—'),
              el('td', { class: `mono ${(mo.pe_oi_change ?? 0) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } },
                mo.pe_oi_change != null ? ((mo.pe_oi_change >= 0 ? '+' : '') + fmtCompact(mo.pe_oi_change)) : '—'),
            ),
            el('tr',
              el('td', { class: 'text-xs muted', style: { fontWeight: '500' } }, 'Post Settlement'),
              el('td', { class: 'mono', style: { fontWeight: '600' } }, ps.pe_oi != null ? fmtCompact(ps.pe_oi) : '—'),
              el('td', { class: `mono ${(ps.pe_oi_change ?? 0) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } },
                ps.pe_oi_change != null ? ((ps.pe_oi_change >= 0 ? '+' : '') + fmtCompact(ps.pe_oi_change)) : '—'),
            ),
          ),
        ),
        el('div', { style: { marginTop: '14px', padding: '10px 12px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' } },
          el('div', { class: 'text-xs muted', style: { marginBottom: '6px' } }, 'Current vs Previous Close'),
          el('div', { class: `mono ${(latest.total_pe_oi - (pc.pe_oi ?? latest.total_pe_oi)) >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } },
            fmtSigned(latest.total_pe_oi - (pc.pe_oi ?? latest.total_pe_oi))),
        ),
      );

      // ── Combined baseline comparison table ──
      const combinedTable = el('div', { class: 'card', style: { padding: '16px', marginTop: '16px' } },
        el('div', { style: { fontSize: '14px', fontWeight: '600', marginBottom: '12px' } }, 'Baseline Comparison'),
        el('div', { class: 'data-grid-wrap', style: { maxHeight: 'none' } },
          el('table', { class: 'data' },
            el('thead', el('tr',
              el('th', {}, 'Baseline'),
              el('th', {}, 'CE OI'),
              el('th', {}, 'PE OI'),
              el('th', {}, 'CE Δ'),
              el('th', {}, 'PE Δ'),
            )),
            el('tbody',
              baselineRow('Previous Close', pc.ce_oi, pc.pe_oi, null, null),
              baselineRow('Market Open', mo.ce_oi, mo.pe_oi, mo.ce_oi_change, mo.pe_oi_change),
              baselineRow('Post Settlement', ps.ce_oi, ps.pe_oi, ps.ce_oi_change, ps.pe_oi_change),
              baselineRow('Current (Latest)', latest.total_ce_oi, latest.total_pe_oi,
                latest.total_ce_oi - (pc.ce_oi ?? latest.total_ce_oi),
                latest.total_pe_oi - (pc.pe_oi ?? latest.total_pe_oi)),
            ),
          ),
        ),
      );

      // ── Assemble ──
      const cardsRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } }, ceCard, peCard);
      oiAnalyticsWrap.innerHTML = '';
      oiAnalyticsWrap.appendChild(summaryBar);
      oiAnalyticsWrap.appendChild(cardsRow);
      oiAnalyticsWrap.appendChild(combinedTable);
    } catch (e) {
      oiAnalyticsWrap.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ── OI Logs (time-series table only) ──
  async function renderOiLogs() {
    oiLogsWrap.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
    if (!state.instrument || !state.date) {
      oiLogsWrap.innerHTML = '<div class="empty-state">Select a date to view OI Logs.</div>';
      return;
    }
    try {
      const data = await _fetchOiData();
      if (!data) { oiLogsWrap.innerHTML = '<div class="empty-state">No OI data for this date.</div>'; return; }
      const { summaryRows, instData } = data;
      const baselines = instData?.baselines || {};
      const first = summaryRows[0];
      const pc = baselines.prev_close || {};
      const baseCe = pc.ce_oi ?? first.total_ce_oi;
      const basePe = pc.pe_oi ?? first.total_pe_oi;

      // ── Quick summary cards ──
      const latest = summaryRows[summaryRows.length - 1];
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
          el('div', { class: 'mono', style: { fontWeight: '600' } }, String(summaryRows.length)),
        ),
      );

      // ── Time-series table ──
      const t = el('table', { class: 'data' });
      const cols = ['Time', 'CE OI', 'PE OI', 'PCR', 'ΔPCR', 'CE Δ', 'PE Δ'];
      const thead = el('thead');
      const hr = el('tr');
      cols.forEach(c => hr.appendChild(el('th', {}, c)));
      thead.appendChild(hr);
      t.appendChild(thead);

      const tbody = el('tbody');
      let prevCe = first.total_ce_oi, prevPe = first.total_pe_oi;
      summaryRows.forEach((r, i) => {
        const rowPcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const cΔ = i === 0 ? 0 : r.total_ce_oi - prevCe;
        const pΔ = i === 0 ? 0 : r.total_pe_oi - prevPe;
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
        prevCe = r.total_ce_oi;
        prevPe = r.total_pe_oi;
      });
      t.appendChild(tbody);

      oiLogsWrap.innerHTML = '';
      oiLogsWrap.appendChild(miniSummary);
      oiLogsWrap.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      oiLogsWrap.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ── Export CSV ──
  async function exportCSV() {
    if (!currentResult) return;
    toast('Exporting…', 'info');
    const rows = [];
    const cols = currentResult.columns || selectedCols;
    for (let p = 1; p <= (currentResult.pages || 1); p++) {
      const res = await api.dataQuery({
        instrument: state.instrument, date: state.date || undefined,
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
    a.download = `${state.instrument}-${state.date || 'data'}.csv`;
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
  await runQuery();
}

export function unmount() {}
