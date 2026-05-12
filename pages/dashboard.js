// pages/dashboard.js — original layout, new flat aesthetic
import { el, fmtNum, fmtCompact, fmtPct, fmtSigned, timeAgo, fmtTimeIST, CHART_AXIS_STYLE } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let pollTimer, statusTimer;
let featuredChart;
let sparkCharts = {};
let currentInstrument = 'nifty';

// DOM refs populated once on first render
let _hero, _instGrid, _utilRow, _featuredCard, _bottomRow, _page;
let _heroEls = {};
let _instCards = {};   // keyed by instrument
let _utilEls = {};
let _bottomEls = {};
let _featuredEls = {};
let _initialized = false;

export async function mount(container) {
  container.innerHTML = '';
  _page = el('div', { class: 'page' });
  container.appendChild(_page);

  _hero = el('div', { class: 'card', style: { marginBottom: '16px', padding: '20px 24px', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' } });
  _page.appendChild(_hero);

  _instGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '16px' } });
  _page.appendChild(_instGrid);

  _utilRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '16px', marginBottom: '16px' } });
  _page.appendChild(_utilRow);

  _featuredCard = el('div', { class: 'card', style: { marginBottom: '16px', minHeight: '420px', display: 'flex', flexDirection: 'column' } });
  _page.appendChild(_featuredCard);

  _bottomRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: '16px' } });
  _page.appendChild(_bottomRow);

  _initialized = false;
  await refresh();
  pollTimer = setInterval(refresh, 60000);
  statusTimer = setInterval(async () => {
    try { const s = await api.status(); store.status = s.service_status || s; } catch (e) {}
  }, 10000);

  window.addEventListener('resize', resize);
}

// ---- Hero ----
function buildHero(data) {
  const it = data.instruments.find(i => i.instrument === currentInstrument) || data.instruments[0];

  const sel = el('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 18px 10px 12px', background: 'var(--surface-2)', borderRadius: 'var(--r-pill)' } });
  _heroEls.icon = el('span', { style: { width: '32px', height: '32px', borderRadius: '999px', background: 'var(--surface-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '13px' } }, (it.label || '?')[0]);
  _heroEls.label = el('div', { style: { fontWeight: 600, fontSize: '14px' } }, it.label);
  sel.appendChild(_heroEls.icon);
  sel.appendChild(el('div', {}, _heroEls.label, el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Index')));
  const dropdown = el('select', { style: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' } },
    ...data.instruments.map(i => el('option', { value: i.instrument, selected: i.instrument === currentInstrument }, i.label))
  );
  dropdown.addEventListener('change', () => { currentInstrument = dropdown.value; refresh(); });
  sel.appendChild(dropdown);
  _hero.appendChild(sel);

  const makeStat = (k) => {
    const val = el('span', { class: 'num', style: { fontSize: '14px', fontWeight: 500 } });
    const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '20px', borderLeft: '1px solid var(--border)' } },
      el('span', { class: 'label' }, k), val
    );
    _hero.appendChild(wrap);
    return val;
  };
  _heroEls.spot = makeStat('Spot');
  _heroEls.change = makeStat('24h Change');
  _heroEls.pcr = makeStat('Portfolio PCR');
  _heroEls.atm = makeStat('ATM Strike');
  _heroEls.strikes = makeStat('Strikes');
  _heroEls.rows = makeStat('Snapshot Rows');
  updateHero(data);
}

function updateHero(data) {
  const it = data.instruments.find(i => i.instrument === currentInstrument) || data.instruments[0];
  const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
  _heroEls.icon.textContent = (it.label || '?')[0];
  _heroEls.label.textContent = it.label;
  _heroEls.spot.textContent = fmtNum(it.spot, 2);
  _heroEls.spot.className = 'num';
  _heroEls.change.textContent = `${fmtSigned(it.change_abs, 2)} (${fmtPct(it.change_pct)})`;
  _heroEls.change.className = 'num ' + tone;
  _heroEls.pcr.textContent = fmtNum(it.pcr, 3);
  _heroEls.pcr.className = 'num ' + (it.pcr >= 1 ? 'bull' : 'bear');
  _heroEls.atm.textContent = fmtNum(it.atm_strike);
  _heroEls.atm.className = 'num';
  _heroEls.strikes.textContent = String(it.strikes ?? '—');
  _heroEls.strikes.className = 'num';
  _heroEls.rows.textContent = String(it.snapshot_rows ?? '—');
  _heroEls.rows.className = 'num';
}

// ---- Instrument Cards ----
function buildInstrumentCards(data) {
  _instCards = {};
  data.instruments.forEach(it => {
    const card = el('div', {
      class: 'card',
      style: { cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '14px' },
      onclick: () => { currentInstrument = it.instrument; refresh(); }
    });

    const pill = el('span', { class: 'change-pill' });
    const hdr = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      el('div', {},
        el('div', { style: { fontSize: '15px', fontWeight: 600 } }, it.label),
        el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' } }, it.instrument)
      ), pill
    );
    card.appendChild(hdr);

    const spotVal = el('div', { style: { fontSize: '28px', fontWeight: 600, fontFamily: 'var(--mono)' } });
    const spotSub = el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } });
    card.appendChild(el('div', {}, spotVal, spotSub));

    const pcrLabel = el('span', { style: { fontWeight: 600 } });
    const pcrBar = el('div', { style: { height: '100%', borderRadius: '999px', transition: 'width 0.4s ease' } });
    card.appendChild(el('div', {},
      el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } },
        el('span', {}, 'PCR'), pcrLabel
      ),
      el('div', { style: { height: '4px', background: 'var(--surface-3)', borderRadius: '999px', overflow: 'hidden' } }, pcrBar)
    ));

    const ceOi = el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } });
    const ceChange = el('div', { class: 'mono', style: { fontSize: '10px' } });
    const peOi = el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } });
    const peChange = el('div', { class: 'mono', style: { fontSize: '10px' } });
    card.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      el('div', {}, el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Call OI'), ceOi, ceChange),
      el('div', {}, el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Put OI'), peOi, peChange)
    ));

    const spark = el('div', { style: { height: '50px', marginTop: '4px', marginInline: '-4px' } });
    card.appendChild(spark);
    _instGrid.appendChild(card);

    _instCards[it.instrument] = { card, pill, spotVal, spotSub, pcrLabel, pcrBar, ceOi, ceChange, peOi, peChange, spark };
  });
}

function updateInstrumentCards(data) {
  data.instruments.forEach(it => {
    const refs = _instCards[it.instrument];
    if (!refs) return;
    const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
    const pcrTone = (it.pcr ?? 1) >= 1 ? 'bull' : 'bear';
    const active = it.instrument === currentInstrument;

    refs.card.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    refs.card.onclick = () => { currentInstrument = it.instrument; refresh(); };
    refs.pill.className = `change-pill ${tone}`;
    refs.pill.textContent = fmtPct(it.change_pct);
    refs.spotVal.textContent = fmtNum(it.spot, 2);
    refs.spotSub.textContent = `${fmtSigned(it.change_abs, 2)} since prev close`;

    const pcrPct = Math.min(100, Math.max(0, ((it.pcr ?? 1) / 2) * 100));
    refs.pcrLabel.className = `mono ${pcrTone}`;
    refs.pcrLabel.textContent = fmtNum(it.pcr, 3);
    refs.pcrBar.style.width = pcrPct + '%';
    refs.pcrBar.style.background = pcrTone === 'bull' ? 'var(--bull)' : 'var(--bear)';

    refs.ceOi.textContent = fmtCompact(it.total_ce_oi);
    refs.ceChange.className = `mono ${it.ce_oi_change >= 0 ? 'bull' : 'bear'}`;
    refs.ceChange.textContent = fmtSigned(it.ce_oi_change, 0) === '—' ? '—' : (it.ce_oi_change >= 0 ? '+' : '') + fmtCompact(it.ce_oi_change);
    refs.peOi.textContent = fmtCompact(it.total_pe_oi);
    refs.peChange.className = `mono ${it.pe_oi_change >= 0 ? 'bull' : 'bear'}`;
    refs.peChange.textContent = fmtSigned(it.pe_oi_change, 0) === '—' ? '—' : (it.pe_oi_change >= 0 ? '+' : '') + fmtCompact(it.pe_oi_change);

    // Sparkline — create or update
    const pts = (it.spark?.spot || []).map((v, i) => [it.spark.timestamps[i].replace(/([+-]\d{2}:\d{2})$/, ''), v]);
    const col = tone === 'bull' ? '#b1ffc2' : '#ff8a9e';
    if (sparkCharts[it.instrument]) {
      sparkCharts[it.instrument].setOption({ series: [{ data: pts, lineStyle: { color: col }, itemStyle: { color: col }, areaStyle: { color: col, opacity: 0.08 } }] });
    } else {
      setTimeout(() => {
        const c = echarts.init(refs.spark, null, { renderer: 'canvas' });
        sparkCharts[it.instrument] = c;
        c.setOption({
          animation: false,
          grid: { left: 0, right: 0, top: 4, bottom: 0 },
          xAxis: { type: 'time', show: false },
          yAxis: { type: 'value', scale: true, show: false },
          tooltip: { trigger: 'axis', backgroundColor: '#181820', borderColor: '#23232b', textStyle: { color: '#fff', fontSize: 11 } },
          series: [{ type: 'line', data: pts, smooth: true, showSymbol: false, lineStyle: { color: col, width: 1.5 }, areaStyle: { color: col, opacity: 0.08 } }],
        });
      }, 0);
    }
  });
}

// ---- Service + Totals ----
function buildUtil(data) {
  const svc = data.service || {};
  const tot = data.totals || {};

  // Service card
  _utilEls.statePill = el('span', { class: `pill ${svc.market_state || ''}` }, el('span', { class: 'dot' }), svc.market_state || '—');
  _utilEls.lastFetch = el('div', { class: 'mono', style: { fontSize: '13px' } });
  _utilEls.nextFetch = el('div', { class: 'mono', style: { fontSize: '13px' } });
  _utilEls.collector = el('div', { class: 'mono', style: { fontSize: '13px' } });
  _utilEls.api = el('div', { class: 'mono', style: { fontSize: '13px' } });
  _utilEls.error = el('div', { class: 'mono text-xs', style: { color: 'var(--bear)', background: 'rgba(255,138,158,0.06)', padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,138,158,0.2)', display: 'none' } });

  const svcCard = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Service'), _utilEls.statePill
    ),
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
      el('div', {}, el('div', { class: 'label' }, 'Last fetch'), _utilEls.lastFetch),
      el('div', {}, el('div', { class: 'label' }, 'Next fetch'), _utilEls.nextFetch),
      el('div', {}, el('div', { class: 'label' }, 'Collector'), _utilEls.collector),
      el('div', {}, el('div', { class: 'label' }, 'API'), _utilEls.api),
    ),
    _utilEls.error,
    el('div', { style: { display: 'flex', gap: '8px', marginTop: 'auto' } },
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#settings'; } }, 'Configure'),
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#data?tab=events'; } }, 'View events'),
    )
  );
  _utilRow.appendChild(svcCard);

  // Totals card
  _utilEls.sentiment = el('span', { class: 'change-pill' });
  _utilEls.ceOi = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } });
  _utilEls.peOi = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } });
  _utilEls.portPcr = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } });
  _utilEls.live = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } });

  const totCard = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Across all instruments'), _utilEls.sentiment
    ),
    el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' } },
      el('div', {}, el('div', { class: 'label' }, 'Combined Call OI'), _utilEls.ceOi),
      el('div', {}, el('div', { class: 'label' }, 'Combined Put OI'), _utilEls.peOi),
      el('div', {}, el('div', { class: 'label' }, 'Portfolio PCR'), _utilEls.portPcr),
      el('div', {}, el('div', { class: 'label' }, 'Live instruments'), _utilEls.live),
    ),
  );
  _utilRow.appendChild(totCard);
  updateUtil(data);
}

function updateUtil(data) {
  const svc = data.service || {};
  const tot = data.totals || {};

  _utilEls.statePill.className = `pill ${svc.market_state || ''}`;
  _utilEls.statePill.textContent = '';
  _utilEls.statePill.appendChild(el('span', { class: 'dot' }));
  _utilEls.statePill.appendChild(document.createTextNode(svc.market_state || '—'));
  _utilEls.lastFetch.textContent = timeAgo(svc.last_fetch);
  _utilEls.nextFetch.textContent = fmtTimeIST(svc.next_fetch);
  _utilEls.collector.textContent = svc.collector_running ? 'active' : 'idle';
  _utilEls.collector.className = `mono ${svc.collector_running ? 'bull' : 'bear'}`;
  _utilEls.api.textContent = svc.api_running ? 'active' : 'idle';
  _utilEls.api.className = `mono ${svc.api_running ? 'bull' : 'bear'}`;

  if (svc.last_error) {
    _utilEls.error.style.display = '';
    _utilEls.error.textContent = String(svc.last_error).slice(0, 120);
    _utilEls.error.title = svc.last_error;
  } else {
    _utilEls.error.style.display = 'none';
  }

  const sentLabel = tot.sentiment?.label || '—';
  const sentTone = tot.sentiment?.tone === 'bull' ? 'bull' : tot.sentiment?.tone === 'bear' ? 'bear' : 'neutral';
  _utilEls.sentiment.className = `change-pill ${sentTone}`;
  _utilEls.sentiment.textContent = sentLabel;
  _utilEls.ceOi.textContent = fmtCompact(tot.total_ce_oi);
  _utilEls.peOi.textContent = fmtCompact(tot.total_pe_oi);
  _utilEls.portPcr.textContent = fmtNum(tot.portfolio_pcr, 3);
  _utilEls.portPcr.className = `mono ${(tot.portfolio_pcr || 0) >= 1 ? 'bull' : 'bear'}`;
  _utilEls.live.textContent = `${tot.available_instruments ?? 0} / ${(data.instruments || []).length}`;
}

// ---- Featured Chart ----
function buildFeatured() {
  _featuredEls.title = el('div', { style: { fontSize: '14px', fontWeight: 600 } });
  _featuredEls.canvas = el('div', { style: { flex: 1, minHeight: '320px' } });
  _featuredCard.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    el('div', {}, _featuredEls.title, el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Today, 1-minute resolution')),
    el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#charts'; } }, 'Open in workspace')
  ));
  _featuredCard.appendChild(_featuredEls.canvas);
  featuredChart = echarts.init(_featuredEls.canvas, null, { renderer: 'canvas' });
  featuredChart.setOption({
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: '#5d5d6a', type: 'dashed' }, lineStyle: { color: '#5d5d6a', type: 'dashed' } },
      backgroundColor: '#181820', borderColor: '#23232b', borderWidth: 1, padding: [10, 14],
      textStyle: { color: '#fff', fontSize: 11 },
    },
    legend: { textStyle: { color: '#9c9ca8', fontSize: 11 }, top: 0, right: 0 },
    grid: { left: 56, right: 56, top: 24, bottom: 36 },
    xAxis: { type: 'time', ...CHART_AXIS_STYLE },
    yAxis: [
      { type: 'value', scale: true, position: 'left', ...CHART_AXIS_STYLE, splitLine: { lineStyle: { color: '#181820', type: 'dashed' } } },
      { type: 'value', scale: true, position: 'right', ...CHART_AXIS_STYLE, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside' }],
    series: [],
  });
}

async function loadFeatured() {
  if (!featuredChart) return;
  const it = (store.dashboard?.instruments || []).find(i => i.instrument === currentInstrument);
  _featuredEls.title.textContent = `Spot × PCR — ${it?.label || ''}`;
  try {
    const payload = await api.chartData({
      instrument: currentInstrument,
      metrics: ['underlying_spot_price', 'pcr'],
      strike_mode: 'aggregate',
      baseline: 'post_settlement',
    });
    const series = payload.series.map((s, i) => {
      const isSpot = i === 0;
      return {
        name: s.label,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: isSpot ? '#ffffff' : '#c6c0ff', width: 1.6 },
        areaStyle: isSpot ? { color: 'rgba(255,255,255,0.03)' } : undefined,
        yAxisIndex: isSpot ? 0 : 1,
        data: s.points.map(p => [p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''), p.value]),
      };
    });
    featuredChart.setOption({ series }, { replaceMerge: ['series'] });
  } catch (e) { console.error(e); }
}

// ---- Bottom Row (movers + activity) ----
function buildBottom(data) {
  // Top movers
  const movers = el('div', { class: 'card' });
  movers.appendChild(el('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px' } }, 'Top movers'));
  _bottomEls.moverRows = {};
  const sorted = [...data.instruments].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
  sorted.forEach(it => {
    const label = el('div', { style: { fontSize: '13px', fontWeight: 500 } }, it.label);
    const spot = el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)' } });
    const pill = el('span', { class: 'change-pill' });
    movers.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' } },
      el('div', {}, label, spot), pill
    ));
    _bottomEls.moverRows[it.instrument] = { label, spot, pill };
  });
  _bottomRow.appendChild(movers);

  // Activity
  const activity = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column' } });
  activity.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Recent activity'),
    el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#data'; } }, 'See all')
  ));
  _bottomEls.activityList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  activity.appendChild(_bottomEls.activityList);
  _bottomRow.appendChild(activity);
}

function updateBottom(data) {
  // Movers
  const sorted = [...data.instruments].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
  sorted.forEach(it => {
    const refs = _bottomEls.moverRows[it.instrument];
    if (!refs) return;
    const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
    refs.spot.textContent = fmtNum(it.spot, 2);
    refs.pill.className = `change-pill ${tone}`;
    refs.pill.textContent = fmtPct(it.change_pct);
  });

  // Activity (async, non-blocking)
  api.events(10).then(evs => {
    const list = _bottomEls.activityList;
    list.innerHTML = '';
    (evs.events || []).forEach(ev => {
      list.appendChild(el('div', { class: `event-row ${ev.level}`, style: { padding: '6px 10px' } },
        el('span', { class: 'dim' }, fmtTimeIST(ev.timestamp)),
        el('span', { class: 'level' }, ev.level),
        el('span', { class: 'mono dim' }, ev.logger || ''),
        el('span', { class: 'msg', title: ev.message }, ev.message || '')
      ));
    });
    if (!(evs.events || []).length) list.appendChild(el('div', { class: 'dim text-xs', style: { padding: '8px' } }, 'No events yet'));
  }).catch(() => {});
}

// ---- Refresh ----
async function refresh() {
  try {
    const data = await api.dashboard(60);
    store.dashboard = data;
    store.status = data.service;
    if (!data.instruments.find(i => i.instrument === currentInstrument)) currentInstrument = data.instruments[0]?.instrument || 'nifty';

    if (!_initialized) {
      buildHero(data);
      buildInstrumentCards(data);
      buildUtil(data);
      buildFeatured();
      buildBottom(data);
      _initialized = true;
    } else {
      updateHero(data);
      updateInstrumentCards(data);
      updateUtil(data);
      updateBottom(data);
    }
    loadFeatured();
  } catch (e) {
    console.error(e);
    if (!_initialized) {
      _page.innerHTML = '';
      _page.appendChild(el('div', { class: 'card empty-state' },
        el('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--text)' } }, 'Could not reach backend'),
        el('span', { class: 'text-xs mono dim' }, e.message || 'Network error'),
        el('div', { class: 'mt-12 dim text-xs' }, 'API base: ' + store.apiBase),
        el('button', { class: 'btn primary mt-12', onclick: refresh }, 'Retry')
      ));
    }
  }
}

function resize() {
  featuredChart && featuredChart.resize();
  Object.values(sparkCharts).forEach(c => c.resize());
}

export function unmount() {
  clearInterval(pollTimer);
  clearInterval(statusTimer);
  if (featuredChart) { featuredChart.dispose(); featuredChart = null; }
  Object.values(sparkCharts).forEach(c => c.dispose());
  sparkCharts = {};
  _initialized = false;
  _heroEls = {};
  _instCards = {};
  _utilEls = {};
  _bottomEls = {};
  _featuredEls = {};
  window.removeEventListener('resize', resize);
}
