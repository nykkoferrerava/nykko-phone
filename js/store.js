// All data lives in this phone's localStorage under one key. Nothing is sent anywhere.
import { uid, today, addDays, daysBetween, advance, round2, PER_MONTH, parseISO } from './util.js';

const KEY = 'pitaka.data';
const VERSION = 1;

export const DEBT_TYPES = {
  card: { label: 'Credit card', icon: '💳' },
  loan: { label: 'Loan', icon: '🏦' },
  installment: { label: 'Installment', icon: '🧾' },
  lending: { label: 'Online lending app', icon: '📱' },
  person: { label: 'Owed to a person', icon: '🤝' },
};
// These have a fixed amount per payment and a set number of payments.
export const isScheduled = (d) => ['loan', 'installment', 'lending'].includes(d.type);

const DEFAULT_CATEGORIES = [
  ['Food', '🍜', 0], ['Groceries', '🛒', 0], ['Transport', '🚕', 0], ['Bills & Utilities', '💡', 0],
  ['Load & Internet', '📶', 0], ['Shopping', '🛍️', 0], ['Health', '💊', 0], ['Fun', '🎉', 0],
  ['Family', '👨‍👩‍👧', 0], ['Personal care', '💈', 0], ['Subscriptions', '📺', 0], ['Other', '📦', 0],
].map(([name, emoji, limit]) => ({ id: uid(), name, emoji, limit }));

function blank() {
  return {
    version: VERSION,
    settings: { onboarded: false, payAnchor: today(), payAmount: 0, pinHash: null, pinSalt: null, lockAfterSec: 60 },
    categories: DEFAULT_CATEGORIES,
    txns: [],
    debts: [],
    bills: [],
    goals: [],
    debtHistory: {},
  };
}

export let db = blank();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) db = migrate(JSON.parse(raw));
  } catch (e) {
    console.error('Could not read saved data', e);
  }
  snapshotDebt(false);
  return db;
}

function migrate(data) {
  const base = blank();
  const out = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
  out.version = VERSION;
  return out;
}

export function save() {
  localStorage.setItem(KEY, JSON.stringify(db));
}

export function replaceAll(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.txns)) throw new Error('This is not a valid backup file.');
  db = migrate(data);
  save();
}

export function resetAll() {
  localStorage.removeItem(KEY);
  db = blank();
}

// ---------- lookups ----------
export const cat = (id) => db.categories.find((c) => c.id === id) || { name: 'Uncategorized', emoji: '❔' };
export const debt = (id) => db.debts.find((d) => d.id === id);
export const goal = (id) => db.goals.find((g) => g.id === id);
export const bill = (id) => db.bills.find((b) => b.id === id);

// ---------- pay periods (bi-weekly) ----------
export function period(iso = today()) {
  const anchor = db.settings.payAnchor || today();
  const idx = Math.floor(daysBetween(anchor, iso) / 14);
  const start = addDays(anchor, idx * 14);
  return { start, end: addDays(start, 13), next: addDays(start, 14) };
}
// Paydays from tomorrow up to and including `until`.
export function paydaysUntil(until) {
  let p = period().next, n = 0;
  while (p <= until) { n++; p = addDays(p, 14); }
  return n;
}

// ---------- debts ----------
export function paymentsLeft(d) {
  if (d.balance <= 0) return 0;
  if (isScheduled(d)) return Math.max(0, (d.totalPayments || 0) - (d.paymentsMade || 0));
  const pay = d.plannedPayment || d.paymentAmount;
  if (!pay) return null;
  if (d.type === 'card' && d.rate > 0) {
    const r = d.rate / 100; // monthly rate
    if (pay <= r * d.balance) return Infinity;
    return Math.ceil(-Math.log(1 - (r * d.balance) / pay) / Math.log(1 + r));
  }
  return Math.ceil(d.balance / pay);
}

export function debtStatus(d) {
  if (d.balance <= 0) return 'paid';
  if (!d.nextDue) return 'ok';
  const n = daysBetween(today(), d.nextDue);
  if (n < 0) return 'overdue';
  if (n <= 3) return 'soon';
  return 'ok';
}

// Estimated date of the last payment.
export function payoffDate(d) {
  const left = paymentsLeft(d);
  if (!left || left === Infinity || !d.nextDue) return null;
  const freq = d.type === 'card' ? 'monthly' : d.frequency || 'monthly';
  if (freq === 'once') return d.nextDue;
  let date = d.nextDue;
  for (let i = 1; i < left; i++) date = advance(date, freq, d.dueDay);
  return date;
}

export const totalDebt = () => round2(db.debts.reduce((s, d) => s + Math.max(0, d.balance), 0));

export function monthlyObligations() {
  let s = 0;
  for (const d of db.debts) {
    if (d.balance <= 0) continue;
    if (d.type === 'card') s += d.plannedPayment || d.paymentAmount || 0;
    else if (d.type === 'person') s += d.plannedPayment || 0;
    else s += (d.paymentAmount || 0) * (PER_MONTH[d.frequency] ?? 1);
  }
  return round2(s);
}

export function snapshotDebt(force = true) {
  const t = today();
  if (!force && db.debtHistory[t] !== undefined) return;
  db.debtHistory[t] = totalDebt();
  if (force) save();
}

export function saveDebt(input) {
  const existing = input.id && debt(input.id);
  const d = existing ? Object.assign(existing, input) : { id: uid(), createdAt: today(), ...input };
  if (d.nextDue) d.dueDay = parseISO(d.nextDue).getDate();
  d.original = Math.max(d.original || 0, d.balance, isScheduled(d) ? (d.paymentAmount || 0) * (d.totalPayments || 0) : 0);
  if (!existing) db.debts.push(d);
  snapshotDebt();
  save();
  return d;
}

export function deleteDebt(id) {
  db.debts = db.debts.filter((d) => d.id !== id);
  for (const t of db.txns) {
    if (t.debtId === id) delete t.debtId;
    if (t.cardId === id) delete t.cardId;
  }
  snapshotDebt();
  save();
}

// ---------- bills & goals ----------
export function saveBill(input) {
  const existing = input.id && bill(input.id);
  const b = existing ? Object.assign(existing, input) : { id: uid(), ...input };
  if (b.nextDue) b.dueDay = parseISO(b.nextDue).getDate();
  if (!existing) db.bills.push(b);
  save();
  return b;
}
export function deleteBill(id) {
  db.bills = db.bills.filter((b) => b.id !== id);
  save();
}
export function saveGoal(input) {
  const existing = input.id && goal(input.id);
  const g = existing ? Object.assign(existing, input) : { id: uid(), saved: 0, createdAt: today(), ...input };
  if (!existing) db.goals.push(g);
  save();
  return g;
}
export function deleteGoal(id) {
  db.goals = db.goals.filter((g) => g.id !== id);
  for (const t of db.txns) if (t.goalId === id) delete t.goalId;
  save();
}
export function saveCategory(input) {
  const existing = input.id && db.categories.find((c) => c.id === input.id);
  if (existing) Object.assign(existing, input);
  else db.categories.push({ id: uid(), ...input });
  save();
}
export function deleteCategory(id) {
  db.categories = db.categories.filter((c) => c.id !== id);
  save();
}

// ---------- transactions ----------
// kind: 'expense' | 'income' | 'debt' (payment) | 'goal' (deposit / withdrawal)
// Each transaction's side effects on debts, bills and goals are applied and reverted
// symmetrically, so editing or deleting one keeps balances correct.
function apply(t) {
  if (t.kind === 'expense' && t.cardId) {
    const c = debt(t.cardId);
    if (c) c.balance = round2(c.balance + t.amount);
  }
  if (t.kind === 'expense' && t.billId) {
    const b = bill(t.billId);
    if (b && b.nextDue) {
      t.prevDue = b.nextDue;
      b.nextDue = advance(b.nextDue, b.frequency, b.dueDay);
      if (!b.nextDue) b.done = true;
    }
  }
  if (t.kind === 'debt') {
    const d = debt(t.debtId);
    if (d) {
      d.balance = round2(d.balance - t.amount);
      if (t.countsInstallment && isScheduled(d)) d.paymentsMade = (d.paymentsMade || 0) + 1;
      if (t.advanceDue && d.nextDue) {
        t.prevDue = d.nextDue;
        const freq = d.type === 'card' ? 'monthly' : d.frequency || 'monthly';
        d.nextDue = advance(d.nextDue, freq, d.dueDay) || d.nextDue;
      }
    }
  }
  if (t.kind === 'goal') {
    const g = goal(t.goalId);
    if (g) g.saved = round2(g.saved + (t.withdraw ? -t.amount : t.amount));
  }
}

function revert(t) {
  if (t.kind === 'expense' && t.cardId) {
    const c = debt(t.cardId);
    if (c) c.balance = round2(c.balance - t.amount);
  }
  if (t.kind === 'expense' && t.billId && t.prevDue) {
    const b = bill(t.billId);
    if (b) { b.nextDue = t.prevDue; b.done = false; }
  }
  if (t.kind === 'debt') {
    const d = debt(t.debtId);
    if (d) {
      d.balance = round2(d.balance + t.amount);
      if (t.countsInstallment && isScheduled(d)) d.paymentsMade = Math.max(0, (d.paymentsMade || 0) - 1);
      if (t.advanceDue && t.prevDue) d.nextDue = t.prevDue;
    }
  }
  if (t.kind === 'goal') {
    const g = goal(t.goalId);
    if (g) g.saved = round2(g.saved - (t.withdraw ? -t.amount : t.amount));
  }
}

const touchesDebt = (t) => t.kind === 'debt' || (t.kind === 'expense' && t.cardId);

export function saveTxn(input) {
  const old = input.id && db.txns.find((t) => t.id === input.id);
  let t;
  if (old) {
    revert(old);
    // Keep the bill link on edit, but the due-date bump is re-done from the restored date.
    t = Object.assign(old, input);
  } else {
    t = { id: uid(), createdAt: Date.now(), ...input };
    db.txns.push(t);
  }
  t.amount = round2(t.amount);
  apply(t);
  if (touchesDebt(t) || (old && touchesDebt(old))) snapshotDebt();
  save();
  return t;
}

export function deleteTxn(id) {
  const t = db.txns.find((x) => x.id === id);
  if (!t) return;
  revert(t);
  db.txns = db.txns.filter((x) => x.id !== id);
  if (touchesDebt(t)) snapshotDebt();
  save();
}

export function txnsBetween(start, end) {
  return db.txns.filter((t) => t.date >= start && t.date <= end);
}

export function sumBy(list, kind) {
  return round2(list.filter((t) => t.kind === kind).reduce((s, t) => s + (kind === 'goal' && t.withdraw ? -t.amount : t.amount), 0));
}

// Everything due (bills + debt payments) up to `until`, including overdue items.
export function upcoming(until) {
  const items = [];
  for (const b of db.bills) {
    if (b.done || !b.nextDue || b.nextDue > until) continue;
    items.push({ kind: 'bill', id: b.id, name: b.name, amount: b.amount, due: b.nextDue, icon: cat(b.categoryId).emoji });
  }
  for (const d of db.debts) {
    if (d.balance <= 0 || !d.nextDue || d.nextDue > until) continue;
    const amt = d.type === 'card' ? d.plannedPayment || d.paymentAmount || d.balance : d.paymentAmount || d.plannedPayment || d.balance;
    items.push({ kind: 'debt', id: d.id, name: d.name, amount: Math.min(amt, d.balance), due: d.nextDue, icon: DEBT_TYPES[d.type].icon });
  }
  return items.sort((a, b) => a.due.localeCompare(b.due));
}
