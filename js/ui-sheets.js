// Bottom sheets: the entry form, detail sheets, edit forms, wallets, settings and the debt import.
import * as S from './store.js';
import * as Sync from './sync.js';
import { db } from './store.js';
import { peso, esc, parseAmount, today, fmtDate, relDay, FREQS, round2, advance } from './util.js';
import {
  $, pw, icon, accounts, openSheet, closeSheet, sheetHead, saveLink, field, staticField, money, moneyValue, select, freqSelect,
  sizeAmount, toast, bar, FormProblem, str, optMoney, reqMoney, intField, setSettings, errorMessage, isValidation, haptic,
} from './ui-core.js';
import {
  refresh, txnRow, byDateDesc, schedPay, minDue, debtTypeOf, debtName, statusChip, goalPlanText, personName,
} from './ui-views.js';
import { paydayPicker, readPayday } from './ui-money.js';
import { walletStatementRow } from './ui-statement.js';
import { budgetWarning, budgetWarningText } from './insights.js';
import * as X from './inbox.js';

const KINDS = [['expense', 'Expense'], ['income', 'Income'], ['debt', 'Pay debt'], ['goal', 'Savings'], ['transfer', 'Move']];
const KIND_TITLES = { expense: 'Add expense', income: 'Add income', debt: 'Pay a debt', goal: 'Savings', transfer: 'Move money', adjust: 'Fee or interest', lend: 'Lend money', collect: 'Got paid back' };
export const WALLET_KINDS = { cash: 'Cash', ewallet: 'E-wallet', bank: 'Bank account' };
export const guessWalletKind = (name) => (/cash|pitaka|wallet\b/i.test(name) && !/gcash/i.test(name) ? 'cash'
  : /bank|bdo|bpi|metrobank|landbank|pnb|security|union|rcbc|china|savings|psbank|eastwest|cimb|gotyme|tonik|seabank|maribank/i.test(name) ? 'bank' : 'ewallet');

const defaultAccount = () => {
  const id = S.defaultAccountId?.();
  return S.account(id) ? id : accounts()[0]?.id || '';
};
const walletOptions = () => accounts().map((a) => [a.id, `${a.name} · ${peso(S.accountBalance(a.id))}`]);
const activeDebts = () => db.debts.filter((d) => d.balance > 0).sort((a, b) => (a.nextDue || '9').localeCompare(b.nextDue || '9'));
const debtFreq = (d) => (d.type === 'card' ? 'monthly' : d.frequency || (d.type === 'person' ? 'once' : 'monthly'));
const isNum = (v) => Number.isFinite(v) && v > 0;

// ================================================================== entry form (+)
export let draft = null;

function suggest(d, amount) {
  if (!d || !d.nextDue || !isNum(amount)) return 0;
  if (d.type === 'card') return amount >= (minDue(d) || 0.01) ? 1 : 0;
  try { return Math.max(0, Math.floor(Number(S.suggestInstallments(d.id, amount)) || 0)); } catch { return 0; }
}
function maxInstallments(d) {
  if (!d?.nextDue) return 0;
  if (d.type === 'card') return 1;
  const left = S.paymentsLeft(d);
  return Number.isFinite(left) && left > 0 ? left : 1;
}

export function txnForm(init = {}) {
  draft = { kind: 'expense', date: today(), note: '', amountText: '', installments: 1, ...init };
  if (init.amount != null && !init.amountText) draft.amountText = moneyValue(init.amount);
  if (!draft.accountId || !S.account(draft.accountId)) draft.accountId = defaultAccount();
  if (!draft.pay) draft.pay = draft.cardId ? `c:${draft.cardId}` : `a:${draft.accountId}`;
  renderTxnForm();
}

export function editTxn(id) {
  const t = db.txns.find((x) => x.id === id);
  if (!t) return toast("That entry wasn't found");
  const inst = t.installments ?? (t.countsInstallment || t.advanceDue ? 1 : 0);
  txnForm({ ...t, amountText: moneyValue(t.amount), installments: inst, instTouched: true, withdraw: t.withdraw ? '1' : '' });
}

function prepKind() {
  const t = draft;
  if (t.kind === 'expense' && !t.categoryId) {
    const order = categoryList();
    t.categoryId = (S.cat(db.settings.lastCategoryId) && db.categories.some((c) => c.id === db.settings.lastCategoryId) ? db.settings.lastCategoryId : order[0]?.id) || '';
  }
  if (t.kind === 'debt') {
    if (!t.id && (!t.debtId || !S.debt(t.debtId) || !(S.debt(t.debtId).balance > 0))) t.debtId = activeDebts()[0]?.id || '';
    const d = S.debt(t.debtId);
    if (d && !t.id && (!t.amountText || t.amountAuto)) {
      const p = schedPay(d);
      if (p) { t.amountText = moneyValue(Math.min(p, d.balance)); t.amountAuto = true; }
    }
    if (d && !t.instTouched) t.installments = suggest(d, parseAmount(t.amountText));
  }
  if (t.kind === 'goal' && !t.id && (!t.goalId || !S.goal(t.goalId))) t.goalId = db.goals[0]?.id || '';
  if (t.kind === 'collect' && !t.id && (!t.receivableId || !S.receivable(t.receivableId))) t.receivableId = (db.receivables || []).find((r) => r.balance > 0)?.id || '';
  if (t.kind === 'lend' && !t.person && t.receivableId) t.person = S.receivable(t.receivableId)?.name || '';
  if (t.kind === 'transfer') {
    if (!S.account(t.accountId)) t.accountId = defaultAccount();
    if (!t.toAccountId || t.toAccountId === t.accountId) t.toAccountId = accounts().find((a) => a.id !== t.accountId)?.id || '';
  }
}

// Visible categories, most used first (the one already picked stays even if it was hidden since).
function categoryList(keep) {
  let ids = [];
  try { ids = S.categoryOrder() || []; } catch { /* fall back to stored order */ }
  const byId = new Map(db.categories.map((c) => [c.id, c]));
  const out = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const c of db.categories) if (!out.includes(c)) out.push(c);
  return out.filter((c) => !c.hidden || c.id === keep);
}

function nextDueText(d, n) {
  if (!d?.nextDue || !n) return '';
  let date = d.nextDue;
  for (let i = 0; i < n; i++) {
    const nx = advance(date, debtFreq(d), d.dueDay, d.dueDays);
    if (!nx) return 'Marks this debt as paid for its due date.';
    date = nx;
  }
  return `Next due date moves to ${fmtDate(date)}.`;
}
function instText(n) {
  return n === 0 ? 'Extra payment' : `${n} payment${n === 1 ? '' : 's'}`;
}
function stepperHtml(d) {
  const n = Math.max(0, Number(draft.installments) || 0);
  const max = maxInstallments(d);
  return `<div class="field" role="group" aria-labelledby="inst-l">
    <span id="inst-l">Covers</span>
    <div class="stepper" style="display:flex;align-items:center;gap:12px">
      <button type="button" class="icon-btn" data-action="inst" data-d="-1" aria-label="One payment fewer" ${n <= 0 ? 'disabled' : ''}>−</button>
      <output name="instOut" aria-live="polite" style="min-width:8ch;text-align:center;font-weight:600">${esc(instText(n))}</output>
      <button type="button" class="icon-btn" data-action="inst" data-d="1" aria-label="One payment more" ${n >= max ? 'disabled' : ''}>+</button>
    </div>
    <input type="hidden" name="installments" value="${n}">
    <small data-inst-hint>${esc(n === 0 ? "An extra payment lowers the balance but doesn't move the due date." : nextDueText(d, n))}</small>
  </div>`;
}
// Update the stepper without re-rendering (keeps the keyboard up while typing the amount).
export function updateStepper(form) {
  const d = S.debt(draft.debtId);
  const box = form.querySelector('.stepper');
  if (!d || !box) return;
  const n = Math.max(0, Math.min(Number(draft.installments) || 0, maxInstallments(d)));
  draft.installments = n;
  form.querySelector('[name=installments]').value = n;
  form.querySelector('[name=instOut]').textContent = instText(n);
  form.querySelector('[data-inst-hint]').textContent = n === 0 ? "An extra payment lowers the balance but doesn't move the due date." : nextDueText(d, n);
  const [minus, plus] = box.querySelectorAll('button');
  minus.disabled = n <= 0;
  plus.disabled = n >= maxInstallments(d);
}

// Re-suggest how many payments the typed amount covers (until the person touches the stepper).
export function autoInstallments(form) {
  readDraft(form);
  const d = S.debt(draft.debtId);
  if (!d || !form.querySelector('.stepper')) return;
  draft.installments = suggest(d, parseAmount(draft.amountText));
  updateStepper(form);
}

const emptyCta = (text, action, label) => `<div class="card center"><p class="meta">${text}</p><button type="button" class="btn primary block" data-action="${action}">${label}</button></div>`;

export function renderTxnForm({ focusAmount = true } = {}) {
  prepKind();
  const t = draft;
  let body = '';
  let usable = true;
  const noteField = field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional" maxlength="120" autocomplete="off">`);
  const walletSel = (name, label, value) => (accounts().length ? field(label, select(name, walletOptions(), value)) : '');
  if (t.kind === 'expense') {
    const cats = categoryList(t.categoryId);
    const cards = db.debts.filter((d) => d.type === 'card');
    const payOpts = [{ group: 'Wallets', options: walletOptions() }];
    if (cards.length) payOpts.push({ group: 'Credit cards', options: cards.map((c) => [`c:${c.id}`, c.name]) });
    if (t.cardId && !S.debt(t.cardId)) payOpts.push([`c:${t.cardId}`, 'Deleted card']);
    payOpts[0].options = payOpts[0].options.map(([id, l]) => [`a:${id}`, l]);
    const bill = t.billId && S.bill(t.billId);
    body = `<fieldset class="cat-grid" style="border:0;padding:0;margin:8px 0 0;min-width:0"><legend class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Category</legend>${cats.map((c) => `<label class="cat-opt"><input type="radio" name="categoryId" value="${esc(c.id)}" ${c.id === t.categoryId ? 'checked' : ''}><span aria-hidden="true">${esc(c.emoji)}</span><small>${esc(c.name)}</small></label>`).join('')}</fieldset>
      ${bill ? staticField('Paying bill', `${esc(bill.name)}${bill.nextDue && !t.id ? ` · due ${esc(fmtDate(bill.nextDue))}` : ''}`) : ''}
      ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="What was it for?" maxlength="120" autocomplete="off">`)}
      ${field('Paid with', select('pay', payOpts, t.pay), cards.length ? "Card purchases are added to that card's balance." : '')}`;
  } else if (t.kind === 'income') {
    body = `${field('Source', `<input name="note" value="${esc(t.note || '')}" placeholder="Salary, freelance, gift…" maxlength="120" autocomplete="off">`)}
      ${walletSel('accountId', 'Into wallet', t.accountId)}`;
  } else if (t.kind === 'debt') {
    const d = S.debt(t.debtId);
    if (t.id && !d) {
      body = `${staticField('Debt', t.debtName ? `Deleted debt: ${esc(t.debtName)}` : 'Deleted debt')}<input type="hidden" name="debtId" value="${esc(t.debtId || '')}"><input type="hidden" name="installments" value="${Number(t.installments) || 0}">
        ${walletSel('accountId', 'From wallet', t.accountId)}${noteField}`;
    } else if (!activeDebts().length && !d) {
      usable = false;
      body = emptyCta("You don't have any debts to pay yet.", 'debtForm', 'Add a debt');
    } else {
      const list = activeDebts();
      if (d && !list.includes(d)) list.unshift(d);
      body = `${field('Which debt?', select('debtId', list.map((x) => [x.id, `${debtTypeOf(x).icon} ${x.name} · ${peso(Math.max(0, x.balance))} left`]), t.debtId))}
        ${d?.nextDue ? stepperHtml(d) : '<input type="hidden" name="installments" value="0">'}
        ${walletSel('accountId', 'From wallet', t.accountId)}
        ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional" maxlength="120" autocomplete="off">`)}`;
    }
  } else if (t.kind === 'goal') {
    const g = S.goal(t.goalId);
    if (t.id && !g) {
      body = `${staticField('Goal', t.goalName ? `Deleted goal: ${esc(t.goalName)}` : 'Deleted goal')}<input type="hidden" name="goalId" value="${esc(t.goalId || '')}">
        <input type="hidden" name="withdraw" value="${t.withdraw ? '1' : ''}">${walletSel('accountId', t.withdraw ? 'Into wallet' : 'From wallet', t.accountId)}${noteField}`;
    } else if (!db.goals.length) {
      usable = false;
      body = emptyCta('Create a savings goal first, like a vacation or an emergency fund.', 'goalForm', 'Add a savings goal');
    } else {
      body = `${field('Goal', select('goalId', db.goals.map((x) => [x.id, `${x.emoji || '🎯'} ${x.name} · ${peso(x.saved)} saved`]), t.goalId))}
        <div class="segmented small" role="radiogroup" aria-label="Add or take out"><label><input type="radio" name="withdraw" value="" ${!t.withdraw ? 'checked' : ''}><span>Add money</span></label><label><input type="radio" name="withdraw" value="1" ${t.withdraw ? 'checked' : ''}><span>Take out</span></label></div>
        ${walletSel('accountId', t.withdraw ? 'Into wallet' : 'From wallet', t.accountId)}
        ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional" maxlength="120" autocomplete="off">`)}`;
    }
  } else if (t.kind === 'transfer') {
    if (accounts().length < 2) {
      usable = false;
      body = emptyCta('Moving money needs two wallets, for example Cash and GCash.', 'walletForm', 'Add a wallet');
    } else {
      body = `<div class="two">${field('From', select('accountId', walletOptions(), t.accountId))}${field('To', select('toAccountId', walletOptions(), t.toAccountId))}</div>
        ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="e.g. Cash-in, ATM withdrawal" maxlength="120" autocomplete="off">`)}`;
    }
  } else if (t.kind === 'lend') {
    const people = [...new Set((db.receivables || []).map((r) => r.name))];
    body = `${t.id && t.orphan ? staticField('Lent to', esc(t.personName || 'Someone')) : field('Lent to', `<input name="person" required maxlength="60" value="${esc(t.person || (t.id ? personName(t) : ''))}" placeholder="Who?" autocomplete="off" list="people-list"><datalist id="people-list">${people.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`)}
      ${walletSel('accountId', 'From wallet', t.accountId)}
      ${t.id ? '' : field('Pay back by', `<input type="date" name="dueDate" value="${esc(t.dueDate || '')}">`, 'Optional')}
      ${noteField}`;
  } else if (t.kind === 'collect') {
    const open = (db.receivables || []).filter((r) => r.balance > 0 || r.id === t.receivableId);
    if (!open.length && !(t.id && t.orphan)) {
      usable = false;
      body = emptyCta('Nobody owes you money right now.', 'lendForm', 'Record money you lent');
    } else {
      body = `${t.id && t.orphan ? staticField('From', esc(t.personName || 'Someone')) : field('Who paid you back?', select('receivableId', open.map((r) => [r.id, `${r.name} · owes ${peso(Math.max(0, r.balance))}`]), t.receivableId))}
        ${walletSel('accountId', 'Into wallet', t.accountId)}${noteField}`;
    }
  } else if (t.kind === 'adjust' && t.accountId && !t.debtId) {
    body = `${staticField('Wallet', esc(S.account(t.accountId)?.name || 'Deleted wallet'))}<input type="hidden" name="accountId" value="${esc(t.accountId)}">
      ${field('Effect', select('direction', [['up', 'Raised the balance'], ['down', 'Lowered the balance']], t.direction || 'up'))}
      ${noteField}
      <p class="meta pad">A balance fix makes the wallet match its app. It isn't counted as spending or income.</p>`;
  } else if (t.kind === 'adjust') {
    const reasons = t.reason === 'correction' ? [['correction', 'Balance fix']] : [['fee', 'Fee'], ['interest', 'Interest'], ['penalty', 'Late penalty']];
    body = `${staticField('Debt', esc(debtName(t)))}<input type="hidden" name="debtId" value="${esc(t.debtId || '')}">
      <div class="two">${field('What is it?', select('reason', reasons, t.reason || 'fee'))}${field('Effect', select('direction', [['up', 'Adds to balance'], ['down', 'Lowers balance']], t.direction || 'up'))}</div>
      ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional" maxlength="120" autocomplete="off">`)}
      <p class="meta pad">This changes what you owe. It isn't counted as spending.</p>`;
  }
  const showKinds = !t.id && !['adjust', 'lend', 'collect'].includes(t.kind) && !t.billId;
  const title = t.id ? (t.kind === 'adjust' ? (t.accountId ? 'Edit balance fix' : 'Edit adjustment') : 'Edit entry') : t.billId ? 'Pay bill' : KIND_TITLES[t.kind];
  const panel = openSheet(`${sheetHead(esc(title), { right: usable ? saveLink('txn-form') : '' })}
    ${showKinds ? `<div class="segmented" role="group" aria-label="Kind of entry">${KINDS.map(([k, l]) => `<button type="button" class="${t.kind === k ? 'on' : ''}" aria-pressed="${t.kind === k}" data-action="txnKind" data-kind="${k}"${k === 'transfer' ? ' aria-label="Move money between wallets"' : ''}>${l}</button>`).join('')}</div>` : ''}
    <form id="txn-form" data-form="txn" autocomplete="off" novalidate>
      ${usable ? `<div class="amount-big"><span aria-hidden="true">₱</span><input name="amount" inputmode="decimal" placeholder="0" autocomplete="off" aria-label="Amount in pesos" value="${esc(t.amountText)}"></div>` : ''}
      ${body}
      ${usable ? `${field('Date', `<input type="date" name="date" value="${esc(t.date)}" required>`)}
      <button class="btn primary block" type="submit">${t.id ? 'Save changes' : 'Save'}</button>` : ''}
      ${t.id ? `<button class="btn danger block" type="button" data-action="deleteTxn" data-id="${esc(t.id)}">Delete entry</button>` : ''}
    </form>`);
  const amt = panel.querySelector('[name=amount]');
  sizeAmount(amt);
  // Focus synchronously inside the tap so iOS raises the keyboard.
  if (amt && !t.id && focusAmount) amt.focus({ preventScroll: true });
}

export function readDraft(form) {
  if (!form || !draft) return;
  const f = new FormData(form);
  for (const k of ['note', 'date', 'categoryId', 'pay', 'accountId', 'toAccountId', 'debtId', 'goalId', 'withdraw', 'direction', 'reason', 'person', 'receivableId', 'dueDate']) if (f.has(k)) draft[k] = f.get(k);
  if (f.has('amount')) draft.amountText = f.get('amount');
  if (f.has('installments')) draft.installments = parseInt(f.get('installments'), 10) || 0;
}

function txnOut() {
  const t = draft;
  const amount = parseAmount(t.amountText);
  if (!isNum(amount)) throw new FormProblem(String(t.amountText || '').trim() ? "That amount doesn't look right. Use numbers only, like 1,250.50." : 'Enter an amount', 'amount');
  const out = { kind: t.kind, amount, date: t.date || today(), note: String(t.note || '').trim().slice(0, 120) };
  if (t.id) out.id = t.id;
  // From Review → Edit: keep where it came from (merchant, reference, time, "confirmed by").
  if (t.inboxId) { out.inboxId = t.inboxId; for (const [k, v] of Object.entries(t.capture || {})) if (v !== undefined && v !== null && v !== '') out[k] = v; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new FormProblem('Pick a date', 'date');
  switch (t.kind) {
    case 'expense': {
      out.categoryId = t.categoryId || null;
      const [k, id] = String(t.pay || '').split(':');
      if (k === 'c') { out.cardId = id; out.accountId = null; } else { out.accountId = id || defaultAccount(); out.cardId = null; }
      if (t.billId) out.billId = t.billId;
      break;
    }
    case 'income': out.accountId = t.accountId; break;
    case 'debt':
      if (!t.debtId && !(t.id && t.orphan)) throw new FormProblem('Pick a debt', 'debtId');
      out.debtId = t.debtId; out.accountId = t.accountId; out.installments = Math.max(0, Number(t.installments) || 0);
      break;
    case 'goal':
      if (!t.goalId && !(t.id && t.orphan)) throw new FormProblem('Pick a goal', 'goalId');
      out.goalId = t.goalId; out.accountId = t.accountId; out.withdraw = t.withdraw === '1' || t.withdraw === true;
      break;
    case 'transfer':
      if (!t.accountId || !t.toAccountId) throw new FormProblem('Pick both wallets', 'accountId');
      if (t.accountId === t.toAccountId) throw new FormProblem('Pick two different wallets', 'toAccountId');
      out.accountId = t.accountId; out.toAccountId = t.toAccountId;
      break;
    case 'adjust':
      if (t.accountId && !t.debtId) { out.accountId = t.accountId; out.direction = t.direction === 'down' ? 'down' : 'up'; out.reason = 'correction'; break; }
      out.debtId = t.debtId; out.direction = t.direction === 'down' ? 'down' : 'up'; out.reason = t.reason || 'fee';
      break;
    case 'lend': {
      out.accountId = t.accountId;
      if (t.id && t.orphan) break;
      const name = String(t.person || '').trim();
      if (!name) throw new FormProblem('Enter who you lent money to', 'person');
      const r = S.findReceivable(name);
      if (t.id) {
        if (!r) throw new FormProblem(`To lend to someone new, add a new entry`, 'person');
        out.receivableId = r.id;
      } else { out.name = name; if (t.dueDate) out.dueDate = t.dueDate; }
      break;
    }
    case 'collect':
      if (!t.receivableId && !(t.id && t.orphan)) throw new FormProblem('Pick who paid you back', 'receivableId');
      out.receivableId = t.receivableId; out.accountId = t.accountId;
      break;
    default: throw new FormProblem('Pick what kind of entry this is');
  }
  return out;
}

function remember(out) {
  const patch = {};
  if (out.accountId && ['expense', 'income', 'debt', 'goal'].includes(out.kind) && out.accountId !== db.settings.defaultAccountId) patch.defaultAccountId = out.accountId;
  if (out.kind === 'expense' && !out.billId && out.categoryId && out.categoryId !== db.settings.lastCategoryId) patch.lastCategoryId = out.categoryId;
  if (Object.keys(patch).length) try { setSettings(patch); } catch { /* a preference; the entry itself is saved */ }
}

export async function undoSaved(id) {
  try { S.deleteTxn(id); await S.flush(); refresh(); toast('Entry removed'); } catch (e) { refresh(); toast(errorMessage(e)); }
}
export async function deleteTxn(id) {
  const copy = S.deleteTxn(id);
  await S.flush();
  haptic();
  closeSheet();
  refresh();
  if (!copy) return toast('That entry was already deleted');
  toast('Deleted', {
    action: 'Undo',
    onAction: async () => { try { S.restoreTxn(copy); await S.flush(); refresh(); toast('Entry restored'); } catch (e) { refresh(); toast(errorMessage(e)); } },
  });
}

// ================================================================== debts
export function addDebtMenu() {
  openSheet(`${sheetHead('Add debts')}
    <div class="list card">
      <button type="button" class="row" data-action="importSheet"><span class="icon" aria-hidden="true">${icon('upload')}</span><span class="grow"><span class="title">Paste from a spreadsheet</span><span class="meta">Copy the rows from Google Sheets or Excel</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button>
      <button type="button" class="row" data-action="debtForm"><span class="icon" aria-hidden="true">${icon('plus')}</span><span class="grow"><span class="title">Add one debt</span><span class="meta">Credit card, loan, installment, lending app or a person</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button>
    </div>`);
}

const dueDaysHtml = (v, freq, hint) => {
  const dd = Array.isArray(v.dueDays) && v.dueDays.length === 2 ? v.dueDays : [15, 31];
  return `<div data-semi ${freq === 'semimonthly' ? '' : 'hidden'}><div class="two">
    ${field('First due day', `<input name="dueDay1" inputmode="numeric" maxlength="2" value="${esc(dd[0])}">`)}
    ${field('Second due day', `<input name="dueDay2" inputmode="numeric" maxlength="2" value="${esc(dd[1])}">`)}</div>
    <small class="meta">${hint}</small></div>`;
};
function readDueDays(f) {
  const a = intField(f, 'dueDay1', { min: 1, max: 31, msg: 'Enter due days from 1 to 31' });
  const b = intField(f, 'dueDay2', { min: 1, max: 31, msg: 'Enter due days from 1 to 31' });
  if (a === b) throw new FormProblem('Enter two different due days', 'dueDay2');
  return [a, b].sort((x, y) => x - y);
}

export function debtForm(d) {
  const v = d || { type: 'loan', frequency: 'monthly', nextDue: '', rate: '' };
  const types = Object.entries(S.DEBT_TYPES);
  const card = v.type === 'card';
  openSheet(`${sheetHead(d ? 'Edit debt' : 'New debt', { right: saveLink('debt-form') })}
    <form id="debt-form" data-form="debt" data-id="${esc(d?.id || '')}" data-type="${esc(v.type)}" novalidate>
      <fieldset class="type-grid" style="border:0;padding:0;margin:0;min-width:0"><legend style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Type of debt</legend>${types.map(([k, t]) => `<label><input type="radio" name="type" value="${esc(k)}" ${v.type === k ? 'checked' : ''}><span aria-hidden="true">${esc(t.icon)}</span><small>${esc(t.label)}</small></label>`).join('')}</fieldset>
      ${field('Name', `<input name="name" required maxlength="60" value="${esc(v.name || '')}" placeholder="e.g. BPI card, iPhone installment, Tita Mel" autocomplete="off">`)}
      ${field(`<span data-bal-label>${card ? 'Current balance' : 'Remaining balance'}</span>`, money('balance', d ? Math.max(0, v.balance) : ''), '<span class="when sched">Leave blank and Pitaka will work it out.</span>')}

      <div class="when sched">
        <div class="two">${field('Payment amount', money('paymentAmount', v.paymentAmount))}${field('How often', freqSelect('frequency', v.frequency))}</div>
        ${dueDaysHtml(v, v.frequency, '31 means the end of the month. Lending apps often use the 5th and 20th.')}
        <div class="two">${field('Total payments', `<input name="totalPayments" inputmode="numeric" maxlength="4" value="${esc(v.totalPayments || '')}" placeholder="e.g. 12">`)}
          ${field('Already paid', `<input name="paymentsMade" inputmode="numeric" maxlength="4" value="${v.paymentsMade ? esc(v.paymentsMade) : ''}" placeholder="0">`)}</div>
      </div>
      <div class="when card-only">
        <div class="two">${field('Minimum due', money('minDue', minDue(v)))}${field('Credit limit', money('creditLimit', v.creditLimit))}</div>
      </div>
      <div class="when card-only person">
        ${field('I plan to pay', money('plannedPayment', v.plannedPayment), 'Per month. Used to estimate how many payments are left.')}
      </div>

      ${field('Next due date', `<input type="date" name="nextDue" value="${esc(v.nextDue || '')}">`, '<span class="when person">Optional for money owed to a person.</span>')}
      ${field('Who you owe (bank, app or person)', `<input name="lender" maxlength="60" value="${esc(v.lender || '')}" placeholder="e.g. BPI, GCash, Home Credit" autocomplete="off">`)}
      <div class="when sched card-only">${field('Interest rate (% per month)', `<input name="rate" inputmode="decimal" maxlength="6" value="${v.rate ? esc(v.rate) : ''}" placeholder="${card ? 'e.g. 3' : 'Optional'}">`)}</div>
      ${field('Notes', `<textarea name="notes" rows="2" maxlength="500" placeholder="Account number, terms…">${esc(v.notes || '')}</textarea>`)}
      <button class="btn primary block" type="submit">Save debt</button>
      ${d ? `<button class="btn danger block" type="button" data-action="deleteDebt" data-id="${esc(d.id)}">Delete debt</button>` : ''}
    </form>`);
}

export function debtSheet(d) {
  if (!d) return toast("That debt wasn't found");
  const T = debtTypeOf(d);
  const card = d.type === 'card';
  const left = S.paymentsLeft(d);
  const payoff = S.payoffDate(d);
  const st = S.debtStatus(d);
  let activity = [];
  try { activity = S.debtActivity(d.id) || []; } catch { activity = db.txns.filter((x) => x.debtId === d.id || x.cardId === d.id).sort(byDateDesc); }
  const paid = round2(activity.filter((x) => x.kind === 'debt').reduce((s, x) => s + x.amount, 0));
  const stats = [['Balance', `<span class="num">${esc(peso(Math.max(0, d.balance)))}</span>`]];
  if (card) {
    stats.push(['Minimum due', minDue(d) ? esc(peso(minDue(d))) : '—'], ['I plan to pay', d.plannedPayment ? `${esc(peso(d.plannedPayment))} <small>a month</small>` : '—']);
    if (d.creditLimit > 0) stats.push(['Available credit', esc(peso(Math.max(0, d.creditLimit - d.balance)))]);
  } else {
    stats.push(S.isScheduled(d) ? ['Payments left', `<b>${esc(left)}</b> of ${esc(d.totalPayments)}`] : ['Payments left', left === Infinity ? 'Never at this rate' : left ? `About ${esc(left)}` : '—']);
    const pay = schedPay(d);
    stats.push(['Payment', pay ? `${esc(peso(pay))}${S.isScheduled(d) ? ` <small>${esc((FREQS[d.frequency] || '').toLowerCase())}</small>` : ''}` : '—']);
  }
  stats.push(['Next due', d.nextDue && d.balance > 0 ? `${esc(fmtDate(d.nextDue))} <small>(${esc(relDay(d.nextDue))})</small>` : '—']);
  stats.push(['Paid off by', payoff ? esc(fmtDate(payoff, { month: 'short', day: 'numeric', year: 'numeric' })) : left === Infinity ? 'Never at this rate' : '—']);
  stats.push(['Paid since added', esc(peso(paid))]);
  if (d.rate) stats.push(['Interest', `${esc(d.rate)}% a month`]);
  let progress = '';
  if (card && d.creditLimit > 0) {
    const pct = (Math.max(0, d.balance) / d.creditLimit) * 100;
    progress = `${bar(pct, pct >= 100 ? 'critical' : pct >= 70 ? 'warning' : '', 'Credit limit used')}<p class="meta center">${pw(Math.max(0, d.balance))} of ${pw(d.creditLimit)} limit used</p>`;
  } else if (!card && d.original > 0) {
    const pct = (1 - d.balance / d.original) * 100;
    progress = `${bar(pct, 'good', 'Paid off so far')}<p class="meta center">${Math.round(Math.max(0, Math.min(100, pct)))}% paid off</p>`;
  }
  openSheet(`${sheetHead(`${esc(T.icon)} ${esc(d.name)}`, { close: 'Done', right: `<button type="button" class="link" data-action="debtForm" data-id="${esc(d.id)}">Edit</button>` })}
    <p class="meta center">${esc(T.label)}${d.lender ? ` · ${esc(d.lender)}` : ''} ${statusChip(st)}</p>
    ${progress}
    <dl class="stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ''}
    <div class="actions">
      ${d.balance > 0 ? `<button type="button" class="btn primary" data-action="payDebt" data-id="${esc(d.id)}">Pay</button>` : ''}
      ${d.nextDue && d.balance > 0 ? `<button type="button" class="btn" data-action="calendar" data-kind="debt" data-id="${esc(d.id)}">${icon('calendar')}Remind me</button>` : ''}
    </div>
    <div class="actions">
      <button type="button" class="btn" data-action="feeForm" data-id="${esc(d.id)}">${icon('plus')}Fee / interest</button>
      <button type="button" class="btn" data-action="fixDebt" data-id="${esc(d.id)}">${icon('edit')}Fix balance</button>
    </div>
    <h3>History</h3>
    ${activity.length ? `<ul class="list">${activity.slice(0, 40).map((x) => txnRow(x, { ctx: 'debt' })).join('')}</ul>` : '<p class="empty">No payments logged yet.</p>'}`);
}

export function fixDebtForm(d) {
  if (!d) return;
  openSheet(`${sheetHead('Fix balance', { right: saveLink('fix-form') })}
    <form id="fix-form" data-form="fixDebt" data-id="${esc(d.id)}" novalidate>
      <p class="meta pad">Pitaka shows ${esc(peso(d.balance))} left on ${esc(d.name)}. Enter the balance on your statement or app, and Pitaka records the difference as a correction.</p>
      ${field('Correct balance now', money('balance', Math.max(0, d.balance), 'aria-describedby="fix-h"'), '<span id="fix-h">Enter 0 if it\'s fully paid.</span>')}
      <button class="btn primary block" type="submit">Save balance</button>
    </form>`);
}

// ================================================================== bills / goals / categories
export function billForm(b) {
  const v = b || { frequency: 'monthly', nextDue: today(), categoryId: db.categories.find((c) => /bill/i.test(c.name))?.id };
  openSheet(`${sheetHead(b ? 'Edit bill' : 'New bill', { right: saveLink('bill-form') })}
    <form id="bill-form" data-form="bill" data-id="${esc(b?.id || '')}" novalidate>
      ${field('Name', `<input name="name" required maxlength="60" value="${esc(v.name || '')}" placeholder="e.g. Rent, Meralco, PLDT, Netflix" autocomplete="off">`)}
      <div class="two">${field('Amount', money('amount', v.amount))}${field('How often', freqSelect('frequency', v.frequency))}</div>
      ${dueDaysHtml(v, v.frequency, '31 means the end of the month.')}
      ${field('Next due date', `<input type="date" name="nextDue" required value="${esc(v.nextDue || today())}">`)}
      ${field('Category', select('categoryId', db.categories.map((c) => [c.id, `${c.emoji} ${c.name}`]), v.categoryId))}
      <button class="btn primary block" type="submit">Save bill</button>
      ${b && b.nextDue && !b.done ? `<button class="btn block" type="button" data-action="calendar" data-kind="bill" data-id="${esc(b.id)}">${icon('calendar')}Add reminder to Calendar</button>` : ''}
      ${b ? `<button class="btn danger block" type="button" data-action="deleteBill" data-id="${esc(b.id)}">Delete bill</button>` : ''}
    </form>`);
}

const GOAL_EMOJI = ['✈️', '🏖️', '🎁', '🚗', '🏠', '💍', '🎓', '📱', '🆘', '🎄'];
export function goalForm(g) {
  const v = g || { emoji: '✈️' };
  openSheet(`${sheetHead(g ? 'Edit goal' : 'New goal', { right: saveLink('goal-form') })}
    <form id="goal-form" data-form="goal" data-id="${esc(g?.id || '')}" novalidate>
      <div class="emoji-row" role="group" aria-label="Pick an icon">${GOAL_EMOJI.map((e) => `<button type="button" class="${e === v.emoji ? 'on' : ''}" data-action="pickEmoji" data-e="${esc(e)}" aria-label="Use ${esc(e)}">${esc(e)}</button>`).join('')}</div>
      <div class="two narrow-first">${field('Icon', `<input name="emoji" value="${esc(v.emoji || '')}" maxlength="4" autocomplete="off">`)}${field('Name', `<input name="name" required maxlength="40" value="${esc(v.name || '')}" placeholder="e.g. Japan trip" autocomplete="off">`)}</div>
      ${field('Target amount', money('target', v.target))}
      ${field('Target date', `<input type="date" name="deadline" value="${esc(v.deadline || '')}">`, 'Optional. Pitaka works out how much to put aside each payday.')}
      ${g ? '' : field('Already saved', money('saved', v.saved))}
      <button class="btn primary block" type="submit">Save goal</button>
      ${g ? `<button class="btn danger block" type="button" data-action="deleteGoal" data-id="${esc(g.id)}">Delete goal</button>` : ''}
    </form>`);
}
export function goalSheet(g) {
  if (!g) return toast("That goal wasn't found");
  const deps = db.txns.filter((t) => t.kind === 'goal' && t.goalId === g.id).sort(byDateDesc);
  openSheet(`${sheetHead(`${esc(g.emoji || '🎯')} ${esc(g.name)}`, { close: 'Done', right: `<button type="button" class="link" data-action="goalForm" data-id="${esc(g.id)}">Edit</button>` })}
    <p class="big num center">${pw(g.saved)}</p><p class="meta center">of ${pw(g.target)}${g.deadline ? ` by ${esc(fmtDate(g.deadline))}` : ''}</p>
    ${bar((g.saved / g.target) * 100, g.saved >= g.target ? 'good' : '', 'Saved so far')}
    <p class="center plan-line">${esc(goalPlanText(g))}</p>
    <div class="actions"><button type="button" class="btn primary" data-action="goalMoney" data-id="${esc(g.id)}">${icon('plus')}Add money</button><button type="button" class="btn" data-action="goalMoney" data-id="${esc(g.id)}" data-w="1">Take out</button></div>
    <h3>History</h3>${deps.length ? `<ul class="list">${deps.map((t) => txnRow(t, { ctx: 'goal' })).join('')}</ul>` : '<p class="empty">Nothing saved yet.</p>'}`);
}
// ================================================================== wallets
export function walletSheet(id) {
  const a = S.account(id);
  if (!a) return toast("That wallet wasn't found");
  const hist = db.txns.filter((t) => t.accountId === id || t.toAccountId === id).sort(byDateDesc).slice(0, 40);
  openSheet(`${sheetHead(esc(a.name), { close: 'Done', right: `<button type="button" class="link" data-action="walletForm" data-id="${esc(id)}">Edit</button>` })}
    <p class="big num center">${esc(peso(S.accountBalance(id)))}</p><p class="meta center">${esc(WALLET_KINDS[a.kind] || 'Wallet')}</p>
    <div class="actions">
      <button type="button" class="btn primary" data-action="moveMoney" data-id="${esc(id)}">${icon('swap')}Move money</button>
      <button type="button" class="btn" data-action="walletForm" data-id="${esc(id)}" data-focus="balance">${icon('edit')}Fix balance</button>
    </div>
    <div class="list card">${walletStatementRow(id)}</div>
    <h3>History</h3>${hist.length ? `<ul class="list">${hist.map((t) => txnRow(t, { ctx: 'wallet', walletId: id })).join('')}</ul>` : '<p class="empty">Nothing in this wallet yet.</p>'}`);
}
export function walletForm(a, { focus = '' } = {}) {
  const bal = a ? S.accountBalance(a.id) : '';
  const panel = openSheet(`${sheetHead(a ? 'Edit wallet' : 'New wallet', { right: saveLink('wallet-form') })}
    <form id="wallet-form" data-form="wallet" data-id="${esc(a?.id || '')}" novalidate>
      ${field('Name', `<input name="name" required maxlength="30" value="${esc(a?.name || '')}" placeholder="e.g. GCash, Maya, BDO savings" autocomplete="off">`)}
      ${field('Type', select('kind', Object.entries(WALLET_KINDS), a?.kind || 'ewallet'))}
      ${field(a ? 'Balance now' : 'Starting balance', money('balance', bal), a ? 'Change this if it doesn\'t match your wallet or app. Pitaka records the difference as a balance fix, not as spending.' : 'What\'s in it today.')}
      <button class="btn primary block" type="submit">Save wallet</button>
      ${a ? `<button class="btn danger block" type="button" data-action="deleteWallet" data-id="${esc(a.id)}">Delete wallet</button>` : ''}
    </form>`);
  if (focus === 'balance') panel.querySelector('[name=balance]')?.focus({ preventScroll: true });
}
// Change a wallet's balance by moving its opening amount, so reports don't see fake income or spending.
export function setWalletBalance(a, target, patch = {}) {
  const cur = S.accountBalance(a.id);
  const delta = round2(target - cur);
  return S.saveAccount({ ...a, ...patch, opening: round2((Number(a.opening) || 0) + delta) });
}

// Shared editor: a list of wallets with balances (onboarding step 2 and "Enter balances").
export function balancesRows() {
  const rows = accounts().map((a) => ({ id: a.id, name: a.name, bal: S.accountBalance(a.id) }));
  for (const name of ['Cash', 'GCash', 'Bank']) if (!rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) rows.push({ id: '', name, bal: '' });
  return rows;
}
export const balanceRow = (r = { id: '', name: '', bal: '' }) => `<div class="wallet-row" data-wrow style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end">
    <input type="hidden" name="wid" value="${esc(r.id)}">
    ${field('Wallet', `<input name="wname" maxlength="30" value="${esc(r.name)}" placeholder="e.g. Maya" autocomplete="off">`)}
    ${field('Balance now', money('wbal', r.bal))}
    <button type="button" class="icon-btn plain" data-action="removeWalletRow" aria-label="Remove ${esc(r.name || 'this wallet')}" style="margin-bottom:6px">${icon('x')}</button>
  </div>`;
export const balancesEditor = (rows) => `<div data-wrows>${rows.map(balanceRow).join('')}</div><input type="hidden" name="wdel" value="">
  <button type="button" class="btn block" data-action="addWalletRow">${icon('plus')}Add another wallet</button>`;

export function saveBalances(form) {
  const f = new FormData(form);
  const ids = f.getAll('wid'), names = f.getAll('wname'), bals = f.getAll('wbal');
  const removed = String(f.get('wdel') || '').split(',').filter(Boolean);
  const rows = [];
  ids.forEach((id, i) => {
    const name = String(names[i] || '').trim().slice(0, 30);
    const raw = String(bals[i] || '').trim();
    if (!name && !raw) return;
    if (!name) throw new FormProblem('Give every wallet a name', 'wname');
    const bal = raw ? parseAmount(raw) : null;
    if (raw && !(Number.isFinite(bal) && bal >= 0)) throw new FormProblem(`Check the balance for ${name}. Use numbers only, like 1,250.50.`, 'wbal');
    rows.push({ id, name, bal });
  });
  if (!rows.length) throw new FormProblem('Keep at least one wallet', 'wname');
  for (const id of removed) if (S.account(id)) S.deleteAccount(id);
  for (const r of rows) {
    const a = r.id && S.account(r.id);
    if (a) setWalletBalance(a, r.bal ?? S.accountBalance(a.id), { name: r.name });
    else S.saveAccount({ name: r.name, kind: guessWalletKind(r.name), opening: r.bal || 0, openingDate: today() });
  }
}
export function balancesForm() {
  openSheet(`${sheetHead('Wallet balances', { right: saveLink('bal-form') })}
    <form id="bal-form" data-form="balances" novalidate>
      <p class="meta pad">How much is in each of your wallets right now? Pitaka adds and subtracts from here as you log entries.</p>
      ${balancesEditor(balancesRows())}
      <button class="btn primary block" type="submit">Save balances</button>
    </form>`);
}

// ================================================================== settings
export function settingsSheet() {
  const s = db.settings;
  let bs = { daysSince: null };
  try { bs = S.backupStatus() || bs; } catch { /* older store */ }
  const last = s.lastBackupAt ? `Last backup ${bs.daysSince === 0 ? 'today' : bs.daysSince === 1 ? 'yesterday' : `${bs.daysSince} days ago`}.` : 'No backup saved yet.';
  const row = (action, title, meta = '', extra = '') => `<button type="button" class="row" data-action="${action}" ${extra}><span class="grow"><span class="title">${title}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</span><span class="chev" aria-hidden="true">${icon('right')}</span></button>`;
  const theme = s.theme || 'system';
  openSheet(`${sheetHead('Settings', { close: 'Done' })}
    <h3>Appearance</h3>
    <div class="segmented" role="group" aria-label="Theme">${[['system', 'contrast', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([k, ic, l]) => `<button type="button" data-action="setTheme" data-theme="${k}" aria-pressed="${theme === k}">${icon(ic)}${l}</button>`).join('')}</div>
    <h3>Payday</h3>
    <form id="settings-form" data-form="settings" novalidate>
      <p class="meta pad"><b>When is your next payday?</b> ${esc(S.paydayInfo().isToday ? 'Today is payday.' : `Pitaka has ${fmtDate(S.paydayInfo().next, { weekday: 'long', month: 'short', day: 'numeric' })}.`)}</p>
      ${paydayPicker(S.period().next)}
      ${field('Usual paycheck', money('payAmount', s.payAmount), 'Fills in "Log paycheck" for you.')}
      <button class="btn block" type="submit">Save payday</button>
    </form>
    <h3>Wallets</h3>
    <div class="list card">${accounts().map((a) => `<button type="button" class="row" data-action="walletSheet" data-id="${esc(a.id)}"><span class="icon" aria-hidden="true">${icon('wallet')}</span><span class="grow"><span class="title">${esc(a.name)}</span><span class="meta">${esc(WALLET_KINDS[a.kind] || 'Wallet')}</span></span><span class="num">${esc(peso(S.accountBalance(a.id)))}</span></button>`).join('')}
      ${row('walletForm', 'Add a wallet')}</div>
    <h3>Capture</h3>
    <div class="list card">
      ${row('connectGuide', 'Connect your iPhone', 'Back Tap quick add, SMS and email alerts, step by step', 'data-from="settings"')}
      ${row('relaySheet', 'Inbox relay', Sync.paired() ? `Paired with ${esc(Sync.relayHost())}` : 'Not set up · lets your shortcuts reach Pitaka', 'data-from="settings"')}
      ${row('inboxSettings', 'Inbox and alerts', 'Review, Files catch-up, alert formats, card mapping')}
    </div>
    <h3>Money</h3>
    <div class="list card">
      ${row('catManager', 'Categories', 'Rename, emoji, order, hide, merge')}
      ${row('statementSheet', 'Import a statement', 'PDF or CSV from GCash, GoTyme, Maya or your bank')}
      ${row('exportSheet', 'Export CSV', 'Transactions, debts, goals, owed to you')}
      ${row('importSheet', 'Paste debts from a spreadsheet', 'Google Sheets or Excel')}
      ${row('calendarAll', 'Add all due dates to Calendar', 'One file with every bill and debt')}
    </div>
    <h3>Security</h3>
    <div class="list card">
      ${row('setPin', s.pinHash ? 'Change PIN' : 'Set a PIN lock', 'Locks after a minute in the background and hides your balances in the app switcher')}
      ${s.pinHash ? row('removePin', 'Turn off PIN') : ''}
    </div>
    <h3>Backup</h3>
    <p class="meta pad">Your data is only stored on this iPhone. ${esc(last)} Save a backup to Files or iCloud Drive now and then, so you don't lose everything if the phone is lost or reset.</p>
    <div class="list card">
      ${row('exportData', 'Save backup file')}
      ${row('importData', 'Restore from backup', 'Replaces what\'s on this phone')}
    </div>
    <p class="meta pad" id="persist-status" aria-live="polite">Checking storage protection…</p>
    <h3>Danger zone</h3>
    <button type="button" class="btn danger block" data-action="eraseAll">Erase all data</button>
    <p class="meta center">Pitaka · private, on-device · ${esc(db.txns.length)} entries</p>`);
  checkPersist();
}
async function checkPersist() {
  const el = $('#persist-status');
  let p = null;
  try { p = await navigator.storage?.persisted?.(); } catch { p = null; }
  if (!el?.isConnected) return;
  el.textContent = p === true
    ? "Storage protection: on. iPhone won't clear Pitaka's data to free up space."
    : p === false
      ? 'Storage protection: off. iPhone may clear data of web apps you haven\'t opened for a while. Keeping Pitaka on your Home Screen and saving backups keeps you safe.'
      : "Storage protection: this browser can't tell. Save backups regularly.";
}

// `repair`: the backup came from a Pitaka paired with a relay, and this one isn't (backups never carry
// the relay's tokens or key).
export function restoredSheet({ repair = false } = {}) {
  openSheet(`${sheetHead('Backup restored', { close: 'Done' })}
    <p class="pad">Your entries are back. The PIN lock is off, because restoring a backup never brings back an old PIN.</p>
    <div class="actions"><button type="button" class="btn primary" data-action="setPin">${icon('lock')}Set a new PIN</button><button type="button" class="btn" data-action="closeSheet">Not now</button></div>
    ${repair ? `<h3>Inbox relay</h3>
    <p class="pad">This backup was paired with your relay. Backups never include its tokens or key, so pair again to keep collecting from your shortcuts. Paste the write token from one of your shortcuts, and they keep working unchanged.</p>
    <div class="actions"><button type="button" class="btn tinted" data-action="relaySheet" data-from="restored">${icon('link')}Pair the relay again</button></div>` : ''}`);
}

// ================================================================== debt import (paste)
const imp = { rows: [], warnings: [], include: [], types: [], errors: [], text: '' };
let importer = null;
const loadImporter = () => (importer ||= import('./importer.js'));

export const importPanel = (ctx) => `<div class="import-box">
    ${field('Paste from Google Sheets or Excel (include the header row)', `<textarea name="importText" rows="8" data-import-text spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Name&#9;Balance&#9;Monthly&#9;Due date&#10;GLoan&#9;7480&#9;1870&#9;15"></textarea>`,
    'In your spreadsheet, select your debts together with the header row, copy, then paste here.')}
  </div>
  <div data-import-preview data-ctx="${ctx}" aria-live="polite"></div>`;

export function importSheet() {
  imp.rows = []; imp.text = '';
  openSheet(`${sheetHead('Paste debts')}${importPanel('sheet')}`);
}

let parseTimer = 0;
export function onImportInput(textarea) {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => parseImport(textarea), 150);
}
async function parseImport(textarea) {
  const root = textarea.closest('#sheet, #onboard');
  const out = root?.querySelector('[data-import-preview]');
  if (!out) return;
  imp.text = textarea.value;
  if (!imp.text.trim()) { imp.rows = []; out.innerHTML = ''; return; }
  let res;
  try {
    res = (await loadImporter()).parseDebtRows(imp.text) || { rows: [], warnings: [] };
  } catch (e) {
    console.error(e);
    out.innerHTML = '<p class="critical-text">Pitaka couldn\'t read that. Try copying the rows again, including the header row.</p>';
    return;
  }
  imp.rows = res.rows || [];
  imp.warnings = res.warnings || [];
  imp.include = imp.rows.map(() => true);
  imp.types = imp.rows.map((r) => (S.DEBT_TYPES[r.type] ? r.type : 'loan'));
  imp.errors = imp.rows.map(() => '');
  drawPreview(out);
}
function rowBalance(r) {
  if (Number.isFinite(r.balance)) return r.balance;
  if (r.paymentAmount > 0 && r.totalPayments > 0) return round2(r.paymentAmount * (r.totalPayments - (r.paymentsMade || 0)));
  return null;
}
function drawPreview(out) {
  const n = imp.include.filter(Boolean).length;
  const ctx = out.dataset.ctx;
  if (!imp.rows.length) {
    out.innerHTML = `<p class="meta pad">No debts found yet. Make sure the first row has headings like Name, Balance, Monthly, Due date.</p>${warnList()}`;
    return;
  }
  const typeOpts = Object.entries(S.DEBT_TYPES).map(([k, t]) => [k, t.label]);
  out.innerHTML = `<p class="meta pad">Found ${imp.rows.length} debt${imp.rows.length === 1 ? '' : 's'}. Check the type of each one and untick any you don't want.</p>
    <div class="import-preview" tabindex="0" role="region" aria-label="Debts found"><table>
      <thead><tr><th scope="col">Add</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col" class="num">Balance</th><th scope="col" class="num">Payment</th><th scope="col">Due</th></tr></thead>
      <tbody>${imp.rows.map((r, i) => {
        const bal = rowBalance(r);
        const pay = r.paymentAmount || r.plannedPayment || r.minDue || 0;
        const due = r.nextDue ? fmtDate(r.nextDue) : r.dueDay ? `Day ${r.dueDay}` : '';
        return `<tr>
          <td><label class="imp-hit"><input type="checkbox" data-imp-inc="${i}" ${imp.include[i] ? 'checked' : ''} aria-label="Add ${esc(r.name || 'this row')}"></label></td>
          <td${r.name ? '' : ' class="warn"'}>${esc(r.name || 'No name')}${imp.errors[i] ? `<br><small class="critical-text">${esc(imp.errors[i])}</small>` : ''}</td>
          <td><select data-imp-type="${i}" aria-label="Type for ${esc(r.name || 'this row')}">${typeOpts.map(([k, l]) => `<option value="${esc(k)}" ${imp.types[i] === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
          <td class="num${bal === null ? ' warn' : ''}">${bal === null ? 'Missing' : esc(peso(bal))}</td>
          <td class="num${pay ? '' : ' muted'}">${pay ? esc(peso(pay)) : '—'}${r.totalPayments ? ` <small>× ${esc(r.totalPayments - (r.paymentsMade || 0))} left</small>` : ''}</td>
          <td${due ? '' : ' class="muted"'}>${esc(due || '—')}</td></tr>`;
      }).join('')}</tbody></table></div>
    ${warnList()}
    <button type="button" class="btn primary block" data-action="importSave" data-ctx="${esc(ctx)}" ${n ? '' : 'disabled'}>Add ${n} debt${n === 1 ? '' : 's'}</button>`;
}
const warnList = () => (imp.warnings.length ? `<ul class="meta">${imp.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');

export function onImportChange(el) {
  const out = el.closest('[data-import-preview]');
  if (el.dataset.impInc !== undefined) imp.include[+el.dataset.impInc] = el.checked;
  if (el.dataset.impType !== undefined) imp.types[+el.dataset.impType] = el.value;
  const n = imp.include.filter(Boolean).length;
  const btn = out?.querySelector('[data-action=importSave]');
  if (btn) { btn.textContent = `Add ${n} debt${n === 1 ? '' : 's'}`; btn.disabled = !n; }
}

// Saves the ticked rows. Returns how many were added; failed rows stay in the preview with the reason.
export function importSave(btn) {
  const out = btn.closest('[data-import-preview]');
  let added = 0;
  const keep = { rows: [], include: [], types: [], errors: [] };
  imp.rows.forEach((r, i) => {
    if (!imp.include[i]) return;
    try {
      const input = { ...r, type: imp.types[i] };
      delete input.id;
      if (!Number.isFinite(input.balance)) { const b = rowBalance(r); if (b !== null) input.balance = b; }
      if (!String(input.name || '').trim()) throw new FormProblem('Needs a name');
      S.saveDebt(input);
      added++;
    } catch (e) {
      if (!isValidation(e)) throw e; // storage problems stop the whole import
      keep.rows.push(r); keep.include.push(true); keep.types.push(imp.types[i]); keep.errors.push(e.message);
    }
  });
  Object.assign(imp, keep, { warnings: keep.rows.length ? ['Fix these in your spreadsheet and paste them again, or add them one by one.'] : [] });
  if (out) drawPreview(out);
  return { added, failed: keep.rows.length };
}

// ================================================================== form handlers
export const FORMS = {
  async txn(form) {
    readDraft(form);
    const out = txnOut();
    const isNew = !out.id;
    const saved = out.kind === 'lend' && isNew ? S.lend(out) : S.saveTxn(out);
    if (draft.inboxId) X.settledBy(draft.inboxId, saved.id);
    remember(out);
    await S.flush();
    closeSheet();
    refresh();
    haptic();
    const d = out.kind === 'debt' && S.debt(out.debtId);
    const r = out.kind === 'collect' && S.receivable(out.receivableId);
    const msg = d && d.balance <= 0 ? `${d.name} is paid off!` : r && r.balance <= 0 ? `${r.name} paid you back in full` : isNew ? 'Saved' : 'Changes saved';
    const sub = budgetWarningText(budgetWarning(saved));
    const dup = isNew && !out.inboxId ? X.duplicateOf(saved) : null;
    if (dup) {
      // You typed what an alert already added: offer to keep one.
      toast(`Looks like ${peso(dup.amount)} ${dup.merchant || ''} from ${dup.conf?.[0]?.inst || 'an alert'}`.replace(/\s+/g, ' '), { icon: 'link', sub: 'Merge keeps one entry with your category and note', action: 'Merge', onAction: async () => { X.mergeInto(saved.id, dup.id); await S.flush(); refresh(); toast('Merged', { icon: 'check' }); } });
    } else if (isNew && saved?.id) toast(msg, { icon: 'check', sub, warn: !!sub, action: 'Undo', onAction: () => undoSaved(saved.id) });
    else toast(msg, { icon: 'check', sub, warn: !!sub });
  },
  async debt(form) {
    const f = new FormData(form);
    const type = String(f.get('type') || 'loan');
    const sched = ['loan', 'installment', 'lending'].includes(type);
    const name = str(f, 'name');
    if (!name) throw new FormProblem('Enter a name', 'name');
    const d = { type, name, lender: str(f, 'lender'), nextDue: f.get('nextDue') || null, notes: str(f, 'notes', 500) };
    const rate = optMoney(f, 'rate', 'interest rate');
    d.rate = rate || 0;
    if (form.dataset.id) d.id = form.dataset.id;
    let balance = optMoney(f, 'balance', 'balance');
    if (sched) {
      d.paymentAmount = reqMoney(f, 'paymentAmount', 'Enter the payment amount');
      d.frequency = String(f.get('frequency') || 'monthly');
      if (d.frequency === 'semimonthly') d.dueDays = readDueDays(f);
      d.totalPayments = intField(f, 'totalPayments', { min: 1, max: 999, msg: 'Enter the total number of payments (1 or more)' });
      d.paymentsMade = intField(f, 'paymentsMade', { min: 0, max: 999, blank: 0, msg: 'Enter how many payments you already made' });
      if (d.paymentsMade > d.totalPayments) throw new FormProblem("\"Already paid\" can't be more than the total payments", 'paymentsMade');
      if (balance === null) balance = round2(d.paymentAmount * (d.totalPayments - d.paymentsMade));
    } else if (type === 'card') {
      d.minDue = optMoney(f, 'minDue', 'minimum due') || 0;
      d.paymentAmount = d.minDue;
      d.creditLimit = optMoney(f, 'creditLimit', 'credit limit') || 0;
      d.plannedPayment = optMoney(f, 'plannedPayment', 'planned payment') || 0;
      d.frequency = 'monthly';
    } else {
      d.plannedPayment = optMoney(f, 'plannedPayment', 'planned payment') || 0;
      d.paymentAmount = 0;
    }
    if (balance === null) throw new FormProblem(type === 'card' ? 'Enter the current balance' : 'Enter how much is left to pay', 'balance');
    d.balance = balance;
    const saved = S.saveDebt(d);
    await S.flush();
    refresh();
    debtSheet(saved?.id ? S.debt(saved.id) || saved : S.debt(d.id));
    toast(form.dataset.id ? 'Debt updated' : 'Debt added');
  },
  async fixDebt(form) {
    const d = S.debt(form.dataset.id);
    if (!d) throw new FormProblem("That debt wasn't found");
    const f = new FormData(form);
    const target = optMoney(f, 'balance', 'balance');
    if (target === null) throw new FormProblem('Enter the correct balance', 'balance');
    const delta = round2(target - d.balance);
    if (!delta) { debtSheet(d); return toast('That is already the balance'); }
    S.saveTxn({ kind: 'adjust', debtId: d.id, amount: Math.abs(delta), direction: delta > 0 ? 'up' : 'down', reason: 'correction', date: today(), note: '' });
    await S.flush();
    refresh();
    debtSheet(S.debt(d.id));
    toast('Balance fixed');
  },
  async bill(form) {
    const f = new FormData(form);
    const name = str(f, 'name');
    if (!name) throw new FormProblem('Enter a name', 'name');
    const b = { name, amount: reqMoney(f, 'amount', 'Enter the amount'), frequency: String(f.get('frequency') || 'monthly'), nextDue: f.get('nextDue') || null, categoryId: f.get('categoryId') || null, done: false };
    if (!b.nextDue) throw new FormProblem('Pick the next due date', 'nextDue');
    if (b.frequency === 'semimonthly') b.dueDays = readDueDays(f);
    if (form.dataset.id) b.id = form.dataset.id;
    S.saveBill(b);
    await S.flush();
    closeSheet();
    refresh();
    toast(form.dataset.id ? 'Bill updated' : 'Bill added');
  },
  async goal(form) {
    const f = new FormData(form);
    const name = str(f, 'name', 40);
    if (!name) throw new FormProblem('Enter a name', 'name');
    const g = { name, emoji: str(f, 'emoji', 8) || '🎯', target: reqMoney(f, 'target', 'Enter a target amount'), deadline: f.get('deadline') || null };
    if (form.dataset.id) g.id = form.dataset.id;
    else g.saved = optMoney(f, 'saved', 'amount already saved') || 0;
    S.saveGoal(g);
    await S.flush();
    closeSheet();
    refresh();
    toast(form.dataset.id ? 'Goal updated' : 'Goal added');
  },
  async cat(form) {
    const f = new FormData(form);
    const name = str(f, 'name', 40);
    if (!name) throw new FormProblem('Enter a name', 'name');
    const c = { name, emoji: str(f, 'emoji', 8) || '🏷️', limit: optMoney(f, 'limit', 'limit') || 0, keywords: str(f, 'keywords', 200), hidden: f.get('hidden') === 'on' };
    if (form.dataset.id) c.id = form.dataset.id;
    S.saveCategory(c);
    await S.flush();
    closeSheet();
    refresh();
  },
  async settings(form) {
    const f = new FormData(form);
    S.setPayday(readPayday(form), optMoney(f, 'payAmount', 'paycheck') || 0);
    await S.flush();
    refresh();
    toast('Payday saved');
  },
  async wallet(form) {
    const f = new FormData(form);
    const name = str(f, 'name', 30);
    if (!name) throw new FormProblem('Enter a name', 'name');
    const kind = WALLET_KINDS[f.get('kind')] ? String(f.get('kind')) : 'ewallet';
    const bal = optMoney(f, 'balance', 'balance');
    const a = form.dataset.id && S.account(form.dataset.id);
    if (a) {
      // A changed balance becomes a visible, undoable "Balance fix" entry (never spending or income).
      S.saveAccount({ ...a, name, kind });
      const fix = bal !== null ? S.fixWalletBalance(a.id, bal) : null;
      await S.flush();
      haptic();
      refresh();
      walletSheet(a.id);
      if (fix) toast('Balance fixed', { icon: 'check', sub: `${fix.direction === 'up' ? '+' : '−'}${peso(fix.amount)} recorded as a balance fix`, action: 'Undo', onAction: () => undoSaved(fix.id) });
      else toast('Wallet updated', { icon: 'check' });
    } else {
      const saved = S.saveAccount({ name, kind, opening: bal || 0, openingDate: today() });
      await S.flush();
      refresh();
      if (saved?.id) walletSheet(saved.id); else closeSheet();
      toast('Wallet added');
    }
  },
  async balances(form) {
    saveBalances(form);
    await S.flush();
    closeSheet();
    refresh();
    toast('Balances saved');
  },
};
