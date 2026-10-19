// Shared UI plumbing: state, sheets, toasts, banners, form helpers, error messages.
import * as S from './store.js';
import { db } from './store.js';
import { peso, esc, monthKey, today, FREQS, parseAmount } from './util.js';
import { sheetDrag, haptic } from './ui-fx.js';

export { haptic };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const ui = {
  tab: 'home', planTab: 'goals', reportMonth: monthKey(today()), reportFollowsNow: true,
  filter: 'all', search: '', showPaid: false, loadProblem: null,
};

export const pw = (n) => peso(n, { whole: true });
export const icon = (name) => `<svg class="ti" aria-hidden="true" focusable="false"><use href="#i-${/^[a-z0-9-]+$/.test(name) ? name : 'info'}"/></svg>`;
export const accounts = () => db.accounts || [];
export const isStandalone = () => !!navigator.standalone || matchMedia('(display-mode: standalone)').matches;

// UI-only preferences (not money data), kept apart from the store's key.
export const pref = {
  get(k) { try { return localStorage.getItem(`pitaka.ui.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`pitaka.ui.${k}`, v); } catch { /* storage blocked: preference just isn't remembered */ } },
};

// Make sure containers exist even if index.html is older than this script.
export function ensureEl(id, tag, cls, before) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    if (cls) el.className = cls;
    el.hidden = tag === 'section';
    if (before) before.before(el); else document.body.append(el);
  }
  return el;
}

// ------------------------------------------------------------------ errors
export class FormProblem extends Error {
  constructor(message, field) { super(message); this.name = 'ValidationError'; this.field = field; }
}
export const isValidation = (e) => !!e && ((S.ValidationError && e instanceof S.ValidationError) || e.name === 'ValidationError');
export const isStoreError = (e) => !!e && ((S.StoreError && e instanceof S.StoreError) || e.name === 'StoreError');
export function storeMessage(e) {
  return e?.code === 'blocked'
    ? "Couldn't save. This browser is blocking Pitaka from saving (Private Browsing or \"Block All Cookies\" can do this). What you typed is still here."
    : "Couldn't save. Pitaka has run out of storage space on this iPhone. What you typed is still here. Save a backup, then free up some space and try again.";
}
export function errorMessage(e) {
  if (isValidation(e)) return e.message;
  if (isStoreError(e)) return storeMessage(e);
  return "Something went wrong, so nothing was changed. Please try again.";
}

// Settings are plain fields on db.settings; written all-or-nothing (await S.flush() to know they're saved).
export const setSettings = (patch) => S.updateSettings(patch);

// ------------------------------------------------------------------ toast
// toast('Saved', { sub: 'Food is ₱120 over budget', warn: true, icon: 'check', action: 'Undo', onAction })
let toastTimer = 0;
let toastFn = null;
export function toast(msg, { action = '', onAction = null, ms = 0, sub = '', warn = false, icon: ic = '' } = {}) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  toastFn = onAction;
  t.innerHTML = `${ic ? icon(ic) : ''}<span class="t-body"><span>${esc(msg)}</span>${sub ? `<span class="t-sub${warn ? ' warn' : ''}">${esc(sub)}</span>` : ''}</span>${action && onAction ? `<button type="button" class="toast-action">${esc(action)}</button>` : ''}`;
  t.hidden = false;
  // restart the entrance animation for back-to-back toasts
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  toastTimer = setTimeout(hideToast, ms || (onAction ? 6000 : sub ? 4200 : 2600));
}
export function hideToast() { $('#toast').hidden = true; toastFn = null; }
export function runToastAction() { const fn = toastFn; hideToast(); if (fn) fn(); }

// ------------------------------------------------------------------ banners (#banner-slot)
const banners = new Map();
export function setBanner(key, b) { banners.set(key, b); renderBanners(); }
export function clearBanner(key) { if (banners.delete(key)) renderBanners(); }
export function renderBanners() {
  const slot = $('#banner-slot');
  if (!slot) return;
  slot.innerHTML = [...banners.entries()].map(([k, b]) => bannerHtml(b, k)).join('');
}
// Layout per app.css: icon, then a div (strong + .meta), then optional small buttons.
export const bannerHtml = (b, key = '') => `<div class="banner ${b.level || 'info'}" role="${b.level === 'critical' ? 'alert' : 'status'}">${icon(b.icon || (b.level === 'info' ? 'info' : 'alert'))}<div><strong>${esc(b.title)}</strong>${b.text ? `<span class="meta">${esc(b.text)}</span>` : ''}</div>${(b.actions || []).map(([label, action, cls = '']) => `<button type="button" class="btn small ${cls}" data-action="${action}">${esc(label)}</button>`).join('')}${key && b.dismiss ? `<button type="button" class="btn small" data-action="dismissBanner" data-k="${esc(key)}">${esc(b.dismiss)}</button>` : ''}</div>`;

// ------------------------------------------------------------------ inert / modal plumbing
let trigger = null;
export const setTrigger = (el) => { trigger = el; };
const sheetState = { opener: null, sel: '', closing: 0 };
const isShown = (sel) => { const el = $(sel); return !!el && !el.hidden; };
export const isSheetOpen = () => { const s = $('#sheet'); return !s.hidden && s.classList.contains('open'); };
export const isLockOpen = () => isShown('#lock');
export const isOverlayOpen = () => isShown('#onboard') || isShown('#install');

// Everything behind the top-most layer is inert: not focusable, not clickable, not read by VoiceOver.
export function syncInert() {
  const lock = isLockOpen();
  const overlay = isOverlayOpen();
  const bg = lock || overlay || isSheetOpen();
  for (const el of [$('#main'), $('.tabbar'), $('#banner-slot'), $('#topbar')]) if (el) el.inert = bg;
  const sh = $('#sheet');
  if (sh && !sheetState.closing) sh.inert = lock || overlay;
  for (const sel of ['#onboard', '#install']) { const el = $(sel); if (el) el.inert = lock; }
}

function describe(el) {
  if (!el?.dataset?.action) return '';
  const id = el.dataset.id ? `[data-id="${CSS.escape(el.dataset.id)}"]` : '';
  const tab = el.dataset.tab ? `[data-tab="${CSS.escape(el.dataset.tab)}"]` : '';
  return `[data-action="${CSS.escape(el.dataset.action)}"]${id}${tab}`;
}

export function openSheet(html) {
  const s = $('#sheet');
  const wasOpen = isSheetOpen();
  clearTimeout(sheetState.closing);
  sheetState.closing = 0;
  if (!wasOpen) {
    const a = trigger?.isConnected ? trigger : document.activeElement;
    const ok = a && a !== document.body && !a.closest('#sheet');
    sheetState.opener = ok ? a : null;
    sheetState.sel = ok ? describe(a) : '';
  }
  trigger = null;
  s.classList.remove('closing');
  s.innerHTML = `<div class="sheet-backdrop" data-action="closeSheet"></div><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1" style="outline:none"><div class="grabber-zone" aria-hidden="true"><div class="grabber"></div></div>${html}</div>`;
  s.hidden = false;
  s.inert = false;
  document.body.classList.add('sheet-open');
  if (!wasOpen) void s.offsetHeight; // let the slide-up transition start from the closed position
  s.classList.add('open');
  syncInert();
  sheetDrag(s, closeSheet);
  const panel = s.querySelector('.sheet-panel');
  panel.focus({ preventScroll: true });
  return panel;
}

export function closeSheet() {
  const s = $('#sheet');
  if (s.hidden) return;
  if (s.contains(document.activeElement)) document.activeElement.blur();
  s.inert = true; // no second tap or Return can reach the form while it slides away
  s.classList.add('closing');
  s.classList.remove('open');
  document.body.classList.remove('sheet-open');
  clearTimeout(sheetState.closing);
  sheetState.closing = setTimeout(() => {
    sheetState.closing = 0;
    if (!s.classList.contains('open')) { s.hidden = true; s.innerHTML = ''; s.classList.remove('closing'); s.style.removeProperty('--drag'); s.style.removeProperty('--drag-p'); }
    syncInert();
    restoreFocus(); // after the slide-out, so a repeated Return can't re-trigger the opener
  }, 340);
  syncInert();
}

export function restoreFocus() {
  let el = sheetState.opener;
  if (!el?.isConnected && sheetState.sel) el = $(`#main ${sheetState.sel}, .tabbar ${sheetState.sel}`);
  sheetState.opener = null;
  sheetState.sel = '';
  if (el?.isConnected && !el.closest('[inert]')) el.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ markup helpers
// The large title sits at the top of the screen; its buttons live in the fixed top bar, which also
// shows the title in small once the page scrolls. `title` is trusted markup (escape dynamic parts).
const topbarState = { title: '', left: '', right: '' };
export function header(title, right = '', sub = '', { left = '' } = {}) {
  Object.assign(topbarState, { title, right, left });
  return `<header class="top"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</header>`;
}
export function renderTopbar() {
  const el = $('#topbar');
  if (!el) return;
  el.innerHTML = `<div class="bar-left">${topbarState.left}</div><div class="bar-title" aria-hidden="true">${topbarState.title}</div><div class="bar-actions">${topbarState.right}</div>`;
}
export const barBtn = (action, ic, label, extra = '', badge = 0) =>
  `<button type="button" class="bar-btn" data-action="${action}" aria-label="${esc(label)}${badge ? `, ${badge} waiting` : ''}" ${extra}>${icon(ic)}${badge ? `<span class="badge" aria-hidden="true">${badge > 99 ? '99+' : badge}</span>` : ''}</button>`;

// Thoughtful empty state: icon (sprite name or an emoji), title, one line, optional buttons [[label, action, cls, extra]].
export const emptyState = ({ icon: ic = 'inbox', emoji = '', title, text = '', actions = [] }) =>
  `<div class="empty-state card"><div class="ill" aria-hidden="true">${emoji ? esc(emoji) : icon(ic)}</div><p class="es-title">${esc(title)}</p>${text ? `<p class="es-text">${esc(text)}</p>` : ''}${actions.length ? `<div class="actions">${actions.map(([l, a, c = '', x = '']) => `<button type="button" class="btn ${c}" data-action="${a}" ${x}>${esc(l)}</button>`).join('')}</div>` : ''}</div>`;

// "₱12,345" for the big numbers, split so the peso sign can be smaller.
export const bigMoney = (n, key) => {
  const v = Math.round(Math.abs(Number(n) || 0));
  return `<span${key ? ` data-count="${esc(key)}" data-to="${v}"` : ''}><span class="cur">₱</span><span class="v">${groupFmt.format(v)}</span></span>`;
};
export const countFormat = (x) => groupFmt.format(Math.round(x));

export function bar(pct, cls = '', label = '') {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  // spans, so a bar can sit inside a row's <button>
  return `<span class="progress ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"${label ? ` aria-label="${esc(label)}"` : ''}><span style="width:${p.toFixed(1)}%"></span></span>`;
}

// back: [label, action, extra] shows "‹ label" instead of the close link (sub-pages of Settings).
export const sheetHead = (title, { right = '', close = 'Cancel', back = null } = {}) =>
  `<div class="sheet-head">${back ? `<button type="button" class="link back" data-action="${back[1]}" ${back[2] || ''}>${icon('left')}${esc(back[0])}</button>` : `<button type="button" class="link" data-action="closeSheet">${close}</button>`}<h2 id="sheet-title">${title}</h2>${right || '<span></span>'}</div>`;
export const saveLink = (formId, label = 'Save') => `<button class="link" type="submit" form="${formId}">${label}</button>`;

export const field = (label, input, hint = '') =>
  `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
export const staticField = (label, html) => `<div class="field"><span>${label}</span><p class="meta">${html}</p></div>`;

const groupFmt = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 });
// Number -> "12,345" or "12,345.50" for input values. 0 / blank -> ''.
export function moneyValue(v) {
  if (typeof v === 'string') return v;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  const cents = Math.round(Math.abs(n) * 100) % 100;
  return n.toLocaleString('en-PH', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}
export const money = (name, value, attrs = '') =>
  `<div class="money"><span aria-hidden="true">₱</span><input name="${name}" inputmode="decimal" placeholder="0.00" autocomplete="off" data-money value="${esc(moneyValue(value))}" ${attrs}></div>`;

export function select(name, options, value, attrs = '') {
  const opt = ([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  return `<select name="${name}" ${attrs}>${options.map((o) => (o.group ? `<optgroup label="${esc(o.group)}">${o.options.map(opt).join('')}</optgroup>` : opt(o))).join('')}</select>`;
}
export const freqSelect = (name, value, skip = []) => select(name, Object.entries(FREQS).filter(([k]) => !skip.includes(k)), value || 'monthly');

// "12345.5" typed -> "12,345.5"; keeps at most 2 decimals and up to 10 whole digits.
export function groupTyping(raw) {
  const s = String(raw ?? '').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  let int = dot >= 0 ? s.slice(0, dot) : s;
  const dec = dot >= 0 ? s.slice(dot + 1).replace(/\./g, '').slice(0, 2) : null;
  int = int.replace(/^0+(?=\d)/, '').slice(0, 10);
  const gi = int ? groupFmt.format(Number(int)) : dec !== null ? '0' : '';
  return dec !== null ? `${gi}.${dec}` : gi;
}
// Reformat in place while typing, keeping the caret after the same digit.
export function liveFormat(input) {
  const old = input.value;
  const next = groupTyping(old);
  if (next === old) return;
  const pos = input.selectionStart ?? old.length;
  const keep = old.slice(0, pos).replace(/[^\d.]/g, '').length;
  input.value = next;
  let i = 0;
  for (let seen = 0; i < next.length && seen < keep; i++) if (/[\d.]/.test(next[i])) seen++;
  try { input.setSelectionRange(i, i); } catch { /* not focused */ }
}

// Size the big amount input to its text so the ₱ sign hugs the number.
let measure = null;
export function sizeAmount(input) {
  if (!input) return;
  const text = input.value || input.placeholder || '0';
  try {
    measure ||= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = measure.measureText(text).width;
    if (!(w > 0)) throw new Error('no width');
    input.style.width = `${Math.ceil(w * 1.05) + 6}px`;
  } catch {
    input.style.width = `${Math.max(1, text.length) + 0.5}ch`;
  }
}

// Busy/disabled state for a form and every submit button that targets it.
export function setBusy(form, on) {
  if (on) form.dataset.busy = '1'; else delete form.dataset.busy;
  const btns = [...form.querySelectorAll('button[type=submit]'), ...(form.id ? $$(`button[form="${CSS.escape(form.id)}"]`) : [])];
  for (const b of btns) { b.disabled = on; if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy'); }
}

export function showFormError(form, err) {
  const msg = errorMessage(err);
  if (!isValidation(err) && !isStoreError(err)) console.error(err);
  let box = form.querySelector('.form-err');
  if (!box) {
    box = document.createElement('p');
    box.className = 'form-err critical-text';
    box.setAttribute('role', 'alert');
    form.prepend(box);
  }
  box.textContent = msg;
  box.hidden = false;
  const name = err?.field;
  const input = name && form.querySelector(`[name="${CSS.escape(name)}"]`);
  if (input && input.type !== 'hidden') {
    input.setAttribute('aria-invalid', 'true');
    input.focus({ preventScroll: true });
  }
  box.scrollIntoView({ block: 'nearest' });
}
export function clearFormError(form) {
  const box = form.querySelector('.form-err');
  if (box) box.hidden = true;
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
}

// Simple reader for FormData-based forms.
export const str = (f, k, max = 60) => String(f.get(k) ?? '').trim().slice(0, max);
// '' -> null; bad text -> FormProblem.
export function optMoney(f, k, what = 'amount') {
  const raw = String(f.get(k) ?? '').trim();
  if (!raw) return null;
  const v = parseAmount(raw);
  if (!Number.isFinite(v) || v < 0) throw new FormProblem(`Check the ${what}. Use numbers only, like 1,250.50.`, k);
  return v;
}
export function reqMoney(f, k, msg) {
  const v = optMoney(f, k);
  if (v === null || !(v > 0)) throw new FormProblem(msg, k);
  return v;
}
export function intField(f, k, { min = 0, max = 999, blank = null, msg } = {}) {
  const raw = String(f.get(k) ?? '').trim();
  if (!raw) { if (blank !== null) return blank; throw new FormProblem(msg || 'Enter a number', k); }
  if (!/^\d{1,4}$/.test(raw) || +raw < min || +raw > max) throw new FormProblem(msg || `Enter a whole number from ${min} to ${max}`, k);
  return +raw;
}
