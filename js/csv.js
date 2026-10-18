// CSV export for spreadsheets. DOM-free (runs under Node).
// Cells starting with = + - @ (or a tab / carriage return) are prefixed with ' so Excel, Numbers and
// Google Sheets never run them as formulas (alert text and notes are untrusted). Numbers stay numbers.
import * as S from './store.js';
import { round2, today } from './util.js';
import { DEBT_TYPES } from './store.js';

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(round2(v)) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const raw = String(v);
  let s = raw.replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t\r]/.test(raw)) s = `'${s}`;
  return /[",\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// A UTF-8 byte order mark first, so Excel shows ₱ and accents correctly; CRLF line endings.
export const toCSV = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const KIND_LABEL = { expense: 'Expense', income: 'Income', debt: 'Debt payment', goal: 'Savings', adjust: 'Adjustment', transfer: 'Transfer', lend: 'Lent', collect: 'Paid back to you' };
const REASON = { fee: 'Fee', interest: 'Interest', penalty: 'Penalty', correction: 'Balance fix' };
const wallet = (id) => (id ? S.account(id)?.name || 'Deleted wallet' : '');
const debtName = (t) => S.debt(t.debtId || t.cardId)?.name || t.debtName || '';
// What the entry did to your wallets: money out is negative.
function signed(t) {
  switch (t.kind) {
    case 'income': case 'collect': return t.amount;
    case 'expense': return t.cardId ? 0 : -t.amount;
    case 'debt': case 'lend': return -t.amount;
    case 'goal': return t.withdraw ? t.amount : -t.amount;
    case 'adjust': return t.accountId ? (t.direction === 'up' ? t.amount : -t.amount) : 0;
    default: return 0;
  }
}

// Entries between `from` and `to` (inclusive), optionally only those touching one wallet (or card).
export function transactionRows({ from = '0000-01-01', to = '9999-12-31', accountId = '' } = {}) {
  const head = ['Date', 'Time', 'Type', 'Amount', 'Wallet change', 'Category', 'From', 'To', 'Card / debt', 'Goal', 'Person', 'Merchant', 'Note', 'Detail', 'Source', 'Reference', 'Confirmed by'];
  const rows = S.db.txns
    .filter((t) => t.date >= from && t.date <= to)
    .filter((t) => !accountId || t.accountId === accountId || t.toAccountId === accountId || t.cardId === accountId)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.at || a.createdAt || 0) - (b.at || b.createdAt || 0))
    .map((t) => {
      const time = t.at ? new Date(t.at).toTimeString().slice(0, 5) : '';
      const toWallet = t.kind === 'transfer' ? wallet(t.toAccountId) : ['income', 'collect'].includes(t.kind) || (t.kind === 'goal' && t.withdraw) ? wallet(t.accountId) : '';
      const fromWallet = t.kind === 'transfer' || !toWallet ? wallet(t.accountId) : '';
      const detail = t.kind === 'adjust' ? `${REASON[t.reason] || 'Adjustment'} (${t.direction === 'up' ? 'up' : 'down'})` : t.kind === 'debt' && t.installments > 1 ? `covers ${t.installments} payments` : t.kind === 'goal' ? (t.withdraw ? 'Took out' : 'Added') : '';
      return [
        t.date, time, KIND_LABEL[t.kind] || t.kind, t.amount, signed(t),
        t.kind === 'expense' ? S.cat(t.categoryId).name : '',
        fromWallet, toWallet, debtName(t),
        t.goalId ? S.goal(t.goalId)?.name || t.goalName || '' : '',
        t.receivableId ? S.receivable(t.receivableId)?.name || t.personName || '' : '',
        t.merchant || '', t.note || '', detail, t.src || 'manual', t.ref || '',
        (t.conf || []).map((c) => c.inst || c.via).join(' + '),
      ];
    });
  return [head, ...rows];
}

export function debtRows() {
  const head = ['Name', 'Type', 'Lender', 'Balance', 'Payment', 'How often', 'Next due', 'Payments left', 'Paid off by', 'Credit limit', 'Interest % a month', 'Notes'];
  return [head, ...S.db.debts.map((d) => {
    const left = S.paymentsLeft(d);
    return [d.name, DEBT_TYPES[d.type]?.label || d.type, d.lender, Math.max(0, d.balance), d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment,
      d.type === 'card' ? 'monthly' : d.frequency, d.nextDue || '', Number.isFinite(left) ? left : left === Infinity ? 'never at this rate' : '', S.payoffDate(d) || '', d.creditLimit || '', d.rate || '', d.notes];
  })];
}

export function goalRows() {
  const head = ['Goal', 'Target', 'Saved', 'Left', 'Target date', 'Per payday'];
  return [head, ...S.db.goals.map((g) => { const p = S.goalPlan(g); return [`${g.emoji || ''} ${g.name}`.trim(), g.target, g.saved, p.remaining, g.deadline || '', p.perPayday || '']; })];
}

export function receivableRows() {
  const head = ['Person', 'Owes you', 'Paid back so far', 'Due', 'Since', 'Notes'];
  return [head, ...(S.db.receivables || []).map((r) => [r.name, Math.max(0, r.balance), S.receivableProgress(r).paid, r.dueDate || '', r.createdAt, r.notes])];
}

// { name, text } for each requested export.
export function buildExports({ what = ['transactions'], from, to, accountId } = {}) {
  const stamp = today();
  const files = [];
  if (what.includes('transactions')) {
    const tag = accountId ? `-${(S.account(accountId)?.name || S.debt(accountId)?.name || 'wallet').toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
    files.push({ name: `pitaka-transactions${tag}-${from || 'start'}-to-${to || stamp}.csv`, text: toCSV(transactionRows({ from, to, accountId })) });
  }
  if (what.includes('debts')) files.push({ name: `pitaka-debts-${stamp}.csv`, text: toCSV(debtRows()) });
  if (what.includes('goals')) files.push({ name: `pitaka-goals-${stamp}.csv`, text: toCSV(goalRows()) });
  if (what.includes('receivables')) files.push({ name: `pitaka-owed-to-you-${stamp}.csv`, text: toCSV(receivableRows()) });
  return files;
}
