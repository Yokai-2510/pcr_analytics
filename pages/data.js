// pages/data.js — Snapshots data explorer (clean rewrite)
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, icon, Select, DateSelect } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

// ── State ──────────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let searchQuery = '';
let resampleInterval = 'raw';
let showOiSummary = false;

const state = {
  instrument: 'nifty',
  date: '',
  page: 1,
  page_size: 100,
  sort: [{ column: 'timestamp', dir: 'desc' }],
};

// ── Helpers ────────────────────────────────────────────────────────────
async function fetchAvailableDates(instrument) {
  try {
    const res = await api.dataDistinct('date', `?instrument=${instrument}&limit=5000`);
    return (res.values || []).filter(Boolean);
  } catch { return []; }
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

  // ── Single toolbar card: all controls in one row ──
  const toolbar = el('div', { class: 'data-toolbar' });

  // Row 1: filters + actions
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

  // Action buttons
  const filterBtn = el('button', { class: 'btn ghost sm', onclick: () => openFilterDialog(f => { filters.push(f); rebuild(); }) }, icon('plus'), 'Filter');
  const colsBtn = el('button', { class: 'btn ghost sm', onclick: () => openColumnsDialog(() => rebuild()) }, 'Columns');
  const refreshBtn = el('button', { class: 'btn ghost sm', onclick: runQuery, title: 'Refresh' }, icon('refresh'));
  const oiBtn = el('button', { class: 'btn ghost sm', onclick: () => { showOiSummary = !showOiSummary; oiBtn.classList.toggle('active', showOiSummary); renderBody(); } }, 'OI Summary');
  const exportBtn = el('button', { class: 'btn secondary sm', onclick: exportCSV }, 'Export CSV');

  controls.append(
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Instrument'), insSel.el),
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Date'), dateSelect.el),
    el('div', { class: 'data-field' }, el('span', { class: 'label' }, 'Interval'), resampleSel.el),
    searchInput,
    el('div', { class: 'data-sep' }),
    filterBtn, colsBtn, refreshBtn,
    el('div', { class: 'data-sep' }),
    oiBtn,
    el('div', { class: 'spacer' }),
    exportBtn,
  );
  toolbar.appendChild(controls);

  // Row 2: filter chips (if any)
  const chipRow = el('div', { class: 'data-chips' });
  toolbar.appendChild(chipRow);

  page.appendChild(toolbar);

  // ── Table area ──
  const tableWrap = el('div', { class: 'data-grid-wrap' });
  const table = el('table', { class: 'data' });
  tableWrap.appendChild(table);
  page.appendChild(tableWrap);

  // ── OI Summary overlay (replaces table when active) ──
  const oiWrap = el('div', { class: 'oi-summary-panel', style: { display: 'none' } });
  page.appendChild(oiWrap);

  // ── Pagination ──
  const pag = el('div', { class: 'data-pagination' });
  page.appendChild(pag);

  // ── State ──
  let currentResult = null;
  let allRows = [];

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

  // ── Table rendering ──
  function renderBody() {
    // Toggle OI summary vs table
    if (showOiSummary) {
      tableWrap.style.display = 'none';
      oiWrap.style.display = '';
      pag.style.display = 'none';
      renderOiSummary();
      return;
    }
    tableWrap.style.display = '';
    oiWrap.style.display = 'none';
    pag.style.display = '';

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let rows = allRows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
    }
    rows = resampleData(rows);

    // Update row counter in pagination
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

    // First page
    pag.appendChild(el('button', {
      class: 'btn ghost sm',
      disabled: res.page <= 1,
      onclick: () => { state.page = 1; runQuery(); },
      title: 'First page',
    }, '⟨⟨'));
    // Prev
    pag.appendChild(el('button', {
      class: 'btn ghost sm',
      disabled: res.page <= 1,
      onclick: () => { state.page = res.page - 1; runQuery(); },
    }, '⟨'));
    pag.appendChild(el('span', { class: 'mono text-sm' }, `${res.page} / ${res.pages}`));
    // Next
    pag.appendChild(el('button', {
      class: 'btn ghost sm',
      disabled: res.page >= res.pages,
      onclick: () => { state.page = res.page + 1; runQuery(); },
    }, '⟩'));
    // Last page
    pag.appendChild(el('button', {
      class: 'btn ghost sm',
      disabled: res.page >= res.pages,
      onclick: () => { state.page = res.pages; runQuery(); },
      title: 'Last page',
    }, '⟩⟩'));

    // Page size
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

  // ── OI Summary (inline, replaces table) ──
  async function renderOiSummary() {
    oiWrap.innerHTML = '<div class="dim" style="padding:24px">Loading OI data…</div>';
    const instrument = state.instrument;
    const date = state.date;
    if (!instrument || !date) {
      oiWrap.innerHTML = '<div class="empty-state">Select a date to view OI summary.</div>';
      return;
    }
    try {
      const oiData = await api.totalOi(instrument, date);
      const rows = Array.isArray(oiData) ? oiData : (oiData.data || oiData.rows || []);
      if (!rows.length) {
        oiWrap.innerHTML = '<div class="empty-state">No OI data for this date.</div>';
        return;
      }

      // Aggregate by timestamp
      const timeMap = new Map();
      rows.forEach(r => {
        const ts = r.timestamp || r.time || r.date;
        if (!ts) return;
        const existing = timeMap.get(ts);
        if (existing) {
          existing.total_ce_oi += (r.total_ce_oi || r.ce_oi || 0);
          existing.total_pe_oi += (r.total_pe_oi || r.pe_oi || 0);
        } else {
          timeMap.set(ts, {
            timestamp: ts,
            total_ce_oi: r.total_ce_oi || r.ce_oi || 0,
            total_pe_oi: r.total_pe_oi || r.pe_oi || 0,
          });
        }
      });
      const summaryRows = [...timeMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // Summary cards
      const latest = summaryRows[summaryRows.length - 1];
      const first = summaryRows[0];
      const pcr = latest.total_pe_oi && latest.total_ce_oi ? (latest.total_pe_oi / latest.total_ce_oi) : 0;
      const ceΔ = latest.total_ce_oi - first.total_ce_oi;
      const peΔ = latest.total_pe_oi - first.total_pe_oi;

      const cards = el('div', { class: 'oi-cards' });
      const makeCard = (title, items) => el('div', { class: 'card oi-card' },
        el('div', { class: 'label' }, title),
        ...items.map(i => el('div', { class: 'oi-row' },
          el('span', { class: 'text-xs muted' }, i.label),
          el('span', { class: `mono ${i.tone || ''}`, style: { fontWeight: '600' } }, i.value),
        )),
      );
      cards.appendChild(makeCard('OI Overview', [
        { label: 'CE OI', value: fmtCompact(latest.total_ce_oi) },
        { label: 'PE OI', value: fmtCompact(latest.total_pe_oi) },
        { label: 'PCR', value: fmtNum(pcr, 3), tone: pcr >= 1 ? 'bull' : 'bear' },
      ]));
      cards.appendChild(makeCard('OI Change', [
        { label: 'CE Δ', value: (ceΔ >= 0 ? '+' : '') + fmtCompact(ceΔ), tone: ceΔ >= 0 ? 'bull' : 'bear' },
        { label: 'PE Δ', value: (peΔ >= 0 ? '+' : '') + fmtCompact(peΔ), tone: peΔ >= 0 ? 'bull' : 'bear' },
        { label: 'Ticks', value: String(summaryRows.length), tone: 'dim' },
      ]));

      // Table
      const t = el('table', { class: 'data' });
      const cols = ['Time', 'CE OI', 'PE OI', 'PCR', 'CE Δ', 'PE Δ'];
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
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' }, fmtTimeIST(r.timestamp)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_ce_oi)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_pe_oi)));
        tr.appendChild(el('td', { class: `mono ${rowPcr >= 1 ? 'bull' : 'bear'}` }, fmtNum(rowPcr, 3)));
        tr.appendChild(el('td', { class: `mono ${cΔ >= 0 ? 'bull' : 'bear'}` }, (cΔ >= 0 ? '+' : '') + fmtCompact(cΔ)));
        tr.appendChild(el('td', { class: `mono ${pΔ >= 0 ? 'bull' : 'bear'}` }, (pΔ >= 0 ? '+' : '') + fmtCompact(pΔ)));
        tbody.appendChild(tr);
        prevCe = r.total_ce_oi;
        prevPe = r.total_pe_oi;
      });
      t.appendChild(tbody);

      oiWrap.innerHTML = '';
      oiWrap.appendChild(cards);
      oiWrap.appendChild(el('div', { class: 'data-grid-wrap' }, t));
    } catch (e) {
      oiWrap.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
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
