// pages/charts.js — workspace (grids up to 3x2) + tabs (1x1 fullview each)
import { el, toast, modal, icon, CHART_AXIS_STYLE, Select } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let mode = localStorage.getItem('charts.mode') || 'tabs';
let activeTab = null;
let chartInstances = {};
let pollTimer = null;
let _body, _toolbar;
let _built = false;

const WORKSPACE_PRESETS = ['1×1', '2×1', '2×2', '3×2'];

const DEFAULT_CONFIG = {
  instrument: 'nifty',
  metrics: ['pcr', 'underlying_spot_price'],
  strike_mode: 'aggregate',
  baseline: 'post_settlement',
  strike_count: 5,
  strikes: [],
  chart_type: 'line',
};

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  if (!store.chartCatalog) {
    try {
      const [cat, presets, types] = await Promise.all([
        api.chartMetrics(),
        api.chartPresets(),
        api.chartTypes().catch(() => ['line', 'area', 'bar', 'candle', 'heatmap', 'scatter', 'histogram'])
      ]);
      store.chartCatalog = cat;
      store.chartPresets = presets;
      store.chartTypes = types;
    } catch (e) {}
  }
  try { store.savedCharts = await api.listCharts(); } catch (e) { store.savedCharts = []; }

  _toolbar = el('div', { class: 'charts-toolbar' });
  page.appendChild(_toolbar);

  _body = el('div', {});
  page.appendChild(_body);

  buildToolbar();
  render();

  window.__chartsRender = () => { buildToolbar(); render(); };
  window.addEventListener('resize', resize);
  pollTimer = setInterval(() => { refreshCharts(); }, 60000);
}

function buildToolbar() {
  _toolbar.innerHTML = '';
  const seg = el('div', { class: 'segmented' },
    el('button', { class: 'seg' + (mode === 'tabs' ? ' active' : ''), onclick: () => switchMode('tabs') }, 'Tabs'),
    el('button', { class: 'seg' + (mode === 'workspace' ? ' active' : ''), onclick: () => switchMode('workspace') }, 'Workspace')
  );
  _toolbar.appendChild(seg);

  if (mode === 'workspace') {
    const layout = localStorage.getItem('charts.layout') || '2×2';
    const lyt = el('div', { class: 'segmented' });
    WORKSPACE_PRESETS.forEach(p => {
      lyt.appendChild(el('button', {
        class: 'seg' + (layout === p ? ' active' : ''),
        onclick: () => { localStorage.setItem('charts.layout', p); buildToolbar(); render(); }
      }, p));
    });
    _toolbar.appendChild(lyt);
  } else {
    const strip = el('div', { class: 'tab-strip', style: { flex: '1', minWidth: '0' } });
    if (!activeTab || !store.savedCharts.find(c => c.id === activeTab)) {
      activeTab = store.savedCharts[0]?.id || null;
    }
    store.savedCharts.forEach(c => {
      const t = el('div', {
        class: 'tab-item' + (activeTab === c.id ? ' active' : ''),
        onclick: (e) => { if (e.target.closest('.close')) return; activeTab = c.id; buildToolbar(); render(); }
      }, c.name);
      const closeBtn = el('span', { class: 'close', onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${c.name}"?`)) return;
        try {
          await api.deleteChart(c.id);
          store.savedCharts = store.savedCharts.filter(x => x.id !== c.id);
          if (activeTab === c.id) activeTab = store.savedCharts[0]?.id || null;
          // Clean up disposed instance
          if (chartInstances[c.id]) { chartInstances[c.id].dispose(); delete chartInstances[c.id]; }
          buildToolbar(); render();
          toast('Deleted', 'success');
        } catch (e) {}
      } });
      closeBtn.appendChild(icon('close'));
      t.appendChild(closeBtn);
      strip.appendChild(t);
    });
    _toolbar.appendChild(strip);
  }

  _toolbar.appendChild(el('div', { class: 'spacer' }));
  _toolbar.appendChild(el('button', { class: 'btn primary sm', onclick: () => openEditor(null) }, icon('plus'), 'New chart'));
}

function switchMode(next) {
  mode = next;
  localStorage.setItem('charts.mode', next);
  // Dispose all chart instances when switching modes
  Object.values(chartInstances).forEach(c => { try { c.dispose(); } catch {} });
  chartInstances = {};
  _built = false;
  buildToolbar();
  render();
}

function render() {
  // Only rebuild DOM if structure changed (mode switch, layout change, tab change)
  // On poll refresh, just update data via refreshCharts()
  if (!_built) {
    _body.innerHTML = '';
    if (mode === 'workspace') buildWorkspace(_body);
    else buildTabs(_body);
    _built = true;
  }
}

function buildWorkspace(root) {
  const layout = localStorage.getItem('charts.layout') || '2×2';
  const [cols, rows] = layout.split('×').map(Number);
  const grid = el('div', { class: 'workspace-grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` } });
  grid.dataset.mode = 'workspace';
  const slots = cols * rows;
  const charts = store.savedCharts.slice(0, slots);
  for (let i = 0; i < slots; i++) {
    const c = charts[i];
    if (c) grid.appendChild(buildTile(c));
    else grid.appendChild(el('div', {
      class: 'tile',
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-dim)' },
      onclick: () => openEditor(null)
    }, el('div', { class: 'flex-col gap-8', style: { alignItems: 'center' } }, icon('plus'), 'Add chart')));
  }
  root.appendChild(grid);
  // Initial load
  charts.forEach(c => loadAndRender(c.id, c.config));
}

function buildTile(chart) {
  const tile = el('div', { class: 'tile' });
  tile.dataset.chartId = chart.id;
  const cfg = chart.config || {};
  const head = el('div', { class: 'tile-header' });
  head.appendChild(el('div', {},
    el('div', { class: 'tile-title' }, chart.name),
    el('div', { class: 'tile-meta mono' }, `${cfg.instrument || ''} · ${(cfg.metrics || []).join(', ')}`)
  ));
  const acts = el('div', { class: 'tile-actions' });
  acts.appendChild(el('button', { class: 'icon-btn', title: 'Edit', onclick: () => openEditor(chart) }, icon('edit')));
  acts.appendChild(el('button', { class: 'icon-btn', title: 'Delete', onclick: async () => {
    if (!confirm('Delete chart?')) return;
    try {
      await api.deleteChart(chart.id);
      store.savedCharts = store.savedCharts.filter(c => c.id !== chart.id);
      if (chartInstances[chart.id]) { chartInstances[chart.id].dispose(); delete chartInstances[chart.id]; }
      _built = false;
      buildToolbar(); render();
      toast('Deleted', 'success');
    } catch (e) {}
  } }, icon('trash')));
  head.appendChild(acts);
  tile.appendChild(head);
  const canvas = el('div', { class: 'echart' });
  canvas.dataset.chartId = chart.id;
  tile.appendChild(canvas);
  return tile;
}

function buildTabs(root) {
  const chart = activeTab ? store.savedCharts.find(c => c.id === activeTab) : null;
  if (!chart) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('div', { style: { fontSize: '14px', color: 'var(--text)' } }, store.savedCharts.length ? 'Select a chart' : 'No charts yet'),
      el('div', {}, store.savedCharts.length ? 'Pick a tab above or create a new chart' : 'Create your first chart to start viewing'),
      el('button', { class: 'btn primary mt-12', onclick: () => openEditor(null) }, icon('plus'), 'New chart')
    ));
    return;
  }
  const cfg = chart.config || DEFAULT_CONFIG;
  const card = el('div', { class: 'chart-full' });
  card.dataset.chartId = chart.id;
  const head = el('div', { class: 'row mb-8', style: { justifyContent: 'space-between' } },
    el('div', {},
      el('div', { style: { fontSize: '14px', fontWeight: '600' } }, chart.name),
      el('div', { class: 'tile-meta mono mt-8' }, `${cfg.instrument} · ${cfg.strike_mode} · ${(cfg.metrics || []).join(', ')}`)
    ),
    el('div', { class: 'row gap-8' },
      el('button', { class: 'btn ghost sm', onclick: () => openEditor(chart) }, icon('edit'), 'Edit')
    )
  );
  const canvas = el('div', { class: 'echart', style: { flex: '1', minHeight: '0' } });
  canvas.dataset.chartId = chart.id;
  card.appendChild(head);
  card.appendChild(canvas);
  root.appendChild(card);
  loadAndRender(chart.id, cfg);
}

// ---- Load data and render/update chart ----
async function loadAndRender(chartId, cfg) {
  try {
    const body = {
      instrument: cfg.instrument,
      metrics: cfg.metrics?.length ? cfg.metrics : ['pcr'],
      strike_mode: cfg.strike_mode || 'aggregate',
      baseline: cfg.baseline || 'post_settlement',
      strike_count: cfg.strike_count || 0,
      strikes: cfg.strikes || [],
      date: cfg.date || undefined,
    };
    const payload = await api.chartData(body);

    // Find the canvas element for this chart
    const canvasEl = _body.querySelector(`[data-chart-id="${chartId}"].echart`);
    if (!canvasEl) return;

    if (chartInstances[chartId]) {
      // Reuse existing instance
      renderEchart(chartInstances[chartId], payload, cfg.chart_type || 'line');
    } else {
      // Create new instance
      const inst = echarts.init(canvasEl, null, { renderer: 'canvas' });
      chartInstances[chartId] = inst;
      renderEchart(inst, payload, cfg.chart_type || 'line');
    }
  } catch (e) {
    const canvasEl = _body.querySelector(`[data-chart-id="${chartId}"].echart`);
    if (canvasEl) canvasEl.innerHTML = `<div class="empty-state"><span class="bear">Chart error</span><span class="text-xs mono dim">${e.message}</span></div>`;
  }
}

// Refresh data for all visible charts without DOM rebuild
function refreshCharts() {
  const charts = mode === 'workspace' ? store.savedCharts.slice(0, getSlotCount()) : (activeTab ? [store.savedCharts.find(c => c.id === activeTab)].filter(Boolean) : []);
  charts.forEach(c => loadAndRender(c.id, c.config));
}

function getSlotCount() {
  const layout = localStorage.getItem('charts.layout') || '2×2';
  const [cols, rows] = layout.split('×').map(Number);
  return cols * rows;
}

function resize() {
  Object.values(chartInstances).forEach(c => { try { c.resize(); } catch {} });
}

export function unmount() {
  Object.values(chartInstances).forEach(c => { try { c.dispose(); } catch {} });
  chartInstances = {};
  window.removeEventListener('resize', resize);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  _built = false;
}

// ---- compact editor modal: 2 side-by-side panels ----
function openEditor(existing) {
  const cfg = existing?.config ? { ...DEFAULT_CONFIG, ...existing.config } : { ...DEFAULT_CONFIG };
  const cat = store.chartCatalog || { metrics: [], baselines: ['post_settlement', 'prev_close'], strike_modes: ['aggregate', 'atm_window', 'custom', 'all'] };

  const nameInput = el('input', { type: 'text', value: existing?.name || 'New chart' });
  const presetSel = el('select', {}, el('option', { value: '' }, 'Custom'),
    ...((store.chartPresets || []).map(p => el('option', { value: p.id }, p.name)))
  );

  const instOptions = ['nifty', 'banknifty', 'sensex'].map(i => ({ value: i, label: i.toUpperCase() }));
  const instSel = Select({ options: instOptions, value: cfg.instrument });

  const today = new Date().toISOString().slice(0, 10);
  const useToday = el('input', { type: 'checkbox', checked: !cfg.date });
  const dateInput = el('input', { type: 'date', value: cfg.date || today, disabled: !cfg.date });
  const dateRow = el('div', { class: 'field' },
    el('span', { class: 'label' }, 'Date'),
    el('label', { class: 'row gap-8', style: { alignItems: 'center' } }, useToday, 'Today', dateInput)
  );
  useToday.addEventListener('change', () => { dateInput.disabled = useToday.checked; });

  const baselineMap = { post_settlement: 'Post settlement', prev_close: 'Previous close', market_open: 'Market open' };
  const baselineOptions = (cat.baselines || ['post_settlement', 'prev_close']).map(b => ({ value: b, label: baselineMap[b] || b }));
  const baselineSel = Select({ options: baselineOptions, value: cfg.baseline });

  const modeMap = { aggregate: 'Aggregate', atm_window: 'ATM window', custom: 'Custom strikes', all: 'All strikes' };
  const modeOptions = (cat.strike_modes || ['aggregate', 'atm_window', 'custom', 'all']).map(m => ({ value: m, label: modeMap[m] || m }));
  const strikeModeSel = Select({ options: modeOptions, value: cfg.strike_mode });

  const strikeCountInput = el('input', { type: 'number', min: '0', max: '100', value: cfg.strike_count ?? 5 });
  const strikesInput = el('input', { type: 'text', placeholder: '24000, 24100', value: (cfg.strikes || []).join(', ') });
  const typesList = (store.chartTypes || []).map(t => (typeof t === 'string' ? { id: t, label: t } : t));
  const fallbackTypes = ['line', 'area', 'bar', 'candle', 'heatmap', 'scatter', 'histogram'].map(t => ({ id: t, label: t.charAt(0).toUpperCase() + t.slice(1) }));
  const ctOptions = (typesList.length ? typesList : fallbackTypes);
  const chartTypeSel = Select({ options: ctOptions, value: cfg.chart_type });

  const field = (label, node) => el('div', { class: 'field' }, el('span', { class: 'label' }, label), node.el || node);

  const leftPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-title' }, 'Configuration'),
    field('Instrument', instSel),
    dateRow,
    field('Baseline', baselineSel),
    field('Strike mode', strikeModeSel),
    field('ATM count', strikeCountInput),
    field('Custom strikes', strikesInput),
    field('Chart type', chartTypeSel),
  );

  // metrics on right
  const metricBox = el('div', { class: 'metric-picker' });
  const groups = (cat.metrics || []).reduce((acc, m) => { (acc[m.group] = acc[m.group] || []).push(m); return acc; }, {});
  for (const [g, list] of Object.entries(groups)) {
    metricBox.appendChild(el('div', { class: 'group-head' }, g.replace(/_/g, ' ')));
    list.forEach(m => {
      const checked = (cfg.metrics || []).includes(m.id);
      metricBox.appendChild(el('label', { class: 'metric-row' },
        el('input', { type: 'checkbox', value: m.id, checked: checked || false }),
        el('div', {}, el('strong', { style: { color: m.color || 'var(--text)' } }, m.label), el('span', { class: 'desc' }, m.description || ''))
      ));
    });
  }
  const rightPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-title' }, 'Metrics'),
    metricBox
  );

  presetSel.addEventListener('change', () => {
    const preset = (store.chartPresets || []).find(p => p.id === presetSel.value);
    if (!preset) return;
    const c = preset.config;
    instSel.setValue(c.instrument || cfg.instrument);
    baselineSel.setValue(c.baseline || cfg.baseline);
    strikeModeSel.setValue(c.strike_mode || cfg.strike_mode);
    chartTypeSel.setValue(c.chart_type || cfg.chart_type);
    strikeCountInput.value = c.strike_count ?? cfg.strike_count;
    strikesInput.value = (c.strikes || []).join(', ');
    metricBox.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = (c.metrics || []).includes(cb.value); });
  });

  const wrap = el('div', {},
    el('h2', {}, existing ? 'Edit chart' : 'New chart'),
    el('div', { class: 'row gap-12 mb-8' },
      el('div', { class: 'field', style: { flex: 2, margin: 0 } }, el('span', { class: 'label' }, 'Name'), nameInput),
      el('div', { class: 'field', style: { flex: 1, margin: 0 } }, el('span', { class: 'label' }, 'Preset'), presetSel),
    ),
    el('div', { class: 'modal-split mt-12' }, leftPanel, rightPanel),
    el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end' } },
      el('button', { class: 'btn ghost sm', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary sm', onclick: async () => {
        const newCfg = {
          instrument: instSel.getValue(),
          baseline: baselineSel.getValue(),
          strike_mode: strikeModeSel.getValue(),
          chart_type: chartTypeSel.getValue(),
          date: useToday.checked ? undefined : (dateInput.value || undefined),
          strike_count: Number(strikeCountInput.value || 0),
          strikes: strikesInput.value.split(',').map(s => s.trim()).filter(Boolean).map(Number),
          metrics: [...metricBox.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value),
        };
        try {
          if (existing?.id) {
            await api.updateChart(existing.id, { name: nameInput.value, description: existing.description || '', config: newCfg });
            toast('Saved', 'success');
          } else {
            const created = await api.createChart({ name: nameInput.value, description: '', config: newCfg });
            activeTab = created.id;
            toast('Created', 'success');
          }
          store.savedCharts = await api.listCharts();
          // Dispose old instances for clean rebuild
          Object.values(chartInstances).forEach(c => { try { c.dispose(); } catch {} });
          chartInstances = {};
          _built = false;
          window.dispatchEvent(new CustomEvent('charts:refresh'));
          m.close();
        } catch (e) {}
      } }, 'Save')
    )
  );
  const m = modal(wrap);
}

function renderEchart(inst, payload, chartType) {
  const hasRight = payload.series?.some(s => s.axis === 'right');
  let series = [];
  let xAxis = { type: 'time', ...CHART_AXIS_STYLE };
  let yAxis = [
    { type: 'value', scale: true, ...CHART_AXIS_STYLE },
    { type: 'value', scale: true, show: hasRight, ...CHART_AXIS_STYLE, splitLine: { show: false } },
  ];

  if (chartType === 'line' || chartType === 'area') {
    series = (payload.series || []).map(s => ({
      name: s.label, type: 'line', smooth: true, showSymbol: false,
      lineStyle: { color: s.color, width: 1.5 },
      itemStyle: { color: s.color },
      yAxisIndex: s.axis === 'right' ? 1 : 0,
      data: (s.points || []).map(p => [p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''), p.value]),
      ...(chartType === 'area' ? { areaStyle: { color: s.color, opacity: 0.15 } } : {})
    }));
  } else if (chartType === 'bar') {
    series = (payload.series || []).map(s => ({
      name: s.label, type: 'bar', itemStyle: { color: s.color },
      yAxisIndex: s.axis === 'right' ? 1 : 0,
      data: (s.points || []).map(p => [p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''), p.value]),
      stack: /oi/i.test(s.label) ? 'oi' : undefined,
    }));
  } else if (chartType === 'candle') {
    const spot = (payload.series || []).find(s => /spot/i.test(s.label)) || payload.series?.[0];
    const ohlc = resampleOHLC(spot?.points || [], 5 * 60 * 1000);
    xAxis = { type: 'category', data: ohlc.map(r => r.t), ...CHART_AXIS_STYLE };
    yAxis = [{ type: 'value', scale: true, ...CHART_AXIS_STYLE }];
    series = [{
      name: spot?.label || 'spot', type: 'candlestick',
      data: ohlc.map(r => [r.o, r.c, r.l, r.h]),
      itemStyle: { color: '#b1ffc2', color0: '#ff8a9e', borderColor: '#b1ffc2', borderColor0: '#ff8a9e' },
    }];
  } else if (chartType === 'heatmap') {
    const points = []; const strikes = new Set(); const times = new Set();
    (payload.series || []).forEach(s => (s.points || []).forEach(p => {
      const ts = p.timestamp.replace(/([+-]\d{2}:\d{2})$/, '');
      if (p.strike != null) { strikes.add(p.strike); times.add(ts); points.push([ts, p.strike, p.value]); }
    }));
    if (!points.length) { inst.setOption({ title: { text: 'Heatmap requires non-aggregate strike mode', textStyle: { color: '#a0a0aa', fontSize: 12 }, top: 'middle', left: 'center' }, series: [] }, true); return; }
    xAxis = { type: 'category', data: [...times].sort(), ...CHART_AXIS_STYLE };
    yAxis = [{ type: 'category', data: [...strikes].sort((a, b) => a - b), ...CHART_AXIS_STYLE }];
    series = [{ name: 'heat', type: 'heatmap', data: points }];
  } else if (chartType === 'scatter') {
    const s1 = payload.series?.[0]; const s2 = payload.series?.[1];
    if (!s1 || !s2) { inst.setOption({ series: [], title: { text: 'Scatter needs 2 metrics', textStyle: { color: '#a0a0aa' }, top: 'middle', left: 'center' } }, true); return; }
    const byTime = new Map();
    (s1.points || []).forEach(p => byTime.set(p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''), [p.value, null]));
    (s2.points || []).forEach(p => { const ts = p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''); const e = byTime.get(ts) || [null, null]; e[1] = p.value; byTime.set(ts, e); });
    const data = [...byTime.values()].filter(([a, b]) => a != null && b != null);
    xAxis = { type: 'value', scale: true, name: s1.label, ...CHART_AXIS_STYLE };
    yAxis = [{ type: 'value', scale: true, name: s2.label, ...CHART_AXIS_STYLE }];
    series = [{ name: `${s1.label} × ${s2.label}`, type: 'scatter', data, itemStyle: { color: s1.color, opacity: 0.6 } }];
  } else if (chartType === 'histogram') {
    const vals = [];
    (payload.series || []).forEach(s => (s.points || []).forEach(p => vals.push(p.value)));
    if (!vals.length) { inst.setOption({ series: [] }, true); return; }
    const min = Math.min(...vals), max = Math.max(...vals);
    const bins = 20, w = (max - min) / bins || 1;
    const buckets = new Array(bins).fill(0);
    vals.forEach(v => { const i = Math.min(bins - 1, Math.floor((v - min) / w)); buckets[i]++; });
    const data = buckets.map((c, i) => [(min + i * w).toFixed(2), c]);
    xAxis = { type: 'category', data: data.map(d => d[0]), ...CHART_AXIS_STYLE };
    yAxis = [{ type: 'value', ...CHART_AXIS_STYLE }];
    series = [{ name: 'count', type: 'bar', data: data.map(d => d[1]), itemStyle: { color: '#c6c0ff' } }];
  }

  inst.setOption({
    animation: false,
    backgroundColor: 'transparent',
    color: (payload.series || []).map(s => s.color),
    tooltip: { trigger: chartType === 'scatter' ? 'item' : 'axis', axisPointer: { type: 'cross', crossStyle: { color: '#5a5a68', type: 'dashed' }, lineStyle: { color: '#5a5a68', type: 'dashed' } }, backgroundColor: 'rgba(18,18,26,0.95)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1, textStyle: { color: '#fff', fontSize: 11 } },
    legend: { textStyle: { color: '#9c9caa', fontSize: 10 }, top: 0, type: 'scroll' },
    grid: { left: 56, right: hasRight ? 56 : 16, top: 28, bottom: 48 },
    xAxis, yAxis,
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', height: 16, bottom: 6, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'transparent', fillerColor: 'rgba(198,192,255,0.15)', handleStyle: { color: '#c6c0ff' }, textStyle: { color: '#5a5a68' } }
    ],
    series,
  }, true);
}

function resampleOHLC(points, bucketMs) {
  if (!points.length) return [];
  const out = new Map();
  for (const p of points) {
    const t = new Date(p.timestamp.replace(/([+-]\d{2}:\d{2})$/, '')).getTime();
    const b = Math.floor(t / bucketMs) * bucketMs;
    const key = new Date(b).toISOString();
    let r = out.get(key);
    if (!r) { r = { t: key, o: p.value, h: p.value, l: p.value, c: p.value }; out.set(key, r); }
    else { r.h = Math.max(r.h, p.value); r.l = Math.min(r.l, p.value); r.c = p.value; }
  }
  return [...out.values()];
}

window.addEventListener('charts:refresh', async () => {
  try {
    store.savedCharts = await api.listCharts();
    // Rebuild on structural changes (new/deleted chart)
    Object.values(chartInstances).forEach(c => { try { c.dispose(); } catch {} });
    chartInstances = {};
    _built = false;
    buildToolbar();
    render();
  } catch (e) {}
});
