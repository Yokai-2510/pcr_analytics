// pages/data.js — Snapshots data explorer (5-tab: OI Analytics / OI Logs / Volume Logs / Entry Signals / All Logs)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, fmtSigned, fmtPct, icon, Select, DateSelect, filterMarketHours } from '../components.js';

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

// Map a raw crossover signal to the user-facing label + tone.
// BUY = buy a CALL (bullish, green); SELL = buy a PUT (bearish, red).
function crossoverLabel(sig) {
  if (sig === 'BUY') return 'BUY CALL';
  if (sig === 'SELL') return 'BUY PUT';
  return sig || '—';
}

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let activeTab = 'volume-logs'; // 'volume-logs' | 'sr' | 'oi-change-logs' | 'entry-signals'
let pollTimer = null;

// Per-tab instrument/date state so each tab remembers its own selection
const tabState = {
  'oi-analytics': { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'oi-logs':      { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'volume-logs':  { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'ltp-strength': { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'sr':           { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'oi-change-logs':   { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'entry-signals':    { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
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
    { id: 'volume-logs', label: 'Volume Logs' },
    { id: 'ltp-strength', label: 'LTP Strength' },
    { id: 'sr', label: 'S/R' },
    { id: 'oi-change-logs', label: 'OI Change Logs' },
    { id: 'entry-signals', label: 'Entry Signals' },
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
  const volumeLogsPanel = el('div', { class: 'tab-panel' });
  const ltpStrengthPanel = el('div', { class: 'tab-panel' });
  const srPanel = el('div', { class: 'tab-panel' });
  const oiChangeLogsPanel = el('div', { class: 'tab-panel' });
  const entrySignalsPanel = el('div', { class: 'tab-panel' });
  const allLogsPanel = el('div', { class: 'tab-panel' });

  // Only the four kept tabs are mounted. The OI Analytics / OI Logs / All Logs
  // panels are still constructed below (their build code is inert when not
  // appended) but are intentionally not shown.
  page.appendChild(volumeLogsPanel);
  page.appendChild(ltpStrengthPanel);
  page.appendChild(srPanel);
  page.appendChild(oiChangeLogsPanel);
  page.appendChild(entrySignalsPanel);

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
        if (tabId === 'volume-logs') renderVolumeLogs();
        else if (tabId === 'ltp-strength') renderLtpStrength();
        else if (tabId === 'sr') renderSR();
        else if (tabId === 'oi-change-logs') renderOiChangeLogs();
        else if (tabId === 'entry-signals') renderEntrySignals();
      },
    });

    const dateSelect = DateSelect({
      instrument: ts.instrument,
      apiDistinctFn: fetchAvailableDates,
      onChange: v => {
        ts.date = v;
        if (tabId === 'volume-logs') renderVolumeLogs();
        else if (tabId === 'ltp-strength') renderLtpStrength();
        else if (tabId === 'sr') renderSR();
        else if (tabId === 'oi-change-logs') renderOiChangeLogs();
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
    volumeLogsPanel.style.display = tabId === 'volume-logs' ? '' : 'none';
    ltpStrengthPanel.style.display = tabId === 'ltp-strength' ? '' : 'none';
    srPanel.style.display = tabId === 'sr' ? '' : 'none';
    oiChangeLogsPanel.style.display = tabId === 'oi-change-logs' ? '' : 'none';
    entrySignalsPanel.style.display = tabId === 'entry-signals' ? '' : 'none';
    if (tabId === 'volume-logs') renderVolumeLogs();
    else if (tabId === 'ltp-strength') renderLtpStrength();
    else if (tabId === 'sr') renderSR();
    else if (tabId === 'oi-change-logs') renderOiChangeLogs();
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
  // VOLUME LOGS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const volumeLogsContent = el('div');
  buildTabToolbar(volumeLogsPanel, 'volume-logs', (controls) => {
    const volExportBtn = el('button', { class: 'btn secondary sm', onclick: exportVolumeLogsCSV }, 'Export CSV');
    controls.append(el('div', { class: 'spacer' }), volExportBtn);
  });
  volumeLogsPanel.appendChild(volumeLogsContent);

  async function _fetchVolumeData(instrument, date) {
    if (!instrument || !date) return null;
    // Fetch volume + computed_ticks in parallel; computed_ticks supplies the
    // OI cumulative difference (oi_difference = PE_cumm - CE_cumm) so we can
    // expose ROC of OI Diff alongside ROC of Vol Diff.
    const [raw, ticksRaw] = await Promise.all([
      api.totalVolume(instrument, date),
      api.computedTicks(instrument, date).catch(() => []),
    ]);
    const rawRows = Array.isArray(raw) ? raw : (raw.data || raw.rows || []);
    const rows = filterMarketHours(rawRows);
    if (!rows.length) return null;
    const timeMap = new Map();
    rows.forEach(r => {
      const ts = r.timestamp || r.time || r.date;
      if (!ts) return;
      const existing = timeMap.get(ts);
      if (existing) {
        existing.total_ce_volume += (r.total_ce_volume || r.ce_volume || 0);
        existing.total_pe_volume += (r.total_pe_volume || r.pe_volume || 0);
        if (!existing.underlying_spot_price) existing.underlying_spot_price = r.underlying_spot_price || 0;
      } else {
        timeMap.set(ts, {
          timestamp: ts,
          total_ce_volume: r.total_ce_volume || r.ce_volume || 0,
          total_pe_volume: r.total_pe_volume || r.pe_volume || 0,
          underlying_spot_price: r.underlying_spot_price || r.spot || 0,
        });
      }
    });
    const summaryRows = [...timeMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Build minute -> oi_difference lookup. Volume rows are now at 15s
    // (un-floored, e.g. 09:15:30) while computed_ticks sit on :00 minute
    // boundaries, so key by the minute prefix (first 16 chars) and every
    // 15s volume row in that minute maps to the minute's OI diff.
    const ticksArr = Array.isArray(ticksRaw) ? ticksRaw : (ticksRaw.ticks || ticksRaw.data || ticksRaw.rows || []);
    const oiDiffByTs = new Map();
    for (const t of ticksArr) {
      const ts = t.timestamp;
      if (!ts || t.oi_difference == null) continue;
      oiDiffByTs.set(ts.slice(0, 16), t.oi_difference);
    }
    return { summaryRows, oiDiffByTs };
  }

  // Trend strength buckets derived from |ROC of Vol Diff|:
  //   <5 Weak, 5–20 Moderate, 20–50 Strong, ≥50 Very Strong.
  function _classifyTrend(absRoc) {
    if (absRoc == null || !Number.isFinite(absRoc)) return 'Neutral';
    if (absRoc < 5) return 'Weak';
    if (absRoc < 20) return 'Moderate';
    if (absRoc < 50) return 'Strong';
    return 'Very Strong';
  }
  function _classifyAlert(trend, roc) {
    if (trend !== 'Strong' && trend !== 'Very Strong') return 'NEUTRAL';
    if (roc == null || !Number.isFinite(roc)) return 'NEUTRAL';
    return roc < 0 ? 'STRONG CE' : 'STRONG PE';
  }
  function _classifyConfidence(trend) {
    return (trend === 'Strong' || trend === 'Very Strong') ? 'High' : 'Low';
  }

  // ── VWAP (session-anchored, per Dr. Vijay's spec) ──────────────────────
  // VWAP(t) = Σ TP(i)·Vol(i) / Σ Vol(i), anchored at 09:15, reset daily.
  // TP(i)  = underlying spot price at tick (H=L=C=spot at tick level).
  // Vol(i) = ΔCE_vol(i) + ΔPE_vol(i) — per-tick incremental CE+PE volume.
  // Band   = 0.05% of VWAP.
  // Signal: spot > VWAP+band → BUY; spot < VWAP−band → SELL; else NEUTRAL.
  // Live from 09:15:00 (no warm-up).
  const VWAP_BAND_PCT = 0.0005;

  function _computeVolumeMetrics(summaryRows, oiDiffByTs) {
    const out = [];
    let prevCeCum = null, prevPeCum = null;
    let prevVolDiff = null;
    // VWAP accumulators — anchored at session start (rows are market-hours filtered)
    let cumPV = 0, cumVol = 0;
    // Tracks the active VWAP position so we can label EXIT/flip transitions
    let vwapPosition = 'NEUTRAL';

    for (let i = 0; i < summaryRows.length; i++) {
      const r = summaryRows[i];
      const ceCum = r.total_ce_volume || 0;   // day-cumulative CE volume
      const peCum = r.total_pe_volume || 0;   // day-cumulative PE volume
      const spot  = r.underlying_spot_price || 0;
      const ts    = r.timestamp || '';

      // Per-tick incremental volume
      const ceVol = prevCeCum !== null ? Math.max(0, ceCum - prevCeCum) : ceCum;
      const peVol = prevPeCum !== null ? Math.max(0, peCum - prevPeCum) : peCum;
      const volDiff = peCum - ceCum;

      // Vol crossover (sign flip)
      let crossover = '';
      if (prevVolDiff !== null) {
        if (prevVolDiff < 0 && volDiff >= 0) crossover = 'PE Cross Up';
        else if (prevVolDiff > 0 && volDiff <= 0) crossover = 'CE Cross Up';
      }

      // VWAP accumulation (TP = spot, Vol = incremental CE+PE volume)
      const tickVol = ceVol + peVol;
      if (spot > 0 && tickVol > 0) { cumPV += spot * tickVol; cumVol += tickVol; }
      const vwap = cumVol > 0 ? cumPV / cumVol : 0;

      // VWAP signal — live from the first tick (09:15), no warm-up
      let vwapSig = 'NEUTRAL';
      if (vwap > 0 && spot > 0) {
        const band = vwap * VWAP_BAND_PCT;
        const dir = spot > vwap + band ? 'BUY' : spot < vwap - band ? 'SELL' : 'NEUTRAL';
        if (dir === 'NEUTRAL') {
          vwapSig = 'NEUTRAL';
        } else if (vwapPosition === 'NEUTRAL') {
          vwapSig = dir;               // first directional signal
          vwapPosition = dir;
        } else if (dir === vwapPosition) {
          vwapSig = dir;               // HOLD — remain in same direction
        } else {
          // Flip: EXIT current → enter new direction
          vwapSig = vwapPosition === 'BUY' ? 'EXIT BUY → SELL' : 'EXIT SELL → BUY';
          vwapPosition = dir;
        }
      }

      // Trend/Alert/Confidence: keep the existing framework but key off vol crossover direction
      const volAbsRoc = volDiff !== 0 && prevVolDiff !== null && Math.abs(prevVolDiff) > 0
        ? Math.abs((volDiff - prevVolDiff) / Math.abs(prevVolDiff) * 100) : null;
      const trend = _classifyTrend(volAbsRoc);
      const alert = _classifyAlert(trend, volDiff !== 0 && prevVolDiff !== null ? (volDiff - prevVolDiff) : null);
      const confidence = _classifyConfidence(trend);

      out.push({
        timestamp: ts,
        ceVol, peVol, ceCum, peCum, volDiff,
        vwap: vwap > 0 ? vwap : null,
        vwapSig,
        crossover, trend, alert, confidence,
        spot: spot || null,
      });
      prevVolDiff = volDiff;
      prevCeCum = ceCum;
      prevPeCum = peCum;
    }
    return out;
  }

  async function exportVolumeLogsCSV() {
    const ts = tabState['volume-logs'];
    if (!ts.instrument || !ts.date) { toast('Select instrument and date first', 'error'); return; }
    toast('Exporting Volume logs…', 'info');
    try {
      const data = await _fetchVolumeData(ts.instrument, ts.date);
      if (!data) { toast('No data to export', 'error'); return; }
      const metrics = _computeVolumeMetrics(data.summaryRows, data.oiDiffByTs);
      const headers = [
        'Time', 'CE_Volume', 'PE_Volume', 'CE_Volume_Cumulative', 'PE_Volume_Cumulative',
        'Volume_Difference_PE_minus_CE', 'Spot_Price', 'VWAP_Price', 'VWAP_Signal',
        'CE_PE_Volume_Crossover', 'Alert_Type',
      ];
      const csvRows = [headers.join(',')];
      for (const m of metrics) {
        csvRows.push([
          m.timestamp, m.ceVol, m.peVol, m.ceCum, m.peCum, m.volDiff,
          m.spot != null ? m.spot.toFixed(2) : '', m.vwap != null ? m.vwap.toFixed(2) : '',
          (m.vwapSig || '').replace(/,/g, ''), m.crossover, m.alert,
        ].join(','));
      }
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `volume-logs-${ts.instrument}-${ts.date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${metrics.length} rows`, 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  }

  async function renderVolumeLogs(silent = false) {
    if (!silent) volumeLogsContent.innerHTML = '<div class="dim" style="padding:24px">Loading volume data…</div>';
    const ts = tabState['volume-logs'];
    if (!ts.instrument || !ts.date) {
      volumeLogsContent.innerHTML = '<div class="empty-state">Select a date to view Volume Logs.</div>';
      return;
    }
    try {
      const data = await _fetchVolumeData(ts.instrument, ts.date);
      if (!data) { volumeLogsContent.innerHTML = '<div class="empty-state">No volume data for this date.</div>'; return; }
      const metrics = _computeVolumeMetrics(data.summaryRows, data.oiDiffByTs);
      const latest = metrics[metrics.length - 1];

      const trendTone = {
        'Very Strong': 'bull', 'Strong': 'bull',
        'Moderate': 'neutral', 'Weak': 'neutral', 'Neutral': 'neutral',
      }[latest.trend] || 'neutral';
      const alertTone = latest.alert === 'STRONG CE' ? 'bear'
                      : latest.alert === 'STRONG PE' ? 'bull' : 'neutral';

      const miniSummary = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' } },
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Latest CE Vol'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, fmtCompact(latest.ceVol)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Latest PE Vol'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, fmtCompact(latest.peVol)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Vol Diff (PE−CE)'),
          el('div', { class: `mono ${latest.volDiff >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '16px' } }, (latest.volDiff >= 0 ? '+' : '') + fmtCompact(latest.volDiff)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Ticks'),
          el('div', { class: 'mono', style: { fontWeight: '600' } }, String(metrics.length)),
        ),
      );

      // Current VWAP position = last directional state (BUY/SELL), else NEUTRAL
      const lastVwapSig = [...metrics].reverse().find(m => m.vwapSig && m.vwapSig !== 'NEUTRAL')?.vwapSig || 'NEUTRAL';
      const vwapSigTone = (lastVwapSig === 'BUY' || lastVwapSig === 'EXIT SELL → BUY') ? 'bull'
        : (lastVwapSig === 'SELL' || lastVwapSig === 'EXIT BUY → SELL') ? 'bear' : 'neutral';

      const miniSummary2 = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' } },
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '130px' } },
          el('span', { class: 'text-xs muted' }, 'Spot Price'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, latest.spot != null ? fmtNum(latest.spot, 2) : '—'),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '130px' } },
          el('span', { class: 'text-xs muted' }, 'VWAP Price'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, latest.vwap != null ? fmtNum(latest.vwap, 2) : '—'),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '130px' } },
          el('span', { class: 'text-xs muted' }, 'VWAP Position'),
          el('div', {}, el('span', { class: `change-pill ${vwapSigTone}`, style: { fontSize: '11px', fontWeight: '700' } }, lastVwapSig)),
        ),
        el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
          el('span', { class: 'text-xs muted' }, 'Alert Type'),
          el('div', {}, el('span', { class: `change-pill ${alertTone}`, style: { fontSize: '11px' } }, latest.alert)),
        ),
      );

      // Display order: latest at top
      const rows = [...metrics].reverse();

      // signed sort key for trend pill ordering
      const trendRank = { 'Very Strong': 4, 'Strong': 3, 'Moderate': 2, 'Weak': 1, 'Neutral': 0 };
      const alertRank = { 'STRONG CE': -1, 'NEUTRAL': 0, 'STRONG PE': 1 };
      const confRank = { 'High': 1, 'Low': 0 };
      const display = rows.map(r => ({
        ...r,
        trendRank: trendRank[r.trend] ?? 0,
        alertRank: alertRank[r.alert] ?? 0,
        confRank: confRank[r.confidence] ?? 0,
      }));

      const cols = [
        { key: 'timestamp', label: 'Time', render: r => el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)) },
        { key: 'ceVol', label: 'CE Vol', render: r => el('td', { class: 'mono' }, fmtCompact(r.ceVol)) },
        { key: 'peVol', label: 'PE Vol', render: r => el('td', { class: 'mono' }, fmtCompact(r.peVol)) },
        { key: 'ceCum', label: 'CE Vol Cum', render: r => el('td', { class: 'mono' }, fmtCompact(r.ceCum)) },
        { key: 'peCum', label: 'PE Vol Cum', render: r => el('td', { class: 'mono' }, fmtCompact(r.peCum)) },
        { key: 'volDiff', label: 'Vol Diff (PE−CE)', render: r => el('td', { class: `mono ${r.volDiff >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '600' } }, (r.volDiff >= 0 ? '+' : '') + fmtCompact(r.volDiff)) },
        { key: 'spot', label: 'Spot Price', render: r => {
          if (r.spot == null) return el('td', { class: 'mono dim' }, '—');
          return el('td', { class: 'mono' }, fmtNum(r.spot, 2));
        } },
        { key: 'vwap', label: 'VWAP Price', render: r => {
          if (r.vwap == null) return el('td', { class: 'mono dim' }, '—');
          return el('td', { class: 'mono' }, fmtNum(r.vwap, 2));
        } },
        { key: 'vwapSig', label: 'VWAP Signal', render: r => {
          const sig = r.vwapSig || '—';
          const tone = sig === 'BUY' || sig === 'EXIT SELL → BUY' ? 'bull'
            : sig === 'SELL' || sig === 'EXIT BUY → SELL' ? 'bear'
            : 'neutral';
          const style = sig === 'EXIT BUY → SELL' ? { background: '#f5a623', color: '#000' }
            : sig === 'EXIT SELL → BUY' ? { background: '#00bcd4', color: '#000' } : {};
          return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px', fontWeight: '700', ...style } }, sig));
        },
          sortFilter: (rs, dir) => rs
            .filter(r => r.vwapSig && r.vwapSig !== 'NEUTRAL')
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
        { key: 'crossover', label: 'Vol Crossover', render: r => {
          if (!r.crossover) return el('td', { class: 'mono dim' }, '—');
          const tone = r.crossover === 'PE Cross Up' ? 'bull' : 'bear';
          return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px', fontWeight: '700' } }, r.crossover));
        },
          sortFilter: (rs, dir) => rs
            .filter(r => r.crossover)
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
        { key: 'alertRank', label: 'Alert',
          render: r => {
            const tone = r.alert === 'STRONG CE' ? 'bear' : r.alert === 'STRONG PE' ? 'bull' : 'neutral';
            return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px', fontWeight: '700' } }, r.alert));
          },
          sortFilter: (rs, dir) => rs
            .filter(r => r.alert !== 'NEUTRAL')
            .sort((a, b) => dir === 'asc'
              ? String(a.timestamp).localeCompare(String(b.timestamp))
              : String(b.timestamp).localeCompare(String(a.timestamp))),
        },
      ];

      const t = buildSortableTable(cols, display);

      volumeLogsContent.innerHTML = '';
      volumeLogsContent.appendChild(miniSummary);
      volumeLogsContent.appendChild(miniSummary2);
      volumeLogsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      if (!silent) volumeLogsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // LTP STRENGTH TAB — Dr. Vijay's LTP-Based Option Strength engine
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Per-5s: ATM, CE_SUM / PE_SUM (Σ SessionChange of ATM+3 ITM each side),
  // Directional Strength (CE_SUM−PE_SUM), Rolling 5-min Strength, 5s & 1-min
  // momentum, Spot vs VWAP, market state and the strict Current Signal
  // (BUY CE / BUY PE only when all STEP 12/13 conditions agree).
  const ltpStrengthContent = el('div');
  buildTabToolbar(ltpStrengthPanel, 'ltp-strength', (controls) => {
    const exportBtn = el('button', { class: 'btn secondary sm', onclick: exportLtpStrengthCSV }, 'Export CSV');
    controls.append(el('div', { class: 'spacer' }), exportBtn);
  });
  ltpStrengthPanel.appendChild(ltpStrengthContent);

  function _ltpSignalLabel(r) {
    // strict actionable signal first, else the market-state quadrant
    if (r.signal === 'BUY') return { text: 'BUY CALL', tone: 'bull' };
    if (r.signal === 'SELL') return { text: 'BUY PUT', tone: 'bear' };
    const s = r.market_state || '—';
    const tone = s.startsWith('BUY CE') ? 'bull' : s.startsWith('BUY PE') ? 'bear'
      : s.startsWith('IV Expansion') ? 'neutral' : s.startsWith('IV Crush') ? 'neutral' : 'neutral';
    return { text: s, tone };
  }

  async function exportLtpStrengthCSV() {
    const ts = tabState['ltp-strength'];
    if (!ts.instrument || !ts.date) { toast('Select instrument and date first', 'error'); return; }
    toast('Exporting LTP strength…', 'info');
    try {
      const rows = await api.ltpStrength(ts.instrument, ts.date);
      const data = filterMarketHours(rows);
      if (!data.length) { toast('No data to export', 'error'); return; }
      const headers = ['Time', 'ATM', 'Spot', 'CE_SUM', 'PE_SUM', 'Directional_Strength',
        'Rolling_Strength', 'Momentum_5s', 'Momentum_1m', 'VWAP', 'VWAP_Status',
        'Market_State', 'Current_Signal'];
      const csv = [headers.join(',')];
      for (const r of data) {
        csv.push([r.timestamp, r.atm, r.spot, r.ce_sum, r.pe_sum, r.directional_strength,
          r.rolling_strength, r.momentum_5s, r.momentum_1m, r.vwap ?? '', r.vwap_status,
          (r.market_state || '').replace(/,/g, ''),
          r.signal === 'BUY' ? 'BUY CALL' : r.signal === 'SELL' ? 'BUY PUT' : ''].join(','));
      }
      const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ltp-strength-${ts.instrument}-${ts.date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${data.length} rows`, 'success');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }

  async function renderLtpStrength(silent = false) {
    if (!silent) ltpStrengthContent.innerHTML = '<div class="dim" style="padding:24px">Loading LTP strength…</div>';
    const ts = tabState['ltp-strength'];
    if (!ts.instrument || !ts.date) {
      ltpStrengthContent.innerHTML = '<div class="empty-state">Select a date to view LTP Strength.</div>';
      return;
    }
    try {
      const latest = await api.ltpStrengthSnapshot(ts.instrument, ts.date);
      if (!latest) {
        ltpStrengthContent.innerHTML = '<div class="empty-state">No LTP strength data for this date.</div>';
        return;
      }
      const sigInfo = _ltpSignalLabel(latest);

      const card = (label, valEl) => el('div', { class: 'card', style: { padding: '12px 16px', flex: '1', minWidth: '120px' } },
        el('span', { class: 'text-xs muted' }, label), valEl);
      const num = (v, tone) => el('div', { class: `mono ${tone || ''}`, style: { fontWeight: '700', fontSize: '16px' } },
        v == null ? '—' : (typeof v === 'number' ? (v >= 0 ? '+' : '') + fmtNum(v, 1) : String(v)));

      // Row 1 — STEP 16 dashboard
      const row1 = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' } },
        card('ATM', el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, String(latest.atm))),
        card('Spot', el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, fmtNum(latest.spot, 2))),
        card('CE_SUM', num(latest.ce_sum, latest.ce_sum >= 0 ? 'bull' : 'bear')),
        card('PE_SUM', num(latest.pe_sum, latest.pe_sum >= 0 ? 'bull' : 'bear')),
        card('Directional Strength', num(latest.directional_strength, latest.directional_strength >= 0 ? 'bull' : 'bear')),
        card('Rolling Strength', num(latest.rolling_strength, latest.rolling_strength >= 0 ? 'bull' : 'bear')),
      );
      // Row 2
      const row2 = el('div', { style: { display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' } },
        card('5s Momentum', num(latest.momentum_5s, latest.momentum_5s >= 0 ? 'bull' : 'bear')),
        card('1m Momentum', num(latest.momentum_1m, latest.momentum_1m >= 0 ? 'bull' : 'bear')),
        card('VWAP', el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, latest.vwap != null ? fmtNum(latest.vwap, 2) : '—')),
        card('VWAP Status', el('div', {}, el('span', { class: `change-pill ${latest.vwap_status === 'Above' ? 'bull' : latest.vwap_status === 'Below' ? 'bear' : 'neutral'}`, style: { fontSize: '11px', fontWeight: '700' } }, latest.vwap_status))),
        card('Current Signal', el('div', {}, el('span', { class: `change-pill ${sigInfo.tone}`, style: { fontSize: '11px', fontWeight: '700' } }, sigInfo.text))),
      );

      // ── Strike-bucket breakdown: how CE_SUM / PE_SUM are built ──
      // Each side: ATM + 3 ITM strikes with 09:15 baseline LTP, current LTP,
      // session change (vs baseline) and rolling change (vs 5 min ago).
      const buildBucket = (title, bucket, sumLabel, sumVal) => {
        const wrap = el('div', { class: 'card', style: { padding: '14px 16px' } });
        wrap.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' } },
          el('div', { style: { fontSize: '13px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px' } }, title),
          el('div', { class: `mono ${sumVal >= 0 ? 'bull' : 'bear'}`, style: { fontWeight: '700', fontSize: '15px' } }, `${sumLabel} ${sumVal >= 0 ? '+' : ''}${fmtNum(sumVal, 1)}`),
        ));
        const table = el('table', { class: 'data-grid', style: { width: '100%' } });
        const thead = el('thead'); const hr = el('tr');
        ['Bucket', 'Strike', 'Baseline LTP', 'Current LTP', 'Session Δ', 'Rolling Δ'].forEach(h => hr.appendChild(el('th', {}, h)));
        thead.appendChild(hr); table.appendChild(thead);
        const tbody = el('tbody');
        (bucket || []).forEach((b, i) => {
          const tr = el('tr', { style: i === 0 ? { background: 'rgba(255,255,255,0.04)', fontWeight: '600' } : {} });
          tr.appendChild(el('td', { class: 'mono', style: i === 0 ? { color: 'var(--accent)' } : {} }, b.label));
          tr.appendChild(el('td', { class: 'mono' }, String(b.strike)));
          tr.appendChild(el('td', { class: 'mono dim' }, b.ref_ltp != null ? fmtNum(b.ref_ltp, 2) : '—'));
          tr.appendChild(el('td', { class: 'mono' }, b.cur_ltp != null ? fmtNum(b.cur_ltp, 2) : '—'));
          tr.appendChild(el('td', { class: `mono ${(b.session_change ?? 0) >= 0 ? 'bull' : 'bear'}` }, b.session_change != null ? (b.session_change >= 0 ? '+' : '') + fmtNum(b.session_change, 2) : '—'));
          tr.appendChild(el('td', { class: `mono ${(b.rolling_change ?? 0) >= 0 ? 'bull' : 'bear'}` }, b.rolling_change != null ? (b.rolling_change >= 0 ? '+' : '') + fmtNum(b.rolling_change, 2) : '—'));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody); wrap.appendChild(table);
        return wrap;
      };

      const buckets = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        buildBucket('Call Strikes (CE)', latest.ce_bucket, 'CE_SUM', latest.ce_sum),
        buildBucket('Put Strikes (PE)', latest.pe_bucket, 'PE_SUM', latest.pe_sum),
      );

      const asOf = el('div', { class: 'dim text-xs mono', style: { marginTop: '10px' } },
        `As of ${fmtTimeIST(latest.timestamp)} · ${latest.ticks} ticks · baseline = first tick @ 09:15 · market state: ${latest.market_state}`);

      ltpStrengthContent.innerHTML = '';
      ltpStrengthContent.appendChild(row1);
      ltpStrengthContent.appendChild(row2);
      ltpStrengthContent.appendChild(buckets);
      ltpStrengthContent.appendChild(asOf);
    } catch (e) {
      if (!silent) ltpStrengthContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S/R (SUPPORT & RESISTANCE) TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Implements the institutional Support/Resistance engine:
  //   * Imaginary pair = strike just below spot + strike just above spot
  //   * Resistance: scan 5 CE strikes from pair_lower upward; primary = strike
  //     with the highest combined %-rank across (OI, Volume, Chg OI)
  //   * Support: scan 5 PE strikes from pair_upper downward; same logic
  //   * WTT (Weak Towards Top): strike ABOVE primary resistance has avg pct >75
  //   * WTB (Weak Towards Bottom): strike BELOW primary support has avg pct >75
  //   * Intraday shift history is accumulated client-side per (instr, date)
  const srContent = el('div');
  buildTabToolbar(srPanel, 'sr');
  srPanel.appendChild(srContent);

  function _srPickPair(spot, strikes) {
    if (spot == null || !strikes.length) return null;
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    let lower = null, upper = null;
    for (const s of sorted) {
      if (s.strike <= spot) lower = s;
      if (s.strike > spot && upper == null) upper = s;
    }
    if (!lower || !upper) return null;
    return { lower, upper, all: sorted };
  }

  // Build a 5-strike scan window: for CE/resistance start at pair.lower and
  // walk up; for PE/support start at pair.upper and walk down.
  function _srScan(pair, side) {
    if (!pair) return [];
    const sorted = pair.all;
    const startStrike = side === 'CE' ? pair.lower.strike : pair.upper.strike;
    const startIdx = sorted.findIndex(s => s.strike === startStrike);
    if (startIdx < 0) return [];
    const step = side === 'CE' ? 1 : -1;
    const out = [];
    for (let i = 0; i < 5; i++) {
      const idx = startIdx + i * step;
      if (idx < 0 || idx >= sorted.length) break;
      out.push(sorted[idx]);
    }
    return out;
  }

  // For each row, compute oi/vol/chg as percentages of the column max,
  // then a "combined %" = average of the three. Highest combined = primary.
  function _srPercentRows(scan, side) {
    const get = (r) => side === 'CE'
      ? { oi: r.ce_oi, vol: r.ce_volume, chg: r.ce_chg_oi }
      : { oi: r.pe_oi, vol: r.pe_volume, chg: r.pe_chg_oi };
    const vals = scan.map(get);
    const maxOi = Math.max(0, ...vals.map(v => v.oi || 0));
    const maxVol = Math.max(0, ...vals.map(v => v.vol || 0));
    const maxChg = Math.max(0, ...vals.map(v => Math.max(0, v.chg || 0)));
    const out = scan.map((r, i) => {
      const v = vals[i];
      const oiPct = maxOi > 0 ? (v.oi / maxOi) * 100 : 0;
      const volPct = maxVol > 0 ? (v.vol / maxVol) * 100 : 0;
      const chgPct = maxChg > 0 ? (Math.max(0, v.chg) / maxChg) * 100 : 0;
      return {
        strike: r.strike, oi: v.oi, vol: v.vol, chg: v.chg,
        oiPct, volPct, chgPct,
        combinedPct: (oiPct + volPct + chgPct) / 3,
      };
    });
    let primaryIdx = 0;
    for (let i = 1; i < out.length; i++) if (out[i].combinedPct > out[primaryIdx].combinedPct) primaryIdx = i;
    return { rows: out, primaryIdx };
  }

  // WTT / WTB: nearby strike (the next one in scan order after primary) has
  // avg percentage >75 — meaning the wall could shift one step further.
  function _srWeakness(percentRows, primaryIdx) {
    const nextIdx = primaryIdx + 1;
    if (nextIdx >= percentRows.length) return false;
    const r = percentRows[nextIdx];
    const avg = (r.oiPct + r.volPct + r.chgPct) / 3;
    return avg > 75;
  }

  // History is keyed by instrument+date so polling re-renders preserve it.
  const srShiftHistory = new Map();
  function _srHistoryKey(instrument, date) { return `${instrument}|${date}`; }
  function _srRecordShift(instrument, date, snapshot) {
    const key = _srHistoryKey(instrument, date);
    if (!srShiftHistory.has(key)) srShiftHistory.set(key, []);
    const hist = srShiftHistory.get(key);
    const prev = hist[hist.length - 1];
    if (prev && prev.support === snapshot.support && prev.resistance === snapshot.resistance
        && prev.wtb === snapshot.wtb && prev.wtt === snapshot.wtt) {
      return hist; // no change, skip
    }
    let direction = 'Init';
    if (prev) {
      const supUp = snapshot.support > prev.support;
      const supDn = snapshot.support < prev.support;
      const resUp = snapshot.resistance > prev.resistance;
      const resDn = snapshot.resistance < prev.resistance;
      if ((supUp && resUp) || (supUp && !resDn) || (!supDn && resUp)) direction = 'Bullish';
      else if ((supDn && resDn) || (supDn && !resUp) || (!supUp && resDn)) direction = 'Bearish';
      else direction = 'Range';
    }
    hist.push({ ...snapshot, direction });
    return hist;
  }

  async function renderSR(silent = false) {
    if (!silent) srContent.innerHTML = '<div class="dim" style="padding:24px">Loading option chain…</div>';
    const ts = tabState['sr'];
    if (!ts.instrument || !ts.date) {
      srContent.innerHTML = '<div class="empty-state">Select a date to view Support/Resistance.</div>';
      return;
    }
    try {
      const histKey = _srHistoryKey(ts.instrument, ts.date);
      // Seed history from backend if first load for this instrument+date
      if (!srShiftHistory.has(histKey)) {
        try {
          const backfill = await api.srHistory(ts.instrument, ts.date);
          if (Array.isArray(backfill) && backfill.length) {
            srShiftHistory.set(histKey, backfill);
          }
        } catch (_) {}
      }

      const payload = await api.optionChain(ts.instrument, ts.date);
      if (!payload || !payload.strikes?.length) {
        srContent.innerHTML = '<div class="empty-state">No option-chain data for this date.</div>';
        return;
      }
      const spot = payload.spot_price;
      const pair = _srPickPair(spot, payload.strikes);
      if (!pair) {
        srContent.innerHTML = '<div class="empty-state">Could not bracket spot with strikes.</div>';
        return;
      }
      const ceScan = _srScan(pair, 'CE');
      const peScan = _srScan(pair, 'PE');
      const ceData = _srPercentRows(ceScan, 'CE');
      const peData = _srPercentRows(peScan, 'PE');
      const primaryResistance = ceData.rows[ceData.primaryIdx]?.strike;
      const primarySupport = peData.rows[peData.primaryIdx]?.strike;
      const isWTT = _srWeakness(ceData.rows, ceData.primaryIdx);
      const isWTB = _srWeakness(peData.rows, peData.primaryIdx);

      const hist = _srRecordShift(ts.instrument, ts.date, {
        timestamp: payload.timestamp,
        spot,
        pairLow: pair.lower.strike,
        pairHigh: pair.upper.strike,
        support: primarySupport,
        resistance: primaryResistance,
        wtt: isWTT,
        wtb: isWTB,
      });

      // ── Summary strip ──
      const lastShift = hist[hist.length - 1];
      const summary = el('div', { class: 'card', style: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '12px' } },
        el('div', {},
          el('span', { class: 'text-xs muted' }, 'Spot'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '18px' } }, fmtNum(spot, 2)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Imaginary Pair'),
          el('div', { class: 'mono', style: { fontWeight: '600' } }, `${pair.lower.strike} / ${pair.upper.strike}`),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Resistance'),
          el('div', { class: 'mono bear', style: { fontWeight: '700', fontSize: '18px' } }, String(primaryResistance ?? '—')),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Support'),
          el('div', { class: 'mono bull', style: { fontWeight: '700', fontSize: '18px' } }, String(primarySupport ?? '—')),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Resistance state'),
          el('div', {}, el('span', { class: `change-pill ${isWTT ? 'bear' : 'neutral'}`, style: { fontSize: '11px', fontWeight: '700' } }, isWTT ? 'WTT' : 'Firm')),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Support state'),
          el('div', {}, el('span', { class: `change-pill ${isWTB ? 'bull' : 'neutral'}`, style: { fontSize: '11px', fontWeight: '700' } }, isWTB ? 'WTB' : 'Firm')),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Shift'),
          el('div', {}, el('span', { class: `change-pill ${lastShift.direction === 'Bullish' ? 'bull' : lastShift.direction === 'Bearish' ? 'bear' : 'neutral'}`, style: { fontSize: '11px', fontWeight: '700' } }, lastShift.direction)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'As of'),
          el('div', { class: 'mono dim text-xs' }, fmtTimeIST(payload.timestamp)),
        ),
      );

      // ── Side-by-side: CE (resistance) and PE (support) tables ──
      const buildSideTable = (title, sideData, primaryStrike) => {
        const wrap = el('div', { class: 'card', style: { padding: '14px 16px' } });
        wrap.appendChild(el('div', { style: { fontSize: '13px', fontWeight: '700', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' } }, title));
        const table = el('table', { class: 'data-grid', style: { width: '100%' } });
        const thead = el('thead');
        const headRow = el('tr');
        ['Strike', 'OI', 'Vol', 'Chg OI', 'OI %', 'Vol %', 'Chg OI %'].forEach(h => headRow.appendChild(el('th', {}, h)));
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = el('tbody');
        sideData.rows.forEach((r, i) => {
          const isPrimary = r.strike === primaryStrike;
          const tr = el('tr', { style: isPrimary ? { background: 'rgba(255,255,255,0.04)', fontWeight: '600' } : {} });
          tr.appendChild(el('td', { class: 'mono', style: isPrimary ? { color: 'var(--accent)' } : {} }, String(r.strike) + (isPrimary ? ' ★' : '')));
          tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.oi)));
          tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.vol)));
          tr.appendChild(el('td', { class: `mono ${r.chg >= 0 ? 'bull' : 'bear'}` }, (r.chg >= 0 ? '+' : '') + fmtCompact(r.chg)));
          const pctCell = (pct) => el('td', { class: `mono ${pct >= 75 ? 'bull' : pct >= 50 ? 'neutral' : 'dim'}` }, fmtNum(pct, 0) + '%');
          tr.appendChild(pctCell(r.oiPct));
          tr.appendChild(pctCell(r.volPct));
          tr.appendChild(pctCell(r.chgPct));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
      };

      const sidesRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' } },
        buildSideTable('Resistance (CE scan ↑)', ceData, primaryResistance),
        buildSideTable('Support (PE scan ↓)', peData, primarySupport),
      );

      // ── Intraday shift history ──
      const histCard = el('div', { class: 'card', style: { padding: '14px 16px' } });
      histCard.appendChild(el('div', { style: { fontSize: '13px', fontWeight: '700', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' } }, `Intraday Shift History (${hist.length})`));
      const histTable = el('table', { class: 'data-grid', style: { width: '100%' } });
      const histHead = el('thead');
      const histHeadRow = el('tr');
      ['Time', 'Spot', 'Pair', 'Support', 'Resistance', 'WTB', 'WTT', 'Direction'].forEach(h => histHeadRow.appendChild(el('th', {}, h)));
      histHead.appendChild(histHeadRow);
      histTable.appendChild(histHead);
      const histBody = el('tbody');
      [...hist].reverse().forEach(h => {
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(h.timestamp)));
        tr.appendChild(el('td', { class: 'mono' }, fmtNum(h.spot, 2)));
        tr.appendChild(el('td', { class: 'mono dim' }, `${h.pairLow}/${h.pairHigh}`));
        tr.appendChild(el('td', { class: 'mono bull' }, String(h.support ?? '—')));
        tr.appendChild(el('td', { class: 'mono bear' }, String(h.resistance ?? '—')));
        tr.appendChild(el('td', {}, h.wtb ? el('span', { class: 'change-pill bull', style: { fontSize: '10px' } }, 'WTB') : el('span', { class: 'mono dim' }, '—')));
        tr.appendChild(el('td', {}, h.wtt ? el('span', { class: 'change-pill bear', style: { fontSize: '10px' } }, 'WTT') : el('span', { class: 'mono dim' }, '—')));
        const tone = h.direction === 'Bullish' ? 'bull' : h.direction === 'Bearish' ? 'bear' : 'neutral';
        tr.appendChild(el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px', fontWeight: '700' } }, h.direction)));
        histBody.appendChild(tr);
      });
      histTable.appendChild(histBody);
      histCard.appendChild(el('div', { class: 'data-grid-wrap', style: { maxHeight: '320px' } }, histTable));

      srContent.innerHTML = '';
      srContent.appendChild(summary);
      srContent.appendChild(sidesRow);
      srContent.appendChild(histCard);
    } catch (e) {
      if (!silent) srContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ENTRY SIGNALS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const oiChangeLogsContent = el('div');
  buildTabToolbar(oiChangeLogsPanel, 'oi-change-logs', (controls) => {
    const esExportBtn = el('button', { class: 'btn secondary sm', onclick: exportOiChangeLogsCSV }, 'Export CSV');
    controls.append(el('div', { class: 'spacer' }), esExportBtn);
  });
  oiChangeLogsPanel.appendChild(oiChangeLogsContent);

  async function exportOiChangeLogsCSV() {
    const ts = tabState['oi-change-logs'];
    if (!ts.instrument || !ts.date) { toast('Select instrument and date first', 'error'); return; }
    toast('Exporting OI change logs…', 'info');
    try {
      const data = await api.computedTicks(ts.instrument, ts.date);
      const rawTicks = Array.isArray(data) ? data : (data.ticks || data.data || data.rows || []);
      const ticks = filterMarketHours(rawTicks);
      if (!ticks.length) { toast('No data to export', 'error'); return; }
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
      const headers = ['Timestamp', 'CE_OI_Change', 'PE_OI_Change', 'CE_Cumulative', 'PE_Cumulative', 'Difference_PE_minus_CE', 'Signal', 'Crossover'];
      const csvRows = [headers.join(',')];
      for (const r of ticks) {
        const ceCumm = r.ce_oi_cumm_change ?? r.ce_cumulative ?? r.ce_oi_cumm ?? 0;
        const peCumm = r.pe_oi_cumm_change ?? r.pe_cumulative ?? r.pe_oi_cumm ?? 0;
        const crossover = (r.crossover === true || r.crossover === 1 || r.crossover === 'TRUE' || r.crossover === 'true') ? 'TRUE' : 'FALSE';
        csvRows.push([
          r.timestamp,
          r.ce_oi_change ?? r.ce_oi_chg ?? 0,
          r.pe_oi_change ?? r.pe_oi_chg ?? 0,
          ceCumm,
          peCumm,
          peCumm - ceCumm,
          (r.signal || '').toUpperCase() || '',
          crossover,
        ].join(','));
      }
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `oi-change-logs-${ts.instrument}-${ts.date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${ticks.length} rows`, 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  }

  async function renderOiChangeLogs(silent = false) {
    if (!silent) oiChangeLogsContent.innerHTML = '<div class="dim" style="padding:24px">Loading OI change logs…</div>';
    const ts = tabState['oi-change-logs'];
    if (!ts.instrument || !ts.date) {
      oiChangeLogsContent.innerHTML = '<div class="empty-state">Select a date to view OI Change Logs.</div>';
      return;
    }
    try {
      const data = await api.computedTicks(ts.instrument, ts.date);
      const rawTicks = Array.isArray(data) ? data : (data.ticks || data.data || data.rows || []);
      const ticks = filterMarketHours(rawTicks);
      if (!ticks.length) {
        oiChangeLogsContent.innerHTML = '<div class="empty-state">No computed ticks for this date.</div>';
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

      oiChangeLogsContent.innerHTML = '';

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
      oiChangeLogsContent.appendChild(summaryStrip);

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
            return el('td', {}, el('span', { class: `change-pill ${tone}`, style: { fontSize: '10px' } }, crossoverLabel(r.signal)));
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
      oiChangeLogsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));

    } catch (e) {
      if (!silent) oiChangeLogsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ENTRY SIGNALS TAB — the actual trade triggers, OI + Volume merged
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // One chronological feed of every entry trigger the trade engine sees,
  // tagged by source. Direction → leg is fixed: BUY → CE, SELL → PE.
  //   OI source     — computed_ticks crossovers (signal BUY/SELL)
  //   Volume source — running-cumulative volume-diff sign flips, identical
  //                   to the Volume Logs "CE/PE Volume Crossover" column
  // A trigger is "Confirmed" when the other source fired the same direction
  // within ±5 min — i.e. where the 'combined' signal_mode would enter.
  const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
  const entrySignalsContent = el('div');
  buildTabToolbar(entrySignalsPanel, 'entry-signals', (controls) => {
    const exportBtn = el('button', { class: 'btn secondary sm', onclick: exportEntrySignalsCSV }, 'Export CSV');
    controls.append(el('div', { class: 'spacer' }), exportBtn);
  });
  entrySignalsPanel.appendChild(entrySignalsContent);

  async function _buildEntrySignals(instrument, date) {
    const [oiRaw, vData] = await Promise.all([
      api.computedTicks(instrument, date).catch(() => []),
      _fetchVolumeData(instrument, date).catch(() => null),
    ]);
    const ticks = filterMarketHours(Array.isArray(oiRaw) ? oiRaw : (oiRaw.ticks || oiRaw.data || oiRaw.rows || []));
    const oiEvents = ticks
      .filter(t => { const s = (t.signal || '').toUpperCase(); return s === 'BUY' || s === 'SELL'; })
      .map(t => ({
        timestamp: t.timestamp,
        source: 'OI',
        signal: (t.signal || '').toUpperCase(),
        metricLabel: 'OI Diff',
        metricValue: t.oi_difference ?? null,
      }));
    const vMetrics = vData ? _computeVolumeMetrics(vData.summaryRows, vData.oiDiffByTs) : [];
    const volEvents = vMetrics
      .filter(m => m.crossover)
      .map(m => ({
        timestamp: m.timestamp,
        source: 'Volume',
        signal: m.crossover === 'PE Cross Up' ? 'BUY' : 'SELL',
        metricLabel: 'Vol Diff',
        metricValue: m.volDiff,
      }));
    const events = [...oiEvents, ...volEvents];
    // Mark confirmation: opposite source, same direction, within the window
    events.forEach(e => {
      const t = new Date(e.timestamp).getTime();
      e.confirmed = events.some(o =>
        o.source !== e.source &&
        o.signal === e.signal &&
        Math.abs(new Date(o.timestamp).getTime() - t) <= CONFIRM_WINDOW_MS);
      e.side = e.signal === 'BUY' ? 'CE' : 'PE';
    });
    events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return events;
  }

  async function exportEntrySignalsCSV() {
    const ts = tabState['entry-signals'];
    if (!ts.instrument || !ts.date) { toast('Select instrument and date first', 'error'); return; }
    toast('Exporting entry signals…', 'info');
    try {
      const events = await _buildEntrySignals(ts.instrument, ts.date);
      if (!events.length) { toast('No entry signals to export', 'error'); return; }
      const headers = ['Time', 'Source', 'Signal', 'Side', 'Metric', 'Metric_Value', 'Confirmed'];
      const csvRows = [headers.join(',')];
      for (const e of events) {
        csvRows.push([
          e.timestamp, e.source, e.signal, e.side, e.metricLabel,
          e.metricValue ?? '', e.confirmed ? 'YES' : 'NO',
        ].join(','));
      }
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `entry-signals-${ts.instrument}-${ts.date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${events.length} rows`, 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  }

  async function renderEntrySignals(silent = false) {
    if (!silent) entrySignalsContent.innerHTML = '<div class="dim" style="padding:24px">Loading entry signals…</div>';
    const ts = tabState['entry-signals'];
    if (!ts.instrument || !ts.date) {
      entrySignalsContent.innerHTML = '<div class="empty-state">Select a date to view Entry Signals.</div>';
      return;
    }
    try {
      const events = await _buildEntrySignals(ts.instrument, ts.date);
      if (!events.length) {
        entrySignalsContent.innerHTML = '<div class="empty-state">No entry signals for this date.</div>';
        return;
      }
      const oiCount = events.filter(e => e.source === 'OI').length;
      const volCount = events.filter(e => e.source === 'Volume').length;
      const confirmedCount = events.filter(e => e.confirmed).length;
      const latest = events[events.length - 1];

      const summaryStrip = el('div', { class: 'card', style: { display: 'flex', gap: '28px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '16px' } },
        el('div', {},
          el('span', { class: 'text-xs muted' }, 'Total Triggers'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px' } }, String(events.length)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'OI Signals'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px', color: 'var(--accent)' } }, String(oiCount)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Volume Signals'),
          el('div', { class: 'mono', style: { fontWeight: '700', fontSize: '16px', color: '#c6c0ff' } }, String(volCount)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Confirmed (combined)'),
          el('div', { class: 'mono bull', style: { fontWeight: '700', fontSize: '16px' } }, String(confirmedCount)),
        ),
        el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
          el('span', { class: 'text-xs muted' }, 'Latest'),
          el('div', {}, el('span', { class: `change-pill ${latest.signal === 'BUY' ? 'bull' : 'bear'}`, style: { fontSize: '10px' } }, crossoverLabel(latest.signal))),
        ),
      );

      // Latest at top
      const rows = [...events].reverse().map(e => ({
        ...e,
        sourceRank: e.source === 'OI' ? 1 : 0,
        signalRank: e.signal === 'BUY' ? 1 : -1,
        confirmedRank: e.confirmed ? 1 : 0,
      }));

      const cols = [
        { key: 'timestamp', label: 'Time', render: r => el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)) },
        { key: 'sourceRank', label: 'Source', render: r => {
          const tone = r.source === 'OI' ? 'neutral' : 'neutral';
          const color = r.source === 'OI' ? 'var(--accent)' : '#c6c0ff';
          return el('td', {}, el('span', { class: 'change-pill', style: { fontSize: '10px', fontWeight: '700', color, borderColor: color } }, r.source));
        } },
        { key: 'signalRank', label: 'Signal', render: r =>
          el('td', {}, el('span', { class: `change-pill ${r.signal === 'BUY' ? 'bull' : 'bear'}`, style: { fontSize: '10px', fontWeight: '700' } }, crossoverLabel(r.signal))) },
        { key: 'side', label: 'Side', render: r =>
          el('td', { class: `mono ${r.side === 'CE' ? 'bull' : 'bear'}`, style: { fontWeight: '600' } }, r.side) },
        { key: 'metricValue', label: 'Driving Metric', render: r => {
          if (r.metricValue == null) return el('td', { class: 'mono dim' }, `${r.metricLabel}: —`);
          const tone = r.metricValue >= 0 ? 'bull' : 'bear';
          return el('td', { class: `mono ${tone}` }, `${r.metricLabel}: ${(r.metricValue >= 0 ? '+' : '') + fmtCompact(r.metricValue)}`);
        } },
        { key: 'confirmedRank', label: 'Confirmed', render: r =>
          r.confirmed
            ? el('td', {}, el('span', { class: 'change-pill bull', style: { fontSize: '10px', fontWeight: '700' } }, '✓ both'))
            : el('td', { class: 'mono dim' }, '—') },
      ];

      const t = buildSortableTable(cols, rows);
      entrySignalsContent.innerHTML = '';
      entrySignalsContent.appendChild(summaryStrip);
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
      allRows = filterMarketHours(res.rows || []);

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
    const rawRows = Array.isArray(oiData) ? oiData : (oiData.data || oiData.rows || []);
    const rows = filterMarketHours(rawRows);
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
      filterMarketHours(res.rows || []).forEach(r => {
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
    if (activeTab === 'volume-logs') renderVolumeLogs(true);
    else if (activeTab === 'ltp-strength') renderLtpStrength(true);
    else if (activeTab === 'sr') renderSR(true);
    else if (activeTab === 'oi-change-logs') renderOiChangeLogs(true);
    else if (activeTab === 'entry-signals') renderEntrySignals(true);
  }, 60000);
}

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
