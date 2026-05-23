// pages/trade.js — paper/live trading config + open/closed orders
// Backend execution wiring is pending; for now all config is persisted to
// localStorage and Orders subtab shows empty-state tables.
import { el, toast, Select, Toggle, ChipMultiPicker, FormField } from '../components.js';

const STORAGE_KEY = 'trade_config_v1';

const DEFAULT_CONFIG = {
  // Entry conditions
  mode: 'paper',                          // 'paper' | 'live'
  auto_execute: false,
  cooldown_minutes: 0,
  ce_trigger_sentiment: 'both',           // 'bull' | 'strong_bull' | 'both'
  pe_trigger_sentiment: 'both',           // 'bear' | 'strong_bear' | 'both'

  // Instrument & quantity — multi-select underlyings
  instruments: ['nifty'],                 // any subset of ['nifty','banknifty','sensex']
  strike_mode: 'atm',                     // 'atm' | 'atm_plus_1' | 'atm_minus_1' | 'custom'
  custom_strike: null,
  lots: 1,

  // Exit conditions
  exit_on_counter_crossover: true,        // first-class exit rule
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

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export async function mount(container) {
  container.innerHTML = '';
  const page = el('div', { class: 'page' });
  container.appendChild(page);

  const subtabs = el('div', { class: 'subtabs' });
  ['configs', 'orders'].forEach((id) => {
    subtabs.appendChild(el('button', {
      class: 'subtab' + (subTab === id ? ' active' : ''),
      onclick: () => { subTab = id; render(); },
    }, id[0].toUpperCase() + id.slice(1)));
  });
  page.appendChild(subtabs);

  const body = el('div', {});
  page.appendChild(body);

  function render() {
    subtabs.querySelectorAll('.subtab').forEach((b) => {
      b.classList.toggle('active', b.textContent.toLowerCase() === subTab);
    });
    body.innerHTML = '';
    if (subTab === 'configs') renderConfigs(body);
    else renderOrders(body);
  }

  render();
}

export function unmount() {}

// ──────────────────────────────────────────────────────────────────────
// Configs subtab — Entry / Instrument / Exit sections (vertical, scrollable)
// ──────────────────────────────────────────────────────────────────────

function renderConfigs(root) {
  const cfg = loadConfig();

  root.appendChild(renderSaveBar(cfg, root));
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
  // Paper / Live toggle — danger-styled when on (LIVE)
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

  const ceSel = Select({
    options: [
      { value: 'both', label: 'Bull + Strong Bull' },
      { value: 'bull', label: 'Bull only' },
      { value: 'strong_bull', label: 'Strong Bull only' },
    ],
    value: cfg.ce_trigger_sentiment,
    onChange: (v) => { cfg.ce_trigger_sentiment = v; },
  });

  const peSel = Select({
    options: [
      { value: 'both', label: 'Bear + Strong Bear' },
      { value: 'bear', label: 'Bear only' },
      { value: 'strong_bear', label: 'Strong Bear only' },
    ],
    value: cfg.pe_trigger_sentiment,
    onChange: (v) => { cfg.pe_trigger_sentiment = v; },
  });

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
      label: 'CE entry trigger',
      input: ceSel.el,
      hint: 'Which bullish sentiment levels (from Data → OI Logs) trigger a CE entry.',
    }),
    FormField({
      label: 'PE entry trigger',
      input: peSel.el,
      hint: 'Which bearish sentiment levels (from Data → OI Logs) trigger a PE entry.',
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
      { value: 'atm_plus_1', label: 'ATM + 1 step (OTM)' },
      { value: 'atm_minus_1', label: 'ATM − 1 step (ITM)' },
      { value: 'custom', label: 'Custom strike' },
    ],
    value: cfg.strike_mode,
    onChange: (v) => {
      cfg.strike_mode = v;
      customField.style.display = v === 'custom' ? '' : 'none';
    },
  });

  const customStrikeInput = el('input', {
    type: 'number',
    value: cfg.custom_strike != null ? String(cfg.custom_strike) : '',
    placeholder: 'e.g. 25000',
  });
  customStrikeInput.onchange = () => {
    const v = parseFloat(customStrikeInput.value);
    cfg.custom_strike = Number.isFinite(v) ? v : null;
  };
  const customField = FormField({
    label: 'Custom strike',
    input: customStrikeInput,
    hint: 'Absolute strike price — only applied when one underlying is selected.',
  });
  customField.style.display = cfg.strike_mode === 'custom' ? '' : 'none';

  const lotsInput = el('input', { type: 'number', min: '1', value: String(cfg.lots) });
  lotsInput.onchange = () => {
    cfg.lots = Math.max(1, parseInt(lotsInput.value, 10) || 1);
    lotsInput.value = String(cfg.lots);
    lotInfo.textContent = formatLotInfo(cfg);
  };
  const lotInfo = el('div', { class: 'form-field-hint' }, formatLotInfo(cfg));

  const lotField = FormField({
    label: 'Lots per entry',
    input: lotsInput,
  });
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
  const parts = cfg.instruments.map((ins) => {
    const lot = LOT_SIZES[ins] || 0;
    return `${INSTRUMENT_LABEL[ins]}: ${cfg.lots} × ${lot} = ${cfg.lots * lot} units`;
  });
  return parts.join('   ·   ');
}

function renderExitSection(cfg) {
  // 1. Exit on counter-crossover — most important, lives at the top
  const crossExitToggle = Toggle({
    value: cfg.exit_on_counter_crossover,
    onChange: (on) => { cfg.exit_on_counter_crossover = on; },
  });

  // 2. Stop Loss
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
    label: 'Stop Loss',
    rightControl: slToggle.el,
    input: [slInput, el('span', { class: 'unit' }, '% drop from entry premium')],
    hint: 'Exits the position when the option premium falls by this %.',
    disabled: !cfg.stop_loss_enabled,
  });

  // 3. Trailing SL — two inputs
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
    label: 'Trailing Stop Loss',
    rightControl: tslToggle.el,
    input: [
      el('span', { class: 'unit' }, 'trigger'),
      tslTrigger,
      el('span', { class: 'unit' }, '% profit · step'),
      tslStep,
      el('span', { class: 'unit' }, '%'),
    ],
    hint: 'Activates once profit reaches the trigger %, then ratchets SL every step % of further gain.',
    disabled: !cfg.trailing_sl_enabled,
  });
  // tslField uses inline-row to keep inputs compact
  tslField.querySelector('.form-field-input').classList.add('inline-row');

  // 4. Target
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
    label: 'Target',
    rightControl: tgtToggle.el,
    input: [tgtInput, el('span', { class: 'unit' }, '% profit on entry premium')],
    hint: 'Books the position when option premium rises by this %.',
    disabled: !cfg.target_enabled,
  });

  // 5. Time-based exit
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
    if (/^\d{2}:\d{2}$/.test(v)) {
      cfg.time_exit_at = v;
    } else {
      toast('Time must be HH:MM', 'warn');
      timeInput.value = cfg.time_exit_at;
    }
  };
  const timeField = FormField({
    label: 'Time-based exit',
    rightControl: timeToggle.el,
    input: [timeInput, el('span', { class: 'unit' }, 'IST')],
    hint: 'Squares off any open position at this clock time (independent of P&L).',
    disabled: !cfg.time_exit_enabled,
  });
  timeField.querySelector('.form-field-input').classList.add('inline-row');

  // 6. Max positions per day
  const maxPosInput = el('input', { type: 'number', min: '1', max: '50', value: String(cfg.max_positions_per_day) });
  maxPosInput.onchange = () => {
    cfg.max_positions_per_day = Math.max(1, parseInt(maxPosInput.value, 10) || 1);
    maxPosInput.value = String(cfg.max_positions_per_day);
  };

  return section('Exit Conditions', [
    FormField({
      label: 'Exit on counter-crossover',
      rightControl: crossExitToggle.el,
      input: el('div', { class: 'form-field-hint', style: { color: 'var(--text)' } },
        'Closes a CE position when a SELL crossover fires (and vice-versa) — the primary exit rule for this strategy.'),
    }),
    slField,
    tslField,
    tgtField,
    timeField,
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
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '12px',
      position: 'sticky',
      top: '64px',
      zIndex: '40',
    },
  },
    el('div', { class: 'text-xs muted' },
      'Saved to your browser. Execution engine wiring is pending — these settings will drive it once available.',
    ),
    el('div', { class: 'row gap-8' },
      el('button', {
        class: 'btn ghost sm',
        onclick: () => {
          if (!confirm('Reset all trade configs to defaults?')) return;
          localStorage.removeItem(STORAGE_KEY);
          root.innerHTML = '';
          renderConfigs(root);
          toast('Reset to defaults', 'info');
        },
      }, 'Reset'),
      el('button', {
        class: 'btn primary sm',
        onclick: () => {
          saveConfig(cfg);
          toast('Trade configs saved', 'success');
        },
      }, 'Save'),
    ),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Orders subtab — Open / Closed for today
// ──────────────────────────────────────────────────────────────────────

function renderOrders(root) {
  const tabsEl = el('div', { class: 'subtabs', style: { marginBottom: '14px' } });
  ['open', 'closed'].forEach((id) => {
    tabsEl.appendChild(el('button', {
      class: 'subtab' + (orderTab === id ? ' active' : ''),
      onclick: () => { orderTab = id; renderOrders(root); },
    }, id === 'open' ? 'Open positions' : 'Closed positions'));
  });
  root.innerHTML = '';
  root.appendChild(tabsEl);

  const cfg = loadConfig();
  const modePill = el('span', {
    class: cfg.mode === 'live' ? 'change-pill bear' : 'change-pill bull',
    style: { fontSize: '11px' },
  }, cfg.mode === 'live' ? 'LIVE' : 'PAPER');

  root.appendChild(el('div', {
    class: 'card form-section',
    style: { padding: '14px 16px' },
  },
    el('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
        el('div', { style: { fontSize: '13px', fontWeight: 600 } },
          orderTab === 'open' ? 'Today · Open positions' : 'Today · Closed positions',
        ),
        modePill,
      ),
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } },
        statBlock('Trades today', '0'),
        statBlock('Open', '0'),
        statBlock('Realized P&L', '—'),
        statBlock('Unrealized P&L', '—'),
        statBlock('Win rate', '—'),
      ),
    ),
  ));

  const tableCard = el('div', { class: 'card form-section' });
  const cols = orderTab === 'open'
    ? ['Time', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'LTP ₹', 'P&L', 'SL', 'Target', 'Actions']
    : ['Entered', 'Exited', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'Exit ₹', 'P&L', 'Reason'];

  const table = el('table', { class: 'data-table', style: { width: '100%' } });
  table.appendChild(el('thead', {},
    el('tr', {}, ...cols.map((c) => el('th', {
      style: {
        textAlign: 'left',
        padding: '8px 10px',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
      },
    }, c))),
  ));
  table.appendChild(el('tbody', {},
    el('tr', {},
      el('td', {
        colspan: cols.length,
        style: { padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' },
      },
        el('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' } },
          orderTab === 'open' ? 'No open positions' : 'No closed positions for today',
        ),
        el('div', { class: 'text-xs muted' },
          'Trades will appear here once the execution engine is wired up.',
        ),
      ),
    ),
  ));
  tableCard.appendChild(table);
  root.appendChild(tableCard);
}

function statBlock(label, value) {
  return el('div', { style: { minWidth: '110px' } },
    el('div', { class: 'label' }, label),
    el('div', { class: 'mono', style: { fontSize: '14px', fontWeight: 600 } }, value),
  );
}
