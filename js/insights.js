// Things Pitaka notices for you: budgets running out and expenses that look like subscriptions.
// DOM-free (runs under Node). Reads the store, never changes it.
import * as S from './store.js';
import { today, addDays, daysBetween, advance, round2 } from './util.js';

// ---------- budgets ----------
// How a category stands this pay period: { limit, spent, left, pct, state: 'ok' | 'near' | 'over' }.
export function budgetUsage(categoryId, iso = today()) {
  const c = S.db.categories.find((x) => x.id === categoryId);
  if (!c || !(c.limit > 0)) return null;
  const p = S.period(iso);
  const spent = round2(S.txnsBetween(p.start, p.end).filter((t) => t.kind === 'expense' && t.categoryId === categoryId).reduce((s, t) => s + t.amount, 0));
  const pct = (spent / c.limit) * 100;
  return { category: c, limit: c.limit, spent, left: round2(c.limit - spent), pct, state: pct > 100 ? 'over' : pct >= 80 ? 'near' : 'ok' };
}
// After saving expense `t`: did it push its category over (or near) the limit? null when nothing to say.
// { kind: 'over' | 'still-over' | 'near', category, amount } — amount is how far over, or what is left.
export function budgetWarning(t) {
  if (!t || t.kind !== 'expense' || !t.categoryId) return null;
  const p = S.period();
  if (t.date < p.start || t.date > p.end) return null;
  const u = budgetUsage(t.categoryId);
  if (!u) return null;
  const before = round2(u.spent - t.amount);
  if (u.spent > u.limit) return { kind: before > u.limit ? 'still-over' : 'over', category: u.category, amount: round2(u.spent - u.limit) };
  if (u.pct >= 80 && (before / u.limit) * 100 < 80) return { kind: 'near', category: u.category, amount: u.left };
  return null;
}
export function budgetWarningText(w) {
  if (!w) return '';
  const name = w.category.name;
  const peso = `₱${Math.round(w.amount).toLocaleString('en-PH')}`;
  if (w.kind === 'over') return `${name} is now ${peso} over budget`;
  if (w.kind === 'still-over') return `${name} is ${peso} over budget`;
  return `${name}: ${peso} left this pay period`;
}
// Categories at 80% or more of their limit this pay period, fullest first.
export function budgetsToWatch(iso = today()) {
  return S.db.categories.map((c) => budgetUsage(c.id, iso)).filter((u) => u && u.pct >= 80).sort((a, b) => b.pct - a.pct);
}

// ---------- subscriptions ----------
// Services that bill monthly or yearly: two charges are enough to suggest them.
const KNOWN = ['netflix', 'spotify', 'youtube', 'disney', 'viu', 'icloud', 'apple', 'google one', 'google storage', 'prime video', 'amazon prime', 'hbo', 'max', 'canva', 'adobe', 'microsoft', 'xbox', 'playstation', 'nintendo', 'crunchyroll', 'iwanttfc', 'vivamax', 'chatgpt', 'notion', 'dropbox', 'gym', 'anytime fitness', 'converge', 'pldt', 'globe', 'smart', 'sky', 'meralco', 'maynilad', 'manila water'];
const NOISE = new Set(['com', 'ph', 'inc', 'corp', 'co', 'www', 'ltd', 'payment', 'subscription', 'sub', 'monthly', 'bill', 'online', 'the']);
export function merchantKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w)).join(' ');
}
const known = (k) => KNOWN.some((n) => ` ${k} `.includes(` ${n} `));
const RULES = [
  { freq: 'weekly', min: 6, max: 8, count: 4 },
  { freq: 'biweekly', min: 12, max: 16, count: 3 },
  { freq: 'monthly', min: 26, max: 35, count: 3 },
  { freq: 'quarterly', min: 85, max: 98, count: 2, knownOnly: true },
  { freq: 'yearly', min: 355, max: 375, count: 2, knownOnly: true },
];

// Repeated expenses with the same merchant and amount at a steady rhythm that aren't bills yet.
// Returns [{ key, name, amount, frequency, count, last, nextDue, categoryId }], newest first.
export function detectSubscriptions({ txns = S.db.txns, bills = S.db.bills, dismissed = S.db.dismissed || [], now = today() } = {}) {
  const from = addDays(now, -400);
  const groups = new Map();
  for (const t of txns) {
    if (t.kind !== 'expense' || t.billId || t.date < from || t.date > now) continue;
    const name = (t.merchant || t.note || '').trim();
    const k = merchantKey(name);
    if (!k) continue;
    const key = `${k}|${Math.round(t.amount * 100)}`;
    if (!groups.has(key)) groups.set(key, { key, k, name, amount: t.amount, dates: [], categoryId: t.categoryId });
    const g = groups.get(key);
    g.dates.push(t.date);
    if (t.categoryId) g.categoryId = t.categoryId;
  }
  const out = [];
  for (const g of groups.values()) {
    if (dismissed.includes(`sub:${g.key}`) || g.dates.length < 2) continue;
    const dates = [...new Set(g.dates)].sort();
    if (dates.length < 2) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const rule = RULES.find((r) => gaps.every((x) => x >= r.min && x <= r.max));
    if (!rule) continue;
    const isKnown = known(g.k);
    if (rule.knownOnly && !isKnown) continue;
    if (dates.length < rule.count && !(isKnown && dates.length >= 2)) continue;
    const last = dates.at(-1);
    if (daysBetween(last, now) > rule.max * 1.6) continue; // stopped
    const covered = bills.some((b) => { const bk = merchantKey(b.name); return (bk && (bk.includes(g.k) || g.k.includes(bk))) || (Math.abs(b.amount - g.amount) < 0.005 && b.categoryId && b.categoryId === g.categoryId); });
    if (covered) continue;
    out.push({ key: g.key, name: g.name, amount: g.amount, frequency: rule.freq, count: dates.length, last, nextDue: advance(last, rule.freq) || last, categoryId: g.categoryId });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}
