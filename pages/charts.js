// pages/charts.js — workspace (grids up to 3x2) + tabs (1x1 fullview each)
import { el, toast, modal, icon, CHART_AXIS_STYLE, Select, DateSelect, filterMarketHours } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let mode = localStorage.getItem('charts.mode') || 'tabs';
let activeTab = null;
let chartInstances = {};
let pollTimer = null;

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

  // single horizontal toolbar row
  const toolbar = el('div', { class: 'charts-toolbar' });
  page.appendChild(toolbar);

  const body = el('div', {});
  page.appendChild(body);

  function buildToolbar() {
    toolbar.innerHTML = '';
    const seg = el('div', { class: 'segmented' },
      el('button', { class: 'seg' + (mode === 'tabs' ? ' active' : ''), onclick: () => switchMode('tabs') }, 'Tabs'),
      el('button', { class: 'seg' + (mode === 'workspace' ? ' active' : ''), onclick: () => switchMode('workspace') }, 'Workspace')
    );
    toolbar.appendChild(seg);

    if (mode === 'workspace') {
      const layout = localStorage.getItem('charts.layout') || '2×2';
      const lyt = el('div', { class: 'segmented' });
      WORKSPACE_PRESETS.forEach(p => {
        lyt.appendChild(el('button', {
          class: 'seg' + (layout === p ? ' active' : ''),
          onclick: () => { localStorage.setItem('charts.layout', p); buildToolbar(); render(); }
        }, p));
      });
      toolbar.appendChild(lyt);
    } else {
      // tab strip inline
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
            buildToolbar(); render();
            toast('Deleted', 'success');
          } catch (e) {}
        } });
        closeBtn.appendChild(icon('close'));
        t.appendChild(closeBtn);
        strip.appendChild(t);
      });
      toolbar.appendChild(strip);
    }

    // In tabs mode the flex:1 strip already fills all free width and scrolls
    // internally, so a spacer would just steal half of it back and cramp the
    // tab list. Only workspace mode needs the spacer to push New chart right.
    if (mode !== 'tabs') toolbar.appendChild(el('div', { class: 'spacer' }));
    toolbar.appendChild(el('button', { class: 'btn primary sm', style: { flexShrink: '0' }, onclick: () => openEditor(null) }, icon('plus'), 'New chart'));
  }

  function switchMode(next) {
    mode = next;
    localStorage.setItem('charts.mode', next);
    buildToolbar();
    render();
  }

  function render() {
    body.innerHTML = '';
    Object.values(chartInstances).forEach(c => c.dispose());
    chartInstances = {};
    if (mode === 'workspace') renderWorkspace(body);
    else renderTabs(body);
  }

  function renderWorkspace(root) {
    const layout = localStorage.getItem('charts.layout') || '2×2';
    const [cols, rows] = layout.split('×').map(Number);
    const grid = el('div', { class: 'workspace-grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` } });
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
  }

  function buildTile(chart) {
    const tile = el('div', { class: 'tile' });
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
      try { await api.deleteChart(chart.id); store.savedCharts = store.savedCharts.filter(c => c.id !== chart.id); buildToolbar(); render(); toast('Deleted', 'success'); } catch (e) {}
    } }, icon('trash')));
    head.appendChild(acts);
    tile.appendChild(head);
    const canvas = el('div', { class: 'echart', 'data-chart-id': chart.id });
    tile.appendChild(canvas);
    setTimeout(() => loadAndRender(canvas, cfg, chart.id), 0);
    return tile;
  }

  function renderTabs(root) {
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
    const head = el('div', { class: 'row mb-8', style: { justifyContent: 'space-between' } },
      el('div', {},
        el('div', { style: { fontSize: '14px', fontWeight: '600' } }, chart.name),
        el('div', { class: 'tile-meta mono mt-8' }, `${cfg.instrument} · ${cfg.strike_mode} · ${(cfg.metrics || []).join(', ')}`)
      ),
      el('div', { class: 'row gap-8' },
        el('button', { class: 'btn ghost sm', onclick: () => openEditor(chart) }, icon('edit'), 'Edit')
      )
    );
    const canvas = el('div', { class: 'echart', style: { flex: '1', minHeight: '0' }, 'data-chart-id': chart.id });
    card.appendChild(head);
    card.appendChild(canvas);
    root.appendChild(card);
    setTimeout(() => loadAndRender(canvas, cfg, chart.id), 0);
  }

  async function loadAndRender(div, cfg, id, silent = false) {
    try {
      const reqBody = {
        instrument: cfg.instrument,
        metrics: cfg.metrics?.length ? cfg.metrics : ['pcr'],
        strike_mode: cfg.strike_mode || 'aggregate',
        baseline: cfg.baseline || 'post_settlement',
        strike_count: cfg.strike_count || 0,
        strikes: cfg.strikes || [],
        date: cfg.date || undefined,
      };
      const payload = await api.chartData(reqBody);
      if (payload?.series) {
        payload.series.forEach(s => {
          if (Array.isArray(s.points)) s.points = filterMarketHours(s.points);
        });
      }
      const inst = chartInstances[id] || (chartInstances[id] = echarts.init(div, null, { renderer: 'canvas' }));
      renderEchart(inst, payload, cfg.chart_type || 'line');
    } catch (e) {
      if (!silent) div.innerHTML = `<div class="empty-state"><span class="bear">Chart error</span><span class="text-xs mono dim">${e.message}</span></div>`;
    }
  }

  window.__chartsRender = () => { buildToolbar(); render(); };
  buildToolbar();
  render();
  window.addEventListener('resize', resize);
  pollTimer = setInterval(() => {
    // Refresh chart data in-place without rebuilding DOM
    if (mode === 'workspace') {
      const layout = localStorage.getItem('charts.layout') || '2×2';
      const [cols, rows] = layout.split('×').map(Number);
      const charts = store.savedCharts.slice(0, cols * rows);
      charts.forEach(c => {
        const div = body.querySelector(`.echart[data-chart-id="${c.id}"]`);
        if (div && c.config) loadAndRender(div, c.config, c.id, true);
      });
    } else if (activeTab) {
      const chart = store.savedCharts.find(c => c.id === activeTab);
      if (chart) {
        const div = body.querySelector(`.echart[data-chart-id="${chart.id}"]`);
        if (div && chart.config) loadAndRender(div, chart.config, chart.id, true);
      }
    }
  }, 60000);
}

function resize() {
  Object.values(chartInstances).forEach(c => { try { c.resize(); } catch {} });
}

export function unmount() {
  Object.values(chartInstances).forEach(c => c.dispose());
  chartInstances = {};
  window.removeEventListener('resize', resize);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
  const instSel = Select({ options: instOptions, value: cfg.instrument, onChange: (v) => {
    chartDateSelect.refresh(v);
  } });

  const today = new Date().toISOString().slice(0, 10);
  const useToday = el('input', { type: 'checkbox', checked: !cfg.date });

  // DateSelect for chart editor — shows available dates in a menu box
  const chartDateSelect = DateSelect({
    instrument: cfg.instrument,
    apiDistinctFn: async (ins) => {
      try {
        const res = await api.dataDistinct('date', `?instrument=${ins}&limit=5000`);
        return (res.values || []).filter(Boolean);
      } catch { return []; }
    },
    placeholder: 'Today (live)',
    width: '150px',
  });
  if (cfg.date) chartDateSelect.setValue(cfg.date);

  const dateRow = el('div', { class: 'field' },
    el('span', { class: 'label' }, 'Date'),
    el('label', { class: 'row gap-8', style: { alignItems: 'center', flexWrap: 'wrap' } }, useToday, 'Today (live)', chartDateSelect.el)
  );
  useToday.addEventListener('change', () => {
    chartDateSelect.el.style.opacity = useToday.checked ? '0.4' : '1';
    chartDateSelect.el.style.pointerEvents = useToday.checked ? 'none' : '';
  });
  if (useToday.checked) {
    chartDateSelect.el.style.opacity = '0.4';
    chartDateSelect.el.style.pointerEvents = 'none';
  }

  const baselineMap = { post_settlement: 'Post settlement', prev_close: 'Previous close', market_open: 'Market open' };
  const baselineOptions = (cat.baselines || ['post_settlement', 'prev_close']).map(b => ({ value: b, label: baselineMap[b] || b }));
  const baselineSel = Select({ options: baselineOptions, value: cfg.baseline });

  const modeMap = { aggregate: 'Aggregate (all strikes)', atm_window: 'ATM window', custom: 'Custom strikes', all: 'All strikes (aggregated)' };
  const modeDesc = {
    aggregate: 'One line — sums OI across all available strikes.',
    atm_window: 'Focus on N strikes around ATM. Shows per-strike lines.',
    custom: 'Pick specific strikes. Shows per-strike lines.',
    all: 'One line — same as Aggregate, sums across every strike.',
  };
  const modeOptions = (cat.strike_modes || ['aggregate', 'atm_window', 'custom', 'all']).map(m => ({ value: m, label: modeMap[m] || m }));

  const strikeCountInput = el('input', { type: 'number', min: '1', max: '100', value: cfg.strike_count ?? 5 });
  const strikesInput = el('input', { type: 'text', placeholder: '24000, 24100', value: (cfg.strikes || []).join(', ') });

  // Conditional field visibility based on strike mode
  const modeDescEl = el('div', { class: 'dim text-xs mt-4', style: { lineHeight: '1.4' } }, modeDesc[cfg.strike_mode] || '');
  const atmCountField = el('div', { class: 'field' }, el('span', { class: 'label' }, 'Strikes each side'), strikeCountInput);
  const customStrikesField = el('div', { class: 'field' }, el('span', { class: 'label' }, 'Custom strikes'), strikesInput);

  function updateStrikeFields(mode) {
    modeDescEl.textContent = modeDesc[mode] || '';
    atmCountField.style.display = mode === 'atm_window' ? '' : 'none';
    customStrikesField.style.display = mode === 'custom' ? '' : 'none';
  }

  const strikeModeSel = Select({
    options: modeOptions,
    value: cfg.strike_mode,
    onChange: (v) => updateStrikeFields(v),
  });
  updateStrikeFields(cfg.strike_mode);

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
    modeDescEl,
    atmCountField,
    customStrikesField,
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
  const rightPanel = el('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' } },
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
    updateStrikeFields(c.strike_mode || cfg.strike_mode);
    metricBox.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = (c.metrics || []).includes(cb.value); });
    if (c.date) { useToday.checked = false; chartDateSelect.setValue(c.date); chartDateSelect.el.style.opacity = '1'; chartDateSelect.el.style.pointerEvents = ''; }
    else { useToday.checked = true; chartDateSelect.el.style.opacity = '0.4'; chartDateSelect.el.style.pointerEvents = 'none'; }
    chartDateSelect.refresh(c.instrument || cfg.instrument);
  });

  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } },
    el('h2', {}, existing ? 'Edit chart' : 'New chart'),
    el('div', { class: 'row gap-12 mb-8' },
      el('div', { class: 'field', style: { flex: 2, margin: 0 } }, el('span', { class: 'label' }, 'Name'), nameInput),
      el('div', { class: 'field', style: { flex: 1, margin: 0 } }, el('span', { class: 'label' }, 'Preset'), presetSel),
    ),
    el('div', { class: 'modal-split mt-12' }, leftPanel, rightPanel),
    el('div', { class: 'row gap-8 mt-12', style: { justifyContent: 'flex-end', flexShrink: 0 } },
      el('button', { class: 'btn ghost sm', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary sm', onclick: async () => {
        const newCfg = {
          instrument: instSel.getValue(),
          baseline: baselineSel.getValue(),
          strike_mode: strikeModeSel.getValue(),
          chart_type: chartTypeSel.getValue(),
          date: useToday.checked ? undefined : (chartDateSelect.getValue() || undefined),
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
      if (p.strike != null) { const ts = p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''); strikes.add(p.strike); times.add(ts); points.push([ts, p.strike, p.value]); }
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
  try { const list = await api.listCharts(); store.savedCharts = list; window.__chartsRender && window.__chartsRender(); } catch (e) {}
});
