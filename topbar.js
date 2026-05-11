// topbar.js — minimal: brand + centered tabs + status pills
import { el, fmtClockIST, timeAgo, icon } from './components.js';
import { store, subscribe } from './store.js';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'charts', label: 'Charts' },
  { id: 'data', label: 'Data' },
  { id: 'settings', label: 'Settings' },
];

export function mountTopbar(root) {
  const brand = el('div', { class: 'brand' },
    el('span', { class: 'brand-mark' }),
    el('span', { class: 'brand-name' }, 'Analytics Charts')
  );
  const left = el('div', { class: 'topbar-left' }, brand);

  const tabsEl = el('nav', { class: 'tabs' },
    ...TABS.map(t => el('a', {
      class: 'tab' + (store.currentPage === t.id ? ' active' : ''),
      href: `#${t.id}`,
      'data-tab': t.id,
    }, t.label))
  );

  const marketPill = el('span', { class: 'pill neutral' }, el('span', { class: 'dot' }), 'offline');
  const clockEl = el('span', { class: 'pill', style: { color: 'var(--text-muted)' } }, fmtClockIST(), ' IST');
  const lastFetchEl = el('span', { class: 'mono text-xs dim' }, '—');
  const cog = el('a', { class: 'icon-btn', href: '#settings', title: 'Settings' });
  cog.appendChild(icon('cog'));

  const right = el('div', { class: 'topbar-right' }, lastFetchEl, marketPill, clockEl, cog);

  const topbar = el('header', { class: 'topbar' }, left, tabsEl, right);
  root.appendChild(topbar);

  setInterval(() => {
    clockEl.childNodes[0].textContent = fmtClockIST();
    if (store.status?.last_fetch) lastFetchEl.textContent = timeAgo(store.status.last_fetch);
  }, 1000);

  function refresh() {
    tabsEl.querySelectorAll('.tab').forEach(a => {
      a.classList.toggle('active', a.dataset.tab === store.currentPage);
    });
    const s = store.status;
    if (s) {
      const state = s.market_state || 'offline';
      marketPill.className = `pill ${state}`;
      marketPill.innerHTML = '';
      marketPill.appendChild(el('span', { class: 'dot' }));
      marketPill.appendChild(document.createTextNode(state.replace(/_/g, ' ')));
      if (s.last_fetch) lastFetchEl.textContent = timeAgo(s.last_fetch);
    }
  }
  subscribe((k) => { if (k === 'currentPage' || k === 'status') refresh(); });
  refresh();
}
