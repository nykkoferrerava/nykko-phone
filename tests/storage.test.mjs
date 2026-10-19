// Storage adapter, atomic saves and the v2 -> v3 migration (js/storage.js + the saving half of js/store.js).
//   node --test tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, ST, S, U, store, fresh, setToday, clone, quiet } from './env.mjs';

const V2_RAW = readFileSync(new URL('./fixtures/v2-data.json', import.meta.url), 'utf8');
const spend = (amount, o = {}) => S.saveTxn({ kind: 'expense', categoryId: S.db.categories[0].id, amount, date: '2026-10-13', note: '', ...o });
const card = (o = {}) => S.saveDebt({ type: 'card', name: 'BPI card', balance: 10000, paymentAmount: 500, plannedPayment: 2000, creditLimit: 50000, rate: 3, nextDue: '2026-10-20', ...o });
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// Memory as the store sees it vs what is on disk.
const memory = () => { const { txns, inbox, ...core } = S.db; return { core, txns, inbox }; };
const disk = () => { const d = store.dump(); return { core: d.core, txns: d.txns, inbox: d.inbox }; };
async function v2Phone(raw) {
  fresh(); await S.flush(); await store.clear(); localStorage.clear();
  if (raw !== undefined) localStorage.setItem('pitaka.data', raw);
}
// An adapter whose writes wait until the test lets them through (or fails them).
function gated(inner) {
  const queue = [];
  const g = {
    ...inner,
    writes: [],
    write(ops) {
      g.writes.push(ops);
      return new Promise((resolve, reject) => queue.push({ ops, pass: () => inner.write(ops).then(resolve, reject), fail: (name = 'QuotaExceededError') => reject(Object.assign(new Error('no'), { name })) }));
    },
    async next() { while (!queue.length) await new Promise((r) => setImmediate(r)); return queue.shift(); },
  };
  return g;
}

describe('storage: memory adapter behaves like IndexedDB', () => {
  test('values are copied in and out, writes are all-or-nothing', async () => {
    const a = ST.memoryAdapter();
    assert.equal(await a.read(), null);
    const v = { id: 'a', amount: 5 };
    await a.write({ meta: { schema: 3 }, core: { x: 1 }, txns: { put: [{ id: 'a', o: 1, v }] } });
    v.amount = 99;
    const snap = await a.read();
    assert.equal(snap.txns[0].v.amount, 5);
    snap.txns[0].v.amount = 7;
    assert.equal((await a.read()).txns[0].v.amount, 5);
    const restore = a.failWith('QuotaExceededError');
    await assert.rejects(a.write({ core: { x: 2 }, txns: { del: ['a'] } }), (e) => e.name === 'QuotaExceededError');
    restore();
    assert.deepEqual(a.dump().core, { x: 1 });
    assert.equal(a.dump().txns.length, 1);
  });
});

describe('storage: every change is all-or-nothing', () => {
  test('a change shows in memory at once and is on disk after flush()', async () => {
    fresh(); await S.flush();
    const t = spend(150);
    assert.equal(S.db.txns.length, 1);
    await S.flush();
    assert.deepEqual(store.dump().txns, [t]);
  });
  test('a throw halfway through an edit puts back the entry and the debts exactly', async () => {
    fresh(); const a = card({ name: 'A' }); const b = card({ name: 'B' }); const t = spend(1000, { cardId: a.id });
    await S.flush();
    const before = JSON.stringify(S.db);
    Object.defineProperty(b, 'balance', { get: () => 10000, set: () => { throw new Error('boom'); }, enumerable: true, configurable: true });
    assert.throws(() => S.saveTxn({ id: t.id, kind: 'expense', amount: 1000, date: '2026-10-13', cardId: b.id }), /boom/);
    assert.equal(JSON.stringify(S.db), before);
    assert.equal(S.debt(a.id).balance, 11000);
    await S.flush();
    assert.equal(stable(memory()), stable(disk()));
  });
  test('quick changes share one write; only changed entries are written', async () => {
    fresh();
    await S.replaceAll({ txns: Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, kind: 'income', amount: 1, date: '2026-10-01' })) });
    const g = gated(store); S.useAdapter(g);
    spend(1); spend(2); spend(3);
    const w = await g.next();
    assert.equal(g.writes.length, 1);
    assert.equal(w.ops.replace, undefined);
    assert.equal(w.ops.txns.put.length, 3);
    w.pass();
    await S.flush();
    const t = S.db.txns.at(-1);
    S.saveTxn({ id: t.id, kind: 'expense', amount: 4, date: '2026-10-13' });
    const w2 = await g.next();
    assert.deepEqual(w2.ops.txns.put.map((r) => r.id), [t.id]);
    assert.equal(w2.ops.txns.put[0].v.amount, 4);
    w2.pass();
    S.deleteTxn(t.id);
    const w3 = await g.next();
    assert.deepEqual(w3.ops.txns, { put: [], del: [t.id] });
    w3.pass();
    await S.flush();
    assert.equal(store.dump().txns.length, 2002);
    S.useAdapter(store);
  });
  test('a failed write rolls back what it carried AND what was changed while it was writing', async () => {
    fresh(); const c = card(); await S.flush();
    const before = JSON.stringify(S.db);
    const g = gated(store); S.useAdapter(g);
    spend(100, { cardId: c.id });
    const w = await g.next();
    spend(200, { cardId: c.id }); // made during the write
    const pending = S.flush();
    w.fail();
    await assert.rejects(pending, (e) => e instanceof S.StoreError && e.code === 'quota');
    assert.equal(JSON.stringify(S.db), before);
    assert.equal(S.debt(c.id).balance, 10000);
    assert.equal(g.writes.length, 1, 'nothing more is written after a failure');
    S.useAdapter(store);
    assert.equal(stable(memory()), stable(disk()));
  });
  test('a write that worked stays when the next one fails', async () => {
    fresh(); const c = card(); await S.flush();
    const g = gated(store); S.useAdapter(g);
    const t1 = spend(100, { cardId: c.id });
    const w1 = await g.next();
    const t2 = S.saveTxn({ id: t1.id, kind: 'expense', amount: 300, date: '2026-10-13', cardId: c.id }); // edits the record being written
    spend(50);
    w1.pass();
    const w2 = await g.next();
    const pending = S.flush();
    w2.fail('SecurityError');
    await assert.rejects(pending, (e) => e.code === 'blocked');
    assert.equal(S.db.txns.length, 1);
    assert.equal(S.db.txns[0].amount, 100, 'back to the version the first write saved');
    assert.equal(S.debt(c.id).balance, 10100);
    assert.equal(t2.id, t1.id);
    S.useAdapter(store);
    assert.equal(stable(memory()), stable(disk()));
  });
  test('the UI hears about a failed write even if nobody waited for it', async () => {
    fresh(); await S.flush();
    let heard = null;
    S.setStoreFailHandler((e) => { heard = e; });
    const restore = store.failWith('QuotaExceededError', 1);
    spend(5);
    await new Promise((r) => setImmediate(r));
    await S.flush().catch(() => {});
    restore();
    S.setStoreFailHandler(null);
    assert.ok(heard instanceof S.StoreError);
    assert.equal(S.db.txns.length, 0);
  });
  test('resetAll that fails to reach the disk puts the old data back', async () => {
    fresh(); spend(5); spend(6); await S.flush();
    const before = JSON.stringify(S.db);
    const restore = store.failWith('QuotaExceededError');
    S.resetAll();
    assert.equal(S.db.txns.length, 0);
    await assert.rejects(S.flush());
    restore();
    assert.equal(JSON.stringify(S.db), before);
  });
  test('erase while an earlier save is still writing: if the erase fails, memory equals the disk', async () => {
    fresh(); const c = card(); await S.flush();
    const g = gated(store); S.useAdapter(g);
    const t = spend(150, { cardId: c.id });
    const w1 = await g.next(); // the entry is on its way to the disk
    S.resetAll();
    const pending = S.flush();
    w1.pass();
    const w2 = await g.next();
    assert.equal(w2.ops.replace, true, 'the erase');
    w2.fail('SecurityError');
    await assert.rejects(pending, (e) => e instanceof S.StoreError);
    S.useAdapter(store);
    assert.ok(S.txn(t.id), 'the saved entry is back in memory, as it is on disk');
    assert.equal(S.debt(c.id).balance, 10150);
    assert.equal(stable(memory()), stable(disk()));
    // The same when the entry was edited again after its save started.
    S.useAdapter(g);
    S.saveTxn({ id: t.id, kind: 'expense', amount: 200, date: '2026-10-13', cardId: c.id });
    const w3 = await g.next();
    S.saveTxn({ id: t.id, kind: 'expense', amount: 300, date: '2026-10-13', cardId: c.id }); // not written yet
    S.resetAll();
    const again = S.flush();
    w3.pass();
    (await g.next()).fail('SecurityError');
    await assert.rejects(again);
    S.useAdapter(store);
    assert.equal(S.txn(t.id).amount, 200, 'what the disk holds');
    assert.equal(S.debt(c.id).balance, 10200);
    assert.equal(stable(memory()), stable(disk()));
    // Two erases in a row: the first reaches the disk, the second fails.
    S.useAdapter(g);
    S.resetAll();
    const first = await g.next();
    S.resetAll();
    const both = S.flush();
    first.pass();
    (await g.next()).fail('SecurityError');
    await assert.rejects(both);
    S.useAdapter(store);
    assert.equal(S.db.txns.length, 0, 'the first erase is on disk, so nothing comes back');
    assert.equal(stable(memory()), stable(disk()));
  });
  test('a change made while a restore is being written never lands on top of the restored data', async () => {
    fresh(); const gc = S.saveAccount({ name: 'GCash', kind: 'ewallet' }); spend(5, { accountId: gc.id }); await S.flush();
    const backup = { ...JSON.parse(S.exportBackup()), accounts: [{ id: 'bk-cash', name: 'Cash', kind: 'cash', opening: 0 }], txns: [{ id: 'bk1', kind: 'income', amount: 700, date: '2026-10-01', accountId: 'bk-cash' }] };
    const queue = [];
    const tick = () => new Promise((r) => setImmediate(r));
    S.useAdapter({ ...store, write: (ops) => new Promise((resolve, reject) => queue.push({ ops, pass: () => store.write(ops).then(resolve, reject) })) });
    const restoring = S.replaceAll(backup);
    while (!queue.length) await tick();
    const w = queue.shift();
    assert.equal(w.ops.replace, true, 'the restore is on its way');
    spend(42, { accountId: gc.id }); // an inbox pull that finishes meanwhile, on the data being replaced
    let outcome = 'waiting';
    S.flush().then(() => { outcome = 'saved'; }, () => { outcome = 'not saved'; });
    await tick();
    await w.pass();
    await restoring;
    for (let i = 0; i < 20; i++) { await tick(); while (queue.length) await queue.shift().pass(); }
    S.useAdapter(store);
    assert.equal(outcome, 'not saved', 'so the relay keeps its items, and they come again onto the restored data');
    assert.deepEqual(S.db.txns.map((t) => t.id), ['bk1']);
    assert.deepEqual(S.db.accounts.map((a) => a.id), ['bk-cash']);
    const d = store.dump();
    assert.deepEqual([d.core.accounts, d.core.settings, d.txns], clone([S.db.accounts, S.db.settings, S.db.txns]), "the old wallets and settings weren't written over the backup");
  });
  test('property: random changes and random failures, memory always equals the disk afterwards', async () => {
    let seed = 1234; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    fresh(); const c = card(); const l = S.saveDebt({ type: 'loan', name: 'L', paymentAmount: 100, frequency: 'monthly', totalPayments: 50, balance: 5000, nextDue: '2026-10-31' });
    const g = S.saveGoal({ name: 'G', target: 100000 });
    await S.flush();
    const undo = [];
    for (let round = 0; round < 150; round++) {
      const failNow = rnd() < 0.2;
      const restore = failNow ? store.failWith(rnd() < 0.5 ? 'QuotaExceededError' : 'SecurityError', 1) : () => {};
      for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
        const r = rnd();
        try {
          if (r < 0.25 || !S.db.txns.length) spend(Math.round(rnd() * 50000) / 100 + 1, rnd() < 0.3 && S.debt(c.id) ? { cardId: c.id } : {});
          else if (r < 0.4) { const t = pick(S.db.txns); S.saveTxn({ ...clone(t), amount: t.amount + 1, fx: undefined }); }
          else if (r < 0.55) { const copy = S.deleteTxn(pick(S.db.txns).id); if (copy) undo.push(copy); }
          else if (r < 0.65 && undo.length) S.restoreTxn(undo.pop());
          else if (r < 0.75 && S.debt(l.id)?.balance > 100) S.saveTxn({ kind: 'debt', debtId: l.id, amount: 100, installments: 1, date: '2026-10-13' });
          else if (r < 0.85 && S.goal(g.id)) S.saveTxn({ kind: 'goal', goalId: g.id, amount: 10, date: '2026-10-13' });
          else if (r < 0.9) S.updateSettings({ payAmount: Math.round(rnd() * 1000) });
          else if (r < 0.93 && S.debt(c.id)) S.deleteDebt(c.id);
          else S.saveCategory({ name: `C${round}`, emoji: '🏷️' });
        } catch (e) {
          if (!(e instanceof S.ValidationError)) throw e;
        }
      }
      await S.flush().catch((e) => assert.ok(e instanceof S.StoreError));
      restore();
      assert.equal(stable(memory()), stable(disk()), `round ${round}`);
    }
    // and loading it back gives the same thing
    const mem = stable(memory());
    await S.load();
    assert.equal(stable(memory()), mem);
  });
  test('18,000 entries: one new entry writes one record and is quick', async () => {
    fresh();
    const many = Array.from({ length: 18000 }, (_, i) => ({ id: `t${i}`, kind: 'expense', amount: 100 + (i % 50), date: U.addDays('2021-10-13', Math.floor(i / 10)), note: `Lunch ${i}`, categoryId: S.db.categories[0].id, accountId: S.db.accounts[0].id, createdAt: 1 }));
    await S.replaceAll({ ...clone(S.db), txns: many });
    const t0 = performance.now();
    await S.load();
    const loadMs = performance.now() - t0;
    const g = gated(store); S.useAdapter(g);
    const t1 = performance.now();
    spend(99);
    const w = await g.next();
    const saveMs = performance.now() - t1;
    assert.equal(w.ops.txns.put.length, 1);
    w.pass();
    await S.flush();
    S.useAdapter(store);
    assert.equal(store.dump().txns.length, 18001);
    assert.ok(saveMs < 250, `save took ${saveMs.toFixed(0)} ms`);
    assert.ok(loadMs < 3000, `load took ${loadMs.toFixed(0)} ms`);
  });
  test('records with unsafe ids found on disk are repaired and written back once', async () => {
    fresh(); await S.flush();
    await store.write({ txns: { put: [{ id: 'bad id', o: 1, v: { id: 'bad id', kind: 'income', amount: 5, date: '2026-10-01' } }] } });
    await S.load();
    await S.flush();
    const ids = store.dump().txns.map((t) => t.id);
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^[\w-]+$/);
    assert.equal(ids[0], S.db.txns[0].id);
  });
});

describe('storage: v2 -> v3 migration', () => {
  test('first launch copies v2 data, checks the copy, keeps v2\'s key, and v2 entries behave the same', async () => {
    await v2Phone(V2_RAW);
    const r = await S.load();
    assert.deepEqual(r, { ok: true, migrated: true });
    assert.equal(S.storageInfo().kind, 'memory');
    assert.equal(S.storageInfo().migration, 'copied');
    assert.equal(localStorage.getItem('pitaka.data'), V2_RAW, "v2's key is never written by v3");
    assert.ok(localStorage.getItem('pitaka.migrated'));
    const d = store.dump();
    assert.equal(d.meta.migration.state, 'copied');
    assert.equal(d.txns.length, 11);
    // Numbers computed by the real v2 code (git b8ac339) for the same data on the same day.
    assert.equal(S.totalCash(), 37687);
    assert.deepEqual(S.db.accounts.map((a) => [a.name, S.accountBalance(a.id)]), [['Cash', -1175], ['GCash', 5362], ['BPI Savings', 33500]]);
    assert.equal(S.totalDebt(), 44493.65);
    const f = S.freeToSpend();
    assert.deepEqual([f.free, f.due, f.setAside], [34456, 500, 2731]);
    assert.deepEqual(S.db.debts.map((x) => [x.name, S.paymentsLeft(x), x.nextDue, x.balance]),
      [['BPI Gold', 11, '2026-10-25', 25993.65], ['Home Credit phone', 6, '2026-11-30', 12000], ['JuanHand', 5, '2026-10-20', 2500], ['Tita Mel', 4, null, 4000]]);
    const { byCategory, ...m } = S.monthSummary('2026-10');
    assert.deepEqual(m, { income: 25000, spent: 2853.5, spentOnCards: 1840.5, debtPaid: 3000, saved: 1500, fees: 702.4, net: 19487, count: 11 });
    assert.equal(S.db.settings.pinHash, 'deadbeef', 'your own data keeps its PIN');
    assert.equal(S.db.settings.theme, 'dark');
    // Old entries still undo correctly after the move.
    const pay = S.db.txns.find((t) => t.kind === 'debt' && t.installments === 1);
    S.deleteTxn(pay.id);
    assert.equal(S.debt(pay.debtId).nextDue, '2026-10-31');
    assert.equal(S.debt(pay.debtId).paymentsMade, 5);
    await S.flush();
  });
  test('a later launch finds the copy intact, marks it verified and removes v2\'s key', async () => {
    await v2Phone(V2_RAW);
    await S.load();
    spend(42); await S.flush();
    const before = stable(memory());
    const S2 = await import(`${APP}/js/store.js?launch=2`);
    const r = await S2.load();
    assert.equal(r.verified, true);
    assert.equal(S2.storageInfo().migration, 'verified');
    assert.equal(localStorage.getItem('pitaka.data'), null);
    assert.equal(store.dump().meta.migration.state, 'verified');
    const { txns, inbox, ...core } = S2.db;
    assert.equal(stable({ core, txns, inbox }), before);
    const S3 = await import(`${APP}/js/store.js?launch=3`);
    assert.deepEqual(await S3.load(), { ok: true });
    await S.load(); // back to the main copy for the other tests
  });
  test('reversible: if the new store is lost before it was verified, v2\'s key brings the data back', async () => {
    await v2Phone(V2_RAW);
    await S.load();
    await store.clear(); // iOS dropped the new store
    const S4 = await import(`${APP}/js/store.js?launch=4`);
    const r = await S4.load();
    assert.deepEqual(r, { ok: true, migrated: true, reverted: true });
    assert.equal(S4.db.txns.length, 11);
    await S.load();
  });
  test('if the copy does not read back the same, Pitaka stays on v2\'s key in v2\'s format', async () => {
    await v2Phone(V2_RAW);
    const bad = { ...store, read: async () => { const s = await store.read(); if (s) s.txns.pop(); return s; } };
    S.useAdapter(bad);
    const r = await quiet(() => S.load());
    assert.equal(r.ok, true); assert.equal(r.fallback, true);
    assert.equal(S.storageInfo().kind, 'localstorage');
    assert.equal(store.dump().txns.length, 0, 'the bad copy was removed');
    assert.equal(S.db.txns.length, 11);
    spend(10); await S.flush();
    const saved = JSON.parse(localStorage.getItem('pitaka.data'));
    assert.equal(saved.txns.length, 12);
    for (const k of ['version', 'settings', 'categories', 'accounts', 'txns', 'debts', 'bills', 'goals', 'debtHistory']) assert.ok(k in saved, k);
    S.useAdapter(store);
  });
  test('IndexedDB that cannot be opened falls back to v2\'s key', async () => {
    await v2Phone(V2_RAW);
    const broken = { ...store, read: async () => { throw Object.assign(new Error('nope'), { name: 'UnknownError' }); } };
    S.useAdapter(broken);
    const r = await quiet(() => S.load());
    assert.equal(r.fallback, true);
    assert.equal(S.db.txns.length, 11);
    S.useAdapter(store);
  });
  test('IndexedDB that cannot be opened AFTER the move never opens the old v2 copy in its place', async () => {
    const broken = { ...store, read: async () => { throw Object.assign(new Error('nope'), { name: 'UnknownError' }); } };
    await v2Phone(V2_RAW);
    await S.load(); // the move: v2's key is kept until a later launch checks the copy
    spend(42); await S.flush(); // only in IndexedDB
    const S6 = await import(`${APP}/js/store.js?launch=6`);
    S6.useAdapter(broken);
    assert.deepEqual(await quiet(() => S6.load()), { ok: false, reason: 'blocked', moved: true }, 'not the stale v2 data, which a later launch would delete');
    S6.saveTxn({ kind: 'income', amount: 1, date: '2026-10-13' });
    await assert.rejects(S6.flush(), (e) => e instanceof S6.StoreError);
    assert.equal(localStorage.getItem('pitaka.data'), V2_RAW, "v2's key is untouched");
    const S7 = await import(`${APP}/js/store.js?launch=7`);
    assert.equal((await S7.load()).verified, true);
    assert.equal(S7.db.txns.length, 12, 'nothing was lost');
    // Once v2's key is gone, a failed open must not start an empty Pitaka either.
    const S8 = await import(`${APP}/js/store.js?launch=8`);
    S8.useAdapter(broken);
    assert.deepEqual(await quiet(() => S8.load()), { ok: false, reason: 'blocked', moved: true });
    await S.load();
  });
  test('on v2\'s key, entries given an id on load are written back, so editing one never drops another', async () => {
    const txns = [100, 200, 300].map((amount, i) => ({ kind: 'expense', amount, date: `2026-10-0${i + 2}`, accountId: 'cash1' })); // saved by v2 without ids
    await v2Phone(JSON.stringify({ version: 2, settings: {}, accounts: [{ id: 'cash1', name: 'Cash', kind: 'cash', opening: 1000, openingDate: '2026-10-01' }], txns }));
    S.useAdapter({ ...store, read: async () => { throw Object.assign(new Error('nope'), { name: 'UnknownError' }); } });
    assert.equal((await quiet(() => S.load())).fallback, true);
    S.saveTxn({ id: S.db.txns[0].id, kind: 'expense', amount: 150, date: '2026-10-02', accountId: 'cash1' });
    await S.flush();
    const saved = JSON.parse(localStorage.getItem('pitaka.data'));
    assert.deepEqual(saved.txns.map((t) => t.amount), [150, 200, 300]);
    assert.deepEqual(saved.txns.map((t) => t.id), S.db.txns.map((t) => t.id));
    assert.equal(S.accountBalance('cash1'), 350);
    S.useAdapter(store);
  });
  test('data that vanished after a finished migration is reported, not silently replaced', async () => {
    await v2Phone();
    localStorage.setItem('pitaka.migrated', '2026-10-01T00:00:00.000Z');
    assert.deepEqual(await S.load(), { ok: true, lost: true });
  });
  test('restoring a backup during the copy phase drops the out-of-date v2 copy', async () => {
    await v2Phone(V2_RAW);
    await S.load();
    await S.replaceAll(JSON.parse(S.exportBackup()));
    assert.equal(localStorage.getItem('pitaka.data'), null);
    assert.equal(S.storageInfo().migration, 'replaced');
  });
  test('erase removes v2\'s key too, so it can never come back after a reload', async () => {
    await v2Phone(V2_RAW);
    await S.load();
    S.resetAll(); await S.flush();
    assert.equal(localStorage.getItem('pitaka.data'), null);
    const S5 = await import(`${APP}/js/store.js?launch=5`);
    await S5.load();
    assert.equal(S5.db.txns.length, 0);
  });
});

describe('storage: backups never contain secrets', () => {
  test('relay secrets live outside the data; erase clears them', async () => {
    fresh(); await S.flush();
    await S.secrets.set('relay', { readToken: 'r'.repeat(43), writeToken: 'w'.repeat(43) });
    spend(5); await S.flush();
    const backup = S.exportBackup();
    assert.ok(!backup.includes('rrrrrrrr') && !backup.includes('wwwwwwww'));
    assert.ok(!JSON.stringify(store.dump()).includes('rrrrrrrr'));
    S.resetAll(); await S.flush();
    assert.equal(await S.secrets.get('relay'), undefined);
  });
  test('restoring a backup keeps the pairing on this phone', async () => {
    fresh(); await S.flush();
    await S.secrets.set('relay', { url: 'https://x.workers.dev' });
    await S.replaceAll(JSON.parse(S.exportBackup()));
    assert.deepEqual(await S.secrets.get('relay'), { url: 'https://x.workers.dev' });
    setToday('2026-10-13');
  });
});
