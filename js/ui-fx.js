// Feel: theme, collapsing header, haptics, count-up numbers and drag-to-dismiss sheets.
// Only DOM here, no data: every piece is a progressive enhancement that does nothing where unsupported.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const THEME_BG = { light: '#f2f2f6', dark: '#000000' }; // = --bg in app.css and js/boot.js

// ------------------------------------------------------------------ theme
export const THEMES = ['system', 'light', 'dark'];
export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'system';
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  try { localStorage.setItem('pitaka.ui.theme', t); } catch { /* boot.js falls back to the system theme */ }
  syncThemeColor(t);
  return t;
}
// Safari tints the status bar with theme-color: one meta for a forced theme, two (by media) for system.
function syncThemeColor(t) {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const add = (content, media) => {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = content;
    if (media) m.media = media;
    document.head.append(m);
  };
  if (t === 'system') {
    add(THEME_BG.light, '(prefers-color-scheme: light)');
    add(THEME_BG.dark, '(prefers-color-scheme: dark)');
  } else add(THEME_BG[t]);
}

// ------------------------------------------------------------------ large title -> compact bar
let ticking = false;
export function syncScrolled() {
  document.body.classList.toggle('scrolled', window.scrollY > 30);
}
export function initScrollHeader() {
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; syncScrolled(); });
  }, { passive: true });
  syncScrolled();
}

// ------------------------------------------------------------------ haptics
// iOS 18+ plays a light tick when an <input type="checkbox" switch> is toggled, also from a script
// during a tap. Elsewhere this toggles a hidden checkbox and nothing else happens.
export function haptic() {
  const label = document.getElementById('haptic');
  if (!label || !/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  try { label.click(); } catch { /* no haptics, no problem */ }
}

// ------------------------------------------------------------------ count-up numbers
// <span data-count="free" data-to="1234.5"><span class="v">₱1,234</span></span>: animates .v from the
// value last shown under the same key. First render and reduced motion show the value straight away.
const shown = new Map();
const easeOut = (x) => 1 - (1 - x) ** 3;
export function runCountUps(root, format) {
  for (const el of root.querySelectorAll('[data-count]')) {
    const key = el.dataset.count;
    const to = Number(el.dataset.to) || 0;
    const v = el.querySelector('.v') || el;
    const from = shown.get(key);
    shown.set(key, to);
    if (from === undefined || from === to || reduced()) continue;
    const t0 = performance.now();
    const ms = Math.min(900, 420 + Math.log10(1 + Math.abs(to - from)) * 90);
    const step = (now) => {
      if (!el.isConnected) return;
      const p = Math.min(1, (now - t0) / ms);
      v.textContent = format(from + (to - from) * easeOut(p));
      if (p < 1) requestAnimationFrame(step);
    };
    v.textContent = format(from);
    requestAnimationFrame(step);
  }
}

// ------------------------------------------------------------------ drag-to-dismiss sheets
// Drag the grabber or the header from anywhere; drag the body down when it is scrolled to the top.
// Lets go: far enough or fast enough closes with the system curve, otherwise it springs back.
const NO_DRAG = 'input, textarea, select, [contenteditable], .import-preview, .chart, .chips.scroll, .wallets, .emoji-row, .tok-text';
export function sheetDrag(root, close) {
  const panel = root.querySelector('.sheet-panel');
  if (!panel) return;
  let state = null; // { y0, dy, lastY, lastT, v, handle, live }
  const set = (dy) => {
    root.style.setProperty('--drag', `${dy}px`);
    root.style.setProperty('--drag-p', String(Math.max(0, Math.min(1, dy / Math.max(1, panel.offsetHeight)))));
  };
  const start = (y, target) => {
    const handle = !!target.closest?.('.grabber-zone, .sheet-head');
    if (!handle && (panel.scrollTop > 0 || target.closest?.(NO_DRAG))) { state = null; return; }
    state = { y0: y, dy: 0, lastY: y, lastT: performance.now(), v: 0, handle, live: false };
  };
  const move = (y, e) => {
    if (!state) return;
    const d = y - state.y0;
    if (!state.live) {
      if (Math.abs(d) < 6) return;
      if (d < 0 || (!state.handle && panel.scrollTop > 0)) { state = null; return; }
      state.live = true;
      panel.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    state.v = (y - state.lastY) / Math.max(1, now - state.lastT);
    state.lastY = y;
    state.lastT = now;
    state.dy = d > 0 ? d : d / 5;
    set(state.dy);
  };
  const end = () => {
    const s = state;
    state = null;
    if (!s?.live) return;
    panel.classList.remove('dragging');
    if (s.dy > Math.min(150, panel.offsetHeight * 0.28) || (s.v > 0.55 && s.dy > 30)) close();
    else set(0);
  };
  panel.addEventListener('touchstart', (e) => start(e.touches[0].clientY, e.target), { passive: true });
  panel.addEventListener('touchmove', (e) => move(e.touches[0].clientY, e), { passive: false });
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
  // Mouse or pen: the grabber and header only.
  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || !e.target.closest('.grabber-zone, .sheet-head') || e.target.closest('button, a, input')) return;
    start(e.clientY, e.target);
    const mv = (ev) => move(ev.clientY, ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); end(); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
  set(0);
}
