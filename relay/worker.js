// Pitaka inbox relay: a Cloudflare Worker that holds what your shortcuts send until Pitaka collects it.
// One file with no imports, so it can be pasted into the Cloudflare dashboard (docs/SETUP-RELAY.md).
//
// Why D1 (binding DB) and not Workers KV:
//   - D1 is strongly consistent. A Quick Add sent a few seconds before you open Pitaka is already there,
//     and an item Pitaka acknowledged is gone for good. KV is eventually consistent: its key listings can
//     lag by a minute or more, so a fresh item could miss the collection when Pitaka opens and a deleted
//     one could come back.
//   - The free plan allows 100,000 D1 rows written a day; KV allows 1,000 writes and 1,000 listings.
//   - Expiry is one indexed DELETE. The Worker creates its own tables, so setting up is still
//     "create a database, bind it".
//
// What it stores: items encrypted the moment they arrive (ECDH-ES on P-256 + AES-256-GCM, a new key per
// item) to the public key Pitaka registered; Pitaka's private key never leaves the phone. SHA-256 hashes
// of the two tokens, never the tokens. The category and wallet names your shortcuts show, unencrypted
// because the shortcuts must read them. Request bodies are never logged.
//
// Settings (Workers & Pages -> your Worker -> Settings):
//   DB              D1 database binding (required)
//   ADMIN_SECRET    secret, used to pair Pitaka (required, 16 characters or more)
//   ALLOWED_ORIGIN  your Pitaka address, e.g. https://nykkoferrerava.github.io (comma-separate several)
//   LIMITER         optional Rate Limiting binding; a per-instance limit applies either way
//
// Tokens: the WRITE token lives only in your shortcuts. It can add items and read the shortcut config.
// The READ token lives only in Pitaka. It can collect, acknowledge (delete), publish the config and
// replace the write token. Pairing again with ADMIN_SECRET replaces both tokens and the key.

const ITEM_TTL = 30 * 24 * 3600 * 1000; // unacknowledged items expire after 30 days
const MAX_BODY = 16 * 1024;
const MAX_PENDING = 5000;
const PULL_PAGE = 100;
const INFO = 'pitaka-relay-v1';
const TYPES = ['entry', 'text', 'sms', 'email', 'wallet', 'balance', 'test'];
// Fields an item may carry, with their size limits. Anything else is dropped.
const FIELDS = {
  entry: { amount: 40, category: 60, wallet: 60, note: 200 },
  text: { text: 300 },
  sms: { sender: 80, text: 4000 },
  email: { from: 200, subject: 300, body: 8000 },
  wallet: { merchant: 120, amount: 40, card: 60, name: 60 },
  balance: { wallet: 60, amount: 40 },
  test: { source: 30 },
};
const NEEDS = { entry: ['amount'], text: ['text'], sms: ['text'], email: [], wallet: ['amount'], balance: ['wallet', 'amount'], test: [] };
const ID = /^[A-Za-z0-9._:-]{6,64}$/;
const KEY = /^i:[a-z0-9]{6,14}:[a-z0-9]{8,16}$/;
const HASH = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
// Two SHA-256 hex digests compared without an early exit.
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HASH.test(a) || !HASH.test(b)) return false;
  let d = 0;
  for (let i = 0; i < 64; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => (x % 36).toString(36)).join(''); };

function cors(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return { ok: true, headers: {} }; // Shortcuts and other non-browser clients send no Origin
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!allowed.includes(origin)) return { ok: false, headers: {} };
  return { ok: true, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' } };
}
function reply(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}

// ---------------------------------------------------------------- rate limits
// One-minute windows per client and route, counted in this Worker instance. With a LIMITER binding,
// Cloudflare's rate limiting is asked as well.
const hits = new Map();
function count(key) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60000);
  hits.set(key, list);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k);
  return list;
}
async function limited(env, key, perMinute) {
  if (env.LIMITER?.limit) {
    try { const { success } = await env.LIMITER.limit({ key }); if (!success) return true; } catch { /* the local count still applies */ }
  }
  const list = count(key);
  list.push(Date.now());
  return list.length > perMinute;
}

// ---------------------------------------------------------------- storage
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS items (k TEXT PRIMARY KEY, box TEXT NOT NULL, exp INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS items_exp ON items (exp)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];
const ready = new WeakSet();
async function schema(db) {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  ready.add(db);
}
async function getMeta(db, k) {
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : null;
}
const putMeta = (db, k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
async function pendingCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE exp > ?').bind(Date.now()).first();
  return Number(row?.n) || 0;
}

// ---------------------------------------------------------------- encryption
async function encryptFor(publicJwk, plaintext) {
  const recipient = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = await crypto.subtle.exportKey('raw', eph.publicKey);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(INFO) }, key, enc.encode(plaintext));
  return { v: 1, alg: 'ECDH-ES+A256GCM', epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) };
}

// ---------------------------------------------------------------- validation
// Returns { item } or { error }. The body may be the item itself or { item: {...} }.
function validateItem(input, now) {
  let x = input;
  if (x && typeof x === 'object' && !Array.isArray(x) && x.item && typeof x.item === 'object') x = x.item;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: 'Send a JSON object' };
  if (!TYPES.includes(x.type)) return { error: `type must be one of ${TYPES.join(', ')}` };
  if (x.id !== undefined && x.id !== null && x.id !== '' && (typeof x.id !== 'string' || !ID.test(x.id))) return { error: 'id must be 6-64 letters, digits or . _ : -' };
  const item = { type: x.type, id: x.id || `r-${now.toString(36)}-${rand(8)}` };
  for (const [k, max] of Object.entries(FIELDS[x.type])) {
    const v = x[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return { error: `${k} must be text or a number` };
    const s = String(v);
    if (s.length > max) return { error: `${k} is longer than ${max} characters` };
    item[k] = s;
  }
  for (const k of NEEDS[x.type]) if (!item[k] || !item[k].trim()) return { error: `${k} is missing` };
  if (x.type === 'email' && !item.subject && !item.body) return { error: 'subject or body is missing' };
  // The time it happened, when the shortcut sends one it can read; otherwise Pitaka uses receivedAt.
  const t = typeof x.at === 'number' ? x.at : typeof x.at === 'string' ? Date.parse(x.at) : NaN;
  if (Number.isFinite(t) && t > 0) item.at = new Date(Math.min(t, now + 86400000)).toISOString();
  item.receivedAt = new Date(now).toISOString();
  return { item };
}
function validateConfig(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const list = (v, n, len) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.slice(0, len)).slice(0, n) : []);
  return { v: 1, categories: list(x.categories, 60, 64), wallets: list(x.wallets, 30, 64), defaultWallet: typeof x.defaultWallet === 'string' ? x.defaultWallet.slice(0, 64) : '', updatedAt: new Date().toISOString() };
}
const validJwk = (k) => !!k && typeof k === 'object' && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && /^[\w-]{43}$/.test(k.x) && /^[\w-]{43}$/.test(k.y) && !('d' in k);

async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return { error: 'too big' };
  const text = await req.text();
  if (enc.encode(text).length > MAX_BODY) return { error: 'too big' };
  try { return { body: JSON.parse(text) }; } catch { return { error: 'not JSON' }; }
}

// ---------------------------------------------------------------- the routes
async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const c = cors(req, env);
  if (!c.ok) return reply(403, { error: 'origin not allowed: set ALLOWED_ORIGIN to your Pitaka address' });
  const out = (status, body) => reply(status, body, c.headers);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...c.headers, 'Cache-Control': 'no-store' } });
  const db = env.DB;
  if (!db?.prepare) return out(500, { error: 'The DB binding (a D1 database) is missing' });
  await schema(db);
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();

  if (path === '/' && req.method === 'GET') return out(200, { ok: true, service: 'pitaka-relay', paired: !!(await getMeta(db, 'pair')) });

  // Tokens: the one presented is hashed, then compared in constant time with the stored hash.
  // Twenty wrong tokens in a minute lock that client out for the rest of the minute.
  if (count(`fail:${ip}`).length >= 20) return out(429, { error: 'too many wrong tokens, wait a minute' });
  const fail = () => { count(`fail:${ip}`).push(Date.now()); return out(401, { error: 'wrong token' }); };
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const hash = await sha256hex(bearer);

  if (path === '/pair' && req.method === 'POST') {
    if (await limited(env, `pair:${ip}`, 10)) return out(429, { error: 'slow down' });
    const secret = String(env.ADMIN_SECRET || '');
    if (secret.length < 16) return out(500, { error: 'Set the ADMIN_SECRET secret (16 characters or more) first' });
    if (!bearer || !sameHash(hash, await sha256hex(secret))) return fail();
    const { body, error } = await readJson(req);
    if (error) return out(400, { error });
    if (!validJwk(body?.publicKey) || !HASH.test(body.readHash || '') || !HASH.test(body.writeHash || '') || body.readHash === body.writeHash) return out(400, { error: 'publicKey (a P-256 public JWK), readHash and writeHash (two different SHA-256 hex digests) are required' });
    await putMeta(db, 'pair', { publicKey: { kty: 'EC', crv: 'P-256', x: body.publicKey.x, y: body.publicKey.y }, readHash: body.readHash, writeHash: body.writeHash, pairedAt: new Date(now).toISOString() });
    return out(200, { ok: true, pending: await pendingCount(db) });
  }

  const pair = await getMeta(db, 'pair');
  if (!pair) return out(409, { error: 'not paired yet: pair from Pitaka first' });
  const isWrite = !!bearer && sameHash(hash, pair.writeHash);
  const isRead = !!bearer && sameHash(hash, pair.readHash);

  // ---- write token: add an item, read the shortcut config
  if (path === '/in' && req.method === 'POST') {
    if (!isWrite) return fail();
    if (await limited(env, `in:${ip}`, Number(env.LIMIT_IN_PER_MIN) || 30)) return out(429, { error: 'slow down' });
    const { body, error } = await readJson(req);
    if (error) return out(400, { error });
    const v = validateItem(body, now);
    if (v.error) return out(400, { error: v.error });
    if ((await pendingCount(db)) >= MAX_PENDING) return out(507, { error: 'the inbox is full: open Pitaka to collect it' });
    const box = await encryptFor(pair.publicKey, JSON.stringify(v.item));
    await db.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)').bind(`i:${now.toString(36)}:${rand(12)}`, JSON.stringify(box), now + ITEM_TTL).run();
    return out(200, { ok: true, id: v.item.id });
  }
  if (path === '/config' && req.method === 'GET') {
    if (!isWrite && !isRead) return fail();
    if (await limited(env, `cfg:${ip}`, 60)) return out(429, { error: 'slow down' });
    return out(200, (await getMeta(db, 'config')) || { v: 1, categories: [], wallets: [], defaultWallet: '', updatedAt: null });
  }

  // ---- read token: publish the config, collect, acknowledge, replace the write token, status
  if (!isRead) return fail();
  if (await limited(env, `read:${ip}`, Number(env.LIMIT_READ_PER_MIN) || 120)) return out(429, { error: 'slow down' });
  if (path === '/config' && req.method === 'PUT') {
    const { body, error } = await readJson(req);
    if (error) return out(400, { error });
    const cfg = validateConfig(body);
    if (!cfg) return out(400, { error: 'config must be an object' });
    await putMeta(db, 'config', cfg);
    return out(200, { ok: true, updatedAt: cfg.updatedAt });
  }
  if (path === '/pull' && req.method === 'GET') {
    await db.prepare('DELETE FROM items WHERE exp <= ?').bind(now).run();
    const after = url.searchParams.get('after') || '';
    const { results } = await db.prepare('SELECT k, box FROM items WHERE k > ? AND exp > ? ORDER BY k LIMIT ?').bind(KEY.test(after) ? after : '', now, PULL_PAGE + 1).all();
    const page = results.slice(0, PULL_PAGE);
    const items = page.map((r) => { try { return { key: r.k, box: JSON.parse(r.box) }; } catch { return { key: r.k, box: null }; } });
    return out(200, { items, more: results.length > PULL_PAGE, after: page.length ? page[page.length - 1].k : null });
  }
  if (path === '/ack' && req.method === 'POST') {
    const { body, error } = await readJson(req);
    if (error) return out(400, { error });
    const keys = [...new Set(Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && KEY.test(k)) : [])].slice(0, 500);
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 50) {
      const part = keys.slice(i, i + 50);
      const r = await db.prepare(`DELETE FROM items WHERE k IN (${part.map(() => '?').join(', ')})`).bind(...part).run();
      deleted += Number(r?.meta?.changes) || 0;
    }
    return out(200, { ok: true, deleted });
  }
  if (path === '/rotate' && req.method === 'POST') {
    const { body, error } = await readJson(req);
    if (error) return out(400, { error });
    if (!HASH.test(body?.writeHash || '') || body.writeHash === pair.readHash) return out(400, { error: 'writeHash (a SHA-256 hex digest) is required' });
    await putMeta(db, 'pair', { ...pair, writeHash: body.writeHash, rotatedAt: new Date(now).toISOString() });
    return out(200, { ok: true });
  }
  if (path === '/status' && req.method === 'GET') {
    const cfg = await getMeta(db, 'config');
    return out(200, { ok: true, paired: true, pairedAt: pair.pairedAt, pending: await pendingCount(db), configAt: cfg?.updatedAt || null });
  }
  return out(404, { error: 'not found' });
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      // Only the error type, never the request or its body.
      console.error('relay error', e?.name || 'Error');
      return reply(500, { error: 'relay error' });
    }
  },
};
