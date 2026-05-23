// pages/trade.js — paper/live trading config + open/closed orders
// Backend execution wiring is pending; for now all config is persisted to
// localStorage and Orders subtab shows empty-state tables.
import { el, toast, Select } from '../components.js';

const STORAGE_KEY = 'trade_config_v1';

const DEFAULT_CONFIG = {
  // Entry conditions
  mode: 'paper',                  // 'paper' | 'live'
  auto_execute: false,
  entry_on_signal: 'both',        // 'both' | 'buy' | 'sell'
  cooldown_minutes: 0,
  strategy: 'oi_crossover',       // 'oi_crossover'

  // Instrument & quantity
  instrument: 'nifty',
  strike_mode: 'atm',             // 'atm' | 'atm_plus_1' | 'atm_minus_1' | 'custom'
  custom_strike: null,
  option_type: 'auto',            // 'auto' (BUY→CE, SELL→PE) | 'ce' | 'pe'
  lots: 1,

  // Exit conditions
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
const INSTRUMENT_LABELS = { nifty: 'NIFTY', banknifty: 'BankNIFTY', sensex: 'Sensex' };

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
// Configs subtab — Entry / Instrument / Exit sections
// ──────────────────────────────────────────────────────────────────────

function renderConfigs(root) {
  const cfg = loadConfig();

  root.appendChild(renderEntrySection(cfg));
  root.appendChild(renderInstrumentSection(cfg));
  root.appendChild(renderExitSection(cfg));
  root.appendChild(renderSaveBar(cfg, root));
}

function renderEntrySection(cfg) {
  const card = el('div', { class: 'card settings-section' });
  card.appendChild(el('h3', {}, 'Entry Conditions'));

  // Mode toggle (paper/live) — prominent at top of section
  const modePill = el('span', { class: '', style: { fontSize: '11px' } });
  function paintMode() {
    modePill.className = cfg.mode === 'live' ? 'change-pill bear' : 'change-pill bull';
    modePill.textContent = cfg.mode === 'live' ? 'LIVE — real orders' : 'PAPER — simulated';
  }
  paintMode();
  card.appendChild(el('div', {
    class: 'row',
    style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', padding: '10px 12px', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' },
  },
    el('div', {},
      el('div', { style: { fontSize: '13px', fontWeight: 600 } }, 'Trading Mode'),
      el('div', { class: 'text-xs muted', style: { marginTop: '2px' } }, 'Paper trades simulate fills locally. Live trades hit the broker.'),
    ),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      modePill,
      el('button', { class: 'btn ghost sm', onclick: () => {
        const next = cfg.mode === 'live' ? 'paper' : 'live';
        if (next === 'live' && !confirm('Switch to LIVE? Real broker orders will be placed.')) return;
        cfg.mode = next;
        paintMode();
      } }, 'Switch'),
    ),
  ));

  const strategySelect = Select({
    options: [{ value: 'oi_crossover', label: 'OI Crossover (cumulative)' }],
    value: cfg.strategy,
    onChange: (v) => { cfg.strategy = v; },
  });

  const entryOnSelect = Select({
    options: [
      { value: 'both', label: 'Both BUY & SELL' },
      { value: 'buy', label: 'Only BUY signals' },
      { value: 'sell', label: 'Only SELL signals' },
    ],
    value: cfg.entry_on_signal,
    onChange: (v) => { cfg.entry_on_signal = v; },
  });

  const autoExecCheck = el('input', { type: 'checkbox' });
  autoExecCheck.checked = cfg.auto_execute;
  autoExecCheck.onchange = () => { cfg.auto_execute = autoExecCheck.checked; };

  const cooldownInput = el('input', { type: 'number', min: '0', max: '120', value: String(cfg.cooldown_minutes) });
  cooldownInput.onchange = () => { cfg.cooldown_minutes = parseInt(cooldownInput.value, 10) || 0; };

  card.appendChild(el('div', { class: 'kv-grid' },
    el('span', { class: 'label' }, 'Strategy'), strategySelect.el,
    el('span', { class: 'label' }, 'Auto-execute on signal'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      autoExecCheck,
      el('span', { class: 'text-xs muted' }, 'when off, signals are visible but no orders fire'),
    ),
    el('span', { class: 'label' }, 'Entry on signal'), entryOnSelect.el,
    el('span', { class: 'label' }, 'Cooldown (minutes)'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      cooldownInput,
      el('span', { class: 'text-xs muted' }, 'minimum gap between entries'),
    ),
  ));

  return card;
}

function renderInstrumentSection(cfg) {
  const card = el('div', { class: 'card settings-section' });
  card.appendChild(el('h3', {}, 'Instrument & Quantity'));

  const instSelect = Select({
    options: [
      { value: 'nifty', label: 'NIFTY' },
      { value: 'banknifty', label: 'BankNIFTY' },
      { value: 'sensex', label: 'Sensex' },
    ],
    value: cfg.instrument,
    onChange: (v) => {
      cfg.instrument = v;
      lotInfo.textContent = formatLotInfo(cfg);
    },
  });

  const strikeSelect = Select({
    options: [
      { value: 'atm', label: 'ATM (at-the-money)' },
      { value: 'atm_plus_1', label: 'ATM + 1 step (OTM)' },
      { value: 'atm_minus_1', label: 'ATM − 1 step (ITM)' },
      { value: 'custom', label: 'Custom strike' },
    ],
    value: cfg.strike_mode,
    onChange: (v) => {
      cfg.strike_mode = v;
      customStrikeRow.style.display = v === 'custom' ? '' : 'none';
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
  const customStrikeRow = el('div', {
    class: 'kv-grid',
    style: { display: cfg.strike_mode === 'custom' ? '' : 'none', marginTop: '8px' },
  },
    el('span', { class: 'label' }, 'Custom strike'),
    customStrikeInput,
  );

  const optionTypeSelect = Select({
    options: [
      { value: 'auto', label: 'Auto (BUY→CE, SELL→PE)' },
      { value: 'ce', label: 'CE only (Call)' },
      { value: 'pe', label: 'PE only (Put)' },
    ],
    value: cfg.option_type,
    onChange: (v) => { cfg.option_type = v; },
  });

  const lotsInput = el('input', { type: 'number', min: '1', value: String(cfg.lots) });
  const lotInfo = el('span', { class: 'text-xs muted' }, formatLotInfo(cfg));
  lotsInput.onchange = () => {
    cfg.lots = Math.max(1, parseInt(lotsInput.value, 10) || 1);
    lotsInput.value = String(cfg.lots);
    lotInfo.textContent = formatLotInfo(cfg);
  };

  card.appendChild(el('div', { class: 'kv-grid' },
    el('span', { class: 'label' }, 'Underlying'), instSelect.el,
    el('span', { class: 'label' }, 'Strike selection'), strikeSelect.el,
  ));
  card.appendChild(customStrikeRow);
  card.appendChild(el('div', { class: 'kv-grid', style: { marginTop: '8px' } },
    el('span', { class: 'label' }, 'Option type'), optionTypeSelect.el,
    el('span', { class: 'label' }, 'Lots'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } }, lotsInput, lotInfo),
  ));

  return card;
}

function formatLotInfo(cfg) {
  const lot = LOT_SIZES[cfg.instrument] || 0;
  return `${lot} units per lot · total ${cfg.lots * lot} units`;
}

function renderExitSection(cfg) {
  const card = el('div', { class: 'card settings-section' });
  card.appendChild(el('h3', {}, 'Exit Conditions'));

  // Stop Loss
  const slCheck = el('input', { type: 'checkbox' });
  slCheck.checked = cfg.stop_loss_enabled;
  const slInput = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(cfg.stop_loss_pct) });
  slInput.disabled = !cfg.stop_loss_enabled;
  slCheck.onchange = () => {
    cfg.stop_loss_enabled = slCheck.checked;
    slInput.disabled = !slCheck.checked;
  };
  slInput.onchange = () => { cfg.stop_loss_pct = parseFloat(slInput.value) || 0; };

  // Trailing Stop Loss
  const tslCheck = el('input', { type: 'checkbox' });
  tslCheck.checked = cfg.trailing_sl_enabled;
  const tslTrigger = el('input', { type: 'number', min: '1', max: '500', step: '1', value: String(cfg.trailing_sl_trigger_pct) });
  const tslStep = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(cfg.trailing_sl_step_pct) });
  tslTrigger.disabled = !cfg.trailing_sl_enabled;
  tslStep.disabled = !cfg.trailing_sl_enabled;
  tslCheck.onchange = () => {
    cfg.trailing_sl_enabled = tslCheck.checked;
    tslTrigger.disabled = !tslCheck.checked;
    tslStep.disabled = !tslCheck.checked;
  };
  tslTrigger.onchange = () => { cfg.trailing_sl_trigger_pct = parseFloat(tslTrigger.value) || 0; };
  tslStep.onchange = () => { cfg.trailing_sl_step_pct = parseFloat(tslStep.value) || 0; };

  // Target
  const tgtCheck = el('input', { type: 'checkbox' });
  tgtCheck.checked = cfg.target_enabled;
  const tgtInput = el('input', { type: 'number', min: '1', max: '500', step: '1', value: String(cfg.target_pct) });
  tgtInput.disabled = !cfg.target_enabled;
  tgtCheck.onchange = () => {
    cfg.target_enabled = tgtCheck.checked;
    tgtInput.disabled = !tgtCheck.checked;
  };
  tgtInput.onchange = () => { cfg.target_pct = parseFloat(tgtInput.value) || 0; };

  // Time-based exit
  const timeCheck = el('input', { type: 'checkbox' });
  timeCheck.checked = cfg.time_exit_enabled;
  const timeInput = el('input', { type: 'text', value: cfg.time_exit_at, placeholder: 'HH:MM', style: { width: '80px' } });
  timeInput.disabled = !cfg.time_exit_enabled;
  timeCheck.onchange = () => {
    cfg.time_exit_enabled = timeCheck.checked;
    timeInput.disabled = !timeCheck.checked;
  };
  timeInput.onchange = () => {
    const v = timeInput.value.trim();
    if (/^\d{2}:\d{2}$/.test(v)) {
      cfg.time_exit_at = v;
    } else {
      toast('Time must be HH:MM', 'warn');
      timeInput.value = cfg.time_exit_at;
    }
  };

  // Max positions per day
  const maxPosInput = el('input', { type: 'number', min: '1', max: '50', value: String(cfg.max_positions_per_day) });
  maxPosInput.onchange = () => {
    cfg.max_positions_per_day = Math.max(1, parseInt(maxPosInput.value, 10) || 1);
    maxPosInput.value = String(cfg.max_positions_per_day);
  };

  card.appendChild(el('div', { class: 'kv-grid' },
    el('span', { class: 'label' }, 'Stop Loss (SL)'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      slCheck, slInput, el('span', { class: 'text-xs muted' }, '% drop from entry premium'),
    ),
    el('span', { class: 'label' }, 'Trailing SL'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center', flexWrap: 'wrap' } },
      tslCheck,
      el('span', { class: 'text-xs muted' }, 'trigger at'),
      tslTrigger,
      el('span', { class: 'text-xs muted' }, '% profit · step'),
      tslStep,
      el('span', { class: 'text-xs muted' }, '%'),
    ),
    el('span', { class: 'label' }, 'Target'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      tgtCheck, tgtInput, el('span', { class: 'text-xs muted' }, '% profit on entry premium'),
    ),
    el('span', { class: 'label' }, 'Time-based exit'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      timeCheck, timeInput, el('span', { class: 'text-xs muted' }, 'auto-exit at this IST time'),
    ),
    el('span', { class: 'label' }, 'Max positions per day'),
    el('div', { class: 'row gap-8', style: { alignItems: 'center' } },
      maxPosInput, el('span', { class: 'text-xs muted' }, 'caps total trades for the session'),
    ),
  ));

  return card;
}

function renderSaveBar(cfg, root) {
  return el('div', {
    class: 'card settings-section',
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' },
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
  // Tab strip
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

  // Summary strip
  root.appendChild(el('div', {
    class: 'card settings-section',
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

  // Empty-state table (orders list will be wired to backend later)
  const tableCard = el('div', { class: 'card settings-section' });
  const cols = orderTab === 'open'
    ? ['Time', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'LTP ₹', 'P&L', 'SL', 'Target', 'Actions']
    : ['Entered', 'Exited', 'Instrument', 'Strike', 'Type', 'Qty', 'Entry ₹', 'Exit ₹', 'P&L', 'Reason'];

  const table = el('table', { class: 'data-table', style: { width: '100%' } });
  table.appendChild(el('thead', {},
    el('tr', {}, ...cols.map((c) => el('th', { style: { textAlign: 'left', padding: '8px 10px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' } }, c))),
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
