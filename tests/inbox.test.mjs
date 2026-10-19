// The inbox pipeline end to end, against the real store: quick add, quick text, alerts, balance checks,
// duplicates, transfers, Review decisions, teaching a format, undo, atomic saves, Files catch-up.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP, S, store, fresh, cat, at, setToday } from './env.mjs';

const X = await import(`${APP}/js/inbox.js`);
const A = await import(`${APP}/js/alerts.js`);
let n = 0;
const cid = () => `c${Date.now()}-${++n}`;
const item = (type, fields, when = at('2026-10-13', 12, 41)) => X.cleanRaw({ id: cid(), type, at: new Date(when).toISOString(), ...fields });
const sms = (sender, text, when) => item('sms', { sender, text }, when);
const run = (...items) => X.processItems(items);

function setup() {
  fresh();
  const cash = S.db.accounts[0];
  const gcash = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 5000, openingDate: '2026-10-01' });
  const gotyme = S.saveAccount({ name: 'GoTyme', kind: 'bank', opening: 2000, openingDate: '2026-10-01' });
  const card = S.saveDebt({ type: 'card', name: 'BPI Gold', lender: 'BPI', balance: 0, paymentAmount: 0, nextDue: '2026-10-25' });
  S.updateSettings({ defaultAccountId: gcash.id });
  return { cash, gcash, gotyme, card };
}

describe('inbox: checking what arrives', () => {
  test('cleanRaw keeps known fields, caps sizes, drops unknown types and dangerous keys', () => {
    const r = X.cleanRaw(JSON.parse('{"id":"abc123456","type":"sms","sender":"GCash","text":"hi","evil":"x","__proto__":{"polluted":1},"at":"2026-10-13T12:41:00+08:00"}'));
    assert.deepEqual(Object.keys(r.raw), ['sender', 'text']);
    assert.equal(r.cid, 'abc123456');
    assert.equal(({}).polluted, undefined);
    assert.equal(X.cleanRaw({ type: 'virus' }), null);
    assert.equal(X.cleanRaw('nope'), null);
    assert.equal(X.cleanRaw({ id: 'abc123456', type: 'sms', text: 'x'.repeat(9000) }).raw.text.length, 4000);
    const noId = X.cleanRaw({ type: 'text', text: '150 lunch', at: '2026-10-13T12:00:00Z' });
    assert.equal(noId.cid, X.cleanRaw({ type: 'text', text: '150 lunch', at: '2026-10-13T12:00:00Z' }).cid, 'same line, same id');
    assert.equal(X.cleanRaw({ item: { id: 'wrapped01', type: 'text', text: 'x' } }).cid, 'wrapped01');
  });
  test('Files catch-up: one JSON object per line, bad lines counted', () => {
    const { items, bad } = X.parseJsonl('{"id":"line000001","type":"text","text":"150 lunch"}\nnot json\n\n{"id":"line000002","type":"entry","amount":99,"category":"Food","wallet":"Cash"}\n{"type":"weird"}');
    assert.deepEqual([items.length, bad], [2, 2]);
  });
});

describe('inbox: Quick Add – Keypad', () => {
  test('a keypad entry becomes an expense straight away', async () => {
    const { gcash } = setup();
    const out = run(item('entry', { amount: 150, category: '🍜 Food', wallet: 'GCash', note: 'lunch' }));
    assert.equal(out.created.length, 1);
    const t = S.txn(out.created[0]);
    assert.deepEqual([t.kind, t.amount, t.categoryId, t.accountId, t.note, t.src], ['expense', 150, cat('Food').id, gcash.id, 'lunch', 'quick']);
    assert.equal(t.at, at('2026-10-13', 12, 41));
    assert.equal(S.inboxItem(out.ids[0]).status, 'auto');
    await S.flush();
  });
  test('renamed categories and cards from the shortcut list are found', () => {
    const { card } = setup();
    S.saveCategory({ id: cat('Food').id, name: 'Kain', emoji: '🍚' });
    const out = run(item('entry', { amount: 1840.5, category: '🍚 Kain', wallet: 'BPI Gold' }));
    const t = S.txn(out.created[0]);
    assert.deepEqual([t.categoryId, t.cardId], [cat('Kain').id, card.id]);
    assert.equal(S.debt(card.id).balance, 1840.5);
  });
  test('an unknown category or wallet waits in Review', () => {
    setup();
    const out = run(item('entry', { amount: 150, category: 'Ghosts', wallet: 'GCash' }));
    assert.deepEqual([out.created.length, out.review.length, S.inboxItem(out.ids[0]).reason], [0, 1, 'unsure']);
  });
  test('the same item twice (relay and Files catch-up) is added once', () => {
    setup();
    const a = item('entry', { amount: 150, category: 'Food', wallet: 'GCash' });
    run(a);
    const again = X.processItems([a, { ...a }]);
    assert.deepEqual([again.created.length, again.duplicates], [0, 2]);
    assert.equal(S.db.txns.length, 1);
  });
  test('test pings prove the shortcut works and add nothing', () => {
    setup();
    const out = run(item('entry', { amount: 1, category: 'Food', wallet: 'GCash', note: 'test' }), item('test', { source: 'keypad' }));
    assert.equal(out.tests.length, 2);
    assert.equal(S.db.txns.length, 0);
    assert.equal(X.testsSince(0).length, 2);
  });
});

describe('inbox: Quick Add – Text', () => {
  test('a confident text is added; an unsure one waits; Accept adds it', () => {
    const { gotyme } = setup();
    const out = run(item('text', { text: 'grab 175 gotyme' }), item('text', { text: 'something 150' }));
    assert.equal(out.created.length, 1);
    assert.deepEqual([S.txn(out.created[0]).categoryId, S.txn(out.created[0]).accountId], [cat('Transport').id, gotyme.id]);
    const waiting = X.pending();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].reason, 'unsure');
    const t = X.accept(waiting[0].id, { categoryId: cat('Other').id });
    assert.equal(t.amount, 150);
    assert.equal(X.reviewCount(), 0);
  });
  test('"lent mel 500" creates money owed to you', () => {
    const { gcash } = setup();
    run(item('text', { text: 'lent mel 500' }));
    assert.equal(S.findReceivable('Mel').balance, 500);
    assert.equal(S.accountBalance(gcash.id), 4500);
  });
  test('"utang kay mel 500" asks; you choose lent or borrowed', () => {
    const { gcash } = setup();
    run(item('text', { text: 'utang kay mel 500' }));
    const [it] = X.pending();
    assert.equal(it.reason, 'lending');
    assert.throws(() => X.accept(it.id), (e) => e instanceof S.ValidationError);
    X.accept(it.id, { as: 'borrowed' });
    const debt = S.db.debts.find((d) => d.type === 'person' && d.name === 'Mel');
    assert.equal(debt.balance, 500);
    assert.equal(S.accountBalance(gcash.id), 5500, 'the borrowed money is in the wallet');
    assert.equal(S.monthSummary('2026-10').income, 0, 'not income');
  });
  test('"received 500 from mel" while Mel owes you asks whether it is the repayment', () => {
    const { gcash } = setup();
    S.lend({ name: 'Mel', amount: 500, accountId: gcash.id });
    const out = run(item('text', { text: 'received 500 from mel' }));
    assert.equal(out.created.length, 0, 'not added as income on its own');
    const [it] = X.pending();
    assert.deepEqual([it.reason, it.parsed.kind, it.parsed.person], ['repayment', 'collect', 'Mel']);
    X.accept(it.id);
    assert.equal(S.findReceivable('Mel').balance, 0);
    assert.equal(S.monthSummary('2026-10').income, 0);
    // From someone who owes you nothing, it is income as before.
    run(item('text', { text: 'received 300 from joy' }));
    assert.equal(S.monthSummary('2026-10').income, 300);
  });
});

describe('inbox: alerts and duplicates', () => {
  test('₱289 Jollibee logged by hand, then the GCash SMS: linked, not counted twice', () => {
    const { gcash } = setup();
    setToday('2026-10-13', 12, 30);
    const manual = S.saveTxn({ kind: 'expense', amount: 289, categoryId: cat('Food').id, accountId: gcash.id, date: '2026-10-13', note: 'Jollibee' });
    setToday('2026-10-13', 12, 45);
    const out = run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref No. 9876543210123. Your new balance is PHP 4,711.00.'));
    assert.deepEqual([out.created.length, out.confirmed.length], [0, 1]);
    assert.equal(S.db.txns.length, 1);
    const t = S.txn(manual.id);
    assert.deepEqual(t.conf.map((c) => [c.via, c.inst, c.ref]), [['sms', 'GCash', '9876543210123']]);
    assert.equal(t.merchant, 'JOLLIBEE FOODS CORP');
    assert.equal(S.accountBalance(gcash.id), 4711);
    assert.equal(S.account(gcash.id).checked.ok, true, 'the balance in the SMS matches');
    setToday('2026-10-13');
  });
  test('the SMS first, then the keypad entry: linked, and your category wins', () => {
    const { gcash } = setup();
    const a = run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref No. 9876543210123.'));
    assert.equal(a.created.length, 1);
    const fun = cat('Fun');
    const b = run(item('entry', { amount: 289, category: 'Fun', wallet: 'GCash' }, at('2026-10-13', 12, 43)));
    assert.deepEqual([b.created.length, b.confirmed.length], [0, 1]);
    assert.equal(S.db.txns.length, 1);
    assert.equal(S.db.txns[0].categoryId, fun.id);
    assert.equal(S.accountBalance(gcash.id), 4711);
  });
  test('the same purchase by SMS and by email merges into one entry (by reference)', () => {
    setup();
    run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref No. 9876543210123.'));
    const e = run(item('email', { from: 'GCash <no-reply@gcash.com>', subject: 'Payment', body: 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP. Ref No. 9876543210123.' }, at('2026-10-13', 18)));
    assert.equal(e.confirmed.length, 1);
    assert.equal(S.db.txns.length, 1);
    assert.deepEqual(S.db.txns[0].conf.map((c) => c.via), ['sms', 'email']);
  });
  test('two real purchases of the same amount stay two', () => {
    setup();
    run(sms('GCash', 'You have paid PHP 50.00 to KUYA ISAW on 10-13-2026. Ref No. 1111111111111.'));
    run(sms('GCash', 'You have paid PHP 50.00 to KUYA ISAW on 10-13-2026. Ref No. 2222222222222.', at('2026-10-13', 12, 50)));
    assert.equal(S.db.txns.length, 2);
  });
  test('a credit card SMS mapped by card ending adds to that card', () => {
    const { card } = setup();
    S.saveCardMap({ last4: '1234', cardId: card.id });
    run(sms('BPI', 'BPI: Your credit card ending 1234 was used for PHP 289.00 at JOLLIBEE QC on 10/13/26 12:41.'));
    assert.equal(S.debt(card.id).balance, 289);
  });
  test('an alert nobody can read waits as "unparsed"; teaching the format reads it and the next ones', () => {
    const { gotyme } = setup();
    const text = 'GoTyme Bank: Spent P120.00 @ MINISTOP BGC 13Oct 12:41. Bal P1,880.00';
    const out = run(sms('GoTyme', text));
    const [it] = X.pending();
    assert.equal(it.reason, 'unsure', 'only a generic guess, so it waits');
    assert.equal(it.parsed.parser, 'generic');
    assert.equal(out.created.length, 0);
    const span = (s) => { const i = text.indexOf(s); return [i, i + s.length]; };
    const format = A.buildTemplate(text, { amount: span('120.00'), merchant: span('MINISTOP BGC'), balance: span('1,880.00') });
    S.saveTemplate({ sender: A.normSender(it), format, kind: 'expense', accountId: gotyme.id });
    const again = X.reparse([it.id]);
    assert.equal(again.created.length, 1);
    assert.equal(S.txn(again.created[0]).merchant, 'MINISTOP BGC');
    const next = run(sms('GoTyme', 'GoTyme Bank: Spent P75.50 @ 7-ELEVEN UPTOWN 14Oct 09:02. Bal P1,804.50', at('2026-10-14', 9, 2)));
    assert.equal(next.created.length, 1);
    assert.equal(S.template(S.db.templates[0].id).hits, 2);
  });
});

describe('inbox: transfers between your own wallets are not spending', () => {
  const sent = 'You have sent PHP 1,000.00 of GCash to GOTYME BANK on 10-13-2026 01:05 PM. Ref. No. 2233445566778.';
  const got = { from: 'GoTyme <no-reply@gotyme.com.ph>', subject: 'Money in', body: 'You received PHP 1,000.00 from JUAN DELA CRUZ on 13 Oct 2026.' };
  test('GCash "sent to GoTyme" alone is a question; with GoTyme "received" it becomes one transfer', () => {
    const { gcash, gotyme } = setup();
    const a = run(sms('GCash', sent, at('2026-10-13', 13, 5)));
    assert.equal(a.review.length, 1);
    assert.equal(S.inboxItem(a.review[0]).reason, 'transfer');
    const b = run(item('email', got, at('2026-10-13', 13, 6)));
    assert.equal(b.created.length, 1);
    assert.equal(X.reviewCount(), 0);
    assert.equal(S.db.txns.length, 1);
    const t = S.db.txns[0];
    assert.deepEqual([t.kind, t.accountId, t.toAccountId, t.conf.length], ['transfer', gcash.id, gotyme.id, 2]);
    assert.equal(S.monthSummary('2026-10').spent, 0);
    assert.equal(S.monthSummary('2026-10').income, 0);
    assert.deepEqual([S.accountBalance(gcash.id), S.accountBalance(gotyme.id)], [4000, 3000]);
  });
  test('the other order: GoTyme income first, then the GCash send turns it into the transfer', () => {
    const { gcash, gotyme } = setup();
    run(item('email', got, at('2026-10-13', 13, 6)));
    assert.equal(S.db.txns[0].kind, 'income');
    run(sms('GCash', sent, at('2026-10-13', 13, 5)));
    assert.equal(S.db.txns.length, 1);
    assert.deepEqual([S.db.txns[0].kind, S.db.txns[0].accountId, S.db.txns[0].toAccountId], ['transfer', gcash.id, gotyme.id]);
    assert.equal(S.monthSummary('2026-10').income, 0);
  });
  test('"Mark as transfer" in Review for money sent to a person you named as your other wallet', () => {
    const { gcash, gotyme } = setup();
    run(sms('GCash', 'You have sent PHP 700.00 of GCash to JUAN DELA CRUZ 09171234567 on 10-13-2026. Ref. No. 5555555555555.'));
    const [it] = X.pending();
    assert.equal(it.reason, 'sent');
    X.markTransfer(it.id, gotyme.id);
    const t = S.db.txns[0];
    assert.deepEqual([t.kind, t.accountId, t.toAccountId], ['transfer', gcash.id, gotyme.id]);
  });
});

describe('inbox: balances', () => {
  test('"new balance" that disagrees becomes a balance drift question; Accept fixes the wallet', () => {
    const { gcash } = setup();
    run(sms('GCash', 'You have paid PHP 100.00 to KUYA ISAW on 10-13-2026. Ref No. 3333333333333. Your new balance is PHP 4,850.00.'));
    assert.equal(S.accountBalance(gcash.id), 4900);
    const drift = X.pending().find((x) => x.type === 'drift');
    assert.deepEqual([drift.drift.reported, drift.drift.computed], [4850, 4900]);
    const fix = X.accept(drift.id);
    assert.deepEqual([fix.kind, fix.accountId, fix.direction, fix.amount], ['adjust', gcash.id, 'down', 50]);
    assert.equal(S.accountBalance(gcash.id), 4850);
  });
  test('Update Balance: a match is noted, a difference proposes a Balance fix', () => {
    const { gcash, gotyme } = setup();
    run(item('balance', { wallet: 'GCash', amount: '5000' }));
    assert.equal(X.reviewCount(), 0);
    assert.equal(S.account(gcash.id).checked.ok, true);
    run(item('balance', { wallet: 'GoTyme', amount: '1,950.25' }));
    const [it] = X.pending();
    assert.equal(it.reason, 'drift');
    X.accept(it.id);
    assert.equal(S.accountBalance(gotyme.id), 1950.25);
  });
  test('an alert from before the wallet\'s starting balance is not a balance drift', () => {
    const { gcash } = setup();
    S.saveAccount({ id: gcash.id, opening: 4000, openingDate: '2026-10-13' }); // set up today, with today's balance
    // Last week's alert arrives late (the Files catch-up): its balance is already in the starting one.
    run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE on 10-08-2026. Ref No. 4444444444444. Your new balance is PHP 4,711.00.', at('2026-10-08', 10)));
    assert.equal(X.reviewCount(), 0, 'no drift question, so no Balance fix that could not change anything');
    assert.equal(S.accountBalance(gcash.id), 4000);
    assert.equal(S.account(gcash.id).checked, undefined);
    // Today's alerts are still checked.
    run(sms('GCash', 'You have paid PHP 100.00 to KUYA ISAW on 10-13-2026. Ref No. 5555555555555. Your new balance is PHP 3,850.00.'));
    assert.deepEqual(X.pending().map((x) => [x.type, x.drift?.reported, x.drift?.computed]), [['drift', 3850, 3900]]);
  });
  test('entries logged after the balance check still count when fixing', () => {
    const { gcash } = setup();
    run(item('balance', { wallet: 'GCash', amount: '4,900' }, at('2026-10-13', 9)));
    S.saveTxn({ kind: 'expense', amount: 200, accountId: gcash.id, date: '2026-10-13', categoryId: cat('Food').id, at: at('2026-10-13', 11) });
    X.accept(X.pending()[0].id);
    assert.equal(S.accountBalance(gcash.id), 4700);
  });
});

describe('inbox: undo, ignore, many at once, atomic saves', () => {
  test('undoing a pull removes what it added and puts the items back in Review', () => {
    const { gcash } = setup();
    const out = run(item('text', { text: 'grab 175 gcash' }), item('entry', { amount: 99, category: 'Load & Internet', wallet: 'GCash' }));
    assert.equal(S.db.txns.length, 2);
    X.undoBatch(out.batch);
    assert.equal(S.db.txns.length, 0);
    assert.equal(S.accountBalance(gcash.id), 5000);
    assert.deepEqual(X.pending().map((x) => x.reason), ['undone', 'undone']);
  });
  test('undoing a link takes the confirmation off again', () => {
    const { gcash } = setup();
    setToday('2026-10-13', 12, 30);
    const m = S.saveTxn({ kind: 'expense', amount: 289, categoryId: cat('Food').id, accountId: gcash.id, date: '2026-10-13', note: 'Jollibee' });
    setToday('2026-10-13', 12, 45);
    const out = run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref No. 9876543210123.'));
    X.undoItem(out.ids[0]);
    assert.equal(S.txn(m.id).conf, undefined);
    assert.equal(S.txn(m.id).merchant, undefined);
    setToday('2026-10-13');
  });
  test('accept or ignore several at once', () => {
    setup();
    run(item('text', { text: 'something 150' }), item('text', { text: 'thingamajig 75' }), item('text', { text: 'mystery 10' }));
    const ids = X.pending().map((x) => x.id);
    X.ignore(ids.slice(0, 1));
    const r = X.acceptMany(ids.slice(1));
    assert.deepEqual([r.ok, r.failed.length], [2, 0]);
    assert.equal(X.reviewCount(), 0);
    assert.equal(S.inboxItem(ids[0]).status, 'ignored');
  });
  test('a pull is all-or-nothing: a failed save leaves nothing behind', async () => {
    setup(); await S.flush();
    const restore = store.failWith('QuotaExceededError');
    run(item('text', { text: 'grab 175 gcash' }), sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE on 10-13-2026. Ref No. 4444444444444.'));
    await assert.rejects(S.flush());
    restore();
    assert.equal(S.db.txns.length, 0);
    assert.equal(S.db.inbox.length, 0);
  });
});

describe('inbox: keeping raw text', () => {
  test('alert text older than the setting is trimmed to what was read from it; pending items keep theirs', () => {
    setup();
    run(sms('GCash', 'You have paid PHP 289.00 to JOLLIBEE on 10-13-2026. Ref No. 4444444444444.'), sms('Unknown', 'Hello PHP 5.00', at('2026-10-13', 13)));
    const later = Date.now() + 91 * 86400000;
    assert.equal(S.trimRaw(90, later), 1);
    const done = S.db.inbox.find((x) => x.status === 'auto');
    assert.deepEqual([done.raw.text, done.trimmed, done.parsed.merchant], [undefined, true, 'JOLLIBEE']);
    assert.ok(S.db.inbox.find((x) => x.status === 'pending').raw.text);
    assert.equal(S.trimRaw(0, later), 0, '0 = keep forever');
  });
});
