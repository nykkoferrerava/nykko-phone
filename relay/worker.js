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
// because the shortcuts must read them. Request bodies and tokens are never logged.
//
// Settings (Workers & Pages -> your Worker -> Settings):
//   DB              D1 database binding (required)
//   ADMIN_SECRET    secret, used to pair Pitaka (required, 16 characters or more)
//   ALLOWED_ORIGIN  your Pitaka address, e.g. https://nykkoferrerava.github.io (comma-separate several)
//   LIMITER         optional Rate Limiting binding; a per-instance limit applies either way
// A daily Cron Trigger (any time) is optional: it deletes expired items even when nothing arrives.
//
// Tokens: the WRITE token lives only in your shortcuts. It can add items and read the shortcut config.
// The READ token lives only in Pitaka. It can collect, acknowledge (delete), publish the config and
// replace the write token. Pairing again with ADMIN_SECRET replaces both tokens and the key; the old
// tokens are then told when that happened, so a pairing you didn't make doesn't go unnoticed.

const ITEM_TTL = 30 * 24 * 3600 * 1000; // unacknowledged items expire after 30 days
// Bytes, not characters: an 8,000-character alert email full of ₱ signs is 24 KB. Text past a field's
// limit is cut (Pitaka keeps the same lengths), so a bank email with a long footer still arrives.
const MAX_BODY = 64 * 1024;
const MAX_PENDING = 5000;
const PULL_PAGE = 100;
const PAIR_TRIES = 10; // wrong setup secrets an hour, from everywhere together, before pairing pauses
const HOUR = 3600 * 1000;
const INFO = 'pitaka-relay-v1';
const TYPES = ['entry', 'text', 'sms', 'email', 'wallet', 'balance', 'test'];
// Fields an item may carry, with their size limits in UTF-16 units (as Pitaka counts). Anything else is
// dropped.
const FIELDS = {
  entry: { amount: 40, category: 60, wallet: 60, note: 200 },
  text: { text: 300 },
  sms: { sender: 80, text: 4000 },
  email: { from: 200, subject: 300, body: 8000 },
  wallet: { merchant: 120, amount: 40, card: 60, name: 60 },
  balance: { wallet: 60, amount: 40 },
  test: { source: 30 },
};
const NAME = 60; // category and wallet names in the config: what an entry can send back
// Automations may arrive empty: tapping play in the Shortcuts editor runs them without a message, and
// Pitaka counts that as a test.
const NEEDS = { entry: ['amount'], text: ['text'], sms: [], email: [], wallet: [], balance: ['wallet', 'amount'], test: [] };
const ID = /^[A-Za-z0-9._:-]{6,64}$/;
const KEY = /^i:[a-z0-9]{6,14}:[a-z0-9]{8,16}$/;
const HASH = /^[0-9a-f]{64}$/;
// Every route and its methods. Anything else is answered before tokens or the database are looked at.
const ROUTES = { '/': ['GET'], '/pair': ['POST'], '/in': ['POST'], '/config': ['GET', 'PUT'], '/pull': ['GET'], '/ack': ['POST'], '/rotate': ['POST'], '/status': ['GET'] };

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();
// A loop, not String.fromCharCode(...bytes): spreading a 64 KB ciphertext overflows the call stack.
function b64u(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
// Two SHA-256 hex digests compared without an early exit. The token is hashed first, so the time taken
// says nothing about the stored hash.
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HASH.test(a) || !HASH.test(b)) return false;
  let d = 0;
  for (let i = 0; i < 64; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => (x % 36).toString(36)).join(''); };
// Cuts text to `max` UTF-16 units without leaving half of an emoji at the end.
function cut(s, max) {
  if (s.length <= max) return s;
  const t = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
}
// "2026-10-19 09:23 (Manila time)". Manila is UTC+8 all year, so no time zone data is needed.
const when = (t) => `${new Date(Number(t) + 8 * HOUR).toISOString().slice(0, 16).replace('T', ' ')} (Manila time)`;

// The client, for rate limits: an IPv4 address, or the /64 network of an IPv6 one. One phone or home
// network gets a whole /64, so counting single IPv6 addresses would give one client billions of tries.
function clientOf(req) {
  const ip = (req.headers.get('CF-Connecting-IP') || 'local').toLowerCase();
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // ::ffff:1.2.3.4
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail === undefined ? [] : tail ? tail.split(':') : [];
  const all = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// ALLOWED_ORIGIN entries as browsers send them: "https://Name.github.io/pitaka/" -> "https://name.github.io".
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map((s) => {
    const t = s.trim();
    if (!t) return '';
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).origin; } catch { return ''; }
  }).filter((o) => o && o !== 'null');
}
function cors(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return { ok: true, headers: {} }; // Shortcuts and other non-browser clients send no Origin
  if (!allowedOrigins(env).includes(origin)) {
    // The refusal is readable by that page, so Pitaka can say what to fix. Nothing else happens for it,
    // and its preflights fail, so it can't send a token.
    return { ok: false, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
  }
  return { ok: true, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' } };
}
function reply(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}

// ---------------------------------------------------------------- rate limits
// One-minute windows per client and route, counted in this Worker instance (Cloudflare may run several,
// so a determined client gets a few times the limit). That is enough for tokens, which are 256-bit
// random; the setup secret also has a limit kept in the database. With a LIMITER binding, Cloudflare's
// rate limiting is asked as well.
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
  if (list.length >= perMinute) return true; // not recorded, so a flood can't grow the list
  list.push(Date.now());
  return false;
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
const purge = (db, now) => db.prepare('DELETE FROM items WHERE exp <= ?').bind(now);
async function pendingCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE exp > ?').bind(Date.now()).first();
  return Number(row?.n) || 0;
}
// Is the inbox full? D1 bills every row a query reads, and counting reads every waiting row. Row ids
// only grow, so (newest - oldest + 1) is an upper bound read from two rows; only near the limit are the
// rows counted, and a full inbox is remembered for a minute (or until an acknowledgement).
const fullUntil = new WeakMap();
async function inboxFull(db, bounds, now) {
  if (now < (fullUntil.get(db) || 0)) return true;
  if (!bounds?.hi || bounds.hi - bounds.lo + 1 < MAX_PENDING) return false;
  if ((await pendingCount(db)) < MAX_PENDING) return false;
  fullUntil.set(db, now + 60000);
  return true;
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
    // An amount that long isn't one; cutting it would change it. Text is cut to its limit.
    if (k === 'amount' && s.length > max) return { error: `amount is longer than ${max} characters` };
    item[k] = cut(s, max);
  }
  for (const k of NEEDS[x.type]) if (!item[k] || !item[k].trim()) return { error: `${k} is missing` };
  // The time it happened, when the shortcut sends one: within the last year and at most a day ahead.
  // Anything else (a wrong clock, Unix seconds instead of milliseconds) is left out, and Pitaka uses
  // receivedAt.
  const t = typeof x.at === 'number' ? x.at : typeof x.at === 'string' ? Date.parse(x.at) : NaN;
  if (Number.isFinite(t) && t > now - 366 * 86400000 && t <= now + 86400000) item.at = new Date(t).toISOString();
  item.receivedAt = new Date(now).toISOString();
  return { item };
}
function validateConfig(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const list = (v, n) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => cut(s, NAME)).slice(0, n) : []);
  return { v: 1, categories: list(x.categories, 60), wallets: list(x.wallets, 30), defaultWallet: typeof x.defaultWallet === 'string' ? cut(x.defaultWallet, NAME) : '', updatedAt: new Date().toISOString() };
}
const validJwk = (k) => !!k && typeof k === 'object' && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && /^[\w-]{43}$/.test(k.x) && /^[\w-]{43}$/.test(k.y) && !('d' in k);
// Importing checks the point is on the curve; a bad one would make every later send fail.
async function usableKey(jwk) {
  try { await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []); return true; } catch { return false; }
}

// Content-Length can be missing (a chunked upload) or wrong, so the body is read with a running byte
// count and dropped as soon as it is too big.
async function readJson(req) {
  const tooBig = { status: 413, error: `The request is bigger than ${MAX_BODY / 1024} KB` };
  if (Number(req.headers.get('content-length')) > MAX_BODY) return tooBig;
  const buf = new Uint8Array(MAX_BODY);
  let n = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > MAX_BODY) { reader.cancel().catch(() => {}); return tooBig; }
      buf.set(value, n);
      n += value.byteLength;
    }
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)); } catch { return { error: 'The body must be UTF-8 JSON' }; }
  try { return { body: JSON.parse(text) }; } catch { return { error: 'The body must be JSON' }; }
}

// A token from an earlier pairing, or a write token that was replaced: say so instead of "wrong token".
function retiredNotice(pair, hash) {
  const r = (pair.retired || []).find((x) => sameHash(hash, x.h));
  if (!r) return null;
  const from = r.from ? ` (from ${r.from})` : '';
  if (r.why === 'rotated') return { error: `This write token was replaced on ${when(r.at)}. Copy the new one from Pitaka (Settings → Inbox relay) into your shortcuts.`, reason: 'token-replaced', at: r.at };
  return {
    error: r.kind === 'read'
      ? `This relay was paired again on ${when(r.at)}${from}. If that wasn't you, your setup secret is known to someone else: change ADMIN_SECRET in Cloudflare, then pair again.`
      : `This relay was paired again on ${when(r.at)}${from}. Copy the new write token from Pitaka (Settings → Inbox relay) into your shortcuts.`,
    reason: 'paired-again',
    at: r.at,
  };
}
const retire = (list, entries) => [...entries, ...(list || [])].slice(0, 6);

// ---------------------------------------------------------------- the routes
async function handle(req, env, c) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!c.ok) return reply(403, { error: "This relay doesn't accept this address: set ALLOWED_ORIGIN to your Pitaka address" }, req.method === 'OPTIONS' ? {} : c.headers);
  const out = (status, body, extra = {}) => reply(status, body, { ...c.headers, ...extra });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...c.headers, 'Cache-Control': 'no-store' } });
  const methods = ROUTES[path];
  if (!methods) return out(404, { error: 'not found' });
  if (!methods.includes(req.method)) return out(405, { error: `Use ${methods.join(' or ')} for ${path}` }, { Allow: methods.join(', ') });
  const db = env.DB;
  if (!db?.prepare) return out(500, { error: 'The DB binding (a D1 database) is missing' });
  await schema(db);
  const ip = clientOf(req);
  const now = Date.now();

  if (path === '/') return out(200, { ok: true, service: 'pitaka-relay', paired: !!(await getMeta(db, 'pair')) });

  // Tokens: the one presented is hashed, then compared in constant time with the stored hash.
  // Twenty wrong tokens in a minute lock that client out for the rest of the minute.
  if (count(`fail:${ip}`).length >= 20) return out(429, { error: 'too many wrong tokens, wait a minute' });
  const fail = () => { count(`fail:${ip}`).push(Date.now()); return out(401, { error: 'wrong token' }); };
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const hash = await sha256hex(bearer);

  if (path === '/pair') {
    if (await limited(env, `pair:${ip}`, 10)) return out(429, { error: 'slow down' });
    // Pasted secrets often carry a space or a line break at the end; Pitaka trims what it sends.
    const secret = String(env.ADMIN_SECRET || '').trim();
    if (secret.length < 16) return out(500, { error: 'Set the ADMIN_SECRET secret (16 characters or more) first' });
    const { body, error, status } = await readJson(req);
    const old = await getMeta(db, 'pair');
    // Every try is counted before the secret is checked, in one atomic statement, so parallel guesses
    // can't share a count; a paused relay is answered from one read, without writing. Keeping the
    // current write token (a new phone, after a restore) proves more than the secret, so it isn't
    // paused: whoever is guessing can't stop you from pairing.
    const keeps = !!old && HASH.test(body?.writeHash || '') && sameHash(body.writeHash, old.writeHash);
    const paused = { error: 'Too many wrong setup secrets in the last hour, so pairing is paused for an hour. To pair now, also paste the write token from one of your shortcuts.', reason: 'pair-paused' };
    if (!keeps) {
      const tries = await getMeta(db, 'pairtries');
      if (tries && now - tries.since < HOUR && tries.n >= PAIR_TRIES) return out(429, paused, { 'Retry-After': '3600' });
    }
    const row = await db.prepare("INSERT INTO meta (k, v) VALUES ('pairtries', json_object('n', 1, 'since', ?)) ON CONFLICT (k) DO UPDATE SET v = CASE WHEN json_extract(meta.v, '$.since') > ? THEN json_set(meta.v, '$.n', json_extract(meta.v, '$.n') + 1) ELSE excluded.v END RETURNING v").bind(now, now - HOUR).first();
    if (!keeps && (JSON.parse(row?.v || '{}').n || 0) > PAIR_TRIES) return out(429, paused, { 'Retry-After': '3600' });
    if (!bearer || !sameHash(hash, await sha256hex(secret))) return fail();
    await db.prepare("DELETE FROM meta WHERE k = 'pairtries'").run();
    if (error) return out(status || 400, { error });
    if (!validJwk(body?.publicKey) || !HASH.test(body.readHash || '') || !HASH.test(body.writeHash || '') || body.readHash === body.writeHash) return out(400, { error: 'publicKey (a P-256 public JWK), readHash and writeHash (two different SHA-256 hex digests) are required' });
    const publicKey = { kty: 'EC', crv: 'P-256', x: body.publicKey.x, y: body.publicKey.y };
    if (!(await usableKey(publicKey))) return out(400, { error: 'publicKey is not a P-256 point' });
    // The old tokens are kept as hashes, so they can be told this happened (and from which country).
    const from = typeof req.cf?.country === 'string' ? req.cf.country.slice(0, 2) : null;
    const gone = old ? [{ h: old.readHash, kind: 'read' }, ...(keeps ? [] : [{ h: old.writeHash, kind: 'write' }])].map((x) => ({ ...x, why: 'paired', at: now, from })) : [];
    await putMeta(db, 'pair', { publicKey, readHash: body.readHash, writeHash: body.writeHash, pairedAt: new Date(now).toISOString(), retired: retire(old?.retired, gone).filter((x) => x.h !== body.readHash && x.h !== body.writeHash) });
    return out(200, { ok: true, pending: await pendingCount(db) });
  }

  const pair = await getMeta(db, 'pair');
  if (!pair) return out(409, { error: 'not paired yet: pair from Pitaka first' });
  const isWrite = !!bearer && sameHash(hash, pair.writeHash);
  const isRead = !!bearer && sameHash(hash, pair.readHash);
  // A token that used to work isn't a guess: it gets the reason, and isn't counted toward the lockout.
  const denied = () => { const r = bearer && retiredNotice(pair, hash); return r ? out(401, r) : fail(); };

  // ---- write token: add an item, read the shortcut config
  if (path === '/in') {
    if (!isWrite) return denied();
    if (await limited(env, `in:${ip}`, Number(env.LIMIT_IN_PER_MIN) || 30)) return out(429, { error: 'slow down' });
    const { body, error, status } = await readJson(req);
    if (error) return out(status || 400, { error });
    const v = validateItem(body, now);
    if (v.error) return out(400, { error: v.error });
    // Expired items go here too, so they are deleted even if Pitaka isn't opened for a while.
    const [, bounds] = await db.batch([purge(db, now), db.prepare('SELECT (SELECT MIN(rowid) FROM items) AS lo, (SELECT MAX(rowid) FROM items) AS hi')]);
    if (await inboxFull(db, bounds?.results?.[0], now)) return out(507, { error: 'the inbox is full: open Pitaka to collect it' });
    const box = await encryptFor(pair.publicKey, JSON.stringify(v.item));
    await db.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)').bind(`i:${now.toString(36)}:${rand(12)}`, JSON.stringify(box), now + ITEM_TTL).run();
    return out(200, { ok: true, id: v.item.id });
  }
  if (path === '/config' && req.method === 'GET') {
    if (!isWrite && !isRead) return denied();
    if (await limited(env, `cfg:${ip}`, 60)) return out(429, { error: 'slow down' });
    return out(200, (await getMeta(db, 'config')) || { v: 1, categories: [], wallets: [], defaultWallet: '', updatedAt: null });
  }

  // ---- read token: publish the config, collect, acknowledge, replace the write token, status
  if (!isRead) return denied();
  if (await limited(env, `read:${ip}`, Number(env.LIMIT_READ_PER_MIN) || 120)) return out(429, { error: 'slow down' });
  if (path === '/config') {
    const { body, error, status } = await readJson(req);
    if (error) return out(status || 400, { error });
    const cfg = validateConfig(body);
    if (!cfg) return out(400, { error: 'config must be an object' });
    await putMeta(db, 'config', cfg);
    return out(200, { ok: true, updatedAt: cfg.updatedAt });
  }
  if (path === '/pull') {
    const after = url.searchParams.get('after') || '';
    const [, page1] = await db.batch([purge(db, now), db.prepare('SELECT k, box FROM items WHERE k > ? AND exp > ? ORDER BY k LIMIT ?').bind(KEY.test(after) ? after : '', now, PULL_PAGE + 1)]);
    const results = page1?.results || [];
    const page = results.slice(0, PULL_PAGE);
    const items = page.map((r) => { try { return { key: r.k, box: JSON.parse(r.box) }; } catch { return { key: r.k, box: null }; } });
    return out(200, { items, more: results.length > PULL_PAGE, after: page.length ? page[page.length - 1].k : null });
  }
  if (path === '/ack') {
    const { body, error, status } = await readJson(req);
    if (error) return out(status || 400, { error });
    const keys = [...new Set(Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && KEY.test(k)) : [])].slice(0, 500);
    // D1 allows 100 bound parameters a statement: 50 keys each, all in one round trip.
    const parts = [];
    for (let i = 0; i < keys.length; i += 50) parts.push(keys.slice(i, i + 50));
    const done = parts.length ? await db.batch(parts.map((p) => db.prepare(`DELETE FROM items WHERE k IN (${p.map(() => '?').join(', ')})`).bind(...p))) : [];
    const deleted = done.reduce((n, r) => n + (Number(r?.meta?.changes) || 0), 0);
    if (deleted) fullUntil.delete(db);
    return out(200, { ok: true, deleted });
  }
  if (path === '/rotate') {
    const { body, error, status } = await readJson(req);
    if (error) return out(status || 400, { error });
    if (!HASH.test(body?.writeHash || '') || body.writeHash === pair.readHash) return out(400, { error: 'writeHash (a SHA-256 hex digest) is required' });
    const gone = body.writeHash === pair.writeHash ? [] : [{ h: pair.writeHash, kind: 'write', why: 'rotated', at: now }];
    await putMeta(db, 'pair', { ...pair, writeHash: body.writeHash, rotatedAt: new Date(now).toISOString(), retired: retire(pair.retired, gone).filter((x) => x.h !== body.writeHash) });
    return out(200, { ok: true });
  }
  // /status
  const cfg = await getMeta(db, 'config');
  return out(200, { ok: true, paired: true, pairedAt: pair.pairedAt, pending: await pendingCount(db), configAt: cfg?.updatedAt || null });
}

export default {
  async fetch(req, env) {
    let c = { ok: true, headers: {} };
    try {
      c = cors(req, env);
      return await handle(req, env, c);
    } catch (e) {
      // Only the error type, never the request or its body. CORS headers too, so Pitaka can read it.
      console.error('relay error', e?.name || 'Error');
      return reply(500, { error: 'relay error' }, c.headers);
    }
  },
  // The optional daily Cron Trigger: deletes items nobody collected within 30 days.
  async scheduled(_controller, env) {
    try {
      if (!env.DB?.prepare) return;
      await schema(env.DB);
      await purge(env.DB, Date.now()).run();
    } catch (e) { console.error('relay cleanup error', e?.name || 'Error'); }
  },
};
