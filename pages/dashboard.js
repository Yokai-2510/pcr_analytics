// pages/dashboard.js — original layout, new flat aesthetic
import { el, fmtNum, fmtCompact, fmtPct, fmtSigned, timeAgo, fmtTimeIST, CHART_AXIS_STYLE } from '../components.js';
import { api } from '../api.js';
import { store } from '../store.js';

let pollTimer, statusTimer;
let featuredChart;
let sparkCharts = {};
let currentInstrument = 'nifty';

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

  function renderHero(data) {
    hero.innerHTML = '';
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

    const stat = (k, v, cls = '') => el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '20px', borderLeft: '1px solid var(--border)' } },
      el('span', { class: 'label' }, k),
      el('span', { class: 'num ' + cls, style: { fontSize: '14px', fontWeight: 500 } }, v)
    );
    hero.appendChild(stat('Spot', fmtNum(it.spot, 2)));
    hero.appendChild(stat('24h Change', `${fmtSigned(it.change_abs, 2)} (${fmtPct(it.change_pct)})`, tone));
    hero.appendChild(stat('Portfolio PCR', fmtNum(it.pcr, 3), it.pcr >= 1 ? 'bull' : 'bear'));
    hero.appendChild(stat('ATM Strike', fmtNum(it.atm_strike)));
    hero.appendChild(stat('Strikes', String(it.strikes ?? '—')));
    hero.appendChild(stat('Snapshot Rows', String(it.snapshot_rows ?? '—')));
  }

  function renderInstrumentCards(data) {
    instGrid.innerHTML = '';
    Object.values(sparkCharts).forEach(c => c.dispose());
    sparkCharts = {};

    data.instruments.forEach(it => {
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      const pcrTone = (it.pcr ?? 1) >= 1 ? 'bull' : 'bear';
      const active = it.instrument === currentInstrument;
      const card = el('div', {
        class: 'card',
        style: { cursor: 'pointer', borderColor: active ? 'var(--accent)' : 'var(--border)', display: 'flex', flexDirection: 'column', gap: '14px' },
        onclick: () => { currentInstrument = it.instrument; refresh(); }
      });

      // header
      card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
        el('div', {},
          el('div', { style: { fontSize: '15px', fontWeight: 600 } }, it.label),
          el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' } }, it.instrument)
        ),
        el('span', { class: `change-pill ${tone}` }, fmtPct(it.change_pct))
      ));

      // big spot
      card.appendChild(el('div', {},
        el('div', { style: { fontSize: '28px', fontWeight: 600, fontFamily: 'var(--mono)' } }, fmtNum(it.spot, 2)),
        el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `${fmtSigned(it.change_abs, 2)} since prev close`)
      ));

      // PCR bar
      const pcrPct = Math.min(100, Math.max(0, ((it.pcr ?? 1) / 2) * 100));
      card.appendChild(el('div', {},
        el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } },
          el('span', {}, 'PCR'),
          el('span', { class: `mono ${pcrTone}`, style: { fontWeight: 600 } }, fmtNum(it.pcr, 3))
        ),
        el('div', { style: { height: '4px', background: 'var(--surface-3)', borderRadius: '999px', overflow: 'hidden' } },
          el('div', { style: { height: '100%', width: pcrPct + '%', background: pcrTone === 'bull' ? 'var(--bull)' : 'var(--bear)', borderRadius: '999px' } })
        )
      ));

      // OI grid
      card.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
        el('div', {},
          el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Call OI'),
          el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } }, fmtCompact(it.total_ce_oi)),
          el('div', { class: `mono ${it.ce_oi_change >= 0 ? 'bull' : 'bear'}`, style: { fontSize: '10px' } }, fmtSigned(it.ce_oi_change, 0) === '—' ? '—' : (it.ce_oi_change >= 0 ? '+' : '') + fmtCompact(it.ce_oi_change))
        ),
        el('div', {},
          el('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Put OI'),
          el('div', { class: 'mono', style: { fontSize: '13px', fontWeight: 500 } }, fmtCompact(it.total_pe_oi)),
          el('div', { class: `mono ${it.pe_oi_change >= 0 ? 'bull' : 'bear'}`, style: { fontSize: '10px' } }, fmtSigned(it.pe_oi_change, 0) === '—' ? '—' : (it.pe_oi_change >= 0 ? '+' : '') + fmtCompact(it.pe_oi_change))
        ),
      ));

      // sparkline
      const spark = el('div', { style: { height: '50px', marginTop: '4px', marginInline: '-4px' } });
      card.appendChild(spark);
      instGrid.appendChild(card);

      setTimeout(() => {
        const c = echarts.init(spark, null, { renderer: 'canvas' });
        sparkCharts[it.instrument] = c;
        const pts = (it.spark?.spot || []).map((v, i) => [it.spark.timestamps[i], v]);
        const col = tone === 'bull' ? '#b1ffc2' : '#ff8a9e';
        c.setOption({
          animation: false,
          grid: { left: 0, right: 0, top: 4, bottom: 0 },
          xAxis: { type: 'time', show: false },
          yAxis: { type: 'value', scale: true, show: false },
          tooltip: { trigger: 'axis', backgroundColor: '#181820', borderColor: '#23232b', textStyle: { color: '#fff', fontSize: 11 } },
          series: [{ type: 'line', data: pts, smooth: true, showSymbol: false, lineStyle: { color: col, width: 1.5 }, areaStyle: { color: col, opacity: 0.08 } }],
        });
      }, 0);
    });
  }

  function renderUtil(data) {
    utilRow.innerHTML = '';
    const svc = data.service || {};
    const tot = data.totals || {};

    const svcCard = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Service'),
        el('span', { class: `pill ${svc.market_state || ''}` }, el('span', { class: 'dot' }), svc.market_state || '—')
      ),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' } },
        el('div', {}, el('div', { class: 'label' }, 'Last fetch'), el('div', { class: 'mono', style: { fontSize: '13px' } }, timeAgo(svc.last_fetch))),
        el('div', {}, el('div', { class: 'label' }, 'Next fetch'), el('div', { class: 'mono', style: { fontSize: '13px' } }, fmtTimeIST(svc.next_fetch))),
        el('div', {}, el('div', { class: 'label' }, 'Collector'), el('div', { class: `mono ${svc.collector_running ? 'bull' : 'bear'}`, style: { fontSize: '13px' } }, svc.collector_running ? 'active' : 'idle')),
        el('div', {}, el('div', { class: 'label' }, 'API'), el('div', { class: `mono ${svc.api_running ? 'bull' : 'bear'}`, style: { fontSize: '13px' } }, svc.api_running ? 'active' : 'idle')),
      ),
      svc.last_error
        ? el('div', { class: 'mono text-xs', style: { color: 'var(--bear)', background: 'rgba(255,138,158,0.06)', padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,138,158,0.2)' }, title: svc.last_error }, String(svc.last_error).slice(0, 120))
        : null,
      el('div', { style: { display: 'flex', gap: '8px', marginTop: 'auto' } },
        el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#settings'; } }, 'Configure'),
        el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#data?tab=events'; } }, 'View events'),
      )
    );
    utilRow.appendChild(svcCard);

    const sentLabel = tot.sentiment?.label || '—';
    const sentTone = tot.sentiment?.tone === 'bull' ? 'bull' : tot.sentiment?.tone === 'bear' ? 'bear' : 'neutral';
    const totCard = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Across all instruments'),
        el('span', { class: `change-pill ${sentTone}` }, sentLabel)
      ),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' } },
        el('div', {}, el('div', { class: 'label' }, 'Combined Call OI'), el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, fmtCompact(tot.total_ce_oi))),
        el('div', {}, el('div', { class: 'label' }, 'Combined Put OI'), el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, fmtCompact(tot.total_pe_oi))),
        el('div', {}, el('div', { class: 'label' }, 'Portfolio PCR'), el('div', { class: `mono ${(tot.portfolio_pcr || 0) >= 1 ? 'bull' : 'bear'}`, style: { fontSize: '15px', fontWeight: 500 } }, fmtNum(tot.portfolio_pcr, 3))),
        el('div', {}, el('div', { class: 'label' }, 'Live instruments'), el('div', { class: 'mono', style: { fontSize: '15px', fontWeight: 500 } }, `${tot.available_instruments ?? 0} / ${(data.instruments || []).length}`)),
      ),
    );
    utilRow.appendChild(totCard);
  }

  function renderFeatured() {
    featuredCard.innerHTML = '';
    const it = (store.dashboard?.instruments || []).find(i => i.instrument === currentInstrument) || (store.dashboard?.instruments || [])[0];
    featuredCard.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
      el('div', {},
        el('div', { style: { fontSize: '14px', fontWeight: 600 } }, `Spot × PCR — ${it?.label || ''}`),
        el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Today, 1-minute resolution'),
      ),
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#charts'; } }, 'Open in workspace')
    ));
    const canvas = el('div', { style: { flex: 1, minHeight: '320px' } });
    featuredCard.appendChild(canvas);
    if (featuredChart) featuredChart.dispose();
    featuredChart = echarts.init(canvas, null, { renderer: 'canvas' });
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
          name: s.label,
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { color: isSpot ? '#ffffff' : '#c6c0ff', width: 1.6 },
          areaStyle: isSpot ? { color: 'rgba(255,255,255,0.03)' } : undefined,
          yAxisIndex: isSpot ? 0 : 1,
          data: s.points.map(p => [p.timestamp, p.value]),
        };
      });
      featuredChart.setOption({
        animation: false,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', crossStyle: { color: '#5d5d6a', type: 'dashed' }, lineStyle: { color: '#5d5d6a', type: 'dashed' } },
          backgroundColor: '#181820',
          borderColor: '#23232b',
          borderWidth: 1,
          padding: [10, 14],
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
        series,
      }, true);
    } catch (e) { console.error(e); }
  }

  function renderBottom(data) {
    bottomRow.innerHTML = '';
    // Top movers
    const movers = el('div', { class: 'card' });
    movers.appendChild(el('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px' } }, 'Top movers'));
    const sorted = [...data.instruments].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
    sorted.forEach(it => {
      const tone = (it.change_pct ?? 0) >= 0 ? 'bull' : 'bear';
      movers.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' } },
        el('div', {},
          el('div', { style: { fontSize: '13px', fontWeight: 500 } }, it.label),
          el('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-muted)' } }, fmtNum(it.spot, 2))
        ),
        el('span', { class: `change-pill ${tone}` }, fmtPct(it.change_pct))
      ));
    });
    bottomRow.appendChild(movers);

    // Activity
    const activity = el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column' } });
    activity.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
      el('div', { style: { fontSize: '14px', fontWeight: 600 } }, 'Recent activity'),
      el('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#data'; } }, 'See all')
    ));
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    activity.appendChild(list);
    api.events(10).then(evs => {
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
    bottomRow.appendChild(activity);
  }

  async function refresh() {
    try {
      const data = await api.dashboard(60);
      store.dashboard = data;
      store.status = data.service;
      if (!data.instruments.find(i => i.instrument === currentInstrument)) currentInstrument = data.instruments[0]?.instrument || 'nifty';
      renderHero(data);
      renderInstrumentCards(data);
      renderUtil(data);
      renderFeatured();
      renderBottom(data);
    } catch (e) {
      console.error(e);
      page.innerHTML = '';
      page.appendChild(el('div', { class: 'card empty-state' },
        el('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--text)' } }, 'Could not reach backend'),
        el('span', { class: 'text-xs mono dim' }, e.message || 'Network error'),
        el('div', { class: 'mt-12 dim text-xs' }, 'API base: ' + store.apiBase),
        el('button', { class: 'btn primary mt-12', onclick: refresh }, 'Retry')
      ));
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
}
