// Sheets for v3 money features: money owed to you, the Friday payday picker, the category manager
// and CSV export.
import * as S from './store.js';
import { db } from './store.js';
import { peso, esc, today, fmtDate, addDays, daysBetween, parseISO, monthKey } from './util.js';
import {
  $, pw, icon, openSheet, closeSheet, sheetHead, saveLink, field, money, select, toast, bar, FormProblem, str, optMoney,
  setSettings, haptic, emptyState, accounts,
} from './ui-core.js';
import { refresh, txnRow, receivableRow } from './ui-views.js';
import { deliverFile } from './ui-ics.js';
import { buildExports } from './csv.js';

// ================================================================== payday picker (Fridays only)
// The next 14 days as a strip; only the Fridays that can be "next payday" can be picked.
export function paydayPicker(selected, name = 'payAnchor') {
  const from = today();
  const choices = S.paydayChoices(from);
  const pick = choices.includes(selected) ? selected : choices.find((d) => S.period().next === d || S.period().start === d) || '';
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));
  const first = parseISO(days[0]), last = parseISO(days[13]);
  const span = first.getMonth() === last.getMonth() ? first.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
    : `${first.toLocaleDateString('en-PH', { month: 'long' })} – ${last.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}`;
  const cell = (d) => {
    const dt = parseISO(d);
    const dow = dt.toLocaleDateString('en-PH', { weekday: 'short' });
    const label = fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' });
    if (!choices.includes(d)) return `<span class="day-opt" aria-hidden="true"><small>${esc(dow)}</small>${dt.getDate()}</span>`;
    return `<label class="day-opt fri"><input type="radio" name="${name}" value="${d}" ${d === pick ? 'checked' : ''} aria-label="${esc(label)}${d === from ? ', today' : ''}"><small>${d === from ? 'Today' : esc(dow)}</small>${dt.getDate()}</label>`;
  };
  return `<fieldset class="field payday-pick"><legend class="sr-only">When is your next payday?</legend>
    <span aria-hidden="true">${esc(span)}</span>
    <div class="days">${days.map(cell).join('')}</div>
    <small>You're paid every second Friday. Pick the next one; Pitaka counts 2-week pay periods from it.</small></fieldset>`;
}
export function readPayday(form, name = 'payAnchor') {
  const v = String(new FormData(form).get(name) || '');
  if (!v) throw new FormProblem('Pick your next payday (a Friday)', name);
  return v;
}

// ================================================================== owed to you
export function recvSheet(id) {
  const r = S.receivable(id);
  if (!r) return toast("That person wasn't found");
  const p = S.receivableProgress(r);
  const hist = S.receivableActivity(r.id);
  openSheet(`${sheetHead(esc(r.name), { close: 'Done', right: `<button type="button" class="link" data-action="recvForm" data-id="${esc(r.id)}">Edit</button>` })}
    <p class="big num center">${esc(peso(Math.max(0, r.balance)))}</p>
    <p class="meta center">${r.balance > 0 ? 'owes you' : 'Paid back in full'}${r.dueDate && r.balance > 0 ? ` · due ${esc(fmtDate(r.dueDate))}` : ''}</p>
    ${p.total > 0 ? `${bar(p.pct, 'good', 'Paid back so far')}<p class="meta center">${esc(pw(p.paid))} of ${esc(pw(p.total))} paid back</p>` : ''}
    <div class="actions">
      ${r.balance > 0 ? `<button type="button" class="btn primary" data-action="collectForm" data-id="${esc(r.id)}">${icon('in')}Got paid back</button>` : ''}
      <button type="button" class="btn" data-action="lendForm" data-id="${esc(r.id)}">${icon('out')}Lend more</button>
    </div>
    ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
    <h3>History</h3>
    ${hist.length ? `<ul class="list">${hist.slice(0, 50).map((t) => txnRow(t, { ctx: 'person' })).join('')}</ul>` : '<p class="empty">Recorded without a wallet entry.</p>'}`);
}

export function recvForm(r) {
  const v = r || { name: '', balance: '', dueDate: '' };
  openSheet(`${sheetHead(r ? 'Edit' : 'Someone owes you', { right: saveLink('recv-form') })}
    <form id="recv-form" data-form="recv" data-id="${esc(r?.id || '')}" novalidate>
      ${field('Who', `<input name="name" required maxlength="60" value="${esc(v.name)}" placeholder="e.g. Mel, Kuya Ben" autocomplete="off">`)}
      ${field(r ? 'What they owe you now' : 'How much they owe you', money('balance', r ? Math.max(0, r.balance) : ''), r ? 'Change this only to correct it. Repayments are logged with "Got paid back".' : 'Money you lent before using Pitaka. To lend from a wallet now, use Lend instead.')}
      ${field('Pay back by', `<input type="date" name="dueDate" value="${esc(v.dueDate || '')}">`, 'Optional')}
      ${field('Notes', `<textarea name="notes" rows="2" maxlength="500">${esc(v.notes || '')}</textarea>`)}
      <button class="btn primary block" type="submit">Save</button>
      ${r ? `<button class="btn danger block" type="button" data-action="deleteRecv" data-id="${esc(r.id)}">Delete</button>` : ''}
    </form>`);
}

// ================================================================== categories
export function catManager({ reorder = false } = {}) {
  const cats = db.categories;
  const counts = new Map();
  for (const t of db.txns) if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  openSheet(`${sheetHead('Categories', { close: 'Done', right: `<button type="button" class="link" data-action="catManager" data-reorder="${reorder ? '' : '1'}">${reorder ? 'Done' : 'Reorder'}</button>` })}
    <p class="meta pad">${reorder ? 'Move categories up or down. This order is used in the entry form and in your shortcuts.' : 'Rename, change the emoji, set a limit, hide or merge. Changes reach your shortcuts the next time Pitaka syncs.'}</p>
    <ul class="list card">${cats.map((c, i) => {
      const meta = [c.hidden ? 'Hidden' : '', c.limit > 0 ? `Limit ${pw(c.limit)}` : '', counts.get(c.id) ? `${counts.get(c.id)} entr${counts.get(c.id) === 1 ? 'y' : 'ies'}` : 'No entries', c.keywords ? `“${c.keywords}”` : ''].filter(Boolean).join(' · ');
      if (reorder) {
        return `<li class="row"><span class="icon" aria-hidden="true">${esc(c.emoji)}</span><span class="grow"><span class="title${c.hidden ? ' muted' : ''}">${esc(c.name)}</span></span>
          <button type="button" class="icon-btn plain" data-action="catMove" data-id="${esc(c.id)}" data-d="-1" aria-label="Move ${esc(c.name)} up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button type="button" class="icon-btn plain" data-action="catMove" data-id="${esc(c.id)}" data-d="1" aria-label="Move ${esc(c.name)} down" ${i === cats.length - 1 ? 'disabled' : ''}>${icon('down')}</button></li>`;
      }
      return `<li><button type="button" class="row" data-action="catForm" data-id="${esc(c.id)}"><span class="icon" aria-hidden="true">${esc(c.emoji)}</span><span class="grow"><span class="title${c.hidden ? ' muted' : ''}">${esc(c.name)}</span><span class="meta">${esc(meta)}</span></span>${c.hidden ? `<span class="chip">${icon('eye-off')}Hidden</span>` : ''}<span class="chev" aria-hidden="true">${icon('right')}</span></button></li>`;
    }).join('')}</ul>
    ${reorder ? '' : `<button class="btn block" data-action="catForm">${icon('plus')}New category</button>`}`);
}

const EMOJI = ['🍜', '☕', '🛒', '🚕', '⛽', '💡', '📶', '🛍️', '💊', '🎉', '👨‍👩‍👧', '💈', '📺', '🏠', '🎓', '🐶', '🎁', '✈️', '🍺', '🧾', '📦'];
export function catForm(c) {
  const v = c || { emoji: '🏷️', limit: 0 };
  const others = db.categories.filter((x) => x.id !== c?.id);
  openSheet(`${sheetHead(c ? 'Edit category' : 'New category', { right: saveLink('cat-form') })}
    <form id="cat-form" data-form="cat" data-id="${esc(c?.id || '')}" novalidate>
      <div class="emoji-row" role="group" aria-label="Pick an emoji">${EMOJI.map((e) => `<button type="button" class="${e === v.emoji ? 'on' : ''}" data-action="pickEmoji" data-e="${esc(e)}" aria-label="Use ${esc(e)}">${esc(e)}</button>`).join('')}</div>
      <div class="two narrow-first">${field('Emoji', `<input name="emoji" value="${esc(v.emoji)}" maxlength="8" autocomplete="off">`)}${field('Name', `<input name="name" required maxlength="40" value="${esc(v.name || '')}" autocomplete="off">`)}</div>
      ${field('Spending limit', money('limit', v.limit), 'For each 2-week pay period. Leave empty for no limit.')}
      ${field('Quick-text words', `<input name="keywords" maxlength="200" value="${esc(v.keywords || '')}" placeholder="e.g. jollibee, lunch, kape" autocomplete="off" autocapitalize="off">`, 'Typing one of these in Quick Add – Text picks this category. Separate with commas.')}
      <label class="check switch-row"><span><b>Hide this category</b><small>It disappears from the entry form and your shortcuts. Past entries keep it.</small></span><input type="checkbox" name="hidden" ${v.hidden ? 'checked' : ''}></label>
      <button class="btn primary block" type="submit">Save</button>
      ${c && others.length ? `<h3>Merge</h3><p class="meta pad">Move every entry and bill of ${esc(c.name)} into another category, then remove ${esc(c.name)}.</p>
        <div class="two">${field('Merge into', `<select name="intoId">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.emoji)} ${esc(o.name)}</option>`).join('')}</select>`)}<div class="field"><span aria-hidden="true">&nbsp;</span><button type="button" class="btn block" style="margin-top:0" data-action="catMerge" data-id="${esc(c.id)}">${icon('merge')}Merge</button></div></div>` : ''}
      ${c ? `<button class="btn danger block" type="button" data-action="deleteCat" data-id="${esc(c.id)}">Delete category</button>` : ''}
    </form>`);
}

// ================================================================== CSV export
const RANGES = [['period', 'This pay period'], ['month', 'This month'], ['3m', 'Last 3 months'], ['all', 'Everything'], ['custom', 'Custom']];
function rangeOf(k) {
  const now = today();
  if (k === 'period') { const p = S.period(); return [p.start, p.end]; }
  if (k === 'month') return [`${monthKey(now)}-01`, now];
  if (k === '3m') return [addDays(now, -91), now];
  if (k === 'all') return ['', ''];
  return null;
}
export function exportSheet(state = {}) {
  const s = { range: 'month', what: ['transactions'], ...state };
  const [from, to] = rangeOf(s.range) || [s.from || addDays(today(), -30), s.to || today()];
  const cards = db.debts.filter((d) => d.type === 'card');
  const scope = [{ group: 'Wallets', options: [['', 'All wallets and cards'], ...accounts().map((a) => [a.id, a.name])] }];
  if (cards.length) scope.push({ group: 'Credit cards', options: cards.map((c) => [c.id, c.name]) });
  const box = (k, l, sub) => `<label class="check"><input type="checkbox" name="what" value="${k}" ${s.what.includes(k) ? 'checked' : ''}><span><b>${l}</b><small>${sub}</small></span></label>`;
  openSheet(`${sheetHead('Export CSV', { right: saveLink('export-form', 'Export') })}
    <form id="export-form" data-form="exportCsv" novalidate>
      <p class="meta pad">Spreadsheet files for Numbers, Excel or Google Sheets, through the share sheet.</p>
      ${box('transactions', 'Transactions', 'Every entry in the date range below')}
      ${box('debts', 'Debts', 'Balances, payments left and payoff dates')}
      ${box('goals', 'Savings goals', 'Targets, saved so far and per-payday amounts')}
      ${box('receivables', 'Owed to you', 'Who owes you and what came back')}
      <h3>Transactions</h3>
      ${field('Date range', select('range', RANGES, s.range, 'data-export-range'))}
      <div class="two">${field('From', `<input type="date" name="from" value="${esc(from)}" ${s.range === 'custom' ? '' : 'disabled'}>`)}${field('To', `<input type="date" name="to" value="${esc(to)}" ${s.range === 'custom' ? '' : 'disabled'}>`)}</div>
      ${field('Wallet', select('accountId', scope, s.accountId || ''))}
      <button class="btn primary block" type="submit">${icon('share')}Export</button>
    </form>`);
}
export function readExport(form) {
  const f = new FormData(form);
  const what = f.getAll('what').map(String);
  if (!what.length) throw new FormProblem('Pick at least one thing to export', 'what');
  const range = String(f.get('range') || 'month');
  let [from, to] = rangeOf(range) || [String(f.get('from') || ''), String(f.get('to') || '')];
  if (range === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new FormProblem('Pick both dates', 'from');
    if (from > to) [from, to] = [to, from];
  }
  return { what, from: from || undefined, to: to || undefined, accountId: String(f.get('accountId') || '') || undefined };
}
// Several files go into one share sheet when the phone allows it; otherwise they download one by one.
export async function deliverFiles(files) {
  const list = files.map((f) => new File([f.text], f.name, { type: 'text/csv' }));
  if (list.length > 1 && navigator.canShare?.({ files: list })) {
    try { await navigator.share({ files: list, title: 'Pitaka export' }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  let how = 'downloaded';
  for (const f of list) how = await deliverFile(f);
  return how;
}

export const MONEY_FORMS = {
  async recv(form) {
    const f = new FormData(form);
    const name = str(f, 'name');
    if (!name) throw new FormProblem('Enter who owes you', 'name');
    const balance = optMoney(f, 'balance', 'amount');
    if (balance === null) throw new FormProblem('Enter how much they owe you', 'balance');
    const input = { name, balance, dueDate: f.get('dueDate') || null, notes: str(f, 'notes', 500) };
    if (form.dataset.id) input.id = form.dataset.id;
    const saved = S.saveReceivable(input);
    await S.flush();
    haptic();
    refresh();
    recvSheet(saved.id);
    toast(form.dataset.id ? 'Saved' : 'Added', { icon: 'check' });
  },
  async exportCsv(form) {
    const files = buildExports(readExport(form));
    const how = await deliverFiles(files);
    if (how === 'cancelled') return;
    closeSheet();
    toast(how === 'shared' ? `Exported ${files.length} file${files.length === 1 ? '' : 's'}` : 'Downloaded. Open it from the Files app.', { icon: 'check' });
  },
};
