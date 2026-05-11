// pages/data.js — Snapshots / Events / History
import { el, toast, fmtTimeIST, icon } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let activeTab = 'snapshots';
let eventTimer;

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  const subtabs = el('div', { class: 'subtabs' });
  ['snapshots', 'events', 'history'].forEach(id => {
    subtabs.appendChild(el('button', { class: 'subtab' + (activeTab === id ? ' active' : ''), onclick: () => { activeTab = id; render(); } }, id.charAt(0).toUpperCase() + id.slice(1)));
  });
  page.appendChild(subtabs);

  const body = el('div', {});
  page.appendChild(body);

  // parse hash params (e.g., #data?tab=events&level=ERROR)
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  if (hashParams.get('tab')) activeTab = hashParams.get('tab');

  async function render() {
    clearInterval(eventTimer);
    subtabs.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === activeTab));
    body.innerHTML = '';
    if (activeTab === 'snapshots') await renderSnapshots(body);
    else if (activeTab === 'events') await renderEvents(body);
    else await renderHistory(body);
  }

  await render();
}

export function unmount() { clearInterval(eventTimer); }

// ---- Snapshots ----
let columnsCatalog = null;
let selectedCols = [];
let filters = [];
let snapState = { instrument: 'nifty', date: '', page: 1, page_size: 100, sort: [{ column: 'timestamp', dir: 'desc' }] };

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

  const bar = el('div', { class: 'filter-bar' });
  const insSel = el('select', {}, ...['nifty', 'banknifty', 'sensex'].map(i => el('option', { value: i, selected: snapState.instrument === i }, i)));
  insSel.addEventListener('change', () => { snapState.instrument = insSel.value; runQuery(); });
  const dateInput = el('input', { type: 'text', placeholder: 'YYYY-MM-DD', value: snapState.date, style: { minWidth: '140px' } });
  dateInput.addEventListener('change', () => { snapState.date = dateInput.value; runQuery(); });

  const filtersHolder = el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } });
  filters.forEach((f, i) => {
    filtersHolder.appendChild(el('span', { class: 'chip removable', onclick: () => { filters.splice(i, 1); renderSnapshots(root); } },
      `${f.column} ${f.op} ${JSON.stringify(f.value)}`, icon('close')));
  });

  const addFilterBtn = el('button', { class: 'btn ghost sm', onclick: () => openFilterDialog((f) => { filters.push(f); renderSnapshots(root); }) }, icon('plus'), 'Filter');
  const colsBtn = el('button', { class: 'btn ghost sm', onclick: () => openColumnsDialog(() => renderSnapshots(root)) }, 'Columns');
  const refreshBtn = el('button', { class: 'btn ghost sm', onclick: runQuery, title: 'Reload' }, icon('refresh'));
  const exportBtn = el('button', { class: 'btn secondary sm', onclick: exportCSV }, 'Export CSV');

  bar.appendChild(el('span', { class: 'label' }, 'Instrument'));
  bar.appendChild(insSel);
  bar.appendChild(el('span', { class: 'label' }, 'Date'));
  bar.appendChild(dateInput);
  bar.appendChild(filtersHolder);
  bar.appendChild(addFilterBtn);
  bar.appendChild(colsBtn);
  bar.appendChild(refreshBtn);
  bar.appendChild(el('div', { class: 'spacer' }));
  bar.appendChild(exportBtn);

  root.appendChild(bar);

  const tableWrap = el('div', { class: 'data-grid-wrap' });
  const table = el('table', { class: 'data' });
  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  const pag = el('div', { class: 'pagination' });
  root.appendChild(pag);

  let currentResult = null;

  async function runQuery() {
    table.innerHTML = '<tbody><tr><td>Loading…</td></tr></tbody>';
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
      renderTable(table, res, (col, dir) => {
        snapState.sort = [{ column: col, dir }];
        runQuery();
      });
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
    const cols = selectedCols;
    const rows = [];
    for (let p = 1; p <= pages; p++) {
      const res = await api.dataQuery({
        instrument: snapState.instrument, date: snapState.date || undefined,
        columns: cols, filters, sort: snapState.sort, page: p, page_size: 500,
      });
      rows.push(...res.rows);
    }
    const csv = [cols.join(',')];
    rows.forEach(r => csv.push(cols.map(c => JSON.stringify(r[c] ?? '')).join(',')));
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${snapState.instrument}-${snapState.date || 'data'}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows`, 'success');
  }

  await runQuery();
}

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

// ---- Events ----
let eventLevel = '';
let eventSearch = '';
let eventPause = false;

async function renderEvents(root) {
  // Always clear any previous timer before re-rendering or polling.
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

// ---- History ----
async function renderHistory(root) {
  const wrap = el('div', { class: 'data-grid-wrap' });
  const t = el('table', { class: 'data' });
  wrap.appendChild(t);
  root.appendChild(wrap);
  try {
    const data = await api.history();
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
        // forces re-render
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
    root.innerHTML = `<div class="empty-state"><span class="bear">Failed</span><span class="text-xs mono dim">${e.message}</span></div>`;
  }
}
