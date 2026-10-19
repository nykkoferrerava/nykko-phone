// First run: 1 Install (Safari only), 2 Next payday, 3 Wallets, 4 Debts, 5 Connect your iPhone,
// then a short "all set" screen that offers a PIN.
import * as S from './store.js';
import { db } from './store.js';
import { esc, today, fmtDate } from './util.js';
import { $, ui, icon, pref, field, money, syncInert, setSettings, toast, optMoney, accounts, isStandalone, errorMessage } from './ui-core.js';
import { render } from './ui-views.js';
import { balancesEditor, balancesRows, saveBalances, importPanel } from './ui-sheets.js';
import { paydayPicker, readPayday } from './ui-money.js';
import { Lock } from './ui-lock.js';

const STEPS = 5;
export const Onboard = { step: 2 };

export function needsInstall() {
  return !db.settings.onboarded && !isStandalone() && pref.get('browserOk') !== '1';
}

const dots = (n) => `<div class="steps" role="img" aria-label="Step ${n} of ${STEPS}">${Array.from({ length: STEPS }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
const stepLabel = (n, what) => `<p class="step-label">Step ${n} of ${STEPS} · ${what}</p>`;
const back = (n) => `<button type="button" class="link" data-action="onbGo" data-step="${n - 1}">Back</button>`;

export function showInstall() {
  const el = $('#install');
  el.innerHTML = `<div class="onboard-inner" role="dialog" aria-modal="true" aria-labelledby="install-h">
    ${dots(1)}${stepLabel(1, 'Install')}
    <div class="logo" aria-hidden="true" style="margin-top:14px">₱</div>
    <h1 id="install-h" tabindex="-1" style="outline:none">Install Pitaka first</h1>
    <p class="meta">Pitaka keeps your money data only on this iPhone. Install it on your Home Screen before you start, so everything you add stays in the app.</p>
    <ol class="install-steps">
      <li><span>Open this page in <b>Safari</b>.</span></li>
      <li><span>Tap the <b>Share</b> button <svg class="ti inline" aria-hidden="true"><use href="#i-share"/></svg> at the bottom of the screen.</span></li>
      <li><span>Scroll down and tap <b>Add to Home Screen</b> <svg class="ti inline" aria-hidden="true"><use href="#i-add-square"/></svg>, then <b>Add</b>.</span></li>
      <li><span>Close Safari and open <b>Pitaka</b> from your Home Screen.</span></li>
    </ol>
    <div class="spacer"></div>
    <button type="button" class="link block" data-action="continueBrowser">Continue in the browser anyway</button>
    <p class="meta center">Anything you type in the browser stays in the browser. It won't move to the installed app.</p>
  </div>`;
  el.hidden = false;
  syncInert();
  $('#install-h').focus({ preventScroll: true });
}

export function continueInBrowser() {
  pref.set('browserOk', '1');
  $('#install').hidden = true;
  showOnboarding(2);
}

const VIEWS = {
  2() {
    const lp = ui.loadProblem;
    return `${dots(2)}${stepLabel(2, 'Payday')}
      ${lp?.reason === 'blocked' ? `<div class="banner critical" role="alert">${icon('alert')}<div><strong>Pitaka can't save on this phone</strong><span class="meta">The browser is blocking storage. Turn off Private Browsing, or "Block All Cookies" in Settings → Safari, then open Pitaka again.</span></div></div>`
        : lp ? `<div class="banner critical" role="alert">${icon('alert')}<div><strong>Your saved data couldn't be read</strong><span class="meta">Pitaka didn't delete it, and started empty. Restore your latest backup to get your entries back.</span></div><button type="button" class="btn small primary" data-action="importData">Restore</button></div>` : ''}
      <h1 id="onb-h" tabindex="-1" style="outline:none">When is your next payday?</h1>
      <p class="meta">You're paid every second Friday. Pitaka shows what's free to spend until then, and plans bills, budgets and savings around your pay periods.</p>
      <form id="onb-form" data-form="onbPay" novalidate>
        ${paydayPicker(S.paydayChoices()[0])}
        ${field('Usual paycheck (optional)', money('payAmount', db.settings.payAmount))}
        <button class="btn primary block" type="submit">Next</button>
      </form>
      <div class="spacer"></div>
      <button type="button" class="link block" data-action="importData">Have a backup file? Restore it</button>`;
  },
  3() {
    return `${dots(3)}${stepLabel(3, 'Wallets')}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Your wallets</h1>
      <p class="meta">How much is in each one right now? Rename or add wallets to match yours: cash, GCash, GoTyme, your bank. You can change these later.</p>
      <form id="onb-form" data-form="onbWallets" novalidate>
        ${balancesEditor(balancesRows())}
        <button class="btn primary block" type="submit">Next</button>
      </form>
      <div class="actions" style="justify-content:space-between">${back(3)}<button type="button" class="link" data-action="onbGo" data-step="4">Skip this step</button></div>`;
  },
  4() {
    return `${dots(4)}${stepLabel(4, 'Debts')}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Your debts</h1>
      <p class="meta">Keeping your debts in a spreadsheet? Copy the rows and paste them here. You can also add them one by one later in the Debts tab.</p>
      ${importPanel('onboard')}
      <div class="actions" style="justify-content:space-between">${back(4)}<button type="button" class="link" data-action="onbGo" data-step="5">${db.debts.length ? 'Next' : 'Add them later'}</button></div>`;
  },
  5() {
    return `${dots(5)}${stepLabel(5, 'Connect your iPhone')}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Add expenses without opening Pitaka</h1>
      <p class="meta">Double-tap the back of your iPhone to log an expense in seconds, and let GCash and bank texts fill in Pitaka on their own.</p>
      <ul class="list card onb-list">
        <li class="row"><span class="icon accent" aria-hidden="true">${icon('vibrate')}</span><span class="grow"><span class="title">Back Tap quick add</span><span class="meta">Amount, category, wallet: done</span></span></li>
        <li class="row"><span class="icon accent" aria-hidden="true">${icon('message')}</span><span class="grow"><span class="title">SMS and email alerts</span><span class="meta">Matched to what you logged, never counted twice</span></span></li>
        <li class="row"><span class="icon accent" aria-hidden="true">${icon('lock')}</span><span class="grow"><span class="title">Private</span><span class="meta">Your own relay, encrypted. No bank passwords, ever.</span></span></li>
      </ul>
      <p class="meta pad">Setup takes about 20 minutes: a free relay, then three shortcuts. Pitaka walks you through it, and you can do it later from Settings.</p>
      <button type="button" class="btn primary block" data-action="onbConnect">${icon('phone')}Set it up now</button>
      <button type="button" class="btn block" data-action="onbGo" data-step="6">Later</button>
      <div class="actions">${back(5)}</div>`;
  },
  6() {
    const n = accounts().length;
    return `${dots(5)}
      <div class="logo" aria-hidden="true" style="margin-top:8px">₱</div>
      <h1 id="onb-h" tabindex="-1" style="outline:none">You're all set</h1>
      <p class="meta">${n} wallet${n === 1 ? '' : 's'}${db.debts.length ? `, ${db.debts.length} debt${db.debts.length === 1 ? '' : 's'}` : ''} · next payday ${esc(fmtDate(S.paydayInfo().next, { weekday: 'short', month: 'short', day: 'numeric' }))}.</p>
      <div class="card" style="margin-top:18px"><p><b>Lock with a PIN?</b></p><p class="meta">A 4-digit PIN keeps your balances private if someone else picks up your phone. Pitaka also hides them in the app switcher.</p>
        <button type="button" class="btn primary block" data-action="onbPin">${icon('lock')}Set a PIN</button></div>
      <button type="button" class="btn block" data-action="onbFinish">Start using Pitaka</button>
      <div class="actions">${back(6)}</div>`;
  },
};

export function showOnboarding(step = 2) {
  Onboard.step = Math.min(6, Math.max(2, Number(step) || 2));
  const el = $('#onboard');
  el.innerHTML = `<div class="onboard-inner" role="dialog" aria-modal="true" aria-labelledby="onb-h">${VIEWS[Onboard.step]()}</div>`;
  el.hidden = false;
  el.scrollTop = 0;
  syncInert();
  $('#onb-h')?.focus({ preventScroll: true });
}

export async function finishOnboarding() {
  if (!accounts().length) S.saveAccount({ name: 'Cash', kind: 'cash', opening: 0, openingDate: today() });
  setSettings({ onboarded: true });
  await S.flush();
  $('#onboard').hidden = true;
  $('#onboard').innerHTML = '';
  syncInert();
  render();
  const next = Onboard.afterFinish;
  Onboard.afterFinish = null;
  if (next) next(); else toast("You're all set", { icon: 'check' });
}

export function onboardPin() {
  Lock.start('set', { onDone: () => { finishOnboarding().catch((e) => toast(errorMessage(e))); } });
}

export const ONBOARD_FORMS = {
  async onbPay(form) {
    const f = new FormData(form);
    S.setPayday(readPayday(form), optMoney(f, 'payAmount', 'paycheck') || 0);
    await S.flush();
    showOnboarding(3);
  },
  async onbWallets(form) {
    saveBalances(form);
    await S.flush();
    showOnboarding(4);
  },
};
