// Pitaka entry point: wires taps, forms, keyboard, lock, onboarding and the service worker.
import * as S from './store.js';
import { db } from './store.js';
import { today, monthKey, shiftMonth, toISO, parseISO, advance } from './util.js';
import {
  $, ui, pref, toast, runToastAction, setBanner, clearBanner, renderBanners, setTrigger, syncInert, closeSheet, isSheetOpen,
  isLockOpen, isOverlayOpen, setBusy, showFormError, clearFormError, liveFormat, sizeAmount, setSettings, errorMessage,
  isValidation, isStoreError, storeMessage, ensureEl,
} from './ui-core.js';
import { render, refresh, activityList, schedPay } from './ui-views.js';
import {
  FORMS as SHEET_FORMS, draft, txnForm, renderTxnForm, readDraft, editTxn, deleteTxn, updateStepper, addDebtMenu, debtForm, debtSheet,
  fixDebtForm, billForm, goalForm, goalSheet, catForm, walletSheet, walletForm, balancesForm, balanceRow, settingsSheet, restoredSheet,
  importSheet, importSave, onImportInput, onImportChange, autoInstallments,
} from './ui-sheets.js';
import { icsForItem, icsForAll, deliverFile } from './ui-ics.js';
import { Lock } from './ui-lock.js';
import { Onboard, needsInstall, showInstall, continueInBrowser, showOnboarding, finishOnboarding, onboardPin, ONBOARD_FORMS } from './ui-onboard.js';

const FORMS = { ...SHEET_FORMS, ...ONBOARD_FORMS };

// ============================================================ backup / restore
async function exportData() {
  let json;
  try { json = S.exportBackup(); } catch (e) { return reportError(e); }
  const file = new File([json], `pitaka-backup-${today()}.json`, { type: 'application/json' });
  const how = await deliverFile(file);
  if (how === 'cancelled') return;
  try { S.markBackedUp(); } catch { /* reminder just shows again */ }
  clearBanner('save');
  refresh();
  if (isSheetOpen() && $('#persist-status')) settingsSheet();
  toast(how === 'shared' ? 'Backup saved' : 'Backup downloaded. Keep it somewhere safe, like iCloud Drive.');
}

async function restoreFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert("This file isn't a Pitaka backup. Pick the .json file you saved from Pitaka."); }
  const n = Array.isArray(data?.txns) ? data.txns.length : 0;
  const what = db.txns.length || db.debts.length ? 'everything on this phone' : "Pitaka's data";
  if (!confirm(`Replace ${what} with this backup (${n} entr${n === 1 ? 'y' : 'ies'})?\n\nThe PIN lock will be off afterwards; you can set a new PIN.`)) return;
  try {
    S.replaceAll(data);
  } catch (e) {
    return alert(isValidation(e) ? e.message : isStoreError(e) ? `Couldn't restore. ${storeMessage(e)}` : "Couldn't restore this file. Nothing on this phone was changed.");
  }
  // Restoring means Pitaka was used before: skip the welcome steps (payday can be fixed in Settings).
  if (!db.settings.onboarded) try { setSettings({ onboarded: true }); } catch { /* onboarding shows again; nothing lost */ }
  try { sessionStorage.setItem('pitaka.restored', '1'); } catch { /* the offer to set a PIN is skipped */ }
  location.reload();
}

function exportRescued() {
  // If no copy could be made, the unreadable text is still under the main key (Pitaka won't overwrite it).
  const key = ui.loadProblem?.rescuedKey || 'pitaka.data';
  let raw = null;
  try { raw = key && localStorage.getItem(key); } catch { raw = null; }
  if (!raw) return toast("The unreadable copy couldn't be found");
  deliverFile(new File([raw], 'pitaka-unreadable-data.txt', { type: 'text/plain' }));
}

function payItem({ kind, id }) {
  if (kind === 'bill') {
    const b = S.bill(id);
    if (!b) return toast("That bill wasn't found");
    return txnForm({ kind: 'expense', amount: b.amount, categoryId: b.categoryId, note: b.name, billId: b.id });
  }
  const d = S.debt(id);
  if (!d) return toast("That debt wasn't found");
  const amt = schedPay(d);
  txnForm({ kind: 'debt', debtId: d.id, amount: Math.min(amt || d.balance, d.balance), amountAuto: true });
}

function removeWalletRow(el) {
  const row = el.closest('[data-wrow]');
  const form = el.closest('form');
  const id = row?.querySelector('[name=wid]')?.value;
  if (id && form) { const del = form.querySelector('[name=wdel]'); del.value = [del.value, id].filter(Boolean).join(','); }
  row?.remove();
}

// ============================================================ actions (data-action)
const ACTIONS = {
  tab: ({ tab }) => { ui.tab = tab; if (tab === 'reports') { ui.reportMonth = monthKey(today()); ui.reportFollowsNow = true; } render(); },
  closeSheet,
  add: () => txnForm({}),
  settings: () => settingsSheet(),
  hideHint: () => { setSettings({ hideInstallHint: true }); refresh(); },
  hideSetup: () => { pref.set('setupHidden', '1'); refresh(); },
  goPlan: ({ sub }) => { closeSheet(); ui.tab = 'plan'; ui.planTab = sub; render(); },
  planTab: ({ sub }) => { ui.planTab = sub; refresh(); },
  filter: ({ f }) => { ui.filter = f; refresh(); },
  togglePaid: () => { ui.showPaid = !ui.showPaid; refresh(); },
  month: ({ d }) => {
    ui.reportMonth = shiftMonth(ui.reportMonth, Number(d));
    if (ui.reportMonth > monthKey(today())) ui.reportMonth = monthKey(today());
    ui.reportFollowsNow = ui.reportMonth === monthKey(today());
    refresh();
  },

  logPaycheck: () => txnForm({ kind: 'income', amount: db.settings.payAmount || undefined, note: 'Salary' }),
  txnKind: ({ kind }) => {
    readDraft($('#txn-form'));
    if (draft.kind === kind) return;
    draft.kind = kind;
    if (draft.amountAuto) { draft.amountText = ''; draft.amountAuto = false; }
    renderTxnForm();
  },
  inst: ({ d }, el) => {
    const form = el.closest('#sheet').querySelector('#txn-form');
    readDraft(form);
    draft.installments = Math.max(0, (Number(draft.installments) || 0) + Number(d));
    draft.instTouched = true;
    updateStepper(form);
  },
  editTxn: ({ id }) => editTxn(id),
  deleteTxn: ({ id }) => deleteTxn(id),
  payItem,
  payDebt: ({ id }) => payItem({ kind: 'debt', id }),

  addDebtMenu: () => addDebtMenu(),
  importSheet: () => importSheet(),
  importSave: ({ ctx }, el) => {
    const { added, failed } = importSave(el);
    if (!added) return toast(failed ? 'None of those could be added' : 'Tick at least one debt');
    refresh();
    if (ctx === 'onboard') { if (!failed) showOnboarding(4); toast(`Added ${added} debt${added === 1 ? '' : 's'}`); return; }
    if (!failed) { closeSheet(); ui.tab = 'debts'; render(); }
    toast(`Added ${added} debt${added === 1 ? '' : 's'}${failed ? `. ${failed} need fixing` : ''}`);
  },
  debtForm: ({ id }) => debtForm(id ? S.debt(id) : null),
  debtSheet: ({ id }) => debtSheet(S.debt(id)),
  deleteDebt: ({ id }) => {
    if (!confirm('Delete this debt? Its payments stay in Activity.')) return;
    S.deleteDebt(id); closeSheet(); refresh(); toast('Debt deleted');
  },
  feeForm: ({ id }) => txnForm({ kind: 'adjust', debtId: id, direction: 'up', reason: 'fee' }),
  fixDebt: ({ id }) => fixDebtForm(S.debt(id)),
  calendar: async ({ kind, id }) => {
    const item = kind === 'bill' ? S.bill(id) : S.debt(id);
    const file = item && icsForItem(kind, item);
    if (!file) return toast('There is no upcoming due date to add');
    if ((await deliverFile(file)) === 'downloaded') toast('Open the downloaded file to add it to Calendar');
  },
  calendarAll: async () => {
    const file = icsForAll();
    if (!file) return toast('No due dates yet. Add bills or debts first.');
    if ((await deliverFile(file)) === 'downloaded') toast('Open the downloaded file to add the dates to Calendar');
  },

  billForm: ({ id }) => billForm(id ? S.bill(id) : null),
  deleteBill: ({ id }) => { if (confirm('Delete this bill? Payments you logged for it stay in Activity.')) { S.deleteBill(id); closeSheet(); refresh(); toast('Bill deleted'); } },

  goalForm: ({ id }) => goalForm(id ? S.goal(id) : null),
  goalSheet: ({ id }) => goalSheet(S.goal(id)),
  goalMoney: ({ id, w }) => txnForm({ kind: 'goal', goalId: id, withdraw: w ? '1' : '' }),
  deleteGoal: ({ id }) => { if (confirm('Delete this goal? Its deposits stay in Activity.')) { S.deleteGoal(id); closeSheet(); refresh(); toast('Goal deleted'); } },

  catForm: ({ id }) => catForm(id ? db.categories.find((c) => c.id === id) : null),
  deleteCat: ({ id }) => {
    if (!confirm('Delete this category? Past expenses in it will show as Uncategorized.')) return;
    S.deleteCategory(id); closeSheet(); refresh();
  },
  pickEmoji: ({ e }, el) => {
    const i = $('#sheet [name=emoji]');
    if (i) i.value = e;
    for (const b of el.parentElement.children) b.classList.toggle('on', b === el);
  },

  walletSheet: ({ id }) => walletSheet(id),
  walletForm: ({ id, focus }) => walletForm(id ? S.account(id) : null, { focus }),
  deleteWallet: ({ id }) => {
    if (!confirm('Delete this wallet?')) return;
    S.deleteAccount(id); closeSheet(); refresh(); toast('Wallet deleted');
  },
  moveMoney: ({ id }) => txnForm({ kind: 'transfer', accountId: id }),
  balancesForm: () => balancesForm(),
  addWalletRow: (_, el) => {
    const list = el.closest('form, .onboard-inner').querySelector('[data-wrows]');
    list.insertAdjacentHTML('beforeend', balanceRow());
    list.lastElementChild.querySelector('[name=wname]').focus();
  },
  removeWalletRow: (_, el) => removeWalletRow(el),

  setPin: () => { closeSheet(); Lock.start('set'); },
  removePin: () => {
    if (!confirm('Turn off the PIN lock?')) return;
    setSettings({ pinHash: null, pinSalt: null, pinFails: 0, pinLockUntil: 0 });
    settingsSheet();
    toast('PIN turned off');
  },
  exportData: () => exportData(),
  importData: () => $('#importFile').click(),
  exportRescued: () => exportRescued(),
  eraseAll: () => {
    if (!confirm('Erase ALL data on this phone? This cannot be undone.')) return;
    if (!confirm('Really erase everything? Save a backup first if you might need it.')) return;
    S.resetAll();
    location.reload();
  },

  continueBrowser: () => continueInBrowser(),
  onbGo: ({ step }) => showOnboarding(step),
  onbPin: () => onboardPin(),
  onbFinish: () => finishOnboarding(),

  applyUpdate: () => applyUpdate(),
  dismissBanner: ({ k }) => clearBanner(k),
};

function reportError(err) {
  if (!isValidation(err) && !isStoreError(err)) console.error(err);
  if (isStoreError(err)) saveFailed(err);
  toast(errorMessage(err), { ms: 5000 });
  refresh();
}
function saveFailed(err) {
  setBanner('save', { level: 'critical', title: "Pitaka couldn't save", text: storeMessage(err), actions: [['Save backup', 'exportData', 'primary']] });
}

// ============================================================ events
document.addEventListener('click', (e) => {
  if (e.target.closest('#toast .toast-action')) { e.preventDefault(); return runToastAction(); }
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('[inert]') || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  setTrigger(el);
  try {
    const r = fn({ ...el.dataset }, el);
    if (r && typeof r.catch === 'function') r.catch(reportError);
  } catch (err) {
    reportError(err);
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.busy || form.closest('[inert]')) return;
  const fn = FORMS[form.dataset.form];
  if (!fn) return;
  setBusy(form, true);
  clearFormError(form);
  try {
    fn(form);
    clearBanner('save');
  } catch (err) {
    setBusy(form, false);
    if (isStoreError(err)) { saveFailed(err); refresh(); }
    showFormError(form, err);
    return;
  }
  // Forms that stay on screen (e.g. Settings → Save payday) become usable again.
  if (form.isConnected && !$('#sheet').inert) setBusy(form, false);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.hasAttribute?.('aria-invalid')) t.removeAttribute('aria-invalid');
  if (t.name === 'amount' && t.closest('.amount-big')) {
    liveFormat(t);
    sizeAmount(t);
    const form = t.form;
    if (draft && form?.id === 'txn-form') {
      draft.amountText = t.value;
      draft.amountAuto = false;
      if (draft.kind === 'debt' && !draft.instTouched) autoInstallments(form);
    }
  } else if (t.hasAttribute?.('data-money')) {
    liveFormat(t);
  }
  if (t.dataset?.input === 'search') {
    ui.search = t.value;
    $('#act-list').innerHTML = activityList();
  }
  if (t.hasAttribute?.('data-import-text')) onImportInput(t);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const form = t.closest('form');
  if (t.dataset.impInc !== undefined || t.dataset.impType !== undefined) return onImportChange(t);
  if (form?.dataset.form === 'debt' && t.name === 'type') {
    form.dataset.type = t.value;
    const l = form.querySelector('[data-bal-label]');
    if (l) l.textContent = t.value === 'card' ? 'Current balance' : 'Remaining balance';
  }
  if (t.name === 'frequency' && form) { const semi = form.querySelector('[data-semi]'); if (semi) semi.hidden = t.value !== 'semimonthly'; }
  if (form?.id === 'txn-form' && draft) {
    if (t.name === 'debtId') {
      readDraft(form);
      draft.instTouched = false;
      if (!draft.amountText) draft.amountAuto = true;
      renderTxnForm({ focusAmount: false });
    } else if (t.name === 'withdraw') {
      readDraft(form);
      renderTxnForm({ focusAmount: false });
    }
  }
});

document.addEventListener('keydown', (e) => {
  // While the lock is up, keys never reach the app behind it.
  if (Lock.mode) {
    const inLock = e.target.closest?.('#lock');
    if (/^\d$/.test(e.key)) Lock.press(e.key);
    else if (e.key === 'Backspace') Lock.press('del');
    if (!(inLock && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab'))) e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key === 'Escape' && isSheetOpen()) { e.preventDefault(); closeSheet(); return; }
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.matches?.('[role="button"][data-action]')) { e.preventDefault(); el.click(); }
}, true);

document.querySelectorAll('#lock [data-k]').forEach((b) => b.addEventListener('click', () => Lock.press(b.dataset.k)));
$('#lock-cancel').addEventListener('click', () => Lock.close(false));
$('#lock-forgot').addEventListener('click', () => Lock.forgot());
$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) restoreFile(file);
});

// iOS only applies :active styles when a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });

// Keyboard: keep sheets above it and the focused field in view.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const kb = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', kb);
  vv.addEventListener('scroll', kb);
}
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t.matches?.('input, select, textarea') || !t.closest('.sheet-panel, #onboard')) return;
  setTimeout(() => { if (document.activeElement === t) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 300);
});

// Background: hide balances from the app switcher, re-lock after a while, and pick up date changes on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    Lock.hiddenAt = Date.now();
    if (db.settings.pinHash) document.body.classList.add('privacy');
    if (SW.ready && isIdle()) applyUpdate();
    return;
  }
  const away = Date.now() - Lock.hiddenAt;
  if (db.settings.pinHash && !Lock.mode && db.settings.onboarded && away > (Number(db.settings.lockAfterSec) || 60) * 1000) Lock.start('unlock');
  // The cover only matters for the app-switcher snapshot; the lock screen (if any) now hides the data.
  document.body.classList.remove('privacy');
  if (ui.reportFollowsNow) ui.reportMonth = monthKey(today());
  refresh();
  checkForUpdate();
});
window.addEventListener('pagehide', () => { if (db.settings.pinHash) document.body.classList.add('privacy'); });

// ============================================================ service worker (contract §6)
const SW = { reg: null, ready: false, applying: false, checkedAt: Date.now() };
const isIdle = () => !isSheetOpen() && !isOverlayOpen() && !isLockOpen();

function updateReady() {
  SW.ready = true;
  if (isIdle()) return applyUpdate();
  setBanner('update', { level: 'info', icon: 'download', title: 'New version ready', text: 'Reload to use it. Finish what you are typing first.', actions: [['Reload', 'applyUpdate', 'primary']] });
}
function applyUpdate() {
  const w = SW.reg?.waiting;
  if (!w) { if (SW.ready) location.reload(); return; }
  SW.applying = true;
  w.postMessage({ type: 'SKIP_WAITING' });
}
function checkForUpdate() {
  if (!SW.reg || Date.now() - SW.checkedAt < 6 * 3600 * 1000) return;
  SW.checkedAt = Date.now();
  SW.reg.update().catch(() => {});
}
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || LOCAL)) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    SW.reg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) updateReady();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) updateReady(); });
    });
  }).catch(() => { /* offline support just isn't available */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!SW.applying || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

// ============================================================ boot
ensureEl('banner-slot', 'div', '', $('#main'));
ensureEl('install', 'section', 'overlay');
let loaded;
try { loaded = S.load(); } catch (e) { console.error(e); loaded = { ok: false, reason: 'unreadable' }; }
if (loaded && loaded.ok === false) {
  ui.loadProblem = loaded;
  if (loaded.reason === 'blocked') {
    setBanner('load', { level: 'critical', title: "Pitaka can't save on this phone", text: 'The browser is blocking storage (Private Browsing or "Block All Cookies" in Safari settings can do this). Anything you enter will be lost when you close Pitaka.', dismiss: 'OK' });
  } else {
    setBanner('load', { level: 'critical', title: "Your saved data couldn't be read", text: loaded.rescuedKey ? 'Pitaka kept the unreadable copy aside on this phone (it was not deleted) and opened empty. Restore your latest backup to get your entries back.' : "Pitaka left it untouched and won't save anything new over it. Restore your latest backup, or save the unreadable copy first.", actions: [['Restore backup', 'importData', 'primary'], ['Save unreadable copy', 'exportRescued']] });
  }
}
renderBanners();
render();
if (!db.settings.onboarded) {
  if (needsInstall()) showInstall(); else showOnboarding(1);
}
if (db.settings.pinHash) Lock.start('unlock');
syncInert();
try { navigator.storage?.persist?.(); } catch { /* not supported */ }

let restored = false;
try { restored = sessionStorage.getItem('pitaka.restored') === '1'; sessionStorage.removeItem('pitaka.restored'); } catch { restored = false; }
if (restored && db.settings.onboarded && !db.settings.pinHash) restoredSheet();

// Test hook, only when served from this computer.
if (LOCAL) window.pitaka = { db: () => db, S, ui, render, toISO, parseISO, advance, Lock, Onboard };
