// First run: "install first" overlay, then a 4-step setup (payday, wallets, debts, PIN).
import * as S from './store.js';
import { db } from './store.js';
import { esc, today } from './util.js';
import { $, ui, icon, pref, field, money, syncInert, setSettings, toast, FormProblem, optMoney, accounts, isStandalone, errorMessage } from './ui-core.js';
import { render } from './ui-views.js';
import { balancesEditor, balancesRows, saveBalances, importPanel } from './ui-sheets.js';
import { Lock } from './ui-lock.js';

const STEPS = 4;
export const Onboard = { step: 1 };

export function needsInstall() {
  return !db.settings.onboarded && !isStandalone() && pref.get('browserOk') !== '1';
}

export function showInstall() {
  const el = $('#install');
  el.innerHTML = `<div class="onboard-inner" role="dialog" aria-modal="true" aria-labelledby="install-h">
    <div class="logo" aria-hidden="true">₱</div>
    <h1 id="install-h" tabindex="-1" style="outline:none">Install Pitaka first</h1>
    <p class="meta">Pitaka keeps your money data only on this iPhone. Install it on your Home Screen before you start, so everything you add stays in the app.</p>
    <ol class="install-steps">
      <li><span>Open this page in <b>Safari</b>.</span></li>
      <li><span>Tap the <b>Share</b> button <svg class="ti inline" aria-hidden="true"><use href="#i-share"/></svg> at the bottom of the screen.</span></li>
      <li><span>Scroll down and tap <b>Add to Home Screen</b> <svg class="ti inline" aria-hidden="true"><use href="#i-add-square"/></svg>, then <b>Add</b>.</span></li>
      <li><span>Close Safari and open <b>Pitaka</b> from your Home Screen.</span></li>
    </ol>
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
  showOnboarding(1);
}

const dots = (n) => `<div class="steps" role="img" aria-label="Step ${n} of ${STEPS}">${Array.from({ length: STEPS }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
const back = (n) => `<button type="button" class="link" data-action="onbGo" data-step="${n - 1}">Back</button>`;

const VIEWS = {
  1() {
    const lp = ui.loadProblem;
    return `${dots(1)}
      ${lp?.reason === 'blocked' ? `<div class="banner critical" role="alert">${icon('alert')}<div><strong>Pitaka can't save on this phone</strong><span class="meta">The browser is blocking storage. Turn off Private Browsing, or "Block All Cookies" in Settings → Safari, then open Pitaka again.</span></div></div>`
        : lp ? `<div class="banner critical" role="alert">${icon('alert')}<div><strong>Your saved data couldn't be read</strong><span class="meta">Pitaka didn't delete it, and started empty. Restore your latest backup to get your entries back.</span></div><button type="button" class="btn small primary" data-action="importData">Restore</button></div>` : ''}
      <div class="logo" aria-hidden="true">₱</div>
      <h1 id="onb-h" tabindex="-1" style="outline:none">Welcome to Pitaka</h1>
      <p class="meta">Expenses, debts, bills and savings goals in one place. Everything stays on this iPhone.</p>
      <form id="onb-form" data-form="onbPay" novalidate>
        ${field('When was your last payday?', `<input type="date" name="payAnchor" value="${esc(db.settings.payAnchor || today())}" required>`, 'You get paid every 2 weeks. Budgets and "free to spend" follow your pay periods.')}
        ${field('Usual paycheck (optional)', money('payAmount', db.settings.payAmount))}
        <button class="btn primary block" type="submit">Next</button>
      </form>
      <button type="button" class="link block" data-action="importData">Have a backup file? Restore it</button>`;
  },
  2() {
    return `${dots(2)}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Your wallets</h1>
      <p class="meta">How much do you have right now? Rename or add wallets to match yours. You can change these later.</p>
      <form id="onb-form" data-form="onbWallets" novalidate>
        ${balancesEditor(balancesRows())}
        <button class="btn primary block" type="submit">Next</button>
      </form>
      <div class="actions" style="justify-content:space-between">${back(2)}<button type="button" class="link" data-action="onbGo" data-step="3">Skip this step</button></div>`;
  },
  3() {
    return `${dots(3)}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Your debts</h1>
      <p class="meta">Keeping your debts in a spreadsheet? Copy the rows and paste them here. You can also add them one by one later in the Debts tab.</p>
      ${importPanel('onboard')}
      <div class="actions" style="justify-content:space-between">${back(3)}<button type="button" class="link" data-action="onbGo" data-step="4">${db.debts.length ? 'Next' : 'Add them later'}</button></div>`;
  },
  4() {
    return `${dots(4)}
      <h1 id="onb-h" tabindex="-1" style="outline:none">Lock with a PIN?</h1>
      <p class="meta">A 4-digit PIN keeps your balances private if someone else picks up your phone. Pitaka also hides them in the app switcher.</p>
      <button type="button" class="btn primary block" data-action="onbPin">${icon('lock')}Set a PIN</button>
      <button type="button" class="btn block" data-action="onbFinish">Not now</button>
      <div class="actions">${back(4)}</div>`;
  },
};

export function showOnboarding(step = 1) {
  Onboard.step = Math.min(STEPS, Math.max(1, Number(step) || 1));
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
  toast("You're all set");
}

export function onboardPin() {
  Lock.start('set', { onDone: () => { try { finishOnboarding(); } catch (e) { toast(errorMessage(e)); } } });
}

export const ONBOARD_FORMS = {
  async onbPay(form) {
    const f = new FormData(form);
    const payAnchor = String(f.get('payAnchor') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payAnchor)) throw new FormProblem('Pick the date of your last payday', 'payAnchor');
    setSettings({ payAnchor, payAmount: optMoney(f, 'payAmount', 'paycheck') || 0 });
    await S.flush();
    showOnboarding(2);
  },
  async onbWallets(form) {
    saveBalances(form);
    await S.flush();
    showOnboarding(3);
  },
};
