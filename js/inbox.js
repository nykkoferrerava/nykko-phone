// The inbox pipeline: items from the relay or the Files catch-up -> entries in Pitaka, or questions in
// Review. DOM-free, runs under Node.
//
//   raw item -> checked and de-duplicated by its client id
//            -> read (quick add, quick text, alert, balance check)
//            -> matched against what is already there (reconcile.js)
//            -> applied when Pitaka is sure; otherwise left "pending" for Review
// A whole pull is one all-or-nothing save, and every automatic change can be undone (undoItem/undoBatch):
// the item then goes back to Review, so nothing is ever silently dropped.
import * as S from './store.js';
import { uid, toISO, today, round2, peso } from './util.js';
import { parseQuick, matchWallet, guessCategory } from './quickparse.js';
import { parseAlert, normSender } from './alerts.js';
import { decide, candidates, entryTime, AUTO, MAYBE } from './reconcile.js';

export const RAW_TYPES = ['entry', 'text', 'sms', 'email', 'wallet', 'balance', 'test'];
const CID = /^[A-Za-z0-9._:-]{6,64}$/;
const cap = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const ALERT_SRC = ['sms', 'email', 'wallet', 'statement'];

// A short, stable id for items that came without one (old lines in inbox.jsonl), so re-imports dedupe.
function hashId(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return `h-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------- checking raw items
// Accepts the relay's items and lines of inbox.jsonl: { id, type, at, ...fields } (or { item: {...} }).
// Returns { cid, type, at, receivedAt, raw } or null. Unknown fields are dropped; text is capped.
export function cleanRaw(x, now = Date.now()) {
  if (x && typeof x === 'object' && x.item && typeof x.item === 'object') x = { ...x.item, receivedAt: x.receivedAt };
  if (!x || typeof x !== 'object' || Array.isArray(x) || !RAW_TYPES.includes(x.type)) return null;
  const raw = {};
  const put = (k, n, v = x[k]) => { const s = cap(v, n); if (s) raw[k] = s; };
  switch (x.type) {
    case 'entry': put('amount', 40); put('category', 60); put('wallet', 60); put('note', 200); break;
    case 'text': put('text', 300); break;
    case 'sms': put('sender', 80); put('text', 4000); break;
    case 'email': put('from', 200); put('subject', 300); put('body', 8000); break;
    case 'wallet': put('merchant', 120); put('amount', 40); put('card', 60); put('name', 60); break;
    case 'balance': put('wallet', 60); put('amount', 40); break;
    case 'test': put('source', 30); break;
  }
  const when = (v) => (typeof v === 'number' ? v : Date.parse(String(v || '')));
  const at = when(x.at);
  const receivedAt = when(x.receivedAt);
  const t = Number.isFinite(at) && at > 0 && at < now + 86400000 ? at : Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : now;
  const cid = typeof x.id === 'string' && CID.test(x.id) ? x.id : hashId(JSON.stringify([x.type, raw, Number.isFinite(at) ? at : '']));
  return { cid, type: x.type, at: Math.trunc(t), receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? Math.trunc(receivedAt) : Math.trunc(now), raw };
}

// Where the object starting at s[start] ('{') ends (the index after its '}'), or -1. Braces in strings don't count.
function objectEnd(s, start) {
  let depth = 0, inStr = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) return j + 1;
  }
  return -1;
}

// iCloud Drive/Shortcuts/Pitaka/inbox.jsonl: one JSON object per line (a JSON array also works). A line
// that doesn't parse may start an object written over several lines (pretty-printed): it is read up to its
// closing brace. If that doesn't parse either, only that one line counts as bad.
export function parseJsonl(text) {
  const items = [];
  let bad = 0;
  const add = (x) => { const c = cleanRaw(x); if (c) items.push(c); else bad++; };
  const src = String(text || '').replace(/^﻿/, '').trim();
  if (src.startsWith('[')) {
    try { for (const x of JSON.parse(src)) add(x); return { items, bad }; } catch { items.length = 0; bad = 0; /* fall back to lines */ }
  }
  for (let i = 0; i < src.length;) {
    const nl = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, nl).trim();
    let next = nl + 1;
    if (line) {
      let x, ok = false;
      try { x = JSON.parse(line); ok = true; } catch { /* maybe several lines */ }
      if (!ok && line.startsWith('{')) {
        const start = src.indexOf('{', i), end = objectEnd(src, start);
        if (end > 0) try { x = JSON.parse(src.slice(start, end)); ok = true; next = end; } catch { /* not an object after all */ }
      }
      if (ok) add(x); else bad++;
    }
    i = next;
  }
  return { items, bad };
}

// ---------------------------------------------------------------- reading names
const lc = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stripEmoji = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
const cards = () => S.db.debts.filter((d) => d.type === 'card');
const ctx = () => ({ categories: S.db.categories, accounts: S.db.accounts, cards: cards(), defaultAccountId: S.defaultAccountId() });

// "🍜 Food" (from the shortcut) or "Food" -> the category, matched by name, then keywords and synonyms.
export function categoryByLabel(label) {
  const name = lc(stripEmoji(label));
  if (!name) return null;
  return S.db.categories.find((c) => lc(c.name) === name) || guessCategory(name, S.db.categories);
}
// A wallet or card by its name as the shortcut shows it, or by an alias ("gcash", "bpi card").
export function walletByName(name) {
  const n = lc(name);
  if (!n) return null;
  const a = S.db.accounts.find((x) => lc(x.name) === n);
  if (a) return { accountId: a.id };
  const c = cards().find((x) => lc(x.name) === n);
  if (c) return { cardId: c.id };
  const m = matchWallet(name, { accounts: S.db.accounts, cards: cards() });
  if (m.conflict) return null;
  return m.cardId ? { cardId: m.cardId } : m.accountId ? { accountId: m.accountId } : null;
}
const walletLabel = (w) => (w?.cardId ? S.debt(w.cardId)?.name : S.account(w?.accountId)?.name) || 'wallet';

// Which wallet or card an alert is about: your format's target, "card ending 1234" and sender mappings,
// then the wallet named like the institution (GCash -> your "GCash" wallet).
function alertWallet(ev, sender) {
  if (ev.cardId && S.debt(ev.cardId)) return { cardId: ev.cardId };
  if (ev.accountId && S.account(ev.accountId)) return { accountId: ev.accountId };
  const maps = S.db.cardMap || [];
  const target = (m) => (m.cardId && S.debt(m.cardId) ? { cardId: m.cardId } : m.accountId && S.account(m.accountId) ? { accountId: m.accountId } : null);
  if (ev.last4) { const m = maps.find((x) => x.last4 === ev.last4); if (m && target(m)) return target(m); }
  if (ev.cardName) {
    const m = maps.find((x) => x.label && lc(x.label) === lc(ev.cardName));
    if (m && target(m)) return target(m);
    const byName = walletByName(ev.cardName);
    if (byName) return byName;
  }
  if (sender) { const m = maps.find((x) => x.sender && !x.last4 && (sender === x.sender || sender.endsWith(x.sender))); if (m && target(m)) return target(m); }
  if (ev.inst) {
    const m = matchWallet(ev.inst, { accounts: S.db.accounts, cards: ev.last4 ? cards() : [] });
    if (!m.conflict && (m.accountId || m.cardId)) return m.cardId ? { cardId: m.cardId } : { accountId: m.accountId };
  }
  return null;
}
// Your own wallet named in a counterparty ("GOTYME BANK", "BPI ****1234"). `exact` when a card mapping
// says so; a bank name alone could also be someone else's account at that bank.
function ownWalletIn(text, exceptId) {
  const last4 = /(\d{4})\b(?!.*\d{4})/.exec(String(text || ''))?.[1];
  if (last4) {
    const m = (S.db.cardMap || []).find((x) => x.last4 === last4 && x.accountId && x.accountId !== exceptId);
    if (m) return { accountId: m.accountId, exact: true };
  }
  const accounts = S.db.accounts.filter((a) => a.id !== exceptId && a.kind !== 'cash');
  const w = matchWallet(text, { accounts, cards: [] });
  return w.accountId && !w.conflict ? { accountId: w.accountId, exact: false } : null;
}
const openReceivable = (name) => { const r = S.findReceivable(name); return r && r.balance > 0 ? r : null; };

// ---------------------------------------------------------------- what a proposal becomes
// A proposal is the entry Pitaka would add: { kind, amount, date, at, accountId, cardId, toAccountId,
// categoryId, note, merchant, ref, receivableId, person, src, inst }.
function txnInput(p, itemId) {
  const base = { amount: p.amount, date: p.date, note: p.note || '', merchant: p.merchant, ref: p.ref, at: p.at, src: p.src, inboxId: itemId };
  if (ALERT_SRC.includes(p.src)) base.conf = [{ via: p.src, inst: p.inst || '', at: p.at, ref: p.ref, inboxId: itemId }];
  switch (p.kind) {
    case 'expense': return { ...base, kind: 'expense', categoryId: p.categoryId, ...(p.cardId ? { cardId: p.cardId } : { accountId: p.accountId }) };
    case 'income': return { ...base, kind: 'income', accountId: p.accountId };
    case 'transfer': return { ...base, kind: 'transfer', accountId: p.accountId, toAccountId: p.toAccountId };
    case 'collect': return { ...base, kind: 'collect', accountId: p.accountId, receivableId: p.receivableId };
    default: return null;
  }
}
// The event reconcile.js matches with.
function eventOf(p, via) {
  const kind = p.kind === 'transfer' ? (p.side === 'in' ? 'transfer-in' : 'transfer-out') : p.kind === 'collect' ? 'income' : p.kind;
  const accountId = p.kind === 'transfer' ? (p.side === 'in' ? p.toAccountId : p.accountId) : p.accountId;
  const otherAccountId = p.kind === 'transfer' ? (p.side === 'in' ? p.accountId : p.toAccountId) : undefined;
  return { kind, amount: p.amount, at: p.at, date: p.date, accountId: p.cardId ? undefined : accountId, cardId: p.cardId, otherAccountId, merchant: p.merchant || p.note, ref: p.ref, via, inst: p.inst };
}
const windowMin = () => S.db.settings.matchWindow || 30;
const pool = (via) => (via === 'quick' ? S.db.txns.filter((t) => ALERT_SRC.includes(t.src)) : S.db.txns);

// Applies a proposal for item `it`, matching first. Returns the item's new status fields.
function apply(it, p, { auto, via }) {
  const ev = eventOf(p, via);
  const d = decide(ev, pool(via), { windowMin: windowMin() });
  const conf = { via: p.src, inst: p.inst || (via === 'quick' ? 'Quick Add' : ''), at: p.at, ref: p.ref, inboxId: it.id };
  if (d.action === 'confirm' && auto) {
    const before = S.confirmTxn(d.txn.id, conf, { merchant: p.merchant, ref: p.ref, at: p.at, categoryId: p.categoryId, note: p.note });
    // What you chose in Quick Add wins over what Pitaka guessed from an alert.
    if (via === 'quick' && p.kind === 'expense' && p.categoryId && d.txn.categoryId !== p.categoryId) S.setTxnFields(d.txn.id, { categoryId: p.categoryId });
    return { status: 'auto', result: { action: 'confirmed', txnId: d.txn.id, before } };
  }
  if (d.action === 'pair' && auto) {
    const t = d.txn;
    const prev = JSON.parse(JSON.stringify(t));
    const [from, to] = d.as === 'pair-in' ? [ev.accountId, t.accountId] : d.as === 'pair-out' ? [t.accountId, ev.accountId] : ev.kind === 'transfer-in' ? [ev.otherAccountId, ev.accountId] : [ev.accountId, ev.otherAccountId];
    S.saveTxn({ id: t.id, kind: 'transfer', amount: t.amount, date: t.date, note: t.note, accountId: from, toAccountId: to, src: t.src, merchant: t.merchant, ref: t.ref || p.ref, at: t.at, inboxId: t.inboxId, conf: [...(t.conf || []), conf] });
    return { status: 'auto', result: { action: 'paired', txnId: t.id, prev } };
  }
  if (d.action === 'create' && auto) {
    const t = S.saveTxn(txnInput(p, it.id));
    return { status: 'auto', result: { action: 'created', txnId: t.id } };
  }
  const reason = d.action === 'review' ? d.reason : d.action === 'confirm' ? 'duplicate' : d.action === 'pair' ? 'transfer' : it.reason || 'unsure';
  return { status: 'pending', reason, candidates: (d.candidates || []).filter((c) => c.score >= MAYBE).slice(0, 5).map((c) => c.txn.id) };
}

// After an alert with "new balance": compare with what Pitaka has at that moment.
function checkBalance(it, accountId, reported, at, via, out) {
  if (!accountId || !(reported >= 0) || reported === null) return;
  // An alert from before the wallet's starting balance (a late catch-up) has nothing to compare with.
  const opened = S.account(accountId)?.openingDate;
  if (opened && toISO(new Date(at)) < opened) return;
  const computed = S.balanceAt(accountId, at);
  if (Math.abs(computed - reported) < 0.01) {
    S.setAccountChecked(accountId, { amount: reported, at, via, ok: true });
    return;
  }
  S.setAccountChecked(accountId, { amount: reported, at, via, ok: false });
  const drift = S.addInbox({ type: 'drift', cid: '', src: it.src, status: 'pending', reason: 'drift', at, receivedAt: it.receivedAt, batch: it.batch, source: it.id, raw: { wallet: S.account(accountId)?.name || '' }, drift: { accountId, reported, computed, at } });
  out.review.push(drift.id);
}

// ---------------------------------------------------------------- the handlers
function handleEntry(it) {
  const r = it.raw;
  const amount = Number(String(r.amount || '').replace(/[₱,\s]|php/gi, ''));
  const c = categoryByLabel(r.category);
  const w = walletByName(r.wallet) || (r.wallet ? null : { accountId: S.defaultAccountId() });
  const p = { kind: 'expense', amount: round2(amount), date: toISO(new Date(it.at)), at: it.at, categoryId: c?.id, note: r.note || '', merchant: '', src: 'quick', ...(w || {}) };
  const reasons = [];
  if (!(p.amount > 0) || p.amount > 1e9) reasons.push('no amount');
  if (!c) reasons.push('unknown category');
  if (!w) reasons.push('unknown wallet');
  return { p, auto: !reasons.length, reason: reasons.length ? (reasons.includes('no amount') ? 'unparsed' : 'unsure') : undefined, reasons };
}

function handleText(it) {
  const q = parseQuick(it.raw.text, ctx());
  const date = toISO(new Date(it.at));
  const base = { amount: q.amount, date, at: it.at, note: q.note, merchant: q.merchant, src: 'quick' };
  if (!q.ok) return { p: { ...base, kind: 'expense' }, auto: false, reason: 'unparsed', q };
  if (q.kind === 'lend') return { p: { ...base, kind: 'lend', person: q.person, accountId: q.accountId }, auto: q.confidence === 'high', lend: true, q };
  if (q.kind === 'utang' || q.kind === 'borrow') return { p: { ...base, kind: q.kind, person: q.person, accountId: q.accountId }, auto: false, reason: 'lending', q };
  if (q.kind === 'income') {
    // "received 500 from mel" while Mel owes you: the repayment, or other income? Pitaka asks, as for alerts.
    // (The parser keeps the name as the note: only lending words give a person.)
    const r = openReceivable(q.person || q.note);
    if (r) return { p: { ...base, kind: 'collect', receivableId: r.id, person: r.name, accountId: q.accountId }, auto: false, reason: 'repayment', q };
    return { p: { ...base, kind: 'income', accountId: q.accountId }, auto: q.confidence === 'high', reason: q.confidence === 'high' ? undefined : 'unsure', q };
  }
  return { p: { ...base, kind: 'expense', categoryId: q.categoryId, accountId: q.cardId ? undefined : q.accountId, cardId: q.cardId }, auto: q.confidence === 'high', reason: q.confidence === 'high' ? undefined : 'unsure', q };
}

function handleAlert(it) {
  const sender = normSender(it);
  const res = parseAlert(it, { templates: S.db.templates });
  if (res.templateId) S.bumpTemplate(res.templateId);
  const ev = res.ev;
  const via = it.type;
  if (!ev) return { p: null, auto: false, reason: 'unparsed', res };
  const date = toISO(new Date(it.at));
  const w = alertWallet(ev, sender);
  const base = { amount: ev.amount, date, at: it.at, merchant: ev.merchant, note: '', ref: ev.reference || undefined, src: via, inst: ev.inst || '', balanceAfter: ev.balanceAfter ?? undefined, parser: res.parser, unverified: res.unverified, confidence: res.confidence };
  const sure = res.confidence >= 0.8;
  if (!w) return { p: { ...base, kind: ev.kind === 'expense' ? 'expense' : ev.kind === 'income' || ev.kind === 'transfer-in' ? 'income' : 'expense' }, auto: false, reason: 'no-wallet', res };
  if (ev.kind === 'expense') {
    const c = guessCategory(ev.merchant, S.db.categories) || S.db.categories.find((x) => x.key === 'other');
    return { p: { ...base, kind: 'expense', categoryId: c?.id, ...w }, auto: sure, reason: sure ? undefined : 'unsure', res };
  }
  if (w.cardId) {
    // A payment or refund on a card: a question, Pitaka doesn't guess with card balances.
    return { p: { ...base, kind: 'income', accountId: S.defaultAccountId() }, auto: false, reason: 'unsure', res };
  }
  const own = ownWalletIn(ev.merchant, w.accountId);
  if (ev.kind === 'transfer-out' || ev.kind === 'transfer-in') {
    const out = ev.kind === 'transfer-out';
    if (own) {
      const p = { ...base, kind: 'transfer', side: out ? 'out' : 'in', accountId: out ? w.accountId : own.accountId, toAccountId: out ? own.accountId : w.accountId };
      return { p, auto: sure, transferGuess: !own.exact, reason: sure ? undefined : 'unsure', res };
    }
    if (out) {
      // Sent money to someone: an expense, a loan or your own account elsewhere? Pitaka asks.
      const c = guessCategory(ev.merchant, S.db.categories);
      return { p: { ...base, kind: 'expense', categoryId: c?.id, accountId: w.accountId, sent: true, person: ev.merchant }, auto: false, reason: 'sent', res };
    }
    const r = openReceivable(ev.merchant);
    if (r) return { p: { ...base, kind: 'collect', receivableId: r.id, person: r.name, accountId: w.accountId }, auto: false, reason: 'repayment', res };
    return { p: { ...base, kind: 'income', accountId: w.accountId, side: 'in', unknownSource: true }, auto: sure, reason: sure ? undefined : 'unsure', res };
  }
  return { p: { ...base, kind: 'income', accountId: w.accountId }, auto: sure, reason: sure ? undefined : 'unsure', res };
}

// Matches an incoming transfer to a "sent to <your wallet>" that is waiting in Review: both halves seen.
function pairWithPending(p, it) {
  const win = windowMin() * 60000;
  const waiting = S.db.inbox.filter((x) => x.status === 'pending' && x.parsed?.kind === 'transfer' && x.parsed.side === 'out' && x.parsed.toAccountId === p.accountId && Math.abs(x.parsed.amount - p.amount) < 0.005 && Math.abs((x.parsed.at || x.at) - it.at) <= win);
  return waiting.length === 1 ? waiting[0] : null;
}

// ---------------------------------------------------------------- processing a pull
// rawItems: from cleanRaw(). Returns { batch, ids, created, confirmed, paired, review, tests, duplicates, lent, items }.
export function processItems(rawItems, { src = 'relay' } = {}) {
  const batch = uid();
  const out = { batch, ids: [], created: [], confirmed: [], paired: [], review: [], tests: [], duplicates: 0, items: [] };
  const list = [...rawItems].filter(Boolean).sort((a, b) => a.at - b.at);
  S.transaction(() => {
    const seen = new Set();
    for (const r of list) {
      if (S.hasClientId(r.cid) || seen.has(r.cid)) { out.duplicates++; continue; }
      seen.add(r.cid);
      if (isTest(r)) {
        const it = S.addInbox({ ...r, src, status: 'test', batch, parsed: { source: testSource(r) } });
        out.tests.push(it.id);
        continue;
      }
      const it = S.addInbox({ ...r, src, status: 'pending', batch });
      out.ids.push(it.id);
      route(it, out);
    }
  });
  out.items = out.ids.map(S.inboxItem).filter(Boolean);
  return out;
}

// Reads one stored item and applies or parks it. Used for new items and after "Teach this format".
function route(it, out) {
  if (it.type === 'balance') return balanceItem(it, out);
  const h = it.type === 'entry' ? handleEntry(it) : it.type === 'text' ? handleText(it) : handleAlert(it);
  const via = it.type === 'entry' || it.type === 'text' ? 'quick' : it.type;
  if (!h.p) { S.patchInbox(it.id, { status: 'pending', reason: h.reason || 'unparsed', parsed: { confidence: 0, parser: h.res?.parser || null, unverified: h.res?.unverified } }); out.review.push(it.id); return; }
  const parsed = { ...h.p, reasons: h.reasons || h.q?.reasons, parser: h.p.parser || (via === 'quick' ? 'quick' : undefined) };
  if (h.lend) {
    // "lent mel 500": a receivable, from a wallet. Matching isn't needed: alerts never create lending.
    if (h.auto && h.p.person && h.p.amount > 0) {
      const t = S.lend({ name: h.p.person, amount: h.p.amount, accountId: h.p.accountId, date: h.p.date, note: h.p.note, at: h.p.at, src: 'quick', inboxId: it.id });
      S.patchInbox(it.id, { status: 'auto', parsed, result: { action: 'created', txnId: t.id } });
      out.created.push(t.id);
    } else { S.patchInbox(it.id, { status: 'pending', reason: 'unsure', parsed }); out.review.push(it.id); }
    return;
  }
  if (['utang', 'borrow'].includes(h.p.kind) || !txnInput(h.p, it.id)) {
    S.patchInbox(it.id, { status: 'pending', reason: h.reason || 'lending', parsed });
    out.review.push(it.id);
    return;
  }
  if (h.p.kind === 'income' && h.p.unknownSource) {
    const other = pairWithPending(h.p, it);
    if (other) {
      // Both halves of a transfer between your wallets: one transfer entry, both items settled.
      const p = { ...other.parsed, conf: undefined };
      const t = S.saveTxn({ ...txnInput(p, other.id), conf: [{ via: p.src, inst: p.inst, at: p.at, ref: p.ref, inboxId: other.id }, { via: h.p.src, inst: h.p.inst, at: h.p.at, ref: h.p.ref, inboxId: it.id }] });
      S.patchInbox(other.id, { status: 'auto', result: { action: 'created', txnId: t.id }, reason: null, decidedAt: Date.now() });
      S.patchInbox(it.id, { status: 'auto', parsed, result: { action: 'confirmed', txnId: t.id, before: { conf: null } } });
      out.created.push(t.id);
      out.review = out.review.filter((x) => x !== other.id);
      return;
    }
  }
  const guessed = h.transferGuess && h.p.kind === 'transfer';
  const auto = h.auto && (!guessed || hasPartner(h.p, via));
  const r = apply(it, h.p, { auto, via });
  if (r.status === 'pending') r.reason = guessed ? 'transfer' : ['duplicate', 'transfer'].includes(r.reason) ? r.reason : h.reason || r.reason;
  S.patchInbox(it.id, { ...r, parsed });
  if (r.status === 'auto') {
    out[r.result.action === 'created' ? 'created' : r.result.action === 'paired' ? 'paired' : 'confirmed'].push(r.result.txnId);
    const acct = h.p.kind === 'transfer' ? (h.p.side === 'in' ? h.p.toAccountId : h.p.accountId) : h.p.accountId;
    if (h.p.balanceAfter !== undefined && !h.p.cardId) checkBalance(S.inboxItem(it.id), acct, h.p.balanceAfter, it.at, via, out);
  } else out.review.push(it.id);
}
// A guessed transfer to your own wallet is applied only when the other half is already there.
function hasPartner(p, via) {
  const d = decide(eventOf(p, via), S.db.txns, { windowMin: windowMin() });
  return (d.action === 'pair' || d.action === 'confirm') && d.score >= AUTO;
}

function balanceItem(it, out) {
  const w = walletByName(it.raw.wallet);
  const reported = Number(String(it.raw.amount || '').replace(/[₱,\s]|php/gi, ''));
  if (!w?.accountId || !Number.isFinite(reported)) {
    S.patchInbox(it.id, { status: 'pending', reason: w ? 'unparsed' : 'no-wallet', parsed: { kind: 'balance', amount: Number.isFinite(reported) ? reported : null } });
    out.review.push(it.id);
    return;
  }
  const computed = S.balanceAt(w.accountId, it.at);
  const drift = { accountId: w.accountId, reported: round2(reported), computed, at: it.at };
  if (Math.abs(computed - reported) < 0.01) {
    S.setAccountChecked(w.accountId, { amount: reported, at: it.at, via: 'balance', ok: true });
    S.patchInbox(it.id, { status: 'done', result: { action: 'matched' }, drift, decidedAt: Date.now() });
    out.confirmed.push(null);
    return;
  }
  S.setAccountChecked(w.accountId, { amount: reported, at: it.at, via: 'balance', ok: false });
  S.patchInbox(it.id, { status: 'pending', reason: 'drift', drift });
  out.review.push(it.id);
}

// "test" items, and quick adds with the note "test", only prove that a shortcut reaches Pitaka.
function isTest(r) {
  if (r.type === 'test') return true;
  if (r.type === 'entry') return lc(r.raw.note) === 'test';
  if (r.type === 'text') return lc(r.raw.text) === 'test';
  if (r.type === 'sms' || r.type === 'email') return !r.raw.text && !r.raw.body && !r.raw.subject || lc(r.raw.text) === 'test';
  if (r.type === 'balance') return lc(r.raw.wallet) === 'test';
  if (r.type === 'wallet') return lc(r.raw.merchant) === 'test' || (!r.raw.merchant && !r.raw.amount);
  return false;
}
const testSource = (r) => (r.type === 'test' ? r.raw.source || 'test' : r.type);

// ---------------------------------------------------------------- Review: decisions
export const pending = () => S.db.inbox.filter((x) => x.status === 'pending').sort((a, b) => b.at - a.at);
export const reviewCount = () => S.db.inbox.reduce((n, x) => n + (x.status === 'pending'), 0);
// Recently applied without asking (for "Undo" in Review), newest first.
export const recentAuto = (days = 7) => S.db.inbox.filter((x) => (x.status === 'auto' || (x.status === 'done' && x.decidedAt)) && x.receivedAt >= Date.now() - days * 86400000).sort((a, b) => b.at - a.at);
export const testsSince = (ms) => S.db.inbox.filter((x) => x.status === 'test' && x.receivedAt >= ms);

function done(id, result) { S.patchInbox(id, { status: 'done', result, reason: null, decidedAt: Date.now() }); }

// Accept what Pitaka proposed. `choice` overrides: { as: 'lent'|'borrowed'|'expense'|'income', create: true
// (add it even though it looks like a duplicate), accountId, categoryId, person }.
export function accept(id, choice = {}) {
  return S.transaction(() => {
    const it = S.inboxItem(id);
    if (!it || it.status !== 'pending') return null;
    if (it.reason === 'drift' || it.type === 'drift') return fixDrift(it);
    const p = { ...it.parsed, ...(choice.accountId ? { accountId: choice.accountId, cardId: undefined } : {}), ...(choice.categoryId ? { categoryId: choice.categoryId } : {}) };
    if (!(p.amount > 0)) throw new S.ValidationError('There is no amount to add. Edit it instead.', 'amount');
    if (p.kind === 'utang' || p.kind === 'borrow' || p.kind === 'lend' || choice.as === 'lent' || choice.as === 'borrowed') {
      const as = choice.as || (p.kind === 'lend' ? 'lent' : p.kind === 'borrow' ? 'borrowed' : null);
      const person = choice.person || p.person || p.merchant;
      if (!as) throw new S.ValidationError('Choose whether you lent or borrowed', 'as');
      if (!person) throw new S.ValidationError('Who was it?', 'person');
      if (as === 'lent') {
        const t = S.lend({ name: person, amount: p.amount, accountId: p.accountId || S.defaultAccountId(), date: p.date, note: p.note, at: p.at, src: p.src, inboxId: id });
        done(id, { action: 'created', txnId: t.id });
        return t;
      }
      // Borrowed: a debt you owe that person, and the money that came into the wallet as a balance fix.
      const existing = S.db.debts.find((d) => d.type === 'person' && lc(d.name) === lc(person));
      const debt = existing
        ? (S.saveTxn({ kind: 'adjust', debtId: existing.id, direction: 'up', reason: 'correction', amount: p.amount, date: p.date, note: 'Borrowed again' }), existing)
        : S.saveDebt({ type: 'person', name: person, balance: p.amount, nextDue: null, notes: '' });
      const cash = S.saveTxn({ kind: 'adjust', accountId: p.accountId || S.defaultAccountId(), direction: 'up', reason: 'correction', amount: p.amount, date: p.date, note: `Borrowed from ${person}`, inboxId: id });
      done(id, { action: 'created', txnId: cash.id, debtId: debt.id });
      return cash;
    }
    if (choice.as === 'expense' && p.kind !== 'expense') Object.assign(p, { kind: 'expense', categoryId: p.categoryId || guessCategory(p.merchant, S.db.categories)?.id });
    if (choice.as === 'income' && p.kind !== 'income') Object.assign(p, { kind: 'income', cardId: undefined });
    const via = it.type === 'entry' || it.type === 'text' ? 'quick' : it.type;
    if (!choice.create) {
      // An explicit accept may also pair a transfer with an entry you added yourself.
      const d = decide(eventOf(p, via), pool(via), { windowMin: windowMin() });
      if ((d.action === 'pair' || d.action === 'review') && d.as !== 'same' && d.score >= MAYBE && p.kind === 'transfer') return pairNow(it, p, d);
      if (d.action === 'confirm') return linkNow(it, d.txn.id, p);
    }
    const input = txnInput({ ...p, kind: p.kind === 'collect' && !S.receivable(p.receivableId) ? 'income' : p.kind }, id);
    if (!input) throw new S.ValidationError('Edit this one to choose what it is', 'kind');
    const t = S.saveTxn(input);
    done(id, { action: 'created', txnId: t.id });
    if (p.balanceAfter !== undefined && !p.cardId) checkBalance(S.inboxItem(id), p.kind === 'transfer' ? (p.side === 'in' ? p.toAccountId : p.accountId) : p.accountId, p.balanceAfter, it.at, via, { review: [] });
    return t;
  });
}
function linkNow(it, txnId, p) {
  const before = S.confirmTxn(txnId, { via: p.src, inst: p.inst || (p.src === 'quick' ? 'Quick Add' : ''), at: p.at, ref: p.ref, inboxId: it.id }, { merchant: p.merchant, ref: p.ref, at: p.at, categoryId: p.categoryId, note: p.note });
  done(it.id, { action: 'confirmed', txnId, before });
  return S.txn(txnId);
}
function pairNow(it, p, d) {
  const t = d.txn;
  const prev = JSON.parse(JSON.stringify(t));
  const ev = eventOf(p, it.type);
  const [from, to] = d.as === 'pair-in' ? [ev.accountId, t.accountId] : d.as === 'pair-out' ? [t.accountId, ev.accountId] : [p.accountId, p.toAccountId];
  S.saveTxn({ id: t.id, kind: 'transfer', amount: t.amount, date: t.date, note: t.note, accountId: from, toAccountId: to, src: t.src, merchant: t.merchant, ref: t.ref || p.ref, at: t.at, inboxId: t.inboxId, conf: [...(t.conf || []), { via: p.src, inst: p.inst, at: p.at, ref: p.ref, inboxId: it.id }] });
  done(it.id, { action: 'paired', txnId: t.id, prev });
  return S.txn(t.id);
}
// It is that entry: link it ("confirmed by").
export function link(id, txnId) {
  return S.transaction(() => {
    const it = S.inboxItem(id);
    if (!it || !S.txn(txnId)) throw new S.ValidationError("That entry wasn't found", 'txnId');
    return linkNow(it, txnId, it.parsed || {});
  });
}
// It was money moving between your own wallets: a transfer (pairing with the other half when it's there).
export function markTransfer(id, otherAccountId) {
  return S.transaction(() => {
    const it = S.inboxItem(id);
    if (!it?.parsed || !S.account(otherAccountId)) throw new S.ValidationError('Pick the other wallet', 'accountId');
    const p = it.parsed;
    const into = p.kind === 'income' || p.side === 'in';
    const own = p.kind === 'transfer' ? (p.side === 'in' ? p.toAccountId : p.accountId) : p.accountId;
    if (!own || own === otherAccountId) throw new S.ValidationError('Pick a different wallet', 'accountId');
    const q = { ...p, kind: 'transfer', side: into ? 'in' : 'out', accountId: into ? otherAccountId : own, toAccountId: into ? own : otherAccountId, cardId: undefined };
    const d = decide(eventOf(q, it.type), S.db.txns, { windowMin: windowMin() });
    if (d.txn && d.as !== 'same' && d.score >= MAYBE) return pairNow(it, q, d);
    if (d.action === 'confirm' && d.txn.kind === 'transfer') return linkNow(it, d.txn.id, q);
    // A manual entry that was really this transfer: turn that entry into the transfer.
    const mine = it.candidates?.map(S.txn).find((t) => t && (t.kind === 'expense' || t.kind === 'income'));
    if (mine) return pairNow(it, q, { txn: mine, as: into ? 'pair-out' : 'pair-in' });
    const t = S.saveTxn(txnInput(q, id));
    done(id, { action: 'created', txnId: t.id });
    return t;
  });
}
function fixDrift(it) {
  const d = it.drift;
  if (!d || !S.account(d.accountId)) throw new S.ValidationError("That wallet wasn't found", 'accountId');
  // The app showed `reported` at that moment; entries logged since then still count.
  const target = round2(d.reported + (S.accountBalance(d.accountId) - S.balanceAt(d.accountId, d.at)));
  const t = S.fixWalletBalance(d.accountId, target, { date: toISO(new Date(d.at)) > today() ? today() : toISO(new Date(d.at)), note: '', src: 'balance', at: d.at, inboxId: it.id });
  S.setAccountChecked(d.accountId, { amount: d.reported, at: d.at, via: 'balance', ok: true });
  done(it.id, { action: t ? 'fixed' : 'matched', txnId: t?.id });
  return t;
}
export function ignore(ids) {
  return S.transaction(() => { for (const id of [].concat(ids)) { const it = S.inboxItem(id); if (it?.status === 'pending') S.patchInbox(id, { status: 'ignored', decidedAt: Date.now() }); } });
}
// Accepts each; returns { ok, failed: [{ id, message }] } (one that needs editing doesn't stop the rest).
export function acceptMany(ids) {
  const failed = [];
  let ok = 0;
  for (const id of ids) {
    try { accept(id); ok++; } catch (e) { if (e instanceof S.ValidationError) failed.push({ id, message: e.message }); else throw e; }
  }
  return { ok, failed };
}
// Put an ignored item back in Review.
export function restore(id) { return S.patchInbox(id, { status: 'pending', decidedAt: null }); }

// An entry you just typed that an alert already added: { txn } of the alert's entry, or null.
export function duplicateOf(t) {
  if (!t || !['expense', 'income'].includes(t.kind) || (t.src && t.src !== 'manual')) return null;
  const ev = { kind: t.kind, amount: t.amount, at: entryTime(t), date: t.date, accountId: t.cardId ? undefined : t.accountId, cardId: t.cardId, merchant: t.note || t.merchant, via: 'quick' };
  const list = candidates(ev, S.db.txns.filter((x) => x.id !== t.id && ALERT_SRC.includes(x.src)), { windowMin: windowMin() });
  return list[0] && list[0].score >= AUTO && list[0].as === 'same' ? list[0].txn : null;
}
// Keeps the alert's entry, with your category and note, and removes the one you typed.
export function mergeInto(newId, keepId) {
  return S.transaction(() => {
    const n = S.txn(newId), k = S.txn(keepId);
    if (!n || !k) return null;
    S.setTxnFields(keepId, { ...(n.kind === 'expense' && n.categoryId ? { categoryId: n.categoryId } : {}), note: n.note || k.note || null, conf: [...(k.conf || []), { via: 'quick', inst: 'You', at: Date.now() }] });
    S.deleteTxn(newId);
    return S.txn(keepId);
  });
}

// After saving an entry from "Edit": the item is settled by that entry.
export function settledBy(id, txnId) { return S.transaction(() => done(id, { action: 'created', txnId })); }

// Undo something Pitaka did on its own (or a decision): the entry change is reversed, the item returns
// to Review.
export function undoItem(id) {
  return S.transaction(() => {
    const it = S.inboxItem(id);
    if (!it?.result) return false;
    const r = it.result;
    if (r.action === 'created' && r.txnId && S.txn(r.txnId)) S.deleteTxn(r.txnId);
    if (r.action === 'created' && r.debtId && !S.db.txns.some((t) => t.debtId === r.debtId)) { const d = S.debt(r.debtId); if (d && d.type === 'person') S.deleteDebt(r.debtId); }
    if ((r.action === 'confirmed') && r.txnId && S.txn(r.txnId)) S.setTxnFields(r.txnId, r.before || {});
    if (r.action === 'paired' && r.prev && S.txn(r.txnId)) S.saveTxn({ ...r.prev, fx: undefined });
    if (r.action === 'fixed' && r.txnId && S.txn(r.txnId)) S.deleteTxn(r.txnId);
    S.patchInbox(id, { status: it.type === 'test' ? 'test' : 'pending', reason: 'undone', result: null, decidedAt: null });
    return true;
  });
}
export function undoBatch(batch) {
  return S.transaction(() => {
    const items = S.db.inbox.filter((x) => x.batch === batch && (x.status === 'auto' || x.type === 'drift'));
    for (const it of items.reverse()) {
      if (it.type === 'drift') S.patchInbox(it.id, { status: 'ignored', decidedAt: Date.now() });
      else undoItem(it.id);
    }
    return items.length;
  });
}
// After teaching a format: read the waiting items again.
export function reparse(ids) {
  const out = { batch: uid(), ids: [], created: [], confirmed: [], paired: [], review: [], tests: [], duplicates: 0 };
  S.transaction(() => { for (const id of ids) { const it = S.inboxItem(id); if (it?.status === 'pending' && ['sms', 'email', 'wallet', 'text', 'entry'].includes(it.type)) { out.ids.push(id); route(it, out); } } });
  return out;
}

// One line about what an item says, for Review and toasts.
export function describeProposal(p) {
  if (!p || !(p.amount > 0)) return '';
  const w = p.kind === 'transfer' ? `${S.account(p.accountId)?.name || '?'} → ${S.account(p.toAccountId)?.name || '?'}` : walletLabel(p);
  const what = p.kind === 'expense' ? S.cat(p.categoryId).name : p.kind === 'income' ? 'Income' : p.kind === 'transfer' ? 'Transfer' : p.kind === 'collect' ? `${p.person} paid you back` : p.kind === 'lend' ? `Lent to ${p.person || '?'}` : p.kind === 'borrow' ? `Borrowed from ${p.person || '?'}` : p.kind === 'utang' ? `Utang · ${p.person || '?'}` : '';
  return [peso(p.amount), p.merchant && p.kind !== 'transfer' ? p.merchant : '', what, w].filter(Boolean).join(' · ');
}
