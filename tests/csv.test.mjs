// CSV export: escaping, the formula-injection guard, filters and the files produced.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { S, C, fresh, cat } from './env-insights.mjs';

describe('csv: cells', () => {
  test('plain values pass through; quotes, commas, new lines and edge spaces are quoted', () => {
    assert.equal(C.csvCell('Jollibee'), 'Jollibee');
    assert.equal(C.csvCell('Ref, ref'), '"Ref, ref"');
    assert.equal(C.csvCell('He said "hi"'), '"He said ""hi"""');
    assert.equal(C.csvCell('line 1\r\nline 2'), '"line 1\nline 2"');
    assert.equal(C.csvCell(' padded'), '" padded"');
    assert.equal(C.csvCell(null), ''); assert.equal(C.csvCell(undefined), '');
    assert.equal(C.csvCell(true), 'yes');
  });
  test('formula injection: text starting with = + - @ tab or CR is neutralised', () => {
    assert.equal(C.csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
    assert.equal(C.csvCell('+63 917 000 0000'), "'+63 917 000 0000");
    assert.equal(C.csvCell('-50 discount'), "'-50 discount");
    assert.equal(C.csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
    assert.equal(C.csvCell('\t=1+1'), "'\t=1+1");
    assert.equal(C.csvCell('\r=1+1'), `"'\n=1+1"`);
    assert.equal(C.csvCell('a=b'), 'a=b', 'only a leading sign matters');
  });
  test('numbers stay numbers, negative ones included', () => {
    assert.equal(C.csvCell(-150), '-150');
    assert.equal(C.csvCell(1234.5), '1234.5');
    assert.equal(C.csvCell(0.1 + 0.2), '0.3');
    assert.equal(C.csvCell(NaN), '');
  });
  test('a file starts with a byte order mark and uses CRLF', () => {
    assert.equal(C.toCSV([['a', 'b'], [1, 'x,y']]), '﻿a,b\r\n1,"x,y"\r\n');
  });
});

describe('csv: exports', () => {
  function seed() {
    fresh();
    const g = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 0, openingDate: '2026-10-01' });
    const card = S.saveDebt({ type: 'card', name: 'BPI Gold', balance: 1000, paymentAmount: 500, nextDue: '2026-10-25' });
    S.saveTxn({ kind: 'income', amount: 25000, date: '2026-10-09', note: 'Salary', accountId: g.id });
    S.saveTxn({ kind: 'expense', amount: 289, date: '2026-10-10', categoryId: cat('Food').id, accountId: g.id, merchant: 'JOLLIBEE', note: '=cmd|calc', src: 'sms', ref: '1234567', conf: [{ via: 'sms', inst: 'GCash' }] });
    S.saveTxn({ kind: 'expense', amount: 1500, date: '2026-10-11', categoryId: cat('Shopping').id, cardId: card.id, note: 'Shoes' });
    S.saveTxn({ kind: 'transfer', amount: 1000, date: '2026-10-12', accountId: g.id, toAccountId: S.defaultAccountId() });
    S.lend({ name: 'Mel', amount: 500, accountId: g.id, date: '2026-10-13' });
    S.saveTxn({ kind: 'expense', amount: 99, date: '2026-09-30', categoryId: cat('Load & Internet').id, note: 'Load' });
    return { g, card };
  }
  test('transactions: header, signs, untrusted text guarded, date range', () => {
    seed();
    const rows = C.transactionRows({ from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(rows[0].slice(0, 6), ['Date', 'Time', 'Type', 'Amount', 'Wallet change', 'Category']);
    assert.equal(rows.length, 6);
    const jb = rows.find((r) => r[11] === 'JOLLIBEE');
    assert.deepEqual([jb[2], jb[3], jb[4], jb[5], jb[6], jb[14], jb[15], jb[16]], ['Expense', 289, -289, 'Food', 'GCash', 'sms', '1234567', 'GCash']);
    const csv = C.toCSV(rows);
    assert.ok(csv.includes(",'=cmd|calc,"), 'the formula is neutralised');
    const card = rows.find((r) => r[12] === 'Shoes');
    assert.deepEqual([card[4], card[8]], [0, 'BPI Gold'], 'a card purchase does not touch a wallet');
    const lend = rows.find((r) => r[2] === 'Lent');
    assert.deepEqual([lend[4], lend[10]], [-500, 'Mel']);
  });
  test('wallet filter keeps entries that touch the wallet (both sides of a transfer) or the card', () => {
    const { g, card } = seed();
    assert.equal(C.transactionRows({ accountId: g.id }).length - 1, 4);
    assert.equal(C.transactionRows({ accountId: S.defaultAccountId() }).length - 1, 2);
    assert.equal(C.transactionRows({ accountId: card.id }).length - 1, 1);
  });
  test('debts, goals and receivables files', () => {
    seed();
    S.saveGoal({ name: 'Japan', emoji: '✈️', target: 60000, saved: 1000, deadline: '2027-04-01' });
    const files = C.buildExports({ what: ['transactions', 'debts', 'goals', 'receivables'], from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(files.map((f) => f.name), ['pitaka-transactions-2026-10-01-to-2026-10-31.csv', 'pitaka-debts-2026-10-13.csv', 'pitaka-goals-2026-10-13.csv', 'pitaka-owed-to-you-2026-10-13.csv']);
    assert.match(files[1].text, /BPI Gold,Credit card,,2500,/);
    assert.match(files[2].text, /✈️ Japan,60000,1000,59000,2027-04-01,/);
    assert.match(files[3].text, /Mel,500,0,,2026-10-13,/);
  });
});
