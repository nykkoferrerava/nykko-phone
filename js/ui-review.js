// The Review inbox: what arrived from your shortcuts and alerts that needs a decision, what Pitaka added
// on its own (with Undo), "Teach this format", and the Settings pages for alert formats, card mapping
// and the inbox.
import * as S from './store.js';
import { db } from './store.js';
import * as X from './inbox.js';
import * as Sync from './sync.js';
import * as A from './alerts.js';
import { esc, peso, fmtDate, today, toISO } from './util.js';
import {
  $, ui, pw, icon, openSheet, closeSheet, sheetHead, saveLink, field, select, toast, FormProblem, str, haptic, emptyState, barBtn, header, accounts,
} from './ui-core.js';
import { EXTRA_VIEWS, homeButtons, backBtn, txnRow, refresh, render } from './ui-views.js';
import { budgetWarning, budgetWarningText } from './insights.js';

export const review = { selecting: false, selected: new Set(), open: new Set() };

const SRC = {
  entry: ['vibrate', 'Quick Add'], text: ['vibrate', 'Quick text'], sms: ['message', 'SMS'], email: ['mail', 'Email'],
  wallet: ['wallet', 'Apple Wallet'], balance: ['wallet', 'Balance check'], drift: ['alert', 'Balance'], test: ['check-circle', 'Test'],
};
const REASON = {
  unparsed: ['Unknown format', 'warning'], unsure: ['Not sure', 'warning'], duplicate: ['Possible duplicate', 'warning'], drift: ['Balance drift', 'critical'],
  transfer: ['Transfer?', 'accent'], sent: ['Sent money', 'accent'], lending: ['Lent or borrowed?', 'accent'], repayment: ['Paid back?', 'accent'],
  'no-wallet': ['Which wallet?', 'warning'], undone: ['Undone', ''],
};
const timeOf = (ms) => { const d = new Date(ms); const day = toISO(d); return `${day === today() ? 'Today' : fmtDate(day)} · ${d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`; };
export function sourceLabel(it) {
  const [ic, label] = SRC[it.type] || ['inbox', 'Item'];
  const inst = it.parsed?.inst;
  if (it.type === 'sms') return [ic, `${inst || it.raw?.sender || 'Text'} SMS`];
  if (it.type === 'email') return [ic, `${inst || (it.raw?.from || '').replace(/<.*$/, '').trim() || 'Email'}`];
  return [ic, label];
}
const rawText = (it) => (it.type === 'email' ? A.alertText(it) : it.type === 'text' ? it.raw?.text : it.type === 'sms' ? it.raw?.text : '') || '';

// ------------------------------------------------------------------ Home: button and card
homeButtons.review = () => {
  const n = X.reviewCount();
  if (!n && !db.inbox.length) return '';
  return barBtn('tab', 'inbox', 'Review', 'data-tab="review"', n);
};
homeButtons.reviewCard = () => {
  const items = X.pending();
  if (!items.length) return '';
  const drift = items.filter((x) => x.reason === 'drift').length;
  const sub = [drift ? `${drift} balance${drift === 1 ? '' : 's'} to check` : '', items.length - drift ? `${items.length - drift} entr${items.length - drift === 1 ? 'y' : 'ies'} to confirm` : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="card row review-nudge" data-action="tab" data-tab="review"><span class="icon accent" aria-hidden="true">${icon('inbox')}</span><span class="grow"><span class="title">${items.length} to review</span><span class="meta">${esc(sub)}</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button>`;
};

// ------------------------------------------------------------------ the Review screen
function proposalLines(it) {
  const p = it.parsed || {};
  if (it.reason === 'drift' || it.type === 'drift') {
    const d = it.drift || {};
    const name = S.account(d.accountId)?.name || it.raw?.wallet || 'Wallet';
    const diff = (d.reported ?? 0) - (d.computed ?? 0);
    return [`${esc(name)} says ${esc(peso(d.reported))}`, `Pitaka has ${esc(peso(d.computed))} · a Balance fix of ${diff > 0 ? '+' : '−'}${esc(peso(Math.abs(diff)))} makes them match`];
  }
  if (!(p.amount > 0)) return [it.type === 'balance' ? `Balance for "${esc(it.raw?.wallet || '?')}"` : 'Pitaka couldn\'t read an amount', ''];
  const main = X.describeProposal(p);
  const details = [p.parser === 'generic' ? 'Guessed from the amount only' : p.unverified ? 'Built-in format (unverified)' : p.parser === 'template' ? 'Your format' : '', p.ref ? `Ref ${p.ref}` : '', p.balanceAfter !== undefined ? `balance ${peso(p.balanceAfter)}` : ''].filter(Boolean).join(' · ');
  return [esc(main), esc(details)];
}

function actionsFor(it) {
  const b = (label, action, cls = '', extra = '') => `<button type="button" class="btn small ${cls}" data-action="${action}" data-id="${esc(it.id)}" ${extra}>${label}</button>`;
  const alert = ['sms', 'email', 'wallet'].includes(it.type);
  const teach = alert && it.type !== 'wallet' ? b(`${icon('tag')}Teach`, 'reviewTeach') : '';
  const ignore = b('Ignore', 'reviewIgnore', 'plain');
  const p = it.parsed || {};
  const has = p.amount > 0;
  switch (it.reason) {
    case 'drift': return [b(`${icon('check')}Fix balance`, 'reviewAccept', 'primary'), ignore];
    case 'duplicate': return [b(`${icon('link')}Same entry`, 'reviewLink', 'primary'), b('Add anyway', 'reviewAccept', '', 'data-create="1"'), ignore];
    case 'transfer': return [b(`${icon('swap')}Transfer`, p.kind === 'transfer' ? 'reviewAccept' : 'reviewTransfer', 'primary'), b(p.side === 'in' || p.kind === 'income' ? 'Income' : 'Expense', 'reviewAccept', '', `data-as="${p.side === 'in' || p.kind === 'income' ? 'income' : 'expense'}"`), ignore];
    case 'sent': return [b('Expense', 'reviewAccept', 'primary', 'data-as="expense"'), b(`${icon('out')}Lent`, 'reviewAccept', '', 'data-as="lent"'), b(`${icon('swap')}Transfer`, 'reviewTransfer'), ignore];
    case 'lending': return [b(`${icon('out')}I lent`, 'reviewAccept', 'primary', 'data-as="lent"'), b(`${icon('in')}I borrowed`, 'reviewAccept', '', 'data-as="borrowed"'), ignore];
    case 'repayment': return [b(`${icon('in')}Paid back`, 'reviewAccept', 'primary'), b('Income', 'reviewAccept', '', 'data-as="income"'), ignore];
    case 'unparsed': return [teach || '', b(`${icon('edit')}Add by hand`, 'reviewEdit', teach ? '' : 'primary'), ignore].filter(Boolean);
    default: return [has ? b(`${icon('check')}Accept`, 'reviewAccept', 'primary') : '', b(`${icon('edit')}Edit`, 'reviewEdit', has ? '' : 'primary'), it.candidates?.length ? b(`${icon('link')}Link`, 'reviewLink') : '', teach, ignore].filter(Boolean);
  }
}

function reviewCard(it) {
  const [ic, label] = sourceLabel(it);
  const [chip, tone] = REASON[it.reason] || ['To check', ''];
  const [main, sub] = proposalLines(it);
  const text = rawText(it);
  const cand = it.reason === 'duplicate' && it.candidates?.[0] ? S.txn(it.candidates[0]) : null;
  const sel = review.selecting;
  const open = review.open.has(it.id);
  return `<li class="card review-card${sel && review.selected.has(it.id) ? ' selected' : ''}">
    <div class="rc-top">${sel ? `<input type="checkbox" class="rc-check" data-review-select="${esc(it.id)}" ${review.selected.has(it.id) ? 'checked' : ''} aria-label="Select">` : ''}<span class="rc-src">${icon(ic)}${esc(label)} · ${esc(timeOf(it.at))}</span><span class="chip ${tone}">${esc(chip)}</span></div>
    <p class="rc-main">${main}</p>${sub ? `<p class="meta">${sub}</p>` : ''}
    ${cand ? `<div class="rc-cand"><span class="meta">Looks like what you already have:</span><ul class="list">${txnRow(cand)}</ul></div>` : ''}
    ${text ? `<button type="button" class="quote${open ? ' open' : ''}" data-action="reviewToggle" data-id="${esc(it.id)}" aria-expanded="${open}">${esc(text)}</button>` : it.trimmed ? '<p class="meta">Message text removed after 90 days.</p>' : ''}
    ${sel ? '' : `<div class="rc-actions">${actionsFor(it).join('')}</div>`}
  </li>`;
}

function recentRow(it) {
  const r = it.result || {};
  const t = r.txnId && S.txn(r.txnId);
  const [ic, label] = sourceLabel(it);
  const what = { created: 'Added', confirmed: 'Linked to your entry', paired: 'Paired into a transfer', fixed: 'Balance fixed', matched: 'Balance matched' }[r.action] || 'Done';
  const line = t ? `${peso(t.amount)} · ${t.merchant || t.note || S.cat(t.categoryId).name}` : X.describeProposal(it.parsed) || what;
  return `<li class="row"><span class="icon" aria-hidden="true">${icon(ic)}</span><span class="grow"><span class="title">${esc(line)}</span><span class="meta">${esc(what)} · ${esc(label)} · ${esc(timeOf(it.at))}</span></span>${r.action && r.action !== 'matched' ? `<button type="button" class="btn small" data-action="reviewUndo" data-id="${esc(it.id)}">${icon('undo')}Undo</button>` : ''}</li>`;
}

EXTRA_VIEWS.review = () => {
  const items = X.pending();
  const recent = X.recentAuto(7).slice(0, 30);
  const right = items.length ? `<button type="button" class="bar-btn text" data-action="reviewSelect">${review.selecting ? 'Done' : 'Select'}</button>` : barBtn('pullNow', 'refresh', 'Check for new items');
  const selBar = review.selecting ? `<div class="select-bar" role="toolbar" aria-label="Selected items">
      <button type="button" class="btn small" data-action="reviewSelectAll">${review.selected.size === items.length ? 'None' : 'All'}</button>
      <span class="meta">${review.selected.size} selected</span>
      <button type="button" class="btn small" data-action="reviewIgnoreMany" ${review.selected.size ? '' : 'disabled'}>Ignore</button>
      <button type="button" class="btn small primary" data-action="reviewAcceptMany" ${review.selected.size ? '' : 'disabled'}>Accept</button></div>` : '';
  return `${header('Review', right, items.length ? `${items.length} waiting for you` : 'All caught up', { left: backBtn() })}
    ${items.length ? `<ul class="cards review-list">${items.map(reviewCard).join('')}</ul>` : emptyState({ icon: 'check-circle', title: 'Nothing to review', text: 'Entries from your shortcuts and alerts that Pitaka isn\'t sure about show up here.' })}
    ${recent.length ? `<section><h2>Added on their own</h2><p class="meta pad">From the last 7 days. Undo puts an item back here.</p><ul class="list card">${recent.map(recentRow).join('')}</ul></section>` : ''}
    ${selBar}`;
};

// ------------------------------------------------------------------ after a pull: one toast
// "1 new entry from Quick Add" (with Undo), the budget warning, and how many wait in Review.
export function announce(out, from = 'Quick Add') {
  const added = out.created.length;
  const linked = out.confirmed.filter(Boolean).length + out.paired.length;
  const waiting = out.review.length;
  if (!added && !linked && !waiting) return false;
  const first = added === 1 && S.txn(out.created[0]);
  const warn = out.created.map((id) => budgetWarningText(budgetWarning(S.txn(id)))).find(Boolean) || '';
  const sub = [warn, linked ? `${linked} matched to entries you had` : '', waiting ? `${waiting} to review` : ''].filter(Boolean).join(' · ');
  if (added) {
    const msg = first ? `${peso(first.amount)} · ${first.kind === 'expense' ? S.cat(first.categoryId).name : first.kind === 'income' ? 'Income' : first.kind === 'transfer' ? 'Transfer' : 'Lent'} · ${(first.cardId ? S.debt(first.cardId)?.name : S.account(first.accountId)?.name) || ''} saved` : `${added} new entries from ${from}`;
    toast(added === 1 ? `1 new entry from ${from}` : msg, { icon: 'inbox', sub: added === 1 ? `${msg}${sub ? ` · ${sub}` : ''}` : sub, warn: !!warn, action: 'Undo', onAction: async () => { X.undoBatch(out.batch); await S.flush(); refresh(); toast('Undone. The items are in Review.', { icon: 'undo' }); } });
  } else if (linked) toast(`${linked} entr${linked === 1 ? 'y' : 'ies'} confirmed`, { icon: 'check', sub: waiting ? `${waiting} to review` : 'Matched to what you already logged' });
  else toast(`${waiting} new item${waiting === 1 ? '' : 's'} to review`, { icon: 'inbox', action: 'Review', onAction: () => { ui.tab = 'review'; render(); } });
  return true;
}

// ------------------------------------------------------------------ Teach this format
const teach = { id: '', text: '', tokens: [], marks: {}, field: 'amount' };
const FIELD_NAMES = { amount: 'Amount', merchant: 'Merchant or name', balance: 'Balance', ref: 'Reference no.' };
function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    let start = m.index, end = m.index + m[0].length;
    while (end > start + 1 && /[.,;:!)\]]/.test(text[end - 1])) end--;
    out.push({ t: m[0], start, end });
  }
  return out;
}
const span = (k) => { const r = teach.marks[k]; return r ? [teach.tokens[r[0]].start, teach.tokens[r[1]].end] : null; };
function teachPreview() {
  if (!teach.marks.amount) return { ok: false, text: 'Tap the amount first.' };
  try {
    const marks = {};
    for (const k of Object.keys(FIELD_NAMES)) if (teach.marks[k]) marks[k] = span(k);
    const format = A.buildTemplate(teach.text, marks);
    const m = A.matchTemplate(format, teach.text);
    return { ok: true, format, text: `Reads ${peso(m.amount)}${m.merchant ? ` · ${m.merchant}` : ''}${m.balance ? ` · balance ${peso(m.balance)}` : ''}${m.ref ? ` · ref ${m.ref}` : ''}` };
  } catch (e) { return { ok: false, text: e.message }; }
}
function tokensHtml() {
  const role = (i) => Object.keys(FIELD_NAMES).find((k) => teach.marks[k] && i >= teach.marks[k][0] && i <= teach.marks[k][1]);
  return teach.tokens.map((tk, i) => { const r = role(i); return `<button type="button" class="tok${r ? ` on ${r}` : ''}" data-action="teachTok" data-i="${i}" aria-pressed="${!!r}"${r ? ` aria-label="${esc(tk.t)}, ${FIELD_NAMES[r]}"` : ''}>${esc(tk.t)}</button>`; }).join(' ');
}
export function teachSheet(id) {
  const it = S.inboxItem(id);
  if (!it) return toast("That item wasn't found");
  const text = A.alertText(it).replace(/\s+/g, ' ').trim();
  Object.assign(teach, { id, text, tokens: tokenize(text), marks: {}, field: 'amount' });
  const p = it.parsed || {};
  const wallets = [{ group: 'Wallets', options: accounts().map((a) => [`a:${a.id}`, a.name]) }];
  const cards = db.debts.filter((d) => d.type === 'card');
  if (cards.length) wallets.push({ group: 'Credit cards', options: cards.map((c) => [`c:${c.id}`, c.name]) });
  const guess = p.cardId ? `c:${p.cardId}` : p.accountId ? `a:${p.accountId}` : '';
  openSheet(`${sheetHead('Teach this format', { right: saveLink('teach-form') })}
    <p class="meta pad">Tap the parts that change from message to message. Pitaka remembers the rest and reads the next messages from <b>${esc(A.normSender(it) || 'this sender')}</b> the same way.</p>
    <div class="segmented small" role="radiogroup" aria-label="What are you tapping?">${Object.entries(FIELD_NAMES).map(([k, l]) => `<label><input type="radio" name="teachField" value="${k}" ${k === 'amount' ? 'checked' : ''} data-teach-field><span>${l.split(' ')[0]}</span></label>`).join('')}</div>
    <div class="tok-text" id="tok-text" aria-label="Message">${tokensHtml()}</div>
    <p class="meta pad" id="teach-preview" aria-live="polite">Tap the amount first.</p>
    <form id="teach-form" data-form="teach" novalidate>
      ${field('This message means', select('kind', [['expense', 'Money out (purchase, payment, bill)'], ['income', 'Money in'], ['transfer-out', 'Sent to another of my wallets'], ['transfer-in', 'Received from another of my wallets']], p.kind === 'income' ? 'income' : p.kind === 'transfer' ? `transfer-${p.side || 'out'}` : 'expense'))}
      ${field('For wallet or card', select('target', [{ group: 'Pick one', options: [['', 'Choose…']] }, ...wallets], guess))}
      <button class="btn primary block" type="submit">Save format</button>
    </form>`);
}
function redrawTeach() {
  const box = $('#tok-text');
  if (box) box.innerHTML = tokensHtml();
  const pv = $('#teach-preview');
  if (pv) { const r = teachPreview(); pv.textContent = r.text; pv.classList.toggle('critical-text', !r.ok && !!teach.marks.amount); }
}
export function teachTap(i) {
  const k = teach.field;
  const cur = teach.marks[k];
  if (k === 'merchant' && cur && cur[0] === cur[1] && Math.abs(i - cur[0]) <= 8 && i !== cur[0]) teach.marks[k] = [Math.min(i, cur[0]), Math.max(i, cur[0])];
  else if (cur && cur[0] <= i && i <= cur[1]) delete teach.marks[k];
  else teach.marks[k] = [i, i];
  // another field can't keep a token now used by this one
  for (const o of Object.keys(teach.marks)) if (o !== k && teach.marks[k] && !(teach.marks[o][1] < teach.marks[k][0] || teach.marks[o][0] > teach.marks[k][1])) delete teach.marks[o];
  haptic();
  redrawTeach();
}
export const teachField = (k) => { teach.field = k; };

// ------------------------------------------------------------------ pickers
export function linkSheet(id) {
  const it = S.inboxItem(id);
  if (!it) return;
  const p = it.parsed || {};
  const near = db.txns.filter((t) => Math.abs(t.amount - (p.amount || 0)) < 0.005 && Math.abs(new Date(t.date) - new Date(p.date || today())) <= 3 * 86400000);
  const ids = [...new Set([...(it.candidates || []), ...near.map((t) => t.id)])].map(S.txn).filter(Boolean).slice(0, 12);
  openSheet(`${sheetHead('Which entry is it?', { close: 'Cancel' })}
    <p class="meta pad">${esc(X.describeProposal(p))}. Pick the entry it belongs to; it gets "confirmed" instead of being added again.</p>
    ${ids.length ? `<ul class="list card">${ids.map((t) => txnRow(t).replace('data-action="editTxn"', `data-action="reviewLinkTo" data-item="${esc(id)}"`)).join('')}</ul>` : '<p class="empty card">No entries with the same amount around that date.</p>'}`);
}
export function transferSheet(id) {
  const it = S.inboxItem(id);
  if (!it) return;
  const p = it.parsed || {};
  const own = p.kind === 'transfer' ? (p.side === 'in' ? p.toAccountId : p.accountId) : p.accountId;
  const into = p.kind === 'income' || p.side === 'in';
  openSheet(`${sheetHead(into ? 'Came from which wallet?' : 'Went to which wallet?', { close: 'Cancel' })}
    <p class="meta pad">${esc(X.describeProposal(p))}. Moving money between your own wallets isn't spending or income.</p>
    <div class="list card">${accounts().filter((a) => a.id !== own).map((a) => `<button type="button" class="row" data-action="reviewTransferTo" data-item="${esc(id)}" data-id="${esc(a.id)}"><span class="icon" aria-hidden="true">${icon('wallet')}</span><span class="grow"><span class="title">${esc(a.name)}</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></button>`).join('')}</div>`);
}
// Edit: the entry form, filled in with what Pitaka read; saving settles the item. app.js passes txnForm
// (the entry form loads after Home).
export function editItem(id, txnForm) {
  const it = S.inboxItem(id);
  if (!it) return;
  const p = it.parsed || {};
  const kind = ['income', 'transfer'].includes(p.kind) ? p.kind : 'expense';
  const conf = ['sms', 'email', 'wallet'].includes(p.src) ? [{ via: p.src, inst: p.inst || '', at: p.at, ref: p.ref, inboxId: id }] : undefined;
  txnForm({ kind, amount: p.amount > 0 ? p.amount : undefined, date: p.date || toISO(new Date(it.at)), note: p.note || p.merchant || (it.type === 'text' ? it.raw?.text : '') || '', categoryId: p.categoryId, accountId: p.accountId, toAccountId: p.toAccountId, cardId: p.cardId, inboxId: id, capture: { merchant: p.merchant, ref: p.ref, at: p.at, src: p.src, conf } });
}

// ------------------------------------------------------------------ Settings: inbox, formats, card mapping
export function inboxSettings() {
  const t = db.templates.length, m = db.cardMap.length, n = X.reviewCount();
  const s = db.settings;
  const row = (action, title, meta = '', extra = '') => `<button type="button" class="row" data-action="${action}" ${extra}><span class="grow"><span class="title">${title}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</span><span class="chev" aria-hidden="true">${icon('right')}</span></button>`;
  openSheet(`${sheetHead('Inbox and alerts', { back: ['Settings', 'settings'] })}
    <div class="list card">
      ${row('relaySheet', 'Inbox relay', Sync.paired() ? `Paired with ${esc(Sync.relayHost())}` : 'Not set up', 'data-from="inboxSettings"')}
      ${row('goReview', 'Review', n ? `${n} waiting` : 'Nothing waiting')}
      ${row('importInbox', 'Import from Files', 'Catch up from iCloud Drive/Shortcuts/Pitaka/inbox.jsonl when the relay was offline')}
      ${row('alertFormats', 'Alert formats', t ? `${t} you taught Pitaka` : 'Formats you teach from Review')}
      ${row('cardMapSheet', 'Cards and accounts', m ? `${m} mapped` : 'Map "card ending 1234" or a sender to a wallet or card')}
    </div>
    <form id="inbox-form" data-form="inboxPrefs" novalidate>
      ${field('Match entries within', select('matchWindow', [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours']], s.matchWindow || 30), 'How far apart an alert and an entry you logged can be and still count as the same purchase.')}
      ${field('Keep the text of alerts', select('rawDays', [[30, 'For 30 days'], [90, 'For 90 days'], [365, 'For a year'], [0, 'Forever']], s.rawDays ?? 90), 'After that only what Pitaka read from them is kept (amount, merchant, reference).')}
      <button class="btn block" type="submit">Save</button>
    </form>`);
}
export function alertFormats() {
  const list = db.templates;
  openSheet(`${sheetHead('Alert formats', { back: ['Inbox', 'inboxSettings'] })}
    <p class="meta pad">Formats you taught Pitaka from Review. Built-in formats for GCash, GoTyme, Maya and the banks are unverified guesses; yours always win.</p>
    ${list.length ? `<ul class="list card">${list.map((t) => `<li class="row" role="button" tabindex="0" data-action="templateForm" data-id="${esc(t.id)}"><span class="icon" aria-hidden="true">${icon('tag')}</span><span class="grow"><span class="title">${esc(t.label || t.sender)}</span><span class="meta mono-line">${esc(t.format)}</span><span class="meta">${esc({ expense: 'Money out', income: 'Money in', 'transfer-out': 'To another wallet', 'transfer-in': 'From another wallet' }[t.kind])} · ${t.hits} read</span></span><span class="chev" aria-hidden="true">${icon('right')}</span></li>`).join('')}</ul>`
      : emptyState({ icon: 'tag', title: 'No formats yet', text: 'When an alert lands in Review as "Unknown format", tap Teach and mark the amount, merchant and balance.' })}`);
}
export function templateForm(id) {
  const t = S.template(id);
  if (!t) return;
  const wallets = [{ group: 'Wallets', options: [['', 'Work it out from the sender'], ...accounts().map((a) => [`a:${a.id}`, a.name])] }];
  const cards = db.debts.filter((d) => d.type === 'card');
  if (cards.length) wallets.push({ group: 'Credit cards', options: cards.map((c) => [`c:${c.id}`, c.name]) });
  openSheet(`${sheetHead('Edit format', { back: ['Formats', 'alertFormats'], right: saveLink('template-form') })}
    <form id="template-form" data-form="template" data-id="${esc(t.id)}" novalidate>
      ${field('Name', `<input name="label" maxlength="60" value="${esc(t.label || '')}" placeholder="${esc(t.sender)}" autocomplete="off">`)}
      ${field('From (sender)', `<input name="sender" maxlength="80" value="${esc(t.sender)}" autocomplete="off" autocapitalize="off">`)}
      ${field('Format', `<textarea name="format" rows="4" class="mono" spellcheck="false" autocapitalize="off">${esc(t.format)}</textarea>`, 'Placeholders: {amount} {merchant} {balance} {ref}, {#} for any number, {w} for any word, {*} for anything.')}
      ${field('This message means', select('kind', [['expense', 'Money out'], ['income', 'Money in'], ['transfer-out', 'Sent to another of my wallets'], ['transfer-in', 'Received from another of my wallets']], t.kind))}
      ${field('For wallet or card', select('target', wallets, t.cardId ? `c:${t.cardId}` : t.accountId ? `a:${t.accountId}` : ''))}
      ${field('Try it on a message', `<textarea name="sample" rows="3" placeholder="Paste a message to test" data-template-test></textarea>`, '<span id="tpl-result" aria-live="polite"></span>')}
      <button class="btn primary block" type="submit">Save format</button>
      <button class="btn danger block" type="button" data-action="deleteTemplate" data-id="${esc(t.id)}">Delete format</button>
    </form>`);
}
export function testTemplate(textarea) {
  const form = textarea.form;
  const out = $('#tpl-result');
  if (!form || !out) return;
  const fmt = form.querySelector('[name=format]').value;
  try { A.compileTemplate(fmt); } catch (e) { out.textContent = e.message; out.className = 'critical-text'; return; }
  const m = A.matchTemplate(fmt, textarea.value);
  out.textContent = !textarea.value.trim() ? '' : m ? `Reads ${peso(m.amount)}${m.merchant ? ` · ${m.merchant}` : ''}${m.balance ? ` · balance ${peso(m.balance)}` : ''}${m.ref ? ` · ref ${m.ref}` : ''}` : "Doesn't match this message";
  out.className = m ? 'good-text' : 'warning-text';
}
export function cardMapSheet() {
  const list = db.cardMap;
  const name = (m) => (m.cardId ? S.debt(m.cardId)?.name : S.account(m.accountId)?.name) || 'Deleted';
  const targets = [{ group: 'Wallets', options: accounts().map((a) => [`a:${a.id}`, a.name]) }];
  const cards = db.debts.filter((d) => d.type === 'card');
  if (cards.length) targets.push({ group: 'Credit cards', options: cards.map((c) => [`c:${c.id}`, c.name]) });
  openSheet(`${sheetHead('Cards and accounts', { back: ['Inbox', 'inboxSettings'] })}
    <p class="meta pad">Tell Pitaka which wallet or credit card an alert is about. A credit-card purchase adds to that card's balance.</p>
    ${list.length ? `<ul class="list card">${list.map((m) => `<li class="row"><span class="icon" aria-hidden="true">${icon(m.cardId ? 'card' : 'wallet')}</span><span class="grow"><span class="title">${m.last4 ? `Ending ${esc(m.last4)}` : `From ${esc(m.sender)}`}</span><span class="meta">→ ${esc(name(m))}</span></span><button type="button" class="icon-btn plain" data-action="deleteCardMap" data-id="${esc(m.id)}" aria-label="Remove">${icon('trash')}</button></li>`).join('')}</ul>` : ''}
    <form id="cardmap-form" data-form="cardMap" novalidate>
      <h3>Add</h3>
      <div class="two">${field('Card or account ending', '<input name="last4" inputmode="numeric" maxlength="4" placeholder="1234" autocomplete="off">')}${field('or sender', '<input name="sender" maxlength="80" placeholder="e.g. BPI" autocomplete="off" autocapitalize="off">')}</div>
      ${field('Goes to', select('target', targets, ''))}
      <button class="btn primary block" type="submit">Add mapping</button>
    </form>`);
}

const splitTarget = (v) => { const [k, id] = String(v || '').split(':'); return k === 'c' ? { cardId: id } : k === 'a' ? { accountId: id } : {}; };
export const REVIEW_FORMS = {
  async teach(form) {
    const pv = teachPreview();
    if (!pv.ok) throw new FormProblem(pv.text);
    const f = new FormData(form);
    const it = S.inboxItem(teach.id);
    const target = splitTarget(f.get('target'));
    const sender = A.normSender(it);
    S.saveTemplate({ sender, format: pv.format, kind: String(f.get('kind')), label: A.senderParser(sender)?.name || '', ...target });
    if (target.accountId || target.cardId) {
      const last4 = A.last4Of(teach.text);
      if (last4 && !db.cardMap.some((m) => m.last4 === last4)) S.saveCardMap({ last4, ...target });
    }
    const same = X.pending().filter((x) => A.normSender(x) === sender).map((x) => x.id);
    const out = X.reparse(same);
    await S.flush();
    haptic();
    closeSheet();
    render({ keepScroll: true });
    toast('Format saved', { icon: 'tag', sub: `${out.created.length + out.confirmed.length} of ${same.length} waiting item${same.length === 1 ? '' : 's'} read` });
  },
  async template(form) {
    const f = new FormData(form);
    S.saveTemplate({ id: form.dataset.id, label: str(f, 'label'), sender: str(f, 'sender', 80), format: String(f.get('format') || '').trim(), kind: String(f.get('kind')), accountId: null, cardId: null, ...splitTarget(f.get('target')) });
    await S.flush();
    alertFormats();
    toast('Format saved', { icon: 'check' });
  },
  async cardMap(form) {
    const f = new FormData(form);
    S.saveCardMap({ last4: str(f, 'last4', 4), sender: str(f, 'sender', 80), ...splitTarget(f.get('target')) });
    await S.flush();
    cardMapSheet();
    toast('Mapping added', { icon: 'check' });
  },
  async inboxPrefs(form) {
    const f = new FormData(form);
    S.updateSettings({ matchWindow: Number(f.get('matchWindow')) || 30, rawDays: Number(f.get('rawDays')) || 0 });
    S.trimRaw();
    await S.flush();
    toast('Saved', { icon: 'check' });
  },
};
