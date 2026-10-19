// Matching what arrives (alerts, quick adds, statement rows) against what is already in Pitaka, so
// nothing is counted twice. DOM-free, runs under Node.
//
// An event: { kind: 'expense'|'income'|'transfer-out'|'transfer-in', amount, at (ms, or null when only
//   the day is known), date ('YYYY-MM-DD'), accountId?, cardId?, otherAccountId? (the own wallet on the
//   other side of a transfer), merchant?, ref?, via: 'sms'|'email'|'wallet'|'quick'|'statement', inst? }
//
// Rules: the same reference number is the same event. Otherwise a match needs the same amount, a
// compatible wallet, a time close enough (±window minutes, or the same day when only dates are known)
// and no clash of names. Only clear, single matches are applied automatically; the rest go to Review.
import { toISO, daysBetween } from './util.js';

const NOISE = new Set(['the', 'inc', 'corp', 'co', 'com', 'ph', 'phil', 'philippines', 'store', 'branch', 'mall', 'ltd', 'and', 'of', 'payment', 'purchase', 'pos', 'qr', 'via', 'to', 'at', 'for']);
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !NOISE.has(w) && !/^\d+$/.test(w));
const bigrams = (w) => { const out = []; for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2)); return out; };

// 0..1: how alike two merchant names are ("JOLLIBEE FOODS CORP" vs "jollibee" = 1).
export function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  // a whole word in common (prefixes count: "jollibee" ~ "jollibeefoods")
  for (const x of ta) for (const y of tb) if (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))) return 1;
  // otherwise Dice coefficient on letter pairs
  const A = bigrams(ta.join('')), B = bigrams(tb.join(''));
  const pool = [...B];
  let hit = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length || 1);
}
const informative = (s) => tokens(s).length > 0;

// When an entry happened: its own time, or the time it was saved when that was on the same day.
export function entryTime(t) {
  if (t.at) return t.at;
  if (t.createdAt > 0 && toISO(new Date(t.createdAt)) === t.date) return t.createdAt;
  return null;
}
const refsOf = (t) => [t.ref, ...(t.conf || []).map((c) => c.ref)].filter(Boolean);
const sameAmount = (a, b) => Math.abs(a - b) < 0.005;

// Which wallet sides of entry `t` the event could be about, and how it would read.
function shape(ev, t) {
  switch (ev.kind) {
    case 'expense':
      if (t.kind === 'expense') return { wallet: ev.cardId ? t.cardId === ev.cardId : ev.accountId ? t.accountId === ev.accountId : null, as: 'same' };
      return null;
    case 'income':
    case 'transfer-in':
      if (ev.cardId) return t.kind === 'debt' && t.debtId === ev.cardId ? { wallet: true, as: 'same' } : null; // a payment on a card statement
      if (t.kind === 'income' || t.kind === 'collect') return { wallet: ev.accountId ? t.accountId === ev.accountId : null, as: ev.otherAccountId && t.kind === 'income' ? 'pair' : 'same' };
      if (t.kind === 'goal' && t.withdraw) return { wallet: ev.accountId ? t.accountId === ev.accountId : null, as: 'same' };
      if (t.kind === 'transfer') return { wallet: ev.accountId ? t.toAccountId === ev.accountId : null, as: 'same', other: t.accountId };
      if (ev.kind === 'transfer-in' && ev.otherAccountId && (t.kind === 'expense' || t.kind === 'transfer') && t.accountId === ev.otherAccountId) return { wallet: true, as: 'pair-out' };
      return null;
    case 'transfer-out':
      if (t.kind === 'transfer') return { wallet: ev.accountId ? t.accountId === ev.accountId : null, as: 'same', other: t.toAccountId };
      if (t.kind === 'expense' || t.kind === 'lend') return { wallet: ev.accountId ? t.accountId === ev.accountId : null, as: ev.otherAccountId && t.kind === 'expense' ? 'pair' : 'same' };
      if (t.kind === 'debt' || (t.kind === 'goal' && !t.withdraw)) return { wallet: ev.accountId ? t.accountId === ev.accountId : null, as: 'same' };
      if (ev.otherAccountId && (t.kind === 'income') && t.accountId === ev.otherAccountId) return { wallet: true, as: 'pair-in' };
      return null;
    default:
      return null;
  }
}

// Entries that could be the same event, best first: [{ txn, score, as, reasons }].
// softNames: statement descriptions rarely look like your notes ("NIKE" vs "Shoes"), so a clash of
// names doesn't count against a match there.
export function candidates(ev, txns, { windowMin = 30, softNames = false } = {}) {
  const out = [];
  const win = windowMin * 60000;
  for (const t of txns) {
    if (!sameAmount(t.amount, ev.amount)) continue;
    const reasons = [];
    const refs = refsOf(t);
    if (ev.ref && refs.includes(ev.ref)) { out.push({ txn: t, score: 1, as: 'same', reasons: ['same reference'] }); continue; }
    const sh = shape(ev, t);
    if (!sh || sh.wallet === false) continue;
    if (ev.otherAccountId && sh.other && sh.other !== ev.otherAccountId) continue;
    // Already confirmed by this channel (an SMS can't confirm two entries, nor one entry twice).
    if ((t.conf || []).some((c) => c.via === ev.via && (!c.inst || !ev.inst || c.inst === ev.inst))) continue;
    if (ev.ref && t.ref && t.ref !== ev.ref) continue;
    let score = 0.2;
    score += sh.wallet === true ? 0.25 : 0.1;
    const te = entryTime(t);
    if (ev.at && te) {
      const dt = Math.abs(ev.at - te);
      if (dt <= win) { score += 0.45 * (1 - dt / (win * 2)); reasons.push('close in time'); }
      else if (toISO(new Date(ev.at)) === t.date) { score += 0.15; reasons.push('same day'); }
      else continue;
    } else {
      const d = Math.abs(daysBetween(ev.date, t.date));
      if (d === 0) { score += 0.3; reasons.push('same day'); }
      else if (d === 1 || (ev.via === 'statement' && d <= 3)) { score += 0.12; reasons.push(`${d} day${d === 1 ? '' : 's'} apart`); }
      else continue;
    }
    // The two halves of a transfer name different parties ("GOTYME BANK" / "JUAN DELA CRUZ"): names don't count.
    const theirs = sh.as === 'same' ? t.merchant || t.note || '' : '';
    if (informative(ev.merchant) && informative(theirs)) {
      const sim = similarity(ev.merchant, theirs);
      if (sim >= 0.5) { score += 0.25; reasons.push('same name'); }
      else if (sim < 0.2 && !softNames) { score -= 0.3; reasons.push('different name'); }
    } else score += 0.05;
    out.push({ txn: t, score: Math.max(0, Math.min(1, score)), as: sh.as, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const AUTO = 0.75;
export const MAYBE = 0.4;
// What to do with an event: { action: 'confirm'|'pair'|'create'|'review', txn?, as?, score, candidates }.
//   confirm: it is that entry (add "confirmed by");  pair: that entry is the other half of a transfer
//   between your own wallets;  create: nothing like it yet;  review: unclear, ask.
// `autoPairOnly`: entries that came from alerts may be turned into transfers automatically, manual ones not.
export function decide(ev, txns, opts = {}) {
  const list = candidates(ev, txns, opts);
  const best = list[0];
  if (!best) return { action: 'create', score: 0, candidates: [] };
  const second = list[1];
  const clear = best.score >= AUTO && (!second || second.score < best.score - 0.15);
  if (best.reasons.includes('same reference')) return { action: 'confirm', txn: best.txn, as: 'same', score: 1, candidates: list };
  if (clear && best.as === 'same') return { action: 'confirm', txn: best.txn, as: 'same', score: best.score, candidates: list };
  if (clear && best.as !== 'same') {
    const fromAlert = ['sms', 'email', 'wallet', 'statement'].includes(best.txn.src);
    return { action: fromAlert ? 'pair' : 'review', reason: fromAlert ? undefined : 'transfer', txn: best.txn, as: best.as, score: best.score, candidates: list };
  }
  if (best.score >= MAYBE) return { action: 'review', reason: best.as === 'same' ? 'duplicate' : 'transfer', txn: best.txn, as: best.as, score: best.score, candidates: list };
  return { action: 'create', score: best.score, candidates: list };
}

// Statement rows: [{ date, amount, kind ('expense'|'income'), merchant, ref }] -> each with the entry it matches
// (if any). One entry matches at most one row.
export function matchRows(rows, txns, { accountId, cardId } = {}) {
  const used = new Set();
  return rows.map((r) => {
    const ev = { kind: r.kind === 'income' ? 'transfer-in' : 'transfer-out', amount: r.amount, at: null, date: r.date, accountId, cardId, merchant: r.merchant, ref: r.ref, via: 'statement' };
    if (cardId) ev.kind = r.kind === 'income' ? 'income' : 'expense';
    const pool = txns.filter((t) => !used.has(t.id));
    const c = candidates(ev, pool, { windowMin: 0, softNames: true }).filter((x) => x.as === 'same' && x.score >= 0.55);
    if (!c.length) return { ...r, match: null, score: 0 };
    used.add(c[0].txn.id);
    return { ...r, match: c[0].txn, score: c[0].score };
  });
}
