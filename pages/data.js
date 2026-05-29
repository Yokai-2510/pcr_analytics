// pages/data.js — Snapshots data explorer (4-tab: OI Analytics / OI Logs / Entry Signals / All Logs)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, fmtSigned, fmtPct, icon, Select, DateSelect } from '../components.js';

// Reusable client-side sortable table. Each col: { key, label, num, render(row) }.
// Click cycles asc -> desc -> none. Numeric sort by default; pass num:false for
// string. The render fn returns the cell node for a row given the col key.
function buildSortableTable(cols, rows) {
  const table = el('table', { class: 'data' });
  const thead = el('thead');
  const hr = el('tr');
  const tbody = el('tbody');
  let sortKey = null;
  let sortDir = null;
  const iconEls = {};

  function applySort() {
    if (!sortKey || !sortDir) return rows;
    const col = cols.find(c => c.key === sortKey);
    // Column can override with sortFilter(rows, dir) -> rows. Used for the
    // Signal / Crossover columns where "sorting" really means "filter the
    // blanks and keep the rest in chronological order so BUY/SELL alternate".
    if (typeof col?.sortFilter === 'function') {
      return col.sortFilter(rows, sortDir);
    }
    const isNum = col?.num !== false;
    return [...rows].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (isNum) {
        av = (av == null || Number.isNaN(Number(av))) ? -Infinity : Number(av);
        bv = (bv == null || Number.isNaN(Number(bv))) ? -Infinity : Number(bv);
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  function paintHeaders() {
    cols.forEach(c => {
      const active = sortKey === c.key;
      iconEls[c.key].parentNode.classList.toggle('active', active);
      iconEls[c.key].textContent = active ? (sortDir === 'asc' ? '▲' : '▼') : '↕';
    });
  }

  function renderRows() {
    tbody.innerHTML = '';
    applySort().forEach(row => {
      const tr = el('tr');
      cols.forEach(c => tr.appendChild(c.render(row)));
      tbody.appendChild(tr);
    });
  }

  cols.forEach(c => {
    const ic = el('span', { class: 'sort-icon' }, '↕');
    iconEls[c.key] = ic;
    const th = el('th', { class: 'sort-th', title: 'Click to sort' }, c.label, ic);
    th.addEventListener('click', () => {
      if (sortKey === c.key) {
        sortDir = sortDir === 'asc' ? 'desc' : sortDir === 'desc' ? null : 'asc';
        if (sortDir === null) sortKey = null;
      } else {
        sortKey = c.key;
        sortDir = 'desc';
      }
      paintHeaders();
      renderRows();
    });
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  table.appendChild(tbody);
  paintHeaders();
  renderRows();
  return table;
}
import { api } from '../api.js';
import { store } from '../store.js';

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let activeTab = 'oi-analytics'; // 'oi-analytics' | 'oi-logs' | 'entry-signals' | 'all-logs'
let pollTimer = null;

// Per-tab instrument/date state so each tab remembers its own selection
const tabState = {
  'oi-analytics': { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'oi-logs':      { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'entry-signals':   { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
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
    { id: 'entry-signals', label: 'Entry Signals' },
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
  const entrySignalsPanel = el('div', { class: 'tab-panel' });
  const allLogsPanel = el('div', { class: 'tab-panel' });

  page.appendChild(oiAnalyticsPanel);
  page.appendChild(oiLogsPanel);
  page.appendChild(entrySignalsPanel);
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
        else if (tabId === 'entry-signals') renderEntrySignals();
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
        else if (tabId === 'entry-signals') renderEntrySignals();
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
    entrySignalsPanel.style.display = tabId === 'entry-signals' ? '' : 'none';
    allLogsPanel.style.display = tabId === 'all-logs' ? '' : 'none';
    if (tabId === 'all-logs') renderBody();
    else if (tabId === 'oi-analytics') renderOiAnalytics();
    else if (tabId === 'oi-logs') renderOiLogs();
    else if (tabId === 'entry-signals') renderEntrySignals();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OI ANALYTICS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const oiAnalyticsContent = el('div');
  buildTabToolbar(oiAnalyticsPanel, 'oi-analytics');
  oiAnalyticsPanel.appendChild(oiAnalyticsContent);

  async function renderOiAnalytics(silent = false) {
    if (!silent) oiAnalyticsContent.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
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
          el('div', { class: `mono ${deltaPcr != null ? (deltaPcr >= 0 ? 'bull' : 'bear') : ''}`, style: { fontWeight: '700', fontSize: '18px' } }, deltaPcr != null ? fmtNum(deltaPcr, 3) : '—'),
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
      if (!silent) oiAnalyticsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OI LOGS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const oiLogsContent = el('div');
  buildTabToolbar(oiLogsPanel, 'oi-logs', (controls) => {
    const oiExportBtn = el('button', { class: 'btn secondary sm', onclick: exportOiLogsCSV }, 'Export CSV');
    controls.append(el('div', { class: 'spacer' }), oiExportBtn);
  });
  oiLogsPanel.appendChild(oiLogsContent);

  // ── Export OI Logs as CSV ──
  async function exportOiLogsCSV() {
    const ts = tabState['oi-logs'];
    if (!ts.instrument || !ts.date) { toast('Select instrument and date first', 'error'); return; }
    toast('Exporting OI logs…', 'info');
    try {
      const data = await _fetchOiData(ts.instrument, ts.date);
      if (!data) { toast('No data to export', 'error'); return; }
      const { summaryRows } = data;
      const headers = ['Time', 'CE_OI', 'PE_OI', 'PCR', 'Delta_PCR', 'CE_Change', 'PE_Change', 'Signed_PCR', 'Signal'];
      const csvRows = [headers.join(',')];
      for (let i = 0; i < summaryRows.length; i++) {
        const r = summaryRows[i];
        const rowPcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const prev = i > 0 ? summaryRows[i - 1] : null;
        const prevPcr = prev ? (prev.total_pe_oi / prev.total_ce_oi) : rowPcr;
        const cΔ = prev ? (r.total_ce_oi - prev.total_ce_oi) : 0;
        const pΔ = prev ? (r.total_pe_oi - prev.total_pe_oi) : 0;
        // ΔPCR = PE ΔOI / CE ΔOI
        const deltaPcr = (prev && Math.abs(cΔ) > 0) ? (pΔ / cΔ) : 0;

        // Signed PCR
        const absCe = Math.abs(cΔ);
        const absPe = Math.abs(pΔ);
        let signedPcr = '';
        let signal = '';
        if (prev && absCe > 0) {
          const pcrMag = absPe / absCe;
          let sign;
          if ((pΔ >= 0 && cΔ >= 0) || (pΔ <= 0 && cΔ <= 0)) {
            sign = pcrMag > 1 ? 1 : -1;
          } else {
            sign = pΔ >= 0 ? 1 : -1;
          }
          signedPcr = (sign * pcrMag).toFixed(6);
          const sp = sign * pcrMag;
          if (sp > 0) signal = sp >= 1 ? 'Strong Bull' : 'Bull';
          else signal = sp <= -1 ? 'Strong Bear' : 'Bear';
        }

        csvRows.push([
          r.timestamp,
          r.total_ce_oi,
          r.total_pe_oi,
          rowPcr.toFixed(6),
          deltaPcr.toFixed(6),
          cΔ,
          pΔ,
          signedPcr,
          signal,
        ].join(','));
      }
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `oi-logs-${ts.instrument}-${ts.date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${summaryRows.length} rows`, 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  }

  async function renderOiLogs(silent = false) {
    if (!silent) oiLogsContent.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
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

      // Compute latest change values for second row of cards
      const origSorted = [...summaryRows]; // ascending
      const prevLatest = origSorted.length > 1 ? origSorted[origSorted.length - 2] : null;
      const latestCeChg = prevLatest ? (latest.total_ce_oi - prevLatest.total_ce_oi) : 0;
      const latestPeChg = prevLatest ? (latest.total_pe_oi - prevLatest.total_pe_oi) : 0;
      const latestDeltaPcr = (prevLatest && Math.abs(latestCeChg) > 0) ? (latestPeChg / latestCeChg) : 0;
      // Signed PCR
      let latestSignedPcr = null;
      if (prevLatest && Math.abs(latestCeChg) > 0) {
        const mag = Math.abs(latestPeChg) / Math.abs(latestCeChg);
        let sign;
        if ((latestPeChg >= 0 && latestCeChg >= 0) || (latestPeChg <= 0 && latestCeChg <= 0)) {
          sign = mag > 1 ? 1 : -1;
        } else {
          sign = latestPeChg >= 0 ? 1 : -1;
        }
        latestSignedPcr = sign * mag;
      }

      const miniSummary = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' } },
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

      // ── Second row: Change metrics ──
      const miniSummary2 = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' } },
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'CE OI Change'),
          el('div', { class: `mono ${latestCeChg >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, (latestCeChg >= 0 ? '+' : '') + fmtCompact(latestCeChg)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'PE OI Change'),
          el('div', { class: `mono ${latestPeChg >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, (latestPeChg >= 0 ? '+' : '') + fmtCompact(latestPeChg)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Delta PCR'),
          el('div', { class: `mono ${latestDeltaPcr >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, (latestDeltaPcr >= 0 ? '+' : '') + fmtNum(latestDeltaPcr, 3)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Signed PCR'),
          el('div', { class: `mono ${latestSignedPcr != null ? (latestSignedPcr >= 0 ? 'bull' : 'bear') : ''}`, style: { fontWeight: '700', fontSize: '16px' } }, latestSignedPcr != null ? ((latestSignedPcr >= 0 ? '+' : '') + fmtNum(latestSignedPcr, 3)) : '—'),
        ),
      );

      // ── Pre-compute every row's display values in time-order (so deltas
      // are deterministic and sort doesn't break the chronology math) ──
      const computed = rows.map(r => {
        const oi = origSorted.indexOf(r);
        const prevRow = oi > 0 ? origSorted[oi - 1] : null;
        const rowPcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const cΔ = prevRow ? (r.total_ce_oi - prevRow.total_ce_oi) : 0;
        const pΔ = prevRow ? (r.total_pe_oi - prevRow.total_pe_oi) : 0;
        const deltaPcr = (prevRow && Math.abs(cΔ) > 0) ? (pΔ / cΔ) : 0;

        // ── Signed PCR (Dr. Vijay Bhilwade methodology) ──
        let signedPcr = null;
        let signal = '—';
        const absCe = Math.abs(cΔ), absPe = Math.abs(pΔ);
        if (prevRow && absCe > 0) {
          const pcrMag = absPe / absCe;
          const sign = ((pΔ >= 0 && cΔ >= 0) || (pΔ <= 0 && cΔ <= 0))
            ? (pcrMag > 1 ? 1 : -1)
            : (pΔ >= 0 ? 1 : -1);
          signedPcr = sign * pcrMag;
          signal = signedPcr > 0
            ? (signedPcr >= 1 ? 'Strong Bull' : 'Bull')
            : (signedPcr <= -1 ? 'Strong Bear' : 'Bear');
        }
        return {
          timestamp: r.timestamp,
          ceOi: r.total_ce_oi,
          peOi: r.total_pe_oi,
          pcr: rowPcr,
          deltaPcr,
          cΔ,
          pΔ,
          signedPcr,
          signal,
          signalRank: { 'Strong Bull': 2, 'Bull': 1, '—': 0, 'Bear': -1, 'Strong Bear': -2 }[signal] ?? 0,
        };
      });

      const cols = [
        { key: 'timestamp', label: 'Time', render: r => el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)) },
        { key: 'ceOi', label: 'CE OI', render: r => el('td', { class: 'mono' }, fmtCompact(r.ceOi)) },
        { key: 'peOi', label: 'PE OI', render: r => el('td', { class: 'mono' }, fmtCompact(r.peOi)) },
        { key: 'pcr', label: 'PCR', render: r => el('td', { class: `mono ${r.pcr >= 1 ? 'bull' : 'bear'}` }, fmtNum(r.pcr, 3)) },
        { key: 'deltaPcr', label: 'ΔPCR', render: r => el('td', { class: `mono ${r.deltaPcr >= 0 ? 'bull' : 'bear'}` }, (r.deltaPcr >= 0 ? '+' : '') + fmtNum(r.deltaPcr, 3)) },
        { key: 'cΔ', label: 'CE Δ', render: r => el('td', { class: `mono ${r.cΔ >= 0 ? 'bull' : 'bear'}` }, (r.cΔ >= 0 ? '+' : '') + fmtCompact(r.cΔ)) },
        { key: 'pΔ', label: 'PE Δ', render: r => el('td', { class: `mono ${r.pΔ >= 0 ? 'bull' : 'bear'}` }, (r.pΔ >= 0 ? '+' : '') + fmtCompact(r.pΔ)) },
        { key: 'signedPcr', label: 'Signed PCR', render: r => {
          if (r.signedPcr == null) return el('td', { class: 'mono dim' }, '—');
          const tone = r.signedPcr > 0 ? 'bull' : r.signedPcr < 0 ? 'bear' : '';
          return el('td', { class: `mono ${tone}`, style: { fontWeight: '600' } }, (r.signedPcr >= 0 ? '+' : '') + fmtNum(r.signedPcr, 3));
        } },
        { key: 'signalRank', label: 'Signal',
          render: r => {
            const tone = r.signal === 'Strong Bull' || r.signal === 'Bull' ? 'bull'
                       : r.signal === 'Strong Bear' || r.signal === 'Bear' ? 'bear' : 'neutral';
            return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px' } }, r.signal));
          },
          // Click on Signal to keep only rows that have a directional read
          // and order them chronologically, so Bull/Bear alternations remain
          // visible in time order rather than grouping all bulls together.
          sortFilter: (rs, dir) => rs
            .filter(r => r.signal !== '—')
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
      ];

      const t = buildSortableTable(cols, computed);

      oiLogsContent.innerHTML = '';
      oiLogsContent.appendChild(miniSummary);
      oiLogsContent.appendChild(miniSummary2);
      oiLogsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      if (!silent) oiLogsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ENTRY SIGNALS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const entrySignalsContent = el('div');
  buildTabToolbar(entrySignalsPanel, 'entry-signals');
  entrySignalsPanel.appendChild(entrySignalsContent);

  async function renderEntrySignals(silent = false) {
    if (!silent) entrySignalsContent.innerHTML = '<div class="dim" style="padding:24px">Loading entry signals…</div>';
    const ts = tabState['entry-signals'];
    if (!ts.instrument || !ts.date) {
      entrySignalsContent.innerHTML = '<div class="empty-state">Select a date to view entry signals.</div>';
      return;
    }
    try {
      const data = await api.computedTicks(ts.instrument, ts.date);
      const ticks = Array.isArray(data) ? data : (data.ticks || data.data || data.rows || []);
      if (!ticks.length) {
        entrySignalsContent.innerHTML = '<div class="empty-state">No computed ticks for this date.</div>';
        return;
      }
      // ── Fill null ce/pe_oi_change from cumulative diffs ──
      // The backend may return null for the first few ticks' change values
      // even though cumulative values are populated. Compute from diffs.
      for (let i = 0; i < ticks.length; i++) {
        const t = ticks[i];
        if (t.ce_oi_change == null || t.pe_oi_change == null) {
          const ceCumm = t.ce_oi_cumm_change ?? t.ce_cumulative ?? t.ce_oi_cumm ?? 0;
          const peCumm = t.pe_oi_cumm_change ?? t.pe_cumulative ?? t.pe_oi_cumm ?? 0;
          if (i === 0) {
            if (t.ce_oi_change == null) t.ce_oi_change = ceCumm;
            if (t.pe_oi_change == null) t.pe_oi_change = peCumm;
          } else {
            const prev = ticks[i - 1];
            const prevCeCumm = prev.ce_oi_cumm_change ?? prev.ce_cumulative ?? prev.ce_oi_cumm ?? 0;
            const prevPeCumm = prev.pe_oi_cumm_change ?? prev.pe_cumulative ?? prev.pe_oi_cumm ?? 0;
            if (t.ce_oi_change == null) t.ce_oi_change = ceCumm - prevCeCumm;
            if (t.pe_oi_change == null) t.pe_oi_change = peCumm - prevPeCumm;
          }
        }
      }

      // Reverse chronological (latest at top)
      const rows = [...ticks].reverse();

      entrySignalsContent.innerHTML = '';

      // Summary strip
      const latest = rows[0];
      const buyCount = rows.filter(r => (r.signal || '').toUpperCase() === 'BUY').length;
      const sellCount = rows.filter(r => (r.signal || '').toUpperCase() === 'SELL').length;
      const crossoverCount = rows.filter(r => r.crossover === true || r.crossover === 1 || r.crossover === 'TRUE' || r.crossover === 'true').length;

      const summaryStrip = el('div', { class: 'card', style: { display: 'flex', gap: '28px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '16px' } },
        el('div', {},
          el('span', { class: 'text-xs muted' }, 'Ticks'),
          el('div', { class: 'mono', style: { fontWeight: '600', fontSize: '16px' } }, String(rows.length)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'BUY Signals'),
          el('div', { class: 'mono bull', style: { fontWeight: '700', fontSize: '16px' } }, String(buyCount)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'SELL Signals'),
          el('div', { class: 'mono bear', style: { fontWeight: '700', fontSize: '16px' } }, String(sellCount)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Crossovers'),
          el('div', { class: 'mono', style: { fontWeight: '600', fontSize: '16px', color: 'var(--accent)' } }, String(crossoverCount)),
        ),
      );
      entrySignalsContent.appendChild(summaryStrip);

      // Pre-compute display values so sorting is just (re)arranging an array.
      const computed = rows.map(r => {
        const ceCumm = r.ce_oi_cumm_change ?? r.ce_cumulative ?? r.ce_oi_cumm ?? 0;
        const peCumm = r.pe_oi_cumm_change ?? r.pe_cumulative ?? r.pe_oi_cumm ?? 0;
        const crossover = r.crossover === true || r.crossover === 1 || r.crossover === 'TRUE' || r.crossover === 'true';
        const signal = (r.signal || '').toUpperCase();
        return {
          timestamp: r.timestamp,
          ceChg: r.ce_oi_change ?? r.ce_oi_chg ?? 0,
          peChg: r.pe_oi_change ?? r.pe_oi_chg ?? 0,
          ceCumm,
          peCumm,
          diff: peCumm - ceCumm,
          signal,
          signalRank: signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0,
          crossover: crossover ? 1 : 0,
        };
      });

      const cols = [
        { key: 'timestamp', label: 'Timestamp', render: r => el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)) },
        { key: 'ceChg', label: 'CE OI Change', render: r => el('td', { class: `mono ${r.ceChg >= 0 ? 'bull' : 'bear'}` }, fmtCompact(r.ceChg)) },
        { key: 'peChg', label: 'PE OI Change', render: r => el('td', { class: `mono ${r.peChg >= 0 ? 'bull' : 'bear'}` }, fmtCompact(r.peChg)) },
        { key: 'ceCumm', label: 'CE Cumulative', render: r => el('td', { class: `mono ${r.ceCumm >= 0 ? 'bull' : 'bear'}` }, fmtCompact(r.ceCumm)) },
        { key: 'peCumm', label: 'PE Cumulative', render: r => el('td', { class: `mono ${r.peCumm >= 0 ? 'bull' : 'bear'}` }, fmtCompact(r.peCumm)) },
        { key: 'diff', label: 'Difference (PE−CE)', render: r => el('td', { class: `mono ${r.diff >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } }, (r.diff >= 0 ? '+' : '') + fmtCompact(r.diff)) },
        { key: 'signalRank', label: 'Signal',
          render: r => {
            const tone = r.signal === 'BUY' ? 'bull' : r.signal === 'SELL' ? 'bear' : 'neutral';
            const label = r.signal || '—';
            return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px' } }, label));
          },
          // Click on Signal to keep only BUY/SELL rows in chronological order
          // — the data_engine enforces strict alternation so they naturally
          // come out BUY/SELL/BUY/SELL once the blanks are dropped.
          sortFilter: (rs, dir) => rs
            .filter(r => r.signalRank !== 0)
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
        { key: 'crossover', label: 'Crossover',
          render: r => el('td', {
            class: 'mono',
            style: { fontWeight: r.crossover ? '700' : '400', color: r.crossover ? 'var(--accent)' : 'var(--text-muted)' },
          }, r.crossover ? 'TRUE' : 'FALSE'),
          // Click on Crossover to keep only TRUE rows, time-ordered.
          sortFilter: (rs, dir) => rs
            .filter(r => r.crossover === 1)
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
      ];

      const t = buildSortableTable(cols, computed);
      entrySignalsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));

    } catch (e) {
      if (!silent) entrySignalsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
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
  async function runQuery(silent = false) {
    if (!silent) allLogsTable.innerHTML = '<tbody><tr><td colspan="20" class="dim">Loading…</td></tr></tbody>';
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
      if (!silent) {
        allLogsTable.innerHTML = '';
        allLogsTableWrap.innerHTML = `<div class="empty-state"><span class="bear">Query failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
      }
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
      api.dashboard(60, date),
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
    if (activeTab === 'all-logs') runQuery(true);
    else if (activeTab === 'oi-analytics') renderOiAnalytics(true);
    else if (activeTab === 'oi-logs') renderOiLogs(true);
    else if (activeTab === 'entry-signals') renderEntrySignals(true);
  }, 60000);
}

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
