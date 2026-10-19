// Storage adapters. store.js talks to one of these and never to IndexedDB or localStorage directly
// (except to read v2's key once for the migration). No DOM access: the memory adapter runs under Node.
//
// What an adapter persists (a "snapshot"):
//   { meta, core, txns: [{ id, o, v }], inbox: [{ id, o, v }] }
//   meta  - schema version and migration state
//   core  - every small collection (settings, categories, wallets, debts, bills, goals, ...)
//   txns / inbox - one record per entry, `o` = insertion order, `v` = the entry itself
//
// write(ops) is atomic: either every part lands or none does.
//   ops = { replace?, meta?, core?, txns?: { put: [rec], del: [id] }, inbox?: { put, del }, clearSecrets? }
// Secrets (relay tokens, the private key) live apart from the data and are never part of a snapshot.

export const LEGACY_KEY = 'pitaka.data';           // v2 kept everything here
export const MIGRATED_KEY = 'pitaka.migrated';     // set when the v2 data was copied into IndexedDB
const BIG = ['txns', 'inbox'];

const clone = (v) => (v === undefined ? undefined : typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- memory (tests, and last resort)
// Behaves like IndexedDB: values are copied in and out, writes are all-or-nothing.
// `failWith(name)` makes the next writes fail the way Safari does ('QuotaExceededError', 'SecurityError').
export function memoryAdapter() {
  let data = empty();
  const secrets = new Map();
  let failName = null;
  let failCount = 0;
  const a = {
    kind: 'memory',
    async read() {
      if (!data.meta && !data.core) return null;
      return { meta: clone(data.meta), core: clone(data.core), txns: [...data.txns.values()].map(clone), inbox: [...data.inbox.values()].map(clone) };
    },
    async write(ops) {
      await null; // always async, like IndexedDB
      if (failName && failCount !== 0) {
        if (failCount > 0) failCount--;
        const e = new Error('write failed');
        e.name = failName;
        throw e;
      }
      const next = ops.replace ? empty() : { meta: data.meta, core: data.core, txns: new Map(data.txns), inbox: new Map(data.inbox) };
      if (ops.meta) next.meta = clone(ops.meta);
      if (ops.core) next.core = clone(ops.core);
      for (const k of BIG) {
        for (const r of ops[k]?.put || []) next[k].set(r.id, clone(r));
        for (const id of ops[k]?.del || []) next[k].delete(id);
      }
      data = next;
      if (ops.clearSecrets) secrets.clear();
    },
    async clear() { data = empty(); },
    secrets: {
      async get(k) { return secrets.get(k); },
      async set(k, v) { secrets.set(k, v); },
      async del(k) { secrets.delete(k); },
      async clear() { secrets.clear(); },
    },
    // ---- test helpers ----
    failWith(name = 'QuotaExceededError', times = -1) { failName = name; failCount = times; return () => { failName = null; }; },
    dump() {
      return { meta: clone(data.meta), core: clone(data.core), txns: [...data.txns.values()].sort((x, y) => x.o - y.o).map((r) => r.v), inbox: [...data.inbox.values()].sort((x, y) => x.o - y.o).map((r) => r.v) };
    },
    secretsMap: secrets,
  };
  return a;
}
function empty() { return { meta: null, core: null, txns: new Map(), inbox: new Map() }; }

// ---------------------------------------------------------------- IndexedDB (the app)
// One database, four object stores. Safari can drop the IndexedDB connection while the app sits in the
// background ("Connection to Indexed Database server lost"); every call reopens once and retries.
export function idbAdapter(name = 'pitaka', idb = globalThis.indexedDB) {
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    let req;
    try { req = idb.open(name, 1); } catch (e) { dbp = null; reject(e); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('txns')) d.createObjectStore('txns', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('secrets')) d.createObjectStore('secrets');
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      d.onclose = () => { dbp = null; };
      resolve(d);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; const e = new Error('IndexedDB is blocked by another tab'); e.name = 'InvalidStateError'; reject(e); };
  }));
  const lost = (e) => !!e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || /connection|closing/i.test(e.message || ''));

  // Runs fn(stores) in one transaction and resolves when it has committed.
  async function run(names, mode, fn, retry = true) {
    try {
      const d = await open();
      return await new Promise((resolve, reject) => {
        const t = d.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
        const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
        let out;
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || Object.assign(new Error('Transaction aborted'), { name: 'AbortError' }));
        try { out = fn(stores); } catch (e) { try { t.abort(); } catch { /* already finished */ } reject(e); }
      });
    } catch (e) {
      if (retry && lost(e)) { dbp = null; return run(names, mode, fn, false); }
      throw e;
    }
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  return {
    kind: 'indexeddb',
    async read() {
      const parts = {};
      await run(['meta', 'txns', 'inbox'], 'readonly', (s) => {
        req(s.meta.get('meta')).then((v) => { parts.meta = v; });
        req(s.meta.get('core')).then((v) => { parts.core = v; });
        req(s.txns.getAll()).then((v) => { parts.txns = v; });
        req(s.inbox.getAll()).then((v) => { parts.inbox = v; });
      });
      if (!parts.meta && !parts.core) return null;
      return { meta: parts.meta || null, core: parts.core || null, txns: parts.txns || [], inbox: parts.inbox || [] };
    },
    async write(ops) {
      const names = ['meta', 'txns', 'inbox', ...(ops.clearSecrets ? ['secrets'] : [])];
      await run(names, 'readwrite', (s) => {
        if (ops.replace) { s.meta.clear(); s.txns.clear(); s.inbox.clear(); }
        if (ops.meta) s.meta.put(ops.meta, 'meta');
        if (ops.core) s.meta.put(ops.core, 'core');
        for (const k of BIG) {
          for (const r of ops[k]?.put || []) s[k].put(r);
          for (const id of ops[k]?.del || []) s[k].delete(id);
        }
        if (ops.clearSecrets) s.secrets.clear();
      });
    },
    async clear() { await this.write({ replace: true }); },
    secrets: {
      async get(k) { let v; await run(['secrets'], 'readonly', (s) => { req(s.secrets.get(k)).then((x) => { v = x; }); }); return v; },
      async set(k, v) { await run(['secrets'], 'readwrite', (s) => { s.secrets.put(v, k); }); },
      async del(k) { await run(['secrets'], 'readwrite', (s) => { s.secrets.delete(k); }); },
      async clear() { await run(['secrets'], 'readwrite', (s) => { s.secrets.clear(); }); },
    },
  };
}

// ---------------------------------------------------------------- localStorage (fallback)
// Used only when IndexedDB can't be opened. It keeps everything in v2's key and format (one JSON object
// with the collections side by side), so a v2 build could still read it. Limited to about 5 MB.
export function legacyAdapter(ls = globalThis.localStorage, key = LEGACY_KEY) {
  const secrets = new Map(); // relay pairing needs IndexedDB: secrets here last only until Pitaka closes
  let mirror = null;
  const toSnap = (obj) => {
    const core = {};
    for (const k of Object.keys(obj)) if (!BIG.includes(k) && k !== '_meta') core[k] = obj[k];
    const recs = (arr) => (Array.isArray(arr) ? arr : []).map((v, o) => ({ id: v?.id, o, v }));
    return { meta: obj._meta || null, core, txns: recs(obj.txns), inbox: recs(obj.inbox) };
  };
  const readNow = () => {
    const raw = ls.getItem(key);
    if (raw === null || raw === undefined) { mirror = empty(); return null; }
    const snap = toSnap(JSON.parse(raw));
    mirror = { meta: snap.meta, core: snap.core, txns: new Map(snap.txns.map((r) => [r.id, r])), inbox: new Map(snap.inbox.map((r) => [r.id, r])) };
    return snap;
  };
  return {
    kind: 'localstorage',
    async read() { return readNow(); },
    async write(ops) {
      await null;
      if (!mirror && !ops.replace) { try { readNow(); } catch { mirror = empty(); } }
      const base = mirror || empty();
      const next = ops.replace ? empty() : { meta: base.meta, core: base.core, txns: new Map(base.txns), inbox: new Map(base.inbox) };
      if (ops.meta) next.meta = clone(ops.meta);
      if (ops.core) next.core = clone(ops.core);
      for (const k of BIG) {
        for (const r of ops[k]?.put || []) next[k].set(r.id, clone(r));
        for (const id of ops[k]?.del || []) next[k].delete(id);
      }
      const byOrder = (m) => [...m.values()].sort((x, y) => x.o - y.o).map((r) => r.v);
      const obj = { ...(next.core || {}), txns: byOrder(next.txns), inbox: byOrder(next.inbox), _meta: next.meta };
      ls.setItem(key, JSON.stringify(obj)); // throws on quota: nothing changed
      mirror = next;
      if (ops.clearSecrets) secrets.clear();
    },
    async clear() { await this.write({ replace: true }); },
    secrets: {
      async get(k) { return secrets.get(k); },
      async set(k, v) { secrets.set(k, v); },
      async del(k) { secrets.delete(k); },
      async clear() { secrets.clear(); },
    },
  };
}

// ---------------------------------------------------------------- nothing works
// Both IndexedDB and localStorage are blocked (for example Private Browsing with "Block All Cookies").
// Every write fails, so the app says so instead of pretending to save.
export function blockedAdapter() {
  const fail = async () => { const e = new Error('Storage is blocked'); e.name = 'SecurityError'; throw e; };
  return { kind: 'blocked', read: async () => null, write: fail, clear: fail, secrets: { get: async () => undefined, set: fail, del: fail, clear: async () => {} } };
}

// ---------------------------------------------------------------- v2's key (migration source)
// { state: 'absent' | 'blocked' | 'ok' | 'unreadable', raw, data }
export function readLegacy(ls = globalThis.localStorage) {
  let raw;
  try { raw = ls ? ls.getItem(LEGACY_KEY) : null; } catch { return { state: 'blocked' }; }
  if (raw === null || raw === undefined) return { state: 'absent' };
  let data;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  const ok = data !== null && typeof data === 'object' && !Array.isArray(data);
  return ok ? { state: 'ok', raw, data } : { state: 'unreadable', raw };
}

// Erase all data: the rescued copies go too.
export function dropRescued(ls = globalThis.localStorage) {
  try {
    const keys = [];
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(`${LEGACY_KEY}.unreadable-`)) keys.push(k); }
    for (const k of keys) ls.removeItem(k);
  } catch { /* blocked: nothing could be kept there either */ }
}

// Keeps a copy of unreadable v2 data under its own key (once: an identical copy is reused).
export function rescueLegacy(raw, ls = globalThis.localStorage) {
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(`${LEGACY_KEY}.unreadable-`) && ls.getItem(k) === raw) return k;
    }
    const k = `${LEGACY_KEY}.unreadable-${Date.now()}`;
    ls.setItem(k, raw);
    return k;
  } catch {
    return null;
  }
}

export function lsGet(k, ls = globalThis.localStorage) { try { return ls ? ls.getItem(k) : null; } catch { return null; } }
export function lsSet(k, v, ls = globalThis.localStorage) { try { ls?.setItem(k, v); return true; } catch { return false; } }
export function lsDel(k, ls = globalThis.localStorage) { try { ls?.removeItem(k); return true; } catch { return false; } }

// The adapter the app uses: IndexedDB when it can be opened, else v2's localStorage key, else blocked.
// Tests set globalThis.__pitakaAdapter first so every copy of store.js shares one memory store.
let shared = null;
export function defaultAdapter() {
  if (globalThis.__pitakaAdapter) return globalThis.__pitakaAdapter;
  if (!shared) shared = globalThis.indexedDB ? idbAdapter() : memoryAdapter();
  return shared;
}
