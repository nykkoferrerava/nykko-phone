// Money owed to you: lending, partial repayments into a wallet, undo, orphans, backups.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { S, store, fresh, clone } from './env.mjs';

const cash = () => S.defaultAccountId();
const gcash = () => S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 5000, openingDate: '2026-10-01' });
const throwsField = (fn, field) => assert.throws(fn, (e) => e instanceof S.ValidationError && (!field || e.field === field) && !/undefined|NaN/.test(e.message));

describe('receivables: lending and getting paid back', () => {
  test('lending from a wallet creates the person and moves the money out', () => {
    fresh(); const g = gcash();
    const t = S.lend({ name: 'Mel', amount: 500, accountId: g.id, note: 'pang-gas' });
    assert.equal(t.kind, 'lend');
    const r = S.findReceivable('mel');
    assert.equal(r.name, 'Mel');
    assert.equal(r.balance, 500);
    assert.equal(S.accountBalance(g.id), 4500);
    assert.equal(S.totalReceivable(), 500);
  });
  test('lending again to the same person (any casing) adds to what they owe', () => {
    fresh(); const g = gcash();
    S.lend({ name: 'Mel', amount: 500, accountId: g.id });
    S.lend({ name: '  MEL ', amount: 300, accountId: g.id });
    assert.equal(S.db.receivables.length, 1);
    assert.equal(S.db.receivables[0].balance, 800);
  });
  test('partial repayments land in a wallet and are capped at what is owed', () => {
    fresh(); const g = gcash();
    S.lend({ name: 'Mel', amount: 1000, accountId: g.id });
    const r = S.findReceivable('Mel');
    S.saveTxn({ kind: 'collect', receivableId: r.id, amount: 400, accountId: cash(), date: '2026-10-13' });
    assert.equal(r.balance, 600);
    assert.equal(S.accountBalance(cash()), 400);
    throwsField(() => S.saveTxn({ kind: 'collect', receivableId: r.id, amount: 601, accountId: cash(), date: '2026-10-13' }), 'amount');
    assert.deepEqual(S.receivableProgress(r), { paid: 400, total: 1000, pct: 40 });
    S.saveTxn({ kind: 'collect', receivableId: r.id, amount: 600, accountId: cash(), date: '2026-10-13' });
    assert.equal(r.balance, 0);
    assert.equal(S.totalReceivable(), 0);
  });
  test('an amount lent before Pitaka can be recorded without touching a wallet', () => {
    fresh();
    const r = S.saveReceivable({ name: 'Kuya Ben', balance: 2000, dueDate: '2026-12-15', notes: 'tuition' });
    assert.equal(r.original, 2000);
    assert.equal(S.totalCash(), 0);
    throwsField(() => S.saveReceivable({ name: ' ', balance: 5 }), 'name');
    throwsField(() => S.saveReceivable({ name: 'X', balance: -5 }), 'balance');
    throwsField(() => S.saveReceivable({ name: 'X', balance: 5, dueDate: '2026-02-30' }), 'dueDate');
  });
  test('editing and deleting lend / collect entries keeps balances exact', () => {
    fresh(); const g = gcash();
    const a = S.lend({ name: 'Mel', amount: 1000, accountId: g.id });
    const r = S.findReceivable('Mel');
    const c = S.saveTxn({ kind: 'collect', receivableId: r.id, amount: 300, accountId: g.id, date: '2026-10-13' });
    S.saveTxn({ id: a.id, kind: 'lend', receivableId: r.id, amount: 1200, accountId: g.id, date: '2026-10-13' });
    assert.equal(r.balance, 900);
    const copy = S.deleteTxn(c.id);
    assert.equal(r.balance, 1200);
    S.restoreTxn(copy);
    assert.equal(r.balance, 900);
    S.deleteTxn(a.id); S.deleteTxn(copy.id);
    assert.equal(r.balance, 0);
    assert.equal(S.accountBalance(g.id), 5000);
  });
  test('lending is not income or spending in reports', () => {
    fresh(); const g = gcash();
    S.lend({ name: 'Mel', amount: 500, accountId: g.id });
    S.saveTxn({ kind: 'collect', receivableId: S.findReceivable('Mel').id, amount: 200, accountId: g.id, date: '2026-10-13' });
    const m = S.monthSummary('2026-10');
    assert.equal(m.income, 0); assert.equal(m.spent, 0); assert.equal(m.net, 0);
    const p = S.periodSummary();
    assert.equal(p.lent, 500); assert.equal(p.collected, 200);
  });
  test('deleting a person keeps their entries as orphans that never move money elsewhere', () => {
    fresh(); const g = gcash();
    const a = S.lend({ name: 'Mel', amount: 500, accountId: g.id });
    S.lend({ name: 'Joy', amount: 100, accountId: g.id });
    const mel = S.findReceivable('Mel');
    S.deleteReceivable(mel.id);
    const t = S.db.txns.find((x) => x.id === a.id);
    assert.equal(t.orphan, true); assert.equal(t.personName, 'Mel');
    S.saveTxn({ id: a.id, kind: 'lend', receivableId: S.findReceivable('Joy').id, amount: 500, accountId: g.id, date: '2026-10-13', note: 'fixed' });
    assert.equal(S.findReceivable('Joy').balance, 100, 'Joy untouched');
    assert.equal(S.accountBalance(g.id), 4400, 'the money still left the wallet');
  });
  test('backups and loading keep receivables and their entries', async () => {
    fresh(); const g = gcash();
    S.lend({ name: 'Mel', amount: 500, accountId: g.id, dueDate: '2026-11-30' });
    const before = clone({ r: S.db.receivables, t: S.db.txns });
    await S.replaceAll(JSON.parse(S.exportBackup()));
    assert.deepEqual(clone({ r: S.db.receivables, t: S.db.txns }), before);
    await S.load();
    assert.deepEqual(clone({ r: S.db.receivables, t: S.db.txns }), before);
  });
  test('a failed save puts the person and the wallet back', async () => {
    fresh(); const g = gcash(); await S.flush();
    const restore = store.failWith('QuotaExceededError');
    S.lend({ name: 'Mel', amount: 500, accountId: g.id });
    await assert.rejects(S.flush(), (e) => e instanceof S.StoreError);
    restore();
    assert.equal(S.db.receivables.length, 0);
    assert.equal(S.accountBalance(g.id), 5000);
  });
});
