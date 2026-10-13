import * as S from './store.js';
import { db } from './store.js';
import {
  peso, esc, parseAmount, today, addDays, daysBetween, fmtDate, relDay, monthKey, monthLabel, shiftMonth,
  FREQS, round2, advance, toISO, parseISO,
} from './util.js';
import { categoryBars, incomeVsSpending, debtLine, mountCharts, resetCharts } from './charts.js';

const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');
const ui = { tab: 'home', planTab: 'goals', reportMonth: monthKey(today()), filter: 'all', search: '', showPaid: false };

// ============================================================ rendering
function render({ keepScroll = false } = {}) {
  resetCharts();
  const y = window.scrollY;
  main.innerHTML = VIEWS[ui.tab]();
  mountCharts(main);
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === (ui.tab === 'activity' ? 'home' : ui.tab)));
  window.scrollTo(0, keepScroll ? y : 0);
}
const refresh = () => render({ keepScroll: true });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

const header = (title, right = '', sub = '') =>
  `<header class="top"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="top-actions">${right}</div></header>`;

const bar = (pct, cls = '') => `<div class="progress ${cls}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

const statusChip = (s) =>
  ({
    overdue: '<span class="chip critical">⚠︎ Overdue</span>',
    soon: '<span class="chip warning">⏰ Due soon</span>',
    paid: '<span class="chip good">✓ Paid off</span>',
  })[s] || '';

function txnIcon(t) {
  if (t.kind === 'income') return '💰';
  if (t.kind === 'debt') return S.DEBT_TYPES[S.debt(t.debtId)?.type]?.icon || '💸';
  if (t.kind === 'goal') return S.goal(t.goalId)?.emoji || '🎯';
  return S.cat(t.categoryId).emoji;
}
function txnTitle(t) {
  if (t.note) return t.note;
  if (t.kind === 'income') return 'Income';
  if (t.kind === 'debt') return `Payment · ${S.debt(t.debtId)?.name || 'Deleted debt'}`;
  if (t.kind === 'goal') return `${t.withdraw ? 'Took from' : 'Saved to'} ${S.goal(t.goalId)?.name || 'goal'}`;
  return S.cat(t.categoryId).name;
}
function txnSub(t) {
  const parts = [];
  if (t.kind === 'expense') {
    if (t.note) parts.push(S.cat(t.categoryId).name);
    if (t.cardId) parts.push(`on ${S.debt(t.cardId)?.name || 'card'}`);
  }
  if (t.kind === 'debt' && t.note) parts.push(S.debt(t.debtId)?.name || '');
  if (t.kind === 'goal' && t.note) parts.push(S.goal(t.goalId)?.name || '');
  return parts.filter(Boolean).join(' · ');
}
function txnRow(t, showDate = true) {
  const plus = t.kind === 'income' || (t.kind === 'goal' && t.withdraw);
  const sub = [txnSub(t), showDate ? fmtDate(t.date) : ''].filter(Boolean).join(' · ');
  return `<li class="row" data-action="editTxn" data-id="${t.id}">
    <span class="icon">${txnIcon(t)}</span>
    <span class="grow"><span class="title">${esc(txnTitle(t))}</span>${sub ? `<span class="meta">${esc(sub)}</span>` : ''}</span>
    <span class="num ${plus ? 'pos' : ''}">${plus ? '+' : '−'}${peso(t.amount)}</span>
  </li>`;
}

function dueRow(it) {
  const late = it.due < today();
  return `<li class="row">
    <span class="icon">${it.icon}</span>
    <span class="grow"><span class="title">${esc(it.name)}</span>
      <span class="meta ${late ? 'critical-text' : ''}">${late ? '⚠︎ Overdue · ' : ''}${fmtDate(it.due)} · ${relDay(it.due)}</span></span>
    <span class="col-end"><span class="num">${peso(it.amount)}</span>
      <button class="btn small" data-action="payItem" data-kind="${it.kind}" data-id="${it.id}">Pay</button></span>
  </li>`;
}

// ============================================================ views
const VIEWS = {
  home() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    const income = S.sumBy(list, 'income');
    const spent = S.sumBy(list, 'expense');
    const cashOut = round2(list.filter((t) => t.kind === 'expense' && !t.cardId).reduce((s, t) => s + t.amount, 0) + S.sumBy(list, 'debt') + S.sumBy(list, 'goal'));
    const left = round2(income - cashOut);
    const due = S.upcoming(p.end);
    const dueTotal = round2(due.reduce((s, d) => s + d.amount, 0));
    const free = round2(left - dueTotal);
    const toPayday = daysBetween(today(), p.next);
    const budgets = db.categories.filter((c) => c.limit > 0);
    const recent = [...db.txns].sort(byDateDesc).slice(0, 6);
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;

    return `${header('Pitaka', `<button class="icon-btn" data-action="settings" aria-label="Settings">⚙︎</button>`,
      `Pay period ${fmtDate(p.start)} – ${fmtDate(p.end)} · payday ${toPayday === 1 ? 'tomorrow' : `in ${toPayday} days`}`)}

    ${!standalone && !db.settings.hideInstallHint ? `<div class="card hint"><b>Install on your iPhone:</b> in Safari tap <b>Share</b> → <b>Add to Home Screen</b>. It then opens full screen and works offline.
      <button class="link" data-action="hideHint">Dismiss</button></div>` : ''}

    <section class="card hero">
      <p class="label">Free to spend until payday</p>
      <p class="big num ${free < 0 ? 'critical-text' : ''}">${peso(free)}</p>
      ${income === 0
        ? `<p class="meta">You haven't logged a paycheck for this period yet.</p>
           <button class="btn primary" data-action="logPaycheck">＋ Log paycheck${db.settings.payAmount ? ` (${peso(db.settings.payAmount)})` : ''}</button>`
        : `<p class="meta">${peso(left)} left from income − ${peso(dueTotal)} still due before payday</p>`}
    </section>

    <div class="tiles">
      <button class="tile" data-action="tab" data-tab="activity"><span class="label">Spent this period</span><span class="num">${peso(spent)}</span></button>
      <button class="tile" data-action="tab" data-tab="debts"><span class="label">Total debt</span><span class="num">${peso(S.totalDebt())}</span></button>
    </div>

    <section>
      <h2>Due before payday</h2>
      ${due.length ? `<ul class="list card">${due.map(dueRow).join('')}</ul>` : `<p class="empty card">Nothing due before your next payday 🎉</p>`}
    </section>

    <section>
      <h2>Budgets this pay period <button class="link" data-action="goPlan" data-sub="budgets">Edit</button></h2>
      ${budgets.length
        ? `<ul class="list card">${budgets.map((c) => budgetRow(c, list)).join('')}</ul>`
        : `<p class="empty card">Set spending limits per category so you know when to slow down. <button class="link" data-action="goPlan" data-sub="budgets">Set limits</button></p>`}
    </section>

    ${db.goals.length ? `<section><h2>Savings goals <button class="link" data-action="goPlan" data-sub="goals">See all</button></h2>
      <ul class="list card">${db.goals.map(goalRow).join('')}</ul></section>` : ''}

    <section>
      <h2>Recent <button class="link" data-action="tab" data-tab="activity">See all</button></h2>
      ${recent.length ? `<ul class="list card">${recent.map((t) => txnRow(t)).join('')}</ul>` : `<p class="empty card">Tap ＋ to log your first expense.</p>`}
    </section>`;
  },

  activity() {
    const chips = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['debt', 'Debt payments'], ['goal', 'Savings']];
    return `${header('Activity', `<button class="icon-btn" data-action="tab" data-tab="home" aria-label="Back">✕</button>`)}
      <input class="search" type="search" placeholder="Search" value="${esc(ui.search)}" data-input="search">
      <div class="chips scroll">${chips.map(([k, l]) => `<button class="chip-btn ${ui.filter === k ? 'on' : ''}" data-action="filter" data-f="${k}">${l}</button>`).join('')}</div>
      <div id="act-list">${activityList()}</div>`;
  },

  debts() {
    const order = { overdue: 0, soon: 1, ok: 2, paid: 3 };
    const active = db.debts.filter((d) => d.balance > 0).sort((a, b) => order[S.debtStatus(a)] - order[S.debtStatus(b)] || (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const paid = db.debts.filter((d) => d.balance <= 0);
    const dates = active.map(S.payoffDate);
    const freeBy = active.length && dates.every(Boolean) ? dates.sort().at(-1) : null;
    return `${header('Debts', `<button class="btn primary small" data-action="debtForm">＋ Add</button>`)}
      <section class="card hero">
        <p class="label">Total you owe</p>
        <p class="big num">${peso(S.totalDebt())}</p>
        <div class="split">
          <div><span class="label">Payments / month</span><span class="num">${peso(S.monthlyObligations())}</span></div>
          <div><span class="label">Debt-free by</span><span class="num">${freeBy ? fmtDate(freeBy, { month: 'short', year: 'numeric' }) : active.length ? '—' : '🎉'}</span></div>
        </div>
      </section>
      ${active.length ? `<ul class="cards">${active.map(debtCard).join('')}</ul>` : `<p class="empty card">No debts tracked yet. Add your credit cards, loans, installments, lending apps and money you owe people.</p>`}
      ${paid.length ? `<button class="link block" data-action="togglePaid">${ui.showPaid ? 'Hide' : 'Show'} paid off (${paid.length})</button>
        ${ui.showPaid ? `<ul class="cards">${paid.map(debtCard).join('')}</ul>` : ''}` : ''}`;
  },

  plan() {
    const tabs = [['goals', 'Goals'], ['bills', 'Bills'], ['budgets', 'Budgets']];
    return `${header('Plan')}
      <div class="segmented">${tabs.map(([k, l]) => `<button class="${ui.planTab === k ? 'on' : ''}" data-action="planTab" data-sub="${k}">${l}</button>`).join('')}</div>
      ${PLAN[ui.planTab]()}`;
  },

  reports() {
    const m = ui.reportMonth;
    const list = db.txns.filter((t) => monthKey(t.date) === m);
    const income = S.sumBy(list, 'income'), spent = S.sumBy(list, 'expense'), debtPaid = S.sumBy(list, 'debt'), saved = S.sumBy(list, 'goal');
    const byCat = {};
    for (const t of list) if (t.kind === 'expense') byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount;
    const rows = Object.entries(byCat).map(([id, value]) => ({ ...S.cat(id), value: round2(value) })).sort((a, b) => b.value - a.value);
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5)).map((key) => {
      const l = db.txns.filter((t) => monthKey(t.date) === key);
      return { key, income: S.sumBy(l, 'income'), spent: S.sumBy(l, 'expense') };
    });
    const hist = Object.entries(db.debtHistory).sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => d >= addDays(today(), -365)).map(([date, value]) => ({ date, value }));
    const top = list.filter((t) => t.kind === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);
    const net = round2(income - spent - debtPaid - saved);
    const isNow = m === monthKey(today());
    return `${header('Reports')}
      <div class="month-nav"><button class="icon-btn" data-action="month" data-d="-1" aria-label="Previous month">‹</button>
        <b>${monthLabel(m, true)}</b>
        <button class="icon-btn" data-action="month" data-d="1" ${isNow ? 'disabled' : ''} aria-label="Next month">›</button></div>
      <div class="tiles four">
        <div class="tile"><span class="label">Income</span><span class="num">${peso(income)}</span></div>
        <div class="tile"><span class="label">Spent</span><span class="num">${peso(spent)}</span></div>
        <div class="tile"><span class="label">Debt paid</span><span class="num">${peso(debtPaid)}</span></div>
        <div class="tile"><span class="label">Saved</span><span class="num">${peso(saved)}</span></div>
      </div>
      <p class="net card">${net >= 0 ? 'Left over' : 'Over by'} <b class="num ${net < 0 ? 'critical-text' : ''}">${peso(Math.abs(net))}</b> after spending, debt payments and savings</p>
      <section><h2>Where your money went</h2><div class="card">${categoryBars(rows)}</div></section>
      <section><h2>Income vs spending</h2><div class="card">${incomeVsSpending(months)}</div></section>
      <section><h2>Total debt over time</h2><div class="card">${debtLine(hist)}</div></section>
      ${top.length ? `<section><h2>Biggest expenses</h2><ul class="list card">${top.map((t) => txnRow(t)).join('')}</ul></section>` : ''}`;
  },
};

function activityList() {
  const q = ui.search.trim().toLowerCase();
  const rows = [...db.txns]
    .filter((t) => ui.filter === 'all' || t.kind === ui.filter)
    .filter((t) => !q || `${txnTitle(t)} ${txnSub(t)} ${S.cat(t.categoryId).name}`.toLowerCase().includes(q))
    .sort(byDateDesc);
  if (!rows.length) return `<p class="empty card">Nothing here yet.</p>`;
  const groups = {};
  for (const t of rows) (groups[t.date] ||= []).push(t);
  return Object.entries(groups).map(([d, ts]) => `<h3 class="date-h">${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}</h3>
    <ul class="list card">${ts.map((t) => txnRow(t, false)).join('')}</ul>`).join('');
}

const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);

function budgetRow(c, periodTxns) {
  const spent = round2(periodTxns.filter((t) => t.kind === 'expense' && t.categoryId === c.id).reduce((s, t) => s + t.amount, 0));
  const pct = (spent / c.limit) * 100;
  const state = pct > 100 ? 'critical' : pct >= 80 ? 'warning' : '';
  return `<li class="row stack" data-action="catForm" data-id="${c.id}">
    <div class="row-line"><span>${c.emoji} ${esc(c.name)}</span>
      <span class="num">${peso(spent)} <small>of ${peso(c.limit)}</small></span></div>
    ${bar(pct, state)}
    ${state ? `<span class="meta ${state}-text">${pct > 100 ? `⚠︎ Over by ${peso(spent - c.limit)}` : `⏰ ${peso(c.limit - spent)} left`}</span>` : ''}
  </li>`;
}

function goalPlan(g) {
  const remaining = Math.max(0, g.target - g.saved);
  if (!remaining) return 'Goal reached 🎉';
  if (!g.deadline) return `${peso(remaining)} to go`;
  const n = S.paydaysUntil(g.deadline);
  if (g.deadline < today()) return `${peso(remaining)} to go · deadline passed`;
  return n > 0 ? `Save ${peso(Math.ceil(remaining / n))} per payday · ${n} payday${n > 1 ? 's' : ''} left` : `${peso(remaining)} needed by ${fmtDate(g.deadline)}`;
}
function goalRow(g) {
  return `<li class="row stack" data-action="goalSheet" data-id="${g.id}">
    <div class="row-line"><span>${esc(g.emoji || '🎯')} ${esc(g.name)}</span><span class="num">${peso(g.saved)} <small>of ${peso(g.target)}</small></span></div>
    ${bar((g.saved / g.target) * 100, g.saved >= g.target ? 'good' : '')}
    <span class="meta">${goalPlan(g)}${g.deadline ? ` · by ${fmtDate(g.deadline)}` : ''}</span>
  </li>`;
}

function debtLeftText(d) {
  const left = S.paymentsLeft(d);
  if (d.balance <= 0) return 'Paid off';
  if (S.isScheduled(d)) return `<b>${left}</b> of ${d.totalPayments} payments left`;
  if (left === Infinity) return `⚠︎ Payment doesn't cover the interest`;
  if (left) return `~<b>${left}</b> payment${left > 1 ? 's' : ''} left at ${peso(d.plannedPayment || d.paymentAmount)}`;
  return 'Set a planned payment to see payments left';
}
function debtCard(d) {
  const st = S.debtStatus(d);
  const pct = d.original ? (1 - d.balance / d.original) * 100 : 0;
  const t = S.DEBT_TYPES[d.type];
  const pay = d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment;
  return `<li class="card debt ${st}" data-action="debtSheet" data-id="${d.id}">
    <div class="row-line"><span class="title">${t.icon} ${esc(d.name)}</span><span class="num big-ish">${peso(Math.max(0, d.balance))}</span></div>
    <div class="row-line meta"><span>${t.label}${d.lender ? ` · ${esc(d.lender)}` : ''}</span>${statusChip(st)}</div>
    ${bar(pct, 'good')}
    <div class="row-line meta"><span>${debtLeftText(d)}</span>
      <span>${d.nextDue && d.balance > 0 ? `${pay ? `${peso(pay)} ` : ''}due ${fmtDate(d.nextDue)}` : ''}</span></div>
  </li>`;
}

const PLAN = {
  goals() {
    return `<button class="btn primary block" data-action="goalForm">＋ New savings goal</button>
      ${db.goals.length ? `<ul class="list card">${db.goals.map(goalRow).join('')}</ul>` : `<p class="empty card">Saving for a vacation, a gadget or an emergency fund? Add a goal and Pitaka tells you how much to put aside every payday.</p>`}`;
  },
  bills() {
    const bills = [...db.bills].sort((a, b) => (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const monthly = round2(bills.filter((b) => !b.done).reduce((s, b) => s + b.amount * ({ weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[b.frequency] || 0), 0));
    return `<button class="btn primary block" data-action="billForm">＋ New bill</button>
      ${bills.length ? `<p class="meta pad">About ${peso(monthly)} a month in bills</p><ul class="list card">${bills.map((b) => {
        const late = !b.done && b.nextDue < today();
        return `<li class="row" data-action="billForm" data-id="${b.id}">
          <span class="icon">${S.cat(b.categoryId).emoji}</span>
          <span class="grow"><span class="title">${esc(b.name)}</span>
          <span class="meta ${late ? 'critical-text' : ''}">${b.done ? 'Done' : `${late ? '⚠︎ Overdue · ' : ''}Due ${fmtDate(b.nextDue)} · ${relDay(b.nextDue)}`} · ${FREQS[b.frequency]}</span></span>
          <span class="col-end"><span class="num">${peso(b.amount)}</span>${b.done ? '' : `<button class="btn small" data-action="payItem" data-kind="bill" data-id="${b.id}">Paid</button>`}</span>
        </li>`;
      }).join('')}</ul>` : `<p class="empty card">Add rent, electricity, water, internet, phone plan, subscriptions… They show up on Home when they're due before your next payday.</p>`}`;
  },
  budgets() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    return `<p class="meta pad">Limits apply to each 2-week pay period (${fmtDate(p.start)} – ${fmtDate(p.end)}). Leave a limit at 0 to just track spending.</p>
      <ul class="list card">${db.categories.map((c) => c.limit > 0 ? budgetRow(c, list) : `<li class="row" data-action="catForm" data-id="${c.id}">
        <span class="icon">${c.emoji}</span><span class="grow"><span class="title">${esc(c.name)}</span><span class="meta">No limit</span></span><span class="chev">›</span></li>`).join('')}</ul>
      <button class="btn block" data-action="catForm">＋ New category</button>`;
  },
};

// ============================================================ sheets
function openSheet(html) {
  const s = $('#sheet');
  s.innerHTML = `<div class="sheet-backdrop" data-action="closeSheet"></div><div class="sheet-panel" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  s.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet() {
  const s = $('#sheet');
  s.classList.remove('open');
  document.body.classList.remove('sheet-open');
  setTimeout(() => { if (!s.classList.contains('open')) { s.hidden = true; s.innerHTML = ''; } }, 250);
}
const sheetHead = (title, right = '') => `<div class="sheet-head"><button class="link" data-action="closeSheet">Cancel</button><h2>${title}</h2><span>${right}</span></div>`;

const field = (label, input, hint = '') => `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
const money = (name, value, attrs = '') => `<div class="money"><span>₱</span><input name="${name}" inputmode="decimal" placeholder="0" value="${value ? value : ''}" ${attrs}></div>`;
const select = (name, options, value) => `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const freqSelect = (name, value, skip = []) => select(name, Object.entries(FREQS).filter(([k]) => !skip.includes(k)), value || 'monthly');

// ---------- transaction form ----------
let draft = null;
function txnForm(t) {
  draft = { kind: 'expense', date: today(), categoryId: db.categories[0]?.id, scheduled: true, ...t };
  renderTxnForm();
}
function renderTxnForm() {
  const t = draft;
  const kinds = [['expense', 'Expense'], ['income', 'Income'], ['debt', 'Pay debt'], ['goal', 'Savings']];
  const active = db.debts.filter((d) => d.balance > 0 || d.id === t.debtId);
  const cards = db.debts.filter((d) => d.type === 'card');
  let body = '';
  if (t.kind === 'expense') {
    body = `<div class="cat-grid">${db.categories.map((c) => `<label class="cat-opt"><input type="radio" name="categoryId" value="${c.id}" ${c.id === t.categoryId ? 'checked' : ''}><span>${c.emoji}</span><small>${esc(c.name)}</small></label>`).join('')}</div>
      ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="What was it for?" autocomplete="off">`)}
      ${cards.length ? field('Paid with', select('cardId', [['', 'Cash / debit / e-wallet'], ...cards.map((c) => [c.id, `💳 ${c.name}`])], t.cardId), 'Card purchases are added to that card\'s balance.') : ''}`;
  } else if (t.kind === 'income') {
    body = field('Source', `<input name="note" value="${esc(t.note || '')}" placeholder="Salary, freelance, gift…">`);
  } else if (t.kind === 'debt') {
    body = active.length
      ? `${field('Which debt?', select('debtId', active.map((d) => [d.id, `${S.DEBT_TYPES[d.type].icon} ${d.name} · ${peso(d.balance)}`]), t.debtId), '')}
        <label class="check"><input type="checkbox" name="scheduled" ${t.scheduled ? 'checked' : ''}><span>This is my scheduled payment<small>Moves the due date to the next one and counts toward payments left</small></span></label>
        ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional">`)}`
      : `<p class="empty">Add a debt first in the Debts tab.</p>`;
  } else {
    body = db.goals.length
      ? `${field('Goal', select('goalId', db.goals.map((g) => [g.id, `${g.emoji || '🎯'} ${g.name}`]), t.goalId))}
        <div class="segmented small"><label><input type="radio" name="withdraw" value="" ${!t.withdraw ? 'checked' : ''}><span>Add money</span></label><label><input type="radio" name="withdraw" value="1" ${t.withdraw ? 'checked' : ''}><span>Take out</span></label></div>
        ${field('Note', `<input name="note" value="${esc(t.note || '')}" placeholder="Optional">`)}`
      : `<p class="empty">Create a savings goal first in Plan → Goals.</p>`;
  }
  openSheet(`${sheetHead(t.id ? 'Edit' : 'Add')}
    <form data-form="txn" autocomplete="off">
      ${t.id ? '' : `<div class="segmented">${kinds.map(([k, l]) => `<button type="button" class="${t.kind === k ? 'on' : ''}" data-action="txnKind" data-kind="${k}">${l}</button>`).join('')}</div>`}
      <div class="amount-big"><span>₱</span><input name="amount" inputmode="decimal" placeholder="0" value="${t.amount || ''}" ${t.id ? '' : 'autofocus'}></div>
      ${body}
      ${field('Date', `<input type="date" name="date" value="${t.date}" required>`)}
      <button class="btn primary block" type="submit">${t.id ? 'Save changes' : 'Save'}</button>
      ${t.id ? `<button class="btn danger block" type="button" data-action="deleteTxn" data-id="${t.id}">Delete</button>` : ''}
    </form>`);
  const amt = $('#sheet [name=amount]');
  sizeAmount(amt);
  if (!t.id) setTimeout(() => amt?.focus(), 50);
}
// Keep the ₱ sign hugging the number as it grows.
function sizeAmount(input) {
  if (input) input.style.width = `${Math.max(1, input.value.length || 1) + 0.5}ch`;
}
function readDraft(form) {
  const f = new FormData(form);
  for (const [k, v] of f.entries()) draft[k] = v;
  draft.scheduled = !!form.querySelector('[name=scheduled]')?.checked;
  draft.amount = parseAmount(f.get('amount'));
}

// ============================================================ actions
const ACTIONS = {
  tab: ({ tab }) => { ui.tab = tab; render(); },
  closeSheet,
  add: () => txnForm({}),
  settings: () => settingsSheet(),
  hideHint: () => { db.settings.hideInstallHint = true; S.save(); refresh(); },
  goPlan: ({ sub }) => { ui.tab = 'plan'; ui.planTab = sub; render(); },
  planTab: ({ sub }) => { ui.planTab = sub; refresh(); },
  filter: ({ f }) => { ui.filter = f; refresh(); },
  togglePaid: () => { ui.showPaid = !ui.showPaid; refresh(); },
  month: ({ d }) => { ui.reportMonth = shiftMonth(ui.reportMonth, Number(d)); refresh(); },

  logPaycheck: () => txnForm({ kind: 'income', amount: db.settings.payAmount || '', note: 'Salary' }),
  txnKind: ({ kind }) => { readDraft($('#sheet form')); draft.kind = kind; renderTxnForm(); },
  editTxn: ({ id }) => { const t = db.txns.find((x) => x.id === id); if (t) txnForm({ ...t, scheduled: !!(t.countsInstallment || t.advanceDue) }); },
  deleteTxn: ({ id }) => {
    if (!confirm('Delete this entry? Any debt, bill or goal it updated will be put back.')) return;
    S.deleteTxn(id); closeSheet(); refresh(); toast('Deleted');
  },
  payItem: ({ kind, id }) => {
    if (kind === 'bill') {
      const b = S.bill(id);
      txnForm({ kind: 'expense', amount: b.amount, categoryId: b.categoryId, note: b.name, billId: b.id });
    } else {
      const d = S.debt(id);
      const amt = d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment;
      txnForm({ kind: 'debt', debtId: d.id, amount: Math.min(amt || d.balance, d.balance), scheduled: true });
    }
  },

  debtForm: ({ id }) => debtForm(id ? S.debt(id) : null),
  debtSheet: ({ id }) => debtSheet(S.debt(id)),
  deleteDebt: ({ id }) => {
    if (!confirm('Delete this debt? Its payment history stays in Activity.')) return;
    S.deleteDebt(id); closeSheet(); refresh(); toast('Debt deleted');
  },
  payDebt: ({ id }) => ACTIONS.payItem({ kind: 'debt', id }),
  calendar: ({ kind, id }) => addToCalendar(kind === 'bill' ? S.bill(id) : S.debt(id), kind),

  billForm: ({ id }) => billForm(id ? S.bill(id) : null),
  deleteBill: ({ id }) => { if (confirm('Delete this bill?')) { S.deleteBill(id); closeSheet(); refresh(); } },

  goalForm: ({ id }) => goalForm(id ? S.goal(id) : null),
  goalSheet: ({ id }) => goalSheet(S.goal(id)),
  goalMoney: ({ id, w }) => txnForm({ kind: 'goal', goalId: id, withdraw: w ? '1' : '' }),
  deleteGoal: ({ id }) => { if (confirm('Delete this goal? Its deposits stay in Activity.')) { S.deleteGoal(id); closeSheet(); refresh(); } },

  catForm: ({ id }) => catForm(id ? db.categories.find((c) => c.id === id) : null),
  deleteCat: ({ id }) => {
    if (!confirm('Delete this category? Past expenses in it will show as Uncategorized.')) return;
    S.deleteCategory(id); closeSheet(); refresh();
  },
  pickEmoji: ({ e }) => { const i = $('#sheet [name=emoji]'); if (i) i.value = e; },

  setPin: () => { closeSheet(); Lock.start('set'); },
  removePin: () => { if (confirm('Turn off the PIN lock?')) { db.settings.pinHash = null; S.save(); settingsSheet(); toast('PIN removed'); } },
  exportData: () => exportBackup(),
  importData: () => $('#importFile').click(),
  eraseAll: () => {
    if (!confirm('Erase ALL data on this phone? This cannot be undone.')) return;
    if (!confirm('Really erase everything? Make a backup first if you might need it.')) return;
    S.resetAll(); location.reload();
  },
};

// ============================================================ debts
function debtForm(d) {
  const v = d || { type: 'loan', frequency: 'monthly', nextDue: addDays(today(), 7), rate: '' };
  const types = Object.entries(S.DEBT_TYPES);
  openSheet(`${sheetHead(d ? 'Edit debt' : 'New debt')}
    <form data-form="debt" data-id="${d?.id || ''}" data-type="${v.type}">
      <div class="type-grid">${types.map(([k, t]) => `<label><input type="radio" name="type" value="${k}" ${v.type === k ? 'checked' : ''}><span>${t.icon}</span><small>${t.label}</small></label>`).join('')}</div>
      ${field('Name', `<input name="name" required value="${esc(v.name || '')}" placeholder="e.g. BPI card, iPhone installment, Tita Mel">`)}
      ${field('Lender / person', `<input name="lender" value="${esc(v.lender || '')}" placeholder="Optional">`)}

      <div class="when sched">
        <div class="two">${field('Payment amount', money('paymentAmount', v.paymentAmount))}${field('How often', freqSelect('frequency', v.frequency))}</div>
        <div class="two">${field('Total payments', `<input name="totalPayments" inputmode="numeric" value="${v.totalPayments || ''}" placeholder="e.g. 12">`)}
          ${field('Already paid', `<input name="paymentsMade" inputmode="numeric" value="${v.paymentsMade || 0}">`)}</div>
      </div>
      <div class="when card-only">
        <div class="two">${field('Minimum due', money('minDue', v.paymentAmount))}${field('Credit limit', money('creditLimit', v.creditLimit))}</div>
      </div>
      <div class="when card-only person">
        ${field('I plan to pay', money('plannedPayment', v.plannedPayment), 'Per month. Used to estimate how many payments are left.')}
      </div>

      ${field('Remaining balance', money('balance', d ? v.balance : ''), '<span class="when sched">Leave blank to use payment × payments left.</span>')}
      ${field('Next due date', `<input type="date" name="nextDue" value="${v.nextDue || ''}">`, '<span class="when person">Optional for personal debts.</span>')}
      <div class="when sched card-only">${field('Interest rate (% per month)', `<input name="rate" inputmode="decimal" value="${v.rate ?? ''}" placeholder="${v.type === 'card' ? 'e.g. 3' : 'Optional'}">`)}</div>
      ${field('Notes', `<textarea name="notes" rows="2" placeholder="Account number, terms…">${esc(v.notes || '')}</textarea>`)}
      <button class="btn primary block" type="submit">Save debt</button>
      ${d ? `<button class="btn danger block" type="button" data-action="deleteDebt" data-id="${d.id}">Delete debt</button>` : ''}
    </form>`);
}

function debtSheet(d) {
  const t = S.DEBT_TYPES[d.type];
  const left = S.paymentsLeft(d);
  const payoff = S.payoffDate(d);
  const pays = db.txns.filter((x) => x.kind === 'debt' && x.debtId === d.id).sort(byDateDesc);
  const charges = db.txns.filter((x) => x.kind === 'expense' && x.cardId === d.id).sort(byDateDesc);
  // Installments may have been paid before tracking started, so count those too.
  const paidSoFar = S.isScheduled(d) ? round2((d.paymentsMade || 0) * d.paymentAmount) : round2(pays.reduce((s, x) => s + x.amount, 0));
  const pay = d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment;
  const st = S.debtStatus(d);
  const stats = [
    ['Balance', `<span class="num">${peso(Math.max(0, d.balance))}</span>`],
    S.isScheduled(d) ? ['Payments left', `<b>${left}</b> of ${d.totalPayments}`] : ['Payments left', left === Infinity ? 'Never at this rate' : left ? `~${left}` : '—'],
    ['Next due', d.nextDue && d.balance > 0 ? `${fmtDate(d.nextDue)} <small>(${relDay(d.nextDue)})</small>` : '—'],
    [d.type === 'card' ? 'Minimum due' : 'Payment', pay ? `${peso(d.type === 'card' ? d.paymentAmount || 0 : pay)}${S.isScheduled(d) ? ` <small>${FREQS[d.frequency].toLowerCase()}</small>` : ''}` : '—'],
    ['Paid off by', payoff ? fmtDate(payoff, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'],
    ['Paid so far', peso(paidSoFar)],
  ];
  if (d.type === 'card' && d.creditLimit) stats.push(['Available credit', peso(Math.max(0, d.creditLimit - d.balance))]);
  if (d.rate) stats.push(['Interest', `${d.rate}% / month`]);
  if (S.isScheduled(d) && left) stats.push(['Still to pay', peso(Math.max(0, d.balance))]);

  openSheet(`${sheetHead(`${t.icon} ${esc(d.name)}`, `<button class="link" data-action="debtForm" data-id="${d.id}">Edit</button>`)}
    <p class="meta center">${t.label}${d.lender ? ` · ${esc(d.lender)}` : ''} ${statusChip(st)}</p>
    ${d.original ? `${bar((1 - d.balance / d.original) * 100, 'good')}<p class="meta center">${Math.round(Math.max(0, (1 - d.balance / d.original) * 100))}% paid off</p>` : ''}
    <dl class="stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ''}
    <div class="actions">
      ${d.balance > 0 ? `<button class="btn primary" data-action="payDebt" data-id="${d.id}">Log payment</button>` : ''}
      ${d.nextDue && d.balance > 0 ? `<button class="btn" data-action="calendar" data-kind="debt" data-id="${d.id}">📅 Remind me</button>` : ''}
    </div>
    <h3>Payment history</h3>
    ${pays.length ? `<ul class="list">${pays.map((x) => txnRow(x)).join('')}</ul>` : '<p class="empty">No payments logged yet.</p>'}
    ${charges.length ? `<h3>Charges on this card</h3><ul class="list">${charges.slice(0, 20).map((x) => txnRow(x)).join('')}</ul>` : ''}`);
}

// ============================================================ bills / goals / categories
function billForm(b) {
  const v = b || { frequency: 'monthly', nextDue: today(), categoryId: db.categories.find((c) => /bill/i.test(c.name))?.id };
  openSheet(`${sheetHead(b ? 'Edit bill' : 'New bill')}
    <form data-form="bill" data-id="${b?.id || ''}">
      ${field('Name', `<input name="name" required value="${esc(v.name || '')}" placeholder="e.g. Rent, Meralco, PLDT, Netflix">`)}
      <div class="two">${field('Amount', money('amount', v.amount))}${field('How often', freqSelect('frequency', v.frequency))}</div>
      ${field('Next due date', `<input type="date" name="nextDue" required value="${v.nextDue || today()}">`)}
      ${field('Category', select('categoryId', db.categories.map((c) => [c.id, `${c.emoji} ${c.name}`]), v.categoryId))}
      <button class="btn primary block" type="submit">Save bill</button>
      ${b ? `<button class="btn block" type="button" data-action="calendar" data-kind="bill" data-id="${b.id}">📅 Add reminder to Calendar</button>
        <button class="btn danger block" type="button" data-action="deleteBill" data-id="${b.id}">Delete bill</button>` : ''}
    </form>`);
}

const GOAL_EMOJI = ['✈️', '🏖️', '🎁', '🚗', '🏠', '💍', '🎓', '📱', '🆘', '🎄'];
function goalForm(g) {
  const v = g || { emoji: '✈️' };
  openSheet(`${sheetHead(g ? 'Edit goal' : 'New goal')}
    <form data-form="goal" data-id="${g?.id || ''}">
      <div class="emoji-row">${GOAL_EMOJI.map((e) => `<button type="button" data-action="pickEmoji" data-e="${e}">${e}</button>`).join('')}</div>
      <div class="two narrow-first">${field('Icon', `<input name="emoji" value="${esc(v.emoji || '')}" maxlength="4">`)}${field('Name', `<input name="name" required value="${esc(v.name || '')}" placeholder="e.g. Japan trip">`)}</div>
      ${field('Target amount', money('target', v.target, 'required'))}
      ${field('Target date', `<input type="date" name="deadline" value="${v.deadline || ''}">`, 'Optional. Pitaka works out how much to save each payday.')}
      ${g ? '' : field('Already saved', money('saved', v.saved))}
      <button class="btn primary block" type="submit">Save goal</button>
      ${g ? `<button class="btn danger block" type="button" data-action="deleteGoal" data-id="${g.id}">Delete goal</button>` : ''}
    </form>`);
}
function goalSheet(g) {
  const deps = db.txns.filter((t) => t.kind === 'goal' && t.goalId === g.id).sort(byDateDesc);
  openSheet(`${sheetHead(`${esc(g.emoji || '🎯')} ${esc(g.name)}`, `<button class="link" data-action="goalForm" data-id="${g.id}">Edit</button>`)}
    <p class="big num center">${peso(g.saved)}</p><p class="meta center">of ${peso(g.target)}${g.deadline ? ` by ${fmtDate(g.deadline)}` : ''}</p>
    ${bar((g.saved / g.target) * 100, g.saved >= g.target ? 'good' : '')}
    <p class="center plan-line">${goalPlan(g)}</p>
    <div class="actions"><button class="btn primary" data-action="goalMoney" data-id="${g.id}">＋ Add money</button><button class="btn" data-action="goalMoney" data-id="${g.id}" data-w="1">Take out</button></div>
    <h3>History</h3>${deps.length ? `<ul class="list">${deps.map((t) => txnRow(t)).join('')}</ul>` : '<p class="empty">Nothing saved yet.</p>'}`);
}
function catForm(c) {
  const v = c || { emoji: '🏷️', limit: 0 };
  openSheet(`${sheetHead(c ? 'Edit category' : 'New category')}
    <form data-form="cat" data-id="${c?.id || ''}">
      <div class="two narrow-first">${field('Icon', `<input name="emoji" value="${esc(v.emoji)}" maxlength="4">`)}${field('Name', `<input name="name" required value="${esc(v.name || '')}">`)}</div>
      ${field('Limit per pay period', money('limit', v.limit), '2 weeks. 0 = no limit.')}
      <button class="btn primary block" type="submit">Save</button>
      ${c ? `<button class="btn danger block" type="button" data-action="deleteCat" data-id="${c.id}">Delete category</button>` : ''}
    </form>`);
}

// ============================================================ settings
function settingsSheet() {
  const s = db.settings;
  openSheet(`${sheetHead('Settings')}
    <form data-form="settings">
      <h3>Payday</h3>
      ${field('A recent payday', `<input type="date" name="payAnchor" value="${s.payAnchor}">`, 'You get paid every 2 weeks counting from this date.')}
      ${field('Usual paycheck', money('payAmount', s.payAmount), 'Pre-fills "Log paycheck".')}
      <button class="btn primary block" type="submit">Save</button>
    </form>
    <h3>Security</h3>
    <div class="list card">
      <button class="row" data-action="setPin"><span class="grow">${s.pinHash ? 'Change PIN' : 'Set a PIN lock'}</span><span class="chev">›</span></button>
      ${s.pinHash ? `<button class="row" data-action="removePin"><span class="grow">Turn off PIN</span><span class="chev">›</span></button>` : ''}
    </div>
    <h3>Backup</h3>
    <p class="meta">Your data is only stored on this iPhone. Save a backup to Files or iCloud Drive now and then so you don't lose it if the phone is lost or reset.</p>
    <div class="list card">
      <button class="row" data-action="exportData"><span class="grow">Save backup file</span><span class="chev">›</span></button>
      <button class="row" data-action="importData"><span class="grow">Restore from backup</span><span class="chev">›</span></button>
    </div>
    <h3>Danger zone</h3>
    <button class="btn danger block" data-action="eraseAll">Erase all data</button>
    <p class="meta center">Pitaka · private, on-device · ${db.txns.length} entries</p>`);
}

async function exportBackup() {
  const name = `pitaka-backup-${today()}.json`;
  const file = new File([JSON.stringify(db, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ============================================================ calendar reminders (.ics)
async function addToCalendar(item, kind) {
  const freqRule = { weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', semimonthly: 'FREQ=MONTHLY;BYMONTHDAY=15,-1', monthly: 'FREQ=MONTHLY', quarterly: 'FREQ=MONTHLY;INTERVAL=3', yearly: 'FREQ=YEARLY' };
  const freq = kind === 'debt' && item.type === 'card' ? 'monthly' : item.frequency || (kind === 'debt' && item.type === 'person' ? 'once' : 'monthly');
  const amount = kind === 'bill' ? item.amount : item.type === 'card' ? item.plannedPayment || item.paymentAmount : item.paymentAmount || item.plannedPayment;
  let rule = freqRule[freq] || '';
  if (rule && kind === 'debt') {
    const left = S.paymentsLeft(item);
    if (left && left !== Infinity) rule += `;COUNT=${left}`;
  }
  const d = item.nextDue.replace(/-/g, '');
  const end = addDays(item.nextDue, 1).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pitaka//EN', 'BEGIN:VEVENT',
    `UID:${item.id}-${Date.now()}@pitaka`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:Pay ${item.name}${amount ? ` (₱${amount.toLocaleString('en-PH')})` : ''}`,
    rule ? `RRULE:${rule}` : '',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:Pay ${item.name}`, 'TRIGGER:-PT15H', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${item.name} is due today`, 'TRIGGER:PT9H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const file = new File([ics], `${item.name.replace(/[^\w]+/g, '-')}.ics`, { type: 'text/calendar' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  a.click();
  toast('Open the file to add it to Calendar');
}

// ============================================================ forms
const num = (v) => parseAmount(v);
const FORMS = {
  txn(form) {
    readDraft(form);
    const t = draft;
    if (!(t.amount > 0)) return toast('Enter an amount');
    const out = { id: t.id, kind: t.kind, amount: t.amount, date: t.date || today(), note: (t.note || '').trim() };
    if (t.kind === 'expense') {
      out.categoryId = t.categoryId;
      if (t.cardId) out.cardId = t.cardId;
      if (t.billId) out.billId = t.billId;
    } else if (t.kind === 'debt') {
      if (!t.debtId) return toast('Add a debt first');
      out.debtId = t.debtId;
      out.countsInstallment = t.scheduled;
      out.advanceDue = t.scheduled;
    } else if (t.kind === 'goal') {
      if (!t.goalId) return toast('Create a goal first');
      out.goalId = t.goalId;
      out.withdraw = !!t.withdraw;
    }
    if (t.id) {
      // Clear fields that no longer apply after an edit.
      const old = db.txns.find((x) => x.id === t.id);
      for (const k of ['cardId', 'debtId', 'goalId', 'withdraw', 'countsInstallment', 'advanceDue']) if (!(k in out)) delete old[k];
    }
    S.saveTxn(out);
    closeSheet();
    refresh();
    const d = out.debtId && S.debt(out.debtId);
    toast(d && d.balance <= 0 ? `🎉 ${d.name} is paid off!` : 'Saved');
  },
  debt(form) {
    const f = new FormData(form);
    const type = f.get('type');
    const sched = ['loan', 'installment', 'lending'].includes(type);
    const d = {
      id: form.dataset.id || undefined,
      type,
      name: f.get('name').trim(),
      lender: f.get('lender').trim(),
      nextDue: f.get('nextDue') || null,
      notes: f.get('notes').trim(),
      rate: num(f.get('rate')) || 0,
    };
    let balance = f.get('balance').trim() === '' ? null : num(f.get('balance'));
    if (sched) {
      d.paymentAmount = num(f.get('paymentAmount'));
      d.frequency = f.get('frequency');
      d.totalPayments = parseInt(f.get('totalPayments'), 10) || 0;
      d.paymentsMade = Math.min(parseInt(f.get('paymentsMade'), 10) || 0, d.totalPayments);
      if (!d.paymentAmount || !d.totalPayments) return toast('Enter the payment amount and total payments');
      if (balance === null) balance = round2(d.paymentAmount * (d.totalPayments - d.paymentsMade));
    } else if (type === 'card') {
      d.paymentAmount = num(f.get('minDue'));
      d.creditLimit = num(f.get('creditLimit'));
      d.plannedPayment = num(f.get('plannedPayment'));
    } else {
      d.plannedPayment = num(f.get('plannedPayment'));
      d.paymentAmount = 0;
    }
    if (balance === null) return toast('Enter the remaining balance');
    d.balance = balance;
    if (!d.id) delete d.id;
    const saved = S.saveDebt(d);
    closeSheet();
    refresh();
    debtSheet(saved);
  },
  bill(form) {
    const f = new FormData(form);
    const b = { name: f.get('name').trim(), amount: num(f.get('amount')), frequency: f.get('frequency'), nextDue: f.get('nextDue'), categoryId: f.get('categoryId'), done: false };
    if (form.dataset.id) b.id = form.dataset.id;
    if (!b.amount) return toast('Enter an amount');
    S.saveBill(b);
    closeSheet();
    refresh();
  },
  goal(form) {
    const f = new FormData(form);
    const g = { name: f.get('name').trim(), emoji: f.get('emoji').trim() || '🎯', target: num(f.get('target')), deadline: f.get('deadline') || null };
    if (!g.target) return toast('Enter a target amount');
    if (form.dataset.id) g.id = form.dataset.id;
    else g.saved = num(f.get('saved'));
    S.saveGoal(g);
    closeSheet();
    refresh();
  },
  cat(form) {
    const f = new FormData(form);
    const c = { name: f.get('name').trim(), emoji: f.get('emoji').trim() || '🏷️', limit: num(f.get('limit')) };
    if (form.dataset.id) c.id = form.dataset.id;
    S.saveCategory(c);
    closeSheet();
    refresh();
  },
  settings(form) {
    const f = new FormData(form);
    db.settings.payAnchor = f.get('payAnchor') || today();
    db.settings.payAmount = num(f.get('payAmount'));
    S.save();
    closeSheet();
    refresh();
    toast('Saved');
  },
  onboard(form) {
    const f = new FormData(form);
    db.settings.payAnchor = f.get('payAnchor') || today();
    db.settings.payAmount = num(f.get('payAmount'));
    db.settings.onboarded = true;
    S.save();
    $('#onboard').hidden = true;
    render();
    if (f.get('pin')) Lock.start('set');
  },
};

// ============================================================ PIN lock
async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const Lock = {
  mode: null, entry: '', first: '', hiddenAt: 0,
  el: () => $('#lock'),
  start(mode) {
    this.mode = mode; this.entry = ''; this.first = '';
    this.el().hidden = false;
    document.body.classList.add('locked');
    this.draw();
  },
  draw(err = '') {
    const title = { unlock: 'Enter PIN', set: 'Choose a 4-digit PIN', confirm: 'Enter it again' }[this.mode];
    $('#lock-title').textContent = title;
    $('#lock-err').textContent = err;
    $('#lock-dots').innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i < this.entry.length ? 'on' : ''}"></i>`).join('');
    $('#lock-cancel').hidden = this.mode === 'unlock';
    $('#lock-forgot').hidden = this.mode !== 'unlock';
  },
  async press(k) {
    if (k === 'del') this.entry = this.entry.slice(0, -1);
    else if (this.entry.length < 4) this.entry += k;
    this.draw();
    if (this.entry.length < 4) return;
    const pin = this.entry;
    this.entry = '';
    if (this.mode === 'unlock') {
      if ((await hashPin(pin, db.settings.pinSalt)) === db.settings.pinHash) return this.close();
      this.el().classList.add('shake');
      setTimeout(() => this.el().classList.remove('shake'), 400);
      return this.draw('Wrong PIN');
    }
    if (this.mode === 'set') { this.first = pin; this.mode = 'confirm'; return this.draw(); }
    if (pin !== this.first) { this.mode = 'set'; return this.draw("PINs didn't match. Try again."); }
    db.settings.pinSalt = crypto.getRandomValues(new Uint32Array(2)).join('');
    db.settings.pinHash = await hashPin(pin, db.settings.pinSalt);
    S.save();
    this.close();
    toast('PIN set');
  },
  close() {
    this.el().hidden = true;
    document.body.classList.remove('locked');
    this.mode = null;
  },
  forgot() {
    if (!confirm('The only way to reset a forgotten PIN is to erase all data on this phone (you can restore a backup afterwards). Erase everything?')) return;
    S.resetAll();
    location.reload();
  },
};

// ============================================================ events
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn({ ...el.dataset });
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  FORMS[form.dataset.form](form);
});
document.addEventListener('input', (e) => {
  if (e.target.closest('.amount-big')) sizeAmount(e.target);
  if (e.target.dataset.input === 'search') {
    ui.search = e.target.value;
    $('#act-list').innerHTML = activityList();
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  const form = t.closest('form');
  if (form?.dataset.form === 'debt' && t.name === 'type') form.dataset.type = t.value;
  if (form?.dataset.form === 'txn' && t.name === 'debtId') {
    const d = S.debt(t.value);
    const amt = d && (d.type === 'card' ? d.plannedPayment || d.paymentAmount : d.paymentAmount || d.plannedPayment);
    if (amt) { form.amount.value = Math.min(amt, d.balance); sizeAmount(form.amount); }
  }
});
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm(`Replace everything on this phone with the backup (${data.txns?.length ?? 0} entries)?`)) return;
    S.replaceAll(data);
    location.reload();
  } catch (err) {
    alert(`Could not restore: ${err.message}`);
  }
});
document.querySelectorAll('#lock [data-k]').forEach((b) => b.addEventListener('click', () => Lock.press(b.dataset.k)));
$('#lock-cancel').addEventListener('click', () => Lock.close());
$('#lock-forgot').addEventListener('click', () => Lock.forgot());
document.addEventListener('keydown', (e) => {
  if (!Lock.mode) return;
  if (/^\d$/.test(e.key)) Lock.press(e.key);
  if (e.key === 'Backspace') Lock.press('del');
});

// Re-lock after the app has been in the background for a while.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) Lock.hiddenAt = Date.now();
  else {
    if (db.settings.pinHash && !Lock.mode && Date.now() - Lock.hiddenAt > db.settings.lockAfterSec * 1000) Lock.start('unlock');
    refresh(); // dates may have rolled over
  }
});

// ============================================================ boot
S.load();
if (db.settings.pinHash) Lock.start('unlock');
if (!db.settings.onboarded) {
  $('#onboard').hidden = false;
  $('#onboard [name=payAnchor]').value = today();
}
render();
navigator.storage?.persist?.();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js');
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}

// Exposed for quick debugging from the console.
window.pitaka = { db: () => db, S, toISO, parseISO, advance };
