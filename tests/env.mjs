// Shared test environment: a fake localStorage, an in-memory storage adapter and a frozen clock.
// Import it before anything from js/ so store.js picks up the memory adapter.
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

export const APP = process.env.PITAKA_DIR ? pathToFileURL(process.env.PITAKA_DIR).href.replace(/\/$/, '') : new URL('..', import.meta.url).href.replace(/\/$/, '');

export class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
}
globalThis.localStorage = new MemStorage();

// "Today" is Tue 2026-10-13 at local noon unless a test moves it.
mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 13, 12).getTime() });
export function setToday(iso, hh = 12, mm = 0) {
  const [y, m, d] = iso.split('-').map(Number);
  mock.timers.setTime(new Date(y, m - 1, d, hh, mm).getTime());
}
export const at = (iso, hh = 12, mm = 0) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, hh, mm).getTime(); };

export const ST = await import(`${APP}/js/storage.js`);
export const store = ST.memoryAdapter();
globalThis.__pitakaAdapter = store;
export const U = await import(`${APP}/js/util.js`);
export const S = await import(`${APP}/js/store.js`);

// Payday anchor Fri 2026-10-09 -> period 10-09..10-22, next payday 10-23.
export function fresh({ today = '2026-10-13', anchor = '2026-10-09' } = {}) {
  setToday(today);
  localStorage.clear();
  S.useAdapter(store);
  S.resetAll();
  S.db.settings.payAnchor = anchor;
  S.db.debtHistory = {};
}
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const cat = (name) => S.db.categories.find((c) => c.name === name);
export const wallet = (name) => S.db.accounts.find((a) => a.name === name);
export const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
