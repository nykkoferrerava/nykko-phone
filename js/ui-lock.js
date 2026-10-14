// PIN lock: set / confirm / unlock, with throttling after wrong tries.
import * as S from './store.js';
import { db } from './store.js';
import { $, $$, setSettings, syncInert, toast, errorMessage } from './ui-core.js';

// ---- SHA-256 (pure JS fallback when crypto.subtle is missing, e.g. plain http on a LAN) ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  if (globalThis.crypto?.subtle?.digest) {
    try { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))); } catch { /* fall through to JS */ }
  }
  return hex(sha256(data));
}
function newSalt() {
  try { return crypto.getRandomValues(new Uint32Array(2)).join(''); } catch { return `${Date.now()}${Math.random()}`.replace(/\D/g, ''); }
}

const FREE_TRIES = 5;
const waitMs = (fails) => 30000 * 2 ** Math.min(Math.max(0, fails - FREE_TRIES), 7); // 30 s, 1 min, 2 min … up to ~1 h

export const Lock = {
  mode: null, entry: '', first: '', hiddenAt: 0, busy: false, opts: {}, timer: 0,
  el: () => $('#lock'),
  start(mode, opts = {}) {
    this.mode = mode; this.entry = ''; this.first = ''; this.opts = opts;
    const a = document.activeElement;
    if (a && a !== document.body) a.blur();
    const el = this.el();
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'lock-title');
    el.hidden = false;
    document.body.classList.add('locked');
    syncInert();
    this.draw();
    this.tick();
    const t = $('#lock-title');
    t.tabIndex = -1;
    t.style.outline = 'none';
    t.focus({ preventScroll: true });
  },
  lockedFor() { return this.mode === 'unlock' ? Math.max(0, (Number(db.settings.pinLockUntil) || 0) - Date.now()) : 0; },
  tick() {
    clearInterval(this.timer);
    const left = this.lockedFor();
    for (const b of $$('#lock [data-k]')) b.disabled = left > 0;
    if (!left) return;
    const show = () => {
      const ms = this.lockedFor();
      if (!ms) { clearInterval(this.timer); for (const b of $$('#lock [data-k]')) b.disabled = false; return this.draw(); }
      const s = Math.ceil(ms / 1000);
      this.draw(`Too many wrong PINs. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`);
    };
    show();
    this.timer = setInterval(show, 1000);
  },
  draw(err = '') {
    const title = { unlock: 'Enter PIN', set: 'Choose a 4-digit PIN', confirm: 'Enter the same PIN again' }[this.mode] || '';
    $('#lock-title').textContent = title;
    $('#lock-err').textContent = err;
    $('#lock-dots').innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i < this.entry.length ? 'on' : ''}"></i>`).join('');
    $('#lock-dots').setAttribute('aria-label', `${this.entry.length} of 4 digits entered`);
    $('#lock-cancel').hidden = this.mode === 'unlock';
    $('#lock-forgot').hidden = this.mode !== 'unlock';
  },
  async press(k) {
    if (!this.mode || this.busy || this.lockedFor()) return;
    if (k === 'del') this.entry = this.entry.slice(0, -1);
    else if (/^\d$/.test(k) && this.entry.length < 4) this.entry += k;
    this.draw();
    if (this.entry.length < 4) return;
    const pin = this.entry;
    this.entry = '';
    this.busy = true;
    try {
      if (this.mode === 'unlock') return await this.check(pin);
      if (this.mode === 'set') { this.first = pin; this.mode = 'confirm'; return this.draw(); }
      if (pin !== this.first) { this.mode = 'set'; this.first = ''; return this.draw("The PINs didn't match. Choose a PIN again."); }
      const pinSalt = newSalt();
      const pinHash = await hashPin(pin, pinSalt);
      try {
        setSettings({ pinSalt, pinHash, pinFails: 0, pinLockUntil: 0 });
      } catch (e) {
        this.mode = 'set';
        return this.draw(`PIN not saved. ${errorMessage(e)}`);
      }
      this.close(true);
      toast('PIN set');
    } catch (e) {
      console.error(e);
      this.draw('Something went wrong. Please try again.');
    } finally {
      this.busy = false;
    }
  },
  async check(pin) {
    if ((await hashPin(pin, db.settings.pinSalt)) === db.settings.pinHash) {
      if (db.settings.pinFails || db.settings.pinLockUntil) persist({ pinFails: 0, pinLockUntil: 0 });
      return this.close(true);
    }
    const fails = (Number(db.settings.pinFails) || 0) + 1;
    const patch = { pinFails: fails };
    if (fails >= FREE_TRIES) patch.pinLockUntil = Date.now() + waitMs(fails);
    persist(patch);
    this.el().classList.add('shake');
    setTimeout(() => this.el().classList.remove('shake'), 400);
    if (patch.pinLockUntil) return this.tick();
    const left = FREE_TRIES - fails;
    this.draw(left <= 3 ? `Wrong PIN. ${left} more ${left === 1 ? 'try' : 'tries'} before a short wait.` : 'Wrong PIN');
  },
  close(done = false) {
    clearInterval(this.timer);
    this.el().hidden = true;
    document.body.classList.remove('locked', 'privacy');
    const { onDone, onCancel } = this.opts;
    this.mode = null;
    this.opts = {};
    syncInert();
    if (done) onDone?.(); else onCancel?.();
  },
  forgot() {
    if (!confirm("A forgotten PIN can't be recovered. The only way back in is to erase Pitaka's data on this phone.\n\nIf you saved a backup file, you can restore it afterwards and choose a new PIN (the backup doesn't bring back the old PIN).\n\nErase everything on this phone?")) return;
    try { S.resetAll(); } catch (e) { alert(errorMessage(e)); return; }
    location.reload();
  },
};

// Throttle counters must survive even if storage is failing.
function persist(patch) {
  try { setSettings(patch); } catch { Object.assign(db.settings, patch); }
}
