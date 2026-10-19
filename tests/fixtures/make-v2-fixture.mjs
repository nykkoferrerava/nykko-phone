// Regenerates tests/fixtures/v2-data.json with the real v2 store.js:
//   mkdir /tmp/v2 && git archive b8ac339 | tar -x -C /tmp/v2
//   node tests/fixtures/make-v2-fixture.mjs /tmp/v2 > tests/fixtures/v2-data.json
import { mock } from 'node:test';
class MemStorage { constructor(){this.m=new Map()} getItem(k){return this.m.has(k)?this.m.get(k):null} setItem(k,v){this.m.set(k,String(v))} removeItem(k){this.m.delete(k)} clear(){this.m.clear()} get length(){return this.m.size} key(i){return [...this.m.keys()][i]??null} }
globalThis.localStorage = new MemStorage();
mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 13, 12).getTime() });
const S = await import(process.argv[2] + '/js/store.js');
S.load();
S.updateSettings({ onboarded: true, payAnchor: '2026-10-09', payAmount: 25000, pinHash: 'deadbeef', pinSalt: '12345', theme: 'dark' });
const cash = S.defaultAccountId();
const gcash = S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 3200, openingDate: '2026-10-01' });
const bpi = S.saveAccount({ name: 'BPI Savings', kind: 'bank', opening: 15000, openingDate: '2026-10-01' });
const [food, groc, transport, bills] = S.db.categories;
S.saveCategory({ id: food.id, name: food.name, emoji: food.emoji, limit: 3000 });
const card = S.saveDebt({ type: 'card', name: 'BPI Gold', lender: 'BPI', balance: 23450.75, paymentAmount: 850, plannedPayment: 3000, creditLimit: 80000, rate: 3, nextDue: '2026-10-25', notes: '' });
const loan = S.saveDebt({ type: 'loan', name: 'Home Credit phone', lender: 'Home Credit', paymentAmount: 2000, frequency: 'monthly', totalPayments: 12, paymentsMade: 5, balance: 14000, nextDue: '2026-10-31', rate: 0, notes: '' });
const lend = S.saveDebt({ type: 'lending', name: 'JuanHand', lender: '', paymentAmount: 500, frequency: 'semimonthly', dueDays: [5, 20], totalPayments: 6, paymentsMade: 1, balance: 2500, nextDue: '2026-10-20', rate: 0, notes: '' });
const tita = S.saveDebt({ type: 'person', name: 'Tita Mel', lender: '', balance: 5000, plannedPayment: 1000, paymentAmount: 0, nextDue: null, rate: 0, notes: 'for the hospital' });
const rent = S.saveBill({ name: 'Rent', amount: 8000, frequency: 'monthly', nextDue: '2026-10-31', categoryId: bills.id, done: false });
const net = S.saveBill({ name: 'Netflix', amount: 549, frequency: 'monthly', nextDue: '2026-10-18', categoryId: S.db.categories[10].id, done: false });
const japan = S.saveGoal({ name: 'Japan trip', emoji: '✈️', target: 60000, deadline: '2027-04-01', saved: 5000 });
const add = (o) => S.saveTxn({ date: '2026-10-13', note: '', ...o });
add({ kind: 'income', amount: 25000, note: 'Salary', accountId: bpi.id, date: '2026-10-09' });
add({ kind: 'transfer', accountId: bpi.id, toAccountId: gcash.id, amount: 3000, note: 'Cash-in', date: '2026-10-09' });
add({ kind: 'expense', amount: 289, categoryId: food.id, accountId: gcash.id, note: 'Jollibee', date: '2026-10-10' });
add({ kind: 'expense', amount: 1840.5, categoryId: groc.id, cardId: card.id, note: 'SM Supermarket', date: '2026-10-11' });
add({ kind: 'expense', amount: 175, categoryId: transport.id, accountId: cash, note: 'Grab', date: '2026-10-12' });
add({ kind: 'debt', debtId: loan.id, amount: 2000, installments: 1, accountId: bpi.id, date: '2026-10-12' });
add({ kind: 'debt', debtId: tita.id, amount: 1000, installments: 0, accountId: cash, date: '2026-10-12' });
add({ kind: 'goal', goalId: japan.id, amount: 2000, accountId: bpi.id, date: '2026-10-12' });
add({ kind: 'goal', goalId: japan.id, amount: 500, withdraw: true, accountId: bpi.id, date: '2026-10-13' });
add({ kind: 'adjust', debtId: card.id, direction: 'up', reason: 'interest', amount: 702.4, date: '2026-10-13' });
add({ kind: 'expense', amount: 549, categoryId: S.db.categories[10].id, billId: net.id, accountId: gcash.id, note: 'Netflix', date: '2026-10-13' });
S.markBackedUp();
process.stdout.write(localStorage.getItem('pitaka.data'));
