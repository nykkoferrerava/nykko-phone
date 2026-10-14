// Tab screens (Home, Activity, Debts, Plan, Reports) and the row builders they share with sheets.
import * as S from './store.js';
import { db } from './store.js';
import { peso, esc, today, daysBetween, fmtDate, relDay, monthKey, monthLabel, shiftMonth, FREQS, round2, addDays, PER_MONTH } from './util.js';
import { categoryBars, incomeVsSpending, debtLine, mountCharts, resetCharts } from './charts.js';
import { $, $$, ui, pw, icon, pref, header, bar, accounts, isStandalone, bannerHtml } from './ui-core.js';

export const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0);

export function render({ keepScroll = false } = {}) {
  resetCharts();
  const y = window.scrollY;
  const main = $('#main');
  try {
    main.innerHTML = VIEWS[ui.tab]();
    mountCharts(main);
  } catch (e) {
    console.error(e);
    main.innerHTML = `${header('Pitaka', settingsBtn())}<div class="card"><p>Something went wrong showing this screen. Your data is still saved on this phone.</p>
      <div class="actions"><button class="btn" data-action="exportData">Save backup</button><button class="btn" data-action="tab" data-tab="home">Go to Home</button></div></div>`;
  }
  const active = ui.tab === 'activity' ? 'home' : ui.tab;
  for (const b of $$('.tabbar [data-tab]')) {
    const on = b.dataset.tab === active;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, keepScroll ? y : 0);
}
export const refresh = () => render({ keepScroll: true });

const settingsBtn = () => `<button class="icon-btn" data-action="settings" aria-label="Settings">${icon('settings')}</button>`;

// ------------------------------------------------------------------ shared pieces
export const minDue = (d) => Number(d.minDue ?? d.paymentAmount) || 0;
// The amount one scheduled payment is expected to be.
export const schedPay = (d) => (d.type === 'card' ? d.plannedPayment || minDue(d) : d.paymentAmount || d.plannedPayment) || 0;
export const debtTypeOf = (d) => S.DEBT_TYPES[d?.type] || { label: 'Debt', icon: '💸' };
export const debtName = (t) => S.debt(t.debtId)?.name || t.debtName || 'Deleted debt';
export const goalName = (t) => S.goal(t.goalId)?.name || t.goalName || 'Deleted goal';
export const walletName = (id) => S.account(id)?.name || 'Deleted wallet';
export const REASONS = { fee: 'Fee', interest: 'Interest', penalty: 'Penalty', correction: 'Balance fix' };

export const statusChip = (s) =>
  ({
    overdue: `<span class="chip critical">${icon('alert')} Overdue</span>`,
    soon: `<span class="chip warning">${icon('clock')} Due soon</span>`,
    paid: `<span class="chip good">${icon('check')} Paid off</span>`,
  })[s] || '';

// icon (html), title, sub, sign (+1 / -1 / 0) and whether a plus reads as good news.
function describe(t, ctx, wid) {
  const many = accounts().length > 1;
  switch (t.kind) {
    case 'income':
      return { icon: '💰', title: t.note || 'Income', sub: many ? `to ${walletName(t.accountId)}` : '', sign: 1, good: true };
    case 'debt': {
      const n = Number(t.installments);
      const extra = n === 0 ? 'extra payment' : n > 1 ? `covers ${n} payments` : '';
      return {
        icon: esc(debtTypeOf(S.debt(t.debtId)).icon), title: t.note || `Payment · ${debtName(t)}`,
        sub: [t.note ? debtName(t) : '', extra, many && ctx !== 'wallet' ? `from ${walletName(t.accountId)}` : ''].filter(Boolean).join(' · '), sign: -1,
      };
    }
    case 'goal': {
      const e = esc(S.goal(t.goalId)?.emoji || '🎯');
      if (ctx === 'goal') return { icon: e, title: t.note || (t.withdraw ? 'Took out' : 'Added'), sub: t.note ? (t.withdraw ? 'Took out' : 'Added') : '', sign: t.withdraw ? -1 : 1, good: !t.withdraw };
      return { icon: e, title: t.note || `${t.withdraw ? 'Took from' : 'Saved to'} ${goalName(t)}`, sub: t.note ? goalName(t) : '', sign: t.withdraw ? 1 : -1, good: !!t.withdraw };
    }
    case 'transfer': {
      const path = `${walletName(t.accountId)} → ${walletName(t.toAccountId)}`;
      const sign = ctx === 'wallet' ? (t.toAccountId === wid ? 1 : -1) : 0;
      return { icon: icon('swap'), title: t.note || 'Moved money', sub: path, sign, good: sign > 0 };
    }
    case 'adjust': {
      const r = REASONS[t.reason] || 'Adjustment';
      const what = `${r} · ${debtName(t)}`;
      return { icon: icon(t.reason === 'correction' ? 'edit' : 'alert'), title: t.note || what, sub: t.note ? what : t.direction === 'down' ? 'Taken off the balance' : 'Added to the balance', sign: t.direction === 'down' ? -1 : 1 };
    }
    default: {
      const c = S.cat(t.categoryId);
      const card = t.cardId ? `on ${S.debt(t.cardId)?.name || t.cardName || 'deleted card'}` : '';
      const from = !card && many && ctx !== 'wallet' ? `from ${walletName(t.accountId)}` : '';
      return { icon: esc(c.emoji), title: t.note || c.name, sub: [t.note ? c.name : '', card || from].filter(Boolean).join(' · '), sign: ctx === 'debt' ? 1 : -1 };
    }
  }
}
export const txnText = (t) => { const d = describe(t, '', ''); return `${d.title} ${d.sub}`; };

export function txnRow(t, { showDate = true, ctx = '', walletId = '' } = {}) {
  const d = describe(t, ctx, walletId);
  const sub = [d.sub, showDate ? fmtDate(t.date) : ''].filter(Boolean).join(' · ');
  const sign = d.sign > 0 ? '+' : d.sign < 0 ? '−' : '';
  return `<li class="row" role="button" tabindex="0" data-action="editTxn" data-id="${esc(t.id)}">
    <span class="icon" aria-hidden="true">${d.icon}</span>
    <span class="grow"><span class="title">${esc(d.title)}</span>${sub ? `<span class="meta">${esc(sub)}</span>` : ''}</span>
    <span class="num ${d.good ? 'pos' : ''}">${sign}${esc(peso(t.amount))}</span>
  </li>`;
}

function dueRow(it) {
  const d = it.kind === 'debt' ? S.debt(it.id) : null;
  const late = it.late ?? it.due < today();
  const when = `${late ? 'Overdue · ' : ''}${fmtDate(it.due)} · ${relDay(it.due)}`;
  const card = d?.type === 'card' ? [d.plannedPayment ? `plan ${pw(d.plannedPayment)}` : '', minDue(d) ? `min ${pw(minDue(d))}` : ''].filter(Boolean).join(' · ') : '';
  return `<li class="row">
    <span class="icon" aria-hidden="true">${esc(it.icon)}</span>
    <span class="grow"><span class="title">${esc(it.name)}</span>
      <span class="meta ${late ? 'critical-text' : ''}">${late ? icon('alert') : ''}${esc(when)}</span>${card ? `<span class="meta">${esc(card)}</span>` : ''}</span>
    <span class="col-end"><span class="num">${esc(peso(it.amount))}</span>
      <button class="btn small" data-action="payItem" data-kind="${esc(it.kind)}" data-id="${esc(it.id)}" aria-label="Pay ${esc(it.name)}">Pay</button></span>
  </li>`;
}

export function budgetRow(c, periodTxns) {
  const spent = round2(periodTxns.filter((t) => t.kind === 'expense' && t.categoryId === c.id).reduce((s, t) => s + t.amount, 0));
  const pct = (spent / c.limit) * 100;
  const state = pct > 100 ? 'critical' : pct >= 80 ? 'warning' : '';
  return `<li class="row stack" role="button" tabindex="0" data-action="catForm" data-id="${esc(c.id)}">
    <div class="row-line"><span>${esc(c.emoji)} ${esc(c.name)}</span>
      <span class="num">${pw(spent)} <small>of ${pw(c.limit)}</small></span></div>
    ${bar(pct, state, `${c.name} budget used`)}
    ${state ? `<span class="meta ${state}-text">${pct > 100 ? `Over by ${pw(spent - c.limit)}` : `${pw(c.limit - spent)} left`}</span>` : ''}
  </li>`;
}

export function goalPlanText(g) {
  const p = S.goalPlan(g);
  if (p.status === 'reached') return 'Goal reached';
  if (p.status === 'no-deadline') return `${pw(p.remaining)} to go`;
  if (p.status === 'overdue') return `${pw(p.remaining)} to go · target date passed`;
  if (p.perPayday > 0) {
    const done = p.depositedThisPeriod >= p.perPayday;
    return `Put aside ${pw(p.perPayday)} per payday · ${p.paydaysLeft} payday${p.paydaysLeft === 1 ? '' : 's'} left${done ? ' · done for this payday' : ''}`;
  }
  return `${pw(p.remaining)} needed by ${fmtDate(g.deadline)}`;
}
export function goalRow(g) {
  return `<li class="row stack" role="button" tabindex="0" data-action="goalSheet" data-id="${esc(g.id)}">
    <div class="row-line"><span>${esc(g.emoji || '🎯')} ${esc(g.name)}</span><span class="num">${pw(g.saved)} <small>of ${pw(g.target)}</small></span></div>
    ${bar((g.saved / g.target) * 100, g.saved >= g.target ? 'good' : '', `${g.name} progress`)}
    <span class="meta">${esc(goalPlanText(g))}${g.deadline ? ` · by ${esc(fmtDate(g.deadline))}` : ''}</span>
  </li>`;
}

export function debtLeftText(d) {
  const left = S.paymentsLeft(d);
  if (d.balance <= 0) return 'Paid off';
  if (S.isScheduled(d)) return `<b>${esc(left)}</b> of ${esc(d.totalPayments)} payments left`;
  if (left === Infinity) return `Payment doesn't cover the interest`;
  if (left) return `About <b>${esc(left)}</b> payment${left > 1 ? 's' : ''} left at ${pw(schedPay(d))}`;
  return 'Add a planned payment to see payments left';
}
function debtCard(d) {
  const st = S.debtStatus(d);
  const T = debtTypeOf(d);
  let progress, left, due = '', warn = '';
  if (d.type === 'card') {
    if (d.creditLimit > 0) {
      const pct = (Math.max(0, d.balance) / d.creditLimit) * 100;
      progress = bar(pct, pct >= 100 ? 'critical' : pct >= 70 ? 'warning' : '', 'Credit limit used');
      left = `${pw(Math.max(0, d.balance))} of ${pw(d.creditLimit)} limit used`;
    } else { progress = ''; left = debtLeftText(d); }
    if (d.nextDue && d.balance > 0) due = `${minDue(d) ? `Min ${pw(minDue(d))} · ` : ''}due ${fmtDate(d.nextDue)}`;
    if (d.creditLimit > 0 && S.paymentsLeft(d) === Infinity) warn = `<p class="meta critical-text">${icon('alert')} Your planned payment doesn't cover the interest</p>`;
  } else {
    progress = d.original > 0 ? bar((1 - d.balance / d.original) * 100, 'good', 'Paid off so far') : '';
    left = debtLeftText(d);
    const pay = schedPay(d);
    if (d.nextDue && d.balance > 0) due = `${pay ? `${pw(Math.min(pay, d.balance))} ` : ''}due ${fmtDate(d.nextDue)}`;
  }
  return `<li class="card debt ${st}" role="button" tabindex="0" data-action="debtSheet" data-id="${esc(d.id)}">
    <div class="row-line"><span class="title">${esc(T.icon)} ${esc(d.name)}</span><span class="num big-ish">${pw(Math.max(0, d.balance))}</span></div>
    <div class="row-line meta"><span>${esc(T.label)}${d.lender ? ` · ${esc(d.lender)}` : ''}</span>${statusChip(st)}</div>
    ${progress}
    <div class="row-line meta"><span>${left}</span><span>${esc(due)}</span></div>
    ${warn}
  </li>`;
}

// ------------------------------------------------------------------ Home helpers
function setupState() {
  const items = [
    { label: 'Log your paycheck', sub: 'So Pitaka can tell what you can spend', done: db.txns.some((t) => t.kind === 'income'), action: 'logPaycheck' },
    { label: 'Add your debts', sub: 'Paste them from your spreadsheet, or add them one by one', done: db.debts.length > 0, action: 'addDebtMenu' },
    { label: 'Add your bills', sub: 'Rent, Meralco, water, internet…', done: db.bills.length > 0, action: 'billForm' },
    { label: 'Set spending limits', sub: 'Per category, for each pay period', done: db.categories.some((c) => c.limit > 0), action: 'goPlan', extra: 'data-sub="budgets"' },
    { label: 'Back up your data', sub: 'Save a copy to Files or iCloud Drive', done: !!db.settings.lastBackupAt, action: 'exportData' },
  ];
  const left = items.filter((i) => !i.done).length;
  return { items, show: left > 0 && db.txns.length < 20 && pref.get('setupHidden') !== '1' };
}
function setupCard(st) {
  return `<section aria-labelledby="setup-h"><h2 id="setup-h">Get set up <button class="link" data-action="hideSetup">Hide</button></h2>
    <ul class="list card">${st.items.map((i) => (i.done
    ? `<li class="row"><span class="icon good-text" aria-hidden="true">${icon('check')}</span><span class="grow"><span class="title muted">${i.label}</span><span class="meta">Done</span></span></li>`
    : `<li class="row" role="button" tabindex="0" data-action="${i.action}" ${i.extra || ''}><span class="icon" aria-hidden="true">${icon('plus')}</span><span class="grow"><span class="title">${i.label}</span><span class="meta">${i.sub}</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></li>`)).join('')}</ul></section>`;
}

function heroCard(fs, hasMoney) {
  if (!hasMoney) {
    return `<section class="card hero"><p class="label">Free to spend until payday</p><p class="big num" aria-label="Not known yet">—</p>
      <p class="meta">Log your paycheck or enter what's in your wallets, and Pitaka shows what you can spend until payday.</p>
      <div class="actions"><button class="btn primary" data-action="logPaycheck">Log paycheck</button><button class="btn" data-action="balancesForm">Enter balances</button></div></section>`;
  }
  const short = fs.free < 0;
  const cols = [['In your wallets', fs.cash], ['Due before payday', fs.due]];
  if (fs.setAside > 0) cols.push(['Set aside for goals', fs.setAside]);
  return `<section class="card hero">
    <p class="label">${short ? 'Short before payday' : 'Free to spend until payday'}</p>
    <p class="big num${short ? ' short' : ''}">${pw(Math.abs(fs.free))}</p>
    ${short ? `<p class="meta">What's due before payday is more than what's in your wallets.</p>` : ''}
    ${fs.hasIncomeThisPeriod ? '' : `<button class="btn primary" data-action="logPaycheck">Log paycheck${db.settings.payAmount ? ` · ${pw(db.settings.payAmount)}` : ''}</button>`}
    <div class="split"${cols.length === 3 ? ' style="grid-template-columns:repeat(3,minmax(0,1fr))"' : ''}>${cols.map(([l, v]) => `<div><span class="label">${l}</span><span class="num">${pw(v)}</span></div>`).join('')}</div>
  </section>`;
}

function walletsRow() {
  const list = accounts();
  if (!list.length) return '';
  return `<div class="wallets" aria-label="Wallets">${list.map((a) => `<button class="wallet${S.accountBalance(a.id) < 0 ? ' neg' : ''}" data-action="walletSheet" data-id="${esc(a.id)}"><span class="label">${esc(a.name)}</span><span class="num">${esc(peso(S.accountBalance(a.id)))}</span></button>`).join('')}
    <button class="wallet add" data-action="walletForm">${icon('plus')}Add wallet</button></div>`;
}

function backupBanner() {
  let st;
  try { st = S.backupStatus(); } catch { return ''; }
  if (!st?.due) return '';
  const when = st.daysSince === null || st.daysSince === undefined ? 'no backup yet' : st.daysSince === 0 ? 'last backup today' : `last backup ${st.daysSince} day${st.daysSince === 1 ? '' : 's'} ago`;
  return bannerHtml({ level: 'warning', icon: 'download', title: 'Back up your data', text: `${when[0].toUpperCase()}${when.slice(1)}${st.newEntries ? ` · ${st.newEntries} new entries since` : ''}`, actions: [['Save backup', 'exportData', 'primary']] });
}

// ------------------------------------------------------------------ views
export const VIEWS = {
  home() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    const spent = S.sumBy(list, 'expense');
    const fs = S.freeToSpend();
    const toPayday = daysBetween(today(), p.next);
    const setup = setupState();
    const hasMoney = db.txns.some((t) => t.kind === 'income') || accounts().some((a) => Number(a.opening)) || fs.cash !== 0;
    const due = fs.dueItems || S.upcoming(p.end);
    const budgets = db.categories.filter((c) => c.limit > 0);
    const recent = [...db.txns].sort(byDateDesc).slice(0, 6);
    const anyPlans = db.bills.some((b) => !b.done) || db.debts.some((d) => d.balance > 0);
    const totalDebt = S.totalDebt();
    const tiles = [
      !setup.show || spent > 0 ? `<button class="tile" data-action="tab" data-tab="activity"><span class="label">Spent this pay period</span><span class="num">${pw(spent)}</span></button>` : '',
      !setup.show || totalDebt > 0 ? `<button class="tile" data-action="tab" data-tab="debts"><span class="label">Total debt</span><span class="num">${pw(totalDebt)}</span></button>` : '',
    ].filter(Boolean);
    const showHint = !isStandalone() && !db.settings.hideInstallHint;

    return `${header('Pitaka', settingsBtn(),
      `${esc(fmtDate(p.start))} – ${esc(fmtDate(p.end))} <span class="nowrap">· payday ${toPayday <= 1 ? (toPayday === 1 ? 'tomorrow' : 'today') : `in ${toPayday} days`}</span>`)}
    ${backupBanner()}
    ${heroCard(fs, hasMoney)}
    ${walletsRow()}
    ${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}
    ${setup.show ? setupCard(setup) : ''}

    ${due.length || anyPlans || !setup.show ? `<section><h2>Due before payday</h2>
      ${due.length ? `<ul class="list card">${due.map(dueRow).join('')}</ul>`
        : anyPlans ? `<p class="empty card">Nothing else is due before payday.</p>`
          : `<p class="empty card">Add your bills and debts to see what's due before payday.</p>`}
    </section>` : ''}

    ${budgets.length ? `<section><h2>Budgets this pay period <button class="link" data-action="goPlan" data-sub="budgets">Edit</button></h2>
      <ul class="list card">${budgets.map((c) => budgetRow(c, list)).join('')}</ul></section>`
      : setup.show ? '' : `<section><h2>Budgets this pay period</h2><p class="empty card">Set spending limits per category so you know when to slow down. <button class="link" data-action="goPlan" data-sub="budgets">Set limits</button></p></section>`}

    ${db.goals.length ? `<section><h2>Savings goals <button class="link" data-action="goPlan" data-sub="goals">See all</button></h2>
      <ul class="list card">${db.goals.map(goalRow).join('')}</ul></section>` : ''}

    <section>
      <h2>Recent ${recent.length ? '<button class="link" data-action="tab" data-tab="activity">See all</button>' : ''}</h2>
      ${recent.length ? `<ul class="list card">${recent.map((t) => txnRow(t)).join('')}</ul>` : `<p class="empty card">Tap ＋ to log your first expense.</p>`}
    </section>

    ${showHint ? `<section><p class="card hint meta"><b>Pitaka is open in the browser.</b> What you add here stays in this browser and won't show up in the Home Screen app. To install: save a backup, then in Safari tap Share → Add to Home Screen, open Pitaka from your Home Screen and restore the backup there.
      <button class="link" data-action="hideHint">Got it</button></p></section>` : ''}`;
  },

  activity() {
    const chips = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['debt', 'Debts'], ['goal', 'Savings'], ['transfer', 'Transfers']];
    return `${header('Activity', `<button class="icon-btn" data-action="tab" data-tab="home" aria-label="Back to Home">${icon('x')}</button>`)}
      <input class="search" type="search" placeholder="Search" aria-label="Search entries" value="${esc(ui.search)}" data-input="search" autocomplete="off">
      <div class="chips scroll">${chips.map(([k, l]) => `<button class="chip-btn ${ui.filter === k ? 'on' : ''}" aria-pressed="${ui.filter === k}" data-action="filter" data-f="${k}">${l}</button>`).join('')}</div>
      <div id="act-list">${activityList()}</div>`;
  },

  debts() {
    const order = { overdue: 0, soon: 1, ok: 2, paid: 3 };
    const active = db.debts.filter((d) => d.balance > 0).sort((a, b) => order[S.debtStatus(a)] - order[S.debtStatus(b)] || (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const paid = db.debts.filter((d) => d.balance <= 0);
    const dates = active.map(S.payoffDate);
    const freeBy = active.length && dates.every(Boolean) ? [...dates].sort().at(-1) : null;
    const add = `<button class="btn primary small" data-action="addDebtMenu">${icon('plus')}Add</button>`;
    if (!db.debts.length) {
      return `${header('Debts')}
        <section class="card center"><p class="big">No debts</p>
          <p class="meta">Add your credit cards, loans, installments, lending apps and money you owe people. Already tracking them in a spreadsheet? Paste them in.</p>
          <button class="btn primary block" data-action="importSheet">${icon('upload')}Paste from a spreadsheet</button>
          <button class="btn block" data-action="debtForm">Add one by one</button></section>`;
    }
    return `${header('Debts', add)}
      <section class="card hero">
        <p class="label">Total you owe</p>
        <p class="big num">${active.length ? pw(S.totalDebt()) : 'No debts'}</p>
        <div class="split">
          <div><span class="label">Monthly payments</span><span class="num">${pw(S.monthlyObligations())}</span></div>
          <div><span class="label">Debt-free by</span><span class="num">${freeBy ? esc(fmtDate(freeBy, { month: 'short', year: 'numeric' })) : active.length ? '—' : 'Now'}</span></div>
        </div>
      </section>
      ${active.length ? `<ul class="cards">${active.map(debtCard).join('')}</ul>` : `<p class="empty card">Everything is paid off.</p>`}
      ${paid.length ? `<button class="link block" data-action="togglePaid" aria-expanded="${ui.showPaid}">${ui.showPaid ? 'Hide' : 'Show'} paid off (${paid.length})</button>
        ${ui.showPaid ? `<ul class="cards">${paid.map(debtCard).join('')}</ul>` : ''}` : ''}`;
  },

  plan() {
    const tabs = [['goals', 'Goals'], ['bills', 'Bills'], ['budgets', 'Budgets']];
    return `${header('Plan')}
      <div class="segmented">${tabs.map(([k, l]) => `<button class="${ui.planTab === k ? 'on' : ''}" aria-pressed="${ui.planTab === k}" data-action="planTab" data-sub="${k}">${l}</button>`).join('')}</div>
      ${PLAN[ui.planTab]()}`;
  },

  reports() {
    const m = ui.reportMonth;
    const isNow = m >= monthKey(today());
    const nav = `${header('Reports')}
      <div class="month-nav"><button class="icon-btn" data-action="month" data-d="-1" aria-label="Previous month">${icon('left')}</button>
        <b aria-live="polite">${esc(monthLabel(m, true))}</b>
        <button class="icon-btn" data-action="month" data-d="1" ${isNow ? 'disabled' : ''} aria-label="Next month">${icon('right')}</button></div>`;
    const sum = S.monthSummary(m);
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5)).map((key) => {
      const s = key === m ? sum : S.monthSummary(key);
      return { key, income: s.income, spent: s.spent };
    });
    const hist = Object.entries(db.debtHistory || {}).sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => d >= addDays(today(), -365)).map(([date, value]) => ({ date, value }));
    const charts = `${months.some((x) => x.income || x.spent) ? `<section><h2>Income vs spending</h2><div class="card">${incomeVsSpending(months)}</div></section>` : ''}
      ${hist.length > 1 ? `<section><h2>Total debt over time</h2><div class="card">${debtLine(hist)}</div></section>` : ''}`;
    if (!sum.count) return `${nav}<p class="empty card">No entries in ${esc(monthLabel(m, true))}.</p>${charts}`;
    const top = db.txns.filter((t) => t.kind === 'expense' && monthKey(t.date) === m).sort((a, b) => b.amount - a.amount).slice(0, 5);
    return `${nav}
      <div class="tiles four">
        <div class="tile"><span class="label">Income</span><span class="num">${pw(sum.income)}</span></div>
        <div class="tile"><span class="label">Spent</span><span class="num">${pw(sum.spent)}</span></div>
        <div class="tile"><span class="label">Debt paid</span><span class="num">${pw(sum.debtPaid)}</span></div>
        <div class="tile"><span class="label">Saved</span><span class="num">${pw(sum.saved)}</span></div>
      </div>
      <p class="net card">${sum.net >= 0 ? 'Left over' : 'Over by'} <b class="num ${sum.net < 0 ? 'critical-text' : ''}">${pw(Math.abs(sum.net))}</b> after spending, debt payments and savings</p>
      ${sum.spentOnCards > 0 ? `<p class="meta pad">${pw(sum.spentOnCards)} of the spending was on credit cards. It counts against what's left over when you pay the card.</p>` : ''}
      ${sum.fees > 0 ? `<p class="meta pad">Fees and interest added to your debts: ${pw(sum.fees)}</p>` : ''}
      <section><h2>Where your money went</h2><div class="card">${categoryBars(sum.byCategory)}</div></section>
      ${charts}
      ${top.length ? `<section><h2>Biggest expenses</h2><ul class="list card">${top.map((t) => txnRow(t)).join('')}</ul></section>` : ''}`;
  },
};

export function activityList() {
  const q = ui.search.trim().toLowerCase();
  const match = (t) => ui.filter === 'all' || t.kind === ui.filter || (ui.filter === 'debt' && t.kind === 'adjust');
  const rows = db.txns
    .filter(match)
    .filter((t) => !q || `${txnText(t)} ${t.kind === 'expense' ? S.cat(t.categoryId).name : ''}`.toLowerCase().includes(q))
    .sort(byDateDesc);
  if (!rows.length) return `<p class="empty card">${q || ui.filter !== 'all' ? 'No entries match.' : 'Nothing here yet. Tap ＋ to log an expense.'}</p>`;
  const groups = {};
  for (const t of rows) (groups[t.date] ||= []).push(t);
  return Object.entries(groups).map(([d, ts]) => `<h3 class="date-h">${esc(fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }))}</h3>
    <ul class="list card">${ts.map((t) => txnRow(t, { showDate: false })).join('')}</ul>`).join('');
}

const PLAN = {
  goals() {
    return `<button class="btn primary block" data-action="goalForm">${icon('plus')}New savings goal</button>
      ${db.goals.length ? `<ul class="list card">${db.goals.map(goalRow).join('')}</ul>` : `<p class="empty card">Saving for a vacation, a gadget or an emergency fund? Add a goal and Pitaka tells you how much to put aside every payday.</p>`}`;
  },
  bills() {
    const bills = [...db.bills].sort((a, b) => (a.done - b.done) || (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const monthly = round2(bills.filter((b) => !b.done).reduce((s, b) => s + b.amount * (PER_MONTH[b.frequency] || 0), 0));
    return `<button class="btn primary block" data-action="billForm">${icon('plus')}New bill</button>
      ${bills.length ? `<p class="meta pad">About ${pw(monthly)} a month in bills</p><ul class="list card">${bills.map((b) => {
        const late = !b.done && b.nextDue && b.nextDue < today();
        const when = b.done ? 'Done' : b.nextDue ? `${late ? 'Overdue · ' : ''}Due ${fmtDate(b.nextDue)} · ${relDay(b.nextDue)}` : 'No due date';
        return `<li class="row" role="button" tabindex="0" data-action="billForm" data-id="${esc(b.id)}">
          <span class="icon" aria-hidden="true">${esc(S.cat(b.categoryId).emoji)}</span>
          <span class="grow"><span class="title">${esc(b.name)}</span>
          <span class="meta ${late ? 'critical-text' : ''}">${esc(when)} · ${esc(FREQS[b.frequency] || '')}</span></span>
          <span class="col-end"><span class="num">${esc(peso(b.amount))}</span>${b.done ? '' : `<button class="btn small" data-action="payItem" data-kind="bill" data-id="${esc(b.id)}" aria-label="Pay ${esc(b.name)}">Pay</button>`}</span>
        </li>`;
      }).join('')}</ul>` : `<p class="empty card">Add rent, electricity, water, internet, phone plan, subscriptions… They show up on Home when they're due before your next payday.</p>`}`;
  },
  budgets() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    return `<p class="meta pad">Spending limits for each 2-week pay period (now ${esc(fmtDate(p.start))} – ${esc(fmtDate(p.end))}). Leave a limit at 0 to just track spending.</p>
      <ul class="list card">${db.categories.map((c) => (c.limit > 0 ? budgetRow(c, list) : `<li class="row" role="button" tabindex="0" data-action="catForm" data-id="${esc(c.id)}">
        <span class="icon" aria-hidden="true">${esc(c.emoji)}</span><span class="grow"><span class="title">${esc(c.name)}</span><span class="meta">No limit</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></li>`)).join('')}</ul>
      <button class="btn block" data-action="catForm">${icon('plus')}New category</button>`;
  },
};
