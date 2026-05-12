// pages/dashboard.js — original layout, new flat aesthetic
import { el, fmtNum, fmtCompact, fmtPct, fmtSigned, timeAgo, fmtTimeIST, CHART_AXIS_STYLE } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let pollTimer, statusTimer;
let featuredChart;
let sparkCharts = {};
let currentInstrument = 'nifty';
let _initialized = false;

// refs captured during first build for in-place updates
let _heroStatEls = {};    // { spot, change, pcr, atm, strikes, rows }
let _instCardEls = {};    // keyed by instrument → { pill, spotVal, spotSub, pcrLabel, pcrBar, ceOi, ceChange, peOi, peChange, card }
let _utilEls = {};        // { statePill, lastFetch, nextFetch, collector, api, error, sentiment, ceOi, peOi, portPcr, live }
let _bottomEls = {};      // { moverRows: {inst: {spot, pill}}, activityList }
let _featuredEls = {};    // { title }

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  // Hero strip
  const hero = el('div', { class: 'card', style: { marginBottom: '16px', padding: '20px 24px', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' } });
  page.appendChild(hero);

  // 3 instrument cards row
  const instGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '16px' } });
  page.appendChild(instGrid);

  // service + totals row
  const utilRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '16px', marginBottom: '16px' } });
  page.appendChild(utilRow);

  // featured chart
  const featuredCard = el('div', { class: 'card', style: { marginBottom: '16px', minHeight: '420px', display: 'flex', flexDirection: 'column' } });
  page.appendChild(featuredCard);

  // top movers + activity
  const bottomRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: '16px' } });
  page.appendChild(bottomRow);

  // ---- Hero (first build) ----
  function renderHero(data) {
    hero.innerHTML = '';
    _heroStatEls = {};
    const it = data.instruments.find(i => i.instrument === currentInstrument) || data.instruments[0];
    const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';

    const sel = el('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 18px 10px 12px', background: 'var(--surface-2)', borderRadius: 'var(--r-pill)' } });
    sel.appendChild(el('span', { style: { width: '32px', height: '32px', borderRadius: '999px', background: 'var(--surface-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '13px' } }, (it.label || '?')[0]));
    sel.appendChild(el('div', {}, el('div', { style: { fontWeight: 600, fontSize: '14px' } }, it.label), el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Index')));
    const dropdown = el('select', { style: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' } },
      ...data.instruments.map(i => el('option', { value: i.instrument, selected: i.instrument === currentInstrument }, i.label))
    );
    dropdown.addEventListener('change', () => { currentInstrument = dropdown.value; refresh(); });
    sel.appendChild(dropdown);
    hero.appendChild(sel);

    const makeStat = (k) => {
      const val = el('span', { class: 'num', style: { fontSize: '14px', fontWeight: 500 } });
      const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '20px', borderLeft: '1px solid var(--border)' } },
        el('span', { class: 'label' }, k), val
      );
      hero.appendChild(wrap);
      return val;
    };
    _heroStatEls.spot = makeStat('Spot');
    _heroStatEls.change = makeStat('24h Change');
    _heroStatEls.pcr = makeStat('Portfolio PCR');
    _heroStatEls.atm = makeStat('ATM Strike');
    _heroStatEls.strikes = makeStat('Strikes');
    _heroStatEls.rows = makeStat('Snapshot Rows');
    updateHero(data);
  }

  function updateHero(data) {
    const it = data.instruments.find(i => i.instrument === currentInstrument) || data.instruments[0];
    const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
    _heroStatEls.spot.textContent = fmtNum(it.spot, 2); _heroStatEls.spot.className = 'num';
    _heroStatEls.change.textContent = `${fmtSigned(it.change_abs, 2)} (${fmtPct(it.change_pct)})`; _heroStatEls.change.className = 'num ' + tone;
    _heroStatEls.pcr.textContent = fmtNum(it.pcr, 3); _heroStatEls.pcr.className = 'num ' + (it.pcr >= 1 ? 'bull' : 'bear');
    _heroStatEls.atm.textContent = fmtNum(it.atm_strike); _heroStatEls.atm.className = 'num';
    _heroStatEls.strikes.textContent = String(it.strikes ?? '—'); _heroStatEls.strikes.className = 'num';
    _heroStatEls.rows.textContent = String(it.snapshot_rows ?? '—'); _heroStatEls.rows.className = 'num';
  }

  // ---- Instrument Cards (first build) ----
  function renderInstrumentCards(data) {
    instGrid.innerHTML = '';
    Object.values(sparkCharts).forEach(c => c.dispose());
    sparkCharts = {};
    _instCardEls = {};

    data.instruments.forEach(it => {
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      const pcrTone = (it.pcr ?? 1) >= 1 ? 'bull' : 'bear';
      const active = it.instrument === currentInstrument;
      const card = el('div', {
        class: 'card',
        style: { cursor: 'pointer', borderColor: active ? 'var(--accent)' : 'var(--border)', display: 'flex', flexDirection: 'column', gap: '14px' },
        onclick: () => { currentInstrument = it.instrument; refresh(); }
      });

      const pill = el('span', { class: `change-pill ${tone}` }, fmtPct(it.change_pct));
      card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
        el('div', {},
          el('div', { style: { fontSize: '15px', fontWeight: 600 } }, it.label),
          el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' } }, it.instrument)
        ), pill
      ));

      const spotVal = el('div', { style: { fontSize: '28px', fontWeight: 600, fontFamily: 'var(--mono)' } }, fmtNum(it.spot, 2));
      const spotSub = el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `${fmtSigned(it.change_abs, 2)} since prev close`);
      card.appendChild(el('div', {}, spotVal, spotSub));

      const pcrPct = Math.min(100, Math.max(0, ((it.pcr ?? 1) / 2) * 100));
      const pcrLabel = el('span', { class: `mono ${pcrTone}`, style: { fontWeight: 600 } }, fmtNum(it.pcr, 3));
      const pcrBar = el('div', { style: { height: '100%', width: pcrPct + '%', background: pcrTone === 'bull' ? 'var(--bull)' : 'var(--bear)', borderRadius: '999px' } });
      card.appendChild(el('div', {},
        el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } },
          el('span', {}, 'PCR'), pcrLabel
        ),
        el('div', { style: { height: '4px', background: 'var(--surface-3)', borderRadius: '999px', overflow: 'hidden' } }, pcrBar)
      ));

      const ceOi = el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } }, fmtCompact(it.total_ce_oi));
      const ceChange = el('div', { class: `mono ${it.ce_oi_change >= 0 ? 'bull' : 'bear'}`, style: { fontSize: '10px' } },
        fmtSigned(it.ce_oi_change, 0) === '—' ? '—' : (it.ce_oi_change >= 0 ? '+' : '') + fmtCompact(it.ce_oi_change));
      const peOi = el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } }, fmtCompact(it.total_pe_oi));
      const peChange = el('div', { class: `mono ${it.pe_oi_change >= 0 ? 'bull' : 'bear'}`, style: { fontSize: '10px' } },
        fmtSigned(it.pe_oi_change, 0) === '—' ? '—' : (it.pe_oi_change >= 0 ? '+' : '') + fmtCompact(it.pe_oi_change));
      card.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
        el('div', {}, el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Call OI'), ceOi, ceChange),
        el('div', {}, el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Put OI'), peOi, peChange)
      ));

      const spark = el('div', { style: { height: '50px', marginTop: '4px', marginInline: '-4px' } });
      card.appendChild(spark);
      instGrid.appendChild(card);

      _instCardEls[it.instrument] = { card, pill, spotVal, spotSub, pcrLabel, pcrBar, ceOi, ceChange, peOi, peChange, spark };
    });
  }

  function updateInstrumentCards(data) {
    data.instruments.forEach(it => {
      const refs = _instCardEls[it.instrument];
      if (!refs) return;
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      const pcrTone = (it.pcr ?? 1) >= 1 ? 'bull' : 'bear';
      refs.card.style.borderColor = it.instrument === currentInstrument ? 'var(--accent)' : 'var(--border)';
      refs.card.onclick = () => { currentInstrument = it.instrument; refresh(); };
      refs.pill.className = `change-pill ${tone}`; refs.pill.textContent = fmtPct(it.change_pct);
      refs.spotVal.textContent = fmtNum(it.spot, 2);
      refs.spotSub.textContent = `${fmtSigned(it.change_abs, 2)} since prev close`;
      const pcrPct = Math.min(100, Math.max(0, ((it.pcr ?? 1) / 2) * 100));
      refs.pcrLabel.className = `mono ${pcrTone}`; refs.pcrLabel.textContent = fmtNum(it.pcr, 3);
      refs.pcrBar.style.width = pcrPct + '%'; refs.pcrBar.style.background = pcrTone === 'bull' ? 'var(--bull)' : 'var(--bear)';
      refs.ceOi.textContent = fmtCompact(it.total_ce_oi);
      refs.ceChange.className = `mono ${it.ce_oi_change >= 0 ? 'bull' : 'bear'}`;
      refs.ceChange.textContent = fmtSigned(it.ce_oi_change, 0) === '—' ? '—' : (it.ce_oi_change >= 0 ? '+' : '') + fmtCompact(it.ce_oi_change);
      refs.peOi.textContent = fmtCompact(it.total_pe_oi);
      refs.peChange.className = `mono ${it.pe_oi_change >= 0 ? 'bull' : 'bear'}`;
      refs.peChange.textContent = fmtSigned(it.pe_oi_change, 0) === '—' ? '—' : (it.pe_oi_change >= 0 ? '+' : '') + fmtCompact(it.pe_oi_change);

      // Sparkline: create or update
      const pts = (it.spark?.spot || []).map((v, i) => [it.spark.timestamps[i].replace(/([+-]\d{2}:\d{2})$/, ''), v]);
      const col = tone === 'bull' ? '#b1ffc2' : '#ff8a9e';
      if (sparkCharts[it.instrument]) {
        sparkCharts[it.instrument].setOption({ series: [{ data: pts, lineStyle: { color: col }, itemStyle: { color: col }, areaStyle: { color: col, opacity: 0.08 } }] });
      } else {
        const c = echarts.init(refs.spark, null, { renderer: 'canvas' });
        sparkCharts[it.instrument] = c;
        c.setOption({
          animation: false, grid: { left: 0, right: 0, top: 4, bottom: 0 },
          xAxis: { type: 'time', show: false }, yAxis: { type: 'value', scale: true, show: false },
          tooltip: { trigger: 'axis', backgroundColor: '#181820', borderColor: '#23232b', textStyle: { color: '#fff', fontSize: 11 } },
          series: [{ type: 'line', data: pts, smooth: true, showSymbol: false, lineStyle: { color: col, width: 1.5 }, areaStyle: { color: col, opacity: 0.08 } }],
        });
      }
    });
  }

  // ---- Service + Totals (first build) ----
  function renderUtil(data) {
    utilRow.innerHTML = '';
    _utilEls = {};
    const svc = data.service || {};
    const tot = data.totals || {};

    _utilEls.statePill = el('span', { class: `pill ${svc.market_state || ''}` }, el('span', { class: 'dot' }), svc.market_state || '—');
    _utilEls.lastFetch = el('div', { class: 'mono', style: { fontSize: '13px' } }, timeAgo(svc.last_fetch));
    _utilEls.nextFetch = el('div', { class: 'mono', style: { fontSize: '13px' } }, fmtTimeIST(svc.next_fetch));
    _utilEls.collector = el('div', { class: `mono ${svc.collector_running ? 'bull' : 'bear'}`, style: { fontSize: '13px' } }, svc.collector_running ? 'active' : 'idle');
    _utilEls.api = el('div', { class: `mono ${svc.api_running ? 'bull' : 'bear'}`, style: { fontSize: '13px' } }, svc.api_running ? 'active' : 'idle');
    _utilEls.error = el('div', { class: 'mono text-xs', style: { color: 'var(--bear)', background: 'rgba(255,138,158,0.06)', padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,138,158,0.2)', display: svc.last_error ? '' : 'none' }, title: svc.last_error || '' }, svc.last_error ? String(svc.last_error).slice(0, 120) : '');

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
    utilRow.appendChild(svcCard);

    const sentLabel = tot.sentiment?.label || '—';
    const sentTone = tot.sentiment?.tone === 'bull' ? 'bull' : tot.sentiment?.tone === 'bear' ? 'bear' : 'neutral';
    _utilEls.sentiment = el('span', { class: `change-pill ${sentTone}` }, sentLabel);
    _utilEls.ceOi = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, fmtCompact(tot.total_ce_oi));
    _utilEls.peOi = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, fmtCompact(tot.total_pe_oi));
    _utilEls.portPcr = el('div', { class: `mono ${(tot.portfolio_pcr || 0) >= 1 ? 'bull' : 'bear'}`, style: { fontSize: '15px', fontWeight: 500 } }, fmtNum(tot.portfolio_pcr, 3));
    _utilEls.live = el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, `${tot.available_instruments ?? 0} / ${(data.instruments || []).length}`);

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
    utilRow.appendChild(totCard);
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
    if (svc.last_error) { _utilEls.error.style.display = ''; _utilEls.error.textContent = String(svc.last_error).slice(0, 120); _utilEls.error.title = svc.last_error; }
    else { _utilEls.error.style.display = 'none'; }
    const sentLabel = tot.sentiment?.label || '—';
    const sentTone = tot.sentiment?.tone === 'bull' ? 'bull' : tot.sentiment?.tone === 'bear' ? 'bear' : 'neutral';
    _utilEls.sentiment.className = `change-pill ${sentTone}`; _utilEls.sentiment.textContent = sentLabel;
    _utilEls.ceOi.textContent = fmtCompact(tot.total_ce_oi);
    _utilEls.peOi.textContent = fmtCompact(tot.total_pe_oi);
    _utilEls.portPcr.textContent = fmtNum(tot.portfolio_pcr, 3);
    _utilEls.portPcr.className = `mono ${(tot.portfolio_pcr || 0) >= 1 ? 'bull' : 'bear'}`;
    _utilEls.live.textContent = `${tot.available_instruments ?? 0} / ${(data.instruments || []).length}`;
  }

  // ---- Featured Chart ----
  function renderFeatured() {
    featuredCard.innerHTML = '';
    _featuredEls = {};
    const it = (store.dashboard?.instruments || []).find(i => i.instrument === currentInstrument) || (store.dashboard?.instruments || [])[0];
    _featuredEls.title = el('div', { style: { fontSize: '14px', fontWeight: 600 } }, `Spot × PCR — ${it?.label || ''}`);
    featuredCard.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
      el('div', {}, _featuredEls.title, el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Today, 1-minute resolution')),
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#charts'; } }, 'Open in workspace')
    ));
    const canvas = el('div', { style: { flex: 1, minHeight: '320px' } });
    featuredCard.appendChild(canvas);
    if (featuredChart) featuredChart.dispose();
    featuredChart = echarts.init(canvas, null, { renderer: 'canvas' });
    featuredChart.setOption({
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross', crossStyle: { color: '#5d5d6a', type: 'dashed' }, lineStyle: { color: '#5d5d6a', type: 'dashed' } }, backgroundColor: '#181820', borderColor: '#23232b', borderWidth: 1, padding: [10, 14], textStyle: { color: '#fff', fontSize: 11 } },
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
    loadFeatured();
  }

  async function loadFeatured() {
    if (!featuredChart) return;
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
          name: s.label, type: 'line', smooth: true, showSymbol: false,
          lineStyle: { color: isSpot ? '#ffffff' : '#c6c0ff', width: 1.6 },
          areaStyle: isSpot ? { color: 'rgba(255,255,255,0.03)' } : undefined,
          yAxisIndex: isSpot ? 0 : 1,
          data: s.points.map(p => [p.timestamp.replace(/([+-]\d{2}:\d{2})$/, ''), p.value]),
        };
      });
      featuredChart.setOption({ series }, { replaceMerge: ['series'] });
    } catch (e) { console.error(e); }
  }

  // ---- Bottom Row ----
  function renderBottom(data) {
    bottomRow.innerHTML = '';
    _bottomEls = { moverRows: {} };

    // Top movers
    const movers = el('div', { class: 'card' });
    movers.appendChild(el('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px' } }, 'Top movers'));
    const sorted = [...data.instruments].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
    sorted.forEach(it => {
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      const spot = el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)' } }, fmtNum(it.spot, 2));
      const pill = el('span', { class: `change-pill ${tone}` }, fmtPct(it.change_pct));
      movers.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' } },
        el('div', {},
          el('div', { style: { fontSize: '13px', fontWeight: 500 } }, it.label), spot
        ), pill
      ));
      _bottomEls.moverRows[it.instrument] = { spot, pill };
    });
    bottomRow.appendChild(movers);

    // Activity
    const activity = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column' } });
    activity.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
      el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Recent activity'),
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#data'; } }, 'See all')
    ));
    _bottomEls.activityList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    activity.appendChild(_bottomEls.activityList);
    bottomRow.appendChild(activity);
    updateBottom(data);
  }

  function updateBottom(data) {
    const sorted = [...data.instruments].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
    sorted.forEach(it => {
      const refs = _bottomEls.moverRows?.[it.instrument];
      if (!refs) return;
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      refs.spot.textContent = fmtNum(it.spot, 2);
      refs.pill.className = `change-pill ${tone}`; refs.pill.textContent = fmtPct(it.change_pct);
    });
    // Activity
    api.events(10).then(evs => {
      const list = _bottomEls.activityList;
      if (!list) return;
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
        renderHero(data);
        renderInstrumentCards(data);
        renderUtil(data);
        renderFeatured();
        renderBottom(data);
        _initialized = true;
      } else {
        updateHero(data);
        updateInstrumentCards(data);
        updateUtil(data);
        updateBottom(data);
        // Featured chart title + data
        const it = data.instruments.find(i => i.instrument === currentInstrument);
        if (_featuredEls.title) _featuredEls.title.textContent = `Spot × PCR — ${it?.label || ''}`;
        loadFeatured();
      }
    } catch (e) {
      console.error(e);
      if (!_initialized) {
        page.innerHTML = '';
        page.appendChild(el('div', { class: 'card empty-state' },
          el('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--text)' } }, 'Could not reach backend'),
          el('span', { class: 'text-xs mono dim' }, e.message || 'Network error'),
          el('div', { class: 'mt-12 dim text-xs' }, 'API base: ' + store.apiBase),
          el('button', { class: 'btn primary mt-12', onclick: refresh }, 'Retry')
        ));
      }
    }
  }

  await refresh();
  pollTimer = setInterval(refresh, 60000);
  statusTimer = setInterval(async () => {
    try { const s = await api.status(); store.status = s.service_status || s; } catch (e) {}
  }, 10000);

  window.addEventListener('resize', resize);
  function resize() {
    featuredChart && featuredChart.resize();
    Object.values(sparkCharts).forEach(c => c.resize());
  }
}

export function unmount() {
  clearInterval(pollTimer);
  clearInterval(statusTimer);
  if (featuredChart) { featuredChart.dispose(); featuredChart = null; }
  Object.values(sparkCharts).forEach(c => c.dispose());
  sparkCharts = {};
  _initialized = false;
  _heroStatEls = {};
  _instCardEls = {};
  _utilEls = {};
  _bottomEls = {};
  _featuredEls = {};
}
