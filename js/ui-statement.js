// Statement import: pick a PDF or CSV, open it (asking for its password if it's locked), check the
// columns and rows, import with Undo, then compare the closing balance with Pitaka's (js/statements.js).
import * as S from './store.js';
import { db } from './store.js';
import * as T from './statements.js';
import { esc, peso, fmtDate, toISO } from './util.js';
import { $, icon, openSheet, closeSheet, sheetHead, field, select, toast, FormProblem, haptic, accounts, emptyState } from './ui-core.js';
import { refresh } from './ui-views.js';

const st = { target: '', chosen: false, name: '', bytes: null, text: '', table: null, roles: [], order: 'auto', positive: 'auto', built: null, rows: [], off: new Set(), check: null };
const MAX_FILE = 15 * 1024 * 1024;
const SHOW = 400;

const cards = () => db.debts.filter((d) => d.type === 'card');
const targetOf = (v) => (String(v).startsWith('c:') ? { cardId: v.slice(2) } : { accountId: String(v).slice(2) });
const targetName = (v) => (String(v).startsWith('c:') ? S.debt(v.slice(2))?.name : S.account(String(v).slice(2))?.name) || '';
const isCard = () => st.target.startsWith('c:');

// ------------------------------------------------------------------ 1 · pick
export function statementSheet({ id = '', card = '' } = {}) {
  const def = card ? `c:${card}` : `a:${id || S.defaultAccountId() || accounts()[0]?.id || ''}`;
  st.target = st.target && !id && !card ? st.target : def;
  st.chosen = !!(id || card); // opened from a wallet or card: that's the one
  const groups = [{ group: 'Wallets', options: accounts().map((a) => [`a:${a.id}`, a.name]) }];
  if (cards().length) groups.push({ group: 'Credit cards', options: cards().map((c) => [`c:${c.id}`, c.name]) });
  openSheet(`${sheetHead('Import a statement')}
    <p class="pad meta">A PDF or CSV statement from GCash, GoTyme, Maya or your bank. Pitaka reads it on this iPhone: nothing is uploaded, and rows you already have are recognised.</p>
    <form id="stmt-pick" novalidate>
      ${field('Statement for', select('target', groups, st.target, 'data-stmt-target'))}
      <button type="button" class="btn primary block" data-action="stmtFile">${icon('file')}Choose the file</button>
    </form>
    <p class="pad meta">Save the statement to Files first (from the email or the app's download). If it's locked with a password, Pitaka asks for it and forgets it right after opening the file.</p>`);
}

let input = null;
export function pickStatementFile() {
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.csv,.txt,application/pdf,text/csv,text/plain';
    input.hidden = true;
    input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) openStatement(f); });
    document.body.append(input);
  }
  const sel = $('#stmt-pick [name=target]');
  if (sel) st.target = sel.value;
  input.click();
}

function busy(msg) {
  openSheet(`${sheetHead('Import a statement', { back: ['Back', 'statementSheet'] })}<div role="status">${emptyState({ icon: 'file', title: msg, text: st.name })}</div>`);
}

async function openStatement(file) {
  if (file.size > MAX_FILE) return toast('That file is too big for a statement', { warn: true });
  st.name = file.name.slice(0, 80);
  st.bytes = null; st.text = ''; st.table = null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (T.isPdf(bytes)) {
    st.bytes = bytes;
    return readPdf('');
  }
  st.text = new TextDecoder().decode(bytes);
  guessTarget(st.text);
  return useTable(T.tableFromCsv(st.text));
}

// The password only lives in this call: it goes to pdf.js and is dropped.
async function readPdf(password) {
  busy('Reading the statement…');
  let pages;
  try { pages = await T.readPdf(st.bytes.slice(), { password }); } catch (e) {
    if (e?.name === 'PdfPasswordError') return passwordSheet(e.wrong);
    return failSheet(e.message || "Pitaka couldn't read this PDF");
  }
  st.bytes = null; // not needed any more
  guessTarget(T.pdfText(pages));
  return useTable(T.tableFromPdf(pages));
}

// ------------------------------------------------------------------ 2 · password
function passwordSheet(wrong) {
  openSheet(`${sheetHead('Statement password', { back: ['Back', 'statementSheet'] })}
    <p class="pad">“${esc(st.name)}” is locked. GCash and many banks lock statements with a password they tell you in the email or the app.</p>
    <form id="stmt-pw" data-form="stmtPassword" novalidate>
      ${field('Password', '<input name="pw" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="128" enterkeyhint="go">', 'Used once to open this file. Pitaka never saves or sends it.')}
      ${wrong ? '<p class="form-err critical-text" role="alert">That password didn\'t open it. Check the email or app for the exact password.</p>' : ''}
      <button class="btn primary block" type="submit">${icon('lock')}Open</button>
    </form>`);
  setTimeout(() => $('#stmt-pw [name=pw]')?.focus(), 350);
}

// "GCash Transaction History" goes to your GCash wallet unless you picked one.
function guessTarget(text) {
  if (st.chosen) return;
  const id = T.guessWallet(st.name, text);
  if (id) st.target = `a:${id}`;
}

function failSheet(msg) {
  openSheet(`${sheetHead('Import a statement', { back: ['Back', 'statementSheet'] })}
    ${emptyState({ icon: 'alert', title: 'No transactions found', text: msg, actions: [['Choose another file', 'stmtFile', 'primary']] })}`);
}

// ------------------------------------------------------------------ 3 · check the rows
function useTable(table) {
  if (!table.rows.length) return failSheet(table.header.length ? 'Pitaka found the columns but no rows with a date. Try the CSV version of the statement if there is one.' : "Pitaka couldn't find a table of transactions in this file. A CSV export usually works when a PDF doesn't.");
  st.table = table;
  st.roles = [...table.roles];
  st.order = 'auto'; st.positive = 'auto';
  st.off = new Set();
  compute();
  preview();
}

function compute() {
  st.built = T.buildRows(st.table, st.roles, { order: st.order, positive: st.positive, card: isCard() });
  st.rows = T.markExisting(st.built.rows, targetOf(st.target));
}
const status = (r) => T.rowStatus(r, targetOf(st.target));
const importable = (r) => ['new', 'transfer'].includes(status(r));
const included = (r) => importable(r) && !st.off.has(r.i);

function rowHtml(r) {
  const s = status(r);
  const other = r.other ? S.account(r.other)?.name : '';
  const chip = {
    existing: `<span class="chip good">${icon('check')}In Pitaka</span>`,
    transfer: `<span class="chip accent">${icon('swap')}${esc(r.kind === 'expense' ? `To ${other}` : `From ${other}`)}</span>`,
    'card-payment': '<span class="chip">Card payment</span>',
    'bad-date': '<span class="chip warning">No date</span>',
    'no-amount': '<span class="chip warning">No amount</span>',
    new: '',
  }[s];
  const amt = r.amount ? `${r.kind === 'income' ? '+' : '−'}${peso(r.amount)}` : '—';
  const can = importable(r);
  return `<li class="row stmt-row ${esc(s)}">
    <input type="checkbox" class="stmt-check" data-stmt-row="${r.i}" ${can && included(r) ? 'checked' : ''} ${can ? '' : 'disabled'} aria-label="Import ${esc(r.merchant || 'this row')} ${esc(amt)}">
    <span class="grow"><span class="title">${esc(r.merchant || '(no description)')}</span><span class="meta">${r.date ? esc(fmtDate(r.date)) : 'No date'} ${chip}</span></span>
    <span class="num ${r.kind === 'income' ? 'pos' : ''}">${esc(amt)}</span></li>`;
}

function preview() {
  const rows = st.rows;
  const counts = { new: 0, transfer: 0, existing: 0, skip: 0 };
  for (const r of rows) { const s = status(r); if (s === 'new' || s === 'transfer') { if (included(r)) counts[s]++; } else if (s === 'existing') counts.existing++; else counts.skip++; }
  const n = counts.new + counts.transfer;
  const roleOpts = T.ROLES.map((k) => [k, T.ROLE_NAMES[k]]);
  const usesAmount = st.roles.includes('amount');
  const numericDates = st.table.rows.some((r) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(String(r[st.roles.indexOf('date')] || '').trim()));
  const needsMapping = !st.roles.includes('date') || !(usesAmount || st.roles.includes('out') || st.roles.includes('in'));
  const sample = st.table.rows.slice(0, 3);
  const closing = st.built.closing;
  openSheet(`${sheetHead('Check the rows', { back: ['Back', 'statementSheet'] })}
    <div class="card stmt-sum">
      <p><b>${esc(st.name)}</b> · ${esc(targetName(st.target))}</p>
      <p class="meta">${rows.length} row${rows.length === 1 ? '' : 's'} · ${counts.existing} already in Pitaka${counts.skip ? ` · ${counts.skip} skipped` : ''}${closing ? ` · closing balance ${esc(peso(closing.balance))} on ${esc(fmtDate(closing.date))}` : ''}</p>
    </div>
    <details class="stmt-cols" ${needsMapping ? 'open' : ''}><summary>${icon('sliders')}Columns${needsMapping ? ' · pick the date and amount columns' : ''}</summary>
      <div class="import-preview" tabindex="0" aria-label="Columns in the statement"><table>
        <thead><tr>${st.table.header.map((h, i) => `<th><span class="meta">${esc(h)}</span><br><select data-stmt-role="${i}" aria-label="What ${esc(h)} holds">${roleOpts.map(([k, l]) => `<option value="${k}" ${st.roles[i] === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></th>`).join('')}</tr></thead>
        <tbody>${sample.map((r) => `<tr>${st.table.header.map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      ${numericDates ? field('Dates are written', select('order', [['auto', `Worked out: ${st.built.order === 'dmy' ? 'day first' : 'month first'}`], ['mdy', 'Month first (10/13/2026)'], ['dmy', 'Day first (13/10/2026)']], st.order, 'data-stmt-opt="order"')) : ''}
      ${usesAmount ? field('Positive amounts are', select('positive', [['auto', `Worked out: money ${st.built.positive}`], ['in', 'Money in'], ['out', 'Money out']], st.positive, 'data-stmt-opt="positive"')) : ''}
    </details>
    ${n || counts.existing ? '' : '<p class="pad meta">Nothing to import with these columns. Open Columns above and pick the date and amount.</p>'}
    <ul class="list card stmt-rows">${rows.slice(0, SHOW).map(rowHtml).join('')}</ul>
    ${rows.length > SHOW ? `<p class="meta pad">Showing the first ${SHOW}. All ${rows.length} rows are imported as checked.</p>` : ''}
    <div class="sheet-foot">
      <button type="button" class="btn primary block" data-action="stmtImport" ${n || counts.existing ? '' : 'disabled'}>${icon('download')}${n ? `Import ${n} entr${n === 1 ? 'y' : 'ies'}` : 'Mark them as on the statement'}</button>
      ${counts.existing && n ? `<p class="meta center">and mark ${counts.existing} as on the statement</p>` : ''}
    </div>`);
}

export function onStatementChange(el) {
  if (el.dataset.stmtRow !== undefined) {
    const i = Number(el.dataset.stmtRow);
    if (el.checked) st.off.delete(i); else st.off.add(i);
    const btn = $('[data-action="stmtImport"]');
    const n = st.rows.filter(included).length;
    if (btn) btn.lastChild.textContent = n ? `Import ${n} entr${n === 1 ? 'y' : 'ies'}` : 'Mark them as on the statement';
    return;
  }
  if (el.dataset.stmtRole !== undefined) {
    const i = Number(el.dataset.stmtRole);
    // One column per role: picking a role takes it from the column that had it.
    if (el.value !== 'skip') st.roles = st.roles.map((r, k) => (k !== i && r === el.value ? 'skip' : r));
    st.roles[i] = el.value;
  } else if (el.dataset.stmtOpt) st[el.dataset.stmtOpt] = el.value;
  else if (el.hasAttribute('data-stmt-target')) { st.target = el.value; st.chosen = true; return; }
  else return;
  st.off = new Set();
  compute();
  const open = $('.stmt-cols')?.open;
  preview();
  const d = $('.stmt-cols');
  if (d && open) d.open = true;
}

// ------------------------------------------------------------------ 4 · import, then the balance check
export async function importStatement() {
  const target = targetOf(st.target);
  const rows = st.rows.filter((r) => status(r) === 'existing' || included(r));
  const res = T.importRows(rows, target, { inst: targetName(st.target) });
  await S.flush();
  haptic();
  refresh();
  const n = res.created.length;
  const undo = async () => { T.undoImport(res); await S.flush(); refresh(); toast('Import undone', { icon: 'undo' }); };
  toast(n ? `${n} entr${n === 1 ? 'y' : 'ies'} imported` : 'Marked as on the statement', { icon: 'check', sub: res.confirmed.length ? `${res.confirmed.length} you had are now marked "on the statement"` : '', action: 'Undo', onAction: undo });
  const check = target.accountId ? T.closingCheck(target.accountId, st.built.closing) : null;
  if (check) return balanceSheet(target.accountId, check);
  closeSheet();
}

function balanceSheet(accountId, check) {
  const a = S.account(accountId);
  const same = !check.diff;
  openSheet(`${sheetHead('Statement balance', { close: 'Done' })}
    <div class="list card">
      <div class="row"><span class="grow"><span class="title">Statement, end of ${esc(fmtDate(check.date))}</span></span><span class="num">${esc(peso(check.statement))}</span></div>
      <div class="row"><span class="grow"><span class="title">Pitaka, same day</span></span><span class="num">${esc(peso(check.pitaka))}</span></div>
      ${same ? '' : `<div class="row"><span class="grow"><span class="title">Difference</span></span><span class="num ${check.diff < 0 ? 'critical-text' : 'pos'}">${check.diff > 0 ? '+' : '−'}${esc(peso(Math.abs(check.diff)))}</span></div>`}
    </div>
    ${same ? `<div class="card row ok-row"><span class="icon accent" aria-hidden="true">${icon('check-circle')}</span><span class="grow"><span class="title">${esc(a.name)} matches the statement</span><span class="meta">Marked as checked for ${esc(fmtDate(check.date))}.</span></span></div>`
    : `<p class="pad meta">A difference usually means entries that weren't logged, or were logged to another wallet. You can look for them first, or record the difference as a visible balance fix on ${esc(fmtDate(check.date))}.</p>
    <div class="actions"><button type="button" class="btn primary" data-action="stmtReconcile" data-id="${esc(accountId)}">${icon('check')}Add a ${esc(peso(Math.abs(check.diff)))} balance fix</button><button type="button" class="btn" data-action="closeSheet">Leave it</button></div>`}`);
  st.check = check;
  if (same) { T.reconcile(accountId, check); S.flush().catch(() => {}); }
}

export async function reconcileStatement(accountId) {
  const check = st.check;
  if (!check) return closeSheet();
  const fix = T.reconcile(accountId, check);
  await S.flush();
  closeSheet();
  refresh();
  toast('Balance fixed to match the statement', { icon: 'check', sub: fix ? `${fix.direction === 'up' ? '+' : '−'}${peso(fix.amount)} on ${fmtDate(fix.date)}` : '', action: fix ? 'Undo' : '', onAction: async () => { S.deleteTxn(fix.id); await S.flush(); refresh(); } });
}

export const STATEMENT_ACTIONS = {
  statementSheet: ({ id, card }) => statementSheet({ id, card }),
  stmtFile: () => pickStatementFile(),
  stmtImport: () => importStatement(),
  stmtReconcile: ({ id }) => reconcileStatement(id),
};
export const STATEMENT_FORMS = {
  async stmtPassword(form) {
    const el = form.querySelector('[name=pw]');
    const pw = el?.value || '';
    if (el) el.value = '';
    if (!pw) throw new FormProblem('Enter the password', 'pw');
    await readPdf(pw);
  },
};

// The wallet sheet's line about its last statement check.
export function walletStatementRow(id) {
  const c = T.lastStatementCheck(id);
  const due = T.reconcileDue(id);
  return `<button type="button" class="row" data-action="statementSheet" data-id="${esc(id)}"><span class="icon" aria-hidden="true">${icon('file')}</span><span class="grow"><span class="title">Import a statement</span><span class="meta">${c ? `Checked against a statement for ${esc(fmtDate(toISO(new Date(c.at))))}` : 'Check this wallet against its monthly statement'}</span></span>${due ? '<span class="chip warning">Due</span>' : ''}<span class="chev" aria-hidden="true">${icon('right')}</span></button>`;
}
