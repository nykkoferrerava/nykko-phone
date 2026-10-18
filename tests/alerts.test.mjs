// Alert parsing: the built-in (unverified) formats, the generic fallback, Apple Wallet, emails, and
// formats taught by tapping ("Teach this format").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP } from './env.mjs';

const A = await import(`${APP}/js/alerts.js`);
const sms = (sender, text) => ({ type: 'sms', raw: { sender, text } });
const ev = (item, o) => A.parseAlert(item, o).ev;

describe('alerts: the registry', () => {
  test('every built-in parser is labelled unverified and has a sender', () => {
    assert.deepEqual(A.PARSERS.map((p) => p.id), ['gcash', 'gotyme', 'maya', 'bpi', 'bdo', 'unionbank', 'metrobank', 'securitybank', 'rcbc', 'seabank', 'cimb']);
    for (const p of A.PARSERS) { assert.equal(p.unverified, true, p.id); assert.ok(p.senders.length, p.id); }
    assert.equal(A.senderParser('GCash').id, 'gcash');
    assert.equal(A.senderParser('BPI ALERTS').id, 'bpi');
    assert.equal(A.senderParser('no-reply@gotyme.com.ph').id, 'gotyme');
    assert.equal(A.senderParser('Mama'), undefined);
  });
  test('money, balance, reference and card ending helpers', () => {
    assert.equal(A.parseMoney('PHP 1,234.50'), 1234.5);
    assert.equal(A.parseMoney('P289.00'), 289);
    assert.equal(A.parseMoney('₱0'), null);
    assert.equal(A.parseMoney('abc'), null);
    assert.equal(A.balanceOf('Your new balance is PHP 1,234.50.'), 1234.5);
    assert.equal(A.balanceOf('Avail bal: PHP 12,345.67'), 12345.67);
    assert.equal(A.balanceOf('Available balance P500.00'), 500);
    assert.equal(A.refOf('Ref. No. 1234567890123.'), '1234567890123');
    assert.equal(A.refOf('Reference Number: AB12CD34EF'), 'AB12CD34EF');
    assert.equal(A.refOf('Ref No. none'), null);
    assert.equal(A.last4Of('card ending in 1234'), '1234');
    assert.equal(A.last4Of('Card ****5678 used'), '5678');
  });
});

describe('alerts: GCash (unverified formats)', () => {
  test('received money', () => {
    const r = A.parseAlert(sms('GCash', 'You have received PHP 500.00 of GCash from JUAN DELA CRUZ 09171234567 on 10-18-2026 12:41 PM. Your new balance is PHP 1,234.50. Ref. No. 1234567890123.'));
    assert.deepEqual({ kind: r.ev.kind, amount: r.ev.amount, merchant: r.ev.merchant, bal: r.ev.balanceAfter, ref: r.ev.reference, inst: r.ev.inst }, { kind: 'transfer-in', amount: 500, merchant: 'JUAN DELA CRUZ', bal: 1234.5, ref: '1234567890123', inst: 'GCash' });
    assert.equal(r.unverified, true); assert.equal(r.parser, 'gcash'); assert.ok(r.confidence >= 0.8);
  });
  test('sent money to a bank', () => {
    const e = ev(sms('GCash', 'You have sent PHP 1,000.00 of GCash to GOTYME BANK on 10-18-2026 01:05 PM. Ref. No. 2233445566778. Your new balance is PHP 234.50.'));
    assert.deepEqual([e.kind, e.amount, e.merchant], ['transfer-out', 1000, 'GOTYME BANK']);
  });
  test('paid a merchant / QR', () => {
    const e = ev(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-18-2026 12:41 PM. Ref No. 9876543210123. Your new balance is PHP 945.50.'));
    assert.deepEqual([e.kind, e.amount, e.merchant, e.balanceAfter, e.reference], ['expense', 289, 'JOLLIBEE FOODS CORP', 945.5, '9876543210123']);
    const qr = ev(sms('GCash', 'You have paid P150.00 via QR Ph to KUYA ISAW STAND. Ref No. 1111222233334.'));
    assert.equal(qr.amount, 150);
  });
  test('paid a bill', () => {
    const e = ev(sms('GCash', 'Your payment of PHP 3,200.00 to MERALCO has been received. Ref. No. 5556667778889.'));
    assert.deepEqual([e.kind, e.amount, e.merchant], ['expense', 3200, 'MERALCO']);
  });
  test('bought load', () => {
    const e = ev(sms('GCash', 'You have successfully loaded PHP 99.00 to 09171234567. Ref. No. 4445556667778.'));
    assert.deepEqual([e.kind, e.amount, e.merchant], ['expense', 99, 'Load']);
  });
  test('cash-in', () => {
    const e = ev(sms('GCash', 'You have successfully cashed-in PHP 1,000.00 via BPI. Your new balance is PHP 2,234.50. Ref. No. 7778889990001.'));
    assert.deepEqual([e.kind, e.amount, e.merchant, e.balanceAfter], ['transfer-in', 1000, 'BPI', 2234.5]);
  });
});

describe('alerts: banks and other wallets (unverified formats)', () => {
  test('credit card purchase with card ending', () => {
    const e = ev(sms('BPI', 'BPI: Your credit card ending 1234 was used for PHP 289.00 at JOLLIBEE QC on 10/18/26 12:41.'));
    assert.deepEqual([e.kind, e.amount, e.merchant, e.last4, e.inst], ['expense', 289, 'JOLLIBEE QC', '1234', 'BPI']);
  });
  test('transaction amounting to ... at ... using card ending', () => {
    const e = ev(sms('BDO', 'BDO: A transaction amounting to PHP 1,250.00 was made at SHOPEE PH using your card ending 5678 on 10/18/2026.'));
    assert.deepEqual([e.kind, e.amount, e.merchant, e.last4], ['expense', 1250, 'SHOPEE PH', '5678']);
  });
  test('account debited / credited, lower confidence', () => {
    const r = A.parseAlert(sms('UnionBank', 'Your account ending 4321 has been debited PHP 5,000.00 on 10/18/2026. Avail bal: PHP 12,345.67'));
    assert.deepEqual([r.ev.kind, r.ev.amount, r.ev.balanceAfter], ['transfer-out', 5000, 12345.67]);
    assert.ok(r.confidence < 0.8);
    const c = A.parseAlert(sms('Metrobank', 'PHP 25,000.00 has been credited to your account ending 4321.'));
    assert.deepEqual([c.ev.kind, c.ev.amount], ['transfer-in', 25000]);
  });
  test('e-wallet style "You received / sent / paid"', () => {
    assert.deepEqual([ev(sms('Maya', 'You received PHP 300.00 from ANA REYES on Oct 18, 2026.')).kind, ev(sms('Maya', 'You paid PHP 89.00 to 7-ELEVEN on Oct 18, 2026.')).merchant], ['transfer-in', '7-ELEVEN']);
    assert.equal(ev(sms('SeaBank', 'You have transferred PHP 2,000.00 to GCASH 0917***4567 on 18 Oct 2026.')).kind, 'transfer-out');
  });
  test('unknown senders fall back to an amount and a card ending, with low confidence', () => {
    const r = A.parseAlert(sms('MyBank', 'Purchase PHP 450.00 at NATIONAL BOOK STORE card **9012'));
    assert.equal(r.parser, 'generic'); assert.equal(r.ev.amount, 450); assert.equal(r.ev.last4, '9012'); assert.ok(r.confidence <= 0.5);
    assert.equal(A.parseAlert(sms('GCash', 'Your OTP is 123456. Do not share it.')).ev, null);
  });
  test('email: HTML is turned into text first', () => {
    const r = A.parseAlert({ type: 'email', raw: { from: 'GoTyme Bank <no-reply@gotyme.com.ph>', subject: 'You sent money', body: '<p>Hi!</p><p>You sent <b>&#8369;1,000.00</b> to JUAN DELA CRUZ on 18 Oct 2026.</p><p>Ref No. 998877665544</p>' } });
    assert.deepEqual([r.parser, r.ev.kind, r.ev.amount, r.ev.merchant, r.ev.reference], ['gotyme', 'transfer-out', 1000, 'JUAN DELA CRUZ', '998877665544']);
  });
  test('Apple Wallet transactions come structured', () => {
    const r = A.parseAlert({ type: 'wallet', raw: { merchant: 'Starbucks Reserve', amount: '₱245.00', card: 'BPI Gold' } });
    assert.deepEqual([r.ev.kind, r.ev.amount, r.ev.merchant, r.ev.cardName, r.confidence], ['expense', 245, 'Starbucks Reserve', 'BPI Gold', 0.9]);
  });
});

describe('alerts: teaching a format', () => {
  const msg = 'GoTyme: You spent PHP 289.00 at JOLLIBEE QC on 10/18/2026 12:41 PM. Available balance PHP 945.50. Ref 9988776655.';
  const span = (text, s) => { const i = text.indexOf(s); return [i, i + s.length]; };
  test('tapping amount, merchant, balance and reference gives a reusable format', () => {
    const f = A.buildTemplate(msg, { amount: span(msg, '289.00'), merchant: span(msg, 'JOLLIBEE QC'), balance: span(msg, '945.50'), ref: span(msg, '9988776655') });
    assert.equal(f, 'GoTyme: You spent {amount} at {merchant} on {#}/{#}/{#} {#}:{#} {w}. Available balance {balance}. Ref {ref}.');
    const next = 'GoTyme: You spent PHP 1,250.00 at SM SUPERMARKET MOA on 10/19/2026 9:05 AM. Available balance PHP 12,000.00. Ref 1122334455. Earn rewards with GoTyme!';
    assert.deepEqual(A.matchTemplate(f, next), { amount: 1250, merchant: 'SM SUPERMARKET MOA', balance: 12000, ref: '1122334455' });
    assert.equal(A.matchTemplate(f, 'GoTyme: You received PHP 100.00 from ANA.'), null);
  });
  test('a taught format beats the built-in one and is trusted more', () => {
    const f = A.buildTemplate(msg, { amount: span(msg, '289.00'), merchant: span(msg, 'JOLLIBEE QC') });
    const r = A.parseAlert(sms('GoTyme', msg.replace('289.00', '75.00')), { templates: [{ id: 't1', sender: 'gotyme', format: f, kind: 'expense', accountId: 'acc1' }] });
    assert.deepEqual([r.parser, r.templateId, r.confidence, r.unverified, r.ev.amount, r.ev.merchant, r.ev.accountId, r.ev.balanceAfter], ['template', 't1', 0.95, false, 75, 'JOLLIBEE QC', 'acc1', 945.5]);
    const other = A.parseAlert(sms('BPI', msg), { templates: [{ id: 't1', sender: 'gotyme', format: f, kind: 'expense' }] });
    assert.notEqual(other.parser, 'template', 'only for the sender it was taught for');
  });
  test('the format must have {amount}, known placeholders, each at most once', () => {
    assert.throws(() => A.compileTemplate('Paid {merchant}'), /needs \{amount\}/);
    assert.throws(() => A.compileTemplate('Paid {amount} {price}'), /Unknown placeholder/);
    assert.throws(() => A.compileTemplate('{amount} and {amount}'), /twice/);
    assert.throws(() => A.compileTemplate(''), /empty/);
    assert.throws(() => A.buildTemplate(msg, {}), /amount/);
    assert.throws(() => A.buildTemplate(msg, { amount: [5, 10], merchant: [8, 20] }), /overlap/);
  });
  test('special characters in the message are matched literally (no regex surprises)', () => {
    const t = 'Paid (QR) [x] P50.00 to A+B*C? Ok.';
    const f = A.buildTemplate(t, { amount: span(t, '50.00'), merchant: span(t, 'A+B*C?') });
    assert.deepEqual(A.matchTemplate(f, 'Paid (QR) [x] P75.25 to D.E? Ok.'), { amount: 75.25, merchant: 'D.E?' });
  });
  test('a merchant at the very end still reads the whole name', () => {
    assert.deepEqual(A.matchTemplate('Charged {amount} by {merchant}', 'Charged PHP 10.00 by NETFLIX.COM'), { amount: 10, merchant: 'NETFLIX' });
    assert.deepEqual(A.matchTemplate('Charged {amount} by {merchant}', 'Charged PHP 10.00 by SPOTIFY AB'), { amount: 10, merchant: 'SPOTIFY AB' });
  });
});
