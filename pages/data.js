// pages/data.js — Snapshots / Events / History / OI Summary
import { el, toast, fmtTimeIST, fmtDateIST, fmtNum, fmtCompact, icon, Select, DateSelect } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let activeTab = 'snapshots';
let eventTimer;

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  const subtabs = el('div', { class: 'subtabs' });
  ['snapshots', 'events', 'history', 'oi-summary'].forEach(id => {
    const label = id === 'oi-summary' ? 'OI Summary' : id.charAt(0).toUpperCase() + id.slice(1);
    subtabs.appendChild(el('button', {
      class: 'subtab' + (activeTab === id ? ' active' : ''),
      onclick: () => { activeTab = id; render(); }
    }, label));
  });
  page.appendChild(subtabs);

  const body = el('div', {});
  page.appendChild(body);

  // parse hash params (e.g., #data?tab=events&level=ERROR)
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  if (hashParams.get('tab')) activeTab = hashParams.get('tab');

  async function render() {
    clearInterval(eventTimer);
    subtabs.querySelectorAll('.subtab').forEach(b => {
      const label = b.textContent.toLowerCase().replace(/\s+/g, '-');
      b.classList.toggle('active', label === activeTab || (activeTab === 'oi-summary' && b.textContent === 'OI Summary') || b.textContent.toLowerCase() === activeTab);
    });
    body.innerHTML = '';
    if (activeTab === 'snapshots') await renderSnapshots(body);
    else if (activeTab === 'events') await renderEvents(body);
    else if (activeTab === 'history') await renderHistory(body);
    else await renderOiSummary(body);
  }

  await render();
}

export function unmount() { clearInterval(eventTimer); }

// ─── Shared: fetch available dates for an instrument ───────────────────
async function fetchAvailableDates(instrument) {
  try {
    const res = await api.dataDistinct('date', `?instrument=${instrument}&limit=5000`);
    return (res.values || []).filter(Boolean);
  } catch (e) {
    console.error('Failed to fetch dates', e);
    return [];
  }
}

// ─── Snapshots ─────────────────────────────────────────────────────────
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let snapState = { instrument: 'nifty', date: '', page: 1, page_size: 100, sort: [{ column: 'timestamp', dir: 'desc' }] };
let searchQuery = '';
let resampleInterval = 'raw'; // raw, 1min, 5min, 15min, 30min, 1hr

async function renderSnapshots(root) {
  if (!columnsCatalog) {
    try {
      columnsCatalog = await api.dataColumns();
      selectedCols = [...(columnsCatalog.default_columns || ['timestamp', 'instrument', 'strike', 'pcr', 'underlying_spot_price'])];
    } catch (e) {
      root.appendChild(el('div', { class: 'empty-state' }, 'Failed to load column catalog.', el('span', { class: 'text-xs mono dim' }, e.message)));
      return;
    }
  }

  // ── Top toolbar: instrument + date + search ──
  const toolbar = el('div', { class: 'filter-bar' });

  // Instrument selector
  const insSel = Select({
    options: ['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() })),
    value: snapState.instrument,
    onChange: (v) => { snapState.instrument = v; dateSelect.refresh(v); snapState.page = 1; runQuery(); },
    width: '130px',
  });

  // Date selector (menu box with available dates)
  const dateSelect = DateSelect({
    instrument: snapState.instrument,
    apiDistinctFn: fetchAvailableDates,
    onChange: (v) => { snapState.date = v; snapState.page = 1; runQuery(); },
    placeholder: 'All dates',
    width: '150px',
  });

  // Search box
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search rows…',
    value: searchQuery,
    style: { minWidth: '180px', maxWidth: '240px' },
  });
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderTableBody();
  });

  // Resample interval selector
  const resampleSel = Select({
    options: [
      { value: 'raw', label: 'Raw data' },
      { value: '1min', label: '1 min' },
      { value: '5min', label: '5 min' },
      { value: '15min', label: '15 min' },
      { value: '30min', label: '30 min' },
      { value: '1hr', label: '1 hour' },
    ],
    value: resampleInterval,
    onChange: (v) => { resampleInterval = v; renderTableBody(); },
    width: '120px',
  });

  toolbar.appendChild(el('span', { class: 'label' }, 'Instrument'));
  toolbar.appendChild(insSel.el);
  toolbar.appendChild(el('span', { class: 'label' }, 'Date'));
  toolbar.appendChild(dateSelect.el);
  toolbar.appendChild(searchInput);
  toolbar.appendChild(el('span', { class: 'label' }, 'Interval'));
  toolbar.appendChild(resampleSel.el);

  root.appendChild(toolbar);

  // ── Filter chips row ──
  const filterRow = el('div', { class: 'filter-chips-row' });
  function renderFilterChips() {
    filterRow.innerHTML = '';
    if (filters.length) {
      filters.forEach((f, i) => {
        filterRow.appendChild(el('span', { class: 'chip removable', onclick: () => { filters.splice(i, 1); renderSnapshots(root); } },
          `${f.column} ${f.op} ${JSON.stringify(f.value)}`, icon('close')));
      });
    }
    filterRow.appendChild(el('button', { class: 'btn ghost sm', onclick: () => openFilterDialog((f) => { filters.push(f); renderSnapshots(root); }) }, icon('plus'), 'Filter'));
    filterRow.appendChild(el('button', { class: 'btn ghost sm', onclick: () => openColumnsDialog(() => renderSnapshots(root)) }, 'Columns'));
    filterRow.appendChild(el('button', { class: 'btn ghost sm', onclick: runQuery, title: 'Reload' }, icon('refresh')));
    filterRow.appendChild(el('div', { class: 'spacer' }));
    filterRow.appendChild(el('button', { class: 'btn secondary sm', onclick: exportCSV }, 'Export CSV'));
  }
  renderFilterChips();
  root.appendChild(filterRow);

  // ── Navigation: scroll to first / last / current ──
  const navBar = el('div', { class: 'data-nav-bar' });
  const scrollToFirstBtn = el('button', { class: 'btn ghost sm', onclick: () => scrollToRow('first') }, '⏮ First');
  const scrollToLastBtn = el('button', { class: 'btn ghost sm', onclick: () => scrollToRow('last') }, 'Last ⏭');
  const scrollToCurrentBtn = el('button', { class: 'btn ghost sm', onclick: () => scrollToRow('current') }, '⏱ Current');
  navBar.appendChild(scrollToFirstBtn);
  navBar.appendChild(scrollToLastBtn);
  navBar.appendChild(scrollToCurrentBtn);
  navBar.appendChild(el('div', { class: 'spacer' }));
  const rowCounter = el('span', { class: 'mono text-xs dim' });
  navBar.appendChild(rowCounter);
  root.appendChild(navBar);

  // ── Table ──
  const tableWrap = el('div', { class: 'data-grid-wrap', id: 'snap-table-wrap' });
  const table = el('table', { class: 'data', id: 'snap-table' });
  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  const pag = el('div', { class: 'pagination' });
  root.appendChild(pag);

  let currentResult = null;
  let allRows = []; // for search + resample

  function scrollToRow(which) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    if (!rows.length) return;
    let targetRow;
    if (which === 'first') targetRow = rows[0];
    else if (which === 'last') targetRow = rows[rows.length - 1];
    else {
      // current: find row closest to current time
      const now = new Date();
      let bestDiff = Infinity;
      rows.forEach(r => {
        const cells = r.querySelectorAll('td');
        // Look for time cell (second column if split, else first)
        for (const cell of cells) {
          const text = cell.textContent.trim();
          if (/^\d{2}:\d{2}:\d{2}/.test(text)) {
            const parts = text.split(':');
            const rowMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
            const nowMin = now.getHours() * 60 + now.getMinutes();
            const diff = Math.abs(rowMin - nowMin);
            if (diff < bestDiff) { bestDiff = diff; targetRow = r; }
          }
        }
      });
      if (!targetRow) targetRow = rows[0];
    }
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetRow.style.background = 'rgba(198,192,255,0.12)';
    setTimeout(() => { targetRow.style.background = ''; }, 1500);
  }

  // Resample data based on interval
  function resampleData(rows) {
    if (resampleInterval === 'raw') return rows;
    const intervalMs = {
      '1min': 60000, '5min': 300000, '15min': 900000, '30min': 1800000, '1hr': 3600000,
    }[resampleInterval];
    if (!intervalMs) return rows;

    // Group by time bucket
    const buckets = new Map();
    rows.forEach(r => {
      const ts = r.timestamp || r.date;
      if (!ts) return;
      const t = new Date(ts).getTime();
      const bucketKey = Math.floor(t / intervalMs) * intervalMs;
      const existing = buckets.get(bucketKey);
      if (!existing) {
        buckets.set(bucketKey, { ...r, _count: 1 });
      } else {
        // Average numeric fields, keep first for non-numeric
        Object.keys(r).forEach(k => {
          if (typeof r[k] === 'number' && typeof existing[k] === 'number') {
            existing[k] = ((existing[k] * existing._count) + r[k]) / (existing._count + 1);
          }
        });
        existing._count++;
      }
    });
    return [...buckets.values()].map(r => { const { _count, ...rest } = r; return rest; });
  }

  function renderTableBody() {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let rows = allRows;
    // Apply search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
    }
    // Apply resampling
    rows = resampleData(rows);

    rowCounter.textContent = `${rows.length} rows`;

    rows.forEach(row => {
      const r = el('tr');
      (currentResult?.columns || []).forEach(c => {
        const col = typeof c === 'string' ? c : c.id;
        let v = row[col];

        // Split timestamp into separate date and time columns
        if (col === 'timestamp' && v) {
          const dateStr = fmtDateIST(v);
          const timeStr = fmtTimeIST(v);
          r.appendChild(el('td', { class: 'mono' }, dateStr));
          r.appendChild(el('td', { class: 'mono' }, timeStr));
          return;
        }

        if (v == null) v = '—';
        else if (typeof v === 'number') v = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4);
        r.appendChild(el('td', {}, String(v)));
      });
      tbody.appendChild(r);
    });
  }

  async function runQuery() {
    table.innerHTML = '<tbody><tr><td colspan="20">Loading…</td></tr></tbody>';
    const body = {
      instrument: snapState.instrument,
      date: snapState.date || undefined,
      columns: selectedCols,
      filters,
      sort: snapState.sort,
      page: snapState.page,
      page_size: snapState.page_size,
    };
    try {
      const res = await api.dataQuery(body);
      currentResult = res;
      allRows = res.rows || [];

      // Build header — split timestamp into Date + Time
      table.innerHTML = '';
      const thead = el('thead');
      const tr = el('tr');
      (res.columns || []).forEach(c => {
        const col = typeof c === 'string' ? c : c.id;
        const label = typeof c === 'string' ? c : c.label;
        if (col === 'timestamp') {
          // Replace with Date + Time columns
          tr.appendChild(el('th', { onclick: () => { snapState.sort = [{ column: 'timestamp', dir: snapState.sort[0]?.dir === 'asc' ? 'desc' : 'asc' }]; runQuery(); } }, 'Date'));
          tr.appendChild(el('th', { onclick: () => { snapState.sort = [{ column: 'timestamp', dir: snapState.sort[0]?.dir === 'asc' ? 'desc' : 'asc' }]; runQuery(); } }, 'Time'));
        } else {
          tr.appendChild(el('th', { onclick: () => {
            const cur = (res.sort_used || [{}])[0];
            const dir = cur?.column === col && cur?.dir === 'asc' ? 'desc' : 'asc';
            snapState.sort = [{ column: col, dir }];
            runQuery();
          } }, label));
        }
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(el('tbody'));

      renderTableBody();
      renderFilterChips();
      renderPagination(pag, res, (p) => { snapState.page = p; runQuery(); }, (s) => { snapState.page_size = s; snapState.page = 1; runQuery(); });
    } catch (e) {
      table.innerHTML = '';
      tableWrap.innerHTML = `<div class="empty-state"><span class="bear">Query failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  async function exportCSV() {
    if (!currentResult) return;
    toast('Exporting CSV…', 'info');
    const pages = currentResult.pages;
    let cols = selectedCols;
    // Add both date and time if timestamp is selected
    const hasTimestamp = cols.includes('timestamp');
    const exportCols = hasTimestamp ? cols.flatMap(c => c === 'timestamp' ? ['date', 'time'] : [c]) : cols;
    const rows = [];
    for (let p = 1; p <= pages; p++) {
      const res = await api.dataQuery({
        instrument: snapState.instrument, date: snapState.date || undefined,
        columns: cols, filters, sort: snapState.sort, page: p, page_size: 500,
      });
      (res.rows || []).forEach(r => {
        const row = {};
        exportCols.forEach(c => {
          if (c === 'date') row[c] = r.timestamp ? fmtDateIST(r.timestamp) : '';
          else if (c === 'time') row[c] = r.timestamp ? fmtTimeIST(r.timestamp) : '';
          else row[c] = r[c];
        });
        rows.push(row);
      });
    }
    const csv = [exportCols.join(',')];
    rows.forEach(r => csv.push(exportCols.map(c => JSON.stringify(r[c] ?? '')).join(',')));
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${snapState.instrument}-${snapState.date || 'data'}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows`, 'success');
  }

  await runQuery();
}

// ─── Shared table rendering ────────────────────────────────────────────
function renderTable(table, res, onSort) {
  table.innerHTML = '';
  const thead = el('thead');
  const tr = el('tr');
  (res.columns || []).forEach(c => {
    const col = typeof c === 'string' ? c : c.id;
    const label = typeof c === 'string' ? c : c.label;
    const th = el('th', { onclick: () => {
      const cur = (res.sort_used || [{}])[0];
      const dir = cur?.column === col && cur?.dir === 'asc' ? 'desc' : 'asc';
      onSort(col, dir);
    } }, label);
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  table.appendChild(thead);
  const tbody = el('tbody');
  (res.rows || []).forEach(row => {
    const r = el('tr');
    (res.columns || []).forEach(c => {
      const col = typeof c === 'string' ? c : c.id;
      let v = row[col];
      if (v == null) v = '—';
      else if (typeof v === 'number') v = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4);
      r.appendChild(el('td', {}, String(v)));
    });
    tbody.appendChild(r);
  });
  table.appendChild(tbody);
}

function renderPagination(root, res, onPage, onSize) {
  root.innerHTML = '';
  root.appendChild(el('span', {}, `${(res.page - 1) * res.page_size + 1}–${Math.min(res.total, res.page * res.page_size)} of ${res.total}`));
  root.appendChild(el('div', { class: 'spacer' }));
  root.appendChild(el('button', { class: 'btn ghost sm', disabled: res.page <= 1, onclick: () => onPage(res.page - 1) }, '‹'));
  root.appendChild(el('span', {}, `Page ${res.page} / ${res.pages}`));
  root.appendChild(el('button', { class: 'btn ghost sm', disabled: res.page >= res.pages, onclick: () => onPage(res.page + 1) }, '›'));
  const sizeSel = el('select', { style: { width: 'auto', minWidth: 'unset' } }, ...[50, 100, 200, 500].map(n => el('option', { value: n, selected: res.page_size === n }, `${n}/page`)));
  sizeSel.addEventListener('change', () => onSize(Number(sizeSel.value)));
  root.appendChild(sizeSel);
}

function openFilterDialog(onAdd) {
  const cols = columnsCatalog?.columns || [];
  const colSel = el('select', {}, ...cols.map(c => el('option', { value: c.id }, c.label || c.id)));
  const opSel = el('select', {});
  const valInput = el('input', { type: 'text', placeholder: 'Value' });
  function refreshOps() {
    const c = cols.find(c => c.id === colSel.value);
    opSel.innerHTML = '';
    (c?.operators || ['eq', 'gt', 'lt']).forEach(o => opSel.appendChild(el('option', { value: o }, o)));
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

// ─── Events ────────────────────────────────────────────────────────────
let eventLevel = '';
let eventSearch = '';
let eventPause = false;

async function renderEvents(root) {
  clearInterval(eventTimer);
  root.innerHTML = '';

  const bar = el('div', { class: 'filter-bar' });
  ['', 'INFO', 'WARNING', 'ERROR'].forEach(lv => {
    bar.appendChild(el('button', { class: 'btn ' + (eventLevel === lv ? 'primary' : 'ghost') + ' sm', onclick: () => { eventLevel = lv; renderEvents(root); } }, lv || 'All'));
  });
  const search = el('input', { type: 'search', placeholder: 'Search…', value: eventSearch, style: { minWidth: '200px' } });
  search.addEventListener('input', () => { eventSearch = search.value; refresh(); });
  bar.appendChild(search);
  bar.appendChild(el('div', { class: 'spacer' }));
  bar.appendChild(el('button', { class: 'btn ghost sm', onclick: () => { eventPause = !eventPause; renderEvents(root); } }, eventPause ? '▶ Resume' : '❚❚ Pause'));
  root.appendChild(bar);

  const list = el('div', { class: 'events-list' });
  root.appendChild(list);

  let events = [];
  async function refresh() {
    try {
      const data = await api.events(200, eventLevel);
      events = data.events || [];
      list.innerHTML = '';
      const filtered = events.filter(ev => !eventSearch || (ev.message || '').toLowerCase().includes(eventSearch.toLowerCase()) || (ev.logger || '').toLowerCase().includes(eventSearch.toLowerCase()));
      filtered.forEach(ev => {
        list.appendChild(el('div', { class: `event-row ${ev.level}` },
          el('span', { class: 'dim' }, fmtTimeIST(ev.timestamp)),
          el('span', { class: 'level' }, ev.level),
          el('span', { class: 'dim' }, ev.logger || ''),
          el('span', { class: 'msg', title: ev.message }, ev.message || '')
        ));
      });
      if (!filtered.length) list.appendChild(el('div', { class: 'empty-state' }, 'No events.'));
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'empty-state' }, el('span', { class: 'bear' }, 'Failed to load events'), el('span', { class: 'text-xs mono dim' }, e.message)));
    }
  }
  await refresh();
  if (!eventPause) {
    eventTimer = setInterval(refresh, 5000);
  }
}

// ─── History ───────────────────────────────────────────────────────────
async function renderHistory(root) {
  // Date selector for history
  const bar = el('div', { class: 'filter-bar' });
  const insSel = Select({
    options: [{ value: '', label: 'All instruments' }, ...['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() }))],
    value: '',
    width: '160px',
    onChange: () => loadHistory(),
  });
  bar.appendChild(el('span', { class: 'label' }, 'Instrument'));
  bar.appendChild(insSel.el);
  bar.appendChild(el('div', { class: 'spacer' }));
  root.appendChild(bar);

  const wrap = el('div', { class: 'data-grid-wrap' });
  const t = el('table', { class: 'data' });
  wrap.appendChild(t);
  root.appendChild(wrap);

  async function loadHistory() {
    t.innerHTML = '';
    try {
      const ins = insSel.getValue();
      const data = ins ? await api.history(ins) : await api.history();
      const rows = Array.isArray(data) ? data : (data.history || []);
      const cols = ['date', 'instrument', 'first_timestamp', 'last_timestamp', 'ticks', 'snapshot_rows', 'strikes'];
      const thead = el('thead');
      const tr = el('tr');
      cols.forEach(c => tr.appendChild(el('th', {}, c)));
      thead.appendChild(tr);
      t.appendChild(thead);
      const tbody = el('tbody');
      rows.forEach(r => {
        const row = el('tr', { style: { cursor: 'pointer' }, onclick: () => {
          snapState.instrument = r.instrument; snapState.date = r.date; activeTab = 'snapshots';
          location.hash = '#data';
          const evt = new HashChangeEvent('hashchange'); window.dispatchEvent(evt);
        } });
        cols.forEach(c => {
          let v = r[c];
          if (c.includes('timestamp') && v) v = fmtTimeIST(v);
          row.appendChild(el('td', {}, String(v ?? '—')));
        });
        tbody.appendChild(row);
      });
      t.appendChild(tbody);
      if (!rows.length) root.appendChild(el('div', { class: 'empty-state' }, 'No history yet.'));
    } catch (e) {
      wrap.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  await loadHistory();
}

// ─── OI Summary ────────────────────────────────────────────────────────
async function renderOiSummary(root) {
  const bar = el('div', { class: 'filter-bar' });

  const insSel = Select({
    options: ['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() })),
    value: 'nifty',
    width: '130px',
    onChange: (v) => { dateSelect.refresh(v); },
  });

  const dateSelect = DateSelect({
    instrument: 'nifty',
    apiDistinctFn: fetchAvailableDates,
    placeholder: 'Select date',
    width: '150px',
  });

  const intervalSel = Select({
    options: [
      { value: '1min', label: '1 min' },
      { value: '5min', label: '5 min' },
      { value: '15min', label: '15 min' },
      { value: '30min', label: '30 min' },
      { value: '1hr', label: '1 hour' },
    ],
    value: '5min',
    width: '120px',
  });

  bar.appendChild(el('span', { class: 'label' }, 'Instrument'));
  bar.appendChild(insSel.el);
  bar.appendChild(el('span', { class: 'label' }, 'Date'));
  bar.appendChild(dateSelect.el);
  bar.appendChild(el('span', { class: 'label' }, 'Interval'));
  bar.appendChild(intervalSel.el);
  bar.appendChild(el('div', { class: 'spacer' }));
  const refreshBtn = el('button', { class: 'btn ghost sm', onclick: loadSummary, title: 'Refresh' }, icon('refresh'));
  bar.appendChild(refreshBtn);
  root.appendChild(bar);

  // Summary cards
  const summaryCards = el('div', { class: 'oi-summary-cards' });
  root.appendChild(summaryCards);

  // Table
  const tableWrap = el('div', { class: 'data-grid-wrap' });
  const table = el('table', { class: 'data' });
  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  async function loadSummary() {
    const instrument = insSel.getValue();
    const date = dateSelect.getValue();
    if (!instrument || !date) {
      toast('Select instrument and date', 'warn');
      return;
    }

    table.innerHTML = '<tbody><tr><td colspan="20">Loading…</td></tr></tbody>';
    summaryCards.innerHTML = '';

    try {
      // Fetch total OI data
      const oiData = await api.totalOi(instrument);
      const rows = Array.isArray(oiData) ? oiData : (oiData.data || oiData.rows || []);

      if (!rows.length) {
        table.innerHTML = '';
        summaryCards.innerHTML = '';
        root.appendChild(el('div', { class: 'empty-state' }, 'No OI data for this date.'));
        return;
      }

      // Group by timestamp and aggregate CE/PE OI
      const intervalMs = {
        '1min': 60000, '5min': 300000, '15min': 900000, '30min': 1800000, '1hr': 3600000,
      }[intervalSel.getValue()] || 300000;

      // Group rows by time bucket
      const timeBuckets = new Map();
      rows.forEach(r => {
        const ts = r.timestamp || r.time || r.date;
        if (!ts) return;
        const t = new Date(ts).getTime();
        const bucketKey = Math.floor(t / intervalMs) * intervalMs;
        const key = new Date(bucketKey).toISOString();

        if (!timeBuckets.has(key)) {
          timeBuckets.set(key, { timestamp: key, total_ce_oi: 0, total_pe_oi: 0, strikes: new Set(), count: 0 });
        }
        const bucket = timeBuckets.get(key);
        bucket.total_ce_oi += (r.total_ce_oi || r.ce_oi || r.call_oi || 0);
        bucket.total_pe_oi += (r.total_pe_oi || r.pe_oi || r.put_oi || 0);
        if (r.strike) bucket.strikes.add(r.strike);
        bucket.count++;
      });

      const summaryRows = [...timeBuckets.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // Summary cards
      const latest = summaryRows[summaryRows.length - 1];
      const first = summaryRows[0];
      const pcr = latest.total_pe_oi && latest.total_ce_oi ? (latest.total_pe_oi / latest.total_ce_oi) : 0;

      const makeCard = (label, value, sub, tone) => el('div', { class: 'card oi-card' },
        el('div', { class: 'label' }, label),
        el('div', { class: `mono ${tone || ''}`, style: { fontSize: '18px', fontWeight: 600 } }, value),
        sub ? el('div', { class: 'mono text-xs dim' }, sub) : null,
      );

      summaryCards.appendChild(makeCard('Total CE OI', fmtCompact(latest.total_ce_oi), `${summaryRows.length} intervals`));
      summaryCards.appendChild(makeCard('Total PE OI', fmtCompact(latest.total_pe_oi), `${latest.strikes?.size || 0} strikes`));
      summaryCards.appendChild(makeCard('PCR (PE/CE)', fmtNum(pcr, 3), '', pcr >= 1 ? 'bull' : 'bear'));
      summaryCards.appendChild(makeCard('CE Change', fmtCompact(latest.total_ce_oi - first.total_ce_oi), 'first→last', (latest.total_ce_oi - first.total_ce_oi) >= 0 ? 'bull' : 'bear'));
      summaryCards.appendChild(makeCard('PE Change', fmtCompact(latest.total_pe_oi - first.total_pe_oi), 'first→last', (latest.total_pe_oi - first.total_pe_oi) >= 0 ? 'bull' : 'bear'));

      // Build table
      table.innerHTML = '';
      const cols = ['Time', 'CE OI', 'PE OI', 'PCR', 'CE Change', 'PE Change', 'Strikes'];
      const thead = el('thead');
      const headRow = el('tr');
      cols.forEach(c => headRow.appendChild(el('th', {}, c)));
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el('tbody');
      let prevCe = first.total_ce_oi;
      let prevPe = first.total_pe_oi;
      summaryRows.forEach((r, i) => {
        const pcr = r.total_pe_oi && r.total_ce_oi ? (r.total_pe_oi / r.total_ce_oi) : 0;
        const ceChange = i === 0 ? 0 : r.total_ce_oi - prevCe;
        const peChange = i === 0 ? 0 : r.total_pe_oi - prevPe;
        const timeStr = fmtTimeIST(r.timestamp);

        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' }, timeStr));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_ce_oi)));
        tr.appendChild(el('td', { class: 'mono' }, fmtCompact(r.total_pe_oi)));
        tr.appendChild(el('td', { class: `mono ${pcr >= 1 ? 'bull' : 'bear'}` }, fmtNum(pcr, 3)));
        tr.appendChild(el('td', { class: `mono ${ceChange >= 0 ? 'bull' : 'bear'}` }, (ceChange >= 0 ? '+' : '') + fmtCompact(ceChange)));
        tr.appendChild(el('td', { class: `mono ${peChange >= 0 ? 'bull' : 'bear'}` }, (peChange >= 0 ? '+' : '') + fmtCompact(peChange)));
        tr.appendChild(el('td', { class: 'mono dim' }, String(r.strikes?.size || r.count || '—')));
        tbody.appendChild(tr);

        prevCe = r.total_ce_oi;
        prevPe = r.total_pe_oi;
      });
      table.appendChild(tbody);

    } catch (e) {
      table.innerHTML = '';
      summaryCards.innerHTML = '';
      tableWrap.innerHTML = `<div class="empty-state"><span class="bear">Failed to load OI data</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  // Auto-load when date is selected
  const origRefresh = dateSelect.refresh.bind(dateSelect);
  dateSelect.refresh = async (ins) => {
    await origRefresh(ins);
    if (dateSelect.getValue()) loadSummary();
  };

  // Watch for date value changes
  let lastOiDate = dateSelect.getValue();
  const oiCheckInterval = setInterval(() => {
    const cur = dateSelect.getValue();
    if (cur !== lastOiDate) { lastOiDate = cur; if (cur) loadSummary(); }
  }, 800);

  // Initial load once date is available
  setTimeout(() => { if (dateSelect.getValue()) loadSummary(); }, 1500);

  // Cleanup on unmount
  const origUnmount = window.__oiCleanup;
  window.__oiCleanup = () => { clearInterval(oiCheckInterval); if (origUnmount) origUnmount(); };
}
