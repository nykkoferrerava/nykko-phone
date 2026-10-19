// All data lives on this phone, in IndexedDB behind a small adapter (js/storage.js). Nothing is sent
// anywhere: the inbox relay only hands encrypted items *to* the phone (see relay/).
// No DOM access in this file: it runs unchanged under Node for the logic tests.
import { uid, today, addDays, daysBetween, advance, retreat, round2, PER_MONTH, parseISO, toISO, monthKey, peso, FREQS, DEFAULT_DUE_DAYS } from './util.js';
import { defaultAdapter, legacyAdapter, blockedAdapter, readLegacy, rescueLegacy, LEGACY_KEY, MIGRATED_KEY, lsGet, lsSet, lsDel } from './storage.js';
import { compileTemplate, TEMPLATE_KINDS } from './alerts.js';

const VERSION = 3;
const MAX_AMOUNT = 1e9;

// ---------- errors ----------
// ValidationError: the message is shown to the user as-is. `field` names the input to highlight.
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}
// StoreError: storage refused the write. code 'quota' (full) or 'blocked' (private mode / blocked).
export class StoreError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}
const fail = (message, field) => { throw new ValidationError(message, field); };

export const DEBT_TYPES = {
  card: { label: 'Credit card', icon: '💳' },
  loan: { label: 'Loan', icon: '🏦' },
  installment: { label: 'Installment', icon: '🧾' },
  lending: { label: 'Online lending app', icon: '📱' },
  person: { label: 'Owed to a person', icon: '🤝' },
};
// These have a fixed amount per payment and a set number of payments.
export const isScheduled = (d) => ['loan', 'installment', 'lending'].includes(d.type);

// lend / collect: money you lent to someone and their repayments (receivables, "owed to you").
const TXN_KINDS = ['expense', 'income', 'debt', 'goal', 'adjust', 'transfer', 'lend', 'collect'];
const SOURCES = ['manual', 'quick', 'sms', 'email', 'wallet', 'statement', 'balance'];
const ACCOUNT_KINDS = ['cash', 'ewallet', 'bank'];
const ADJUST_REASONS = ['fee', 'interest', 'penalty', 'correction'];

// [name, emoji, key]. The key stays when a category is renamed, so quick-text synonyms keep working.
const DEFAULT_CATEGORIES = [
  ['Food', '🍜', 'food'], ['Groceries', '🛒', 'groceries'], ['Transport', '🚕', 'transport'], ['Bills & Utilities', '💡', 'bills'],
  ['Load & Internet', '📶', 'load'], ['Shopping', '🛍️', 'shopping'], ['Health', '💊', 'health'], ['Fun', '🎉', 'fun'],
  ['Family', '👨‍👩‍👧', 'family'], ['Personal care', '💈', 'personal'], ['Subscriptions', '📺', 'subscriptions'], ['Other', '📦', 'other'],
];
export const CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c[2]);

// ---------- small helpers ----------
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[\w-]{1,40}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const isISO = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && toISO(parseISO(v)) === v;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const sum = (arr, f) => round2(arr.reduce((s, x) => s + f(x), 0));
// Own, defined, non-dangerous keys only (so a "__proto__" key in input can never reach Object.assign).
function defined(input) {
  const out = {};
  if (!isObj(input)) return out;
  for (const k of Object.keys(input)) if (!BAD_KEYS.has(k) && input[k] !== undefined) out[k] = input[k];
  return out;
}
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.replace(/[₱,\s]/g, ''));
  return NaN;
}
const absent = (v) => v === undefined || v === null || v === '';

// One rule set, two modes: strict (user input -> ValidationError) and lenient (stored/restored data -> repair).
function rules(strict) {
  const bad = (msg, field, fallback) => {
    if (strict) fail(msg, field);
    return fallback;
  };
  return {
    bad,
    number(v, { min = -Infinity, max = Infinity, def = 0, required = false, int = false } = {}, msg, field) {
      if (absent(v)) return required ? bad(msg, field, def) : def;
      const n = toNum(v);
      if (!Number.isFinite(n)) return bad(msg, field, def);
      if (strict && (n < min || n > max || (int && !Number.isInteger(n)))) return bad(msg, field, def);
      return int ? Math.trunc(n) : round2(n);
    },
    oneOf(v, allowed, def, msg, field) {
      if (absent(v)) return def;
      return allowed.includes(v) ? v : bad(msg, field, def);
    },
    name(v, def, msg = 'Enter a name', field = 'name') {
      return str(v, 60) || bad(msg, field, def);
    },
    date(v, { required = false } = {}, msg = 'Pick a valid date', field = 'date') {
      if (absent(v)) return required ? bad(msg, field, null) : null;
      return isISO(v) ? v : bad(msg, field, null);
    },
    dueDays(v) {
      if (absent(v)) return [...DEFAULT_DUE_DAYS];
      const ok = Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(toNum(x)) && toNum(x) >= 1 && toNum(x) <= 31) && toNum(v[0]) !== toNum(v[1]);
      if (!ok) return bad('Pick two different days of the month (1 to 31)', 'dueDays', [...DEFAULT_DUE_DAYS]);
      return v.map(toNum).sort((a, b) => a - b);
    },
  };
}

// ---------- record shapes (shared by the save functions and the load/restore sanitizer) ----------
function shapeCategory(r, strict) {
  const v = rules(strict);
  const c = {
    id: r.id,
    name: v.name(r.name, 'Category'),
    emoji: str(r.emoji, 16) || '📦',
    limit: v.number(r.limit, { min: 0, max: MAX_AMOUNT }, 'Enter a budget amount, or leave it blank', 'limit'),
  };
  if (CATEGORY_KEYS.includes(r.key)) c.key = r.key;
  if (r.hidden === true) c.hidden = true;
  const kw = str(r.keywords, 200).toLowerCase().split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (kw.length) c.keywords = [...new Set(kw)].join(', ');
  return c;
}
function shapeReceivable(r, strict) {
  const v = rules(strict);
  return {
    id: r.id,
    name: v.name(r.name, 'Someone', 'Enter who owes you', 'name'),
    balance: v.number(r.balance, { min: 0, max: MAX_AMOUNT, required: true }, 'Enter how much they owe you', 'balance'),
    original: v.number(r.original, { min: 0, max: MAX_AMOUNT }),
    dueDate: v.date(r.dueDate, {}, 'Pick a valid date', 'dueDate'),
    notes: str(r.notes, 500),
    createdAt: isISO(r.createdAt) ? r.createdAt : today(),
  };
}
function shapeAccount(r, strict) {
  const v = rules(strict);
  return {
    id: r.id,
    name: str(r.name, 40) || v.bad('Enter a name for this wallet', 'name', 'Wallet'),
    kind: ACCOUNT_KINDS.includes(r.kind) ? r.kind : 'cash',
    opening: v.number(r.opening, { min: -MAX_AMOUNT, max: MAX_AMOUNT }, 'Enter the starting balance', 'opening'),
    // null = no cut-off: every entry counts (the default Cash wallet until a starting balance is typed).
    openingDate: v.date(r.openingDate, {}, 'Pick the date of that balance', 'openingDate'),
    ...shapeChecked(r.checked),
  };
}
// The last balance an alert, a balance check or a statement confirmed for a wallet.
function shapeChecked(c) {
  if (!isObj(c) || !Number.isFinite(toNum(c.amount)) || !(Number(c.at) > 0)) return {};
  return { checked: { amount: round2(toNum(c.amount)), at: Math.trunc(Number(c.at)), via: SOURCES.includes(c.via) ? c.via : 'balance', ok: c.ok === true } };
}
// A saved alert format ("Teach this format"): text with {amount}, {merchant}, {balance}, {ref} and {#}.
function shapeTemplate(r, strict) {
  const v = rules(strict);
  const t = {
    id: r.id,
    sender: str(r.sender, 80).toLowerCase() || v.bad('Say who sends these messages', 'sender', '*'),
    format: typeof r.format === 'string' ? r.format.slice(0, 1000) : '',
    kind: TEMPLATE_KINDS.includes(r.kind) ? r.kind : v.bad('Pick what this message means', 'kind', 'expense'),
    label: str(r.label, 60),
    createdAt: isISO(r.createdAt) ? r.createdAt : today(),
    hits: Number.isInteger(r.hits) && r.hits >= 0 ? r.hits : 0,
  };
  try { compileTemplate(t.format); } catch (e) { if (strict) fail(e.message, 'format'); return null; }
  if (isId(r.accountId)) t.accountId = r.accountId;
  if (isId(r.cardId)) t.cardId = r.cardId;
  return t;
}
// "Card ending 1234" or a sender name -> a wallet or a credit card.
function shapeCardMap(r, strict) {
  const v = rules(strict);
  const last4 = /^\d{4}$/.test(String(r.last4 ?? '').trim()) ? String(r.last4).trim() : '';
  const sender = str(r.sender, 80).toLowerCase();
  if (!last4 && !sender) return v.bad('Enter the last 4 digits or the sender name', 'last4', null);
  const m = { id: r.id, label: str(r.label, 60) };
  if (last4) m.last4 = last4;
  if (sender) m.sender = sender;
  if (isId(r.cardId)) m.cardId = r.cardId;
  else if (isId(r.accountId)) m.accountId = r.accountId;
  else return v.bad('Pick the wallet or card', 'target', null);
  return m;
}
function shapeDebt(r, strict) {
  const v = rules(strict);
  const type = v.oneOf(r.type, Object.keys(DEBT_TYPES), strict ? undefined : 'loan', 'Pick what kind of debt this is', 'type') || fail('Pick what kind of debt this is', 'type');
  const sched = isScheduled({ type });
  const money = (val, msg, field, o = {}) => v.number(val, { min: 0, max: MAX_AMOUNT, ...o }, msg, field);
  const d = {
    id: r.id,
    type,
    name: v.name(r.name, 'Debt'),
    lender: str(r.lender, 60),
    balance: money(r.balance, 'Enter how much is left to pay', 'balance', { required: true, min: type === 'card' ? -MAX_AMOUNT : 0 }),
    original: v.number(r.original, {}),
    paymentAmount: money(r.paymentAmount, sched ? 'Enter the amount of each payment' : 'Enter a valid amount', 'paymentAmount', { required: sched, min: sched ? 0.01 : 0 }),
    plannedPayment: money(r.plannedPayment, 'Enter a valid amount', 'plannedPayment'),
    creditLimit: money(r.creditLimit, 'Enter a valid credit limit', 'creditLimit'),
    frequency: v.oneOf(r.frequency, Object.keys(FREQS), 'monthly', 'Pick how often you pay', 'frequency'),
    totalPayments: 0,
    paymentsMade: 0,
    nextDue: v.date(r.nextDue, {}, 'Pick a valid due date', 'nextDue'),
    dueDay: null,
    rate: v.number(r.rate, { min: 0, max: 100 }, 'Enter the interest rate (0 to 100%)', 'rate'),
    notes: str(r.notes, 500),
    createdAt: isISO(r.createdAt) ? r.createdAt : today(),
  };
  d.totalPayments = v.number(r.totalPayments, { min: sched ? 1 : 0, max: 1000, int: true, required: sched }, 'Enter how many payments in total', 'totalPayments');
  d.paymentsMade = v.number(r.paymentsMade, { min: 0, max: sched ? d.totalPayments : 1000, int: true }, "Payments made can't be more than the total", 'paymentsMade');
  const day = toNum(r.dueDay);
  d.dueDay = Number.isInteger(day) && day >= 1 && day <= 31 ? day : d.nextDue ? parseISO(d.nextDue).getDate() : null;
  if (d.frequency === 'semimonthly' && type !== 'card') d.dueDays = v.dueDays(r.dueDays);
  if (!absent(r.minDue)) d.minDue = money(r.minDue, 'Enter a valid minimum due', 'minDue');
  return d;
}
function shapeBill(r, strict) {
  const v = rules(strict);
  const b = {
    id: r.id,
    name: v.name(r.name, 'Bill'),
    amount: v.number(r.amount, { min: 0.01, max: MAX_AMOUNT, required: true }, 'Enter the bill amount', 'amount'),
    frequency: v.oneOf(r.frequency, Object.keys(FREQS), 'monthly', 'Pick how often this bill comes', 'frequency'),
    nextDue: v.date(r.nextDue, { required: strict }, 'Pick the due date', 'nextDue'),
    dueDay: null,
    done: r.done === true,
  };
  if (isId(r.categoryId)) b.categoryId = r.categoryId;
  const day = toNum(r.dueDay);
  b.dueDay = Number.isInteger(day) && day >= 1 && day <= 31 ? day : b.nextDue ? parseISO(b.nextDue).getDate() : null;
  if (b.frequency === 'semimonthly') b.dueDays = v.dueDays(r.dueDays);
  return b;
}
function shapeGoal(r, strict) {
  const v = rules(strict);
  return {
    id: r.id,
    name: v.name(r.name, 'Goal'),
    emoji: str(r.emoji, 16) || '🎯',
    target: v.number(r.target, { min: 0.01, max: MAX_AMOUNT, required: true }, 'Enter the amount you want to save', 'target'),
    saved: v.number(r.saved, { min: 0, max: MAX_AMOUNT }, 'Enter how much is already saved', 'saved'),
    deadline: v.date(r.deadline, {}, 'Pick a valid date', 'deadline'),
    createdAt: isISO(r.createdAt) ? r.createdAt : today(),
  };
}

function defaultSettings(accountId) {
  return {
    onboarded: false, payAnchor: today(), payAmount: 0, pinHash: null, pinSalt: null, lockAfterSec: 60, rawDays: 90, matchWindow: 30,
    hideInstallHint: false, lastCategoryId: null, defaultAccountId: accountId, relayUrl: null,
    lastBackupAt: null, entriesAtBackup: 0, pinFails: 0, pinLockUntil: 0,
  };
}
const boolOr = (v) => (typeof v === 'boolean' ? v : undefined);
const numMin0 = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const SETTINGS_RULES = {
  onboarded: boolOr,
  hideInstallHint: boolOr,
  payAnchor: (v) => (isISO(v) ? v : undefined),
  payAmount: numMin0,
  lockAfterSec: numMin0,
  pinLockUntil: numMin0,
  entriesAtBackup: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
  pinFails: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
  pinHash: (v) => (v === null || typeof v === 'string' ? v : undefined),
  pinSalt: (v) => (v === null || typeof v === 'string' ? v : undefined),
  lastCategoryId: (v) => (v === null || isId(v) ? v : undefined),
  defaultAccountId: (v) => (v === null || isId(v) ? v : undefined),
  lastBackupAt: (v) => (v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? v : undefined),
  theme: (v) => (['system', 'light', 'dark'].includes(v) ? v : undefined),
  rawDays: (v) => (Number.isInteger(v) && v >= 0 && v <= 3650 ? v : undefined), // 0 = keep alert text forever
  matchWindow: (v) => (Number.isInteger(v) && v >= 5 && v <= 720 ? v : undefined), // minutes
  // The relay's address only (its tokens and key are secrets, kept outside db), so a restored backup can
  // offer to pair with the same relay again.
  relayUrl: (v) => (v === null || (typeof v === 'string' && /^https?:\/\/[\w.:-]{3,200}(\/[\w./-]*)?$/.test(v)) ? v : undefined),
};
// Known settings are type-checked; other simple values (UI preferences) are kept as they are.
function cleanSettings(s, base) {
  const out = { ...base };
  if (!isObj(s)) return out;
  for (const k of Object.keys(s)) {
    if (BAD_KEYS.has(k)) continue;
    const v = s[k];
    if (SETTINGS_RULES[k]) {
      const x = SETTINGS_RULES[k](v);
      if (x !== undefined) out[k] = x;
    } else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 500)) {
      out[k] = v;
    }
  }
  return out;
}

function newCashAccount(openingDate = null) {
  return { id: uid(), name: 'Cash', kind: 'cash', opening: 0, openingDate };
}
function blank() {
  const cash = newCashAccount();
  return {
    version: VERSION,
    settings: defaultSettings(cash.id),
    categories: DEFAULT_CATEGORIES.map(([name, emoji, key]) => ({ id: uid(), name, emoji, limit: 0, key })),
    accounts: [cash],
    txns: [],
    debts: [],
    bills: [],
    goals: [],
    debtHistory: {},
    receivables: [],
    dismissed: [],
    templates: [],
    cardMap: [],
    inbox: [],
  };
}

export let db = blank();

// ---------- saving: every change is all-or-nothing ----------
// A change runs in memory inside tx(). If it throws (a ValidationError, a bug), memory is put back exactly
// as it was. Otherwise it is staged and written to storage in one atomic batch right after (quick changes
// share a batch). `await flush()` resolves once everything staged is on disk. If the write fails, memory
// goes back to what storage holds and flush() rejects with a StoreError, so nothing is ever half saved
// and memory never disagrees with storage for long.
//
// The two big collections (txns, inbox) are written record by record, so years of entries are never
// rewritten for one change. Code that changes one of their records in place calls touch() first;
// added() and dropped() record inserts and deletes. Everything else ("core") is small and is compared
// and written as a whole.
const BIG = ['txns', 'inbox'];
const SESSION = uid(); // tells a later launch apart from this one (migration check)
let adapter = null;
let meta = { schema: VERSION };
let seq = 0; // order numbers for big-collection records (their order on disk)
const ord = { txns: new Map(), inbox: new Map() };
let trk = null; // inside tx(): before-images of records this change touched, by collection
const freshStaged = () => ({ core: false, meta: false, rewrite: false, clearSecrets: false, txns: new Set(), inbox: new Set() });
// Undo info back to what storage holds: the core JSON and before-images of records changed since.
// `full`: the data an erase replaced, kept until the erase is on disk. `gen`: which erase this belongs to.
let gen = 0; // bumped by resetAll(): a batch taken before it was for the data the erase replaced
const freshUndo = (core) => ({ core, txns: new Map(), inbox: new Map(), full: null, gen });
let staged = freshStaged();
let undo = freshUndo('');
let writing = false;
let scheduled = false;
let waiters = [];
let failHandler = null;

function storageError(e) {
  if (e instanceof StoreError) return e;
  const quota = !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  return quota
    ? new StoreError("Couldn't save. This phone's storage for Pitaka is full. Export a backup, then try again.", 'quota', e)
    : new StoreError("Couldn't save. Storage is blocked on this phone (for example in private browsing). Export a backup so nothing is lost.", 'blocked', e);
}

function coreOf(d = db) {
  const o = {};
  for (const k of Object.keys(d)) if (!BIG.includes(k)) o[k] = d[k];
  return o;
}
const coreJson = () => JSON.stringify(coreOf());
const plain = (v) => JSON.parse(JSON.stringify(v));
function restoreCore(json) {
  const c = JSON.parse(json);
  for (const k of Object.keys(coreOf())) if (!(k in c)) delete db[k];
  for (const k of Object.keys(c)) if (!BAD_KEYS.has(k)) db[k] = c[k];
}

const image = (coll, rec) => ({ json: JSON.stringify(rec), o: ord[coll].get(rec.id) });
// Call before changing a record of a big collection in place (or before removing it).
function touch(coll, rec) {
  if (trk && rec && !trk[coll].has(rec.id)) trk[coll].set(rec.id, image(coll, rec));
}
// Call before removing a record of a big collection. If the same id is added again it goes to the end.
function dropped(coll, rec) {
  touch(coll, rec);
  ord[coll].delete(rec.id);
}
// Call after adding a new record to a big collection.
function added(coll, rec) {
  if (!ord[coll].has(rec.id)) ord[coll].set(rec.id, ++seq);
  if (trk && !trk[coll].has(rec.id)) trk[coll].set(rec.id, null);
}
// Puts records back to their before-images (null = didn't exist), keeping the on-disk order.
function putBack(coll, images) {
  if (!images.size) return;
  const arr = db[coll];
  const at = new Map(arr.map((r, i) => [r.id, i]));
  const gone = new Set();
  for (const [id, before] of images) {
    const i = at.get(id);
    if (before === null) {
      if (i !== undefined) gone.add(i);
      ord[coll].delete(id);
    } else {
      const rec = JSON.parse(before.json);
      ord[coll].set(id, before.o ?? ++seq);
      if (i !== undefined) arr[i] = rec;
      else arr.push(rec);
    }
  }
  db[coll] = arr.filter((_, i) => !gone.has(i)).sort((a, b) => ord[coll].get(a.id) - ord[coll].get(b.id));
}

let depth = 0;
function tx(fn) {
  if (depth) return fn();
  const before = coreJson();
  trk = { txns: new Map(), inbox: new Map() };
  depth++;
  try {
    const out = fn();
    stage(before);
    return out;
  } catch (e) {
    if (coreJson() !== before) restoreCore(before);
    for (const k of BIG) putBack(k, trk[k]);
    throw e;
  } finally {
    depth--;
    trk = null;
  }
}

function stage(before) {
  if (coreJson() !== before) staged.core = true;
  for (const k of BIG) {
    for (const [id, img] of trk[k]) {
      if (!undo[k].has(id)) undo[k].set(id, img);
      staged[k].add(id);
    }
  }
  if (hasStaged()) schedule();
}
const hasStaged = () => staged.core || staged.meta || staged.rewrite || staged.txns.size > 0 || staged.inbox.size > 0;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; pump(); });
}

// Builds one atomic write from what is staged, copying the data now (memory may change while it runs).
function takeBatch() {
  const s = staged;
  staged = freshStaged();
  const ops = {};
  const imgs = { txns: new Map(), inbox: new Map() };
  const rec = (k, r) => {
    const json = JSON.stringify(r);
    const o = ord[k].get(r.id);
    imgs[k].set(r.id, { json, o });
    return { id: r.id, o, v: JSON.parse(json) };
  };
  let coreJ = null;
  if (s.rewrite || s.core) { coreJ = coreJson(); ops.core = JSON.parse(coreJ); }
  if (s.rewrite || s.meta) ops.meta = plain(meta);
  if (s.rewrite) {
    ops.replace = true;
    if (s.clearSecrets) ops.clearSecrets = true;
    for (const k of BIG) ops[k] = { put: db[k].map((r) => rec(k, r)), del: [] };
  } else {
    for (const k of BIG) {
      if (!s[k].size) continue;
      const live = new Map(db[k].map((r) => [r.id, r]));
      const put = [], del = [];
      for (const id of s[k]) {
        const r = live.get(id);
        if (r) put.push(rec(k, r));
        else { del.push(id); imgs[k].set(id, null); }
      }
      ops[k] = { put, del };
    }
  }
  return { ops, coreJ, imgs, rewrite: s.rewrite, gen };
}

// The batch is on disk: it is the new "what storage holds" for the records it wrote.
function settled(b) {
  // A batch taken before an erase updates the data that erase replaced (what comes back if it fails).
  let u = undo, st = staged;
  while (u.gen !== b.gen && u.full) { st = u.full.staged; u = u.full.undo; }
  if (b.coreJ !== null) u.core = b.coreJ;
  if (b.rewrite) u.full = null; // everything before it is gone from the disk
  for (const k of BIG) {
    const ids = b.rewrite ? new Set([...u[k].keys(), ...b.imgs[k].keys()]) : b.imgs[k].keys();
    for (const id of ids) {
      if (st[k].has(id)) u[k].set(id, b.imgs[k].get(id) ?? null); // changed again since: undo to this batch
      else u[k].delete(id);
    }
  }
}

// The write failed: memory goes back to what storage holds, everyone waiting hears about it.
function failed(err, first) {
  // Back before every erase that hasn't reached the disk.
  let f = null;
  for (let u = undo; u.full; u = u.full.undo) f = u.full;
  if (f) {
    db = f.db;
    ord.txns = f.ord.txns; ord.inbox = f.ord.inbox; seq = Math.max(seq, f.seq);
    undo = f.undo;
  }
  if (coreJson() !== undo.core) restoreCore(undo.core);
  for (const k of BIG) putBack(k, undo[k]);
  staged = freshStaged();
  undo = freshUndo(coreJson());
  const all = [...first, ...waiters];
  waiters = [];
  for (const w of all) w.reject(err);
  try { failHandler?.(err); } catch (e) { console.error(e); }
}

async function pump() {
  if (writing) return;
  writing = true;
  try {
    while (hasStaged()) {
      const batch = takeBatch();
      const ws = waiters;
      waiters = [];
      try {
        await adapter.write(batch.ops);
      } catch (e) {
        failed(storageError(e), ws);
        return;
      }
      settled(batch);
      for (const w of ws) w.resolve();
    }
    const ws = waiters;
    waiters = [];
    for (const w of ws) w.resolve();
  } finally {
    writing = false;
  }
}

// Resolves when every change made so far is on disk; rejects with a StoreError if saving failed (memory
// has then been put back to what is on disk).
export function flush() {
  if (!writing && !scheduled && !hasStaged()) return Promise.resolve();
  if (!adapter) adapter = defaultAdapter();
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}
const settle = () => flush().catch(() => {});
// Called with the StoreError when a write fails (so the UI can say so even if nobody awaited it).
export function setStoreFailHandler(fn) { failHandler = fn; }

// Writes everything in memory, for data changed outside tx() (tests, repairs after loading).
export function save() {
  if (!adapter) adapter = defaultAdapter();
  staged.rewrite = true;
  schedule();
}

// Tests can point the store at their own adapter.
export function useAdapter(a) { adapter = a; }
export const storageInfo = () => ({ kind: adapter?.kind || 'none', migration: meta.migration?.state || null, migratedAt: meta.migration?.at || null });
// Relay tokens and the private key. Never part of `db`, so never in a backup.
export const secrets = {
  get: (k) => (adapter ? adapter.secrets.get(k) : Promise.resolve(undefined)),
  set: (k, v) => adapter.secrets.set(k, v),
  del: (k) => adapter.secrets.del(k),
};

// ---------- load / migration / backup ----------
// The order of on-disk records, with a number for any record that has none.
function install(data, ordMap, m) {
  db = data;
  meta = m;
  ord.txns = new Map();
  ord.inbox = new Map();
  seq = 0;
  for (const k of BIG) for (const o of ordMap?.[k]?.values() || []) if (Number.isFinite(o) && o > seq) seq = o;
  for (const k of BIG) {
    for (const r of db[k]) {
      const o = ordMap?.[k]?.get(r.id);
      ord[k].set(r.id, Number.isFinite(o) ? o : ++seq);
    }
  }
  trk = null;
  staged = freshStaged();
  snap(false);
  undo = freshUndo(coreJson());
}
const indexOrder = (data) => Object.fromEntries(BIG.map((k) => [k, new Map((data[k] || []).map((r, i) => [r.id, i + 1]))]));
function fromSnapshot(snap) {
  const ordMap = {};
  const data = { ...(isObj(snap.core) ? snap.core : {}) };
  for (const k of BIG) {
    const recs = (Array.isArray(snap[k]) ? snap[k] : []).filter(isObj).sort((a, b) => (a.o || 0) - (b.o || 0));
    data[k] = recs.map((r) => r.v);
    ordMap[k] = new Map(recs.map((r) => [r.v?.id, r.o]));
  }
  return { data, ordMap };
}
const recsOf = (data, k) => data[k].map((v, i) => ({ id: v.id, o: i + 1, v: plain(v) }));
const fullOps = (data, m) => ({ replace: true, meta: plain(m), core: plain(coreOf(data)), txns: { put: recsOf(data, 'txns') }, inbox: { put: recsOf(data, 'inbox') } });
// JSON with sorted keys, so two copies of the same data compare equal whatever order fields were set in.
const stable = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x?.id === b[i].id);
const canUseLocalStorage = () => { try { const k = 'pitaka.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch { return false; } };

// Opens the saved data. The first v3 launch copies v2's localStorage data into IndexedDB, reads it back
// and compares; v2's key is left untouched until a later launch finds the copy intact. If IndexedDB
// can't be used, Pitaka keeps working from v2's key (in v2's format).
// Returns { ok: true, migrated?, verified?, reverted?, lost?, fallback? } or { ok: false, reason, rescuedKey? }.
export async function load() {
  await settle();
  if (!adapter) adapter = defaultAdapter();
  if (adapter.kind === 'localstorage') return loadLegacyMode();
  let snapIn;
  try {
    snapIn = await adapter.read();
  } catch (e) {
    console.error('Storage could not be opened', e);
    // After the move to IndexedDB, v2's key is out of date (or gone). Opening it instead would show old or
    // no data, and what was entered then would be lost when IndexedDB opens again: save nothing this time.
    if (!canUseLocalStorage() || lsGet(MIGRATED_KEY)) {
      adapter = blockedAdapter();
      install(blank(), null, { schema: VERSION });
      return { ok: false, reason: 'blocked' };
    }
    adapter = legacyAdapter();
    return { ...(await loadLegacyMode()), fallback: true };
  }
  if (snapIn) return fromStore(snapIn);
  return migrateOrStart();
}

async function fromStore(snapIn) {
  const { data, ordMap } = fromSnapshot(snapIn);
  const clean = sanitize(data);
  const repaired = BIG.some((k) => !sameIds(data[k], clean[k])) || stable(coreOf(clean)) !== stable(isObj(snapIn.core) ? snapIn.core : null);
  install(clean, ordMap, isObj(snapIn.meta) ? snapIn.meta : { schema: VERSION });
  const out = { ok: true };
  if (repaired) save();
  const mig = meta.migration;
  if (mig?.state === 'copied' && mig.session !== SESSION) {
    // A later launch found the IndexedDB copy: the migration is verified and v2's key can go.
    meta.migration = { ...mig, state: 'verified', verifiedAt: new Date().toISOString() };
    staged.meta = true;
    schedule();
    try {
      await flush();
      lsDel(LEGACY_KEY);
      out.verified = true;
    } catch (e) {
      console.error('Could not record the verified migration', e);
    }
  }
  return out;
}

async function migrateOrStart() {
  const legacy = readLegacy();
  if (legacy.state === 'ok') return migrate(legacy);
  const lost = !!lsGet(MIGRATED_KEY) && legacy.state === 'absent';
  install(blank(), null, { schema: VERSION, createdAt: new Date().toISOString() });
  if (legacy.state === 'unreadable') {
    console.error('Saved data could not be read; a copy was kept');
    return { ok: false, reason: 'unreadable', rescuedKey: rescueLegacy(legacy.raw) };
  }
  return lost ? { ok: true, lost: true } : { ok: true };
}

async function migrate(legacy) {
  const data = sanitize(legacy.data);
  const at = new Date().toISOString();
  const m = { schema: VERSION, createdAt: at, migration: { from: 'localStorage', at, session: SESSION, state: 'copied', txns: data.txns.length } };
  const reverted = !!lsGet(MIGRATED_KEY);
  try {
    await adapter.write(fullOps(data, m));
    const back = await adapter.read();
    const again = back && sanitize(fromSnapshot(back).data);
    if (!again || stable(again) !== stable(data)) throw Object.assign(new Error('The copy in IndexedDB did not match'), { name: 'VerifyError' });
  } catch (e) {
    console.error('Could not move the data to IndexedDB; staying on localStorage', e);
    try { await adapter.clear(); } catch { /* nothing more to do */ }
    adapter = legacyAdapter();
    return { ...(await loadLegacyMode()), fallback: true };
  }
  lsSet(MIGRATED_KEY, at);
  install(data, indexOrder(data), m);
  return reverted ? { ok: true, migrated: true, reverted: true } : { ok: true, migrated: true };
}

// Fallback: v2's key is the store. Unreadable data is copied aside first and never written over.
async function loadLegacyMode() {
  const legacy = readLegacy();
  if (legacy.state === 'blocked') {
    adapter = blockedAdapter();
    install(blank(), null, { schema: VERSION });
    return { ok: false, reason: 'blocked' };
  }
  if (legacy.state === 'unreadable') {
    console.error('Saved data could not be read; a copy was kept');
    const rescuedKey = rescueLegacy(legacy.raw);
    if (!rescuedKey) adapter = blockedAdapter(); // no copy could be made: never write over it
    install(blank(), null, { schema: VERSION });
    return { ok: false, reason: 'unreadable', rescuedKey };
  }
  if (legacy.state === 'absent') {
    install(blank(), null, { schema: VERSION });
    return { ok: true };
  }
  const data = sanitize(legacy.data);
  install(data, indexOrder(data), isObj(legacy.data._meta) ? legacy.data._meta : { schema: VERSION });
  // v2's key keeps entries by id: ones that got an id just now are written back, or the next save would
  // merge every entry that had none into one.
  if (BIG.some((k) => !sameIds(list(legacy.data[k]), data[k]))) save();
  return { ok: true };
}

export function exportBackup() {
  const out = JSON.parse(JSON.stringify(db));
  for (const k of ['pinHash', 'pinSalt', 'pinFails', 'pinLockUntil']) delete out.settings[k];
  out.app = 'pitaka';
  out.exportedAt = new Date().toISOString();
  return JSON.stringify(out);
}

export function markBackedUp() {
  tx(() => {
    db.settings.lastBackupAt = new Date().toISOString();
    db.settings.entriesAtBackup = db.txns.length;
  });
}

const localDay = (ms) => toISO(new Date(ms));
export function backupStatus() {
  const total = db.txns.length + db.debts.length + db.bills.length + db.goals.length;
  const last = Date.parse(db.settings.lastBackupAt || '');
  const backed = Number.isFinite(last);
  const daysSince = backed ? daysBetween(localDay(last), today()) : null;
  const newEntries = backed ? db.txns.filter((t) => t.createdAt > last).length : total;
  let age = daysSince;
  if (!backed) {
    // Never backed up: count from the first thing entered.
    const starts = [
      ...db.txns.map((t) => t.createdAt).filter((x) => x > 0).map(localDay),
      ...db.debts.map((d) => d.createdAt), ...db.goals.map((g) => g.createdAt),
    ].filter(isISO).sort();
    age = starts.length ? daysBetween(starts[0], today()) : 0;
  }
  return { due: total > 0 && (age >= 14 || newEntries >= 40), daysSince, newEntries };
}

// Restores a backup: written to storage first, so a failure leaves both memory and storage untouched.
export async function replaceAll(data) {
  if (!isObj(data) || !Array.isArray(data.txns)) fail("This isn't a Pitaka backup file.");
  const next = sanitize(data);
  // Restoring never brings back a PIN: the usual reason to restore is a forgotten PIN.
  Object.assign(next.settings, { pinHash: null, pinSalt: null, pinFails: 0, pinLockUntil: 0 });
  await settle();
  if (!adapter) adapter = defaultAdapter();
  const m = { ...meta, schema: VERSION, restoredAt: new Date().toISOString() };
  if (m.migration?.state === 'copied') m.migration = { ...m.migration, state: 'replaced' };
  try {
    await adapter.write(fullOps(next, m));
  } catch (e) {
    throw storageError(e);
  }
  install(next, indexOrder(next), m);
  if (adapter.kind !== 'localstorage') lsDel(LEGACY_KEY); // the pre-update copy is out of date now
}

// Erases everything, including the relay pairing. `await flush()` to know it reached the disk.
export function resetAll() {
  if (!adapter) adapter = defaultAdapter();
  const prev = { db, ord: { txns: ord.txns, inbox: ord.inbox }, seq, undo, staged };
  gen++;
  if (adapter.kind !== 'localstorage') lsDel(LEGACY_KEY);
  lsDel(MIGRATED_KEY);
  db = blank();
  meta = { schema: VERSION, createdAt: new Date().toISOString() };
  ord.txns = new Map();
  ord.inbox = new Map();
  undo = freshUndo(coreJson());
  undo.full = prev;
  staged = freshStaged();
  staged.rewrite = true;
  staged.clearSecrets = true;
  schedule();
}

// Repairs anything stored or restored so a bad record can never brick the app. Also migrates v1 -> v2 -> v3.
function sanitize(data) {
  const base = blank();
  const fixIds = (arr) => {
    const seen = new Set();
    for (const x of arr) {
      if (!isId(x.id) || seen.has(x.id)) do x.id = uid(); while (seen.has(x.id));
      seen.add(x.id);
    }
    return arr;
  };
  const out = {
    version: VERSION,
    settings: cleanSettings(data.settings, base.settings),
    categories: Array.isArray(data.categories) ? fixIds(list(data.categories).map((r) => shapeCategory(r, false))) : base.categories,
    receivables: fixIds(list(data.receivables).map((r) => shapeReceivable(r, false))),
    accounts: fixIds(list(data.accounts).map((r) => shapeAccount(r, false))),
    txns: [],
    debts: fixIds(list(data.debts).map((r) => shapeDebt(r, false))),
    bills: fixIds(list(data.bills).map((r) => shapeBill(r, false))),
    goals: fixIds(list(data.goals).map((r) => shapeGoal(r, false))),
    debtHistory: {},
    dismissed: (Array.isArray(data.dismissed) ? data.dismissed : []).filter((x) => typeof x === 'string' && x.length <= 120).slice(-200),
    templates: fixIds(list(data.templates).map((r) => shapeTemplate(r, false)).filter(Boolean)),
    cardMap: fixIds(list(data.cardMap).map((r) => shapeCardMap(r, false)).filter(Boolean)),
    inbox: [],
  };
  // Categories from before v3 get their built-in key back by name (only one category per key).
  const keyed = new Set(out.categories.map((c) => c.key).filter(Boolean));
  for (const c of out.categories) {
    if (c.key) continue;
    const d = DEFAULT_CATEGORIES.find(([name]) => name.toLowerCase() === c.name.toLowerCase());
    if (d && !keyed.has(d[2])) { c.key = d[2]; keyed.add(d[2]); }
  }
  out.txns = fixIds(list(data.txns).map((r) => cleanTxn(r, out)).filter(Boolean));
  out.inbox = fixIds(list(data.inbox).map(cleanInbox).filter(Boolean));

  // v1 had no wallets: everything that was cash goes into one "Cash" wallet from the first entry on.
  if (!out.accounts.length) out.accounts.push(newCashAccount(out.txns.map((t) => t.date).sort()[0] || null));
  const hasAccount = (id) => out.accounts.some((a) => a.id === id);
  if (!hasAccount(out.settings.defaultAccountId)) out.settings.defaultAccountId = out.accounts[0].id;
  const fallback = out.settings.defaultAccountId;
  out.txns = out.txns.filter((t) => {
    if (t.kind === 'transfer') return hasAccount(t.accountId) && hasAccount(t.toAccountId) && t.accountId !== t.toAccountId;
    if ((t.kind === 'adjust' && !t.accountId) || (t.kind === 'expense' && t.cardId)) return true;
    if (!hasAccount(t.accountId)) t.accountId = fallback;
    return true;
  });

  if (isObj(data.debtHistory)) {
    for (const k of Object.keys(data.debtHistory)) {
      const v = toNum(data.debtHistory[k]);
      if (isISO(k) && Number.isFinite(v)) out.debtHistory[k] = round2(v);
    }
  }
  return out;
}

function cleanFx(fx) {
  if (!isObj(fx)) return null;
  const n = (v) => (Number.isFinite(toNum(v)) ? round2(toNum(v)) : 0);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const iso = (v) => (isISO(v) ? v : null);
  const freq = (v) => (FREQS[v] ? v : 'monthly');
  const out = {};
  const part = (k) => (isObj(fx[k]) && isId(fx[k].id) ? fx[k] : null);
  let p;
  if ((p = part('card'))) out.card = { id: p.id, amount: n(p.amount) };
  if ((p = part('bill'))) out.bill = { id: p.id, from: iso(p.from), to: iso(p.to), freq: freq(p.freq) };
  if ((p = part('debt'))) out.debt = { id: p.id, amount: n(p.amount), counted: int(p.counted), steps: int(p.steps), from: iso(p.from), to: iso(p.to), freq: freq(p.freq) };
  if ((p = part('adjust'))) out.adjust = { id: p.id, delta: n(p.delta) };
  if ((p = part('goal'))) out.goal = { id: p.id, delta: n(p.delta) };
  if ((p = part('recv'))) out.recv = { id: p.id, delta: n(p.delta) };
  return out;
}

function cleanTxn(r, data) {
  if (!TXN_KINDS.includes(r.kind) || !isISO(r.date)) return null;
  const amount = round2(toNum(r.amount));
  if (!(amount > 0)) return null;
  const ref = (v) => (isId(v) ? v : undefined);
  const t = { id: r.id, kind: r.kind, amount, date: r.date, note: str(r.note, 200), createdAt: Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : 0 };
  Object.assign(t, cleanCapture(r));
  switch (r.kind) {
    case 'expense':
      Object.assign(t, { categoryId: ref(r.categoryId), cardId: ref(r.cardId), billId: ref(r.billId) });
      if (!t.cardId) t.accountId = ref(r.accountId);
      break;
    case 'income': t.accountId = ref(r.accountId); break;
    case 'debt': {
      const n = toNum(r.installments);
      Object.assign(t, { debtId: ref(r.debtId), accountId: ref(r.accountId), installments: Number.isInteger(n) && n >= 0 ? n : r.countsInstallment || r.advanceDue ? 1 : 0 });
      break;
    }
    case 'goal': Object.assign(t, { goalId: ref(r.goalId), accountId: ref(r.accountId), withdraw: truthy(r.withdraw) }); break;
    case 'adjust':
      if (r.direction !== 'up' && r.direction !== 'down') return null;
      // A wallet balance fix has a wallet and no debt; it is always a correction.
      if (!ref(r.debtId) && ref(r.accountId)) Object.assign(t, { accountId: ref(r.accountId), direction: r.direction, reason: 'correction' });
      else Object.assign(t, { debtId: ref(r.debtId), direction: r.direction, reason: ADJUST_REASONS.includes(r.reason) ? r.reason : 'correction' });
      break;
    case 'transfer': Object.assign(t, { accountId: ref(r.accountId), toAccountId: ref(r.toAccountId) }); break;
    case 'lend': case 'collect': Object.assign(t, { receivableId: ref(r.receivableId), accountId: ref(r.accountId) }); break;
  }
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  // Entries whose debt, goal or receivable was deleted stay, marked as such (BUG-08).
  const debtRef = t.debtId || t.cardId;
  const unlinked = (t.kind === 'debt' && !t.debtId) || (t.kind === 'adjust' && !t.debtId && !t.accountId) || (t.kind === 'goal' && !t.goalId) || ((t.kind === 'lend' || t.kind === 'collect') && !t.receivableId); // v1 deleteDebt removed the link
  const recvGone = t.receivableId && !(data.receivables || []).some((x) => x.id === t.receivableId);
  if (r.orphan === true || unlinked || (debtRef && !data.debts.some((d) => d.id === debtRef)) || (t.goalId && !data.goals.some((g) => g.id === t.goalId)) || recvGone) {
    t.orphan = true;
    if (t.goalId) t.goalName = str(r.goalName, 60);
    else if (t.kind === 'lend' || t.kind === 'collect') t.personName = str(r.personName, 60);
    else t.debtName = str(r.debtName, 60);
  }
  t.fx = cleanFx(r.fx) || legacyFx({ ...t, prevDue: r.prevDue, countsInstallment: r.countsInstallment, advanceDue: r.advanceDue }, data);
  return t;
}

// Inbox items: what arrived from the relay, the Files catch-up or an import, with what Pitaka made of it.
// The content is untrusted (alert text); only known fields of limited size are kept.
export const INBOX_TYPES = ['entry', 'text', 'sms', 'email', 'wallet', 'balance', 'test', 'drift'];
const INBOX_STATUS = ['pending', 'auto', 'done', 'ignored', 'test'];
const RAW_FIELDS = { sender: 80, text: 4000, from: 200, subject: 300, body: 8000, merchant: 120, card: 60, name: 60, wallet: 60, category: 60, note: 200, amount: 40, source: 30 };
function plainSmall(v, max = 4000) {
  if (!isObj(v)) return undefined;
  try { const j = JSON.stringify(v); return j.length <= max ? JSON.parse(j, (k, x) => (BAD_KEYS.has(k) ? undefined : x)) : undefined; } catch { return undefined; }
}
function cleanInbox(r) {
  if (!isId(r.id) || !INBOX_TYPES.includes(r.type)) return null;
  const ms = (v) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  const out = { id: r.id, type: r.type, cid: str(r.cid, 64), src: str(r.src, 12) || 'relay', status: INBOX_STATUS.includes(r.status) ? r.status : 'pending', at: ms(r.at), receivedAt: ms(r.receivedAt) };
  const raw = {};
  if (isObj(r.raw)) for (const [k, max] of Object.entries(RAW_FIELDS)) { const x = str(r.raw[k], max); if (x) raw[k] = x; }
  out.raw = raw;
  for (const k of ['reason']) { const x = str(r[k], 24); if (x) out[k] = x; }
  for (const k of ['parsed', 'result', 'drift']) { const x = plainSmall(r[k]); if (x) out[k] = x; }
  if (Array.isArray(r.candidates)) out.candidates = r.candidates.filter(isId).slice(0, 10);
  for (const k of ['batch', 'source']) if (isId(r[k])) out[k] = r[k];
  if (ms(r.decidedAt)) out.decidedAt = ms(r.decidedAt);
  if (r.trimmed === true) out.trimmed = true;
  return out;
}

// Where an entry came from and what confirmed it (quick add, alerts, statements). All optional.
//   src: how it was entered; merchant; ref: reference number; at: time of the event (ms);
//   conf: [{ via, inst, at, ref }] confirmations ("✓ confirmed by GCash"); inboxId: the item it came from.
function cleanCapture(r) {
  const out = {};
  if (SOURCES.includes(r.src)) out.src = r.src;
  const m = str(r.merchant, 80);
  if (m) out.merchant = m;
  const ref = str(r.ref, 40);
  if (ref && /^[\w./:-]+$/.test(ref)) out.ref = ref;
  if (Number.isFinite(r.at) && r.at > 0) out.at = Math.trunc(r.at);
  if (isId(r.inboxId)) out.inboxId = r.inboxId;
  if (Array.isArray(r.conf)) {
    const conf = r.conf.filter(isObj).slice(0, 8).map((c) => {
      const x = { via: SOURCES.includes(c.via) ? c.via : 'sms', inst: str(c.inst, 40) };
      if (Number.isFinite(c.at)) x.at = Math.trunc(c.at);
      const cr = str(c.ref, 40);
      if (cr && /^[\w./:-]+$/.test(cr)) x.ref = cr;
      if (isId(c.inboxId)) x.inboxId = c.inboxId;
      return x;
    });
    if (conf.length) out.conf = conf;
  }
  return out;
}
const CAPTURE_KEYS = ['src', 'merchant', 'ref', 'at', 'inboxId', 'conf'];

// ---------- lookups ----------
export const cat = (id) => db.categories.find((c) => c.id === id) || { name: 'Uncategorized', emoji: '❔' };
export const debt = (id) => db.debts.find((d) => d.id === id);
export const goal = (id) => db.goals.find((g) => g.id === id);
export const bill = (id) => db.bills.find((b) => b.id === id);
export const account = (id) => db.accounts.find((a) => a.id === id);
export const receivable = (id) => (db.receivables || []).find((r) => r.id === id);
export const visibleCategories = () => db.categories.filter((c) => !c.hidden);

// Replace an existing record's contents in place (callers may hold a reference to it).
function overwrite(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  return Object.assign(target, src);
}

// ---------- wallets ----------
export function defaultAccountId() {
  const id = db.settings.defaultAccountId;
  return account(id) ? id : db.accounts[0]?.id ?? null;
}

// Money in or out of wallet `id` for one entry. Card purchases and debt adjustments are not cash.
function cashDelta(t, id) {
  switch (t.kind) {
    case 'income': return t.accountId === id ? t.amount : 0;
    case 'expense': return !t.cardId && t.accountId === id ? -t.amount : 0;
    case 'debt': return t.accountId === id ? -t.amount : 0;
    case 'goal': return t.accountId === id ? (t.withdraw ? t.amount : -t.amount) : 0;
    case 'transfer': return (t.toAccountId === id ? t.amount : 0) - (t.accountId === id ? t.amount : 0);
    case 'adjust': return t.accountId === id ? (t.direction === 'up' ? t.amount : -t.amount) : 0;
    case 'lend': return t.accountId === id ? -t.amount : 0;
    case 'collect': return t.accountId === id ? t.amount : 0;
    default: return 0;
  }
}
// The opening balance is the balance at the start of openingDate; entries before it are already in it.
export function accountBalance(id) {
  const a = account(id);
  if (!a) return 0;
  let s = a.opening;
  for (const t of db.txns) if (!a.openingDate || t.date >= a.openingDate) s += cashDelta(t, id);
  return round2(s);
}
export const totalCash = () => sum(db.accounts, (a) => accountBalance(a.id));

export function saveAccount(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? account(input.id) : null;
    const patch = defined(input);
    const a = shapeAccount({ ...(existing || {}), ...patch }, true);
    a.id = existing ? existing.id : uid();
    // A new wallet's starting balance is as of today unless a date is given. Editing keeps the date,
    // so "balance now" corrections can move `opening` by the difference.
    if (!existing && patch.openingDate === undefined) a.openingDate = today();
    if (existing) return overwrite(existing, a);
    db.accounts.push(a);
    return a;
  });
}

export function deleteAccount(id) {
  return tx(() => {
    if (!account(id)) return;
    if (db.txns.some((t) => t.accountId === id || t.toAccountId === id)) fail('This wallet has entries. Move or delete them first.', 'id');
    if (db.accounts.length <= 1) fail('You need at least one wallet.', 'id');
    db.accounts = db.accounts.filter((a) => a.id !== id);
    if (db.settings.defaultAccountId === id) db.settings.defaultAccountId = db.accounts[0].id;
  });
}

// Wallet balance as it was at a moment (ms): earlier days, plus entries of that day up to that time.
export function balanceAt(id, ms) {
  const a = account(id);
  if (!a) return 0;
  const day = toISO(new Date(ms));
  let s = a.opening;
  // On that day, an entry counts if it happened before `ms`. Its time is `at` (from an alert or statement)
  // or when it was saved that same day; an entry added on a later day for that day has no known time and
  // counts as earlier.
  const when = (t) => t.at || (t.createdAt && toISO(new Date(t.createdAt)) === t.date ? t.createdAt : 0);
  for (const t of db.txns) {
    if (a.openingDate && t.date < a.openingDate) continue;
    if (t.date < day || (t.date === day && when(t) <= ms)) s += cashDelta(t, id);
  }
  return round2(s);
}

// Records a visible, undoable "Balance fix" so the wallet shows `target` (as the bank or e-wallet app does).
// Returns the entry, or null when the balance already matches.
export function fixWalletBalance(id, target, { date = today(), note = '', src, at, inboxId } = {}) {
  const a = account(id);
  if (!a) fail('Pick a wallet', 'accountId');
  const want = toNum(target);
  if (!Number.isFinite(want) || Math.abs(want) > MAX_AMOUNT) fail('Enter the balance the app shows', 'balance');
  const delta = round2(round2(want) - accountBalance(id));
  if (!delta) return null;
  return saveTxn({ kind: 'adjust', accountId: id, direction: delta > 0 ? 'up' : 'down', amount: Math.abs(delta), reason: 'correction', date, note, src, at, inboxId });
}

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

// Payday is every second Friday. "When is your next payday?" can only be one of the next two Fridays
// (today counts when today is a Friday): any later Friday is the same 2-week cycle as one of them.
export const isFriday = (iso) => isISO(iso) && parseISO(iso).getDay() === 5;
export function paydayChoices(from = today()) {
  const out = [];
  for (let d = from; out.length < 2; d = addDays(d, 1)) if (parseISO(d).getDay() === 5) out.push(d);
  return out;
}
export function setPayday(iso, payAmount) {
  return tx(() => {
    if (!isISO(iso)) fail('Pick your next payday', 'payAnchor');
    if (!isFriday(iso)) fail('Payday is a Friday. Pick one of the Fridays shown.', 'payAnchor');
    const n = daysBetween(today(), iso);
    if (n < 0 || n > 13) fail('Pick the next payday: this Friday or the one after', 'payAnchor');
    db.settings.payAnchor = iso;
    if (payAmount !== undefined) db.settings.payAmount = rules(true).number(payAmount, { min: 0, max: MAX_AMOUNT }, 'Check the paycheck amount', 'payAmount');
  });
}
// { next, days, isToday }: the next payday (today counts on payday itself).
export function paydayInfo(iso = today()) {
  const p = period(iso);
  if (p.start === iso) return { next: iso, days: 0, isToday: true };
  return { next: p.next, days: daysBetween(iso, p.next), isToday: false };
}

// ---------- debts ----------
const debtFreq = (d) => (d.type === 'card' ? 'monthly' : FREQS[d.frequency] ? d.frequency : 'monthly');
// What one payment of this debt normally is.
const dueAmount = (d) => (d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment) || d.balance;

export function paymentsLeft(d) {
  if (!(d.balance > 0)) return 0;
  if (isScheduled(d)) {
    // Penalties or fees can leave a balance after the last scheduled payment: still at least 1 to go.
    const bySchedule = (d.totalPayments || 0) - (d.paymentsMade || 0);
    const byBalance = d.paymentAmount > 0 ? Math.ceil(round2(d.balance / d.paymentAmount) - 1e-9) : 1;
    return Math.max(1, bySchedule, byBalance);
  }
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
  if (!left || left === Infinity) return null;
  const freq = debtFreq(d);
  if (!d.nextDue) {
    // Undated debts (e.g. owed to a person) are estimated as monthly payments starting a month from now.
    if (freq !== 'monthly') return null;
    let date = advance(today(), 'monthly');
    for (let i = 1; i < left; i++) date = advance(date, 'monthly');
    return date;
  }
  if (freq === 'once') return d.nextDue;
  let date = d.nextDue;
  for (let i = 1; i < left; i++) date = advance(date, freq, d.dueDay, d.dueDays) || date;
  return date;
}

export const totalDebt = () => sum(db.debts, (d) => Math.max(0, d.balance));

export function monthlyObligations() {
  let s = 0;
  for (const d of db.debts) {
    if (!(d.balance > 0)) continue;
    let m;
    if (d.type === 'card') m = d.plannedPayment || d.paymentAmount || 0;
    else if (d.type === 'person') m = d.plannedPayment || 0;
    else if (debtFreq(d) === 'once') m = !d.nextDue || daysBetween(today(), d.nextDue) <= 31 ? d.paymentAmount || d.balance : 0;
    else m = (d.paymentAmount || 0) * (PER_MONTH[debtFreq(d)] ?? 1);
    s += Math.min(m, d.balance);
  }
  return round2(s);
}

// Records today's total debt for the chart.
function snap(force = true) {
  const t = today();
  if (!force && db.debtHistory[t] !== undefined) return;
  db.debtHistory[t] = totalDebt();
}
export function snapshotDebt(force = true) {
  if (!force) return snap(false);
  tx(() => snap(true));
}

const paidOn = (id) => sum(db.txns.filter((t) => t.kind === 'debt' && t.debtId === id && !t.orphan), (t) => t.amount);
const scheduleTotal = (d) => (isScheduled(d) ? round2((d.paymentAmount || 0) * (d.totalPayments || 0)) : 0);

export function saveDebt(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? debt(input.id) : null;
    const d = shapeDebt({ ...(existing ? JSON.parse(JSON.stringify(existing)) : {}), ...defined(input) }, true);
    d.id = existing ? existing.id : uid();
    d.createdAt = existing ? existing.createdAt : today();
    // Keep the intended day (e.g. the 31st after a February date) unless the user picked a new date.
    if (!d.nextDue) d.dueDay = null;
    else if (!existing || d.nextDue !== existing.nextDue || !existing.dueDay) d.dueDay = parseISO(d.nextDue).getDate();
    else d.dueDay = existing.dueDay;
    // "% paid off" baseline. A corrected balance resets it to balance + what was really paid (BUG-17).
    const sched = scheduleTotal(d);
    if (!existing) d.original = Math.max(d.original || 0, d.balance, sched);
    else if (d.balance !== existing.balance || sched !== scheduleTotal(existing)) d.original = Math.max(round2(d.balance + paidOn(d.id)), sched);
    else d.original = Math.max(existing.original || 0, d.balance, sched);
    const out = existing ? overwrite(existing, d) : (db.debts.push(d), d);
    snap();
    return out;
  });
}

// Payments and card purchases stay in Activity, marked as belonging to a deleted debt.
export function deleteDebt(id) {
  return tx(() => {
    const d = debt(id);
    if (!d) return;
    db.debts = db.debts.filter((x) => x.id !== id);
    for (const t of db.txns) {
      if (t.debtId === id || t.cardId === id) { touch('txns', t); t.orphan = true; t.debtName = d.name; }
    }
    snap();
  });
}

// How many scheduled payments `amount` covers: 0 if less than one payment.
export function suggestInstallments(debtId, amount) {
  const d = debt(debtId);
  const a = Number(amount);
  if (!d || !(d.balance > 0) || !(a > 0)) return 0;
  if (d.type === 'card') return a + 0.001 >= (d.paymentAmount || 0) ? 1 : 0; // one statement per month
  const per = isScheduled(d) ? d.paymentAmount : d.plannedPayment || d.paymentAmount;
  if (!(per > 0)) return d.nextDue ? 1 : 0;
  const n = Math.floor((a + 0.001) / per);
  const left = paymentsLeft(d);
  return Number.isFinite(left) && left > 0 ? Math.min(n, left) : n;
}

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
export function debtActivity(debtId) {
  return db.txns
    .filter((t) => ((t.kind === 'debt' || t.kind === 'adjust') && t.debtId === debtId) || (t.kind === 'expense' && t.cardId === debtId))
    .sort(byNewest);
}

// ---------- bills, goals, categories ----------
export function saveBill(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? bill(input.id) : null;
    const b = shapeBill({ ...(existing ? JSON.parse(JSON.stringify(existing)) : {}), ...defined(input) }, true);
    b.id = existing ? existing.id : uid();
    if (!existing || b.nextDue !== existing.nextDue || !existing.dueDay) b.dueDay = parseISO(b.nextDue).getDate();
    else b.dueDay = existing.dueDay;
    if (existing && b.nextDue !== existing.nextDue) b.done = false; // a new date means it is due again
    if (existing) return overwrite(existing, b);
    db.bills.push(b);
    return b;
  });
}
export function deleteBill(id) {
  return tx(() => { db.bills = db.bills.filter((b) => b.id !== id); });
}
// One tap from Home: records the bill's usual amount from a wallet (or card) and moves it to its next date.
export function payBill(id, { accountId, cardId, date = today(), amount } = {}) {
  const b = bill(id);
  if (!b) fail("That bill wasn't found", 'billId');
  return saveTxn({ kind: 'expense', amount: amount ?? b.amount, categoryId: b.categoryId, billId: b.id, note: b.name, date, accountId: cardId ? undefined : accountId, cardId });
}

// ---------- money owed to you (receivables) ----------
export function saveReceivable(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? receivable(input.id) : null;
    const r = shapeReceivable({ ...(existing ? JSON.parse(JSON.stringify(existing)) : { balance: 0 }), ...defined(input) }, true);
    r.id = existing ? existing.id : uid();
    r.createdAt = existing ? existing.createdAt : today();
    if (!existing) r.original = Math.max(r.original || 0, r.balance);
    if (existing) return overwrite(existing, r);
    db.receivables.push(r);
    return r;
  });
}
// Entries stay in Activity, marked as belonging to someone who is no longer listed.
export function deleteReceivable(id) {
  return tx(() => {
    const r = receivable(id);
    if (!r) return;
    db.receivables = db.receivables.filter((x) => x.id !== id);
    for (const t of db.txns) if (t.receivableId === id) { touch('txns', t); t.orphan = true; t.personName = r.name; }
  });
}
const samePerson = (a, b) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
export const findReceivable = (name) => {
  const all = (db.receivables || []).filter((r) => samePerson(r.name, String(name || '')));
  return all.find((r) => r.balance > 0) || all[0] || null;
};
// You lent money: adds to what `name` (or receivableId) owes you, taking it from a wallet.
export function lend({ receivableId, name, amount, accountId, date = today(), note = '', dueDate, ...capture } = {}) {
  return tx(() => {
    let r = receivableId ? receivable(receivableId) : findReceivable(name);
    if (!r) {
      if (!str(name, 60)) fail('Enter who you lent money to', 'name');
      r = saveReceivable({ name, balance: 0, dueDate: dueDate || null });
    } else if (dueDate) r.dueDate = rules(true).date(dueDate, {}, 'Pick a valid date', 'dueDate');
    return saveTxn({ kind: 'lend', receivableId: r.id, amount, accountId, date, note, ...capture });
  });
}
export const totalReceivable = () => sum(db.receivables || [], (r) => Math.max(0, r.balance));
export function receivableActivity(id) {
  return db.txns.filter((t) => (t.kind === 'lend' || t.kind === 'collect') && t.receivableId === id).sort(byNewest);
}
// How much of what someone owes you has come back: { paid, total, pct }.
export function receivableProgress(r) {
  const paid = sum(db.txns.filter((t) => t.kind === 'collect' && t.receivableId === r.id && !t.orphan), (t) => t.amount);
  const total = round2(paid + Math.max(0, r.balance));
  return { paid, total, pct: total > 0 ? (paid / total) * 100 : 100 };
}

export function saveGoal(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? goal(input.id) : null;
    const g = shapeGoal({ ...(existing ? JSON.parse(JSON.stringify(existing)) : {}), ...defined(input) }, true);
    g.id = existing ? existing.id : uid();
    g.createdAt = existing ? existing.createdAt : today();
    if (existing) return overwrite(existing, g);
    db.goals.push(g);
    return g;
  });
}
export function deleteGoal(id) {
  return tx(() => {
    const g = goal(id);
    if (!g) return;
    db.goals = db.goals.filter((x) => x.id !== id);
    for (const t of db.txns) if (t.goalId === id) { touch('txns', t); t.orphan = true; t.goalName = g.name; }
  });
}

export function saveCategory(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? db.categories.find((c) => c.id === input.id) : null;
    const c = shapeCategory({ ...(existing || {}), ...defined(input) }, true);
    c.id = existing ? existing.id : uid();
    if (existing) return overwrite(existing, c);
    db.categories.push(c);
    return c;
  });
}
export function deleteCategory(id) {
  return tx(() => {
    db.categories = db.categories.filter((c) => c.id !== id);
    if (db.settings.lastCategoryId === id) db.settings.lastCategoryId = null;
  });
}

// Category ids, most used in the last 30 days first (ties keep the original order).
export function categoryOrder() {
  const to = today(), from = addDays(to, -29);
  const uses = new Map();
  for (const t of db.txns) {
    if (t.kind === 'expense' && t.categoryId && t.date >= from && t.date <= to) uses.set(t.categoryId, (uses.get(t.categoryId) || 0) + 1);
  }
  return db.categories
    .map((c, i) => ({ id: c.id, i, n: uses.get(c.id) || 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.id);
}

// Moves a category up (-1) or down (+1) in the list (the order of the entry form and the shortcut).
export function moveCategory(id, step) {
  return tx(() => {
    const i = db.categories.findIndex((c) => c.id === id);
    const j = i + Math.sign(Number(step) || 0);
    if (i < 0 || j < 0 || j >= db.categories.length) return false;
    const [c] = db.categories.splice(i, 1);
    db.categories.splice(j, 0, c);
    return true;
  });
}
// Merges `fromId` into `intoId`: its entries and bills move, its keywords join, then it is removed.
export function mergeCategory(fromId, intoId) {
  return tx(() => {
    const from = db.categories.find((c) => c.id === fromId);
    const into = db.categories.find((c) => c.id === intoId);
    if (!from || !into) fail('Pick the category to merge into', 'intoId');
    if (from === into) fail('Pick a different category', 'intoId');
    let moved = 0;
    for (const t of db.txns) {
      if (t.categoryId === fromId) { touch('txns', t); t.categoryId = intoId; moved++; }
    }
    for (const b of db.bills) if (b.categoryId === fromId) b.categoryId = intoId;
    if (!(into.limit > 0) && from.limit > 0) into.limit = from.limit;
    const kw = [into.keywords, from.keywords, from.name.toLowerCase()].filter(Boolean).join(', ');
    const merged = shapeCategory({ ...into, keywords: kw }, false);
    if (merged.keywords) into.keywords = merged.keywords;
    if (!into.key && from.key) into.key = from.key;
    db.categories = db.categories.filter((c) => c.id !== fromId);
    if (db.settings.lastCategoryId === fromId) db.settings.lastCategoryId = intoId;
    return moved;
  });
}

// Savings plan: how much to put aside each payday to reach the goal by its deadline.
export function goalPlan(g) {
  const remaining = round2(Math.max(0, g.target - g.saved));
  const p = period();
  const depositedThisPeriod = round2(Math.max(0, sum(
    db.txns.filter((t) => t.kind === 'goal' && t.goalId === g.id && !t.orphan && t.date >= p.start && t.date <= p.end),
    (t) => (t.withdraw ? -t.amount : t.amount),
  )));
  const base = { remaining, perPayday: 0, paydaysLeft: null, depositedThisPeriod, setAsideNow: 0 };
  if (remaining <= 0) return { ...base, status: 'reached' };
  if (!g.deadline) return { ...base, status: 'no-deadline' };
  if (g.deadline < today()) return { ...base, paydaysLeft: 0, status: 'overdue' };
  const paydaysLeft = 1 + paydaysUntil(g.deadline); // this period's pay counts too
  // Spread what was left at the start of this period, so the target doesn't move after a deposit.
  const perPayday = Math.ceil(round2((remaining + depositedThisPeriod) / paydaysLeft));
  const setAsideNow = round2(Math.min(remaining, Math.max(0, perPayday - depositedThisPeriod)));
  return { remaining, perPayday, paydaysLeft, depositedThisPeriod, setAsideNow, status: 'on-track' };
}

// ---------- transactions ----------
// kind: 'expense' | 'income' | 'debt' (payment) | 'goal' (deposit / withdrawal) | 'adjust' | 'transfer'.
// apply() records exactly what it changed in t.fx and revert() undoes that record, so editing or deleting
// entries in any order keeps balances right. A due date moved by a later payment steps back with retreat().
const touchesDebt = (t) => t.kind === 'debt' || (t.kind === 'adjust' && !!t.debtId) || (t.kind === 'expense' && !!t.cardId);

function apply(t) {
  const fx = {};
  if (t.kind === 'expense') {
    const c = t.cardId && debt(t.cardId);
    if (c) {
      c.balance = round2(c.balance + t.amount);
      fx.card = { id: c.id, amount: t.amount };
    }
    const b = t.billId && bill(t.billId);
    if (b && b.nextDue && !b.done) {
      const to = advance(b.nextDue, b.frequency, b.dueDay, b.dueDays);
      fx.bill = { id: b.id, from: b.nextDue, to, freq: b.frequency };
      if (to) b.nextDue = to;
      else b.done = true;
    }
  }
  if (t.kind === 'debt') {
    const d = debt(t.debtId);
    if (d) {
      d.balance = round2(d.balance - t.amount);
      const n = t.installments || 0;
      const room = Math.max(0, (d.totalPayments || 0) - (d.paymentsMade || 0));
      const e = { id: d.id, amount: t.amount, counted: isScheduled(d) ? Math.min(n, room) : 0, steps: 0, from: null, to: null, freq: debtFreq(d) };
      d.paymentsMade = (d.paymentsMade || 0) + e.counted;
      if (n && d.nextDue) {
        let to = d.nextDue;
        for (let i = 0; i < n; i++) {
          const next = advance(to, e.freq, d.dueDay, d.dueDays);
          if (!next) break;
          to = next;
          e.steps++;
        }
        e.from = d.nextDue;
        e.to = to;
        d.nextDue = to;
      }
      fx.debt = e;
    }
  }
  if (t.kind === 'adjust') {
    const d = debt(t.debtId);
    if (d) {
      const delta = t.direction === 'up' ? t.amount : -t.amount;
      d.balance = round2(d.balance + delta);
      fx.adjust = { id: d.id, delta };
    }
  }
  if (t.kind === 'goal') {
    const g = goal(t.goalId);
    if (g) {
      const delta = t.withdraw ? -t.amount : t.amount;
      g.saved = round2(g.saved + delta);
      fx.goal = { id: g.id, delta };
    }
  }
  if (t.kind === 'lend' || t.kind === 'collect') {
    const r = receivable(t.receivableId);
    if (r) {
      const delta = t.kind === 'lend' ? t.amount : -t.amount;
      r.balance = round2(r.balance + delta);
      fx.recv = { id: r.id, delta };
    }
  }
  t.fx = fx;
}

function revert(t) {
  const fx = t.fx || legacyFx(t);
  if (fx.card) {
    const c = debt(fx.card.id);
    if (c) c.balance = round2(c.balance - fx.card.amount);
  }
  if (fx.bill) {
    const b = bill(fx.bill.id);
    if (b) {
      if (!fx.bill.to) {
        if (b.done) { b.done = false; b.nextDue = fx.bill.from; }
      } else if (b.nextDue === fx.bill.to) b.nextDue = fx.bill.from;
      else if (b.nextDue) b.nextDue = retreat(b.nextDue, fx.bill.freq, b.dueDay, b.dueDays) || fx.bill.from;
    }
  }
  if (fx.debt) {
    const d = debt(fx.debt.id);
    if (d) {
      d.balance = round2(d.balance + fx.debt.amount);
      if (fx.debt.counted) d.paymentsMade = Math.max(0, (d.paymentsMade || 0) - fx.debt.counted);
      if (fx.debt.steps && d.nextDue) {
        if (d.nextDue === fx.debt.to && fx.debt.from) d.nextDue = fx.debt.from;
        else for (let i = 0; i < fx.debt.steps; i++) d.nextDue = retreat(d.nextDue, fx.debt.freq, d.dueDay, d.dueDays) || d.nextDue;
      }
    }
  }
  if (fx.adjust) {
    const d = debt(fx.adjust.id);
    if (d) d.balance = round2(d.balance - fx.adjust.delta);
  }
  if (fx.goal) {
    const g = goal(fx.goal.id);
    if (g) g.saved = round2(g.saved - fx.goal.delta);
  }
  if (fx.recv) {
    const r = receivable(fx.recv.id);
    if (r) r.balance = round2(r.balance - fx.recv.delta);
  }
  delete t.fx;
}

// Effect record for entries saved before t.fx existed (v1: prevDue / countsInstallment / advanceDue).
function legacyFx(t, data = db) {
  const find = (k, id) => data[k].find((x) => x.id === id);
  const fx = {};
  if (t.kind === 'expense' && isId(t.cardId)) fx.card = { id: t.cardId, amount: t.amount };
  if (t.kind === 'expense' && isId(t.billId) && isISO(t.prevDue)) {
    const b = find('bills', t.billId);
    const freq = b?.frequency || 'monthly';
    fx.bill = { id: t.billId, from: t.prevDue, to: advance(t.prevDue, freq, b?.dueDay, b?.dueDays), freq };
  }
  if (t.kind === 'debt' && isId(t.debtId)) {
    const d = find('debts', t.debtId);
    const n = Number.isInteger(t.installments) ? t.installments : t.countsInstallment || t.advanceDue ? 1 : 0;
    const counts = t.countsInstallment === undefined ? n > 0 : !!t.countsInstallment;
    const e = { id: t.debtId, amount: t.amount, counted: d && isScheduled(d) && counts ? n : 0, steps: 0, from: null, to: null, freq: d ? debtFreq(d) : 'monthly' };
    if (n && d && isISO(t.prevDue) && t.advanceDue !== false) {
      let to = t.prevDue;
      for (let i = 0; i < n; i++) {
        const next = advance(to, e.freq, d.dueDay, d.dueDays);
        if (!next) break;
        to = next;
        e.steps++;
      }
      Object.assign(e, { from: t.prevDue, to });
    }
    fx.debt = e;
  }
  if (t.kind === 'adjust' && isId(t.debtId)) fx.adjust = { id: t.debtId, delta: t.direction === 'up' ? t.amount : -t.amount };
  if (t.kind === 'goal' && isId(t.goalId)) fx.goal = { id: t.goalId, delta: t.withdraw ? -t.amount : t.amount };
  if ((t.kind === 'lend' || t.kind === 'collect') && isId(t.receivableId)) fx.recv = { id: t.receivableId, delta: t.kind === 'lend' ? t.amount : -t.amount };
  return fx;
}

// Balance of debt `id` / savings of goal `id` as they would be with `old`'s effect undone.
function balanceWithout(old, id) {
  const d = debt(id);
  const fx = old ? old.fx || legacyFx(old) : {};
  let b = d.balance;
  if (fx.debt?.id === id) b += fx.debt.amount;
  if (fx.adjust?.id === id) b -= fx.adjust.delta;
  if (fx.card?.id === id) b -= fx.card.amount;
  return round2(b);
}
function savedWithout(old, id) {
  const fx = old ? old.fx || legacyFx(old) : {};
  return round2(goal(id).saved - (fx.goal?.id === id ? fx.goal.delta : 0));
}
function owedWithout(old, id) {
  const fx = old ? old.fx || legacyFx(old) : {};
  return round2(receivable(id).balance - (fx.recv?.id === id ? fx.recv.delta : 0));
}

// Builds a clean entry from what the UI sent. Only the fields of its kind are kept (contract §2).
function buildTxn(input, old) {
  const kind = input.kind ?? old?.kind;
  if (!TXN_KINDS.includes(kind)) fail('Pick what kind of entry this is', 'kind');
  const rawAmount = input.amount ?? old?.amount;
  const n = toNum(rawAmount);
  if (!Number.isFinite(n) || round2(n) <= 0) fail('Enter an amount', 'amount');
  if (n > MAX_AMOUNT) fail('That amount is too big', 'amount');
  const amount = round2(n);
  const date = input.date ?? old?.date ?? today();
  if (!isISO(date)) fail('Pick a valid date', 'date');
  const t = { id: old?.id || uid(), kind, amount, date, note: str(input.note ?? old?.note, 200), createdAt: old?.createdAt ?? Date.now() };
  // Capture details (source, merchant, reference, confirmations) survive edits made in the form.
  const cap = {};
  for (const k of CAPTURE_KEYS) { const v = input[k] !== undefined ? input[k] : old?.[k]; if (v !== undefined && v !== null && v !== '') cap[k] = v; }
  Object.assign(t, cleanCapture(cap));
  // An entry whose debt or goal was deleted keeps that link; it is never moved to another one (BUG-08).
  const orphan = !!old?.orphan && old.kind === kind;
  const wallet = (id, field = 'accountId', msg = 'Pick a wallet') => {
    const a = absent(id) ? defaultAccountId() : id;
    if (!account(a)) fail(msg, field);
    return a;
  };
  const pickDebt = (id) => {
    const d = debt(id);
    if (!d) fail('Pick a debt', 'debtId');
    return d;
  };
  switch (kind) {
    case 'expense':
      if (isId(input.categoryId)) t.categoryId = input.categoryId;
      if (orphan && old.cardId) t.cardId = old.cardId;
      else if (!absent(input.cardId)) {
        const c = debt(input.cardId);
        if (!c || c.type !== 'card') fail('Pick a card', 'cardId');
        t.cardId = c.id;
      } else t.accountId = wallet(input.accountId);
      if (isId(input.billId) && (bill(input.billId) || input.billId === old?.billId)) t.billId = input.billId;
      break;
    case 'income':
      t.accountId = wallet(input.accountId);
      break;
    case 'debt': {
      if (orphan) t.debtId = old.debtId;
      else {
        const d = pickDebt(input.debtId);
        t.debtId = d.id;
        const room = balanceWithout(old, d.id);
        if (amount > room + 0.001) fail(`That's more than the ${peso(Math.max(0, room))} left on ${d.name}`, 'amount');
      }
      t.accountId = wallet(input.accountId);
      if (!absent(input.installments)) {
        const k = toNum(input.installments);
        if (!Number.isInteger(k) || k < 0 || k > 1000) fail('Enter how many payments this covers', 'installments');
        t.installments = k;
      } else if (old?.kind === 'debt' && old.debtId === t.debtId) t.installments = old.installments || 0;
      else t.installments = suggestInstallments(t.debtId, amount);
      break;
    }
    case 'goal': {
      if (orphan) t.goalId = old.goalId;
      else {
        const g = goal(input.goalId);
        if (!g) fail('Pick a goal', 'goalId');
        t.goalId = g.id;
      }
      t.accountId = wallet(input.accountId);
      t.withdraw = truthy(input.withdraw);
      if (t.withdraw && !orphan) {
        const room = savedWithout(old, t.goalId);
        if (amount > room + 0.001) fail(`Only ${peso(Math.max(0, room))} is saved in ${goal(t.goalId).name}`, 'amount');
      }
      break;
    }
    case 'adjust': {
      // A wallet balance fix: a wallet and no debt (always a correction, never spending or income).
      if (!orphan && absent(input.debtId) && !absent(input.accountId)) {
        if (input.direction !== 'up' && input.direction !== 'down') fail('Choose whether the balance goes up or down', 'direction');
        t.accountId = wallet(input.accountId);
        t.direction = input.direction;
        t.reason = 'correction';
        break;
      }
      if (orphan) t.debtId = old.debtId;
      else t.debtId = pickDebt(input.debtId).id;
      if (input.direction !== 'up' && input.direction !== 'down') fail('Choose whether the balance goes up or down', 'direction');
      t.direction = input.direction;
      t.reason = ADJUST_REASONS.includes(input.reason) ? input.reason : 'correction';
      if (t.direction === 'down' && !orphan) {
        const room = balanceWithout(old, t.debtId);
        if (amount > room + 0.001) fail(`That's more than the ${peso(Math.max(0, room))} left on ${debt(t.debtId).name}`, 'amount');
      }
      break;
    }
    case 'transfer':
      if (absent(input.accountId) || !account(input.accountId)) fail('Pick the wallet the money comes from', 'accountId');
      if (absent(input.toAccountId) || !account(input.toAccountId)) fail('Pick the wallet the money goes to', 'toAccountId');
      if (input.accountId === input.toAccountId) fail('Pick two different wallets', 'toAccountId');
      t.accountId = input.accountId;
      t.toAccountId = input.toAccountId;
      break;
    case 'lend':
    case 'collect': {
      if (orphan) t.receivableId = old.receivableId;
      else {
        const r = receivable(input.receivableId);
        if (!r) fail('Pick who owes you', 'receivableId');
        t.receivableId = r.id;
        if (kind === 'collect') {
          const room = owedWithout(old, r.id);
          if (amount > room + 0.001) fail(`${r.name} only owes you ${peso(Math.max(0, room))}`, 'amount');
        }
      }
      t.accountId = wallet(input.accountId);
      break;
    }
  }
  if (orphan) {
    t.orphan = true;
    if (old.debtName !== undefined) t.debtName = old.debtName;
    if (old.goalName !== undefined) t.goalName = old.goalName;
    if (old.personName !== undefined) t.personName = old.personName;
  }
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
}

export function saveTxn(input = {}) {
  return tx(() => {
    const old = isId(input.id) ? db.txns.find((t) => t.id === input.id) : null;
    const t = buildTxn(defined(input), old);
    let out = t;
    const oldTouched = !!old && touchesDebt(old);
    if (old) {
      touch('txns', old);
      revert(old);
      out = overwrite(old, t);
    } else {
      db.txns.push(t);
      added('txns', t);
    }
    apply(out);
    if (oldTouched || touchesDebt(out)) snap();
    return out;
  });
}

// Removes an entry and undoes its effects. Returns a copy for Undo (see restoreTxn), or null.
export function deleteTxn(id) {
  return tx(() => {
    const t = db.txns.find((x) => x.id === id);
    if (!t) return null;
    const copy = JSON.parse(JSON.stringify(t));
    const touched = touchesDebt(t);
    dropped('txns', t);
    revert(t);
    db.txns = db.txns.filter((x) => x !== t);
    if (touched) snap();
    return copy;
  });
}

// Puts back an entry returned by deleteTxn (same id when it is free) and re-applies its effects.
export function restoreTxn(copy) {
  return tx(() => {
    if (!isObj(copy)) fail('Nothing to undo', 'id');
    const c = defined(copy);
    const t = buildTxn(c, c.orphan ? { ...c, fx: undefined } : null);
    t.id = isId(c.id) && !db.txns.some((x) => x.id === c.id) ? c.id : uid();
    if (Number.isFinite(c.createdAt)) t.createdAt = c.createdAt;
    db.txns.push(t);
    added('txns', t);
    apply(t);
    if (touchesDebt(t)) snap();
    return t;
  });
}

export function txnsBetween(start, end) {
  return db.txns.filter((t) => t.date >= start && t.date <= end);
}

export function sumBy(items, kind) {
  return sum(items.filter((t) => t.kind === kind), (t) => (kind === 'goal' && t.withdraw ? -t.amount : t.amount));
}

// Everything due (bills + debt payments) up to `until`, including overdue items and repeats.
export function upcoming(until) {
  const now = today();
  const items = [];
  const MAX_REPEATS = 60;
  for (const b of db.bills) {
    if (b.done || !b.nextDue) continue;
    for (let due = b.nextDue, i = 0; due && due <= until && i < MAX_REPEATS; due = advance(due, b.frequency, b.dueDay, b.dueDays), i++) {
      items.push({ kind: 'bill', id: b.id, name: b.name, amount: b.amount, due, icon: cat(b.categoryId).emoji, late: due < now });
    }
  }
  for (const d of db.debts) {
    if (!(d.balance > 0) || !d.nextDue) continue;
    const per = dueAmount(d);
    let left = d.balance;
    for (let due = d.nextDue, i = 0; due && due <= until && left > 0 && i < MAX_REPEATS; due = advance(due, debtFreq(d), d.dueDay, d.dueDays), i++) {
      items.push({ kind: 'debt', id: d.id, name: d.name, amount: round2(Math.min(per, left)), due, icon: DEBT_TYPES[d.type]?.icon || '💸', late: due < now });
      left = round2(left - per);
    }
  }
  return items.sort((a, b) => a.due.localeCompare(b.due));
}

// Home screen hero: what can be spent until payday. Cash is every wallet, so last period's leftover
// (or pay credited a day early) carries over automatically.
export function freeToSpend() {
  const p = period();
  const cash = totalCash();
  const dueItems = upcoming(p.end);
  const due = sum(dueItems, (x) => x.amount);
  const setAsideItems = [];
  for (const g of db.goals) {
    const plan = goalPlan(g);
    if (plan.setAsideNow > 0) setAsideItems.push({ goalId: g.id, name: g.name, emoji: g.emoji, amount: plan.setAsideNow });
  }
  const setAside = sum(setAsideItems, (x) => x.amount);
  return {
    cash, due, dueItems, setAside, setAsideItems,
    free: round2(cash - due - setAside),
    next: p.next,
    hasIncomeThisPeriod: db.txns.some((t) => t.kind === 'income' && t.date >= p.start && t.date <= p.end),
  };
}

// Monthly report numbers. Card purchases are spending, but the cash leaves when the card is paid,
// so `net` subtracts card payments and NOT the card purchases themselves.
export function monthSummary(key) {
  return summarize(db.txns.filter((t) => monthKey(t.date) === key));
}
// One pay period (start = its payday): the month numbers plus lending and where the money went.
export function periodSummary(start = period().start) {
  const end = addDays(start, 13);
  const items = txnsBetween(start, end);
  return { start, end, next: addDays(start, 14), ...summarize(items), lent: sumBy(items, 'lend'), collected: sumBy(items, 'collect'), topMerchants: topMerchants(items) };
}
// Expenses grouped by merchant (or note when there is no merchant), biggest first.
export function topMerchants(items, n = 5) {
  const groups = new Map();
  for (const t of items) {
    if (t.kind !== 'expense') continue;
    const name = (t.merchant || t.note || '').trim();
    if (!name) continue;
    const k = name.toLowerCase().replace(/\s+/g, ' ');
    if (!groups.has(k)) groups.set(k, { name, value: 0, count: 0 });
    const g = groups.get(k);
    g.value += t.amount;
    g.count++;
  }
  return [...groups.values()].map((g) => ({ ...g, value: round2(g.value) })).sort((a, b) => b.value - a.value || b.count - a.count).slice(0, n);
}
function summarize(items) {
  const expenses = items.filter((t) => t.kind === 'expense');
  const income = sumBy(items, 'income'), spent = sumBy(items, 'expense'), debtPaid = sumBy(items, 'debt'), saved = sumBy(items, 'goal');
  const spentOnCards = sum(expenses.filter((t) => t.cardId), (t) => t.amount);
  const fees = sum(items.filter((t) => t.kind === 'adjust' && t.direction === 'up' && t.reason !== 'correction'), (t) => t.amount);
  const groups = new Map();
  for (const t of expenses) {
    const c = db.categories.find((x) => x.id === t.categoryId);
    const k = c ? c.id : '';
    if (!groups.has(k)) groups.set(k, { id: c ? c.id : null, name: c ? c.name : 'Uncategorized', emoji: c ? c.emoji : '❔', value: 0 });
    groups.get(k).value += t.amount;
  }
  const byCategory = [...groups.values()].map((g) => ({ ...g, value: round2(g.value) })).sort((a, b) => b.value - a.value);
  return { income, spent, spentOnCards, debtPaid, saved, fees, net: round2(income - (spent - spentOnCards) - debtPaid - saved), byCategory, count: items.length };
}

// ---------- capture: inbox items, confirmations, alert formats, card mapping ----------
// Several changes as one all-or-nothing save (the inbox pipeline applies a whole batch this way).
export const transaction = (fn) => tx(fn);
export const txn = (id) => db.txns.find((t) => t.id === id);
export const inboxItem = (id) => db.inbox.find((x) => x.id === id);
export const hasClientId = (cid) => !!cid && db.inbox.some((x) => x.cid === cid);
export function addInbox(item) {
  return tx(() => {
    const it = cleanInbox({ ...defined(item), id: isId(item?.id) && !inboxItem(item.id) ? item.id : uid() });
    if (!it) fail("That item couldn't be read");
    db.inbox.push(it);
    added('inbox', it);
    return it;
  });
}
export function patchInbox(id, patch) {
  return tx(() => {
    const it = inboxItem(id);
    if (!it) return null;
    touch('inbox', it);
    const next = cleanInbox({ ...it, ...defined(patch), id: it.id, type: it.type });
    for (const k of Object.keys(patch || {})) if (patch[k] === null) delete next[k];
    return overwrite(it, next);
  });
}
// Adds "confirmed by" to an entry and fills in what it was missing (merchant, reference, time).
// Returns the fields it changed, so the change can be undone with setTxnFields().
export function confirmTxn(id, conf, enrich = {}) {
  return tx(() => {
    const t = txn(id);
    if (!t) fail("That entry wasn't found", 'txnId');
    touch('txns', t);
    const before = {};
    for (const k of ['conf', 'merchant', 'ref', 'at', 'categoryId', 'note']) before[k] = t[k] === undefined ? null : JSON.parse(JSON.stringify(t[k]));
    const c = cleanCapture({ conf: [conf] }).conf?.[0];
    if (c) t.conf = [...(t.conf || []), c];
    const e = cleanCapture(enrich);
    if (!t.merchant && e.merchant) t.merchant = e.merchant;
    if (!t.ref && e.ref) t.ref = e.ref;
    if (!t.at && e.at) t.at = e.at;
    if (t.kind === 'expense' && !t.categoryId && isId(enrich.categoryId)) t.categoryId = enrich.categoryId;
    if (!t.note && str(enrich.note, 200)) t.note = str(enrich.note, 200);
    return before;
  });
}
// Puts capture fields back (null removes one). Only fields that never move money.
export function setTxnFields(id, fields) {
  return tx(() => {
    const t = txn(id);
    if (!t) return null;
    touch('txns', t);
    for (const k of ['conf', 'merchant', 'ref', 'at', 'categoryId', 'note']) {
      if (!(k in fields)) continue;
      if (fields[k] === null || fields[k] === undefined) delete t[k];
      else if (k === 'categoryId') { if (isId(fields[k])) t.categoryId = fields[k]; }
      else if (k === 'note') t.note = str(fields[k], 200);
      else Object.assign(t, cleanCapture({ [k]: fields[k] }));
    }
    return t;
  });
}
export const template = (id) => db.templates.find((x) => x.id === id);
export function saveTemplate(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? template(input.id) : null;
    const t = shapeTemplate({ ...(existing || {}), ...defined(input) }, true);
    t.id = existing ? existing.id : uid();
    if (existing) return overwrite(existing, t);
    db.templates.push(t);
    return t;
  });
}
export function deleteTemplate(id) {
  return tx(() => { db.templates = db.templates.filter((x) => x.id !== id); });
}
export function bumpTemplate(id) {
  return tx(() => { const t = template(id); if (t) t.hits++; });
}
export function saveCardMap(input = {}) {
  return tx(() => {
    const existing = isId(input.id) ? db.cardMap.find((x) => x.id === input.id) : null;
    const m = shapeCardMap({ ...(existing || {}), ...defined(input) }, true);
    if (m.cardId && debt(m.cardId)?.type !== 'card') fail('Pick a credit card', 'target');
    if (m.accountId && !account(m.accountId)) fail('Pick a wallet', 'target');
    m.id = existing ? existing.id : uid();
    if (existing) return overwrite(existing, m);
    db.cardMap.push(m);
    return m;
  });
}
export function deleteCardMap(id) {
  return tx(() => { db.cardMap = db.cardMap.filter((x) => x.id !== id); });
}
export function setAccountChecked(id, checked) {
  return tx(() => {
    const a = account(id);
    if (!a) return;
    const c = shapeChecked(checked).checked;
    if (c) a.checked = c;
  });
}
// What the shortcuts show: category and wallet lists (the relay keeps a copy for them).
export function shortcutConfig() {
  const names = [];
  for (const a of db.accounts) names.push(a.name);
  for (const d of db.debts) if (d.type === 'card' && d.balance >= 0 && !names.some((n) => n.toLowerCase() === d.name.toLowerCase())) names.push(d.name);
  return {
    v: 1,
    categories: visibleCategories().map((c) => `${c.emoji} ${c.name}`),
    wallets: names,
    defaultWallet: account(defaultAccountId())?.name || names[0] || 'Cash',
  };
}
// Alert text older than `days` (and decided) is cut down to what Pitaka read from it.
export function trimRaw(days = db.settings.rawDays ?? 90, now = Date.now()) {
  if (!(days > 0)) return 0;
  const before = now - days * 86400000;
  return tx(() => {
    let n = 0;
    for (const it of db.inbox) {
      if (it.status === 'pending' || (it.receivedAt || it.at) >= before || !(it.raw?.text || it.raw?.body)) continue;
      touch('inbox', it);
      delete it.raw.text;
      delete it.raw.body;
      it.trimmed = true;
      n++;
    }
    return n;
  });
}

// Remembers that a suggestion was dismissed ("sub:<key>"), so it isn't offered again.
export function dismiss(key) {
  return tx(() => {
    const k = str(key, 120);
    if (k && !db.dismissed.includes(k)) db.dismissed = [...db.dismissed, k].slice(-200);
  });
}

// Settings changes from the UI (PIN, pay day, preferences) with the same all-or-nothing save.
export function updateSettings(patch = {}) {
  return tx(() => Object.assign(db.settings, cleanSettings(defined(patch), {})));
}
