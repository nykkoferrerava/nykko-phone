// Categories (rename, hide, reorder, merge), wallet balance fixes, one-tap bills, pay-period reports,
// budget warnings and subscription suggestions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { S, I, fresh, cat, setToday } from './env-insights.mjs';

const spend = (amount, o = {}) => S.saveTxn({ kind: 'expense', categoryId: cat('Food').id, amount, date: '2026-10-13', note: '', ...o });
const throwsField = (fn, field) => assert.throws(fn, (e) => e instanceof S.ValidationError && (!field || e.field === field));

describe('categories', () => {
  test('defaults carry a built-in key that survives renaming', async () => {
    fresh();
    assert.deepEqual(S.db.categories.map((c) => c.key), S.CATEGORY_KEYS);
    const food = cat('Food');
    S.saveCategory({ id: food.id, name: 'Kain', emoji: '🍚' });
    assert.equal(S.db.categories[0].key, 'food');
    assert.equal(S.db.categories[0].name, 'Kain');
    await S.load();
    assert.equal(S.db.categories[0].key, 'food');
  });
  test('v2 categories get their key back by name; a custom one stays without', async () => {
    fresh();
    await S.replaceAll({ txns: [], categories: [{ id: 'a', name: 'transport', emoji: '🚕', limit: 0 }, { id: 'b', name: 'Pets', emoji: '🐶', limit: 0 }, { id: 'c', name: 'Transport', emoji: '🚌', limit: 0 }] });
    assert.deepEqual(S.db.categories.map((c) => c.key), ['transport', undefined, undefined]);
  });
  test('hide, keywords and reorder', () => {
    fresh();
    const pets = S.saveCategory({ name: 'Pets', emoji: '🐶', keywords: 'Vet, Pet food;  vet ,grooming' });
    assert.equal(pets.keywords, 'vet, pet food, grooming');
    S.saveCategory({ id: pets.id, name: 'Pets', emoji: '🐶', hidden: true });
    assert.equal(S.visibleCategories().some((c) => c.id === pets.id), false);
    S.saveCategory({ id: pets.id, name: 'Pets', emoji: '🐶', hidden: false });
    assert.equal(S.visibleCategories().some((c) => c.id === pets.id), true);
    const ids = S.db.categories.map((c) => c.id);
    assert.equal(S.moveCategory(ids[2], -1), true);
    assert.deepEqual(S.db.categories.slice(0, 3).map((c) => c.id), [ids[0], ids[2], ids[1]]);
    assert.equal(S.moveCategory(ids[0], -1), false, 'already first');
  });
  test('merge moves entries and bills, joins keywords, keeps a limit, removes the old one', async () => {
    fresh();
    const coffee = S.saveCategory({ name: 'Coffee', emoji: '☕', limit: 1500, keywords: 'starbucks' });
    const food = cat('Food');
    const a = spend(150, { categoryId: coffee.id }); const b = spend(200);
    const bl = S.saveBill({ name: 'Beans', amount: 500, nextDue: '2026-10-30', categoryId: coffee.id });
    S.updateSettings({ lastCategoryId: coffee.id });
    assert.equal(S.mergeCategory(coffee.id, food.id), 1);
    assert.equal(S.db.txns.find((t) => t.id === a.id).categoryId, food.id);
    assert.equal(S.db.txns.find((t) => t.id === b.id).categoryId, food.id);
    assert.equal(S.bill(bl.id).categoryId, food.id);
    assert.equal(food.limit, 1500);
    assert.equal(food.keywords, 'starbucks, coffee');
    assert.equal(S.db.categories.some((c) => c.id === coffee.id), false);
    assert.equal(S.db.settings.lastCategoryId, food.id);
    throwsField(() => S.mergeCategory(food.id, food.id), 'intoId');
    throwsField(() => S.mergeCategory('nope', food.id), 'intoId');
    await S.flush();
  });
  test('merging two built-in categories keeps both sets of synonyms and adds the budgets together', async () => {
    fresh();
    const food = cat('Food'), groc = cat('Groceries');
    S.saveCategory({ id: food.id, name: 'Food', emoji: food.emoji, limit: 3000 });
    S.saveCategory({ id: groc.id, name: 'Groceries', emoji: groc.emoji, limit: 2000 });
    S.mergeCategory(groc.id, food.id);
    const f = cat('Food');
    assert.equal(f.limit, 5000);
    const { parseQuick } = await import('../js/quickparse.js');
    const ctx = { categories: S.db.categories, accounts: S.db.accounts, cards: [], defaultAccountId: S.defaultAccountId() };
    assert.equal(parseQuick('puregold 500', ctx).categoryId, f.id, 'a Groceries synonym');
    assert.equal(parseQuick('jollibee 289', ctx).categoryId, f.id, 'a Food synonym');
    // Restored from a backup, the merged category still has both.
    await S.replaceAll(JSON.parse(S.exportBackup()));
    assert.deepEqual(cat('Food').also, ['groceries']);
    assert.equal(parseQuick('puregold 500', { ...ctx, categories: S.db.categories }).categoryId, f.id);
  });
  test('merged keywords are kept whole when they run past the limit', () => {
    fresh();
    const words = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}x`).join(', ');
    const a = S.saveCategory({ name: 'Aa', emoji: '🅰️', keywords: words('alpha', 12) });
    const b = S.saveCategory({ name: 'Bb', emoji: '🅱️', keywords: words('bravo', 12) });
    S.mergeCategory(b.id, a.id);
    const kw = S.db.categories.find((c) => c.id === a.id).keywords.split(', ');
    assert.ok(kw.join(', ').length <= 200);
    for (const k of kw) assert.match(k, /^(alpha|bravo)\d+x$|^bb$/, `no cut-off keyword: ${k}`);
  });
});

describe('wallet balance fixes', () => {
  test('a fix is a visible, undoable correction that lands exactly on the target', () => {
    fresh();
    const g = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 1000, openingDate: '2026-10-01' });
    spend(289, { accountId: g.id });
    const t = S.fixWalletBalance(g.id, '1,234.50');
    assert.equal(S.accountBalance(g.id), 1234.5);
    assert.deepEqual({ kind: t.kind, accountId: t.accountId, direction: t.direction, reason: t.reason, amount: t.amount }, { kind: 'adjust', accountId: g.id, direction: 'up', reason: 'correction', amount: 523.5 });
    assert.equal(S.fixWalletBalance(g.id, 1234.5), null, 'already right');
    const m = S.monthSummary('2026-10');
    assert.equal(m.income, 0); assert.equal(m.fees, 0);
    S.deleteTxn(t.id);
    assert.equal(S.accountBalance(g.id), 711);
    throwsField(() => S.fixWalletBalance(g.id, 'abc'), 'balance');
    throwsField(() => S.fixWalletBalance('nope', 5), 'accountId');
  });
  test('balanceAt reads the wallet at a moment of the day', () => {
    fresh();
    const g = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 1000, openingDate: '2026-10-01' });
    const at = (h) => new Date(2026, 9, 13, h).getTime();
    spend(100, { accountId: g.id, at: at(9) }); spend(50, { accountId: g.id, at: at(15) });
    assert.equal(S.balanceAt(g.id, at(12)), 900);
    assert.equal(S.balanceAt(g.id, at(16)), 850);
  });
  test('an entry added today for an earlier day has no known time, and counts in that whole day', () => {
    fresh();
    const g = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 1000, openingDate: '2026-10-01' });
    spend(200, { accountId: g.id, date: '2026-10-12' }); // saved on the 13th
    assert.equal(S.balanceAt(g.id, new Date(2026, 9, 12, 8).getTime()), 800);
    assert.equal(S.balanceAt(g.id, new Date(2026, 9, 11, 23).getTime()), 1000);
  });
});

describe('bills and reports', () => {
  test('payBill records the usual amount and moves the bill to its next date', () => {
    fresh();
    const b = S.saveBill({ name: 'Meralco', amount: 3200, nextDue: '2026-10-20', categoryId: cat('Bills & Utilities').id });
    const t = S.payBill(b.id);
    assert.equal(t.amount, 3200); assert.equal(t.note, 'Meralco'); assert.equal(t.categoryId, b.categoryId);
    assert.equal(S.bill(b.id).nextDue, '2026-11-20');
    S.deleteTxn(t.id);
    assert.equal(S.bill(b.id).nextDue, '2026-10-20');
    throwsField(() => S.payBill('nope'), 'billId');
  });
  test('pay-period summary: income, spending, saved, debt paid, top categories and merchants', () => {
    fresh();
    const g = S.saveGoal({ name: 'Japan', target: 10000 });
    const d = S.saveDebt({ type: 'person', name: 'Tita', balance: 3000, plannedPayment: 1000 });
    S.saveTxn({ kind: 'income', amount: 25000, date: '2026-10-09', note: 'Salary' });
    spend(289, { note: 'Jollibee', date: '2026-10-10' }); spend(320, { merchant: 'JOLLIBEE', note: 'lunch', date: '2026-10-12' });
    spend(175, { categoryId: cat('Transport').id, note: 'Grab' });
    spend(5000, { categoryId: cat('Groceries').id, note: 'SM', date: '2026-10-08' }); // previous period
    S.saveTxn({ kind: 'goal', goalId: g.id, amount: 2000, date: '2026-10-11' });
    S.saveTxn({ kind: 'debt', debtId: d.id, amount: 1000, installments: 0, date: '2026-10-11' });
    const p = S.periodSummary();
    assert.deepEqual([p.start, p.end, p.next], ['2026-10-09', '2026-10-22', '2026-10-23']);
    assert.deepEqual([p.income, p.spent, p.saved, p.debtPaid], [25000, 784, 2000, 1000]);
    assert.deepEqual(p.byCategory.map((c) => [c.name, c.value]), [['Food', 609], ['Transport', 175]]);
    assert.deepEqual(p.topMerchants, [{ name: 'Jollibee', value: 609, count: 2 }, { name: 'Grab', value: 175, count: 1 }]);
    const prev = S.periodSummary('2026-09-25');
    assert.equal(prev.spent, 5000);
  });
});

describe('insights: budgets', () => {
  test('warning when an entry pushes a category over, or past 80%', () => {
    fresh();
    S.saveCategory({ id: cat('Food').id, name: 'Food', emoji: '🍜', limit: 1000 });
    assert.equal(I.budgetWarning(spend(500)), null);
    const near = I.budgetWarning(spend(350));
    assert.deepEqual([near.kind, near.amount], ['near', 150]);
    const over = I.budgetWarning(spend(270));
    assert.deepEqual([over.kind, over.amount], ['over', 120]);
    assert.equal(I.budgetWarningText(over), 'Food is now ₱120 over budget');
    assert.equal(I.budgetWarning(spend(10)).kind, 'still-over');
    assert.equal(I.budgetWarning(spend(10, { date: '2026-10-01' })), null, 'last pay period');
    assert.equal(I.budgetWarning(spend(10, { categoryId: cat('Fun').id })), null, 'no limit');
    assert.deepEqual(I.budgetsToWatch().map((u) => u.category.name), ['Food']);
  });
});

describe('insights: subscriptions', () => {
  const monthly = (name, amount, dates, o = {}) => dates.map((date) => spend(amount, { note: name, date, categoryId: cat('Subscriptions').id, ...o }));
  test('a known service charged the same amount a month apart is suggested', () => {
    fresh({ today: '2026-10-13' });
    monthly('Netflix', 549, ['2026-08-12', '2026-09-12']);
    monthly('NETFLIX.COM', 549, ['2026-10-12'], { merchant: 'NETFLIX.COM', note: '' });
    const [s] = I.detectSubscriptions();
    assert.deepEqual({ name: s.name, amount: s.amount, frequency: s.frequency, count: s.count, nextDue: s.nextDue }, { name: 'Netflix', amount: 549, frequency: 'monthly', count: 3, nextDue: '2026-11-12' });
  });
  test('unknown merchants need three steady charges; coincidences are not suggested', () => {
    fresh();
    monthly('Jollibee', 289, ['2026-09-12', '2026-10-12']);
    assert.equal(I.detectSubscriptions().length, 0);
    monthly('Barangay gym', 500, ['2026-08-10', '2026-09-10', '2026-10-10']);
    assert.deepEqual(I.detectSubscriptions().map((x) => x.name), ['Barangay gym']);
    monthly('Lunch', 150, ['2026-08-01', '2026-08-20', '2026-10-10']);
    assert.equal(I.detectSubscriptions().length, 1, 'irregular gaps');
  });
  test('weekly, already a bill, dismissed and stopped ones are handled', () => {
    fresh();
    monthly('Grab pass', 99, ['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-13']);
    assert.equal(I.detectSubscriptions()[0].frequency, 'weekly');
    monthly('Spotify', 149, ['2026-09-01', '2026-10-01']);
    S.saveBill({ name: 'Spotify Premium', amount: 149, nextDue: '2026-11-01' });
    assert.deepEqual(I.detectSubscriptions().map((x) => x.name), ['Grab pass']);
    S.db.dismissed.push(`sub:${I.detectSubscriptions()[0].key}`);
    assert.equal(I.detectSubscriptions().length, 0);
    fresh();
    monthly('Disney', 159, ['2026-03-01', '2026-04-01', '2026-05-01']);
    assert.equal(I.detectSubscriptions().length, 0, 'stopped months ago');
    setToday('2026-10-13');
  });
});
