// Logic tests for Pitaka (js/util.js, js/store.js, js/importer.js). No dependencies.
//   node --test tests/
//   TZ=Asia/Manila node --test tests/ ; TZ=UTC node --test tests/ ; TZ=America/New_York node --test tests/
// PITAKA_DIR=/some/checkout points the tests at another copy of the app.
//
// Test names that start with "BUG-nn" or "Ann" refer to the chaos report (BUGS.md) and the logic review.
// Tests marked { todo } document product gaps that are out of scope; they never fail the run.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const APP = process.env.PITAKA_DIR ? pathToFileURL(process.env.PITAKA_DIR).href.replace(/\/$/, '') : new URL('..', import.meta.url).href.replace(/\/$/, '');

// ---- environment: store.js gets an in-memory storage adapter; localStorage holds v2's data ----------
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
}
globalThis.localStorage = new MemStorage();
const ST = await import(`${APP}/js/storage.js`);
const store = ST.memoryAdapter();
globalThis.__pitakaAdapter = store;

// Freeze "today" so due/overdue/period logic is deterministic. Local noon avoids any TZ edge.
mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 13, 12).getTime() });
function setToday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  mock.timers.setTime(new Date(y, m - 1, d, 12).getTime());
}

const U = await import(`${APP}/js/util.js`);
const S = await import(`${APP}/js/store.js`);
const I = await import(`${APP}/js/importer.js`);
const quiet = console.error;

// ---- fixtures -----------------------------------------------------------------------------------
// Today = Tue 2026-10-13, payday anchor = Fri 2026-10-09 -> period 10-09..10-22, next payday 10-23.
function fresh({ today = '2026-10-13', anchor = '2026-10-09' } = {}) {
  setToday(today);
  localStorage.clear();
  S.resetAll();
  S.db.settings.payAnchor = anchor;
  S.db.debtHistory = {};
}
const card = (o = {}) => S.saveDebt({ type: 'card', name: 'BPI card', lender: '', balance: 10000, paymentAmount: 500, plannedPayment: 2000, creditLimit: 50000, rate: 3, nextDue: '2026-10-20', notes: '', ...o });
const loan = (o = {}) => S.saveDebt({ type: 'loan', name: 'Home Credit', lender: '', paymentAmount: 1000, frequency: 'monthly', totalPayments: 12, paymentsMade: 0, balance: 12000, nextDue: '2026-10-31', rate: 0, notes: '', ...o });
const person = (o = {}) => S.saveDebt({ type: 'person', name: 'Tita Mel', lender: '', balance: 5000, plannedPayment: 1000, paymentAmount: 0, nextDue: null, rate: 0, notes: '', ...o });
const bill = (o = {}) => S.saveBill({ name: 'Rent', amount: 8000, frequency: 'monthly', nextDue: '2026-10-31', categoryId: S.db.categories[3].id, done: false, ...o });
const goal = (o = {}) => S.saveGoal({ name: 'Japan', emoji: '✈️', target: 60000, deadline: '2027-04-01', saved: 0, ...o });
const add = (o) => S.saveTxn({ date: '2026-10-13', note: '', ...o });
const pay = (d, amount, installments = 1, o = {}) => add({ kind: 'debt', debtId: d.id, amount, installments, ...o });
const payBill = (b, amount = b.amount, o = {}) => add({ kind: 'expense', categoryId: b.categoryId, billId: b.id, amount, ...o });
const spend = (amount, o = {}) => add({ kind: 'expense', categoryId: S.db.categories[0].id, amount, ...o });
const clone = (x) => JSON.parse(JSON.stringify(x));
const state = () => clone({ debts: S.db.debts, bills: S.db.bills, goals: S.db.goals });
const cashId = () => S.defaultAccountId();
const throwsValidation = (fn, field) => assert.throws(fn, (e) => {
  assert.ok(e instanceof S.ValidationError, `expected ValidationError, got ${e && e.name}: ${e && e.message}`);
  assert.ok(e.message && !/undefined|NaN|null/.test(e.message), `message should be plain English: ${e.message}`);
  if (field) assert.equal(e.field, field);
  return true;
});

// What the UI sends when the user opens an entry, changes some fields and saves (contract §2 fields only).
const TXN_FIELDS = {
  expense: ['categoryId', 'accountId', 'cardId', 'billId'], income: ['accountId'],
  debt: ['debtId', 'accountId', 'installments'], goal: ['goalId', 'accountId', 'withdraw'],
  adjust: ['debtId', 'direction', 'reason'], transfer: ['accountId', 'toAccountId'],
};
function edit(id, changes = {}) {
  const old = S.db.txns.find((x) => x.id === id);
  const t = { ...old, ...changes };
  const out = { id: t.id, kind: t.kind, amount: t.amount, date: t.date, note: t.note };
  for (const k of TXN_FIELDS[t.kind]) if (t[k] !== undefined && t[k] !== '' && t[k] !== null) out[k] = t[k];
  return S.saveTxn(out);
}
// Mirrors the debt form when the user opens "Edit debt" and saves without changes.
function resaveDebt(d) {
  const input = { id: d.id, type: d.type, name: d.name, lender: d.lender || '', nextDue: d.nextDue, notes: d.notes || '', rate: d.rate || 0, balance: d.balance };
  if (S.isScheduled(d)) Object.assign(input, { paymentAmount: d.paymentAmount, frequency: d.frequency, totalPayments: d.totalPayments, paymentsMade: d.paymentsMade });
  else if (d.type === 'card') Object.assign(input, { paymentAmount: d.paymentAmount, creditLimit: d.creditLimit, plannedPayment: d.plannedPayment });
  else Object.assign(input, { plannedPayment: d.plannedPayment, paymentAmount: 0 });
  return S.saveDebt(input);
}
function refPeriod(anchor, iso) {
  let s = anchor;
  while (s > iso) s = U.addDays(s, -14);
  while (U.addDays(s, 14) <= iso) s = U.addDays(s, 14);
  return { start: s, end: U.addDays(s, 13), next: U.addDays(s, 14) };
}
function simulateCard(balance, ratePct, payment) {
  let b = balance, n = 0;
  const r = ratePct / 100;
  while (b > 0.004) { b = b * (1 + r) - payment; n++; if (n > 5000) return Infinity; }
  return n;
}
// Make storage writes fail the way iOS Safari does.
const failWrites = (name = 'QuotaExceededError') => store.failWith(name);
// What is on disk once everything staged has been written.
async function stored() { await S.flush(); return store.dump(); }
// A phone that has only v2's data (or nothing) in localStorage, as on the first v3 launch.
async function v2Phone(raw) {
  fresh(); await S.flush(); await store.clear(); localStorage.clear();
  if (raw !== undefined) localStorage.setItem('pitaka.data', raw);
}

// =================================================================================================
describe('util: dates', () => {
  test('toISO/parseISO round-trip every day of 2024-2029 (incl. leap days)', () => {
    let d = '2024-01-01', n = 0;
    while (d < '2030-01-01') { assert.equal(U.toISO(U.parseISO(d)), d); d = U.addDays(d, 1); n++; }
    assert.equal(n, 2192);
  });
  test('daysBetween is exact across month/year/leap boundaries', () => {
    assert.equal(U.daysBetween('2028-02-28', '2028-03-01'), 2);
    assert.equal(U.daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(U.daysBetween('2027-01-01', '2026-12-31'), -1);
    assert.equal(U.daysBetween('2020-01-03', '2026-10-13'), 2475);
  });
  test('addMonths clamps to month end and restores the intended day with keepDay', () => {
    assert.equal(U.addMonths('2026-01-31', 1, 31), '2026-02-28');
    assert.equal(U.addMonths('2026-02-28', 1, 31), '2026-03-31');
    assert.equal(U.addMonths('2028-01-31', 1, 31), '2028-02-29');
    assert.equal(U.addMonths('2028-02-29', 1, 31), '2028-03-31');
    assert.equal(U.addMonths('2026-03-31', 1, 31), '2026-04-30');
    assert.equal(U.addMonths('2026-12-15', 1), '2027-01-15');
    assert.equal(U.addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(U.addMonths('2026-03-31', -1), '2026-02-28');
  });
  test('without keepDay a month-end date drifts (callers must pass dueDay)', () => {
    assert.equal(U.addMonths('2026-02-28', 1), '2026-03-28');
  });
  test('shiftMonth', () => {
    assert.equal(U.shiftMonth('2026-12', 1), '2027-01');
    assert.equal(U.shiftMonth('2026-01', -1), '2025-12');
    assert.equal(U.shiftMonth('2026-10', -5), '2026-05');
  });
  test('relDay always returns relative text', () => {
    setToday('2026-10-13');
    assert.equal(U.relDay('2026-10-13'), 'today');
    assert.equal(U.relDay('2026-10-14'), 'tomorrow');
    assert.equal(U.relDay('2026-10-25'), 'in 12 days');
    assert.equal(U.relDay('2026-10-10'), '3 days ago');
    assert.equal(U.relDay('2027-10-13'), 'in 365 days');
  });
});

describe('util: advance() / retreat() for every frequency', () => {
  test('weekly / biweekly cross month and year', () => {
    assert.equal(U.advance('2026-12-29', 'weekly'), '2027-01-05');
    assert.equal(U.advance('2026-12-25', 'biweekly'), '2027-01-08');
    assert.equal(U.advance('2028-02-22', 'weekly'), '2028-02-29');
  });
  test('monthly chain from the 31st with keepDay: Jan31 -> Feb28 -> Mar31 -> Apr30 -> May31', () => {
    const out = []; let d = '2026-01-31';
    for (let i = 0; i < 4; i++) out.push((d = U.advance(d, 'monthly', 31)));
    assert.deepEqual(out, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });
  test('monthly chain in a leap year: Jan31 -> Feb29 -> Mar31', () => {
    assert.equal(U.advance('2028-01-31', 'monthly', 31), '2028-02-29');
    assert.equal(U.advance('2028-02-29', 'monthly', 31), '2028-03-31');
  });
  test('quarterly from Nov 30 with keepDay: Feb 28 -> May 30', () => {
    assert.equal(U.advance('2026-11-30', 'quarterly', 30), '2027-02-28');
    assert.equal(U.advance('2027-02-28', 'quarterly', 30), '2027-05-30');
  });
  test('yearly on Feb 29 with keepDay', () => {
    let d = '2028-02-29'; const out = [];
    for (let i = 0; i < 4; i++) out.push((d = U.advance(d, 'yearly', 29)));
    assert.deepEqual(out, ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });
  test('semimonthly default 15th & end-of-month sequence incl. February', () => {
    let d = '2026-01-31'; const out = [];
    for (let i = 0; i < 7; i++) out.push((d = U.advance(d, 'semimonthly')));
    assert.deepEqual(out, ['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30', '2026-05-15']);
    assert.equal(U.advance('2028-02-15', 'semimonthly'), '2028-02-29');
    assert.equal(U.advance('2026-12-31', 'semimonthly'), '2027-01-15');
  });
  test('semimonthly from an off-schedule day snaps to the next due day', () => {
    assert.equal(U.advance('2026-10-05', 'semimonthly'), '2026-10-15');
    assert.equal(U.advance('2026-10-20', 'semimonthly'), '2026-10-31');
  });
  test('semimonthly with custom due days (5th & 20th, common for lending apps)', () => {
    assert.equal(U.advance('2026-10-05', 'semimonthly', undefined, [5, 20]), '2026-10-20');
    assert.equal(U.advance('2026-10-20', 'semimonthly', undefined, [5, 20]), '2026-11-05');
    assert.equal(U.advance('2026-10-10', 'semimonthly', undefined, [5, 20]), '2026-10-20');
    assert.equal(U.advance('2026-12-20', 'semimonthly', undefined, [5, 20]), '2027-01-05');
    assert.equal(U.advance('2026-02-10', 'semimonthly', undefined, [10, 30]), '2026-02-28');
    assert.equal(U.advance('2026-02-28', 'semimonthly', undefined, [10, 30]), '2026-03-10');
    assert.equal(U.retreat('2026-03-10', 'semimonthly', undefined, [10, 30]), '2026-02-28');
    assert.equal(U.retreat('2026-11-05', 'semimonthly', undefined, [5, 20]), '2026-10-20');
    assert.equal(U.retreat('2026-10-20', 'semimonthly', undefined, [5, 20]), '2026-10-05');
  });
  test('once and unknown frequencies return null (advance and retreat)', () => {
    assert.equal(U.advance('2026-10-13', 'once'), null);
    assert.equal(U.advance('2026-10-13', undefined), null);
    assert.equal(U.retreat('2026-10-13', 'once'), null);
  });
  test('retreat is the exact inverse of advance along every schedule (24 steps out and back)', () => {
    const cases = [['weekly', '2026-10-14'], ['biweekly', '2026-10-16'], ['semimonthly', '2026-01-15'], ['semimonthly', '2026-01-31'],
      ['semimonthly', '2026-01-05', undefined, [5, 20]], ['semimonthly', '2026-01-30', undefined, [30, 31]], ['semimonthly', '2026-01-01', undefined, [1, 16]],
      ['monthly', '2026-01-31', 31], ['monthly', '2027-01-29', 29], ['quarterly', '2026-11-30', 30], ['yearly', '2028-02-29', 29], ['monthly', '2026-10-15', 15]];
    for (const [freq, start, keepDay, dueDays] of cases) {
      const chain = [start];
      for (let i = 0; i < 24; i++) chain.push(U.advance(chain[i], freq, keepDay, dueDays));
      for (let i = 24; i > 0; i--) assert.equal(U.retreat(chain[i], freq, keepDay, dueDays), chain[i - 1], `${freq} ${dueDays || ''} retreat(${chain[i]})`);
    }
  });
  test('FREQS keys stay, semimonthly reads "Twice a month"', () => {
    assert.deepEqual(Object.keys(U.FREQS), ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly', 'once']);
    assert.equal(U.FREQS.semimonthly, 'Twice a month');
  });
  test('PER_MONTH factors', () => {
    assert.equal(U.round2(1000 * U.PER_MONTH.weekly), 4333.33);
    assert.equal(U.round2(1000 * U.PER_MONTH.biweekly), 2166.67);
    assert.equal(U.PER_MONTH.semimonthly, 2);
  });
});

describe('util: money', () => {
  test('peso uses the real minus sign and drops zero centavos', () => {
    assert.equal(U.peso(-6674), '−₱6,674');
    assert.equal(U.peso(-1234.5), '−₱1,234.50');
    assert.equal(U.peso(1234.5), '₱1,234.50');
    assert.equal(U.peso(1000), '₱1,000');
    assert.equal(U.peso(12.6, { whole: true }), '₱13');
    assert.equal(U.peso(-0.001), '₱0');
    assert.equal(U.peso(NaN), '₱0');
    assert.equal(U.peso(undefined), '₱0');
  });
  test('BUG-26: pesoShort uses k / M / B and never "₱500000M"', () => {
    assert.equal(U.pesoShort(0), '₱0');
    assert.equal(U.pesoShort(500), '₱500');
    assert.equal(U.pesoShort(1500), '₱1.5k');
    assert.equal(U.pesoShort(25000), '₱25k');
    assert.equal(U.pesoShort(999950), '₱1M');
    assert.equal(U.pesoShort(2500000), '₱2.5M');
    assert.equal(U.pesoShort(5e11), '₱500B');
    assert.equal(U.pesoShort(-2500), '−₱2.5k');
    assert.ok(!/\d{4,}/.test(U.pesoShort(1e12)), U.pesoShort(1e12));
    assert.ok(!/\d{4,}/.test(U.pesoShort(999999)), U.pesoShort(999999));
  });
  test('BUG-23: parseAmount accepts plain amounts, ₱, commas and spaces', () => {
    assert.equal(U.parseAmount('1234'), 1234);
    assert.equal(U.parseAmount('1,234.50'), 1234.5);
    assert.equal(U.parseAmount('₱500'), 500);
    assert.equal(U.parseAmount(' 500 '), 500);
    assert.equal(U.parseAmount('₱ 1,000,000'), 1000000);
    assert.equal(U.parseAmount('12.345678'), 12.35);
    assert.equal(U.parseAmount('.5'), 0.5);
    assert.equal(U.parseAmount('0'), 0);
    assert.equal(U.parseAmount(250), 250);
  });
  test('BUG-23: parseAmount returns NaN for anything else', () => {
    for (const bad of ['abc', '5O0', '1e12', '--5', '-5', '12abc', '', '   ', null, undefined, '1.2.3', '₱', 'Infinity', '0x10', NaN, Infinity, -5]) {
      assert.ok(Number.isNaN(U.parseAmount(bad)), `parseAmount(${JSON.stringify(bad)}) = ${U.parseAmount(bad)}`);
    }
  });
  test('round2 removes float noise', () => {
    assert.equal(U.round2(0.1 + 0.2), 0.3);
    assert.equal(U.round2(1234.565 + 0.0049), 1234.57);
  });
  test('esc escapes all five HTML-significant characters', () => {
    assert.equal(U.esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    assert.equal(U.esc(undefined), '');
  });
});

// =================================================================================================
describe('store: pay periods', () => {
  test('day before / of / after payday', () => {
    fresh();
    assert.deepEqual(S.period('2026-10-08'), { start: '2026-09-25', end: '2026-10-08', next: '2026-10-09' });
    assert.deepEqual(S.period('2026-10-09'), { start: '2026-10-09', end: '2026-10-22', next: '2026-10-23' });
    assert.deepEqual(S.period('2026-10-22'), { start: '2026-10-09', end: '2026-10-22', next: '2026-10-23' });
    assert.deepEqual(S.period('2026-10-23'), { start: '2026-10-23', end: '2026-11-05', next: '2026-11-06' });
  });
  test('anchor in the future still yields the period containing today', () => {
    fresh({ anchor: '2026-12-04' });
    assert.deepEqual(S.period('2026-10-13'), refPeriod('2026-12-04', '2026-10-13'));
  });
  test('anchor years ago matches brute force for every day of 2026-2028', () => {
    fresh({ anchor: '2020-01-03' });
    let d = '2026-01-01';
    while (d < '2029-01-01') { assert.deepEqual(S.period(d), refPeriod('2020-01-03', d), d); d = U.addDays(d, 1); }
  });
  test('paydaysUntil counts paydays after today up to and including the date', () => {
    fresh();
    assert.equal(S.paydaysUntil('2026-10-22'), 0);
    assert.equal(S.paydaysUntil('2026-10-23'), 1);
    assert.equal(S.paydaysUntil('2026-11-06'), 2);
    assert.equal(S.paydaysUntil('2026-10-01'), 0);
    let n = 0; for (let p = '2026-10-23'; p <= '2027-04-01'; p = U.addDays(p, 14)) n++;
    assert.equal(S.paydaysUntil('2027-04-01'), n);
  });
  test('paydaysUntil on payday itself does not count today', () => {
    fresh({ today: '2026-10-09' });
    assert.equal(S.paydaysUntil('2026-10-09'), 0);
    assert.equal(S.paydaysUntil('2026-10-23'), 1);
  });
});

// =================================================================================================
describe('store: errors and transactional saves (BUG-02)', () => {
  test('ValidationError and StoreError are exported Error subclasses', () => {
    const v = new S.ValidationError('Enter an amount', 'amount');
    assert.ok(v instanceof Error); assert.equal(v.field, 'amount'); assert.equal(v.message, 'Enter an amount');
    const s = new S.StoreError('x', 'quota');
    assert.ok(s instanceof Error); assert.equal(s.code, 'quota');
  });
  test('a failed write rejects flush() with StoreError(quota) and puts memory back exactly', async () => {
    fresh(); const c = card(); spend(100);
    await S.flush();
    const before = JSON.stringify(S.db);
    const restore = failWrites();
    try {
      spend(150, { cardId: c.id });
      await assert.rejects(S.flush(), (e) => e instanceof S.StoreError && e.code === 'quota' && !!e.message);
      assert.equal(JSON.stringify(S.db), before);
      assert.equal(S.debt(c.id).balance, 10000);
      assert.equal(S.db.txns.length, 1);
    } finally { restore(); }
    spend(150); // works again once storage is back
    assert.equal(S.db.txns.length, 2);
    assert.equal((await stored()).txns.length, 2);
  });
  test('blocked storage gives StoreError(blocked)', async () => {
    fresh(); await S.flush();
    const restore = failWrites('SecurityError');
    try { spend(150); await assert.rejects(S.flush(), (e) => e instanceof S.StoreError && e.code === 'blocked'); } finally { restore(); }
  });
  test('EVERY mutating function rolls back when the write fails', async () => {
    fresh(); const c = card(); const l = loan(); const b = bill(); const g = goal(); const t = pay(l, 1000); spend(10, { cardId: c.id });
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 0 });
    const catId = S.db.categories[0].id;
    const ops = {
      saveTxn: () => spend(1), editTxn: () => edit(t.id, { amount: 500 }), deleteTxn: () => S.deleteTxn(t.id),
      restoreTxn: () => S.restoreTxn({ ...clone(t), id: 'zz-restore' }),
      saveDebt: () => S.saveDebt({ id: l.id, type: 'loan', name: 'X', balance: 1, paymentAmount: 1, totalPayments: 1, paymentsMade: 0, frequency: 'monthly' }),
      newDebt: () => person(), deleteDebt: () => S.deleteDebt(c.id), saveBill: () => bill(), deleteBill: () => S.deleteBill(b.id),
      saveGoal: () => goal(), deleteGoal: () => S.deleteGoal(g.id), saveCategory: () => S.saveCategory({ name: 'Pets', emoji: '🐶', limit: 0 }),
      deleteCategory: () => S.deleteCategory(catId), saveAccount: () => S.saveAccount({ name: 'BPI', kind: 'bank', opening: 5 }),
      deleteAccount: () => S.deleteAccount(gc.id), markBackedUp: () => S.markBackedUp(), updateSettings: () => S.updateSettings({ pinFails: 3 }), snapshotDebt: () => { setToday('2026-10-14'); S.snapshotDebt(); },
    };
    for (const [name, op] of Object.entries(ops)) {
      setToday('2026-10-13');
      await S.flush();
      const before = JSON.stringify(S.db);
      const restore = failWrites();
      try {
        op();
        await assert.rejects(S.flush(), (e) => e instanceof S.StoreError, name);
        assert.equal(JSON.stringify(S.db), before, `${name} left memory half-applied`);
      } finally { restore(); }
    }
  });
  test('validation errors change nothing', () => {
    fresh(); const p = person({ balance: 1000 });
    const before = JSON.stringify(S.db);
    throwsValidation(() => pay(p, 5000));
    assert.equal(JSON.stringify(S.db), before);
  });
});

// =================================================================================================
describe('store: load, sanitize and migration', () => {
  test('load() of a fresh phone is ok', async () => {
    fresh(); await S.flush();
    assert.deepEqual(await S.load(), { ok: true });
    assert.equal(S.db.version, 3);
  });
  test('BUG-03/A10: unreadable data is rescued under its own key and never overwritten', async () => {
    const raw = '{"txns":[{"id":"a"';
    await v2Phone(raw);
    console.error = () => {};
    let r; try { r = await S.load(); } finally { console.error = quiet; }
    assert.equal(r.ok, false); assert.equal(r.reason, 'unreadable');
    assert.match(r.rescuedKey, /^pitaka\.data\.unreadable-\d+$/);
    assert.equal(localStorage.getItem(r.rescuedKey), raw);
    assert.ok(Array.isArray(S.db.txns) && S.db.txns.length === 0, 'continues with blank data');
    console.error = () => {};
    let again; try { await store.clear(); again = await S.load(); } finally { console.error = quiet; }
    assert.equal(again.rescuedKey, r.rescuedKey, 'opening again reuses the same copy');
    spend(100); await S.flush(); // saving goes to the new store; v2's key and the copy stay as they were
    assert.equal(localStorage.getItem(r.rescuedKey), raw);
    assert.equal(localStorage.getItem('pitaka.data'), raw);
  });
  test('Erase all data also removes the rescued copies of unreadable data', async () => {
    await v2Phone('{"txns":[{"id":"a"');
    console.error = () => {};
    let r; try { r = await S.load(); } finally { console.error = quiet; }
    assert.ok(localStorage.getItem(r.rescuedKey));
    S.resetAll(); await S.flush();
    const left = []; for (let i = 0; i < localStorage.length; i++) left.push(localStorage.key(i));
    assert.deepEqual(left.filter((k) => k.startsWith('pitaka.data')), []);
  });
  test('BUG-03: JSON that is not a Pitaka object ([], null, 42) is rescued too', async () => {
    for (const raw of ['[]', 'null', '42', '"hello"']) {
      await v2Phone(raw);
      console.error = () => {};
      let r; try { r = await S.load(); } finally { console.error = quiet; }
      assert.equal(r.reason, 'unreadable', raw); assert.equal(localStorage.getItem(r.rescuedKey), raw);
    }
  });
  test('blocked storage on load: reason blocked, app keeps working in memory and says saves fail', async () => {
    await v2Phone();
    const denied = () => { const e = new Error('denied'); e.name = 'SecurityError'; throw e; };
    const read = store.read;
    store.read = async () => denied();
    localStorage.getItem = denied; localStorage.setItem = denied;
    let r; console.error = () => {};
    try { r = await S.load(); } finally { store.read = read; delete localStorage.getItem; delete localStorage.setItem; console.error = quiet; }
    assert.equal(r.ok, false); assert.equal(r.reason, 'blocked');
    assert.ok(Array.isArray(S.db.debts));
    spend(5);
    await assert.rejects(S.flush(), (e) => e instanceof S.StoreError && e.code === 'blocked');
    assert.equal(S.db.txns.length, 0);
    S.useAdapter(store);
  });
  test('BUG-04: malformed saved data is normalised so the app cannot brick', async () => {
    await v2Phone(JSON.stringify({ version: 1, txns: [{ id: 'a', kind: 'expense', amount: 5 }, { id: 'b', kind: 'expense', amount: 5, date: '2026-10-01' }, { id: 'c', kind: 'weird', amount: 1, date: '2026-10-01' }, { id: 'd', kind: 'income', amount: 'NaN', date: '2026-10-01' }, null, 5],
      debts: null, bills: 'x', goals: [{ id: 'g', name: 'G', target: '100', saved: '5' }], categories: {}, debtHistory: null, settings: 'nope' }));
    assert.equal((await S.load()).ok, true);
    assert.deepEqual(S.db.txns.map((t) => t.id), ['b']);
    assert.deepEqual(S.db.debts, []); assert.deepEqual(S.db.bills, []);
    assert.equal(S.goal('g').target, 100); assert.equal(S.goal('g').saved, 5);
    assert.ok(S.db.categories.length > 0); assert.deepEqual(Object.keys(S.db.debtHistory).length, 1);
    assert.doesNotThrow(() => { S.upcoming('2026-10-22'); S.freeToSpend(); S.monthSummary('2026-10'); S.totalDebt(); });
  });
  test('BUG-01: entries saved without an id (or with a dangerous id) get a fresh safe id on load', async () => {
    await v2Phone(JSON.stringify({ version: 1, txns: [{ kind: 'expense', amount: 5, date: '2026-10-01' }, { kind: 'expense', amount: 6, date: '2026-10-01' },
      { id: '"><img src=y onerror=alert(1)>', kind: 'expense', amount: 7, date: '2026-10-01', categoryId: '<b>' }], debts: [], categories: [{ id: 'x"><', name: 'Food', emoji: '🍜', limit: 0 }] }));
    await S.load();
    assert.equal(S.db.txns.length, 3);
    const ids = S.db.txns.map((t) => t.id);
    assert.equal(new Set(ids).size, 3);
    for (const id of [...ids, ...S.db.categories.map((c) => c.id)]) assert.match(id, /^[\w-]{1,40}$/);
    assert.equal(S.db.txns[2].categoryId, undefined, 'unsafe reference dropped');
  });
  test('A9: strings coerced, unknown debt type normalised, dates validated', async () => {
    fresh();
    await S.replaceAll({ txns: [], debts: [{ id: 'c1', type: 'card', name: 'X', balance: '5000', paymentAmount: '500', nextDue: '2026-10-20' }, { id: 'd1', type: 'gcash-loan', name: 'Y', balance: 100, nextDue: 'tomorrow' }] });
    spend(100, { cardId: 'c1' });
    assert.equal(S.debt('c1').balance, 5100);
    assert.ok(S.DEBT_TYPES[S.debt('d1').type]);
    assert.equal(S.debt('d1').nextDue, null);
    assert.doesNotThrow(() => S.upcoming('2026-10-22'));
  });
  test('__proto__ keys in a backup do not pollute Object.prototype', async () => {
    fresh();
    await S.replaceAll(JSON.parse('{"txns":[],"__proto__":{"polluted":1},"settings":{"__proto__":{"polluted":2}},"debts":[{"id":"q","type":"person","name":"Q","balance":1,"__proto__":{"polluted":3}}]}'));
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf(S.db), Object.prototype);
    S.saveDebt(JSON.parse('{"id":"q","type":"person","name":"Q","balance":1,"__proto__":{"polluted":4}}'));
    assert.equal(({}).polluted, undefined);
    await S.load();
    assert.equal(({}).polluted, undefined);
  });
  test('v1 -> v2 -> v3 migration: one Cash wallet holding every old cash entry; old payments still revert', async () => {
    const cat = { id: 'food', name: 'Food', emoji: '🍜', limit: 0 };
    await v2Phone(JSON.stringify({
      version: 1, settings: { onboarded: true, payAnchor: '2026-10-09', payAmount: 20000, pinHash: 'h', pinSalt: 's', lockAfterSec: 60 },
      categories: [cat],
      debts: [{ id: 'L', type: 'loan', name: 'Loan', balance: 11000, original: 12000, paymentAmount: 1000, frequency: 'monthly', totalPayments: 12, paymentsMade: 1, nextDue: '2026-11-30', dueDay: 30, rate: 0, createdAt: '2026-09-01' },
        { id: 'C', type: 'card', name: 'Card', balance: 900, paymentAmount: 500, plannedPayment: 0, nextDue: '2026-10-20', dueDay: 20 }],
      txns: [
        { id: 't1', kind: 'income', amount: 20000, date: '2026-10-01', createdAt: 1 },
        { id: 't2', kind: 'expense', amount: 300, date: '2026-10-02', categoryId: 'food', createdAt: 2 },
        { id: 't3', kind: 'expense', amount: 900, date: '2026-10-03', categoryId: 'food', cardId: 'C', createdAt: 3 },
        { id: 't4', kind: 'debt', amount: 1000, date: '2026-10-05', debtId: 'L', countsInstallment: true, advanceDue: true, prevDue: '2026-10-31', createdAt: 4 },
      ],
      bills: [], goals: [], debtHistory: { '2026-10-01': 12000 },
    }));
    assert.equal((await S.load()).ok, true);
    assert.equal(S.db.version, 3);
    assert.equal(S.db.accounts.length, 1);
    const [a] = S.db.accounts;
    assert.deepEqual({ name: a.name, kind: a.kind, opening: a.opening, openingDate: a.openingDate }, { name: 'Cash', kind: 'cash', opening: 0, openingDate: '2026-10-01' });
    assert.equal(S.defaultAccountId(), a.id);
    assert.equal(S.db.settings.pinHash, 'h', 'loading your own data keeps the PIN');
    for (const id of ['t1', 't2', 't4']) assert.equal(S.db.txns.find((t) => t.id === id).accountId, a.id);
    assert.equal(S.db.txns.find((t) => t.id === 't3').accountId, undefined);
    assert.equal(S.totalCash(), 20000 - 300 - 1000);
    S.deleteTxn('t4');
    assert.equal(S.debt('L').nextDue, '2026-10-31'); assert.equal(S.debt('L').paymentsMade, 0); assert.equal(S.debt('L').balance, 12000);
    S.deleteTxn('t3');
    assert.equal(S.debt('C').balance, 0);
  });
  test('v1 payments whose debt was deleted by the old app (no debtId) load as orphans and stay editable', async () => {
    await v2Phone(JSON.stringify({ version: 1, txns: [{ id: 'p', kind: 'debt', amount: 500, date: '2026-10-01', countsInstallment: true, advanceDue: true }, { id: 'g', kind: 'goal', amount: 50, date: '2026-10-01' }], debts: [], goals: [] }));
    await S.load();
    assert.equal(S.db.txns[0].orphan, true); assert.equal(S.db.txns[1].orphan, true);
    const t = S.saveTxn({ id: 'p', kind: 'debt', amount: 500, date: '2026-10-01', note: 'old loan' });
    assert.equal(t.note, 'old loan'); assert.equal(t.orphan, true); assert.ok(!('debtId' in t));
  });
  test('save/load round trip is lossless', async () => {
    fresh(); const c = card(); const l = loan(); const b = bill(); const g = goal();
    add({ kind: 'income', amount: 25000 }); pay(l, 2000, 2); payBill(b, 8000, { cardId: c.id }); add({ kind: 'goal', goalId: g.id, amount: 100 });
    S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 50, openingDate: '2026-10-01' });
    S.db.settings.someUiFlag = true; S.save();
    const snap = clone(S.db);
    await S.load();
    assert.deepEqual(clone(S.db), snap);
  });
  test('load() adds today to the debt history once without overwriting', async () => {
    fresh(); card(); S.save();
    setToday('2026-10-15');
    await S.load(); assert.equal(S.db.debtHistory['2026-10-15'], 10000);
    S.db.debtHistory['2026-10-15'] = 1; await S.load();
    assert.equal(S.db.debtHistory['2026-10-15'], 10000);
  });
});

describe('store: backups', () => {
  test('replaceAll rejects non-backups with a plain message', async () => {
    fresh();
    for (const bad of [null, { debts: [] }, 'x', [], 5, { txns: 'no' }]) {
      await assert.rejects(S.replaceAll(bad), (e) => e instanceof S.ValidationError && e.message === "This isn't a Pitaka backup file.");
    }
  });
  test('BUG-11: restoring a backup never brings back a PIN', async () => {
    fresh();
    await S.replaceAll({ txns: [], settings: { pinHash: 'abc', pinSalt: '1', onboarded: true } });
    assert.equal(S.db.settings.pinHash, null); assert.equal(S.db.settings.pinSalt, null);
    assert.equal(S.db.settings.onboarded, true);
    assert.equal((await stored()).core.settings.pinHash, null);
  });
  test('BUG-10: a restore too big for storage leaves memory and storage untouched', async () => {
    fresh(); spend(1); const before = JSON.stringify(await stored()); const db0 = S.db;
    const restore = failWrites();
    try {
      await assert.rejects(S.replaceAll({ txns: [{ id: 'x', kind: 'income', amount: 5, date: '2026-10-01' }] }), (e) => e instanceof S.StoreError);
    } finally { restore(); }
    assert.equal(S.db, db0); assert.equal(S.db.txns.length, 1);
    assert.equal(JSON.stringify(store.dump()), before);
  });
  test('BUG-04: a backup with null/missing collections is normalised', async () => {
    fresh();
    await S.replaceAll({ txns: [], debts: null, bills: 'x' });
    assert.ok(Array.isArray(S.db.debts) && Array.isArray(S.db.bills) && S.db.accounts.length === 1);
  });
  test('exportBackup -> replaceAll round trip keeps all entries (PIN is not exported)', async () => {
    fresh(); const c = card(); const l = loan(); add({ kind: 'income', amount: 25000 }); pay(l, 1000); spend(50, { cardId: c.id });
    S.db.settings.pinHash = 'secret'; S.db.settings.pinSalt = 'salt';
    const json = S.exportBackup();
    assert.equal(typeof json, 'string');
    const data = JSON.parse(json);
    assert.ok(!data.settings.pinHash, 'PIN hash must not leave the phone');
    const before = clone({ txns: S.db.txns, debts: S.db.debts, accounts: S.db.accounts });
    S.resetAll();
    await S.replaceAll(data);
    assert.deepEqual(clone({ txns: S.db.txns, debts: S.db.debts, accounts: S.db.accounts }), before);
  });
  test('backupStatus: nothing to back up on a fresh phone', () => {
    fresh();
    assert.deepEqual(S.backupStatus(), { due: false, daysSince: null, newEntries: 0 });
  });
  test('backupStatus: due 14 days after the first entry when never backed up', () => {
    fresh(); spend(5);
    assert.equal(S.backupStatus().due, false);
    setToday('2026-10-27');
    assert.equal(S.backupStatus().due, true);
    assert.equal(S.backupStatus().daysSince, null);
  });
  test('backupStatus / markBackedUp: due after 14 days or 40 new entries', () => {
    fresh(); spend(5);
    S.markBackedUp();
    assert.match(S.db.settings.lastBackupAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(S.db.settings.entriesAtBackup, 1);
    assert.deepEqual(S.backupStatus(), { due: false, daysSince: 0, newEntries: 0 });
    mock.timers.setTime(Date.now() + 60000);
    for (let i = 0; i < 39; i++) spend(1);
    assert.deepEqual(S.backupStatus(), { due: false, daysSince: 0, newEntries: 39 });
    spend(1);
    assert.equal(S.backupStatus().due, true); assert.equal(S.backupStatus().newEntries, 40);
    S.markBackedUp();
    setToday('2026-10-26'); assert.equal(S.backupStatus().due, false);
    setToday('2026-10-27'); assert.deepEqual(S.backupStatus(), { due: true, daysSince: 14, newEntries: 0 });
  });
});

// =================================================================================================
describe('store: settings', () => {
  test('updateSettings type-checks known keys and keeps simple UI preferences', async () => {
    fresh();
    S.updateSettings({ pinFails: 2, payAnchor: 'nope', onboarded: true, theme: 'dark', __proto__: { polluted: 1 } });
    assert.equal(S.db.settings.pinFails, 2); assert.equal(S.db.settings.payAnchor, '2026-10-09');
    assert.equal(S.db.settings.onboarded, true); assert.equal(S.db.settings.theme, 'dark');
    assert.equal(({}).polluted, undefined);
    assert.equal((await stored()).core.settings.pinFails, 2);
  });
});

describe('store: wallets', () => {
  test('a new phone has one Cash wallet that is the default and counts every entry', () => {
    fresh();
    assert.equal(S.db.accounts.length, 1);
    assert.equal(S.db.accounts[0].openingDate, null);
    add({ kind: 'income', amount: 100, date: '2025-01-01' });
    assert.equal(S.totalCash(), 100);
    assert.equal(S.db.accounts[0].name, 'Cash'); assert.equal(S.db.accounts[0].kind, 'cash');
    assert.equal(S.defaultAccountId(), S.db.accounts[0].id);
    assert.equal(S.account(S.defaultAccountId()).name, 'Cash');
  });
  test('balances follow income, spending, payments, goals and transfers', () => {
    fresh(); const c = card(); const l = loan(); const g = goal();
    const cash = cashId();
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 1200, openingDate: '2026-10-13' });
    assert.match(gc.id, /^[\w-]+$/);
    assert.equal(S.accountBalance(gc.id), 1200);
    add({ kind: 'income', amount: 20000 });                         // default wallet
    spend(300, { accountId: gc.id });
    spend(900, { cardId: c.id });                                   // not cash
    pay(l, 1000, 1, { accountId: cash });
    add({ kind: 'goal', goalId: g.id, amount: 500 });
    add({ kind: 'goal', goalId: g.id, amount: 200, withdraw: true });
    add({ kind: 'transfer', accountId: cash, toAccountId: gc.id, amount: 1000 });
    add({ kind: 'adjust', debtId: l.id, direction: 'up', reason: 'fee', amount: 50 }); // not cash
    assert.equal(S.accountBalance(cash), 20000 - 1000 - 500 + 200 - 1000);
    assert.equal(S.accountBalance(gc.id), 1200 - 300 + 1000);
    assert.equal(S.totalCash(), 17700 + 1900);
  });
  test('entries dated before the opening date are already in the opening balance', () => {
    fresh();
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 1000, openingDate: '2026-10-13' });
    spend(100, { accountId: gc.id, date: '2026-10-10' });
    spend(50, { accountId: gc.id, date: '2026-10-13' });
    assert.equal(S.accountBalance(gc.id), 950);
  });
  test('saveAccount validates and edits in place', () => {
    fresh();
    throwsValidation(() => S.saveAccount({ name: '  ', kind: 'cash', opening: 0 }), 'name');
    throwsValidation(() => S.saveAccount({ name: 'X', kind: 'cash', opening: NaN }), 'opening');
    const a = S.saveAccount({ name: 'BPI', kind: 'bank' });
    assert.equal(a.opening, 0); assert.equal(a.openingDate, '2026-10-13');
    setToday('2026-10-20');
    const b = S.saveAccount({ id: a.id, name: 'BPI Savings', kind: 'bank', opening: 5000 });
    assert.equal(b.openingDate, '2026-10-13', 'editing keeps the opening date');
    assert.equal(b, S.account(a.id)); assert.equal(S.account(a.id).name, 'BPI Savings'); assert.equal(S.accountBalance(a.id), 5000);
    assert.equal(S.saveAccount({ name: 'Weird', kind: 'crypto' }).kind, 'cash');
  });
  test('"Balance now" correction by moving the opening amount lands exactly on the target (default wallet too)', () => {
    fresh();
    add({ kind: 'income', amount: 20000, date: '2026-10-01' }); spend(1234.5);
    const setWalletBalance = (a, target) => S.saveAccount({ ...a, opening: U.round2(a.opening + U.round2(target - S.accountBalance(a.id))) }); // as in ui-sheets.js
    setWalletBalance(S.account(cashId()), 15000);
    assert.equal(S.accountBalance(cashId()), 15000);
    assert.equal(S.account(cashId()).openingDate, null);
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 300, openingDate: '2026-10-13' });
    spend(50, { accountId: gc.id });
    setWalletBalance(S.account(gc.id), 1000);
    assert.equal(S.accountBalance(gc.id), 1000);
  });
  test('deleteAccount refuses a wallet with entries or the last wallet; moves the default', () => {
    fresh();
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet' });
    const t = spend(5, { accountId: gc.id });
    throwsValidation(() => S.deleteAccount(gc.id));
    S.deleteTxn(t.id);
    S.saveTxn({ kind: 'transfer', accountId: cashId(), toAccountId: gc.id, amount: 5, date: '2026-10-13' });
    throwsValidation(() => S.deleteAccount(gc.id));
    S.db.txns.length = 0; S.save();
    const cash = cashId();
    S.deleteAccount(cash);
    assert.equal(S.defaultAccountId(), gc.id);
    throwsValidation(() => S.deleteAccount(gc.id));
  });
  test('transfers need two different wallets', () => {
    fresh();
    const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet' });
    throwsValidation(() => add({ kind: 'transfer', accountId: gc.id, toAccountId: gc.id, amount: 100 }));
    throwsValidation(() => add({ kind: 'transfer', accountId: gc.id, amount: 100 }));
    throwsValidation(() => add({ kind: 'transfer', accountId: gc.id, toAccountId: 'nope', amount: 100 }));
  });
});

// =================================================================================================
describe('store: debts', () => {
  test('zero or negative balance -> 0 payments left, no payoff date', () => {
    fresh();
    const c = card({ balance: 0 });
    assert.equal(S.paymentsLeft(c), 0); assert.equal(S.payoffDate(c), null);
    assert.equal(S.paymentsLeft(card({ balance: -150 })), 0);
  });
  test('scheduled types count total - made', () => {
    fresh();
    for (const type of ['loan', 'installment', 'lending']) assert.equal(S.paymentsLeft(loan({ type, totalPayments: 12, paymentsMade: 4, balance: 8000 })), 8, type);
  });
  test('card: 0% interest, amortization matches a simulation, below-interest never pays off', () => {
    fresh();
    assert.equal(S.paymentsLeft(card({ rate: 0, balance: 10000, plannedPayment: 3000 })), 4);
    for (const [bal, rate, p] of [[50000, 3, 2000], [10000, 3, 2000], [120000, 2, 5000], [8000, 3.5, 1000], [25000, 1, 25250], [100, 3, 50]]) {
      assert.equal(S.paymentsLeft(card({ balance: bal, rate, plannedPayment: p })), simulateCard(bal, rate, p), `${bal}@${rate}% paying ${p}`);
    }
    assert.equal(S.paymentsLeft(card({ balance: 50000, rate: 3, plannedPayment: 1500 })), Infinity);
    assert.equal(S.payoffDate(card({ balance: 50000, rate: 3, plannedPayment: 1000 })), null);
    assert.equal(S.paymentsLeft(card({ rate: 0, balance: 1000, plannedPayment: 0, paymentAmount: 500 })), 2);
    assert.equal(S.paymentsLeft(card({ rate: 0, balance: 1000, plannedPayment: 0, paymentAmount: 0 })), null);
  });
  test('person debt uses planned payment', () => {
    fresh();
    assert.equal(S.paymentsLeft(person({ balance: 2500, plannedPayment: 1000 })), 3);
    assert.equal(S.paymentsLeft(person({ balance: 2500, plannedPayment: 0 })), null);
  });
  test('payoffDate: monthly 31st, semimonthly, biweekly, once, card', () => {
    fresh();
    assert.equal(S.payoffDate(loan({ nextDue: '2027-01-31', totalPayments: 3, balance: 3000 })), '2027-03-31');
    assert.equal(S.payoffDate(loan({ frequency: 'semimonthly', nextDue: '2026-10-15', totalPayments: 3, balance: 3000 })), '2026-11-15');
    assert.equal(S.payoffDate(loan({ frequency: 'semimonthly', dueDays: [5, 20], nextDue: '2026-10-20', totalPayments: 3, balance: 3000 })), '2026-11-20');
    assert.equal(S.payoffDate(loan({ frequency: 'biweekly', nextDue: '2026-10-16', totalPayments: 3, balance: 3000 })), '2026-11-13');
    assert.equal(S.payoffDate(loan({ type: 'lending', frequency: 'once', nextDue: '2026-10-20', totalPayments: 1, paymentAmount: 1500, balance: 1500 })), '2026-10-20');
    assert.equal(S.payoffDate(card({ rate: 0, balance: 6000, plannedPayment: 2000, nextDue: '2026-10-20' })), '2026-12-20');
  });
  test('A3/BUG-22: a scheduled debt with balance left after the last installment still has payments left', () => {
    fresh();
    const d = loan({ type: 'lending', totalPayments: 4, paymentsMade: 4, balance: 450 });
    assert.ok(S.paymentsLeft(d) >= 1); assert.notEqual(S.payoffDate(d), null);
    const e = loan({ totalPayments: 12, paymentsMade: 10, balance: 5000, paymentAmount: 1000 });
    assert.equal(S.paymentsLeft(e), 5, 'penalties pushed the balance past the schedule');
  });
  test('person debt with a planned payment but no due date is estimated monthly from today', () => {
    fresh();
    // 3 payments of ₱1,000, the first a month from "today" (2026-10-13).
    assert.equal(S.payoffDate(person({ balance: 3000, plannedPayment: 1000, nextDue: null })), '2027-01-13');
    assert.equal(S.payoffDate(person({ balance: 3000, plannedPayment: 0, nextDue: null })), null);
  });
  test('totalDebt ignores overpaid balances and has no float noise', () => {
    fresh();
    card({ balance: 0.1 }); card({ balance: 0.2 }); card({ balance: -500 });
    assert.equal(S.totalDebt(), 0.3);
  });
  test('monthlyObligations by type and frequency', () => {
    fresh();
    card({ plannedPayment: 2000, paymentAmount: 500 });
    card({ plannedPayment: 0, paymentAmount: 500 });
    person({ plannedPayment: 1000 });
    loan({ paymentAmount: 1000, frequency: 'weekly' });
    loan({ paymentAmount: 1000, frequency: 'semimonthly' });
    loan({ paymentAmount: 3000, frequency: 'quarterly', totalPayments: 4, balance: 12000 });
    loan({ paymentAmount: 999, frequency: 'monthly', balance: 0 });
    assert.equal(S.monthlyObligations(), U.round2(2000 + 500 + 1000 + 4333.333333 + 2000 + 1000));
  });
  test('P3: a one-time lending loan due within a month counts in monthlyObligations; later ones do not', () => {
    fresh();
    loan({ type: 'lending', frequency: 'once', totalPayments: 1, paymentAmount: 1500, balance: 1500, nextDue: '2026-10-20' });
    loan({ type: 'lending', frequency: 'once', totalPayments: 1, paymentAmount: 9000, balance: 9000, nextDue: '2027-03-01' });
    assert.equal(S.monthlyObligations(), 1500);
  });
  test('BUG-16: saveDebt rejects bad input with field names', () => {
    fresh();
    throwsValidation(() => person({ balance: -5000 }), 'balance');
    throwsValidation(() => person({ balance: NaN }), 'balance');
    throwsValidation(() => person({ name: '   ' }), 'name');
    throwsValidation(() => loan({ paymentAmount: -1000 }), 'paymentAmount');
    throwsValidation(() => loan({ totalPayments: -12 }), 'totalPayments');
    throwsValidation(() => loan({ totalPayments: 0 }), 'totalPayments');
    throwsValidation(() => loan({ totalPayments: 12, paymentsMade: 13 }), 'paymentsMade');
    throwsValidation(() => loan({ frequency: 'daily' }), 'frequency');
    throwsValidation(() => loan({ nextDue: '2026-02-31' }), 'nextDue');
    throwsValidation(() => S.saveDebt({ type: 'mystery', name: 'X', balance: 1 }), 'type');
    throwsValidation(() => card({ rate: -1 }), 'rate');
    throwsValidation(() => loan({ frequency: 'semimonthly', dueDays: [0, 40] }), 'dueDays');
    assert.equal(S.db.debts.length, 0);
  });
  test('BUG-01: saveDebt/saveBill/saveGoal/saveCategory with id: undefined still get an id', () => {
    fresh();
    assert.ok(person({ id: undefined }).id);
    assert.ok(bill({ id: undefined }).id);
    assert.ok(goal({ id: '' }).id);
    assert.ok(S.saveCategory({ id: undefined, name: 'Pets', emoji: '🐶', limit: 0 }).id);
  });
  test('semimonthly debts default to the 15th & end of month; custom due days are kept', () => {
    fresh();
    assert.deepEqual(loan({ frequency: 'semimonthly', nextDue: '2026-10-15' }).dueDays, [15, 31]);
    const d = loan({ type: 'lending', frequency: 'semimonthly', dueDays: [20, 5], nextDue: '2026-10-20' });
    assert.deepEqual(d.dueDays, [5, 20]);
    assert.equal(loan({ frequency: 'monthly', dueDays: [5, 20] }).dueDays, undefined);
    pay(d, 1000); assert.equal(d.nextDue, '2026-11-05');
    pay(d, 1000); assert.equal(d.nextDue, '2026-11-20');
  });
  test('BUG-13/A8: editing a debt after a month-end advance keeps the intended due day (31st)', () => {
    fresh({ today: '2027-01-20' }); const d = loan({ nextDue: '2027-01-31' });
    pay(d, 1000); assert.equal(d.nextDue, '2027-02-28');
    resaveDebt(d);
    pay(d, 1000);
    assert.equal(d.nextDue, '2027-03-31');
  });
  test('A8: choosing a new due date does update the due day', () => {
    fresh(); const d = loan({ nextDue: '2026-10-31' });
    S.saveDebt({ ...clone(d), nextDue: '2026-11-05' });
    assert.equal(d.dueDay, 5);
    pay(d, 1000); assert.equal(d.nextDue, '2026-12-05');
  });
  test('BUG-13: editing a bill after a month-end advance keeps the intended due day (31st)', () => {
    fresh({ today: '2027-01-20' }); const b = bill({ nextDue: '2027-01-31' });
    payBill(b); assert.equal(b.nextDue, '2027-02-28');
    S.saveBill({ id: b.id, name: b.name, amount: b.amount, frequency: b.frequency, nextDue: b.nextDue, categoryId: b.categoryId, done: false });
    payBill(b);
    assert.equal(b.nextDue, '2027-03-31');
  });
  test('BUG-17: correcting a mistyped balance (no payments yet) resets "% paid off"', () => {
    fresh(); const p = person({ balance: 1000000 });
    S.saveDebt({ ...clone(p), balance: 10000 });
    assert.equal(p.original, 10000);
    pay(p, 2000, 0);
    S.saveDebt({ ...clone(p), balance: 7500 }); // corrected again, with ₱2,000 already paid
    assert.equal(p.original, 9500);
    const l = loan({ paymentsMade: 4, balance: 8000 });
    assert.equal(l.original, 12000, 'scheduled debts start from payment × total');
  });
  test('suggestInstallments', () => {
    fresh(); const l = loan(); const c = card(); const p = person({ nextDue: '2026-10-30' });
    assert.equal(S.suggestInstallments(l.id, 999), 0);
    assert.equal(S.suggestInstallments(l.id, 1000), 1);
    assert.equal(S.suggestInstallments(l.id, 3500), 3);
    assert.equal(S.suggestInstallments(l.id, 12000), 12);
    assert.equal(S.suggestInstallments(l.id, 1e6), 12, 'capped at payments left');
    assert.equal(S.suggestInstallments(c.id, 200), 0, 'below the minimum due');
    assert.equal(S.suggestInstallments(c.id, 5000), 1, 'a card statement is paid once a month');
    assert.equal(S.suggestInstallments(p.id, 2500), 2);
    assert.equal(S.suggestInstallments('nope', 2500), 0);
  });
  test('debtActivity lists payments, adjustments and card charges newest first', () => {
    fresh(); const c = card(); const l = loan();
    const a = spend(100, { cardId: c.id, date: '2026-10-01' });
    const b = pay(c, 2000, 1, { date: '2026-10-10' });
    const x = add({ kind: 'adjust', debtId: c.id, direction: 'up', reason: 'interest', amount: 300, date: '2026-10-05' });
    pay(l, 1000); spend(5);
    assert.deepEqual(S.debtActivity(c.id).map((t) => t.id), [b.id, x.id, a.id]);
  });
  test('deleteDebt snapshots the new total', () => {
    fresh(); const a = card(); card({ balance: 500 });
    S.deleteDebt(a.id);
    assert.equal(S.db.debtHistory['2026-10-13'], 500);
  });
});

// =================================================================================================
describe('store: transactions — create and validate', () => {
  test('BUG-01: id undefined or empty never overwrites the generated id', () => {
    fresh();
    const a = S.saveTxn({ id: undefined, kind: 'expense', amount: 150, date: '2026-10-13' });
    const b = S.saveTxn({ id: '', kind: 'expense', amount: 150, date: '2026-10-13' });
    assert.ok(a.id && b.id && a.id !== b.id);
    assert.deepEqual(S.db.txns.map((t) => t.id), [a.id, b.id]);
    assert.equal(typeof a.createdAt, 'number');
  });
  test('BUG-16/23: amount must be a finite number > 0 and ≤ 1e9', () => {
    fresh();
    for (const amount of [0, -5, NaN, Infinity, 'abc', 1e9 + 1, 0.001, undefined]) throwsValidation(() => spend(amount), 'amount');
    assert.equal(spend(1e9).amount, 1e9);
    assert.equal(spend(10.005 + 0.0001).amount, 10.01);
    assert.equal(S.db.txns.length, 2);
  });
  test('kind, date and links are validated', () => {
    fresh(); const l = loan();
    throwsValidation(() => add({ kind: 'gift', amount: 5 }), 'kind');
    throwsValidation(() => spend(5, { date: '2026-13-45' }), 'date');
    throwsValidation(() => add({ kind: 'debt', amount: 5 }), 'debtId');
    throwsValidation(() => add({ kind: 'debt', debtId: 'nope', amount: 5 }), 'debtId');
    throwsValidation(() => add({ kind: 'goal', amount: 5 }), 'goalId');
    throwsValidation(() => spend(5, { cardId: l.id }), 'cardId');
    throwsValidation(() => spend(5, { accountId: 'nope' }), 'accountId');
    throwsValidation(() => add({ kind: 'adjust', debtId: l.id, amount: 5 }), 'direction');
  });
  test('BUG-14: paying more than the balance is refused with a plain message', () => {
    fresh(); const p = person({ name: 'GLoan', balance: 7480 });
    assert.throws(() => pay(p, 8000, 0), (e) => e instanceof S.ValidationError && e.field === 'amount' && e.message.includes('₱7,480') && e.message.includes('GLoan'));
    const t = pay(p, 7480, 0);
    assert.equal(p.balance, 0);
    edit(t.id, { amount: 7000 }); // editing within the old amount is fine
    assert.equal(p.balance, 480);
    throwsValidation(() => edit(t.id, { amount: 7481 }), 'amount');
  });
  test('BUG-15: taking more out of a goal than it holds is refused', () => {
    fresh(); const g = goal({ saved: 1000 });
    throwsValidation(() => add({ kind: 'goal', goalId: g.id, amount: 5000, withdraw: true }), 'amount');
    const w = add({ kind: 'goal', goalId: g.id, amount: 700, withdraw: true });
    assert.equal(g.saved, 300);
    edit(w.id, { amount: 1000 }); assert.equal(g.saved, 0);
    throwsValidation(() => edit(w.id, { amount: 1001 }), 'amount');
  });
  test('fields that do not belong to the kind are ignored', () => {
    fresh(); const c = card();
    const t = add({ kind: 'income', amount: 100, cardId: c.id, debtId: c.id, junk: '<script>', fx: { card: { id: c.id, amount: 1e6 } } });
    assert.equal(c.balance, 10000);
    assert.equal(t.junk, undefined); assert.equal(t.cardId, undefined);
    assert.equal(t.accountId, cashId());
  });
});

describe('store: transaction side effects apply/revert symmetrically', () => {
  test('plain expense and income change no debt/bill/goal', () => {
    fresh(); const c = card(); const before = state();
    const a = spend(150); const b = add({ kind: 'income', amount: 25000, note: 'Salary' });
    assert.deepEqual(state(), before);
    S.deleteTxn(a.id); S.deleteTxn(b.id);
    assert.deepEqual(state(), before); assert.equal(S.db.txns.length, 0); assert.equal(c.balance, 10000);
  });
  test('card expense adds to card balance; delete restores', () => {
    fresh(); const c = card();
    const t = spend(1234.56, { cardId: c.id });
    assert.equal(c.balance, 11234.56);
    S.deleteTxn(t.id);
    assert.equal(c.balance, 10000);
  });
  test('scheduled loan payment: balance, paymentsMade, nextDue; delete restores all', () => {
    fresh(); const d = loan(); const before = state();
    const t = pay(d, 1000);
    assert.equal(d.balance, 11000); assert.equal(d.paymentsMade, 1); assert.equal(d.nextDue, '2026-11-30');
    S.deleteTxn(t.id);
    assert.deepEqual(state(), before);
  });
  test('installments 0 = extra payment: changes only the balance', () => {
    fresh(); const d = loan();
    pay(d, 500, 0);
    assert.equal(d.balance, 11500); assert.equal(d.paymentsMade, 0); assert.equal(d.nextDue, '2026-10-31');
  });
  test('A4: paying 3 installments in one go counts 3 and moves the due date 3 times', () => {
    fresh(); const d = loan(); const before = state();
    const t = pay(d, 3000, 3);
    assert.equal(d.balance, 9000); assert.equal(d.paymentsMade, 3); assert.equal(S.paymentsLeft(d), 9);
    assert.equal(d.nextDue, '2027-01-31');
    S.deleteTxn(t.id);
    assert.deepEqual(state(), before);
  });
  test('installments left out -> the suggested number is used', () => {
    fresh(); const d = loan();
    const t = add({ kind: 'debt', debtId: d.id, amount: 2000 });
    assert.equal(t.installments, 2); assert.equal(d.paymentsMade, 2);
  });
  test('card scheduled payment advances due monthly; person payment without due date', () => {
    fresh(); const c = card(); const p = person();
    pay(c, 2000); pay(p, 1000);
    assert.equal(c.balance, 8000); assert.equal(c.nextDue, '2026-11-20');
    assert.equal(p.balance, 4000); assert.equal(p.nextDue, null);
  });
  test('"once" lending app: payment keeps the due date, paid off at 0; delete restores', () => {
    fresh(); const d = loan({ type: 'lending', frequency: 'once', totalPayments: 1, balance: 1500, paymentAmount: 1500, nextDue: '2026-10-20' });
    const t = pay(d, 1500);
    assert.equal(d.balance, 0); assert.equal(d.nextDue, '2026-10-20'); assert.equal(S.debtStatus(d), 'paid');
    S.deleteTxn(t.id); assert.equal(d.balance, 1500); assert.equal(d.paymentsMade, 0);
  });
  test('goal deposit and withdrawal; delete restores', () => {
    fresh(); const g = goal({ saved: 1000 });
    const a = add({ kind: 'goal', goalId: g.id, amount: 2500, withdraw: false });
    const b = add({ kind: 'goal', goalId: g.id, amount: 700, withdraw: true });
    assert.equal(g.saved, 2800);
    S.deleteTxn(a.id); assert.equal(g.saved, 300);
    S.deleteTxn(b.id); assert.equal(g.saved, 1000);
  });
  test('bill payment advances the bill; delete restores; one-time bill toggles done', () => {
    fresh(); const b = bill(); const once = bill({ name: 'Passport', frequency: 'once', nextDue: '2026-10-20', amount: 950 });
    const t = payBill(b); const u = payBill(once);
    assert.equal(b.nextDue, '2026-11-30'); assert.equal(once.done, true);
    S.deleteTxn(t.id); S.deleteTxn(u.id);
    assert.equal(b.nextDue, '2026-10-31'); assert.equal(once.done, false); assert.equal(once.nextDue, '2026-10-20');
  });
  test('bill paid with a credit card: bill advances AND card balance grows', () => {
    fresh(); const c = card(); const b = bill({ name: 'Meralco', amount: 3200.5 });
    const t = payBill(b, 3200.5, { cardId: c.id });
    assert.equal(c.balance, 13200.5); assert.equal(b.nextDue, '2026-11-30');
    S.deleteTxn(t.id); assert.equal(c.balance, 10000); assert.equal(b.nextDue, '2026-10-31');
  });
  test('debt adjustments change only the balance', () => {
    fresh(); const l = loan(); const before = clone(l);
    const up = add({ kind: 'adjust', debtId: l.id, direction: 'up', reason: 'penalty', amount: 500 });
    const down = add({ kind: 'adjust', debtId: l.id, direction: 'down', reason: 'correction', amount: 200 });
    assert.equal(l.balance, 12300); assert.equal(l.paymentsMade, 0); assert.equal(l.nextDue, '2026-10-31');
    assert.equal(S.totalCash(), 0);
    throwsValidation(() => add({ kind: 'adjust', debtId: l.id, direction: 'down', reason: 'correction', amount: 20000 }), 'amount');
    S.deleteTxn(up.id); S.deleteTxn(down.id);
    assert.deepEqual(clone(l), before);
    assert.equal(add({ kind: 'adjust', debtId: l.id, direction: 'up', amount: 1 }).reason, 'correction');
  });

  // ---- edits ----
  test('edit amount of a card expense applies only the difference', () => {
    fresh(); const c = card();
    const t = spend(1000, { cardId: c.id });
    edit(t.id, { amount: 250 });
    assert.equal(c.balance, 10250);
  });
  test('edit: move expense from card A to card B', () => {
    fresh(); const a = card({ name: 'A' }); const b = card({ name: 'B' });
    const t = spend(1000, { cardId: a.id });
    edit(t.id, { cardId: b.id });
    assert.equal(a.balance, 10000); assert.equal(b.balance, 11000);
  });
  test('A1 (P0): edit a card expense to a wallet removes the charge from the card', () => {
    fresh(); const c = card();
    const t = spend(1000, { cardId: c.id });
    assert.equal(c.balance, 11000);
    edit(t.id, { cardId: '' });
    assert.equal(c.balance, 10000, 'card still carries the ₱1,000 charge');
    assert.equal(S.db.txns[0].accountId, cashId());
    assert.equal(S.totalCash(), -1000);
  });
  test('A1: revert uses the OLD effect record even when the stored fields were changed by hand', () => {
    fresh(); const c = card(); const d = card({ name: 'Other' });
    const t = spend(1000, { cardId: c.id });
    t.cardId = d.id; t.amount = 5; // stale/corrupted fields must not decide what gets undone
    S.deleteTxn(t.id);
    assert.equal(c.balance, 10000); assert.equal(d.balance, 10000);
  });
  test('edit: move a payment from debt A to debt B', () => {
    fresh(); const a = loan({ name: 'A' }); const b = loan({ name: 'B', nextDue: '2026-10-25' });
    const t = pay(a, 1000);
    edit(t.id, { debtId: b.id });
    assert.equal(a.balance, 12000); assert.equal(a.paymentsMade, 0); assert.equal(a.nextDue, '2026-10-31');
    assert.equal(b.balance, 11000); assert.equal(b.paymentsMade, 1); assert.equal(b.nextDue, '2026-11-25');
  });
  test('edit: installments 1 -> 0 un-counts the payment and restores the due date', () => {
    fresh(); const d = loan();
    const t = pay(d, 1000);
    edit(t.id, { installments: 0 });
    assert.equal(d.paymentsMade, 0); assert.equal(d.nextDue, '2026-10-31'); assert.equal(d.balance, 11000);
  });
  test('edit: change kind debt payment -> expense restores the debt', () => {
    fresh(); const d = loan(); const before = clone(d);
    const t = pay(d, 1000);
    S.saveTxn({ id: t.id, kind: 'expense', categoryId: S.db.categories[0].id, amount: 1000, date: '2026-10-13' });
    assert.deepEqual(clone(d), before);
    assert.equal(S.db.txns[0].debtId, undefined);
  });
  test('edit: goal deposit -> withdrawal', () => {
    fresh(); const g = goal({ saved: 5000 });
    const t = add({ kind: 'goal', goalId: g.id, amount: 1000, withdraw: false });
    edit(t.id, { withdraw: true });
    assert.equal(g.saved, 4000);
  });
  test('repeated no-op edits are idempotent', () => {
    fresh(); const d = loan(); const b = bill(); const c = card();
    const t1 = pay(d, 1000); const t2 = payBill(b); const t3 = spend(99.99, { cardId: c.id });
    const snap = state();
    for (let i = 0; i < 5; i++) { edit(t1.id); edit(t2.id); edit(t3.id); }
    assert.deepEqual(state(), snap);
  });
  test('BUG-07/A2: editing an OLDER bill payment must not roll the due date back', () => {
    fresh(); const b = bill();
    const oct = payBill(b); payBill(b, 8000, { date: '2026-11-28' });
    assert.equal(b.nextDue, '2026-12-31');
    edit(oct.id, { amount: 8500 });
    assert.equal(b.nextDue, '2026-12-31');
  });
  test('BUG-07/A2: editing an OLDER debt payment must not roll the due date back', () => {
    fresh(); const d = loan();
    const p1 = pay(d, 1000); pay(d, 1000, 1, { date: '2026-11-28' });
    assert.equal(d.nextDue, '2026-12-31');
    edit(p1.id, { amount: 1100 });
    assert.equal(d.nextDue, '2026-12-31'); assert.equal(d.paymentsMade, 2); assert.equal(d.balance, 9900);
  });
  test('BUG-07: deleting bill payments oldest-first restores the right due dates', () => {
    fresh(); const b = bill();
    const oct = payBill(b); const nov = payBill(b, 8000, { date: '2026-11-28' });
    S.deleteTxn(oct.id); assert.equal(b.nextDue, '2026-11-30');
    S.deleteTxn(nov.id); assert.equal(b.nextDue, '2026-10-31');
  });
  test('BUG-07: deleting debt payments oldest-first restores the original due date', () => {
    fresh(); const d = loan(); const before = clone(d);
    const p1 = pay(d, 1000); const p2 = pay(d, 1000); const p3 = pay(d, 1000);
    S.deleteTxn(p1.id); assert.equal(d.nextDue, '2026-12-31', 'two payments left -> two steps after Oct 31');
    S.deleteTxn(p2.id); S.deleteTxn(p3.id);
    assert.deepEqual(clone(d), before);
  });
  test('A7: moving a scheduled payment to a debt with no due date, then deleting it, must not invent a due date', () => {
    fresh(); const a = loan({ name: 'A' }); const p = person({ nextDue: null });
    const t = pay(a, 1000);
    edit(t.id, { debtId: p.id });
    S.deleteTxn(t.id);
    assert.equal(p.nextDue, null); assert.equal(a.nextDue, '2026-10-31');
  });
  test('BUG-07 (property): for every frequency, payments edited then deleted in shuffled order restore the debt and bill exactly', () => {
    let seed = 42; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cases = [['weekly', '2026-10-14'], ['biweekly', '2026-10-16'], ['semimonthly', '2026-10-15'], ['semimonthly', '2026-10-31'],
      ['semimonthly', '2026-10-20', [5, 20]], ['monthly', '2026-10-31'], ['monthly', '2027-01-29'], ['quarterly', '2026-11-30'], ['yearly', '2028-02-29']];
    for (const [freq, start, dueDays] of cases) {
      fresh(); const d = loan({ frequency: freq, dueDays, nextDue: start, totalPayments: 20, balance: 20000 }); const b = bill({ frequency: freq, dueDays, nextDue: start, amount: 500 });
      const d0 = clone(d), b0 = clone(b);
      const ids = [];
      for (let i = 0; i < 6; i++) { ids.push(pay(d, i === 2 ? 2000 : 1000, i === 2 ? 2 : 1).id); ids.push(payBill(b).id); }
      const after = { d: d.nextDue, b: b.nextDue };
      const order = [...ids].sort(() => rnd() - 0.5);
      for (const id of order) edit(id, { note: 'typo fixed' });
      assert.deepEqual({ d: d.nextDue, b: b.nextDue }, after, `${freq} from ${start}: no-op edits moved due dates`);
      for (const id of order) S.deleteTxn(id);
      assert.deepEqual(clone(d), d0, `${freq} from ${start}: debt not restored (nextDue ${d.nextDue})`);
      assert.deepEqual(clone(b), b0, `${freq} from ${start}: bill not restored (nextDue ${b.nextDue})`);
    }
  });
  test('BUG-21: changing a debt\'s type between payment and delete keeps paymentsMade symmetric', () => {
    fresh(); const d = loan({ paymentsMade: 2, balance: 10000 });
    const t = pay(d, 1000); assert.equal(d.paymentsMade, 3);
    S.saveDebt({ ...clone(d), type: 'card', creditLimit: 0, plannedPayment: 1000 });
    S.deleteTxn(t.id);
    S.saveDebt({ ...clone(d), type: 'loan' });
    assert.equal(d.paymentsMade, 2);
  });
  test('BUG-08: deleting a debt keeps its entries as orphans; editing one never moves money to another debt', () => {
    fresh(); const old = loan({ name: 'OldLoan' }); const c = card();
    const t = pay(old, 1000); const e = spend(10, { cardId: c.id });
    S.deleteDebt(old.id);
    const orphan = S.db.txns.find((x) => x.id === t.id);
    assert.equal(orphan.orphan, true); assert.equal(orphan.debtName, 'OldLoan'); assert.equal(orphan.debtId, old.id);
    S.saveTxn({ id: t.id, kind: 'debt', debtId: c.id, amount: 1000, date: '2026-10-13', note: 'typo fixed', installments: 1 });
    assert.equal(c.balance, 10010, 'card untouched'); assert.equal(c.nextDue, '2026-10-20');
    assert.equal(S.db.txns.find((x) => x.id === t.id).note, 'typo fixed');
    S.deleteDebt(c.id);
    assert.equal(S.db.txns.find((x) => x.id === e.id).orphan, true);
    assert.equal(S.db.txns.length, 2);
    assert.doesNotThrow(() => { S.deleteTxn(t.id); S.deleteTxn(e.id); });
  });
  test('BUG-08: deleting a goal keeps its deposits; editing one never moves money into another goal', () => {
    fresh(); const japan = goal(); const emergency = goal({ name: 'Emergency' });
    const t = add({ kind: 'goal', goalId: japan.id, amount: 5000 });
    S.deleteGoal(japan.id);
    const orphan = S.db.txns[0];
    assert.equal(orphan.orphan, true); assert.equal(orphan.goalName, 'Japan');
    S.saveTxn({ id: t.id, kind: 'goal', goalId: emergency.id, amount: 5000, date: '2026-10-13', note: 'x' });
    assert.equal(emergency.saved, 0);
  });
  test('deleteTxn returns a deep copy for Undo; restoreTxn re-applies it', () => {
    fresh(); const d = loan(); const before = state();
    const t = pay(d, 2000, 2);
    const after = state();
    const copy = S.deleteTxn(t.id);
    assert.deepEqual(state(), before);
    assert.equal(copy.id, t.id); assert.equal(copy.amount, 2000);
    copy.note = 'changed'; // a copy, not the stored object
    assert.equal(S.db.txns.length, 0);
    const back = S.restoreTxn(copy);
    assert.equal(back.id, t.id);
    assert.deepEqual(state(), after);
    assert.equal(S.deleteTxn('missing'), null);
  });
  test('restoreTxn of an orphan brings back the entry without touching anything', () => {
    fresh(); const d = loan(); const t = pay(d, 1000);
    S.deleteDebt(d.id);
    const copy = S.deleteTxn(t.id);
    const back = S.restoreTxn(copy);
    assert.equal(back.orphan, true); assert.equal(S.db.txns.length, 1);
  });
  test('a payment saved in the old format (prevDue, no effect record) still reverts', () => {
    fresh(); const d = loan(); const b = bill();
    const t = pay(d, 1000); const u = payBill(b);
    for (const x of [t, u]) { x.prevDue = x.fx.debt?.from || x.fx.bill?.from; delete x.fx; }
    S.deleteTxn(t.id); S.deleteTxn(u.id);
    assert.equal(d.nextDue, '2026-10-31'); assert.equal(d.balance, 12000); assert.equal(d.paymentsMade, 0);
    assert.equal(b.nextDue, '2026-10-31');
  });
});

describe('store: rounding over many transactions', () => {
  test('1,000 card charges of ₱0.10 sum to exactly ₱100; deleting all restores exactly', () => {
    fresh(); const c = card({ balance: 0 });
    const ids = [];
    for (let i = 0; i < 1000; i++) ids.push(spend(0.1, { cardId: c.id }).id);
    assert.equal(c.balance, 100);
    assert.equal(S.sumBy(S.db.txns, 'expense'), 100);
    for (const id of ids) S.deleteTxn(id);
    assert.equal(c.balance, 0);
  });
  test('random centavo amounts: apply then delete in random order returns to the exact start', () => {
    fresh(); const c = card({ balance: 54321.09 }); const g = goal({ saved: 1234.56 });
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ids = [];
    for (let i = 0; i < 300; i++) {
      const amt = U.round2(rnd() * 500 + 0.01);
      const withdraw = i % 2 === 0 && amt <= g.saved;
      ids.push((i % 3 === 0 ? add({ kind: 'goal', goalId: g.id, amount: amt, withdraw }) : spend(amt, { cardId: c.id })).id);
    }
    ids.sort(() => rnd() - 0.5).forEach((id) => { try { S.deleteTxn(id); } catch (e) { throw new Error(`delete failed: ${e.message}`); } });
    assert.equal(c.balance, 54321.09); assert.equal(g.saved, 1234.56);
  });
});

// =================================================================================================
describe('store: upcoming()', () => {
  test('includes overdue + due-by items, excludes done bills and paid debts, sorted by date, flags late', () => {
    fresh();
    bill({ name: 'Water', nextDue: '2026-10-01', amount: 400 });
    bill({ name: 'Netflix', nextDue: '2026-10-18', amount: 549 });
    bill({ name: 'Later', nextDue: '2026-11-18', amount: 1 });
    const done = bill({ name: 'Done', nextDue: '2026-10-15', amount: 1, frequency: 'once' }); payBill(done);
    card({ name: 'BPI', nextDue: '2026-10-20', plannedPayment: 2000 });
    loan({ name: 'Paid', balance: 0, nextDue: '2026-10-16' });
    loan({ name: 'Last bit', balance: 300, paymentAmount: 1000, nextDue: '2026-10-16' });
    const u = S.upcoming('2026-10-22');
    assert.deepEqual(u.map((x) => [x.name, x.due, x.amount, x.late]), [
      ['Water', '2026-10-01', 400, true], ['Last bit', '2026-10-16', 300, false], ['Netflix', '2026-10-18', 549, false], ['BPI', '2026-10-20', 2000, false],
    ]);
    assert.deepEqual(Object.keys(u[0]).sort(), ['amount', 'due', 'icon', 'id', 'kind', 'late', 'name']);
  });
  test('A5: a weekly bill due twice before payday is listed twice', () => {
    fresh();
    bill({ name: 'Grab weekly pass', amount: 500, frequency: 'weekly', nextDue: '2026-10-14' });
    const due = S.upcoming(S.period().end).filter((x) => x.name === 'Grab weekly pass');
    assert.deepEqual(due.map((x) => x.due), ['2026-10-14', '2026-10-21']);
  });
  test('A5: repeat debt occurrences stop once the balance is covered', () => {
    fresh();
    loan({ name: 'Weekly', frequency: 'weekly', paymentAmount: 1000, balance: 1500, totalPayments: 2, nextDue: '2026-10-07' });
    assert.deepEqual(S.upcoming('2026-11-30').map((x) => [x.due, x.amount, x.late]), [['2026-10-07', 1000, true], ['2026-10-14', 500, false]]);
  });
  test('semimonthly 5th & 20th debt', () => {
    fresh();
    loan({ type: 'lending', frequency: 'semimonthly', dueDays: [5, 20], nextDue: '2026-10-20' });
    assert.deepEqual(S.upcoming('2026-11-06').map((x) => x.due), ['2026-10-20', '2026-11-05']);
  });
});

describe('store: snapshotDebt history', () => {
  test('records the total on debt-changing actions and keys it by today', () => {
    fresh(); const c = card();
    assert.equal(S.db.debtHistory['2026-10-13'], 10000);
    const t = spend(500, { cardId: c.id });
    assert.equal(S.db.debtHistory['2026-10-13'], 10500);
    setToday('2026-10-14'); S.deleteTxn(t.id);
    assert.equal(S.db.debtHistory['2026-10-14'], 10000);
    assert.equal(S.db.debtHistory['2026-10-13'], 10500);
    add({ kind: 'adjust', debtId: c.id, direction: 'up', reason: 'interest', amount: 300, date: '2026-10-14' });
    assert.equal(S.db.debtHistory['2026-10-14'], 10300);
  });
});

// =================================================================================================
describe('store: freeToSpend / goalPlan / categoryOrder / monthSummary', () => {
  test('freeToSpend on a fresh phone', () => {
    fresh();
    assert.deepEqual(S.freeToSpend(), { cash: 0, due: 0, dueItems: [], setAside: 0, setAsideItems: [], free: 0, next: '2026-10-23', hasIncomeThisPeriod: false });
  });
  test('freeToSpend = all wallets − due before payday − goal set-aside (card purchases are not cash)', () => {
    fresh(); const c = card({ nextDue: '2026-11-20' });
    bill({ name: 'Internet', amount: 1699, nextDue: '2026-10-20' });
    const g = goal();
    add({ kind: 'income', amount: 20000 });
    spend(300); spend(900, { cardId: c.id });
    const f = S.freeToSpend();
    const plan = S.goalPlan(g);
    assert.equal(f.cash, 19700); assert.equal(f.due, 1699);
    assert.deepEqual(f.dueItems.map((x) => x.name), ['Internet']);
    assert.equal(plan.setAsideNow, 4616);
    assert.deepEqual(f.setAsideItems, [{ goalId: g.id, name: 'Japan', emoji: '✈️', amount: 4616 }]);
    assert.equal(f.setAside, 4616);
    assert.equal(f.free, 19700 - 1699 - 4616);
    assert.equal(f.hasIncomeThisPeriod, true);
  });
  test('carry-over: money left from last period (or pay credited a day early) still counts', () => {
    fresh({ today: '2026-10-23', anchor: '2026-10-09' });
    add({ kind: 'income', amount: 20000, date: '2026-10-22' });
    const f = S.freeToSpend();
    assert.equal(f.cash, 20000); assert.equal(f.free, 20000); assert.equal(f.hasIncomeThisPeriod, false);
  });
  test('goalPlan: on track, deposits this period reduce what is left to set aside', () => {
    fresh(); const g = goal();
    // paydays after today up to Apr 1: 12, plus the current period = 13
    assert.deepEqual(S.goalPlan(g), { remaining: 60000, perPayday: 4616, paydaysLeft: 13, depositedThisPeriod: 0, setAsideNow: 4616, status: 'on-track' });
    add({ kind: 'goal', goalId: g.id, amount: 1000 });
    assert.deepEqual(S.goalPlan(g), { remaining: 59000, perPayday: 4616, paydaysLeft: 13, depositedThisPeriod: 1000, setAsideNow: 3616, status: 'on-track' });
    add({ kind: 'goal', goalId: g.id, amount: 300, withdraw: true });
    assert.equal(S.goalPlan(g).depositedThisPeriod, 700);
  });
  test('goalPlan: earlier deposits shrink the per-payday amount', () => {
    fresh(); const g = goal();
    add({ kind: 'goal', goalId: g.id, amount: 13000, date: '2026-10-01' });
    const p = S.goalPlan(g);
    assert.equal(p.perPayday, 3616); assert.equal(p.setAsideNow, 3616); assert.equal(p.depositedThisPeriod, 0);
  });
  test('goalPlan: reached, no deadline, overdue, deadline this period', () => {
    fresh();
    assert.equal(S.goalPlan(goal({ target: 100, saved: 100 })).status, 'reached');
    assert.equal(S.goalPlan(goal({ target: 100, saved: 100 })).setAsideNow, 0);
    const nd = S.goalPlan(goal({ deadline: null }));
    assert.equal(nd.status, 'no-deadline'); assert.equal(nd.setAsideNow, 0); assert.equal(nd.remaining, 60000);
    const od = S.goalPlan(goal({ deadline: '2026-10-01' }));
    assert.equal(od.status, 'overdue'); assert.equal(od.setAsideNow, 0);
    const soon = S.goalPlan(goal({ target: 5000, deadline: '2026-10-20' }));
    assert.equal(soon.paydaysLeft, 1); assert.equal(soon.perPayday, 5000); assert.equal(soon.setAsideNow, 5000);
  });
  test('BUG-16: saveGoal / saveBill / saveCategory reject bad numbers and blank names', () => {
    fresh();
    throwsValidation(() => goal({ target: -100 }), 'target');
    throwsValidation(() => goal({ target: 0 }), 'target');
    throwsValidation(() => goal({ name: ' ' }), 'name');
    throwsValidation(() => goal({ saved: -5 }), 'saved');
    throwsValidation(() => bill({ amount: -500 }), 'amount');
    throwsValidation(() => bill({ nextDue: null }), 'nextDue');
    throwsValidation(() => S.saveCategory({ name: 'X', emoji: '🐶', limit: -50 }), 'limit');
    throwsValidation(() => S.saveCategory({ name: '', emoji: '🐶', limit: 0 }), 'name');
    assert.equal(S.saveCategory({ name: 'Pets', emoji: '🐶' }).limit, 0);
  });
  test('categoryOrder: most used in the last 30 days first, ties keep the original order', () => {
    fresh(); const c = S.db.categories.map((x) => x.id);
    const use = (i, n, date = '2026-10-10') => { for (let k = 0; k < n; k++) spend(1, { categoryId: c[i], date }); };
    use(5, 3); use(7, 2); use(2, 2); use(11, 9, '2026-09-01');
    add({ kind: 'income', amount: 5 });
    assert.deepEqual(S.categoryOrder(), [c[5], c[2], c[7], ...c.filter((_, i) => ![5, 2, 7].includes(i))]);
  });
  test('A6/BUG-09: monthSummary counts a card purchase once', () => {
    fresh({ today: '2026-10-25' }); const c = card({ balance: 0 });
    add({ kind: 'income', amount: 30000 });
    spend(5000, { cardId: c.id });
    pay(c, 5000);
    assert.equal(S.monthSummary('2026-10').net, 25000);
  });
  test('monthSummary shape', () => {
    fresh(); const c = card(); const l = loan(); const g = goal(); const [food, groc] = S.db.categories;
    add({ kind: 'income', amount: 20000 });
    spend(300, { categoryId: food.id }); spend(700, { categoryId: groc.id }); spend(200, { categoryId: food.id, cardId: c.id }); spend(50, { categoryId: 'gone' });
    pay(l, 1000);
    add({ kind: 'goal', goalId: g.id, amount: 2000 }); add({ kind: 'goal', goalId: g.id, amount: 500, withdraw: true });
    add({ kind: 'adjust', debtId: c.id, direction: 'up', reason: 'fee', amount: 150 });
    add({ kind: 'adjust', debtId: c.id, direction: 'down', reason: 'correction', amount: 10 });
    add({ kind: 'transfer', accountId: cashId(), toAccountId: S.saveAccount({ name: 'GCash', kind: 'ewallet' }).id, amount: 999 });
    spend(5, { date: '2026-09-30' });
    const m = S.monthSummary('2026-10');
    assert.deepEqual({ ...m, byCategory: undefined }, { income: 20000, spent: 1250, spentOnCards: 200, debtPaid: 1000, saved: 1500, fees: 150, net: 20000 - 1050 - 1000 - 1500, byCategory: undefined, count: 11 });
    assert.deepEqual(m.byCategory.map((x) => [x.name, x.value]), [['Groceries', 700], ['Food', 500], ['Uncategorized', 50]]);
    assert.equal(m.byCategory[0].id, groc.id); assert.equal(m.byCategory[0].emoji, groc.emoji);
  });
});

// =================================================================================================
describe('importer: parseDebtRows', () => {
  const sheet = [
    'Name\tBalance\tMonthly\tTerms\tPaid\tDue date\tLender',
    'Phone\t₱12,000.00\t2,000\t12\t6\t10/31/2026\tHome Credit',
    'BPI Credit Card\t45,500\t3,000\t\t\t15\tBPI',
    'Tita Mel\t5000\t1000\t\t\t\t',
    'Motorcycle\t60,000\t5,000\t24\t12\tNov 5\tBDO',
    'SSS salary loan\t20000\t1,000\t\t\t2026-11-10\tSSS',
    'GLoan\t7480\t1870\t4\t0\t\t',
  ].join('\n');
  test('Google Sheets paste (tab-separated) with English headers', () => {
    fresh();
    const { rows, warnings } = I.parseDebtRows(sheet);
    assert.equal(rows.length, 6, warnings.join('; '));
    const [phone, bpi, tita, moto, sss, gloan] = rows;
    assert.deepEqual(
      { type: phone.type, name: phone.name, lender: phone.lender, balance: phone.balance, paymentAmount: phone.paymentAmount, totalPayments: phone.totalPayments, paymentsMade: phone.paymentsMade, nextDue: phone.nextDue, frequency: phone.frequency },
      { type: 'lending', name: 'Phone', lender: 'Home Credit', balance: 12000, paymentAmount: 2000, totalPayments: 12, paymentsMade: 6, nextDue: '2026-10-31', frequency: 'monthly' });
    assert.equal(bpi.type, 'card'); assert.equal(bpi.balance, 45500); assert.equal(bpi.plannedPayment, 3000); assert.equal(bpi.nextDue, '2026-10-15');
    assert.equal(tita.type, 'person'); assert.equal(tita.plannedPayment, 1000); assert.equal(tita.nextDue, null);
    assert.equal(moto.type, 'installment'); assert.equal(moto.nextDue, '2026-11-05'); assert.equal(moto.totalPayments, 24);
    assert.equal(sss.type, 'loan'); assert.equal(sss.totalPayments, 20); assert.equal(sss.nextDue, '2026-11-10');
    assert.equal(gloan.type, 'lending'); assert.equal(gloan.totalPayments, 4);
    for (const r of rows) assert.doesNotThrow(() => S.saveDebt(r), r.name);
    assert.equal(S.db.debts.length, 6);
  });
  test('Filipino headers, CSV with quotes, balance computed when missing', () => {
    fresh();
    const csv = 'Pangalan,Hulog,Ilang buwan,Nabayaran,Petsa\n"Ref, ref","₱1,500.00",6,2,2026-11-01\nTala,"2,000",3,1,';
    const { rows, warnings } = I.parseDebtRows(csv);
    assert.equal(rows.length, 2, warnings.join('; '));
    assert.equal(rows[0].name, 'Ref, ref'); assert.equal(rows[0].paymentAmount, 1500); assert.equal(rows[0].balance, 6000);
    assert.equal(rows[0].type, 'installment');
    assert.equal(rows[1].type, 'lending'); assert.equal(rows[1].balance, 4000);
    for (const r of rows) S.saveDebt(r);
  });
  test('Filipino balance header (Utang / Natitira) and twice-a-month due days', () => {
    fresh();
    const { rows } = I.parseDebtRows('Utang\tNatitira\tHulog\tTerms\tDue\nJuanHand\t3000\t500\t6\t5 & 20');
    assert.equal(rows[0].type, 'lending'); assert.equal(rows[0].balance, 3000);
    assert.equal(rows[0].frequency, 'semimonthly'); assert.deepEqual(rows[0].dueDays, [5, 20]); assert.equal(rows[0].nextDue, '2026-10-20');
    S.saveDebt(rows[0]);
  });
  test('warnings: unreadable numbers, missing names, total rows, empty input', () => {
    fresh();
    const { rows, warnings } = I.parseDebtRows('Name\tBalance\nGood\t100\nBad\tabc\n\t500\nTotal\t600');
    assert.deepEqual(rows.map((r) => r.name), ['Good']);
    assert.ok(warnings.some((w) => /Row 3/.test(w) && /abc/.test(w)), warnings.join('; '));
    assert.ok(warnings.some((w) => /Row 4/.test(w)), warnings.join('; '));
    const empty = I.parseDebtRows('   ');
    assert.deepEqual(empty.rows, []); assert.ok(empty.warnings.length >= 1);
  });
  test('a loan with no schedule becomes a one-time payment that saveDebt accepts', () => {
    fresh();
    const { rows, warnings } = I.parseDebtRows('Name,Balance,Lender\nCar loan,90000,BPI Family');
    assert.equal(rows[0].type, 'loan'); assert.equal(rows[0].frequency, 'once'); assert.equal(rows[0].totalPayments, 1);
    assert.ok(warnings.length >= 1);
    S.saveDebt(rows[0]);
  });
  test('a credit card sheet (min due / credit limit columns) is read as cards', () => {
    fresh();
    const { rows } = I.parseDebtRows('Card\tBank\tStatement balance\tMin due\tDue date\tCredit limit\nGold\tBPI\t₱23,450.75\t₱850\t10/25/2026\t80,000');
    assert.deepEqual({ type: rows[0].type, name: rows[0].name, lender: rows[0].lender, balance: rows[0].balance, paymentAmount: rows[0].paymentAmount, creditLimit: rows[0].creditLimit, nextDue: rows[0].nextDue },
      { type: 'card', name: 'Gold', lender: 'BPI', balance: 23450.75, paymentAmount: 850, creditLimit: 80000, nextDue: '2026-10-25' });
    S.saveDebt(rows[0]);
  });
  test('money owed to family is a person debt even with a lender column', () => {
    fresh();
    const { rows } = I.parseDebtRows('Pangalan\tHalaga\tKanino\nUtang kay Ate Joy\t3000\tAte Joy\nPambayad sa ospital\t8000\tTita Mel');
    assert.deepEqual(rows.map((r) => [r.type, r.balance]), [['person', 3000], ['person', 8000]]);
  });
  test('no header row: columns read in order Name, Balance, Payment, Terms', () => {
    fresh();
    const { rows, warnings } = I.parseDebtRows('Atome\t2400\t800\t3');
    assert.equal(rows.length, 1); assert.equal(rows[0].type, 'lending'); assert.equal(rows[0].balance, 2400);
    assert.ok(warnings.length >= 1);
  });
});
