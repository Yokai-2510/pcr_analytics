// pages/data.js — Snapshots data explorer (4-tab: OI Analytics / OI Logs / Indicators / All Logs)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, fmtSigned, fmtPct, icon, Select, DateSelect } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { INDICATOR_DEFS, buildSignedPcrSeries, computeAll } from '../indicators.js';

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let activeTab = 'oi-analytics'; // 'oi-analytics' | 'oi-logs' | 'indicators' | 'all-logs'
let pollTimer = null;

// Per-tab instrument/date state so each tab remembers its own selection
const tabState = {
  'oi-analytics': { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'oi-logs':      { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
  'indicators':   { instrument: 'nifty', date: new Date().toISOString().slice(0, 10) },
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
    { id: 'indicators', label: 'Indicators' },
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
  const indicatorsPanel = el('div', { class: 'tab-panel' });
  const allLogsPanel = el('div', { class: 'tab-panel' });

  page.appendChild(oiAnalyticsPanel);
  page.appendChild(oiLogsPanel);
  page.appendChild(indicatorsPanel);
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
        else if (tabId === 'indicators') renderIndicators();
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
        else if (tabId === 'indicators') renderIndicators();
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
    indicatorsPanel.style.display = tabId === 'indicators' ? '' : 'none';
    allLogsPanel.style.display = tabId === 'all-logs' ? '' : 'none';
    if (tabId === 'all-logs') renderBody();
    else if (tabId === 'oi-analytics') renderOiAnalytics();
    else if (tabId === 'oi-logs') renderOiLogs();
    else if (tabId === 'indicators') renderIndicators();
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
      const cols = ['Time', 'CE OI', 'PE OI', 'PCR', 'ΔPCR', 'CE Δ', 'PE Δ', 'Signed PCR', 'Signal'];
      const thead = el('thead');
      const hr = el('tr');
      cols.forEach(c => hr.appendChild(el('th', {}, c)));
      thead.appendChild(hr);
      t.appendChild(thead);

      const tbody = el('tbody');
      // Walk rows top-down (latest first), compute deltas against previous row
      const origSorted = [...summaryRows]; // ascending
      const origIdx = (r) => origSorted.indexOf(r);

      rows.forEach((r, displayIdx) => {
        const oi = origIdx(r);
        const rowPcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const prevRow = oi > 0 ? origSorted[oi - 1] : null;
        const prevPcr = prevRow ? (prevRow.total_pe_oi / prevRow.total_ce_oi) : rowPcr;
        const prevCe = prevRow ? prevRow.total_ce_oi : r.total_ce_oi;
        const prevPe = prevRow ? prevRow.total_pe_oi : r.total_pe_oi;
        const cΔ = r.total_ce_oi - prevCe;
        const pΔ = r.total_pe_oi - prevPe;
        // ΔPCR = PE ΔOI / CE ΔOI (ratio of OI changes, not PCR difference)
        const deltaPcr = (prevRow && Math.abs(cΔ) > 0) ? (pΔ / cΔ) : 0;

        // ── Signed PCR (Dr. Vijay Bhilwade methodology) ──
        // PCR = |PE ΔOI| / |CE ΔOI|
        // Sign: same-sign → + if PCR>1 else -; diff-sign → sign of PE ΔOI
        const absCe = Math.abs(cΔ);
        const absPe = Math.abs(pΔ);
        let signedPcr = null;
        let signal = '—';
        if (prevRow && absCe > 0) {
          const pcrMag = absPe / absCe;
          let sign;
          if ((pΔ >= 0 && cΔ >= 0) || (pΔ <= 0 && cΔ <= 0)) {
            // Same direction: compare relative strength
            sign = pcrMag > 1 ? 1 : -1;
          } else {
            // Opposite direction: sign follows PE ΔOI
            sign = pΔ >= 0 ? 1 : -1;
          }
          signedPcr = sign * pcrMag;
          if (signedPcr > 0) {
            signal = signedPcr >= 1 ? 'Strong Bull' : 'Bull';
          } else {
            signal = signedPcr <= -1 ? 'Strong Bear' : 'Bear';
          }
        }

        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_ce_oi)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_pe_oi)));
        tr.appendChild(el('td', { class: `mono ${rowPcr >= 1 ? 'bull' : 'bear'}` }, fmtNum(rowPcr, 3)));
        tr.appendChild(el('td', { class: `mono ${deltaPcr >= 0 ? 'bull' : 'bear'}` }, (deltaPcr >= 0 ? '+' : '') + fmtNum(deltaPcr, 3)));
        tr.appendChild(el('td', { class: `mono ${cΔ >= 0 ? 'bull' : 'bear'}` }, (cΔ >= 0 ? '+' : '') + fmtCompact(cΔ)));
        tr.appendChild(el('td', { class: `mono ${pΔ >= 0 ? 'bull' : 'bear'}` }, (pΔ >= 0 ? '+' : '') + fmtCompact(pΔ)));
        // Signed PCR
        if (signedPcr != null) {
          const spcrTone = signedPcr > 0 ? 'bull' : signedPcr < 0 ? 'bear' : '';
          tr.appendChild(el('td', { class: `mono ${spcrTone}`, style: { fontWeight: '600' } }, (signedPcr >= 0 ? '+' : '') + fmtNum(signedPcr, 3)));
        } else {
          tr.appendChild(el('td', { class: 'mono dim' }, '—'));
        }
        // Signal
        const sigTone = signal.startsWith('Strong Bull') ? 'bull' : signal === 'Bull' ? 'bull' : signal.startsWith('Strong Bear') ? 'bear' : signal === 'Bear' ? 'bear' : '';
        const sigClass = sigTone === 'bull' ? 'change-pill bull' : sigTone === 'bear' ? 'change-pill bear' : 'change-pill neutral';
        tr.appendChild(el('td', {}, el('span', { class: sigClass, style: { fontSize: '10px' } }, signal)));
        tbody.appendChild(tr);
      });
      t.appendChild(tbody);

      oiLogsContent.innerHTML = '';
      oiLogsContent.appendChild(miniSummary);
      oiLogsContent.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      if (!silent) oiLogsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INDICATORS TAB
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const indicatorsContent = el('div');
  buildTabToolbar(indicatorsPanel, 'indicators');
  indicatorsPanel.appendChild(indicatorsContent);

  // Indicator params state (persisted to localStorage)
  let indicatorParams = {};
  try { indicatorParams = JSON.parse(localStorage.getItem('indicatorParams') || '{}'); } catch {}
  // Apply defaults for missing
  for (const def of INDICATOR_DEFS) {
    if (!indicatorParams[def.id]) {
      indicatorParams[def.id] = {};
      for (const c of def.configs) {
        indicatorParams[def.id][c.key] = c.default;
      }
    }
  }

  function saveIndicatorParams() {
    localStorage.setItem('indicatorParams', JSON.stringify(indicatorParams));
  }

  async function renderIndicators(silent = false) {
    if (!silent) indicatorsContent.innerHTML = '<div class="dim" style="padding:24px">Loading…</div>';
    const ts = tabState['indicators'];
    if (!ts.instrument || !ts.date) {
      indicatorsContent.innerHTML = '<div class="empty-state">Select a date to view indicators.</div>';
      return;
    }
    try {
      const data = await _fetchOiData(ts.instrument, ts.date);
      if (!data || !data.summaryRows.length) {
        indicatorsContent.innerHTML = '<div class="empty-state">No OI data for this date.</div>';
        return;
      }
      const series = buildSignedPcrSeries(data.summaryRows);
      const results = computeAll(series, indicatorParams);

      indicatorsContent.innerHTML = '';

      // ── Config panel (left) + Results table (right) ──
      const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: '16px', alignItems: 'start' } });

      // Config panel
      const cfgPanel = el('div', { class: 'card', style: { position: 'sticky', top: '72px' } });
      cfgPanel.appendChild(el('div', { style: { fontSize: '14px', fontWeight: '600', marginBottom: '14px' } }, 'Indicator Config'));

      for (const def of INDICATOR_DEFS) {
        const section = el('div', { style: { marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--border)' } });
        section.appendChild(el('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--accent)', marginBottom: '4px' } }, def.name));
        section.appendChild(el('div', { class: 'text-xs dim', style: { marginBottom: '8px' } }, def.description));

        for (const cfg of def.configs) {
          const currentVal = indicatorParams[def.id]?.[cfg.key] ?? cfg.default;
          const input = el('input', {
            type: 'number', min: String(cfg.min), max: String(cfg.max),
            step: String(cfg.step || 1), value: String(currentVal),
            style: { width: '80px', height: '28px', fontSize: '11px' },
          });
          input.addEventListener('change', () => {
            let v = parseFloat(input.value);
            if (isNaN(v)) v = cfg.default;
            v = Math.max(cfg.min, Math.min(cfg.max, v));
            input.value = String(v);
            indicatorParams[def.id][cfg.key] = v;
            saveIndicatorParams();
            renderIndicatorResults(series, results = computeAll(series, indicatorParams));
          });
          const row = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
            el('span', { class: 'label', style: { minWidth: '100px' } }, cfg.label), input
          );
          section.appendChild(row);
        }
        cfgPanel.appendChild(section);
      }
      layout.appendChild(cfgPanel);

      // Results area
      const resultsArea = el('div');
      layout.appendChild(resultsArea);
      indicatorsContent.appendChild(layout);

      renderIndicatorResults(series, results);

    } catch (e) {
      if (!silent) indicatorsContent.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  function renderIndicatorResults(series, results) {
    const resultsArea = indicatorsContent.querySelector('div:last-child');
    if (!resultsArea) return;
    resultsArea.innerHTML = '';

    // Summary strip
    const latest = series[series.length - 1];
    const strip = el('div', { class: 'card', style: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px', marginBottom: '16px' } },
      el('div', {},
        el('span', { class: 'text-xs muted' }, 'Latest Signed PCR'),
        el('div', { class: `mono ${latest?.signedPcr > 0 ? 'bull' : latest?.signedPcr < 0 ? 'bear' : ''}`, style: { fontWeight: '700', fontSize: '18px' } },
          latest?.signedPcr != null ? (latest.signedPcr >= 0 ? '+' : '') + latest.signedPcr.toFixed(3) : '—'
        ),
      ),
      el('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '20px' } },
        el('span', { class: 'text-xs muted' }, 'Data Points'),
        el('div', { class: 'mono', style: { fontWeight: '600' } }, String(series.filter(d => d.signedPcr != null).length)),
      ),
    );
    resultsArea.appendChild(strip);

    // One table per indicator
    for (const def of INDICATOR_DEFS) {
      const data = results[def.id];
      if (!data) continue;

      const card = el('div', { class: 'card', style: { marginBottom: '12px' } });
      const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } },
        el('div', {},
          el('div', { style: { fontSize: '13px', fontWeight: '600' } }, def.name),
          el('div', { class: 'text-xs dim' }, def.description),
        ),
      );
      card.appendChild(header);

      const cfg = {};
      for (const c of def.configs) {
        cfg[c.key] = indicatorParams[def.id]?.[c.key] ?? c.default;
      }
      const cfgStr = Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join(', ');
      card.appendChild(el('div', { class: 'mono text-xs dim', style: { marginBottom: '8px' } }, `Config: ${cfgStr}`));

      if (def.outputType === 'bands') {
        // Bollinger / StdDev bands: show latest values + signal
        const bandsData = data; // { upper, middle, lower, signals }
        const lastIdx = series.length - 1;
        const latestUpper = bandsData.upper[lastIdx]?.value;
        const latestMiddle = bandsData.middle[lastIdx]?.value;
        const latestLower = bandsData.lower[lastIdx]?.value;
        const latestSignal = bandsData.signals[lastIdx];

        const valsRow = el('div', { style: { display: 'flex', gap: '20px', marginBottom: '8px', flexWrap: 'wrap' } },
          bandValChip('Upper', latestUpper, 'var(--bear)'),
          bandValChip('Middle', latestMiddle, 'var(--text-muted)'),
          bandValChip('Lower', latestLower, 'var(--bull)'),
          signalChip(latestSignal),
        );
        card.appendChild(valsRow);

        // Table: recent values (last 15)
        const t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, el('tr', {},
          el('th', {}, 'Time'), el('th', {}, 'Signed PCR'), el('th', {}, 'Upper'), el('th', {}, 'Middle'), el('th', {}, 'Lower'), el('th', {}, 'Signal')
        )));
        const tbody = el('tbody');
        const start = Math.max(0, series.length - 15);
        for (let i = series.length - 1; i >= start; i--) {
          const d = series[i];
          const tr = el('tr');
          tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(d.timestamp)));
          tr.appendChild(el('td', { class: `mono ${d.signedPcr > 0 ? 'bull' : d.signedPcr < 0 ? 'bear' : ''}` },
            d.signedPcr != null ? d.signedPcr.toFixed(3) : '—'));
          tr.appendChild(el('td', { class: 'mono' }, bandsData.upper[i]?.value != null ? bandsData.upper[i].value.toFixed(3) : '—'));
          tr.appendChild(el('td', { class: 'mono' }, bandsData.middle[i]?.value != null ? bandsData.middle[i].value.toFixed(3) : '—'));
          tr.appendChild(el('td', { class: 'mono' }, bandsData.lower[i]?.value != null ? bandsData.lower[i].value.toFixed(3) : '—'));
          tr.appendChild(el('td', {}, signalChip(bandsData.signals[i])));
          tbody.appendChild(tr);
        }
        t.appendChild(tbody);
        card.appendChild(el('div', { class: 'data-grid-wrap', style: { maxHeight: '320px' } }, t));

      } else {
        // Single-series indicator: show latest value + signal
        const lastIdx = series.length - 1;
        const latestVal = data[lastIdx]?.value;
        const latestSignal = data[lastIdx]?.signal;

        const valsRow = el('div', { style: { display: 'flex', gap: '20px', marginBottom: '8px', flexWrap: 'wrap' } },
          valChip(def.name, latestVal, def),
          def.hasSignal ? signalChip(latestSignal) : null,
        );
        card.appendChild(valsRow);

        // Table: recent values (last 15)
        const t = el('table', { class: 'data' });
        const cols = ['Time', 'Signed PCR', def.name];
        if (def.hasSignal) cols.push('Signal');
        t.appendChild(el('thead', {}, el('tr', {}, ...cols.map(c => el('th', {}, c)))));
        const tbody = el('tbody');
        const start = Math.max(0, series.length - 15);
        for (let i = series.length - 1; i >= start; i--) {
          const d = series[i];
          const v = data[i];
          const tr = el('tr');
          tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(d.timestamp)));
          tr.appendChild(el('td', { class: `mono ${d.signedPcr > 0 ? 'bull' : d.signedPcr < 0 ? 'bear' : ''}` },
            d.signedPcr != null ? d.signedPcr.toFixed(3) : '—'));
          tr.appendChild(el('td', { class: 'mono' }, v?.value != null ? v.value.toFixed(4) : '—'));
          if (def.hasSignal) tr.appendChild(el('td', {}, signalChip(v?.signal)));
          tbody.appendChild(tr);
        }
        t.appendChild(tbody);
        card.appendChild(el('div', { class: 'data-grid-wrap', style: { maxHeight: '320px' } }, t));
      }

      resultsArea.appendChild(card);
    }
  }

  function valChip(label, value, def) {
    const tone = def.id === 'rsi' ? (value >= 70 ? 'bear' : value <= 30 ? 'bull' : '') :
                 def.id === 'zscore' ? (value >= 2 ? 'bear' : value <= -2 ? 'bull' : '') : '';
    return el('div', { class: 'card', style: { padding: '10px 14px', minWidth: '100px' } },
      el('span', { class: 'text-xs muted' }, label),
      el('div', { class: `mono ${tone}`, style: { fontWeight: '700', fontSize: '16px' } },
        value != null ? value.toFixed(4) : '—'),
    );
  }

  function bandValChip(label, value, color) {
    return el('div', { class: 'card', style: { padding: '10px 14px', minWidth: '80px' } },
      el('span', { class: 'text-xs muted' }, label),
      el('div', { class: 'mono', style: { fontWeight: '600', fontSize: '14px', color } },
        value != null ? value.toFixed(3) : '—'),
    );
  }

  function signalChip(signal) {
    if (!signal) return el('span', { class: 'change-pill neutral' }, '—');
    const tone = signal.includes('Bull') || signal.includes('Oversold') || signal.includes('Low') || signal.includes('Below') ? 'bull' :
                 signal.includes('Bear') || signal.includes('Overbought') || signal.includes('High') || signal.includes('Above') ? 'bear' : 'neutral';
    return el('span', { class: `change-pill ${tone}` }, signal);
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
    if (activeTab === 'all-logs') runQuery(true);
    else if (activeTab === 'oi-analytics') renderOiAnalytics(true);
    else if (activeTab === 'oi-logs') renderOiLogs(true);
    else if (activeTab === 'indicators') renderIndicators(true);
  }, 60000);
}

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
