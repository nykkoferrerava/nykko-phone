// Collecting from the relay into Pitaka (js/sync.js) end to end: the real Worker on a mocked D1, the
// client, the inbox pipeline and the store. Saved before acknowledged; secrets never in backups.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP, S, store, fresh, cat } from './env.mjs';
import './env-relay.mjs';

const worker = (await import(`${APP}/relay/worker.js`)).default;
const R = await import(`${APP}/js/relay-client.js`);
const Y = await import(`${APP}/js/sync.js`);
const { DatabaseSync } = await import('node:sqlite');

function mockD1() {
  const sql = new DatabaseSync(':memory:');
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
  });
  return { sql, prepare: (q) => stmt(q), batch: async (l) => Promise.all(l.map((s) => s.run())) };
}
const BASE = 'https://pitaka-relay.example.workers.dev';
const SECRET = 'correct-horse-battery-staple';
let env;
let ip = 0;
const calls = [];
// The clock is frozen here, so each test is its own client for the Worker's per-minute limits.
R.useFetch((url, init = {}) => {
  calls.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
  return worker.fetch(new Request(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': `10.1.0.${ip}` } }), env);
});
let n = 0;
const quick = (o = {}) => ({ type: 'entry', id: `q-${++n}-abcdef`, amount: 150, category: '🍜 Food', wallet: 'GCash', ...o });
const pending = () => Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM items').get().n);

beforeEach(async () => {
  fresh();
  await S.flush();
  await Y.unpair();
  ip++;
  env = { DB: mockD1(), ADMIN_SECRET: SECRET, LIMIT_IN_PER_MIN: '100000', LIMIT_READ_PER_MIN: '100000' };
  S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 5000, openingDate: '2026-10-01' });
  await S.flush();
  calls.length = 0;
});

describe('sync: pairing', () => {
  test('pairs, keeps the tokens and key as secrets, and publishes the shortcut lists', async () => {
    const p = await Y.pairWith(BASE, SECRET);
    assert.equal(Y.paired(), true);
    assert.equal(S.db.settings.relayUrl, BASE);
    const cfg = await R.readConfig(p.relay);
    assert.ok(cfg.categories.includes('🍜 Food'));
    assert.ok(cfg.wallets.includes('GCash'));
    assert.equal((await S.secrets.get('relayKey')).extractable, false);
    // Survives a relaunch: the pairing is read back from the secrets store.
    assert.equal(await Y.loadPairing(), true);
    assert.equal(Y.info().write, p.relay.write);
  });
  test('backups carry the relay address but never the tokens or the key', async () => {
    const p = await Y.pairWith(BASE, SECRET);
    const backup = S.exportBackup();
    assert.ok(backup.includes(BASE));
    assert.ok(!backup.includes(p.relay.read) && !backup.includes(p.relay.write));
    assert.ok(!/relayKey|"d":/.test(backup));
  });
  test('erasing Pitaka removes the pairing', async () => {
    await Y.pairWith(BASE, SECRET);
    S.resetAll();
    await S.flush();
    assert.equal(await Y.loadPairing(), false);
    assert.equal(store.secretsMap.size, 0);
  });
  test('pairing again can keep the write token your shortcuts already have', async () => {
    const first = await Y.pairWith(BASE, SECRET);
    await Y.unpair(); // as after a restore on a new phone
    await Y.pairWith(BASE, SECRET, { keepWrite: first.relay.write });
    assert.equal((await R.send(first.relay, quick())).ok, true, 'the old shortcut still works');
    await assert.rejects(Y.pairWith(BASE, SECRET, { keepWrite: 'too-short' }), { code: 'invalid' });
  });
  test('pairing again first collects what is waiting for the current pairing', async () => {
    const first = await Y.pairWith(BASE, SECRET);
    await R.send(first.relay, quick({ note: 'waiting' }));
    await Y.pairWith(BASE, SECRET);
    assert.ok(S.db.txns.some((t) => t.note === 'waiting'));
    assert.equal(pending(), 0);
  });
});

describe('sync: collecting', () => {
  test('a Quick Add becomes an entry, then is deleted from the relay', async () => {
    const { relay } = await Y.pairWith(BASE, SECRET);
    await R.send(relay, quick({ note: 'Jollibee' }));
    const got = await Y.collect({ force: true });
    assert.equal(got.from, 'Quick Add');
    assert.equal(got.out.created.length, 1);
    const t = S.txn(got.out.created[0]);
    assert.deepEqual([t.amount, t.categoryId, t.note, t.src], [150, cat('Food').id, 'Jollibee', 'quick']);
    assert.equal(pending(), 0);
    assert.equal(await Y.collect({ force: true }), null, 'nothing new');
  });
  test('labels say where items came from', async () => {
    const { relay } = await Y.pairWith(BASE, SECRET);
    await R.send(relay, { type: 'sms', id: 'sms-1-abcdef', sender: 'GCash', text: 'You have paid PHP 289.00 to JOLLIBEE on 10-13-2026 12:41 PM. Ref. No. 9876543210123.' });
    assert.equal((await Y.collect({ force: true })).from, 'SMS');
    await R.send(relay, quick());
    await R.send(relay, { type: 'balance', id: 'bal-1-abcdef', wallet: 'GCash', amount: 4000 });
    assert.equal((await Y.collect({ force: true })).from, 'your iPhone');
  });
  test('the same item delivered twice (Files catch-up, or a retry) is added once', async () => {
    const { relay } = await Y.pairWith(BASE, SECRET);
    await R.send(relay, quick({ id: 'same-123456' }));
    await R.send(relay, quick({ id: 'same-123456' }));
    const got = await Y.collect({ force: true });
    assert.equal(got.out.created.length, 1);
    assert.equal(got.out.duplicates, 1);
    assert.equal(pending(), 0, 'both copies are cleared');
  });
  test('if saving fails nothing is acknowledged: the items come again and are added once', async () => {
    const { relay } = await Y.pairWith(BASE, SECRET);
    await R.send(relay, quick({ note: 'kept' }));
    const before = S.db.txns.length;
    store.failWith('QuotaExceededError', 1);
    await assert.rejects(Y.collect({ force: true }));
    assert.equal(S.db.txns.length, before, 'memory went back to what is on disk');
    assert.equal(pending(), 1, 'still on the relay');
    await Y.collect({ force: true });
    assert.equal(S.db.txns.filter((t) => t.note === 'kept').length, 1);
    assert.equal(pending(), 0);
  });
  test('items sealed for an earlier pairing are counted and cleared, not silently dropped', async () => {
    const old = await R.pair(BASE, SECRET);
    await R.send(old.relay, quick());
    await Y.pairWith(BASE, SECRET);
    // pairWith only collects first for its own earlier pairing; the item above was for someone else's key.
    const got = await Y.collect({ force: true });
    assert.equal(got.unreadable, 1);
    assert.equal(pending(), 0);
  });
  test('foreground bursts are collapsed into one collection', async () => {
    await Y.pairWith(BASE, SECRET);
    await Y.collect({ force: true });
    calls.length = 0;
    const [a, b] = await Promise.all([Y.collect(), Y.collect()]);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.deepEqual(calls, [], 'within a few seconds of the last one: skipped');
  });
  test('the shortcut lists are sent again only when they change', async () => {
    await Y.pairWith(BASE, SECRET);
    calls.length = 0;
    await Y.collect({ force: true });
    assert.ok(!calls.includes('PUT /config'));
    S.saveCategory({ name: 'Pets', emoji: '🐶' });
    await S.flush();
    await Y.collect({ force: true });
    assert.ok(calls.includes('PUT /config'));
    assert.ok((await R.readConfig({ url: BASE, write: Y.info().write })).categories.includes('🐶 Pets'));
  });
  test('the self-test goes through the write token and comes back as a test item', async () => {
    await Y.pairWith(BASE, SECRET);
    const since = Date.now();
    const got = await Y.selfTest();
    assert.equal(got.out.tests.length, 1);
    assert.equal(S.db.inbox.filter((x) => x.status === 'test' && x.receivedAt >= since).length, 1);
    assert.equal(S.db.txns.filter((t) => t.src === 'quick').length, 0, 'a test adds no entry');
  });
  test('a new write token stops the old one', async () => {
    const { relay } = await Y.pairWith(BASE, SECRET);
    const write = await Y.rotateWrite();
    assert.notEqual(write, relay.write);
    await assert.rejects(R.send(relay, quick()), { code: 'auth' });
    assert.equal((await Y.loadPairing()) && Y.info().write, write);
  });
  test('not paired: nothing to do', async () => {
    assert.equal(await Y.collect({ force: true }), null);
    assert.deepEqual(calls, []);
  });
});
