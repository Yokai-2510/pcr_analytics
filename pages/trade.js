// pages/trade.js — paper trading: Configs, Orders, Reports
// Config and orders live in the backend (/api/trade/*). LocalStorage is a
// fallback when the API is unreachable so the UI never goes blank.
import { el, toast, Select, Toggle, ChipMultiPicker, FormField } from '../components.js';
import { api } from '../api.js';

const STORAGE_KEY = 'trade_config_v1';

const DEFAULT_CONFIG = {
  mode: 'paper',
  auto_execute: false,
  cooldown_minutes: 0,
  instruments: ['nifty'],
  strike_mode: 'atm',
  custom_steps: 0,
  lots: 1,
  exit_on_counter_crossover: true,
  stop_loss_enabled: true,
  stop_loss_pct: 30,
  trailing_sl_enabled: false,
  trailing_sl_trigger_pct: 20,
  trailing_sl_step_pct: 10,
  target_enabled: true,
  target_pct: 50,
  time_exit_enabled: true,
  time_exit_at: '15:15',
  max_positions_per_day: 3,
};

const LOT_SIZES = { nifty: 75, banknifty: 30, sensex: 20 };
const INSTRUMENT_LABEL = { nifty: 'NIFTY', banknifty: 'BankNIFTY', sensex: 'Sensex' };

let subTab = 'configs';
let orderTab = 'open';
let reportDate = null;       // selected date in Reports subtab
let _pollTimer = null;       // shared polling timer for live subtabs

async function loadConfig() {
  try {
    const res = await api.getTradeConfig();
    const cfg = { ...DEFAULT_CONFIG, ...(res?.config || {}) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));   // mirror for offline read
    return cfg;
  } catch (e) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULT_CONFIG };
    }
  }
}

async function saveConfig(cfg) {
  await api.putTradeConfig(cfg);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  const subtabs = el('div', { class: 'subtabs' });
  ['configs', 'orders', 'reports'].forEach((id) => {
    subtabs.appendChild(el('button', {
      class: 'subtab' + (subTab === id ? ' active' : ''),
      onclick: () => { subTab = id; render(); },
    }, id[0].toUpperCase() + id.slice(1)));
  });
  page.appendChild(subtabs);

  const body = el('div', {});
  page.appendChild(body);

  async function render() {
    _stopPoll();
    subtabs.querySelectorAll('.subtab').forEach((b) => {
      b.classList.toggle('active', b.textContent.toLowerCase() === subTab);
    });
    body.innerHTML = '';
    if (subTab === 'configs') await renderConfigs(body);
    else if (subTab === 'orders') await renderOrders(body);
    else await renderReports(body);
  }

  await render();
}

export function unmount() { _stopPoll(); }

function _stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ──────────────────────────────────────────────────────────────────────
// Configs subtab
// ──────────────────────────────────────────────────────────────────────

async function renderConfigs(root) {
  const loaded = await loadConfig();

  // Track whether the config differs from the last-saved version so the
  // Save button stays greyed until the user actually changes something.
  let baselineJson = JSON.stringify(loaded);
  let dirty = false;
  const resetBtn = el('button', { class: 'btn ghost sm' }, 'Reset');
  const saveBtn = el('button', { class: 'btn primary sm' }, 'Save');
  saveBtn.disabled = true;

  function syncButtons() { saveBtn.disabled = !dirty; }

  // Proxy the config so any field assignment automatically re-checks
  // dirty-ness — works with every onChange that does `cfg.x = y`.
  const cfg = new Proxy({ ...loaded }, {
    set(target, key, value) {
      target[key] = value;
      dirty = JSON.stringify(target) !== baselineJson;
      syncButtons();
      return true;
    },
  });

  resetBtn.onclick = async () => {
    if (!confirm('Reset all trade configs to defaults?')) return;
    try { await saveConfig({ ...DEFAULT_CONFIG }); }
    catch (e) { toast('Reset failed: ' + e.message, 'error'); return; }
    root.innerHTML = '';
    await renderConfigs(root);
    toast('Reset to defaults', 'info');
  };

  saveBtn.onclick = async () => {
    if (!dirty) return;
    try {
      await saveConfig({ ...cfg });
      baselineJson = JSON.stringify({ ...cfg });
      dirty = false;
      syncButtons();
      toast('Trade configs saved', 'success');
    } catch (e) {
      toast('Save failed: ' + (e.message || 'unknown'), 'error');
    }
  };

  const saveBar = el('div', {
    class: 'card form-section',
    style: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: '12px', position: 'sticky', top: '64px', zIndex: '40',
    },
  },
    el('div', { class: 'text-xs muted' },
      'Saved to the backend. The engine re-reads the active config on every tick — changes apply within ~1 second.',
    ),
    el('div', { class: 'row gap-8' }, resetBtn, saveBtn),
  );

  root.appendChild(saveBar);
  root.appendChild(renderEntrySection(cfg));
  root.appendChild(renderInstrumentSection(cfg));
  root.appendChild(renderExitSection(cfg));
}

function section(title, fields) {
  const card = el('div', { class: 'card form-section' });
  card.appendChild(el('h3', {}, title));
  const body = el('div', { class: 'form-section-body' });
  fields.forEach(f => f && body.appendChild(f));
  card.appendChild(body);
  return card;
}

function renderEntrySection(cfg) {
  const modeToggle = Toggle({
    value: cfg.mode === 'live',
    danger: true,
    onChange: (on) => {
      if (on && !confirm('Switch to LIVE? Real broker orders will be placed.')) {
        modeToggle.set(false);
        return;
      }
      cfg.mode = on ? 'live' : 'paper';
      modeLabel.textContent = on ? 'LIVE' : 'PAPER';
      modeLabel.className = 'mono ' + (on ? 'bear' : 'bull');
    },
  });
  const modeLabel = el('span', {
    class: 'mono ' + (cfg.mode === 'live' ? 'bear' : 'bull'),
    style: { fontSize: '12px', fontWeight: 600, marginRight: '8px' },
  }, cfg.mode === 'live' ? 'LIVE' : 'PAPER');

  const autoExecToggle = Toggle({
    value: cfg.auto_execute,
    onChange: (on) => { cfg.auto_execute = on; },
  });

  const directionRules = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr auto 1fr',
      gap: '6px 12px',
      padding: '12px 14px',
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
      fontSize: '12px',
      alignItems: 'center',
    },
  },
    el('span', { class: 'mono', style: { textAlign: 'right' } }, 'CE cumm > PE cumm before crossover'),
    el('span', { class: 'mono', style: { color: 'var(--text-muted)' } }, '→'),
    el('span', { class: 'mono bull', style: { fontWeight: 600 } }, 'BUY CE'),
    el('span', { class: 'mono', style: { textAlign: 'right' } }, 'PE cumm > CE cumm before crossover'),
    el('span', { class: 'mono', style: { color: 'var(--text-muted)' } }, '→'),
    el('span', { class: 'mono bear', style: { fontWeight: 600 } }, 'BUY PE'),
  );

  const cooldownInput = el('input', { type: 'number', min: '0', max: '120', value: String(cfg.cooldown_minutes) });
  cooldownInput.onchange = () => { cfg.cooldown_minutes = parseInt(cooldownInput.value, 10) || 0; };

  return section('Entry Conditions', [
    FormField({
      label: 'Trading Mode',
      input: el('div', { class: 'row gap-8', style: { alignItems: 'center' } }, modeLabel, modeToggle.el),
      hint: 'Paper trades simulate fills locally. Live trades hit the broker — real money, real orders.',
    }),
    FormField({
      label: 'Auto-execute on signal',
      input: autoExecToggle.el,
      hint: 'When off, signals appear in the Data tab but no orders fire.',
    }),
    FormField({
      label: 'Entry direction (auto)',
      input: directionRules,
      hint: 'Whichever side’s cumulative OI change was lower just before the crossover is the side that gets bought. No configuration — the rule is fixed.',
    }),
    FormField({
      label: 'Cooldown (minutes)',
      input: [cooldownInput, el('span', { class: 'unit' }, 'min')],
      hint: 'Minimum gap between consecutive entries on the same underlying.',
    }),
  ]);
}

function renderInstrumentSection(cfg) {
  const instPicker = ChipMultiPicker({
    options: [
      { value: 'nifty', label: 'NIFTY' },
      { value: 'banknifty', label: 'BankNIFTY' },
      { value: 'sensex', label: 'Sensex' },
    ],
    value: cfg.instruments,
    onChange: (v) => {
      cfg.instruments = v;
      lotInfo.textContent = formatLotInfo(cfg);
    },
  });

  const strikeSel = Select({
    options: [
      { value: 'atm', label: 'ATM (at-the-money)' },
      { value: 'itm_1', label: 'ITM −1 step' },
      { value: 'itm_2', label: 'ITM −2 steps' },
      { value: 'custom_steps', label: 'Custom (ATM ± N steps)' },
    ],
    value: cfg.strike_mode,
    onChange: (v) => {
      cfg.strike_mode = v;
      customField.style.display = v === 'custom_steps' ? '' : 'none';
    },
  });

  const customStepsInput = el('input', {
    type: 'number',
    step: '1',
    value: cfg.custom_steps != null ? String(cfg.custom_steps) : '0',
    placeholder: 'e.g. 2 = 2 steps ITM, −1 = 1 step OTM',
  });
  customStepsInput.onchange = () => {
    const v = parseInt(customStepsInput.value, 10);
    cfg.custom_steps = Number.isFinite(v) ? v : 0;
  };
  const customField = FormField({
    label: 'Custom steps from ATM',
    input: customStepsInput,
    hint: 'Positive number = ITM (toward spot), negative = OTM (away from spot). Step direction is leg-aware.',
  });
  customField.style.display = cfg.strike_mode === 'custom_steps' ? '' : 'none';

  const lotsInput = el('input', { type: 'number', min: '1', value: String(cfg.lots) });
  lotsInput.onchange = () => {
    cfg.lots = Math.max(1, parseInt(lotsInput.value, 10) || 1);
    lotsInput.value = String(cfg.lots);
    lotInfo.textContent = formatLotInfo(cfg);
  };
  const lotInfo = el('div', { class: 'form-field-hint' }, formatLotInfo(cfg));

  const lotField = FormField({ label: 'Lots per entry', input: lotsInput });
  lotField.appendChild(lotInfo);

  return section('Instrument & Quantity', [
    FormField({
      label: 'Underlyings',
      input: instPicker.el,
      hint: 'Pick one or more. Each enabled underlying gets its own entries when its sentiment matches.',
    }),
    FormField({
      label: 'Strike selection',
      input: strikeSel.el,
      hint: 'ATM resolves per-underlying using each instrument’s configured strike step.',
    }),
    customField,
    lotField,
  ]);
}

function formatLotInfo(cfg) {
  if (!cfg.instruments?.length) return 'No underlying selected — pick at least one above.';
  return cfg.instruments.map((ins) => {
    const lot = LOT_SIZES[ins] || 0;
    return `${INSTRUMENT_LABEL[ins]}: ${cfg.lots} × ${lot} = ${cfg.lots * lot} units`;
  }).join('   ·   ');
}

function renderExitSection(cfg) {
  const crossExitToggle = Toggle({
    value: cfg.exit_on_counter_crossover,
    onChange: (on) => { cfg.exit_on_counter_crossover = on; },
  });

  const slToggle = Toggle({
    value: cfg.stop_loss_enabled,
    onChange: (on) => {
      cfg.stop_loss_enabled = on;
      slInput.disabled = !on;
      slField.classList.toggle('disabled', !on);
    },
  });
  const slInput = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(cfg.stop_loss_pct) });
  slInput.disabled = !cfg.stop_loss_enabled;
  slInput.onchange = () => { cfg.stop_loss_pct = parseFloat(slInput.value) || 0; };
  const slField = FormField({
    label: 'Stop Loss', rightControl: slToggle.el,
    input: [slInput, el('span', { class: 'unit' }, '% drop from entry premium')],
    hint: 'Exits the position when the option premium falls by this %.',
    disabled: !cfg.stop_loss_enabled,
  });

  const tslToggle = Toggle({
    value: cfg.trailing_sl_enabled,
    onChange: (on) => {
      cfg.trailing_sl_enabled = on;
      tslTrigger.disabled = !on;
      tslStep.disabled = !on;
      tslField.classList.toggle('disabled', !on);
    },
  });
  const tslTrigger = el('input', { type: 'number', min: '1', max: '500', step: '1', value: String(cfg.trailing_sl_trigger_pct) });
  const tslStep = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(cfg.trailing_sl_step_pct) });
  tslTrigger.disabled = !cfg.trailing_sl_enabled;
  tslStep.disabled = !cfg.trailing_sl_enabled;
  tslTrigger.onchange = () => { cfg.trailing_sl_trigger_pct = parseFloat(tslTrigger.value) || 0; };
  tslStep.onchange = () => { cfg.trailing_sl_step_pct = parseFloat(tslStep.value) || 0; };
  const tslField = FormField({
    label: 'Trailing Stop Loss', rightControl: tslToggle.el,
    input: [
      el('span', { class: 'unit' }, 'trigger'), tslTrigger,
      el('span', { class: 'unit' }, '% profit · step'), tslStep,
      el('span', { class: 'unit' }, '%'),
    ],
    hint: 'Activates once profit reaches the trigger %, then ratchets SL every step % of further gain.',
    disabled: !cfg.trailing_sl_enabled,
  });
  tslField.querySelector('.form-field-input').classList.add('inline-row');

  const tgtToggle = Toggle({
    value: cfg.target_enabled,
    onChange: (on) => {
      cfg.target_enabled = on;
      tgtInput.disabled = !on;
      tgtField.classList.toggle('disabled', !on);
    },
  });
  const tgtInput = el('input', { type: 'number', min: '1', max: '500', step: '1', value: String(cfg.target_pct) });
  tgtInput.disabled = !cfg.target_enabled;
  tgtInput.onchange = () => { cfg.target_pct = parseFloat(tgtInput.value) || 0; };
  const tgtField = FormField({
    label: 'Target', rightControl: tgtToggle.el,
    input: [tgtInput, el('span', { class: 'unit' }, '% profit on entry premium')],
    hint: 'Books the position when option premium rises by this %.',
    disabled: !cfg.target_enabled,
  });

  const timeToggle = Toggle({
    value: cfg.time_exit_enabled,
    onChange: (on) => {
      cfg.time_exit_enabled = on;
      timeInput.disabled = !on;
      timeField.classList.toggle('disabled', !on);
    },
  });
  const timeInput = el('input', { type: 'text', value: cfg.time_exit_at, placeholder: 'HH:MM' });
  timeInput.disabled = !cfg.time_exit_enabled;
  timeInput.onchange = () => {
    const v = timeInput.value.trim();
    if (/^\d{2}:\d{2}$/.test(v)) cfg.time_exit_at = v;
    else { toast('Time must be HH:MM', 'warn'); timeInput.value = cfg.time_exit_at; }
  };
  const timeField = FormField({
    label: 'Time-based exit', rightControl: timeToggle.el,
    input: [timeInput, el('span', { class: 'unit' }, 'IST')],
    hint: 'Squares off any open position at this clock time (independent of P&L).',
    disabled: !cfg.time_exit_enabled,
  });
  timeField.querySelector('.form-field-input').classList.add('inline-row');

  const maxPosInput = el('input', { type: 'number', min: '1', max: '50', value: String(cfg.max_positions_per_day) });
  maxPosInput.onchange = () => {
    cfg.max_positions_per_day = Math.max(1, parseInt(maxPosInput.value, 10) || 1);
    maxPosInput.value = String(cfg.max_positions_per_day);
  };

  return section('Exit Conditions', [
    FormField({
      label: 'Exit on counter-crossover', rightControl: crossExitToggle.el,
      input: el('div', { class: 'form-field-hint', style: { color: 'var(--text)' } },
        'Closes a CE position when a SELL crossover fires (and vice-versa) — the primary exit rule for this strategy.'),
    }),
    slField, tslField, tgtField, timeField,
    FormField({
      label: 'Max positions per day',
      input: [maxPosInput, el('span', { class: 'unit' }, 'trades')],
      hint: 'Hard cap on total entries across all underlyings for the session.',
    }),
  ]);
}

function renderSaveBar(cfg, root) {
  return el('div', {
    class: 'card form-section',
    style: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: '12px', position: 'sticky', top: '64px', zIndex: '40',
    },
  },
    el('div', { class: 'text-xs muted' },
      'Saved to the backend. The engine re-reads the active config on every tick — changes apply within ~1 second.',
    ),
    el('div', { class: 'row gap-8' },
      el('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          if (!confirm('Reset all trade configs to defaults?')) return;
          try { await saveConfig({ ...DEFAULT_CONFIG }); }
          catch (e) { toast('Reset failed: ' + e.message, 'error'); return; }
          root.innerHTML = '';
          await renderConfigs(root);
          toast('Reset to defaults', 'info');
        },
      }, 'Reset'),
      el('button', {
        class: 'btn primary sm',
        onclick: async () => {
          try {
            await saveConfig(cfg);
            toast('Trade configs saved', 'success');
          } catch (e) {
            toast('Save failed: ' + (e.message || 'unknown'), 'error');
          }
        },
      }, 'Save'),
    ),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Orders subtab — Open / Closed for today, polled
// ──────────────────────────────────────────────────────────────────────

async function renderOrders(root) {
  _stopPoll();
  root.innerHTML = '';

  const tabsEl = el('div', { class: 'subtabs', style: { marginBottom: '14px' } });
  ['open', 'closed'].forEach((id) => {
    tabsEl.appendChild(el('button', {
      class: 'subtab' + (orderTab === id ? ' active' : ''),
      onclick: () => { orderTab = id; renderOrders(root); },
    }, id === 'open' ? 'Open positions' : 'Closed positions'));
  });
  root.appendChild(tabsEl);

  const summaryCard = el('div', { class: 'card form-section', style: { padding: '14px 16px' } });
  const tableCard = el('div', { class: 'card form-section' });
  root.appendChild(summaryCard);
  root.appendChild(tableCard);

  async function refresh() {
    try {
      const [posRes, sumRes, cfgRes] = await Promise.all([
        api.tradePositions(`?status=${orderTab}`),
        api.tradeSummary(),
        api.getTradeConfig().catch(() => ({ config: {} })),
      ]);
      paintSummary(summaryCard, sumRes, cfgRes.config, orderTab);
      paintPositions(tableCard, posRes.positions || [], orderTab);
    } catch (e) {
      summaryCard.innerHTML = '';
      summaryCard.appendChild(el('div', { class: 'empty-state' },
        el('span', { class: 'bear' }, 'Failed to load orders'),
        el('span', { class: 'text-xs mono dim' }, e.message || 'network error'),
      ));
    }
  }

  await refresh();
  _pollTimer = setInterval(refresh, 3000);
}

function paintSummary(card, summary, cfg, tab) {
  card.innerHTML = '';
  const modePill = el('span', {
    class: cfg?.mode === 'live' ? 'change-pill bear' : 'change-pill bull',
    style: { fontSize: '11px' },
  }, cfg?.mode === 'live' ? 'LIVE' : 'PAPER');
  const winRate = summary.win_rate != null
    ? `${(summary.win_rate * 100).toFixed(1)}%` : '—';
  card.appendChild(el('div', {
    class: 'row',
    style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  },
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      el('div', { style: { fontSize: '13px', fontWeight: 600 } },
        tab === 'open' ? 'Today · Open positions' : 'Today · Closed positions'),
      modePill,
    ),
    el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } },
      statBlock('Trades today', String(summary.trades_total ?? 0)),
      statBlock('Open', String(summary.trades_open_at_eod ?? 0)),
      statBlock('Closed', String(summary.trades_closed ?? 0)),
      statBlock('Realized P&L', fmtPnL(summary.gross_pnl)),
      statBlock('Win rate', winRate),
    ),
  ));
}

function paintPositions(card, positions, tab) {
  card.innerHTML = '';
  const cols = tab === 'open'
    ? ['Time', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'LTP ₹', 'P&L', 'SL', 'Target', '']
    : ['Entered', 'Exited', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'Exit ₹', 'P&L', 'Reason'];

  const table = el('table', { class: 'data-table', style: { width: '100%' } });
  table.appendChild(el('thead', {},
    el('tr', {}, ...cols.map((c) => el('th', {
      style: {
        textAlign: 'left', padding: '8px 10px', fontSize: '11px',
        textTransform: 'uppercase', letterSpacing: '0.5px',
        color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
      },
    }, c))),
  ));

  const tbody = el('tbody');
  if (!positions.length) {
    tbody.appendChild(el('tr', {},
      el('td', { colspan: cols.length, style: { padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' } },
        el('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' } },
          tab === 'open' ? 'No open positions' : 'No closed positions for today'),
        el('div', { class: 'text-xs mono dim' },
          'Trades land here as the engine fires entries and exits.'),
      ),
    ));
  } else if (tab === 'open') {
    positions.forEach((p) => tbody.appendChild(openRow(p)));
  } else {
    positions.forEach((p) => tbody.appendChild(closedRow(p)));
  }
  table.appendChild(tbody);
  card.appendChild(table);
}

function openRow(p) {
  const ltp = p.live_ltp;
  const pnl = p.unrealized_pnl;
  return el('tr', { class: 'data-row' },
    cell(fmtTime(p.entry_time)),
    cell(p.instrument),
    cell(p.strike),
    cell(p.option_type, p.option_type === 'CE' ? 'bull' : 'bear'),
    cell(p.qty),
    cell(fmtRupee(p.entry_price)),
    cell(ltp != null ? fmtRupee(ltp) : '—'),
    cell(pnl != null ? fmtPnL(pnl) : '—', pnl != null ? (pnl >= 0 ? 'bull' : 'bear') : ''),
    cell(p.sl_price != null ? fmtRupee(p.sl_price) : '—'),
    cell(p.target_price != null ? fmtRupee(p.target_price) : '—'),
    el('td', { style: { padding: '6px 10px', textAlign: 'right' } },
      el('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          if (!confirm(`Close position ${p.id} (${p.instrument} ${p.strike} ${p.option_type})?`)) return;
          try {
            await api.tradeManualExit(p.id);
            toast('Exit queued', 'success');
          } catch (e) {
            toast('Exit failed: ' + (e.message || 'unknown'), 'error');
          }
        },
      }, 'Close'),
    ),
  );
}

function closedRow(p) {
  return el('tr', { class: 'data-row' },
    cell(fmtTime(p.entry_time)),
    cell(fmtTime(p.exit_time)),
    cell(p.instrument),
    cell(p.strike),
    cell(p.option_type, p.option_type === 'CE' ? 'bull' : 'bear'),
    cell(p.qty),
    cell(fmtRupee(p.entry_price)),
    cell(fmtRupee(p.exit_price)),
    cell(fmtPnL(p.pnl), p.pnl != null && p.pnl >= 0 ? 'bull' : 'bear'),
    cell(formatExitReason(p.exit_reason)),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Reports subtab — per-date history
// ──────────────────────────────────────────────────────────────────────

async function renderReports(root) {
  _stopPoll();
  root.innerHTML = '';

  let dates = [];
  try {
    const res = await api.tradeReportDates();
    dates = res.dates || [];
  } catch (e) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('span', { class: 'bear' }, 'Failed to load reports'),
      el('span', { class: 'text-xs mono dim' }, e.message || 'network error'),
    ));
    return;
  }

  if (!dates.length) {
    root.appendChild(el('div', { class: 'card empty-state' },
      el('div', { style: { fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' } },
        'No trade reports yet'),
      el('div', { class: 'text-xs muted' },
        'Reports appear here once the engine has fired at least one trade on a given date.'),
    ));
    return;
  }

  if (!reportDate || !dates.includes(reportDate)) reportDate = dates[0];

  // Picker bar
  const sel = Select({
    options: dates.map((d) => ({ value: d, label: d })),
    value: reportDate,
    onChange: async (v) => { reportDate = v; await paintReport(); },
  });
  const pickerCard = el('div', { class: 'card form-section', style: { padding: '14px 16px' } },
    el('div', { class: 'row gap-8', style: { alignItems: 'center', flexWrap: 'wrap' } },
      el('span', { class: 'label' }, 'DATE'),
      sel.el,
      el('span', { class: 'text-xs muted' }, `${dates.length} date${dates.length === 1 ? '' : 's'} on record`),
    ),
  );
  root.appendChild(pickerCard);

  const summaryCard = el('div', { class: 'card form-section', style: { padding: '14px 16px' } });
  const breakdownCard = el('div', { class: 'card form-section' });
  const positionsCard = el('div', { class: 'card form-section' });
  root.appendChild(summaryCard);
  root.appendChild(breakdownCard);
  root.appendChild(positionsCard);

  async function paintReport() {
    try {
      const [report, posRes] = await Promise.all([
        api.tradeReport(reportDate),
        api.tradePositions(`?date=${reportDate}&status=closed`),
      ]);
      paintReportSummary(summaryCard, report);
      paintReportBreakdown(breakdownCard, report);
      paintPositions(positionsCard, posRes.positions || [], 'closed');
    } catch (e) {
      summaryCard.innerHTML = '';
      summaryCard.appendChild(el('div', { class: 'empty-state' },
        el('span', { class: 'bear' }, 'Failed to load report'),
        el('span', { class: 'text-xs mono dim' }, e.message || 'network error'),
      ));
    }
  }

  await paintReport();
}

function paintReportSummary(card, report) {
  card.innerHTML = '';
  const winRate = report.win_rate != null ? `${(report.win_rate * 100).toFixed(1)}%` : '—';
  card.appendChild(el('div', {
    class: 'row',
    style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  },
    el('div', {},
      el('div', { style: { fontSize: '13px', fontWeight: 600 } }, `Report · ${report.date}`),
      el('div', { class: 'text-xs muted', style: { marginTop: '2px' } },
        `Generated ${fmtTime(report.generated_at)}` +
        (report.modes?.length ? `  ·  modes: ${report.modes.join(', ')}` : '')),
    ),
    el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } },
      statBlock('Trades', String(report.trades_total ?? 0)),
      statBlock('Closed', String(report.trades_closed ?? 0)),
      statBlock('Open at EOD', String(report.trades_open_at_eod ?? 0)),
      statBlock('Wins', String(report.wins ?? 0)),
      statBlock('Losses', String(report.losses ?? 0)),
      statBlock('Win rate', winRate),
      statBlock('Gross P&L', fmtPnL(report.gross_pnl)),
      statBlock('Best trade', fmtPnL(report.best_trade_pnl)),
      statBlock('Worst trade', fmtPnL(report.worst_trade_pnl)),
    ),
  ));
}

function paintReportBreakdown(card, report) {
  card.innerHTML = '';
  card.appendChild(el('h3', {}, 'Breakdown'));
  const grid = el('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' },
  });

  const byInst = report.by_instrument || {};
  const byReason = report.by_exit_reason || {};
  const bySide = report.by_side || {};

  grid.appendChild(breakdownTable('By instrument', byInst, (v) => `${v.trades} trades · ${fmtPnL(v.pnl)}`));
  grid.appendChild(breakdownTable('By exit reason', byReason, (v) => `${v} trades`));
  grid.appendChild(breakdownTable('By side', bySide, (v) => `${v} trades`));

  card.appendChild(grid);
}

function breakdownTable(title, dict, fmt) {
  const wrap = el('div', { class: 'form-field-input', style: { flexDirection: 'column', alignItems: 'stretch' } });
  wrap.appendChild(el('div', { class: 'label', style: { marginBottom: '6px' } }, title));
  const keys = Object.keys(dict || {});
  if (!keys.length) {
    wrap.appendChild(el('div', { class: 'text-xs muted' }, '—'));
    return wrap;
  }
  keys.forEach((k) => {
    wrap.appendChild(el('div', {
      class: 'row',
      style: { justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' },
    },
      el('span', { class: 'mono', style: { fontSize: '12px' } }, formatExitReason(k)),
      el('span', { class: 'mono text-xs', style: { color: 'var(--text-muted)' } }, fmt(dict[k])),
    ));
  });
  return wrap;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

function statBlock(label, value) {
  return el('div', { style: { minWidth: '110px' } },
    el('div', { class: 'label' }, label),
    el('div', { class: 'mono', style: { fontSize: '14px', fontWeight: 600 } }, value),
  );
}

function cell(value, klass = '') {
  return el('td', {
    style: { padding: '6px 10px', borderBottom: '1px solid var(--border)' },
    class: 'mono' + (klass ? ' ' + klass : ''),
  }, value == null ? '—' : String(value));
}

function fmtTime(iso) {
  if (!iso) return '—';
  // "2026-05-25T09:16:00+05:30" → "09:16:00"
  return iso.slice(11, 19);
}

function fmtRupee(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPnL(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const sign = n >= 0 ? '+' : '';
  return sign + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatExitReason(reason) {
  if (!reason) return '—';
  return String(reason)
    .replace(/^exit_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
