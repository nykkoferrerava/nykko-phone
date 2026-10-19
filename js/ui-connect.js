// The inbox relay in the app: pairing, its status, the write token for your shortcuts, and collecting
// when Pitaka opens or comes back to the foreground (js/sync.js does the work).
import * as S from './store.js';
import { db } from './store.js';
import * as Sync from './sync.js';
import { newAdminSecret } from './relay-client.js';
import { esc, fmtDate, toISO } from './util.js';
import { $, ui, icon, openSheet, closeSheet, sheetHead, field, toast, FormProblem, str, haptic, setBanner, clearBanner } from './ui-core.js';
import { refresh } from './ui-views.js';
import { announce } from './ui-review.js';

// The guide loads on first use and adds its Copy buttons' values here (ui-guide.js imports this file).
export const guideHooks = { copy: null };

const conn = { adminSecret: '', showWrite: false, status: null, statusAt: 0 };

// ------------------------------------------------------------------ helpers
// Links to the setup guides: on GitHub when Pitaka runs from GitHub Pages (they open in Safari).
export function docsUrl(file) {
  const m = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}/blob/HEAD/docs/${file}` : `./docs/${file}`;
}
export const docsLink = (file, label) => `<a class="row" href="${esc(docsUrl(file))}" target="_blank" rel="noopener noreferrer"><span class="icon" aria-hidden="true">${icon('file')}</span><span class="grow"><span class="title">${esc(label)}</span><span class="meta">${esc(file)}</span></span><span class="chev" aria-hidden="true">${icon('external')}</span></a>`;

export async function copyText(text, done = 'Copied') {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (!ok) return toast("Couldn't copy", { sub: 'Touch and hold the text to copy it instead.' });
  haptic();
  toast(done, { icon: 'copy', ms: 1800 });
}
// Values the Copy buttons can copy, looked up by name so secrets aren't written into the page twice.
const COPY = {
  url: () => Sync.info().url,
  write: () => Sync.info().write,
  adminSecret: () => conn.adminSecret,
};
export function copyValue(key, data = {}) {
  if (key === 'g') return guideHooks.copy?.(data);
  const v = COPY[key]?.();
  if (!v) return toast('Nothing to copy yet');
  return copyText(v, key === 'write' ? 'Write token copied' : key === 'url' ? 'Relay address copied' : 'Copied');
}
export const copyBtn = (key, what = '') => `<button type="button" class="btn small tinted" data-action="copy" data-k="${esc(key)}"${what ? ` aria-label="Copy ${esc(what)}"` : ''}>${icon('copy')}Copy</button>`;

const whenText = (ms) => {
  if (!ms) return 'never';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${sameDay ? 'today' : fmtDate(toISO(d))} at ${d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`;
};
export function relayMessage(e) {
  switch (e?.code) {
    case 'network': return `Couldn't reach the relay. Check the address and your connection. If it's right, check that ALLOWED_ORIGIN in Cloudflare is ${location.origin}.`;
    case 'origin': return `The relay doesn't accept this address. Set ALLOWED_ORIGIN in Cloudflare to ${location.origin}.`;
    case 'auth': return Sync.paired() ? 'The relay no longer accepts Pitaka. Was it paired again from somewhere else? Unpair, then pair again.' : "That setup secret isn't the one in Cloudflare (ADMIN_SECRET).";
    case 'unpaired': return 'The relay has no pairing (its database was reset?). Unpair, then pair again.';
    case 'busy': return 'The relay is busy. Wait a minute and try again.';
    case 'server': return e.message || 'The relay had a problem.';
    case 'storage': return e.message;
    default: return e?.message || 'Something went wrong';
  }
}

// ------------------------------------------------------------------ the relay sheet
const backFor = (from) => ({ connect: ['Connect', 'connectGuide'], settings: ['Settings', 'settings'], inboxSettings: ['Inbox', 'inboxSettings'] })[from] || null;

export function relaySheet(from = 'inboxSettings') {
  ui.relayFrom = from;
  if (Sync.paired()) return pairedSheet(from);
  const s = conn.adminSecret;
  const storage = Sync.canPair() ? '' : `<div class="banner warning" role="status">${icon('alert')}<div><strong>Pairing needs Pitaka's newer storage</strong><span class="meta">This phone is using the older storage, which can't keep the relay's private key. You can still catch up from Files.</span></div></div>`;
  openSheet(`${sheetHead('Inbox relay', { back: backFor(from) })}
    <p class="pad meta">A tiny Cloudflare Worker you own, on the free plan. Your shortcuts send to it; it seals each item so only this iPhone can open it, and holds it until Pitaka opens. Pitaka works fine without it.</p>
    ${storage}
    <h3>1 · Deploy your relay</h3>
    <p class="pad meta">Follow the relay guide once (about 10 minutes, no coding). It asks for a setup secret: make one here and paste it into Cloudflare as <b>ADMIN_SECRET</b>. Pitaka doesn't keep it.</p>
    <div class="list card">
      <div class="row stack"><div class="row-line"><span class="title">Setup secret</span>${s ? copyBtn('adminSecret', 'the setup secret') : `<button type="button" class="btn small tinted" data-action="makeAdminSecret">${icon('key')}Make one</button>`}</div><span class="meta mono-wrap" id="admin-secret">${s ? esc(s) : 'Not made yet'}</span></div>
      ${docsLink('SETUP-RELAY.md', 'Open the relay guide')}
    </div>
    <h3>2 · Pair Pitaka</h3>
    <form id="relay-form" data-form="relayPair" novalidate>
      ${field('Relay address', `<input name="url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" maxlength="200" placeholder="pitaka-relay.yourname.workers.dev" value="${esc(db.settings.relayUrl || '')}">`, 'Cloudflare shows it after you deploy. It ends in .workers.dev.')}
      ${field('Setup secret', `<input name="secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" value="${esc(s)}">`, 'The ADMIN_SECRET you saved in Cloudflare. Used once to pair.')}
      <details class="pad"><summary>Your shortcuts already have a write token?</summary>
        ${field('Keep this write token', '<input name="keepWrite" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60" placeholder="43 letters and digits">', 'After a restore or on a new phone: copy it from one of your shortcuts, and none of them need changing.')}
      </details>
      <button class="btn primary block" type="submit" ${Sync.canPair() ? '' : 'disabled'}>${icon('link')}Pair</button>
    </form>`);
}

function pairedSheet(from) {
  const i = Sync.info();
  const st = conn.status;
  const host = Sync.relayHost();
  const writeShown = conn.showWrite ? esc(i.write) : '•'.repeat(24);
  openSheet(`${sheetHead('Inbox relay', { back: backFor(from) })}
    <div class="card row ok-row"><span class="icon accent" aria-hidden="true">${icon('check-circle')}</span><span class="grow"><span class="title">Paired with your relay</span><span class="meta">${esc(host)} · since ${esc(whenText(i.pairedAt))}</span></span></div>
    <div class="list card">
      <div class="row stack"><div class="row-line"><span class="title">Relay address</span>${copyBtn('url', 'the relay address')}</div><span class="meta mono-wrap">${esc(i.url)}</span></div>
      <div class="row stack"><div class="row-line"><span class="title">Write token</span><span class="btns"><button type="button" class="btn small" data-action="toggleWrite" aria-pressed="${conn.showWrite}">${icon(conn.showWrite ? 'eye-off' : 'eye')}${conn.showWrite ? 'Hide' : 'Show'}</button>${copyBtn('write', 'the write token')}</span></div><span class="meta mono-wrap" id="write-token">${writeShown}</span></div>
    </div>
    <p class="pad meta">The write token can only add items. Paste it into each shortcut where the guide says <b>write token</b>. Never share it in a screenshot.</p>
    <h3>Status</h3>
    <div class="list card" id="relay-status">
      <div class="row"><span class="grow"><span class="title">Last collected</span><span class="meta">${esc(whenText(i.lastOk))}${i.lastError ? ` · last try failed: ${esc(i.lastError)}` : ''}</span></span></div>
      <div class="row"><span class="grow"><span class="title">Waiting on the relay</span><span class="meta" id="relay-pending">${st ? esc(pendingText(st.pending)) : 'Checking…'}</span></span></div>
    </div>
    <div class="actions">
      <button type="button" class="btn primary" data-action="relayCheck">${icon('refresh')}Check now</button>
      <button type="button" class="btn" data-action="relayTest">${icon('check-circle')}Send a test</button>
    </div>
    <h3>If something's wrong</h3>
    <div class="list card">
      <button type="button" class="row" data-action="relayRotate"><span class="icon" aria-hidden="true">${icon('refresh')}</span><span class="grow"><span class="title">Make a new write token</span><span class="meta">If it leaked. Every shortcut then needs the new one.</span></span></button>
      <button type="button" class="row danger" data-action="relayUnpair"><span class="icon" aria-hidden="true">${icon('x')}</span><span class="grow"><span class="title">Unpair this iPhone</span><span class="meta">Pitaka stops collecting. Your entries stay.</span></span></button>
    </div>`);
  refreshStatus();
}

// The relay's answer is never trusted as markup: only a whole number gets through.
const pendingText = (n) => { const k = Math.max(0, Math.trunc(Number(n)) || 0); return `${k} item${k === 1 ? '' : 's'}`; };
async function refreshStatus() {
  try {
    conn.status = await Sync.status();
    conn.statusAt = Date.now();
  } catch (e) { conn.status = null; const el = $('#relay-pending'); if (el) el.textContent = relayMessage(e); return; }
  const el = $('#relay-pending');
  if (el && conn.status) el.textContent = pendingText(conn.status.pending);
}

// ------------------------------------------------------------------ collecting
let pendingNews = null;
// `manual`: from "Check now", which always reports back.
export async function syncNow({ manual = false, locked = false } = {}) {
  if (!Sync.paired()) { if (manual) toast('Pair with your relay first'); return null; }
  let got;
  try { got = await Sync.collect({ force: manual }); } catch (e) {
    if (manual) toast("Couldn't collect", { warn: true, sub: relayMessage(e) });
    else if (['auth', 'unpaired', 'origin'].includes(e?.code)) setBanner('relay', { level: 'warning', icon: 'cloud', title: 'The relay needs attention', text: relayMessage(e), actions: [['Open', 'relaySheet']], dismiss: 'Later' });
    return null;
  }
  clearBanner('relay');
  if (!got) { if (manual) toast('Nothing new on the relay', { icon: 'check', ms: 2000 }); return null; }
  refresh();
  if (locked) pendingNews = got; else showNews(got, manual);
  return got;
}
// What arrived while the PIN screen was up is announced after unlocking, not over the lock screen.
export function showPendingNews() {
  const got = pendingNews;
  pendingNews = null;
  if (got) showNews(got, false);
}
function showNews(got, manual) {
  if (got.unreadable || got.skipped) {
    const n = got.unreadable + got.skipped;
    setBanner('relay-unreadable', { level: 'warning', icon: 'cloud', title: `${n} item${n === 1 ? '' : 's'} from the relay couldn't be opened`, text: 'They were sealed for an earlier pairing, so only that pairing could read them; they have been cleared from the relay. A Quick Add among them is still in iCloud Drive: Import from Files brings it back.', actions: [['Import from Files', 'importInbox']], dismiss: 'OK' });
  }
  if (got.out && announce(got.out, got.from)) return;
  const tests = got.out?.tests.length || 0;
  if (tests) toast(`Test received${tests > 1 ? ` (${tests})` : ''}`, { icon: 'check-circle', sub: 'Your shortcut reached Pitaka through the relay.' });
  else if (manual) toast(got.out?.duplicates ? 'Nothing new: already in Pitaka' : 'Nothing new on the relay', { icon: 'check', ms: 2000 });
}

// Once paired, Pitaka may only connect to itself and this relay. A second Content-Security-Policy
// narrows the one in index.html (a page obeys both). Unpairing reloads the page to lift it.
export function narrowCsp() {
  const url = Sync.info().url;
  if (!url || document.querySelector('meta[data-relay-csp]')) return;
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  const m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = `connect-src 'self' ${origin}`;
  m.dataset.relayCsp = '';
  document.head.append(m);
}

// ------------------------------------------------------------------ actions and forms
export const CONNECT_ACTIONS = {
  relaySheet: ({ from }) => relaySheet(from || ui.relayFrom || 'inboxSettings'),
  copy: (d) => copyValue(d.k, d),
  makeAdminSecret: () => { conn.adminSecret = newAdminSecret(); relaySheet(ui.relayFrom); copyValue('adminSecret'); },
  toggleWrite: () => { conn.showWrite = !conn.showWrite; relaySheet(ui.relayFrom); },
  relayCheck: async () => { await syncNow({ manual: true }); if (Sync.paired() && $('#relay-status')) relaySheet(ui.relayFrom); },
  relayTest: async () => {
    try {
      const got = await Sync.selfTest();
      if (got) showNews(got, true);
      if ($('#relay-status')) relaySheet(ui.relayFrom);
    } catch (e) { toast("The test didn't arrive", { warn: true, sub: relayMessage(e) }); }
  },
  relayRotate: async () => {
    if (!confirm('Make a new write token?\n\nThe current one stops working at once, so every shortcut needs the new token pasted in.')) return;
    try { await Sync.rotateWrite(); conn.showWrite = true; relaySheet(ui.relayFrom); toast('New write token made', { icon: 'key', sub: 'Copy it into each of your shortcuts.' }); } catch (e) { toast("Couldn't change the token", { warn: true, sub: relayMessage(e) }); }
  },
  relayUnpair: async () => {
    if (!confirm('Unpair this iPhone from the relay?\n\nPitaka stops collecting from it. Anything still waiting there stays until it expires (30 days), unless you pair again first.')) return;
    await Sync.unpair();
    location.reload(); // lifts the narrowed Content-Security-Policy
  },
};

export const CONNECT_FORMS = {
  async relayPair(form) {
    const f = new FormData(form);
    const url = str(f, 'url', 200);
    const secret = str(f, 'secret', 200);
    if (!url) throw new FormProblem('Paste your relay address', 'url');
    if (!secret) throw new FormProblem('Enter the setup secret', 'secret');
    let p;
    try { p = await Sync.pairWith(url, secret, { keepWrite: str(f, 'keepWrite', 60) }); } catch (e) {
      throw new FormProblem(relayMessage(e), e?.code === 'auth' ? 'secret' : e?.code === 'invalid' && /token/.test(e.message) ? 'keepWrite' : 'url');
    }
    conn.adminSecret = '';
    conn.showWrite = true;
    narrowCsp();
    haptic();
    relaySheet(ui.relayFrom);
    toast('Paired with your relay', { icon: 'check-circle', sub: p.pending ? `${p.pending} item${p.pending === 1 ? ' was' : 's were'} waiting` : 'Now copy the write token into your shortcuts.' });
    await syncNow({ manual: false });
    if ($('#relay-status')) relaySheet(ui.relayFrom); // shows the first collection
  },
};
