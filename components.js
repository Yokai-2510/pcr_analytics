// components.js — small UI helpers
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---- toast ----
let toastRoot;
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = el('div', { class: 'toast-root' });
    document.body.appendChild(toastRoot);
  }
  return toastRoot;
}
export function toast(msg, type = 'info', duration = 4000) {
  const root = ensureToastRoot();
  const node = el('div', { class: `toast ${type}` }, msg);
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 240);
  }, duration);
}

// ---- modal ----
export function modal(content, opts = {}) {
  const close = () => bg.remove();
  const bg = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === bg) close(); } },
    el('div', { class: 'modal' }, content)
  );
  document.body.appendChild(bg);
  return { close, el: bg };
}

// ---- formatters ----
export function fmtNum(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return sign + (abs / 1e7).toFixed(2) + 'Cr';
  if (abs >= 1e5) return sign + (abs / 1e5).toFixed(2) + 'L';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
  return sign + abs.toFixed(0);
}
export function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}
export function fmtSigned(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + fmtNum(n, digits);
}
export function timeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
export function fmtClockIST(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return fmt.format(date);
}
export function fmtDateClockIST(date = new Date()) {
  const d = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).format(date);
  const t = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(date);
  return `${d}  ${t}`;
}
export function fmtTimeIST(iso) {
  if (!iso) return '—';
  const fmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return fmt.format(new Date(iso));
}
export function fmtDateIST(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

// ---- icons (inline svg) ----
const ICONS = {
  cog: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.15.68.4.92.7"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 21v-5h5"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  expand: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 14v6h6M20 10V4h-6M4 4l8 8M20 20l-8-8"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
};
export function icon(name) {
  const span = el('span', { html: ICONS[name] || '', style: { display: 'inline-flex' } });
  return span;
}

// ---- password input ----
export function passwordInput(name, placeholder = '') {
  const input = el('input', { type: 'password', name, placeholder });
  const btn = el('button', { type: 'button', class: 'eye' });
  btn.appendChild(icon('eye'));
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = '';
    btn.appendChild(icon(showing ? 'eye' : 'eyeOff'));
  });
  const wrap = el('div', { class: 'password-wrap' }, input, btn);
  return { wrap, input };
}

// ---- credential input ----
// Like passwordInput but the eye fetches the stored plaintext from the
// backend on demand and drops it into the input. Click again to hide and
// clear. Returns { wrap, input, isEdited() } so the caller can skip fields
// that were merely revealed and not modified.
export function credentialInput(name, placeholder, fetchFullValue) {
  const input = el('input', { type: 'password', name, placeholder, autocomplete: 'off' });
  const btn = el('button', { type: 'button', class: 'eye', title: 'Show stored value' });
  btn.appendChild(icon('eye'));

  let revealedValue = null;
  let busy = false;

  btn.addEventListener('click', async () => {
    if (busy) return;
    if (revealedValue !== null) {
      input.type = 'password';
      input.value = '';
      revealedValue = null;
      btn.innerHTML = '';
      btn.appendChild(icon('eye'));
      return;
    }
    busy = true;
    btn.disabled = true;
    try {
      const full = await fetchFullValue();
      if (!full) { toast(`${name}: not configured`, 'warn'); return; }
      input.type = 'text';
      input.value = full;
      revealedValue = full;
      btn.innerHTML = '';
      btn.appendChild(icon('eyeOff'));
    } catch (e) {
      toast(`Failed to reveal ${name}: ${e.message}`, 'error');
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });

  const wrap = el('div', { class: 'password-wrap' }, input, btn);
  return {
    wrap,
    input,
    isEdited: () => input.value !== '' && input.value !== revealedValue,
  };
}

// ---- custom Select (replaces native <select>) ----
// options: [{ value, label, description? }]
// Returns { el, getValue, setValue, setOptions }
const SELECT_ICONS = {
  chev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>',
};
let _activeSelect = null;
document.addEventListener('mousedown', (e) => {
  if (_activeSelect && !_activeSelect.contains(e.target)) {
    _activeSelect.dispatchEvent(new CustomEvent('cselect:close'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _activeSelect) {
    _activeSelect.dispatchEvent(new CustomEvent('cselect:close'));
  }
});

export function Select({ options = [], value = null, placeholder = 'Select…', onChange, width, showDescription = false } = {}) {
  let currentValue = value;
  let currentOptions = options;
  let open = false;
  let focusIdx = -1;

  const wrap = el('div', { class: 'cselect', style: width ? { width } : {}, tabindex: 0 });
  const valueEl = el('span', { class: 'cselect-value' });
  const chev = el('span', { class: 'chev', html: SELECT_ICONS.chev });
  const trigger = el('button', { type: 'button', class: 'cselect-trigger' }, valueEl, chev);
  const menu = el('div', { class: 'cselect-menu', style: { display: 'none' } });
  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  function findOpt(v) { return currentOptions.find(o => o.value === v); }

  function renderValue() {
    const opt = findOpt(currentValue);
    if (opt) {
      valueEl.textContent = opt.label;
      valueEl.classList.remove('placeholder');
    } else {
      valueEl.textContent = placeholder;
      valueEl.classList.add('placeholder');
    }
  }

  function renderMenu() {
    menu.innerHTML = '';
    currentOptions.forEach((opt, i) => {
      const selected = opt.value === currentValue;
      const row = el('div', {
        class: 'cselect-option' + (selected ? ' selected' : '') + (i === focusIdx ? ' focus' : ''),
        'data-value': opt.value,
        onmousedown: (e) => { e.preventDefault(); pick(opt.value); },
      });
      const lbl = el('div', {},
        el('div', {}, opt.label),
        showDescription && opt.description ? el('span', { class: 'desc' }, opt.description) : null
      );
      const check = el('span', { class: 'check', html: SELECT_ICONS.check });
      row.appendChild(lbl);
      row.appendChild(check);
      menu.appendChild(row);
    });
  }

  function setOpen(v) {
    open = v;
    trigger.classList.toggle('open', v);
    menu.style.display = v ? '' : 'none';
    // Cards establish their own stacking context via backdrop-filter, so a
    // dropdown menu inside a card can be clipped behind sibling cards. Lift
    // the containing card while this menu is open and drop it back on close.
    const card = wrap.closest('.card');
    if (card) card.classList.toggle('has-open-dropdown', v);
    if (v) {
      _activeSelect = wrap;
      focusIdx = currentOptions.findIndex(o => o.value === currentValue);
      renderMenu();
    } else if (_activeSelect === wrap) {
      _activeSelect = null;
    }
  }

  function pick(v) {
    const same = v === currentValue;
    currentValue = v;
    renderValue();
    setOpen(false);
    if (!same && typeof onChange === 'function') onChange(v);
  }

  trigger.addEventListener('click', (e) => { e.preventDefault(); setOpen(!open); });
  wrap.addEventListener('cselect:close', () => setOpen(false));
  wrap.addEventListener('keydown', (e) => {
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx = Math.min(currentOptions.length - 1, focusIdx + 1); renderMenu(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx = Math.max(0, focusIdx - 1); renderMenu(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (focusIdx >= 0) pick(currentOptions[focusIdx].value); }
  });

  renderValue();

  return {
    el: wrap,
    getValue: () => currentValue,
    setValue: (v) => { currentValue = v; renderValue(); },
    setOptions: (opts) => { currentOptions = opts; renderValue(); },
  };
}

// ---- Toggle switch (iOS-style slider) ----
// Returns { el, get, set }. `danger: true` renders red when on (use for
// destructive switches like paper -> live).
export function Toggle({ value = false, onChange, danger = false } = {}) {
  let on = !!value;
  const track = el('span', { class: 'toggle-track' }, el('span', { class: 'toggle-thumb' }));
  const wrap = el('label', { class: 'toggle-switch' + (danger ? ' danger' : '') + (on ? ' on' : '') },
    el('input', { type: 'checkbox' }),
    track,
  );
  wrap.addEventListener('click', (e) => {
    e.preventDefault();
    on = !on;
    wrap.classList.toggle('on', on);
    if (typeof onChange === 'function') onChange(on);
  });
  return {
    el: wrap,
    get: () => on,
    set: (v) => { on = !!v; wrap.classList.toggle('on', on); },
  };
}

// ---- Chip multi-picker (generic version of WeekdayPicker) ----
// options: [{ value, label }]. Returns { el, get, set }.
export function ChipMultiPicker({ options = [], value = [], onChange } = {}) {
  let selected = new Set(value);
  const wrap = el('div', { class: 'weekday-picker' });
  options.forEach(opt => {
    const chip = el('button', {
      type: 'button',
      class: 'weekday-chip' + (selected.has(opt.value) ? ' active' : ''),
      'data-value': opt.value,
      onclick: () => {
        if (selected.has(opt.value)) selected.delete(opt.value);
        else selected.add(opt.value);
        chip.classList.toggle('active');
        if (typeof onChange === 'function') onChange([...selected]);
      },
    }, opt.label);
    wrap.appendChild(chip);
  });
  return {
    el: wrap,
    get: () => [...selected],
    set: (v) => {
      selected = new Set(v || []);
      wrap.querySelectorAll('.weekday-chip').forEach(c => {
        c.classList.toggle('active', selected.has(c.dataset.value));
      });
    },
  };
}

// ---- FormField — vertical layout: [label + right control] / [input] / [hint] ----
// label: string (required). input: any DOM node. hint: optional string.
// rightControl: optional DOM node rendered on the label row (e.g. a toggle).
// disabled: optional boolean — greys input + hint.
export function FormField({ label, input, hint, rightControl, disabled = false } = {}) {
  const header = el('div', { class: 'form-field-header' },
    el('span', { class: 'form-field-label' }, label),
    rightControl ? rightControl : null,
  );
  const inputWrap = el('div', { class: 'form-field-input' });
  if (input) {
    if (input.nodeType) inputWrap.appendChild(input);
    else if (Array.isArray(input)) input.forEach(n => n && inputWrap.appendChild(n));
  }
  const node = el('div', { class: 'form-field' + (disabled ? ' disabled' : '') }, header, inputWrap);
  if (hint) node.appendChild(el('div', { class: 'form-field-hint' }, hint));
  return node;
}

// ---- WeekdayPicker ----
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function WeekdayPicker({ value = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], onChange } = {}) {
  let selected = new Set(value);
  const wrap = el('div', { class: 'weekday-picker' });
  WEEKDAYS.forEach(d => {
    const chip = el('button', {
      type: 'button',
      class: 'weekday-chip' + (selected.has(d) ? ' active' : ''),
      onclick: () => {
        if (selected.has(d)) selected.delete(d); else selected.add(d);
        chip.classList.toggle('active');
        if (typeof onChange === 'function') onChange([...selected]);
      },
    }, d);
    wrap.appendChild(chip);
  });
  return {
    el: wrap,
    getValue: () => [...selected],
    setValue: (v) => {
      selected = new Set(v);
      wrap.querySelectorAll('.weekday-chip').forEach(c => c.classList.toggle('active', selected.has(c.textContent)));
    },
  };
}

// ---- weekday string serialization ----
// Backend stores `weekdays` as a systemd calendar expression like "Mon..Fri"
// or "Mon,Wed,Fri". Convert between that and an array of day names.
const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function parseWeekdays(spec) {
  if (!spec) return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (Array.isArray(spec)) return spec;
  const text = String(spec).trim();
  // systemd range, e.g. "Mon..Fri"
  if (text.includes('..')) {
    const [a, b] = text.split('..').map(s => s.trim());
    const ai = WEEKDAY_ORDER.indexOf(a), bi = WEEKDAY_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0 && ai <= bi) return WEEKDAY_ORDER.slice(ai, bi + 1);
  }
  // comma list
  return text.split(/[,\s]+/).map(s => s.trim()).filter(d => WEEKDAY_ORDER.includes(d));
}
export function serializeWeekdays(days) {
  if (!days || !days.length) return '';
  const idxs = days.map(d => WEEKDAY_ORDER.indexOf(d)).filter(i => i >= 0).sort((a, b) => a - b);
  if (!idxs.length) return '';
  // detect contiguous block → use range
  const contiguous = idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1);
  if (contiguous && idxs.length >= 3) return `${WEEKDAY_ORDER[idxs[0]]}..${WEEKDAY_ORDER[idxs[idxs.length - 1]]}`;
  return idxs.map(i => WEEKDAY_ORDER[i]).join(',');
}

// ---- DateSelect: menu-box date picker populated from API distinct values ----
// apiDistinctFn: async (instrument) => string[] of available dates
// Returns { el, getValue, setValue, refresh }
export function DateSelect({ instrument = 'nifty', apiDistinctFn, onChange, placeholder = 'Select date…', width } = {}) {
  let currentValue = '';
  let availableDates = [];
  let loading = false;

  const sel = Select({ options: [], value: null, placeholder, onChange: (v) => {
    currentValue = v;
    if (typeof onChange === 'function') onChange(v);
  }, width: width || '160px' });

  async function refresh(ins) {
    if (loading) return;
    loading = true;
    try {
      const dates = await apiDistinctFn(ins || instrument);
      availableDates = (dates || []).sort().reverse();
      sel.setOptions(availableDates.map(d => ({ value: d, label: d })));
      if (currentValue && availableDates.includes(currentValue)) {
        sel.setValue(currentValue);
      } else if (availableDates.length) {
        currentValue = availableDates[0];
        sel.setValue(currentValue);
        if (typeof onChange === 'function') onChange(currentValue);
      }
    } catch (e) {
      console.error('DateSelect refresh failed', e);
    }
    loading = false;
  }

  // initial load
  refresh(instrument);

  return {
    el: sel.el,
    getValue: () => currentValue,
    setValue: (v) => { currentValue = v; sel.setValue(v); },
    refresh: (ins) => refresh(ins),
    getAvailableDates: () => [...availableDates],
  };
}

// ---- echarts dark theme baseline ----
export const ECHART_THEME = {
  backgroundColor: 'transparent',
  textStyle: { color: '#ffffff', fontFamily: 'Inter, ui-sans-serif, system-ui' },
};

export const CHART_AXIS_STYLE = {
  axisLine: { lineStyle: { color: '#26262d' } },
  axisLabel: { color: '#a0a0aa', fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
  splitLine: { lineStyle: { color: '#1c1c22' } },
  axisTick: { show: false },
};
