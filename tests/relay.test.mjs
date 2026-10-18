// The inbox relay (relay/worker.js) driven through its fetch handler with a mocked D1 database (an
// in-memory SQLite), and the client (js/relay-client.js) talking to it: pairing, token scopes, validation,
// sealing and opening items, acknowledging, expiry, rate limits, CORS and logging.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP } from './env-relay.mjs';

const worker = (await import(`${APP}/relay/worker.js`)).default;
const C = await import(`${APP}/js/relay-client.js`);
const { DatabaseSync } = await import('node:sqlite');

// D1's binding API over node:sqlite. Like D1, binding `undefined` is an error.
function mockD1() {
  const sql = new DatabaseSync(':memory:');
  const stmt = (q, args = []) => ({
    bind(...a) {
      if (a.some((v) => v === undefined)) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
      return stmt(q, a);
    },
    async first() { return sql.prepare(q).get(...args) ?? null; },
    async all() { return { success: true, results: sql.prepare(q).all(...args), meta: {} }; },
    async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

const ORIGIN = 'https://nykkoferrerava.github.io';
const BASE = 'https://pitaka-relay.example.workers.dev';
const SECRET = 'correct-horse-battery-staple';
let env;
let ip = 0;
let clientIp = '';
let origin = '';
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

// The client's requests go straight into the Worker, from one "phone" (IP address) per test.
C.useFetch((url, init = {}) => worker.fetch(new Request(url, { method: init.method, headers: { ...init.headers, 'CF-Connecting-IP': clientIp, ...(origin ? { Origin: origin } : {}) }, body: init.body }), env));
const raw = (path, { method = 'GET', token, body, headers = {} } = {}) => worker.fetch(new Request(`${BASE}${path}`, {
  method,
  headers: { 'CF-Connecting-IP': clientIp, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}), env);
const json = async (res) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  env = { DB: mockD1(), ADMIN_SECRET: SECRET, ALLOWED_ORIGIN: `${ORIGIN}, https://example.org/`, LIMIT_IN_PER_MIN: '1000' };
  clientIp = `10.0.0.${++ip}`;
  origin = '';
  offset = 0;
});
async function paired() {
  const p = await C.pair(BASE, SECRET);
  return { ...p, key: p.privateKey, relay: p.relay };
}
const entry = (o = {}) => ({ type: 'entry', id: `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, amount: 150, category: '🍜 Food', wallet: 'GCash', ...o });

describe('relay: pairing', () => {
  test('an address check works before pairing; everything else waits for it', async () => {
    assert.deepEqual(await C.probe(BASE), { paired: false });
    assert.equal((await raw('/in', { method: 'POST', token: 'x', body: entry() })).status, 409);
  });
  test('needs the right admin secret, and ADMIN_SECRET must be set and long enough', async () => {
    await assert.rejects(C.pair(BASE, 'wrong-secret-wrong-secret'), { code: 'auth' });
    env.ADMIN_SECRET = 'short';
    await assert.rejects(C.pair(BASE, 'short'), { code: 'server' });
    delete env.ADMIN_SECRET;
    await assert.rejects(C.pair(BASE, SECRET), { code: 'server' });
  });
  test('stores only the public key and the token hashes', async () => {
    const { relay, key } = await paired();
    assert.equal(key.extractable, false, 'the private key cannot be exported');
    assert.deepEqual(key.usages, ['deriveBits']);
    assert.match(relay.read, /^[\w-]{43}$/, '256-bit tokens');
    assert.match(relay.write, /^[\w-]{43}$/);
    assert.notEqual(relay.read, relay.write);
    const stored = env.DB.sql.prepare("SELECT v FROM meta WHERE k = 'pair'").get().v;
    assert.ok(!stored.includes(relay.read) && !stored.includes(relay.write), 'tokens are never stored');
    const pair = JSON.parse(stored);
    assert.deepEqual(Object.keys(pair.publicKey).sort(), ['crv', 'kty', 'x', 'y']);
    assert.equal(pair.readHash, await C.sha256hex(relay.read));
    assert.deepEqual(await C.probe(BASE), { paired: true });
  });
  test('rejects a private key, equal hashes and junk', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const h = await C.sha256hex('a');
    const h2 = await C.sha256hex('b');
    for (const body of [{ publicKey: jwk, readHash: h, writeHash: h2 }, { publicKey: { ...jwk, d: undefined, kty: 'RSA' }, readHash: h, writeHash: h2 }, { publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, readHash: h, writeHash: h }, { publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, readHash: 'nothex', writeHash: h2 }]) {
      assert.equal((await raw('/pair', { method: 'POST', token: SECRET, body })).status, 400);
    }
    assert.equal((await raw('/pair', { method: 'POST', token: SECRET, body: '{nope' })).status, 400);
  });
  test('pairing again replaces both tokens; items sealed for the old key are reported, not lost silently', async () => {
    const a = await paired();
    await C.send(a.relay, entry({ note: 'before' }));
    const b = await paired();
    await assert.rejects(C.send(a.relay, entry()), { code: 'auth' });
    await assert.rejects(C.collect(a.relay, a.key), { code: 'auth' });
    await C.send(b.relay, entry({ note: 'after' }));
    const got = await C.collect(b.relay, b.key);
    assert.deepEqual(got.items.map((x) => x.item.note), ['after']);
    assert.equal(got.unreadable.length, 1);
    assert.equal(b.pending, 1, 'pairing says how many items were waiting');
  });
});

describe('relay: the two tokens', () => {
  test('the write token adds items and reads the config, and nothing else', async () => {
    const { relay } = await paired();
    const w = relay.write;
    assert.equal((await raw('/in', { method: 'POST', token: w, body: entry() })).status, 200);
    assert.equal((await raw('/config', { token: w })).status, 200);
    for (const [path, method, body] of [['/pull', 'GET'], ['/ack', 'POST', { keys: [] }], ['/config', 'PUT', { categories: [] }], ['/status', 'GET'], ['/rotate', 'POST', { writeHash: 'a'.repeat(64) }], ['/pair', 'POST', {}]]) {
      assert.equal((await raw(path, { method, token: w, body })).status, 401, `${method} ${path}`);
    }
  });
  test('the read token collects, acknowledges, publishes the config, but cannot add items', async () => {
    const { relay } = await paired();
    const r = relay.read;
    assert.equal((await raw('/in', { method: 'POST', token: r, body: entry() })).status, 401);
    for (const [path, method, body] of [['/pull', 'GET'], ['/ack', 'POST', { keys: [] }], ['/config', 'PUT', { categories: [] }], ['/status', 'GET'], ['/config', 'GET']]) {
      assert.equal((await raw(path, { method, token: r, body })).status, 200, `${method} ${path}`);
    }
    assert.equal((await raw('/pair', { method: 'POST', token: r, body: {} })).status, 401, 'cannot re-pair');
  });
  test('no token, a wrong token, or a token in the wrong place: 401', async () => {
    const { relay } = await paired();
    assert.equal((await raw('/pull')).status, 401);
    assert.equal((await raw('/pull', { token: `${relay.read}x` })).status, 401);
    assert.equal((await raw(`/pull?token=${relay.read}`)).status, 401);
    assert.equal((await raw('/pull', { headers: { Authorization: relay.read } })).status, 200, 'the Bearer prefix is optional');
  });
  test('twenty wrong tokens in a minute lock that client out for the minute', async () => {
    const { relay } = await paired();
    for (let i = 0; i < 20; i++) assert.equal((await raw('/pull', { token: `bad${i}` })).status, 401);
    assert.equal((await raw('/pull', { token: relay.read })).status, 429, 'even the right token waits');
    offset += 61000;
    assert.equal((await raw('/pull', { token: relay.read })).status, 200);
  });
  test('a new write token replaces the old one at once', async () => {
    const { relay } = await paired();
    const next = await C.rotateWrite(relay);
    assert.notEqual(next.write, relay.write);
    await assert.rejects(C.send(relay, entry()), { code: 'auth' });
    assert.equal((await C.send(next, entry())).ok, true);
    assert.equal((await raw('/rotate', { method: 'POST', token: relay.read, body: { writeHash: await C.sha256hex(relay.read) } })).status, 400, 'cannot make the write token equal the read token');
  });
});

describe('relay: what an item may contain', () => {
  test('rejects unknown types, bad ids, missing or oversized fields, non-JSON and big bodies', async () => {
    const { relay } = await paired();
    const w = relay.write;
    const bad = [
      { type: 'nope', id: 'abcdef1' },
      { type: 'entry', id: 'x', amount: 1 },
      { type: 'entry', id: 'abc def ghi', amount: 1 },
      { type: 'entry', id: 'abcdef1' },
      { type: 'text', id: 'abcdef1', text: '   ' },
      { type: 'text', id: 'abcdef1', text: 'x'.repeat(301) },
      { type: 'sms', id: 'abcdef1', sender: 'GCash', text: { nested: true } },
      { type: 'balance', id: 'abcdef1', wallet: 'GCash' },
      { type: 'email', id: 'abcdef1', from: 'a@b.c' },
      [entry()],
      'null',
    ];
    for (const body of bad) assert.equal((await raw('/in', { method: 'POST', token: w, body })).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await raw('/in', { method: 'POST', token: w, body: '{"type":' })).status, 400);
    assert.equal((await raw('/in', { method: 'POST', token: w, body: { ...entry(), note: 'x'.repeat(17000) } })).status, 400, 'over 16 KB');
    assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  });
  test('keeps known fields only, accepts { item }, makes an id when none is sent, ignores an unreadable time', async () => {
    const { relay, key } = await paired();
    await C.send(relay, { item: { ...entry({ id: 'quick-123456' }), evil: '<script>', at: '2026-10-18T12:41:00+08:00' } });
    await C.send(relay, { type: 'sms', sender: 'GCash', text: 'You have paid P289.00 to JOLLIBEE', at: 'Oct 18, 2026 at 12:41 PM' });
    await C.send(relay, { type: 'balance', id: 'bal-1234567', wallet: 'GCash', amount: 5361.5, at: Date.now() + 9 * 86400000 });
    const { items } = await C.collect(relay, key);
    const [a, b, c] = items.map((x) => x.item);
    assert.deepEqual(Object.keys(a).sort(), ['amount', 'at', 'category', 'id', 'receivedAt', 'type', 'wallet']);
    assert.equal(a.id, 'quick-123456');
    assert.equal(a.at, '2026-10-18T04:41:00.000Z');
    assert.equal(a.amount, '150', 'numbers arrive as text, as from Shortcuts');
    assert.match(b.id, /^r-[a-z0-9]+-[a-z0-9]{8}$/);
    assert.equal(b.at, undefined, "a time the relay can't read is left out; Pitaka uses receivedAt");
    assert.ok(Date.parse(c.at) <= Date.now() + 86400000, 'a time in the future is capped at a day ahead');
  });
});

describe('relay: sealed items', () => {
  test('stored as ciphertext only, a new ephemeral key per item, opened by the paired key', async () => {
    const { relay, key } = await paired();
    await C.send(relay, entry({ note: 'Jollibee with Mel' }));
    await C.send(relay, { type: 'sms', id: 'sms-1234567', sender: 'GCash', text: 'You have paid P289.00 to JOLLIBEE. Ref 9876543210123' });
    const rows = env.DB.sql.prepare('SELECT box FROM items').all();
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(!/Jollibee|JOLLIBEE|GCash|289|150/.test(r.box), 'no plaintext at rest');
    const boxes = rows.map((r) => JSON.parse(r.box));
    assert.notEqual(boxes[0].epk, boxes[1].epk);
    assert.equal(boxes[0].alg, 'ECDH-ES+A256GCM');
    const { items, unreadable } = await C.collect(relay, key);
    assert.deepEqual(unreadable, []);
    assert.deepEqual(items.map((x) => x.item.note || x.item.text), ['Jollibee with Mel', 'You have paid P289.00 to JOLLIBEE. Ref 9876543210123']);
  });
  test('a changed byte, or another key, cannot open an item', async () => {
    const { relay, key } = await paired();
    await C.send(relay, entry());
    const { box } = (await (await raw('/pull', { token: relay.read })).json()).items[0];
    const flip = (s) => (s[5] === 'A' ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
    await assert.rejects(C.openBox(key, { ...box, ct: flip(box.ct) }));
    await assert.rejects(C.openBox(key, { ...box, iv: flip(box.iv) }));
    const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    await assert.rejects(C.openBox(other.privateKey, box));
    assert.equal((await C.openBox(key, box)).amount, '150');
  });
});

describe('relay: collecting and acknowledging', () => {
  test('items stay until acknowledged, then are deleted', async () => {
    const { relay, key } = await paired();
    for (let i = 0; i < 3; i++) await C.send(relay, entry({ note: `n${i}` }));
    const first = await C.collect(relay, key);
    assert.equal((await C.collect(relay, key)).items.length, 3, 'collecting alone deletes nothing');
    assert.equal(await C.ack(relay, first.items.slice(0, 2).map((x) => x.key)), 2);
    assert.deepEqual((await C.collect(relay, key)).items.map((x) => x.item.note), ['n2']);
    assert.equal((await C.status(relay)).pending, 1);
  });
  test('ack ignores anything that is not an item key', async () => {
    const { relay } = await paired();
    await C.send(relay, entry());
    const res = await json(await raw('/ack', { method: 'POST', token: relay.read, body: { keys: ["i:1' OR '1'='1", 'pair', 'config', 42, null] } }));
    assert.deepEqual(res, { status: 200, body: { ok: true, deleted: 0 } });
    assert.ok(env.DB.sql.prepare("SELECT v FROM meta WHERE k = 'pair'").get(), 'the pairing is untouched');
    assert.equal((await C.status(relay)).pending, 1);
  });
  test('pages through a long backlog in order', async () => {
    const { relay, key } = await paired();
    for (let i = 0; i < 230; i++) { offset += 5; await C.send(relay, entry({ note: String(i) })); }
    const { items } = await C.collect(relay, key);
    assert.equal(items.length, 230);
    assert.deepEqual(items.map((x) => Number(x.item.note)), [...Array(230).keys()]);
    assert.equal(await C.ack(relay, items.map((x) => x.key)), 230);
    assert.equal((await C.status(relay)).pending, 0);
  });
  test('unacknowledged items expire after 30 days', async () => {
    const { relay, key } = await paired();
    await C.send(relay, entry({ note: 'old' }));
    offset += 29 * 86400000;
    await C.send(relay, entry({ note: 'newer' }));
    assert.equal((await C.collect(relay, key)).items.length, 2, 'day 29: both there');
    offset += 1 * 86400000 + 1000;
    assert.deepEqual((await C.collect(relay, key)).items.map((x) => x.item.note), ['newer']);
    assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1, 'expired rows are deleted, not just hidden');
    assert.equal((await C.status(relay)).pending, 1);
  });
  test('a full inbox refuses new items instead of growing without limit', async () => {
    const { relay } = await paired();
    const ins = env.DB.sql.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)');
    for (let i = 0; i < 5000; i++) ins.run(`i:${(1e12 + i).toString(36)}:aaaaaaaaaaaa`, '{}', Date.now() + 86400000);
    await assert.rejects(C.send(relay, entry()), { code: 'full' });
  });
});

describe('relay: the shortcut config', () => {
  test('Pitaka publishes it with the read token, shortcuts read it with the write token, trimmed and checked', async () => {
    const { relay } = await paired();
    const empty = await C.readConfig(relay);
    assert.deepEqual(empty.categories, []);
    await C.publishConfig(relay, { categories: ['🍜 Food', 42, '', 'x'.repeat(100)], wallets: ['Cash', 'GCash'], defaultWallet: 'GCash', extra: 'dropped' });
    const cfg = await C.readConfig(relay);
    assert.deepEqual(cfg.categories, ['🍜 Food', 'x'.repeat(64)]);
    assert.deepEqual(cfg.wallets, ['Cash', 'GCash']);
    assert.equal(cfg.defaultWallet, 'GCash');
    assert.equal(cfg.extra, undefined);
    assert.equal((await raw('/config', { method: 'PUT', token: relay.read, body: [1, 2] })).status, 400);
  });
});

describe('relay: rate limits, CORS and logging', () => {
  test('more than the per-minute limit from one client gets 429', async () => {
    const { relay } = await paired();
    env.LIMIT_IN_PER_MIN = '5';
    for (let i = 0; i < 5; i++) await C.send(relay, entry());
    await assert.rejects(C.send(relay, entry()), { code: 'busy' });
    clientIp = '10.9.9.9';
    assert.equal((await C.send(relay, entry())).ok, true, 'another client is not affected');
    offset += 61000;
    clientIp = `10.0.0.${ip}`;
    assert.equal((await C.send(relay, entry())).ok, true, 'and the window moves on');
  });
  test('only your Pitaka address may call it from a browser; shortcuts send no Origin', async () => {
    const { relay } = await paired();
    origin = 'https://evil.example';
    await assert.rejects(C.status(relay), { code: 'origin' });
    const pre = await raw('/pull', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
    origin = ORIGIN;
    const ok = await raw('/status', { token: relay.read, headers: { Origin: ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(ok.headers.get('Cache-Control'), 'no-store');
    const opt = await raw('/pull', { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(opt.status, 204, 'a trailing slash in ALLOWED_ORIGIN is fine');
    assert.match(opt.headers.get('Access-Control-Allow-Headers'), /authorization/);
    origin = '';
    assert.equal((await C.status(relay)).ok, true, 'no Origin header: allowed');
  });
  test('never logs a request body or a token, even when something breaks', async () => {
    const { relay } = await paired();
    const logged = [];
    const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(keep)) console[k] = (...a) => logged.push(a.map(String).join(' '));
    try {
      await C.send(relay, entry({ note: 'SECRET-NOTE' }));
      env.DB.prepare = () => { throw new Error('D1 down SECRET-NOTE'); };
      const res = await raw('/in', { method: 'POST', token: relay.write, body: entry({ note: 'SECRET-NOTE' }) });
      assert.deepEqual(await json(res), { status: 500, body: { error: 'relay error' } });
    } finally { Object.assign(console, keep); }
    assert.deepEqual(logged, ['relay error Error']);
    assert.ok(!logged.join(' ').includes(relay.write));
  });
});

describe('relay client', () => {
  test('relay addresses', () => {
    assert.equal(C.relayUrl('pitaka-relay.nykko.workers.dev'), 'https://pitaka-relay.nykko.workers.dev');
    assert.equal(C.relayUrl(' https://pitaka-relay.nykko.workers.dev/ '), 'https://pitaka-relay.nykko.workers.dev');
    assert.equal(C.relayUrl('http://localhost:8787'), 'http://localhost:8787');
    for (const bad of ['', 'http://pitaka.example.com', 'https://a.dev/?token=x', 'https://user:pw@a.dev', 'ftp://a.dev', 'https://']) assert.throws(() => C.relayUrl(bad), { code: 'invalid' }, bad);
  });
  test('tokens and secrets are random and long enough', () => {
    const t = new Set(Array.from({ length: 50 }, C.newToken));
    assert.equal(t.size, 50);
    for (const x of t) assert.equal(C.fromB64u(x).length, 32);
    assert.ok(C.newAdminSecret().length >= 32);
  });
  test('a network failure is a RelayError, never a raw TypeError', async () => {
    C.useFetch(async () => { throw new TypeError('Load failed'); });
    try { await assert.rejects(C.probe(BASE), { name: 'RelayError', code: 'network' }); } finally {
      C.useFetch((url, init = {}) => worker.fetch(new Request(url, { method: init.method, headers: { ...init.headers, 'CF-Connecting-IP': clientIp, ...(origin ? { Origin: origin } : {}) }, body: init.body }), env));
    }
  });
  test('an address that is not a Pitaka relay is caught', async () => {
    C.useFetch(async () => new Response('<html>', { status: 200 }));
    try { await assert.rejects(C.probe(BASE), { code: 'invalid' }); } finally {
      C.useFetch((url, init = {}) => worker.fetch(new Request(url, { method: init.method, headers: { ...init.headers, 'CF-Connecting-IP': clientIp, ...(origin ? { Origin: origin } : {}) }, body: init.body }), env));
    }
  });
});
