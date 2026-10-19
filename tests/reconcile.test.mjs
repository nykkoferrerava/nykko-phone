// Matching: duplicates, linking, reference merges, transfer pairing and statement rows (js/reconcile.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP, at } from './env.mjs';

const R = await import(`${APP}/js/reconcile.js`);
const T = (o) => ({ id: o.id || Math.random().toString(36).slice(2), kind: 'expense', amount: 289, date: '2026-10-18', note: '', createdAt: at('2026-10-18', 12, 30), accountId: 'gcash', ...o });
const E = (o) => ({ kind: 'expense', amount: 289, at: at('2026-10-18', 12, 41), date: '2026-10-18', accountId: 'gcash', merchant: 'JOLLIBEE FOODS CORP', via: 'sms', inst: 'GCash', ...o });

describe('reconcile: names', () => {
  test('similarity', () => {
    assert.equal(R.similarity('JOLLIBEE FOODS CORP', 'jollibee'), 1);
    assert.equal(R.similarity('SM SUPERMARKET MOA', 'SM Supermarket'), 1);
    assert.equal(R.similarity('NETFLIX.COM', 'Netflix'), 1);
    assert.ok(R.similarity('JOLLIBEE', 'Grab') < 0.2);
    assert.equal(R.similarity('', 'x'), 0);
  });
  test('entryTime uses the event time, or the save time on the same day', () => {
    assert.equal(R.entryTime({ at: 5, date: '2026-10-18' }), 5);
    assert.equal(R.entryTime({ createdAt: at('2026-10-18', 9), date: '2026-10-18' }), at('2026-10-18', 9));
    assert.equal(R.entryTime({ createdAt: at('2026-10-19', 9), date: '2026-10-18' }), null, 'saved the next day: time unknown');
  });
});

describe('reconcile: the ₱289 Jollibee case', () => {
  test('logged by hand, then the GCash SMS arrives: link, do not add', () => {
    const manual = T({ id: 'm', note: 'Jollibee' });
    const d = R.decide(E(), [manual]);
    assert.equal(d.action, 'confirm'); assert.equal(d.txn.id, 'm'); assert.ok(d.score >= R.AUTO);
  });
  test('logged with the keypad (no note, just a category): still linked', () => {
    const d = R.decide(E(), [T({ id: 'k', categoryId: 'food' })]);
    assert.equal(d.action, 'confirm');
  });
  test('a different merchant at the same time and amount is only a "possible duplicate"', () => {
    const d = R.decide(E(), [T({ note: 'Grab' })]);
    assert.equal(d.action, 'review'); assert.equal(d.reason, 'duplicate');
  });
  test('two possible entries: ask, never pick one', () => {
    const d = R.decide(E(), [T({ id: 'a' }), T({ id: 'b', createdAt: at('2026-10-18', 12, 35) })]);
    assert.equal(d.action, 'review');
  });
  test('outside the time window on another day, or another wallet or amount: a new entry', () => {
    assert.equal(R.decide(E(), [T({ date: '2026-10-16', createdAt: at('2026-10-16', 12) })]).action, 'create');
    assert.equal(R.decide(E(), [T({ accountId: 'gotyme' })]).action, 'create');
    assert.equal(R.decide(E(), [T({ amount: 290 })]).action, 'create');
  });
  test('the window is configurable', () => {
    const t = T({ note: 'Jollibee', createdAt: at('2026-10-18', 12, 0) });
    assert.equal(R.decide(E(), [t], { windowMin: 30 }).action, 'confirm');
    assert.equal(R.decide(E(), [t], { windowMin: 5 }).action, 'confirm', 'same day and same name still match');
    assert.equal(R.decide(E({ merchant: '' }), [T({ createdAt: at('2026-10-18', 8) })], { windowMin: 5 }).action, 'review');
  });
  test('an entry already confirmed by an SMS is a second purchase, not the same one', () => {
    const t = T({ note: 'Jollibee', conf: [{ via: 'sms', inst: 'GCash', ref: '111' }] });
    assert.equal(R.decide(E({ ref: '222' }), [t]).action, 'create');
  });
});

describe('reconcile: one event from SMS, email and statement', () => {
  test('the same reference number merges, even outside the window', () => {
    const t = T({ ref: '9876543210123', at: at('2026-10-18', 8), src: 'sms', conf: [{ via: 'sms', inst: 'GCash', ref: '9876543210123' }] });
    const d = R.decide(E({ via: 'email', ref: '9876543210123', at: at('2026-10-18', 18) }), [t]);
    assert.deepEqual([d.action, d.score], ['confirm', 1]);
  });
  test('an email without a reference still links to the SMS entry by amount, time and name', () => {
    const t = T({ merchant: 'JOLLIBEE FOODS CORP', at: at('2026-10-18', 12, 41), src: 'sms', conf: [{ via: 'sms', inst: 'GCash' }] });
    assert.equal(R.decide(E({ via: 'email', at: at('2026-10-18', 12, 43) }), [t]).action, 'confirm');
  });
  test('different reference numbers are different events', () => {
    const t = T({ ref: 'AAA111', note: 'Jollibee' });
    assert.equal(R.decide(E({ ref: 'BBB222' }), [t]).action, 'create');
  });
});

describe('reconcile: transfers between your own wallets', () => {
  test('GCash "sent ₱1,000 to GoTyme" then GoTyme "received ₱1,000": the transfer is confirmed', () => {
    const transfer = { id: 'tr', kind: 'transfer', amount: 1000, date: '2026-10-18', accountId: 'gcash', toAccountId: 'gotyme', at: at('2026-10-18', 13, 5), src: 'sms', conf: [{ via: 'sms', inst: 'GCash' }] };
    const d = R.decide({ kind: 'transfer-in', amount: 1000, at: at('2026-10-18', 13, 6), date: '2026-10-18', accountId: 'gotyme', merchant: 'JUAN DELA CRUZ', via: 'email', inst: 'GoTyme' }, [transfer]);
    assert.deepEqual([d.action, d.txn.id], ['confirm', 'tr']);
  });
  test('the other order: GoTyme income first, then GCash "sent to GoTyme" pairs them into one transfer', () => {
    const income = { id: 'in', kind: 'income', amount: 1000, date: '2026-10-18', accountId: 'gotyme', at: at('2026-10-18', 13, 6), src: 'email', conf: [{ via: 'email', inst: 'GoTyme' }] };
    const d = R.decide({ kind: 'transfer-out', amount: 1000, at: at('2026-10-18', 13, 5), date: '2026-10-18', accountId: 'gcash', otherAccountId: 'gotyme', merchant: 'GOTYME BANK', via: 'sms', inst: 'GCash' }, [income]);
    assert.deepEqual([d.action, d.as, d.txn.id], ['pair', 'pair-in', 'in']);
  });
  test('an entry you typed yourself is never turned into a transfer without asking', () => {
    const typed = { id: 'x', kind: 'expense', amount: 1000, date: '2026-10-18', accountId: 'gcash', createdAt: at('2026-10-18', 13), note: 'to gotyme' };
    const d = R.decide({ kind: 'transfer-out', amount: 1000, at: at('2026-10-18', 13, 5), date: '2026-10-18', accountId: 'gcash', otherAccountId: 'gotyme', merchant: 'GOTYME BANK', via: 'sms' }, [typed]);
    assert.deepEqual([d.action, d.reason], ['review', 'transfer']);
  });
  test('a transfer to a different wallet is not this one', () => {
    const transfer = { id: 'tr', kind: 'transfer', amount: 1000, date: '2026-10-18', accountId: 'gcash', toAccountId: 'bpi', at: at('2026-10-18', 13, 5) };
    assert.equal(R.decide({ kind: 'transfer-out', amount: 1000, at: at('2026-10-18', 13, 5), date: '2026-10-18', accountId: 'gcash', otherAccountId: 'gotyme', via: 'sms' }, [transfer]).action, 'create');
  });
});

describe('reconcile: statement rows', () => {
  test('rows already in Pitaka are marked, one entry per row, dates may be a day or two off', () => {
    const txns = [
      T({ id: 'a', date: '2026-10-10', createdAt: 1, note: 'Jollibee' }),
      T({ id: 'b', date: '2026-10-12', createdAt: 1, amount: 175, note: 'Grab' }),
      { id: 'c', kind: 'income', amount: 25000, date: '2026-10-09', accountId: 'gcash', createdAt: 1 },
      { id: 'd', kind: 'debt', amount: 2000, date: '2026-10-12', accountId: 'gcash', debtId: 'loan', createdAt: 1 },
    ];
    const rows = [
      { date: '2026-10-10', amount: 289, kind: 'expense', merchant: 'JOLLIBEE' },
      { date: '2026-10-11', amount: 289, kind: 'expense', merchant: 'JOLLIBEE' },
      { date: '2026-10-13', amount: 175, kind: 'expense', merchant: 'GRAB PH' },
      { date: '2026-10-09', amount: 25000, kind: 'income', merchant: 'PAYROLL' },
      { date: '2026-10-12', amount: 2000, kind: 'expense', merchant: 'HOME CREDIT' },
      { date: '2026-10-15', amount: 50, kind: 'expense', merchant: 'FEE' },
    ];
    const out = R.matchRows(rows, txns, { accountId: 'gcash' });
    assert.deepEqual(out.map((r) => r.match?.id ?? null), ['a', null, 'b', 'c', 'd', null]);
  });
  test('card statements match card purchases and payments to that card', () => {
    const txns = [
      { id: 'p', kind: 'expense', amount: 1500, date: '2026-10-11', cardId: 'card', createdAt: 1, note: 'Shoes' },
      { id: 'q', kind: 'debt', amount: 3000, date: '2026-10-20', debtId: 'card', accountId: 'bpi', createdAt: 1 },
    ];
    const out = R.matchRows([{ date: '2026-10-12', amount: 1500, kind: 'expense', merchant: 'NIKE' }, { date: '2026-10-20', amount: 3000, kind: 'income', merchant: 'PAYMENT THANK YOU' }], txns, { cardId: 'card' });
    assert.deepEqual(out.map((r) => r.match?.id ?? null), ['p', 'q']);
  });
});
