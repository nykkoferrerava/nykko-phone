// Quick Add – Text parser: amounts, categories (names, keywords, synonyms), wallets and cards, income,
// lending, notes, and when it must NOT guess.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP, S, fresh, cat } from './env.mjs';

const Q = await import(`${APP}/js/quickparse.js`);

function setup() {
  fresh();
  const gcash = S.saveAccount({ name: 'GCash', kind: 'ewallet' });
  const gotyme = S.saveAccount({ name: 'GoTyme', kind: 'bank' });
  const bpi = S.saveAccount({ name: 'BPI Savings', kind: 'bank' });
  const card = S.saveDebt({ type: 'card', name: 'BPI Gold', lender: 'BPI', balance: 0, paymentAmount: 0 });
  const ctx = () => ({ categories: S.db.categories, accounts: S.db.accounts, cards: S.db.debts.filter((d) => d.type === 'card'), defaultAccountId: S.defaultAccountId() });
  return { gcash, gotyme, bpi, card, cash: S.db.accounts[0], ctx };
}
const pick = (r) => ({ kind: r.kind, amount: r.amount, cat: S.db.categories.find((c) => c.id === r.categoryId)?.name ?? null, wallet: S.account(r.accountId)?.name ?? null, card: S.debt(r.cardId)?.name ?? null, note: r.note, confidence: r.confidence });

describe('quickparse: amounts', () => {
  test('finds the amount wherever it is, in every common way of writing it', () => {
    const v = (s) => Q.findAmounts(s).map((a) => a.value);
    assert.deepEqual(v('150 lunch'), [150]);
    assert.deepEqual(v('lunch 150'), [150]);
    assert.deepEqual(v('₱1,200 groceries'), [1200]);
    assert.deepEqual(v('₱ 1,200.50'), [1200.5]);
    assert.deepEqual(v('shopee 1.2k'), [1200]);
    assert.deepEqual(v('2k padala'), [2000]);
    assert.deepEqual(v('php 500 gas'), [500]);
    assert.deepEqual(v('PHP500'), [500]);
    assert.deepEqual(v('p250 kape'), [250]);
    assert.deepEqual(v('500php'), [500]);
    assert.deepEqual(v('500 pesos'), [500]);
  });
  test('phone numbers, references, dates and words with digits are not amounts', () => {
    const v = (s) => Q.findAmounts(s).map((a) => a.value);
    assert.deepEqual(v('globe 09171234567 99'), [99]);
    assert.deepEqual(v('7-eleven 85'), [85]);
    assert.deepEqual(v('13th month 15000'), [15000]);
    assert.deepEqual(v('ref 123456789012 500'), [500]);
    assert.deepEqual(v('10/18 lunch 150'), [150]);
  });
  test('a mistyped thousands comma is not read as a smaller amount', () => {
    const v = (s) => Q.findAmounts(s).map((a) => a.value);
    assert.deepEqual(v('12,00 lunch'), [], '"12,00" is not ₱12');
    assert.deepEqual(v('lunch 1,20'), []);
    assert.deepEqual(v('1,2k shopee'), [], '"1,2k" is not ₱2,000');
    assert.deepEqual(v('kape 120, gcash'), [120], 'a comma after the amount is just punctuation');
    assert.deepEqual(v('lunch,150'), [150]);
    assert.deepEqual(v('1,200 lunch'), [1200]);
    const { ctx } = setup();
    const r = Q.parseQuick('12,00 lunch', ctx());
    assert.equal(r.ok, false);
    assert.equal(r.confidence, 'low');
  });
});

describe('quickparse: the examples', () => {
  test('150 lunch gcash', () => {
    const { ctx } = setup();
    assert.deepEqual(pick(Q.parseQuick('150 lunch gcash', ctx())), { kind: 'expense', amount: 150, cat: 'Food', wallet: 'GCash', card: null, note: 'Lunch', confidence: 'high' });
  });
  test('jollibee 289 (default wallet, merchant kept)', () => {
    const { ctx } = setup();
    const r = Q.parseQuick('jollibee 289', ctx());
    assert.deepEqual(pick(r), { kind: 'expense', amount: 289, cat: 'Food', wallet: 'Cash', card: null, note: 'Jollibee', confidence: 'high' });
    assert.equal(r.merchant, 'Jollibee');
  });
  test('grab 175 gotyme', () => {
    const { ctx } = setup();
    assert.deepEqual(pick(Q.parseQuick('grab 175 gotyme', ctx())), { kind: 'expense', amount: 175, cat: 'Transport', wallet: 'GoTyme', card: null, note: 'Grab', confidence: 'high' });
  });
  test('₱1,200 groceries bpi card -> the BPI credit card', () => {
    const { ctx } = setup();
    assert.deepEqual(pick(Q.parseQuick('₱1,200 groceries bpi card', ctx())), { kind: 'expense', amount: 1200, cat: 'Groceries', wallet: null, card: 'BPI Gold', note: 'Groceries', confidence: 'high' });
  });
  test('a full stop at the end (iOS adds one after a double space) still finds the wallet and category', () => {
    const { ctx } = setup();
    const r = pick(Q.parseQuick('kape 120 gcash.', ctx()));
    assert.deepEqual([r.amount, r.cat, r.wallet, r.confidence], [120, 'Food', 'GCash', 'high']);
    assert.equal(pick(Q.parseQuick('sahod 25,000 bpi.', ctx())).wallet, 'BPI Savings');
    assert.equal(pick(Q.parseQuick('150 lunch.', ctx())).cat, 'Food');
    assert.equal(pick(Q.parseQuick('7-eleven 85', ctx())).cat, 'Groceries', 'a hyphen inside a word stays');
  });
  test('"bpi" alone is the BPI wallet, not the card', () => {
    const { ctx } = setup();
    assert.equal(pick(Q.parseQuick('sm 3500 bpi', ctx())).wallet, 'BPI Savings');
  });
  test('utang kay mel 500 asks: lent or borrowed?', () => {
    const { ctx } = setup();
    const r = Q.parseQuick('utang kay mel 500', ctx());
    assert.deepEqual([r.kind, r.amount, r.person, r.confidence], ['utang', 500, 'Mel', 'low']);
  });
  test('lent / pautang create money owed to you', () => {
    const { ctx } = setup();
    const a = Q.parseQuick('lent mel 500', ctx());
    assert.deepEqual([a.kind, a.amount, a.person, a.confidence], ['lend', 500, 'Mel', 'high']);
    const b = Q.parseQuick('pautang kay ate joy 1.5k gcash', ctx());
    assert.deepEqual([b.kind, b.amount, b.person, S.account(b.accountId).name, b.confidence], ['lend', 1500, 'Ate Joy', 'GCash', 'high']);
  });
  test('borrowed is a question too', () => {
    const { ctx } = setup();
    const r = Q.parseQuick('borrowed 1000 from kuya ben', ctx());
    assert.deepEqual([r.kind, r.person, r.confidence], ['borrow', 'Kuya Ben', 'low']);
  });
  test('income words: sahod, salary, received', () => {
    const { ctx } = setup();
    assert.deepEqual(pick(Q.parseQuick('sahod 25,000 bpi', ctx())), { kind: 'income', amount: 25000, cat: null, wallet: 'BPI Savings', card: null, note: '', confidence: 'high' });
    assert.equal(Q.parseQuick('received 500 gcash', ctx()).kind, 'income');
    assert.equal(Q.parseQuick('salary 30k', ctx()).amount, 30000);
  });
  test('synonyms for the Philippine defaults', () => {
    const { ctx } = setup();
    const c = (s) => pick(Q.parseQuick(s, ctx())).cat;
    assert.equal(c('meralco 3,200.50'), 'Bills & Utilities');
    assert.equal(c('load 99 globe'), 'Load & Internet');
    assert.equal(c('smart 50'), 'Load & Internet');
    assert.equal(c('shopee 1.2k'), 'Shopping');
    assert.equal(c('lazada 899'), 'Shopping');
    assert.equal(c('angkas 120'), 'Transport');
    assert.equal(c('jeep 13'), 'Transport');
    assert.equal(c('mcdo 199'), 'Food');
    assert.equal(c('padala nanay 2k'), 'Family');
    assert.equal(c('netflix 549 bpi card'), 'Subscriptions');
    assert.equal(c('mercury drug 340'), 'Health');
    assert.equal(c('7-eleven 85'), 'Groceries');
  });
});

describe('quickparse: your categories', () => {
  test('a renamed default keeps its synonyms; your keywords and names win', () => {
    const { ctx } = setup();
    S.saveCategory({ id: cat('Food').id, name: 'Kain', emoji: '🍚' });
    assert.equal(pick(Q.parseQuick('jollibee 289', ctx())).cat, 'Kain');
    const pets = S.saveCategory({ name: 'Pets', emoji: '🐶', keywords: 'vet, pet food' });
    assert.equal(pick(Q.parseQuick('vet 1500', ctx())).cat, 'Pets');
    assert.equal(pick(Q.parseQuick('pet food 300', ctx())).cat, 'Pets');
    assert.equal(pick(Q.parseQuick('pets 300', ctx())).cat, 'Pets');
    assert.ok(pets.id);
  });
  test('hidden categories are not picked', () => {
    const { ctx } = setup();
    const fun = cat('Fun');
    S.saveCategory({ id: fun.id, name: 'Fun', emoji: '🎉', hidden: true });
    const r = Q.parseQuick('movie 300', ctx());
    assert.equal(r.categoryId, null);
    assert.equal(r.confidence, 'low');
  });
});

describe('quickparse: when not sure, it says so', () => {
  test('no amount, two amounts, no category, two wallets', () => {
    const { ctx } = setup();
    const none = Q.parseQuick('lunch with mel', ctx());
    assert.equal(none.ok, false); assert.ok(none.reasons.includes('no amount'));
    const two = Q.parseQuick('2 burgers 300', ctx());
    assert.equal(two.amount, 300); assert.equal(two.confidence, 'low'); assert.ok(two.reasons.includes('several amounts'));
    const marked = Q.parseQuick('2 burgers ₱300', ctx());
    assert.equal(marked.amount, 300); assert.equal(marked.confidence, 'high', 'the ₱ makes it clear');
    const nocat = Q.parseQuick('something 150', ctx());
    assert.equal(nocat.confidence, 'low'); assert.ok(nocat.reasons.includes('no category'));
    const wallets = Q.parseQuick('150 lunch gcash gotyme', ctx());
    assert.equal(wallets.confidence, 'low'); assert.ok(wallets.reasons.includes('two wallets'));
    assert.equal(Q.parseQuick('', ctx()).ok, false);
  });
});
