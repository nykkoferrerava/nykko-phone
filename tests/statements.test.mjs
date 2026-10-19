// Statement import (js/statements.js): reading PDFs with the vendored pdf.js (a password-protected
// GCash-style history and a bank statement, from tests/fixtures/make-statements.py) and CSV files,
// guessing columns, marking what Pitaka already has, importing with Undo, and the closing-balance check.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, S, store, fresh, cat, wallet } from './env.mjs';

const T = await import(`${APP}/js/statements.js`);
const fixture = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
// pdf.js says, once, that Node can't draw pages (Pitaka only reads their text).
async function quietly(fn) {
  const keep = [console.log, console.warn];
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { [console.log, console.warn] = keep; }
}
let gcashPages, bankPages;
before(async () => {
  gcashPages = await quietly(() => T.readPdf(fixture('statement-gcash.pdf'), { password: 'pitaka1234' }));
  bankPages = await quietly(() => T.readPdf(fixture('statement-bank.pdf')));
});
function setup() {
  fresh();
  const gcash = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 5000, openingDate: '2026-10-01' });
  const gotyme = S.saveAccount({ name: 'GoTyme', kind: 'bank', opening: 0, openingDate: '2026-10-01' });
  const bpi = S.saveAccount({ name: 'BPI Savings', kind: 'bank', opening: 20000, openingDate: '2026-10-01' });
  const card = S.saveDebt({ type: 'card', name: 'Metrobank Card', lender: 'Metrobank', balance: 0, paymentAmount: 0, nextDue: '2026-10-25' });
  return { gcash, gotyme, bpi, card };
}
const gcashRows = (target) => {
  const t = T.tableFromPdf(gcashPages);
  const b = T.buildRows(t, t.roles);
  return { table: t, built: b, rows: T.markExisting(b.rows, target) };
};

describe('statements: money and dates', () => {
  test('amounts as statements write them', () => {
    const n = (s) => T.parseAmount(s)?.n ?? null;
    assert.equal(n('1,234.56'), 1234.56);
    assert.equal(n('-1,234.56'), -1234.56);
    assert.equal(n('(1,234.56)'), -1234.56);
    assert.equal(n('PHP 289.00'), 289);
    assert.equal(n('₱ 50'), 50);
    assert.equal(n('1,234.56-'), -1234.56);
    assert.deepEqual(T.parseAmount('500.00 DR'), { n: 500, mark: 'dr' });
    assert.deepEqual(T.parseAmount('500.00 CR'), { n: 500, mark: 'cr' });
    for (const bad of ['', 'abc', '12,34', '1001234567890', '09171234567', '2026-10-13']) assert.equal(T.parseAmount(bad), null, bad);
  });
  test('dates in the usual forms; numeric ones month-first unless a day is over 12', () => {
    const d = (s, o) => T.parseDate(s, { year: 2026, ...o })?.iso ?? null;
    assert.equal(d('2026-10-13 08:12 PM'), '2026-10-13');
    assert.equal(d('10/13/2026'), '2026-10-13');
    assert.equal(d('13/10/2026', { order: 'dmy' }), '2026-10-13');
    assert.equal(d('03/04/26'), '2026-03-04');
    assert.equal(d('Oct 13, 2026'), '2026-10-13');
    assert.equal(d('13 Oct 2026'), '2026-10-13');
    assert.equal(d('13-Oct-26'), '2026-10-13');
    assert.equal(d('Sept 3'), '2026-09-03', 'no year: the statement year');
    assert.equal(d('2026-02-30'), null);
    assert.equal(d('Description'), null);
    assert.equal(T.dateOrder(['01/02/2026', '13/02/2026']), 'dmy');
    assert.equal(T.dateOrder(['01/02/2026', '02/13/2026']), 'mdy');
    assert.equal(T.dateOrder(['01/02/2026']), 'mdy');
  });
  test('column roles from headers, then from what the columns hold', () => {
    assert.deepEqual(T.guessRoles(['Date and Time', 'Description', 'Reference No.', 'Debit', 'Credit', 'Balance'], []), ['date', 'desc', 'ref', 'out', 'in', 'balance']);
    assert.deepEqual(T.guessRoles(['Transaction Date', 'Details', 'Money In', 'Money Out', 'Running Balance'], []), ['date', 'desc', 'in', 'out', 'balance']);
    assert.deepEqual(T.guessRoles(['Posting Date', 'Transaction Date', 'Transaction Amount', 'Remarks'], []), ['date', 'skip', 'amount', 'desc']);
    assert.deepEqual(T.guessRoles(['A', 'B', 'C'], [['2026-10-01', 'JOLLIBEE', '-289.00'], ['2026-10-02', 'GRAB', '-175.00']]), ['date', 'desc', 'amount']);
  });
});

describe('statements: PDFs', () => {
  test('a locked PDF asks for its password, says when it is wrong, and opens with the right one', async () => {
    await assert.rejects(quietly(() => T.readPdf(fixture('statement-gcash.pdf'))), (e) => e.name === 'PdfPasswordError' && e.wrong === false);
    await assert.rejects(quietly(() => T.readPdf(fixture('statement-gcash.pdf'), { password: 'nope' })), (e) => e.name === 'PdfPasswordError' && e.wrong === true);
    assert.ok(gcashPages.length === 2 && gcashPages[0].length > 10);
  });
  test('the password is never kept', () => {
    setup();
    assert.ok(!JSON.stringify(S.db).includes('pitaka1234'));
    assert.ok(!JSON.stringify(store.dump()).includes('pitaka1234'));
  });
  test('a GCash-style history: header on each page, a wrapped description, debit and credit columns', () => {
    const t = T.tableFromPdf(gcashPages);
    assert.deepEqual(t.header, ['Date and Time', 'Description', 'Reference No.', 'Debit', 'Credit', 'Balance']);
    assert.deepEqual(t.roles, ['date', 'desc', 'ref', 'out', 'in', 'balance']);
    assert.equal(t.rows.length, 6, 'both pages, repeated header and footers skipped');
    assert.equal(t.opening, 5000);
    const b = T.buildRows(t, t.roles);
    assert.deepEqual(b.rows.map((r) => [r.date, r.kind, r.amount]), [
      ['2026-10-01', 'income', 1000], ['2026-10-03', 'expense', 289], ['2026-10-05', 'expense', 100],
      ['2026-10-08', 'expense', 1000], ['2026-10-10', 'expense', 1520.5], ['2026-10-12', 'income', 2000],
    ]);
    assert.equal(b.rows[2].merchant, 'Buy Load Transaction for Globe Prepaid 09171234567');
    assert.equal(b.rows[1].ref, '1001234567891');
    assert.deepEqual(b.closing, { date: '2026-10-12', balance: 5090.5 });
  });
  test('a bank statement: header once, newest first, one signed Amount column', () => {
    const t = T.tableFromPdf(bankPages);
    assert.deepEqual(t.roles, ['date', 'desc', 'amount', 'balance']);
    const b = T.buildRows(t, t.roles);
    assert.equal(b.positive, 'in', 'the running balance shows that positive amounts are money in');
    assert.deepEqual(b.rows.map((r) => [r.date, r.kind, r.amount]), [['2026-09-30', 'expense', 2000], ['2026-09-25', 'income', 25000], ['2026-09-20', 'expense', 549], ['2026-09-15', 'income', 1.25]]);
    assert.deepEqual(b.closing, { date: '2026-09-30', balance: 23452.25 }, 'the latest row, though it is listed first');
  });
  test('something that is not a PDF statement fails clearly', async () => {
    await assert.rejects(quietly(() => T.readPdf(new TextEncoder().encode('%PDF-1.4 broken'))), /couldn't read this PDF/);
    assert.equal(T.isPdf(fixture('statement-bank.pdf')), true);
    assert.equal(T.isPdf(new TextEncoder().encode('Date,Amount')), false);
  });
});

describe('statements: CSV', () => {
  test('quotes, a preamble before the header, and day-first dates', () => {
    const csv = '﻿My Bank\r\nAccount: ****1234\r\n\r\nDate,Description,Withdrawal,Deposit,Balance\r\n13/10/2026,"JOLLIBEE, SM NORTH",289.00,,"4,711.00"\r\n14/10/2026,"He said ""hi""",,"1,000.00","5,711.00"\r\n';
    const t = T.tableFromCsv(csv);
    assert.deepEqual(t.roles, ['date', 'desc', 'out', 'in', 'balance']);
    const b = T.buildRows(t, t.roles);
    assert.equal(b.order, 'dmy');
    assert.deepEqual(b.rows.map((r) => [r.date, r.kind, r.amount, r.merchant]), [['2026-10-13', 'expense', 289, 'JOLLIBEE, SM NORTH'], ['2026-10-14', 'income', 1000, 'He said "hi"']]);
  });
  test('semicolons, DR/CR marks and a card statement where purchases are positive', () => {
    const t = T.tableFromCsv('Posting Date;Particulars;Amount\n2026-10-02;LAZADA;1,499.00\n2026-10-05;PAYMENT - THANK YOU;3,000.00 CR\n2026-10-06;REFUND LAZADA;-200.00\n');
    const b = T.buildRows(t, t.roles, { card: true });
    assert.equal(b.positive, 'out');
    assert.deepEqual(b.rows.map((r) => [r.kind, r.amount]), [['expense', 1499], ['income', 3000], ['income', 200]]);
  });
  test('roles and options can be changed by hand', () => {
    const t = T.tableFromCsv('When,What,How much\n01/02/2026,X,100\n');
    const b = T.buildRows(t, ['date', 'desc', 'amount'], { order: 'dmy', positive: 'out' });
    assert.deepEqual([b.rows[0].date, b.rows[0].kind], ['2026-02-01', 'expense']);
    const bad = T.buildRows(t, ['skip', 'desc', 'amount']);
    assert.equal(bad.rows[0].problem, 'date');
  });
});

describe('statements: matching and importing', () => {
  test('rows already in Pitaka are marked; transfers between your wallets are recognised', () => {
    const { gcash, gotyme, bpi } = setup();
    S.saveTxn({ kind: 'expense', amount: 289, date: '2026-10-03', accountId: gcash.id, categoryId: cat('Food').id, note: 'Jollibee' });
    const { rows } = gcashRows({ accountId: gcash.id });
    const st = rows.map((r) => T.rowStatus(r, { accountId: gcash.id }));
    assert.deepEqual(st, ['new', 'existing', 'new', 'transfer', 'new', 'transfer']);
    assert.equal(rows[3].other, gotyme.id);
    assert.equal(rows[5].other, bpi.id);
  });
  test('import adds new rows, links existing ones, then a second import of the same file adds nothing', () => {
    const { gcash, gotyme, bpi } = setup();
    const manual = S.saveTxn({ kind: 'expense', amount: 289, date: '2026-10-03', accountId: gcash.id, categoryId: cat('Food').id, note: 'Jollibee' });
    const before = S.db.txns.length;
    const target = { accountId: gcash.id };
    const res = T.importRows(gcashRows(target).rows, target, { inst: 'GCash' });
    assert.equal(res.created.length, 5);
    assert.equal(S.db.txns.length, before + 5);
    assert.ok(S.txn(manual.id).conf.some((c) => c.via === 'statement'), 'the one you logged is now "on the statement"');
    const tr = S.db.txns.filter((t) => t.kind === 'transfer');
    assert.deepEqual(tr.map((t) => [t.accountId, t.toAccountId, t.amount]).sort(), [[bpi.id, gcash.id, 2000], [gcash.id, gotyme.id, 1000]].sort());
    assert.ok(S.db.txns.filter((t) => t.src === 'statement').every((t) => t.conf?.[0]?.via === 'statement'));
    assert.equal(S.accountBalance(gcash.id), 5090.5, 'Pitaka now agrees with the statement');
    assert.equal(S.accountBalance(gotyme.id), 1000);
    // Same file again: every row is already there.
    const again = gcashRows(target).rows;
    assert.ok(again.every((r) => T.rowStatus(r, target) === 'existing'));
    assert.deepEqual(T.importRows(again, target, { inst: 'GCash' }).created, []);
  });
  test('Undo removes what the import added and the "on the statement" marks', () => {
    const { gcash } = setup();
    const manual = S.saveTxn({ kind: 'expense', amount: 289, date: '2026-10-03', accountId: gcash.id, categoryId: cat('Food').id, note: 'Jollibee' });
    const snapshot = JSON.stringify(S.db.txns);
    const target = { accountId: gcash.id };
    const res = T.importRows(gcashRows(target).rows, target, { inst: 'GCash' });
    T.undoImport(res);
    assert.equal(JSON.stringify(S.db.txns), snapshot);
    assert.equal(S.txn(manual.id).conf, undefined);
  });
  test('an import is one save: if it fails, nothing is added', async () => {
    const { gcash } = setup();
    await S.flush();
    const n = S.db.txns.length;
    store.failWith('QuotaExceededError', 1);
    const target = { accountId: gcash.id };
    T.importRows(gcashRows(target).rows, target);
    await assert.rejects(S.flush());
    assert.equal(S.db.txns.length, n);
  });
  test('card statements: purchases are imported to the card; payments to it are only marked', () => {
    const { card } = setup();
    const t = T.tableFromCsv('Date,Description,Amount\n2026-10-02,LAZADA,1499.00\n2026-10-05,PAYMENT THANK YOU,3000.00 CR\n');
    const target = { cardId: card.id };
    const rows = T.markExisting(T.buildRows(t, t.roles, { card: true }).rows, target);
    assert.deepEqual(rows.map((r) => T.rowStatus(r, target)), ['new', 'card-payment']);
    const res = T.importRows(rows, target);
    assert.equal(res.created.length, 1);
    const p = S.txn(res.created[0]);
    assert.deepEqual([p.kind, p.cardId, p.amount], ['expense', card.id, 1499]);
    assert.equal(S.debt(card.id).balance, 1499, 'the card balance goes up');
  });
  test('categories are guessed from the merchant', () => {
    const { gcash } = setup();
    const target = { accountId: gcash.id };
    const res = T.importRows(gcashRows(target).rows, target);
    const jollibee = res.created.map(S.txn).find((t) => /JOLLIBEE/.test(t.merchant));
    assert.equal(jollibee.categoryId, cat('Food').id);
  });
});

describe('statements: which wallet', () => {
  test('a statement names its wallet in the file name or its first lines', () => {
    const { gcash, gotyme } = setup();
    assert.equal(T.guessWallet('statement.pdf', T.pdfText(gcashPages)), gcash.id, '"GCash Transaction History"');
    assert.equal(T.guessWallet('GoTyme_Statement_Oct2026.csv', 'Date,Amount'), gotyme.id);
    assert.equal(T.guessWallet('export.csv', 'Date,Description,Amount'), null);
  });
});

describe('statements: the monthly check', () => {
  test('compares the closing balance with Pitaka on that day and fixes the difference on request', () => {
    const { gcash } = setup();
    S.saveAccount({ ...gcash, opening: 4800 }); // Pitaka was ₱200 short from the start
    const target = { accountId: gcash.id };
    const { rows, built } = gcashRows(target);
    T.importRows(rows, target);
    const check = T.closingCheck(gcash.id, built.closing);
    assert.deepEqual(check, { date: '2026-10-12', statement: 5090.5, pitaka: 4890.5, diff: 200 });
    assert.equal(T.reconcileDue(gcash.id), true);
    const fix = T.reconcile(gcash.id, check);
    assert.deepEqual([fix.kind, fix.direction, fix.amount, fix.date, fix.reason], ['adjust', 'up', 200, '2026-10-12', 'correction']);
    assert.equal(T.closingCheck(gcash.id, built.closing).diff, 0);
    assert.equal(T.lastStatementCheck(gcash.id).amount, 5090.5);
    assert.equal(T.reconcileDue(gcash.id), false);
  });
  test('when they already match, only the check is recorded', () => {
    const { gcash } = setup();
    const target = { accountId: gcash.id };
    const { rows, built } = gcashRows(target);
    T.importRows(rows, target);
    const check = T.closingCheck(gcash.id, built.closing);
    assert.equal(check.diff, 0);
    const n = S.db.txns.length;
    assert.equal(T.reconcile(gcash.id, check), null);
    assert.equal(S.db.txns.length, n);
    assert.equal(wallet('GCash').checked.via, 'statement');
  });
});
