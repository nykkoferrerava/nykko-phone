// The inbox relay (relay/worker.js) driven through its fetch handler with a mocked D1 database (an
// in-memory SQLite), and the client (js/relay-client.js) talking to it: pairing, token scopes, validation,
// sealing and opening items, acknowledging, expiry, rate limits, CORS and logging.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP, mockD1 } from './env-relay.mjs';

const worker = (await import(`${APP}/relay/worker.js`)).default;
const C = await import(`${APP}/js/relay-client.js`);
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
  body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
}), env);
const json = async (res) => ({ status: res.status, body: await res.json() });
// The SQL of every statement the Worker prepares from now on.
const spy = () => { const qs = []; const prep = env.DB.prepare; env.DB.prepare = (q) => { qs.push(q); return prep(q); }; return qs; };

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
  test('rejects unknown types, bad ids, missing fields, odd values, a long amount, non-JSON and big bodies', async () => {
    const { relay } = await paired();
    const w = relay.write;
    const bad = [
      { type: 'nope', id: 'abcdef1' },
      { type: 'entry', id: 'x', amount: 1 },
      { type: 'entry', id: 'abc def ghi', amount: 1 },
      { type: 'entry', id: 'abcdef1' },
      { type: 'entry', id: 'abcdef1', amount: '1'.repeat(41) },
      { type: 'text', id: 'abcdef1', text: '   ' },
      { type: 'sms', id: 'abcdef1', sender: 'GCash', text: { nested: true } },
      { type: 'balance', id: 'abcdef1', wallet: 'GCash' },
      [entry()],
      'null',
    ];
    for (const body of bad) assert.equal((await raw('/in', { method: 'POST', token: w, body })).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await raw('/in', { method: 'POST', token: w, body: '{"type":' })).status, 400);
    assert.equal((await raw('/in', { method: 'POST', token: w, body: { ...entry(), note: 'x'.repeat(70000) } })).status, 413, 'over 64 KB');
    assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  });
  test('an automation run from the Shortcuts editor (no message) still arrives, as a test', async () => {
    const { relay, key } = await paired();
    for (const type of ['sms', 'email', 'wallet']) assert.equal((await C.send(relay, { type, id: `${type}-123456` })).ok, true);
    assert.deepEqual((await C.collect(relay, key)).items.map((x) => x.item.type), ['sms', 'email', 'wallet']);
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
    assert.equal(c.at, undefined, 'so is a time more than a day ahead (a wrong clock), instead of becoming tomorrow');
  });
  test('a time outside the last year or more than a day ahead is left out; Unix seconds are not read as 1970', async () => {
    const { relay, key } = await paired();
    const now = Date.now();
    const at = [now - 5 * 60000, now + 3600000, now - 200 * 86400000, now + 2 * 86400000, now - 400 * 86400000, Math.round(now / 1000), new Date(now - 60000).toISOString()];
    for (const [i, t] of at.entries()) await C.send(relay, { type: 'test', id: `at-test-${i}`, at: t });
    const got = (await C.collect(relay, key)).items.map((x) => (x.item.at ? Date.parse(x.item.at) : null));
    assert.deepEqual(got, [now - 5 * 60000, now + 3600000, now - 200 * 86400000, null, null, null, now - 60000]);
  });
  test('a time without an offset is kept as the phone sent it, so Pitaka reads it in the phone\'s time zone, not UTC', async () => {
    const { relay, key } = await paired();
    const hourAgo = Date.now() - 3600000;
    const manila = new Date(hourAgo + 8 * 3600000).toISOString().slice(0, 19); // an hour ago, on a Manila clock
    for (const [i, at] of [`${manila}+08:00`, manila, manila.replace('T', ' '), `${manila.slice(0, 10)}`, `${manila} PM`].entries()) await C.send(relay, { type: 'test', id: `local-at-${i}`, at });
    const items = (await C.collect(relay, key)).items.map((x) => x.item);
    assert.equal(items[1].at, manila, 'kept as sent');
    assert.equal(items[2].at, manila, 'a space instead of the T is made the ISO form Safari reads');
    assert.deepEqual([items[3].at, items[4].at], [undefined, undefined], 'a date alone, or something unreadable, is left out');
    // What Pitaka does with them on an iPhone set to Manila time.
    const { cleanRaw } = await import(`${APP}/js/inbox.js`);
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Manila';
    try {
      const [withOffset, without, spaced] = items.slice(0, 3).map((it) => cleanRaw(it).at);
      assert.equal(without, withOffset, '"…T09:30:00" and "…T09:30:00+08:00" are the same instant');
      assert.equal(spaced, withOffset);
      assert.equal(withOffset, hourAgo - (hourAgo % 1000));
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
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
    assert.deepEqual(cfg.categories, ['🍜 Food', 'x'.repeat(60)]);
    assert.deepEqual(cfg.wallets, ['Cash', 'GCash']);
    assert.equal(cfg.defaultWallet, 'GCash');
    assert.equal(cfg.extra, undefined);
    assert.equal((await raw('/config', { method: 'PUT', token: relay.read, body: [1, 2] })).status, 400);
  });
  test('names are cut to what an entry may send back (60), never through the middle of an emoji', async () => {
    const { relay } = await paired();
    const long = `🛒 ${'Groceries and household supplies, Saturday market (imported)'}`;
    await C.publishConfig(relay, { categories: [long, `${'x'.repeat(59)}🍜`], wallets: [`${'w'.repeat(59)}💳`], defaultWallet: `${'w'.repeat(59)}💳` });
    const cfg = await C.readConfig(relay);
    assert.equal(cfg.categories[0], long.slice(0, 60));
    assert.equal(cfg.categories[1], 'x'.repeat(59), 'the emoji that would not fit is dropped whole');
    assert.equal(cfg.wallets[0], 'w'.repeat(59));
    assert.equal(cfg.defaultWallet, 'w'.repeat(59));
    for (const name of cfg.categories) assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: entry({ category: name }) })).status, 200, 'a name from the config is always accepted back');
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

describe('relay: hostile or broken requests', () => {
  test('a body with no Content-Length, or a false one, is cut off at 64 KB instead of being read to the end', async () => {
    const { relay } = await paired();
    let made = 0;
    const endless = new ReadableStream({ pull(c) { if (made >= 8 * 1024 * 1024) return c.close(); made += 65536; c.enqueue(new Uint8Array(65536).fill(32)); } });
    const res = await worker.fetch(new Request(`${BASE}/in`, { method: 'POST', duplex: 'half', headers: { Authorization: `Bearer ${relay.write}`, 'CF-Connecting-IP': clientIp }, body: endless }), env);
    assert.equal(res.status, 413);
    assert.ok(made <= 4 * 65536, `stopped reading early (${made} bytes made)`);
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, headers: { 'Content-Length': '10' }, body: { ...entry(), note: 'x'.repeat(70000) } })).status, 413, 'a Content-Length that lies low');
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, headers: { 'Content-Length': String(10 ** 9) }, body: entry() })).status, 413, 'one that says too big is believed');
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })).status, 400, 'bytes that are not UTF-8');
  });
  test('long and multi-byte alerts arrive, cut to the field limits; an emoji is never split', async () => {
    const { relay, key } = await paired();
    const peso = `Paid ₱289.00 to JOLLIBEE. ${'₱'.repeat(7000)}`; // about 21 KB, under 8,000 characters
    const footer = `You paid PHP 289.00 to JOLLIBEE. ${'Disclaimer. '.repeat(700)}`;
    await C.send(relay, { type: 'email', id: 'em-1234567', from: 'alerts@bank.example', subject: 'Payment', body: peso });
    await C.send(relay, { type: 'email', id: 'em-2345678', from: 'alerts@bank.example', subject: 'Payment', body: footer });
    await C.send(relay, { type: 'sms', id: 'sms-1234567', sender: 'GCash', text: `${'x'.repeat(3999)}🍜 tail` });
    await C.send(relay, { type: 'text', id: 'qt-1234567', text: 'y'.repeat(301) });
    const [a, b, c, d] = (await C.collect(relay, key)).items.map((x) => x.item);
    assert.equal(a.body, peso);
    assert.equal(b.body, footer.slice(0, 8000));
    assert.equal(c.text, 'x'.repeat(3999), 'the emoji that would not fit is dropped whole');
    assert.equal(d.text, 'y'.repeat(300));
  });
  test('deeply nested or junk JSON is answered, not crashed on', async () => {
    const { relay } = await paired();
    const deep = `{"type":"test","id":"test-1234567","x":${'['.repeat(20000)}${']'.repeat(20000)}}`;
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: deep })).status, 200, 'unknown fields are dropped');
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: '['.repeat(30000) })).status, 400);
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: { type: '__proto__', id: 'test-1234567' } })).status, 400);
    assert.equal((await raw('/in', { method: 'POST', token: relay.write, body: '{"__proto__":{"type":"test"},"type":"test","id":"test-7654321"}' })).status, 200);
    assert.equal({}.type, undefined, 'nothing leaked into Object.prototype');
  });
  test('the right token with the wrong method gets 405 and the method to use, and is not counted as a wrong token', async () => {
    const { relay } = await paired();
    for (let i = 0; i < 25; i++) {
      const res = await raw('/in', { token: relay.write });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('Allow'), 'POST');
    }
    assert.match((await json(await raw('/in', { token: relay.write }))).body.error, /Use POST/);
    assert.equal((await C.send(relay, entry())).ok, true, 'not locked out');
    assert.equal((await raw('/', { method: 'POST' })).status, 405);
    assert.equal((await raw('/config', { method: 'DELETE', token: relay.read })).headers.get('Allow'), 'GET, PUT');
  });
  test('unknown paths are answered without the database or a token check', async () => {
    await paired();
    const qs = spy();
    for (const p of ['/wp-login.php', '/favicon.ico', '/in/x', '//in', '/%69n']) assert.equal((await raw(p, { token: 'x' })).status, 404, p);
    assert.equal(qs.length, 0);
  });
  test('errors carry CORS headers too, so Pitaka can read them', async () => {
    const { relay } = await paired();
    env.DB.prepare = () => { throw new Error('D1 down'); };
    const keep = console.error;
    console.error = () => {};
    try {
      const res = await raw('/status', { token: relay.read, headers: { Origin: ORIGIN } });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    } finally { console.error = keep; }
  });
  test('ALLOWED_ORIGIN is read the way browsers send an origin; a refused page can read why', async () => {
    env.ALLOWED_ORIGIN = ' https://NykkoFerrerava.github.io/pitaka/ ,example.org';
    for (const o of [ORIGIN, 'https://example.org']) assert.equal((await raw('/', { headers: { Origin: o } })).status, 200, o);
    const no = await raw('/', { headers: { Origin: 'https://evil.example' } });
    assert.equal(no.status, 403);
    assert.equal(no.headers.get('Access-Control-Allow-Origin'), 'https://evil.example', 'readable');
    assert.match((await no.json()).error, /ALLOWED_ORIGIN/);
    const pre = await raw('/pull', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null, 'its preflight still fails, so it can never send a token');
    env.ALLOWED_ORIGIN = 'null, not a url';
    assert.equal((await raw('/', { headers: { Origin: 'null' } })).status, 403, 'a sandboxed page (Origin: null) is never allowed');
  });
  test('an ADMIN_SECRET pasted with a space or a line break still pairs', async () => {
    env.ADMIN_SECRET = `  ${SECRET}\n`;
    assert.equal((await C.pair(BASE, SECRET)).pending, 0);
  });
  test('a public key that is not a point on P-256 is refused at pairing', async () => {
    const h = await C.sha256hex('a');
    const h2 = await C.sha256hex('b');
    const res = await raw('/pair', { method: 'POST', token: SECRET, body: { publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }, readHash: h, writeHash: h2 } });
    assert.equal(res.status, 400);
    assert.deepEqual(await C.probe(BASE), { paired: false });
  });
  test('rate limits count an IPv6 client by its /64 network', async () => {
    const { relay } = await paired();
    env.LIMIT_IN_PER_MIN = '3';
    const from = async (ip) => { clientIp = ip; return (await raw('/in', { method: 'POST', token: relay.write, body: entry() })).status; };
    assert.deepEqual([await from('2001:db8:a:b::1'), await from('2001:db8:a:b::2'), await from('2001:db8:a:b:1:2:3:4'), await from('2001:0db8:000a:000b:0000:0000:0000:0009')], [200, 200, 200, 429]);
    assert.equal(await from('2001:db8:a:c::1'), 200, 'another network is not affected');
    assert.equal(await from('::ffff:192.0.2.7'), 200);
    assert.equal(await from('192.0.2.7'), 200);
    assert.equal(await from('192.0.2.7'), 200);
    assert.equal(await from('::ffff:192.0.2.7'), 429, 'an IPv4-mapped address is that IPv4 client');
  });
});

describe('relay: guessing the setup secret, and pairing again', () => {
  const guess = async (i, ip = `198.51.100.${i}`) => { clientIp = ip; return (await raw('/pair', { method: 'POST', token: `wrong-secret-${i}-xxxxxxxx`, body: {} })).status; };
  test('ten wrong setup secrets an hour, from anywhere together, pause pairing for everyone', async () => {
    const statuses = [];
    for (let i = 1; i <= 12; i++) statuses.push(await guess(i, `2001:db8:${i}::1`));
    assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
    clientIp = '203.0.113.9';
    await assert.rejects(C.pair(BASE, SECRET), (e) => e.code === 'paused' && /paused for an hour/.test(e.message));
    offset += 3600000 + 1000;
    assert.equal((await C.pair(BASE, SECRET)).pending, 0, 'an hour later it works');
    assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM meta WHERE k = 'pairtries'").get().n, 0, 'and the count starts again');
  });
  test('guesses sent all at once share no count: still only ten are checked', async () => {
    const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => worker.fetch(new Request(`${BASE}/pair`, { method: 'POST', headers: { Authorization: `Bearer guess-${i}-xxxxxxxxxxxx`, 'CF-Connecting-IP': `198.51.${i}.1` }, body: '{}' }), env).then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 30);
  });
  test('a paused relay answers from one read and writes nothing', async () => {
    for (let i = 1; i <= 10; i++) await guess(i);
    const qs = spy();
    assert.equal(await guess(11), 429);
    assert.ok(qs.every((q) => /^SELECT/.test(q)), qs.join(' | '));
  });
  test('whoever is guessing cannot stop you: pairing with your current write token still works', async () => {
    const a = await paired();
    for (let i = 1; i <= 10; i++) await guess(i);
    clientIp = '203.0.113.10';
    await assert.rejects(C.pair(BASE, SECRET), { code: 'paused' });
    const b = await C.pair(BASE, SECRET, { keepWrite: a.relay.write });
    assert.equal(b.relay.write, a.relay.write);
    assert.equal((await C.send(b.relay, entry())).ok, true);
    await assert.rejects(C.pair(BASE, `${SECRET}-wrong`, { keepWrite: a.relay.write }), { code: 'auth' }, 'it still needs the right secret');
  });
  test('a right secret clears the count of wrong ones', async () => {
    for (let i = 1; i <= 9; i++) await guess(i);
    clientIp = '203.0.113.11';
    await paired();
    for (let i = 20; i <= 28; i++) assert.equal(await guess(i), 401);
  });
  test('after pairing again, the old tokens are told when, instead of "wrong token"', async () => {
    const a = await paired();
    const b = await paired();
    const manila = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 13).replace('T', ' ');
    await assert.rejects(C.collect(a.relay, a.key), (e) => e.code === 'auth' && e.reason === 'paired-again' && e.message.includes(`paired again on ${manila}:`) && /\d\d:\d\d Manila time\./.test(e.message) && /change ADMIN_SECRET/.test(e.message));
    await assert.rejects(C.send(a.relay, entry()), (e) => e.code === 'auth' && e.reason === 'paired-again' && /new write token/.test(e.message));
    for (let i = 0; i < 25; i++) assert.equal((await raw('/pull', { token: a.relay.read })).status, 401, 'an old token never works');
    assert.equal((await raw('/pull', { token: b.relay.read })).status, 200, 'and is not counted as a guess');
    const next = await C.rotateWrite(b.relay);
    await assert.rejects(C.send(b.relay, entry()), (e) => e.reason === 'token-replaced' && /replaced on/.test(e.message));
    assert.equal((await C.send(next, entry())).ok, true);
    const c = await C.pair(BASE, SECRET, { keepWrite: next.write });
    assert.equal((await C.send(next, entry())).ok, true, 'a kept write token is not retired');
    await assert.rejects(C.status(b.relay), (e) => e.reason === 'paired-again');
    assert.equal((await C.status(c.relay)).ok, true);
    const stored = JSON.parse(env.DB.sql.prepare("SELECT v FROM meta WHERE k = 'pair'").get().v);
    assert.ok(stored.retired.length <= 6 && stored.retired.every((x) => /^[0-9a-f]{64}$/.test(x.h)), 'only hashes, and only a few');
    assert.ok(!JSON.stringify(stored).includes(a.relay.read));
  });
});

describe('relay: costs and clean-up', () => {
  test('a send reads two row ids instead of counting every waiting item', async () => {
    const { relay } = await paired();
    const ins = env.DB.sql.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)');
    for (let i = 0; i < 4000; i++) ins.run(`i:${(1e12 + i).toString(36)}:aaaaaaaaaaaa`, '{}', Date.now() + 86400000);
    const qs = spy();
    await C.send(relay, entry());
    assert.ok(!qs.some((q) => /COUNT/.test(q)), qs.join(' | '));
  });
  test('gaps in the row ids are counted properly: a few items far apart are not a full inbox', async () => {
    const { relay } = await paired();
    env.DB.sql.prepare('INSERT INTO items (rowid, k, box, exp) VALUES (?, ?, ?, ?)').run(1, 'i:aaaaaaaa:aaaaaaaaaaaa', '{}', Date.now() + 86400000);
    env.DB.sql.prepare('INSERT INTO items (rowid, k, box, exp) VALUES (?, ?, ?, ?)').run(9000, 'i:aaaaaaab:aaaaaaaaaaaa', '{}', Date.now() + 86400000);
    assert.equal((await C.send(relay, entry())).ok, true);
  });
  test('a full inbox takes items again as soon as Pitaka acknowledges some', async () => {
    const { relay } = await paired();
    const ins = env.DB.sql.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)');
    const keys = [];
    for (let i = 0; i < 5000; i++) { const k = `i:${(1e12 + i).toString(36)}:aaaaaaaaaaaa`; keys.push(k); ins.run(k, '{}', Date.now() + 86400000); }
    await assert.rejects(C.send(relay, entry()), { code: 'full' });
    await assert.rejects(C.send(relay, entry()), { code: 'full' }, 'remembered');
    assert.equal(await C.ack(relay, keys.slice(0, 10)), 10);
    assert.equal((await C.send(relay, entry())).ok, true);
  });
  test('acknowledging 500 keys stays under D1\'s 100 parameters a statement', async () => {
    const { relay } = await paired();
    const ins = env.DB.sql.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)');
    const keys = [];
    for (let i = 0; i < 500; i++) { const k = `i:${(1e12 + i).toString(36)}:bbbbbbbbbbbb`; keys.push(k); ins.run(k, '{}', Date.now() + 86400000); }
    assert.deepEqual(await json(await raw('/ack', { method: 'POST', token: relay.read, body: { keys: [...keys, ...keys] } })), { status: 200, body: { ok: true, deleted: 500 } });
  });
  test('expired items are deleted when something arrives, and by the daily Cron Trigger', async () => {
    const { relay } = await paired();
    const old = env.DB.sql.prepare('INSERT INTO items (k, box, exp) VALUES (?, ?, ?)');
    old.run('i:aaaaaaaa:cccccccccccc', '{}', Date.now() - 1000);
    await C.send(relay, entry());
    assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1, 'only the new one');
    old.run('i:aaaaaaab:cccccccccccc', '{}', Date.now() - 1000);
    await worker.scheduled({ cron: '17 19 * * *' }, env, {});
    assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items WHERE exp <= ?').get(Date.now()).n, 0);
    await worker.scheduled({}, {}, {}); // no DB binding: nothing to do, nothing thrown
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
