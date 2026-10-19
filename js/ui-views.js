// Tab screens (Home, Activity, Debts, Plan, Reports) and the row builders they share with sheets.
import * as S from './store.js';
import { db } from './store.js';
import { peso, esc, today, daysBetween, fmtDate, relDay, monthKey, monthLabel, shiftMonth, FREQS, round2, addDays, PER_MONTH } from './util.js';
import { categoryBars, incomeVsSpending, debtLine, mountCharts, resetCharts } from './charts.js';
import { $, $$, ui, pw, icon, pref, header, bar, accounts, isStandalone, bannerHtml, renderTopbar, barBtn, emptyState, bigMoney, countFormat } from './ui-core.js';
import { runCountUps, syncScrolled } from './ui-fx.js';
import { budgetUsage, budgetsToWatch, detectSubscriptions } from './insights.js';

export const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date)) || (b.at || b.createdAt || 0) - (a.at || a.createdAt || 0);

// Screens that add to VIEWS from other modules (e.g. Review) register here.
export const EXTRA_VIEWS = {};

// keepScroll: a refresh of the same screen (no entrance animation, scroll position kept).
export function render({ keepScroll = false } = {}) {
  resetCharts();
  const y = window.scrollY;
  const main = $('#main');
  try {
    const view = VIEWS[ui.tab] || EXTRA_VIEWS[ui.tab] || VIEWS.home;
    main.innerHTML = `<div class="${keepScroll ? 'view-static' : 'view'}">${view()}</div>`;
    mountCharts(main);
  } catch (e) {
    console.error(e);
    main.innerHTML = `${header('Pitaka', settingsBtn())}<div class="card"><p>Something went wrong showing this screen. Your data is still saved on this phone.</p>
      <div class="actions"><button class="btn" data-action="exportData">Save backup</button><button class="btn" data-action="tab" data-tab="home">Go to Home</button></div></div>`;
  }
  renderTopbar();
  runCountUps(main, countFormat);
  const active = ['activity', 'review'].includes(ui.tab) ? 'home' : ui.tab;
  for (const b of $$('.tabbar [data-tab]')) {
    const on = b.dataset.tab === active;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, keepScroll ? y : 0);
  syncScrolled();
}
export const refresh = () => render({ keepScroll: true });

// Home's top bar: the Review inbox (with a count) when there is something to review, and Settings.
export const homeButtons = { review: () => '' };
const settingsBtn = () => barBtn('settings', 'settings', 'Settings');
export const backBtn = (label = 'Home') => `<button type="button" class="bar-btn text" data-action="tab" data-tab="home" aria-label="Back to ${esc(label)}">${icon('left')}${esc(label)}</button>`;

// ------------------------------------------------------------------ shared pieces
export const minDue = (d) => Number(d.minDue ?? d.paymentAmount) || 0;
// The amount one scheduled payment is expected to be.
export const schedPay = (d) => (d.type === 'card' ? d.plannedPayment || minDue(d) : d.paymentAmount || d.plannedPayment) || 0;
export const debtTypeOf = (d) => S.DEBT_TYPES[d?.type] || { label: 'Debt', icon: '💸' };
export const debtName = (t) => S.debt(t.debtId)?.name || t.debtName || 'Deleted debt';
export const goalName = (t) => S.goal(t.goalId)?.name || t.goalName || 'Deleted goal';
export const walletName = (id) => S.account(id)?.name || 'Deleted wallet';
export const personName = (t) => S.receivable(t.receivableId)?.name || t.personName || 'Someone';
export const REASONS = { fee: 'Fee', interest: 'Interest', penalty: 'Penalty', correction: 'Balance fix' };
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// "Next payday: Fri, Oct 23 · 5 days" (or "Payday today").
export function paydayLine() {
  const p = S.paydayInfo();
  if (p.isToday) return 'Payday today';
  return `Next payday: ${fmtDate(p.next, { weekday: 'short', month: 'short', day: 'numeric' })} · ${days(p.days)}`;
}

export const statusChip = (s) =>
  ({
    overdue: `<span class="chip critical">${icon('alert')} Overdue</span>`,
    soon: `<span class="chip warning">${icon('clock')} Due soon</span>`,
    paid: `<span class="chip good">${icon('check')} Paid off</span>`,
  })[s] || '';

// "✓ GCash" when an alert, an email or a statement confirmed the entry.
export function confirmedBadge(t) {
  if (!t.conf?.length) return '';
  const by = [...new Set(t.conf.map((c) => c.inst || (c.via === 'statement' ? 'statement' : c.via)))].join(', ');
  return `<span class="conf" title="Confirmed by ${esc(by)}">${icon('check')}${esc(by)}</span>`;
}

// icon (html), title, sub, sign (+1 / -1 / 0) and whether a plus reads as good news.
function describe(t, ctx, wid) {
  const many = accounts().length > 1;
  switch (t.kind) {
    case 'income':
      return { icon: '💰', title: t.note || t.merchant || 'Income', sub: many ? `to ${walletName(t.accountId)}` : '', sign: 1, good: true };
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
    case 'lend':
      return { icon: icon('out'), title: t.note || `Lent to ${personName(t)}`, sub: [t.note ? `Lent to ${personName(t)}` : '', many && ctx !== 'wallet' ? `from ${walletName(t.accountId)}` : ''].filter(Boolean).join(' · '), sign: ctx === 'person' ? 1 : -1 };
    case 'collect':
      return { icon: icon('in'), title: t.note || `${personName(t)} paid you back`, sub: [t.note ? personName(t) : '', many && ctx !== 'wallet' ? `to ${walletName(t.accountId)}` : ''].filter(Boolean).join(' · '), sign: ctx === 'person' ? -1 : 1, good: ctx !== 'person' };
    case 'adjust': {
      if (t.accountId) {
        const what = `Balance fix · ${walletName(t.accountId)}`;
        return { icon: icon('edit'), title: t.note || what, sub: t.note ? what : t.direction === 'down' ? 'Lowered to match the app' : 'Raised to match the app', sign: t.direction === 'down' ? -1 : 1, good: false };
      }
      const r = REASONS[t.reason] || 'Adjustment';
      const what = `${r} · ${debtName(t)}`;
      return { icon: icon(t.reason === 'correction' ? 'edit' : 'alert'), title: t.note || what, sub: t.note ? what : t.direction === 'down' ? 'Taken off the balance' : 'Added to the balance', sign: t.direction === 'down' ? -1 : 1 };
    }
    default: {
      const c = S.cat(t.categoryId);
      const card = t.cardId ? `on ${S.debt(t.cardId)?.name || t.cardName || 'deleted card'}` : '';
      const from = !card && many && ctx !== 'wallet' ? `from ${walletName(t.accountId)}` : '';
      const title = t.note || t.merchant || c.name;
      return { icon: esc(c.emoji), title, sub: [title !== c.name ? c.name : '', card || from].filter(Boolean).join(' · '), sign: ctx === 'debt' ? 1 : -1 };
    }
  }
}
export const txnText = (t) => { const d = describe(t, '', ''); return `${d.title} ${d.sub} ${t.merchant || ''}`; };

export function txnRow(t, { showDate = true, ctx = '', walletId = '' } = {}) {
  const d = describe(t, ctx, walletId);
  const sub = [d.sub, showDate ? fmtDate(t.date) : ''].filter(Boolean).join(' · ');
  const sign = d.sign > 0 ? '+' : d.sign < 0 ? '−' : '';
  const badge = confirmedBadge(t);
  return `<li><button type="button" class="row" data-action="editTxn" data-id="${esc(t.id)}">
    <span class="icon" aria-hidden="true">${d.icon}</span>
    <span class="grow"><span class="title">${esc(d.title)}</span>${sub || badge ? `<span class="meta">${esc(sub)}${sub && badge ? ' · ' : ''}${badge}</span>` : ''}</span>
    <span class="num ${d.good ? 'pos' : ''}">${sign}${esc(peso(t.amount))}</span>
  </button></li>`;
}

function dueRow(it) {
  const d = it.kind === 'debt' ? S.debt(it.id) : null;
  const late = it.late ?? it.due < today();
  const when = `${late ? 'Overdue · ' : ''}${fmtDate(it.due)} · ${relDay(it.due)}`;
  const card = d?.type === 'card' ? [d.plannedPayment ? `plan ${pw(d.plannedPayment)}` : '', minDue(d) ? `min ${pw(minDue(d))}` : ''].filter(Boolean).join(' · ') : '';
  const btn = it.kind === 'bill'
    ? `<button class="btn small tinted" data-action="markPaid" data-id="${esc(it.id)}" aria-label="Mark ${esc(it.name)} paid">${icon('check')}Paid</button>`
    : `<button class="btn small" data-action="payItem" data-kind="${esc(it.kind)}" data-id="${esc(it.id)}" aria-label="Pay ${esc(it.name)}">Pay</button>`;
  return `<li class="row">
    <span class="icon" aria-hidden="true">${esc(it.icon)}</span>
    <span class="grow"><span class="title">${esc(it.name)}</span>
      <span class="meta ${late ? 'critical-text' : ''}">${late ? icon('alert') : ''}${esc(when)}</span>${card ? `<span class="meta">${esc(card)}</span>` : ''}</span>
    <span class="col-end"><span class="num">${esc(peso(it.amount))}</span>${btn}</span>
  </li>`;
}

// One category against its limit for this pay period.
export function budgetRow(c, periodTxns) {
  const spent = round2(periodTxns.filter((t) => t.kind === 'expense' && t.categoryId === c.id).reduce((s, t) => s + t.amount, 0));
  const pct = (spent / c.limit) * 100;
  const state = pct > 100 ? 'critical' : pct >= 80 ? 'warning' : '';
  const left = daysBetween(today(), S.period().end) + 1;
  const status = pct > 100 ? `Over by ${pw(spent - c.limit)}` : `${pw(c.limit - spent)} left`;
  return `<li><button type="button" class="row" data-action="catForm" data-id="${esc(c.id)}">
    <span class="icon" aria-hidden="true">${esc(c.emoji)}</span>
    <span class="grow"><span class="row-line"><span class="title">${esc(c.name)}</span><span class="num">${pw(spent)} <small>of ${pw(c.limit)}</small></span></span>
      ${bar(pct, state, `${c.name} budget used`)}
      <span class="meta${state ? ` ${state}-text` : ''}">${status} · ${days(left)} to go</span></span>
  </button></li>`;
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
  const pct = Math.round(Math.max(0, Math.min(100, (g.saved / g.target) * 100)));
  return `<li><button type="button" class="row" data-action="goalSheet" data-id="${esc(g.id)}">
    <span class="icon" aria-hidden="true">${esc(g.emoji || '🎯')}</span>
    <span class="grow"><span class="row-line"><span class="title">${esc(g.name)}</span><span class="num">${pw(g.saved)} <small>of ${pw(g.target)}</small></span></span>
      ${bar(pct, g.saved >= g.target ? 'good' : '', `${g.name} progress`)}
      <span class="meta">${pct}% · ${esc(goalPlanText(g))}${g.deadline ? ` · by ${esc(fmtDate(g.deadline))}` : ''}</span></span>
  </button></li>`;
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
    if (d.creditLimit > 0 && S.paymentsLeft(d) === Infinity) warn = `<span class="meta critical-text">${icon('alert')} Your planned payment doesn't cover the interest</span>`;
  } else {
    progress = d.original > 0 ? bar((1 - d.balance / d.original) * 100, 'good', 'Paid off so far') : '';
    left = debtLeftText(d);
    const pay = schedPay(d);
    if (d.nextDue && d.balance > 0) due = `${pay ? `${pw(Math.min(pay, d.balance))} ` : ''}due ${fmtDate(d.nextDue)}`;
  }
  return `<li><button type="button" class="card debt ${st}" data-action="debtSheet" data-id="${esc(d.id)}">
    <span class="row-line"><span class="title">${esc(T.icon)} ${esc(d.name)}</span><span class="num big-ish">${pw(Math.max(0, d.balance))}</span></span>
    <span class="row-line meta"><span>${esc(T.label)}${d.lender ? ` · ${esc(d.lender)}` : ''}</span>${statusChip(st)}</span>
    ${progress}
    <span class="row-line meta"><span>${left}</span><span>${esc(due)}</span></span>
    ${warn}
  </button></li>`;
}

export function receivableRow(r) {
  const p = S.receivableProgress(r);
  const late = r.dueDate && r.balance > 0 && r.dueDate < today();
  const meta = [r.balance <= 0 ? 'Paid back in full' : p.paid > 0 ? `${pw(p.paid)} of ${pw(p.total)} paid back` : '', r.dueDate && r.balance > 0 ? `${late ? 'Was due' : 'Due'} ${fmtDate(r.dueDate)}` : ''].filter(Boolean).join(' · ') || 'Nothing paid back yet';
  return `<li><button type="button" class="row" data-action="recvSheet" data-id="${esc(r.id)}">
    <span class="icon accent" aria-hidden="true">${icon('person')}</span>
    <span class="grow"><span class="row-line"><span class="title">${esc(r.name)}</span><span class="num">${pw(Math.max(0, r.balance))}</span></span>
      ${p.paid > 0 ? bar(p.pct, 'good', `${r.name} paid back`) : ''}
      <span class="meta${late ? ' critical-text' : ''}">${esc(meta)}</span></span>
  </button></li>`;
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
    : `<li><button type="button" class="row" data-action="${i.action}" ${i.extra || ''}><span class="icon accent" aria-hidden="true">${icon('plus')}</span><span class="grow"><span class="title">${i.label}</span><span class="meta">${i.sub}</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button></li>`)).join('')}</ul></section>`;
}

function heroCard(fs, hasMoney) {
  const when = '';
  if (!hasMoney) {
    return `<section class="hero spend" aria-label="Free to spend until payday"><div class="hero-top"><p class="label">Free to spend until payday</p>${when}</div>
      <p class="big num"><span aria-hidden="true">—</span><span class="sr-only">Not known yet</span></p>
      <p class="meta">Log your paycheck or enter what's in your wallets, and Pitaka shows what you can spend until payday.</p>
      <div class="actions"><button class="btn primary" data-action="logPaycheck">Log paycheck</button><button class="btn" data-action="balancesForm">Enter balances</button></div></section>`;
  }
  const short = fs.free < 0;
  const cols = [['In wallets', fs.cash], ['Due', fs.due]];
  if (fs.setAside > 0) cols.push(['Set aside', fs.setAside]);
  return `<section class="hero spend${short ? ' short' : ''}" aria-label="${short ? 'Short before payday' : 'Free to spend until payday'}">
    <div class="hero-top"><p class="label">${short ? 'Short before payday' : 'Free to spend until payday'}</p>${when}</div>
    <p class="big num">${short ? '<span class="cur">−</span>' : ''}${bigMoney(fs.free, 'free')}</p>
    ${short ? `<p class="meta">What's due before payday is more than what's in your wallets.</p>` : ''}
    ${fs.hasIncomeThisPeriod ? '' : `<button class="btn primary" data-action="logPaycheck">${icon('plus')}Log paycheck${db.settings.payAmount ? ` · ${pw(db.settings.payAmount)}` : ''}</button>`}
    <div class="split${cols.length === 3 ? ' three' : ''}">${cols.map(([l, v]) => `<div><span class="label">${l}</span><span class="num">${pw(v)}</span></div>`).join('')}</div>
  </section>`;
}

function walletsRow() {
  const list = accounts();
  if (!list.length) return '';
  return `<div class="wallets" role="group" aria-label="Wallets">${list.map((a) => { const b = S.accountBalance(a.id); return `<button class="wallet${b < 0 ? ' neg' : ''}" data-kind="${esc(a.kind)}" data-action="walletSheet" data-id="${esc(a.id)}"><span class="label"><i aria-hidden="true"></i>${esc(a.name)}</span><span class="num">${esc(peso(b))}</span></button>`; }).join('')}
    <button class="wallet add" data-action="walletForm">${icon('plus')}Add wallet</button></div>`;
}

function backupBanner() {
  let st;
  try { st = S.backupStatus(); } catch { return ''; }
  if (!st?.due) return '';
  const when = st.daysSince === null || st.daysSince === undefined ? 'no backup yet' : st.daysSince === 0 ? 'last backup today' : `last backup ${st.daysSince} day${st.daysSince === 1 ? '' : 's'} ago`;
  return bannerHtml({ level: 'warning', icon: 'download', title: 'Back up your data', text: `${when[0].toUpperCase()}${when.slice(1)}${st.newEntries ? ` · ${st.newEntries} new entries since` : ''}`, actions: [['Save backup', 'exportData', 'primary']] });
}

const FREQ_WORD = { weekly: 'a week', biweekly: 'every 2 weeks', monthly: 'a month', quarterly: 'every 3 months', yearly: 'a year' };
function subscriptionCards() {
  let subs = [];
  try { subs = detectSubscriptions().slice(0, 2); } catch (e) { console.error(e); }
  if (!subs.length) return '';
  return `<section aria-labelledby="subs-h"><h2 id="subs-h">Looks like a subscription</h2>${subs.map((x) => `<div class="card suggest">
      <div class="row-line"><span class="title">${esc(S.cat(x.categoryId).emoji)} ${esc(x.name)}</span><span class="num">${esc(peso(x.amount))} <small>${esc(FREQ_WORD[x.frequency] || '')}</small></span></div>
      <p class="meta">Paid ${x.count} times, last on ${esc(fmtDate(x.last))}. Add it as a bill so it shows up before it's due?</p>
      <div class="actions"><button type="button" class="btn small tinted" data-action="addSubBill" data-key="${esc(x.key)}">${icon('plus')}Add as bill</button><button type="button" class="btn small" data-action="dismissSub" data-key="${esc(x.key)}">Not a subscription</button></div>
    </div>`).join('')}</section>`;
}

// ------------------------------------------------------------------ views
export const VIEWS = {
  home() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    const spent = S.sumBy(list, 'expense');
    const fs = S.freeToSpend();
    const setup = setupState();
    const hasMoney = db.txns.some((t) => t.kind === 'income') || accounts().some((a) => Number(a.opening)) || fs.cash !== 0;
    const due = fs.dueItems || S.upcoming(p.end);
    const watch = budgetsToWatch();
    const budgets = db.categories.filter((c) => c.limit > 0);
    const recent = [...db.txns].sort(byDateDesc).slice(0, 6);
    const anyPlans = db.bills.some((b) => !b.done) || db.debts.some((d) => d.balance > 0);
    const totalDebt = S.totalDebt();
    const owed = S.totalReceivable();
    const tiles = [
      !setup.show || spent > 0 ? `<button class="tile" data-action="tab" data-tab="activity"><span class="label">Spent this pay period</span><span class="num">${pw(spent)}</span></button>` : '',
      !setup.show || totalDebt > 0 ? `<button class="tile" data-action="tab" data-tab="debts"><span class="label">${owed > 0 ? 'You owe' : 'Total debt'}</span><span class="num">${pw(totalDebt)}</span></button>` : '',
    ].filter(Boolean);
    const showHint = !isStandalone() && !db.settings.hideInstallHint;

    return `${header('Pitaka', `${homeButtons.review()}${settingsBtn()}`, `<span>${esc(paydayLine())}</span>`)}
    ${backupBanner()}
    ${homeButtons.reviewCard ? homeButtons.reviewCard() : ''}
    ${heroCard(fs, hasMoney)}
    ${walletsRow()}
    ${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}
    ${setup.show ? setupCard(setup) : ''}

    ${due.length || anyPlans || !setup.show ? `<section><h2>Due before payday</h2>
      ${due.length ? `<ul class="list card">${due.map(dueRow).join('')}</ul>`
        : anyPlans ? `<p class="empty card">Nothing else is due before payday.</p>`
          : `<p class="empty card">Add your bills and debts to see what's due before payday.</p>`}
    </section>` : ''}

    ${watch.length ? `<section><h2>Budgets to watch <button class="link" data-action="goPlan" data-sub="budgets">All budgets</button></h2>
      <ul class="list card">${watch.map((u) => budgetRow(u.category, list)).join('')}</ul></section>`
      : budgets.length ? `<section><h2>Budgets</h2><button type="button" class="card row ok-row" data-action="goPlan" data-sub="budgets"><span class="icon accent" aria-hidden="true">${icon('check-circle')}</span><span class="grow"><span class="title">${budgets.length === 1 ? 'Your budget is on track' : `All ${budgets.length} budgets on track`}</span><span class="meta">${budgets.length === 1 ? 'Under 80% of its limit' : 'None has reached 80% of its limit'} this pay period</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button></section>`
        : setup.show ? '' : `<section><h2>Budgets</h2><p class="empty card">Set spending limits per category so you know when to slow down. <button class="link" data-action="goPlan" data-sub="budgets">Set limits</button></p></section>`}

    ${subscriptionCards()}

    ${db.goals.length ? `<section><h2>Savings goals <button class="link" data-action="goPlan" data-sub="goals">See all</button></h2>
      <ul class="list card">${db.goals.map(goalRow).join('')}</ul></section>` : ''}

    <section>
      <h2>Recent ${recent.length ? '<button class="link" data-action="tab" data-tab="activity">See all</button>' : ''}</h2>
      ${recent.length ? `<ul class="list card">${recent.map((t) => txnRow(t)).join('')}</ul>` : emptyState({ icon: 'receipt', title: 'No entries yet', text: 'Tap + to log your first expense. It takes a few seconds.', actions: [['Add an expense', 'add', 'primary']] })}
    </section>

    ${showHint ? `<section><p class="card hint meta"><b>Pitaka is open in the browser.</b> What you add here stays in this browser and won't show up in the Home Screen app. To install: save a backup, then in Safari tap Share → Add to Home Screen, open Pitaka from your Home Screen and restore the backup there.
      <button class="link" data-action="hideHint">Got it</button></p></section>` : ''}`;
  },

  activity() {
    const chips = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['debt', 'Debts'], ['goal', 'Savings'], ['transfer', 'Transfers'], ['lend', 'Lending']];
    return `${header('Activity', '', '', { left: backBtn() })}
      <div class="search-wrap">${icon('search')}<input class="search" type="search" placeholder="Search" aria-label="Search entries" value="${esc(ui.search)}" data-input="search" autocomplete="off"></div>
      <div class="chips scroll">${chips.map(([k, l]) => `<button class="chip-btn ${ui.filter === k ? 'on' : ''}" aria-pressed="${ui.filter === k}" data-action="filter" data-f="${k}">${l}</button>`).join('')}</div>
      <div id="act-list">${activityList()}</div>`;
  },

  debts() {
    const order = { overdue: 0, soon: 1, ok: 2, paid: 3 };
    const owedTab = ui.debtsTab === 'owed';
    const active = db.debts.filter((d) => d.balance > 0).sort((a, b) => order[S.debtStatus(a)] - order[S.debtStatus(b)] || (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const paid = db.debts.filter((d) => d.balance <= 0);
    const recv = [...(db.receivables || [])].sort((a, b) => (b.balance > 0) - (a.balance > 0) || (a.dueDate || '9').localeCompare(b.dueDate || '9'));
    const add = owedTab
      ? `<button class="bar-btn text" data-action="lendForm">${icon('plus')}Lend</button>`
      : `<button class="bar-btn text" data-action="addDebtMenu">${icon('plus')}Add</button>`;
    const summary = `<section class="card hero debts-hero"><div class="split two-big">
        <button type="button" class="${owedTab ? '' : 'on'}" data-action="debtsTab" data-sub="owe"><span class="label">You owe</span><span class="big num">${bigMoney(S.totalDebt(), 'debt')}</span></button>
        <button type="button" class="${owedTab ? 'on' : ''}" data-action="debtsTab" data-sub="owed"><span class="label">Owed to you</span><span class="big num good-text">${bigMoney(S.totalReceivable(), 'owed')}</span></button></div></section>
      <div class="segmented" role="group" aria-label="Show"><button type="button" data-action="debtsTab" data-sub="owe" aria-pressed="${!owedTab}">You owe${active.length ? ` · ${active.length}` : ''}</button><button type="button" data-action="debtsTab" data-sub="owed" aria-pressed="${owedTab}">Owed to you${recv.filter((r) => r.balance > 0).length ? ` · ${recv.filter((r) => r.balance > 0).length}` : ''}</button></div>`;
    if (owedTab) {
      return `${header('Debts', add)}${summary}
        ${recv.length ? `<ul class="list card">${recv.map(receivableRow).join('')}</ul>`
          : emptyState({ icon: 'users', title: 'Nobody owes you', text: 'Lent money to someone? Record it here, then log their repayments as they come in. Quick text works too: "lent mel 500".', actions: [['Record money you lent', 'lendForm', 'primary']] })}`;
    }
    if (!db.debts.length) {
      return `${header('Debts', add)}${summary}
        ${emptyState({ icon: 'card', title: 'No debts yet', text: 'Add your credit cards, loans, installments, lending apps and money you owe people. Already tracking them in a spreadsheet? Paste them in.', actions: [['Paste from a spreadsheet', 'importSheet', 'primary'], ['Add one by one', 'debtForm']] })}`;
    }
    const dates = active.map(S.payoffDate);
    const freeBy = active.length && dates.every(Boolean) ? [...dates].sort().at(-1) : null;
    return `${header('Debts', add)}${summary}
      <div class="tiles">
        <div class="tile"><span class="label">Monthly payments</span><span class="num">${pw(S.monthlyObligations())}</span></div>
        <div class="tile"><span class="label">Debt-free by</span><span class="num">${freeBy ? esc(fmtDate(freeBy, { month: 'short', year: 'numeric' })) : active.length ? '—' : 'Now'}</span></div>
      </div>
      ${active.length ? `<ul class="cards">${active.map(debtCard).join('')}</ul>` : `<p class="empty card">Everything is paid off.</p>`}
      ${paid.length ? `<button class="link block" data-action="togglePaid" aria-expanded="${ui.showPaid}">${ui.showPaid ? 'Hide' : 'Show'} paid off (${paid.length})</button>
        ${ui.showPaid ? `<ul class="cards">${paid.map(debtCard).join('')}</ul>` : ''}` : ''}`;
  },

  plan() {
    const tabs = [['goals', 'Goals'], ['bills', 'Bills'], ['budgets', 'Budgets']];
    return `${header('Plan')}
      <div class="segmented" role="group" aria-label="Plan">${tabs.map(([k, l]) => `<button class="${ui.planTab === k ? 'on' : ''}" aria-pressed="${ui.planTab === k}" data-action="planTab" data-sub="${k}">${l}</button>`).join('')}</div>
      ${PLAN[ui.planTab]()}`;
  },

  reports() {
    const mode = ui.reportMode === 'period' ? 'period' : 'month';
    const right = barBtn('exportSheet', 'share', 'Export CSV');
    const seg = `<div class="segmented" role="group" aria-label="Report by"><button type="button" data-action="reportMode" data-sub="month" aria-pressed="${mode === 'month'}">Month</button><button type="button" data-action="reportMode" data-sub="period" aria-pressed="${mode === 'period'}">Pay period</button></div>`;
    return `${header('Reports', right)}${seg}${mode === 'period' ? periodReport() : monthReport()}`;
  },
};

function monthReport() {
  const m = ui.reportMonth;
  const isNow = m >= monthKey(today());
  const nav = `<div class="month-nav"><button class="icon-btn" data-action="month" data-d="-1" aria-label="Previous month">${icon('left')}</button>
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
  if (!sum.count) return `${nav}${emptyState({ icon: 'chart', title: `Nothing in ${monthLabel(m, true)}`, text: 'Reports fill in as you log income, spending, debt payments and savings.' })}${charts}`;
  const items = db.txns.filter((t) => monthKey(t.date) === m);
  return `${nav}${summaryBlock(sum, items)}${charts}${biggest(items)}`;
}

function periodReport() {
  const cur = S.period().start;
  const start = ui.reportPeriod && ui.reportPeriod <= cur ? S.period(ui.reportPeriod).start : cur;
  const p = S.periodSummary(start);
  const isNow = start >= cur;
  const nav = `<div class="month-nav"><button class="icon-btn" data-action="period" data-d="-1" aria-label="Previous pay period">${icon('left')}</button>
      <b aria-live="polite">${esc(fmtDate(p.start))} – ${esc(fmtDate(p.end))}</b>
      <button class="icon-btn" data-action="period" data-d="1" ${isNow ? 'disabled' : ''} aria-label="Next pay period">${icon('right')}</button></div>`;
  if (!p.count) return `${nav}${emptyState({ icon: 'calendar', title: 'Nothing in this pay period', text: 'Each pay period runs two weeks, from one payday to the day before the next.' })}`;
  const items = S.txnsBetween(p.start, p.end);
  const lending = p.lent || p.collected ? `<p class="meta pad">${p.lent ? `Lent out ${pw(p.lent)}` : ''}${p.lent && p.collected ? ' · ' : ''}${p.collected ? `paid back to you ${pw(p.collected)}` : ''}</p>` : '';
  const merchants = p.topMerchants.length ? `<section><h2>Top merchants</h2><ul class="list card">${p.topMerchants.map((x, i) => `<li class="row"><span class="icon" aria-hidden="true"><b>${i + 1}</b></span><span class="grow"><span class="title">${esc(x.name)}</span><span class="meta">${x.count} time${x.count === 1 ? '' : 's'}</span></span><span class="num">${pw(x.value)}</span></li>`).join('')}</ul></section>` : '';
  return `${nav}${summaryBlock(p, items)}${lending}${merchants}${biggest(items)}`;
}

function summaryBlock(sum, items) {
  return `<div class="tiles four">
      <div class="tile"><span class="label">Income</span><span class="num">${pw(sum.income)}</span></div>
      <div class="tile"><span class="label">Spent</span><span class="num">${pw(sum.spent)}</span></div>
      <div class="tile"><span class="label">Saved</span><span class="num">${pw(sum.saved)}</span></div>
      <div class="tile"><span class="label">Debt paid</span><span class="num">${pw(sum.debtPaid)}</span></div>
    </div>
    <p class="net card">${sum.net >= 0 ? 'Left over' : 'Over by'} <b class="num ${sum.net < 0 ? 'critical-text' : ''}">${pw(Math.abs(sum.net))}</b> after spending, debt payments and savings</p>
    ${sum.spentOnCards > 0 ? `<p class="meta pad">${pw(sum.spentOnCards)} of the spending was on credit cards. It counts against what's left over when you pay the card.</p>` : ''}
    ${sum.fees > 0 ? `<p class="meta pad">Fees and interest added to your debts: ${pw(sum.fees)}</p>` : ''}
    <section><h2>Where your money went</h2><div class="card">${categoryBars(sum.byCategory)}</div></section>`;
}
function biggest(items) {
  const top = items.filter((t) => t.kind === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);
  return top.length ? `<section><h2>Biggest expenses</h2><ul class="list card">${top.map((t) => txnRow(t)).join('')}</ul></section>` : '';
}

export function activityList() {
  const q = ui.search.trim().toLowerCase();
  const match = (t) => ui.filter === 'all' || t.kind === ui.filter || (ui.filter === 'debt' && t.kind === 'adjust' && t.debtId) || (ui.filter === 'lend' && t.kind === 'collect');
  const rows = db.txns
    .filter(match)
    .filter((t) => !q || `${txnText(t)} ${t.kind === 'expense' ? S.cat(t.categoryId).name : ''}`.toLowerCase().includes(q))
    .sort(byDateDesc);
  if (!rows.length) return q || ui.filter !== 'all' ? `<p class="empty card">No entries match.</p>` : emptyState({ icon: 'receipt', title: 'Nothing here yet', text: 'Tap + to log an expense.' });
  const groups = {};
  for (const t of rows.slice(0, 600)) (groups[t.date] ||= []).push(t);
  return Object.entries(groups).map(([d, ts]) => `<h2 class="h3 date-h">${esc(fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }))}</h2>
    <ul class="list card">${ts.map((t) => txnRow(t, { showDate: false })).join('')}</ul>`).join('') + (rows.length > 600 ? `<p class="meta pad center">Showing the latest 600 entries. Search to find older ones.</p>` : '');
}

const PLAN = {
  goals() {
    if (!db.goals.length) return emptyState({ icon: 'target', title: 'Save for something', text: 'A trip, a gadget or an emergency fund: add a goal and Pitaka tells you how much to put aside every payday.', actions: [['New savings goal', 'goalForm', 'primary']] });
    const saved = db.goals.reduce((s, g) => s + g.saved, 0);
    const target = db.goals.reduce((s, g) => s + g.target, 0);
    return `<div class="tiles"><div class="tile"><span class="label">Saved so far</span><span class="num">${pw(saved)}</span></div><div class="tile"><span class="label">Across ${db.goals.length} goal${db.goals.length === 1 ? '' : 's'}</span><span class="num">${target ? Math.round((saved / target) * 100) : 0}%</span></div></div>
      <ul class="list card" style="margin-top:12px">${db.goals.map(goalRow).join('')}</ul>
      <button class="btn block" data-action="goalForm">${icon('plus')}New savings goal</button>`;
  },
  bills() {
    const bills = [...db.bills].sort((a, b) => (a.done - b.done) || (a.nextDue || '9').localeCompare(b.nextDue || '9'));
    const monthly = round2(bills.filter((b) => !b.done).reduce((s, b) => s + b.amount * (PER_MONTH[b.frequency] || 0), 0));
    if (!bills.length) return emptyState({ icon: 'repeat', title: 'No bills yet', text: "Add rent, Meralco, water, internet, your phone plan and subscriptions. They show up on Home when they're due before payday.", actions: [['New bill', 'billForm', 'primary']] });
    return `<div class="tiles"><div class="tile"><span class="label">Bills a month</span><span class="num">${pw(monthly)}</span></div><div class="tile"><span class="label">Before payday</span><span class="num">${pw(S.upcoming(S.period().end).filter((x) => x.kind === 'bill').reduce((s, x) => s + x.amount, 0))}</span></div></div>
      <ul class="list card" style="margin-top:12px">${bills.map((b) => {
        const late = !b.done && b.nextDue && b.nextDue < today();
        const when = b.done ? 'Done' : b.nextDue ? `${late ? 'Overdue · ' : ''}Due ${fmtDate(b.nextDue)} · ${relDay(b.nextDue)}` : 'No due date';
        return `<li class="row">
          <button type="button" class="row-main" data-action="billForm" data-id="${esc(b.id)}"><span class="icon" aria-hidden="true">${esc(S.cat(b.categoryId).emoji)}</span>
          <span class="grow"><span class="title">${esc(b.name)}</span>
          <span class="meta ${late ? 'critical-text' : ''}">${esc(when)} · ${esc(FREQS[b.frequency] || '')}</span><span class="sr-only">${esc(peso(b.amount))}</span></span></button>
          <span class="col-end"><span class="num" aria-hidden="true">${esc(peso(b.amount))}</span>${b.done ? '' : `<button class="btn small" data-action="payItem" data-kind="bill" data-id="${esc(b.id)}" aria-label="Pay ${esc(b.name)}">Pay</button>`}</span>
        </li>`;
      }).join('')}</ul>
      <button class="btn block" data-action="billForm">${icon('plus')}New bill</button>`;
  },
  budgets() {
    const p = S.period();
    const list = S.txnsBetween(p.start, p.end);
    const withLimit = db.categories.filter((c) => c.limit > 0 && !c.hidden);
    const others = db.categories.filter((c) => !(c.limit > 0) && !c.hidden);
    const total = withLimit.reduce((s, c) => s + c.limit, 0);
    const used = withLimit.reduce((s, c) => s + (budgetUsage(c.id)?.spent || 0), 0);
    return `<p class="meta pad">Limits for each 2-week pay period, now ${esc(fmtDate(p.start))} – ${esc(fmtDate(p.end))}.</p>
      ${withLimit.length ? `<div class="card budget-total"><div class="row-line"><span class="title">All budgets</span><span class="num">${pw(used)} <small>of ${pw(total)}</small></span></div>${bar((used / total) * 100, used > total ? 'critical' : used >= total * 0.8 ? 'warning' : '', 'All budgets used')}</div>
        <ul class="list card" style="margin-top:12px">${withLimit.map((c) => budgetRow(c, list)).join('')}</ul>` : ''}
      ${others.length ? `<h2 class="h3">No limit yet</h2><ul class="list card">${others.map((c) => `<li><button type="button" class="row" data-action="catForm" data-id="${esc(c.id)}">
        <span class="icon" aria-hidden="true">${esc(c.emoji)}</span><span class="grow"><span class="title">${esc(c.name)}</span><span class="meta">Tap to set a limit</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button></li>`).join('')}</ul>` : ''}
      <button class="btn block" data-action="catManager">${icon('sliders')}Manage categories</button>`;
  },
};
