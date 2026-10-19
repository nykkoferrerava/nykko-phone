// Statements -> rows Pitaka can import. PDF statements (GCash, GoTyme, banks) are read with pdf.js,
// vendored in vendor/pdfjs and loaded only when a PDF is picked; CSV files are read here. DOM-free apart
// from loading pdf.js, so the tests run it under Node.
//
//   file -> positioned text (PDF) or cells (CSV) -> a table: header + rows
//        -> a role for each column (date, description, money out, money in, amount, balance, reference),
//           guessed here and changeable in the preview
//        -> rows { date, amount, kind, merchant, ref, balance }, marked against what Pitaka already has
//        -> imported in one save, with Undo; then the closing balance is compared with Pitaka's.
// A statement's password goes to pdf.js for that one read and is never kept.
import * as S from './store.js';
import { round2, today } from './util.js';
import { matchRows } from './reconcile.js';
import { guessCategory, matchWallet } from './quickparse.js';

export const ROLES = ['skip', 'date', 'desc', 'out', 'in', 'amount', 'balance', 'ref'];
export const ROLE_NAMES = { skip: "Don't use", date: 'Date', desc: 'Description', out: 'Money out', in: 'Money in', amount: 'Amount (− out, + in)', balance: 'Balance', ref: 'Reference no.' };
const MAX_ROWS = 3000;
const MAX_PAGES = 80;

// ---------------------------------------------------------------- reading PDFs
const PDFJS = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
let lib = null;
async function pdfjs() {
  if (!lib) {
    const L = await import(PDFJS);
    L.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    lib = L;
  }
  return lib;
}

export class PdfPasswordError extends Error {
  constructor(wrong) { super(wrong ? "That password didn't open it" : 'This PDF is locked with a password'); this.name = 'PdfPasswordError'; this.wrong = wrong; }
}
export const isPdf = (bytes) => bytes?.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF

// Text items with positions, page by page: [[{ str, x, y, w, h }]] (y grows downwards).
// `bytes` is handed to pdf.js (which may take it over): pass a fresh copy for each try.
export async function readPdf(bytes, { password = '' } = {}) {
  const L = await pdfjs();
  const task = L.getDocument({ data: bytes, password: password || undefined, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0, stopAtErrors: false });
  let doc;
  try { doc = await task.promise; } catch (e) {
    if (e?.name === 'PasswordException') throw new PdfPasswordError(e.code === L.PasswordResponses?.INCORRECT_PASSWORD);
    throw new Error("Pitaka couldn't read this PDF. Is it a statement you downloaded from the app or bank?", { cause: e });
  }
  try {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages.push(tc.items.filter((i) => typeof i.str === 'string' && i.str.trim()).map((i) => ({
        str: i.str.replace(/\s+/g, ' ').trim(), x: i.transform[4], y: vp.height - i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 10,
      })));
      page.cleanup();
    }
    return pages;
  } finally { await task.destroy(); }
}

// ---------------------------------------------------------------- money and dates
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "Oct", "Sept", "October" -> 10; anything else -> 0.
const monthOf = (w) => { const s = String(w || '').toLowerCase(); return s.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(s)) + 1 : 0; };
const pad = (n) => String(n).padStart(2, '0');
const validDay = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// "-1,234.56", "(1,234.56)", "PHP 1,234.56 DR", "₱1,234.56", "1.234,56"? (no: PH statements use 1,234.56)
// -> a signed number, or null. `mark` says whether DR/CR was written.
export function parseAmount(s) {
  let t = String(s ?? '').trim();
  if (!t) return null;
  let sign = 1;
  let mark = '';
  // "500.00 DR", or "500.00DR" with no space.
  if (/(?:\b|(?<=\d))(dr|debit)\.?$/i.test(t)) { mark = 'dr'; t = t.replace(/(?:\b|(?<=\d))(dr|debit)\.?$/i, ''); }
  else if (/(?:\b|(?<=\d))(cr|credit)\.?$/i.test(t)) { mark = 'cr'; t = t.replace(/(?:\b|(?<=\d))(cr|credit)\.?$/i, ''); }
  t = t.replace(/(php|₱|p(?=\s*[\d(-]))/gi, '').replace(/\s+/g, '');
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/^[-−–]/.test(t)) { sign = -sign; t = t.slice(1); } else if (/^\+/.test(t)) t = t.slice(1);
  if (/[-−]$/.test(t)) { sign = -sign; t = t.slice(0, -1); }
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(t)) return null;
  if (/^\d{8,}$/.test(t)) return null; // a reference or phone number, not money
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return { n: round2(sign * n), mark };
}
const amountOf = (s) => parseAmount(s)?.n ?? null;

// A date in any of the usual statement forms -> { iso, mdy } or null. `order` 'mdy' | 'dmy' decides
// 03/04/2026; `year` fills in dates written without one ("Oct 13").
export function parseDate(s, opts = {}) {
  const d = parseDay(s, opts);
  if (!d) return null;
  // "08:12 PM", "20:12", "8:12:05 am" after the date (however long the date was): the time it happened.
  const rest = String(s).trim().replace(/\s+/g, ' ').slice(d.len);
  delete d.len;
  const tm = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?(?![\d:])/i.exec(rest);
  if (tm) {
    let h = +tm[1];
    const pm = tm[3] && /p/i.test(tm[3]);
    if (tm[3]) h = (h % 12) + (pm ? 12 : 0);
    if (h < 24 && +tm[2] < 60) d.min = h * 60 + +tm[2];
  }
  return d;
}
function parseDay(s, { order = 'mdy', year = null } = {}) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
  if (m) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return validDay(y, mo, d) ? { iso: `${y}-${pad(mo)}-${pad(d)}`, kind: 'iso', len: m[0].length } : null; }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(t);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    const [mo, d] = order === 'dmy' ? [b, a] : [a, b];
    return validDay(y, mo, d) ? { iso: `${y}-${pad(mo)}-${pad(d)}`, kind: 'num', a, b, len: m[0].length } : null;
  }
  // "Oct 13, 2026", "October 13 2026", "Oct 13"
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?\b/.exec(t);
  if (m && monthOf(m[1])) {
    const mo = monthOf(m[1]);
    const y = m[3] ? +m[3] : year;
    if (!y) return null;
    return validDay(y, mo, +m[2]) ? { iso: `${y}-${pad(mo)}-${pad(+m[2])}`, kind: 'name', guessedYear: !m[3], len: m[0].length } : null;
  }
  // "13 Oct 2026", "13-Oct-26", "13 October"
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]*(\d{2,4})?\b/.exec(t);
  if (m && monthOf(m[2])) {
    const mo = monthOf(m[2]);
    const y = m[3] ? fullYear(+m[3]) : year;
    if (!y) return null;
    return validDay(y, mo, +m[1]) ? { iso: `${y}-${pad(mo)}-${pad(+m[1])}`, kind: 'name', guessedYear: !m[3], len: m[0].length } : null;
  }
  return null;
}
// For numeric dates: day-first when some first number is over 12, month-first otherwise (the PH norm).
export function dateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v || '').trim());
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    if (+m[2] > 12) mdy++;
  }
  return dmy > mdy ? 'dmy' : 'mdy';
}

// ---------------------------------------------------------------- columns
const HEAD = [
  ['ref', /\b(ref(erence)?|trace|txn ?id|transaction ?(id|no)|confirmation)\b/i],
  ['balance', /\bbal(ance)?\b/i],
  ['date', /\bdate\b|^posted|^posting|^date ?(and|&) ?time$|^time$/i],
  ['out', /\b(debits?|withdrawals?|money ?out|paid ?out|outflows?|spent|charges?|dr)\b/i],
  ['in', /\b(credits?|deposits?|money ?in|received|inflows?|cr)\b/i],
  ['amount', /\b(amount|amt|value)\b/i],
  ['desc', /\b(description|details?|particulars|narrative|merchant|payee|remarks|memo|transaction|type|name)\b/i],
];
export function headerRole(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40 || /\d{3}/.test(t)) return null;
  for (const [role, re] of HEAD) if (re.test(t)) return role;
  return null;
}
const headerCount = (cells) => new Set(cells.map(headerRole).filter(Boolean)).size;

// One role per column, from the header first, then from what the column holds.
export function guessRoles(header, rows) {
  const roles = header.map(() => 'skip');
  const taken = new Set();
  header.forEach((h, i) => {
    const r = headerRole(h);
    if (r && !taken.has(r)) { roles[i] = r; taken.add(r); }
  });
  const sample = rows.slice(0, 60);
  const share = (i, test) => { const v = sample.map((r) => r[i]).filter((x) => x && String(x).trim()); return v.length ? v.filter(test).length / v.length : 0; };
  header.forEach((_, i) => {
    if (roles[i] !== 'skip') return;
    if (!taken.has('date') && share(i, (x) => !!parseDate(x, { year: 2000 })) >= 0.6) { roles[i] = 'date'; taken.add('date'); return; }
    if (share(i, (x) => amountOf(x) !== null) >= 0.6) {
      if (!taken.has('amount') && !taken.has('out') && !taken.has('in')) { roles[i] = 'amount'; taken.add('amount'); } else if (!taken.has('balance')) { roles[i] = 'balance'; taken.add('balance'); }
    }
  });
  if (!taken.has('desc')) {
    let best = -1, len = 0;
    header.forEach((_, i) => {
      if (roles[i] !== 'skip') return;
      const avg = sample.reduce((s, r) => s + String(r[i] || '').length, 0) / (sample.length || 1);
      if (avg > len) { len = avg; best = i; }
    });
    if (best >= 0 && len >= 3) roles[best] = 'desc';
  }
  return roles;
}

// ---------------------------------------------------------------- PDF text -> table
// Items on (nearly) the same baseline form a line, left to right.
export function linesOf(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, Math.min(last.h, it.h) * 0.5)) last.items.push(it);
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}
// Items close together are one cell ("Jollibee" "Foods" "Corp"); a wider gap starts the next cell.
export function cellsOf(line) {
  const cells = [];
  for (const it of line.items) {
    const last = cells[cells.length - 1];
    if (last && it.x - last.x1 < Math.max(4, it.h * 0.9)) { last.text += ` ${it.str}`; last.x1 = Math.max(last.x1, it.x + it.w); }
    else cells.push({ text: it.str, x0: it.x, x1: it.x + it.w });
  }
  return cells;
}
const FOOTER = /^(total|totals|ending balance|closing balance|end of|page \d|\*{3}|this is a (system|computer)|nothing follows)/i;
const OPENING = /^(beginning|opening|starting|previous) balance/i;

// Builds { header, rows, roles, opening, year } from the PDF's pages. Columns come from the header line
// (each data item goes to the column under which its centre falls); a line without a date continues the
// row above it (long descriptions wrap). Without a header, lines that start with a date are the rows.
export function tableFromPdf(pages) {
  const all = pages.flat();
  const years = {};
  for (const it of all) for (const y of it.str.match(/\b20\d\d\b/g) || []) years[y] = (years[y] || 0) + 1;
  const year = Number(Object.entries(years).sort((a, b) => b[1] - a[1])[0]?.[0]) || Number(today().slice(0, 4));
  let cols = null;
  const rows = [];
  let opening = null;
  let current = null;
  for (const page of pages) {
    const lines = linesOf(page);
    if (opening === null) for (const l of lines) {
      const text = l.items.map((i) => i.str).join(' ');
      if (OPENING.test(text)) { const n = amountOf(text.match(/-?[\d,]+\.\d{2}/g)?.pop()); if (n !== null) { opening = n; break; } }
    }
    let headerAt = lines.findIndex((l) => { const c = cellsOf(l); return headerCount(c.map((x) => x.text)) >= 3 && c.some((x) => headerRole(x.text) === 'date'); });
    if (headerAt >= 0) {
      const hc = cellsOf(lines[headerAt]);
      cols = hc.map((c, i) => ({ name: c.text, x0: c.x0, x1: c.x1, lo: i ? (hc[i - 1].x1 + c.x0) / 2 : -Infinity, hi: i < hc.length - 1 ? (c.x1 + hc[i + 1].x0) / 2 : Infinity }));
    } else headerAt = -1;
    if (!cols) continue;
    const dateCol = cols.findIndex((c) => headerRole(c.name) === 'date');
    for (const line of lines.slice(headerAt + 1)) {
      const text = line.items.map((i) => i.str).join(' ');
      if (FOOTER.test(text)) { current = null; continue; }
      if (headerCount(cellsOf(line).map((c) => c.text)) >= 3) { current = null; continue; } // a repeated header
      const cells = cols.map(() => []);
      for (const it of line.items) {
        const mid = it.x + it.w / 2;
        let k = cols.findIndex((c) => mid >= c.lo && mid < c.hi);
        if (k < 0) k = cols.length - 1;
        cells[k].push(it.str);
      }
      const row = cells.map((c) => c.join(' ').trim());
      if (OPENING.test(text)) { const n = amountOf(row[row.length - 1]) ?? amountOf(text.match(/[\d,]+\.\d{2}/g)?.pop()); if (n !== null) opening = n; current = null; continue; }
      if (parseDate(row[dateCol], { year })) { current = row; rows.push(row); if (rows.length >= MAX_ROWS) break; continue; }
      // A wrapped line: its text belongs to the row above (descriptions, a second line of time, references).
      if (current) row.forEach((v, k) => { if (v) current[k] = current[k] ? `${current[k]} ${v}` : v; });
    }
  }
  if (cols) {
    const header = cols.map((c) => c.name);
    return { header, rows, roles: guessRoles(header, rows), opening, year, source: 'pdf' };
  }
  // No header: the lines that start with a date, cell by cell.
  const grid = [];
  for (const page of pages) for (const line of linesOf(page)) {
    const cells = cellsOf(line).map((c) => c.text);
    if (cells.length >= 2 && parseDate(cells[0], { year })) grid.push(cells);
  }
  const width = Math.max(0, ...grid.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const rows2 = grid.slice(0, MAX_ROWS).map((r) => header.map((_, i) => r[i] || ''));
  return { header, rows: rows2, roles: guessRoles(header, rows2), opening: null, year, source: 'pdf' };
}

// ---------------------------------------------------------------- CSV -> table
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const head = src.split(/\r?\n/).slice(0, 20).join('\n');
  const delim = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && !cell.trim()) { q = true; cell = ''; }
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
      if (rows.length > MAX_ROWS + 50) break;
    } else cell += ch;
  }
  if (cell.trim() || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some(Boolean));
}
export function tableFromCsv(text) {
  const grid = parseCsv(text);
  if (!grid.length) return { header: [], rows: [], roles: [], opening: null, year: null, source: 'csv' };
  let h = grid.slice(0, 15).findIndex((r) => headerCount(r) >= 2);
  // Unknown column names: a first row without dates or amounts, above rows with them, is still a header.
  const plain = (r) => r.every((c) => !parseDate(c, { year: 2000 }) && amountOf(c) === null);
  if (h < 0 && grid.length > 1 && plain(grid[0]) && !plain(grid[1])) h = 0;
  const width = Math.max(...grid.map((r) => r.length));
  const header = h >= 0 ? Array.from({ length: width }, (_, i) => grid[h][i] || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const rows = grid.slice(h >= 0 ? h + 1 : 0, (h >= 0 ? h + 1 : 0) + MAX_ROWS).filter((r) => r.filter(Boolean).length >= 2).map((r) => header.map((_, i) => r[i] || ''));
  const years = (text.match(/\b20\d\d\b/g) || []).map(Number);
  return { header, rows, roles: guessRoles(header, rows), opening: null, year: years.length ? years.sort((a, b) => years.filter((y) => y === b).length - years.filter((y) => y === a).length)[0] : null, source: 'csv' };
}

// ---------------------------------------------------------------- table -> rows
// opts: order 'auto'|'mdy'|'dmy'; positive 'auto'|'in'|'out' (what a positive Amount means); card: the
// statement is for a credit card (purchases are usually positive there).
export function buildRows(table, roles, { order = 'auto', positive = 'auto', card = false } = {}) {
  const col = (role) => roles.indexOf(role);
  const [cDate, cDesc, cOut, cIn, cAmt, cBal, cRef] = ['date', 'desc', 'out', 'in', 'amount', 'balance', 'ref'].map(col);
  const ord = order === 'auto' ? dateOrder(table.rows.map((r) => r[cDate])) : order;
  const year = table.year || Number(today().slice(0, 4));
  // What a positive Amount means: the balance column settles it when there is one.
  let pos = positive;
  if (pos === 'auto') {
    pos = card ? 'out' : 'in';
    // A wallet's balance goes up with money in. The listing order has to be known first: "in, oldest first"
    // and "out, newest first" fit the same pair of rows. (A card's balance may be owed or bank-style: left as is.)
    const dates = cDate >= 0 ? table.rows.map((r) => parseDate(r[cDate], { order: ord, year })?.iso).filter(Boolean) : [];
    if (cAmt >= 0 && cBal >= 0 && !card && dates.length > 1 && dates[0] !== dates[dates.length - 1]) {
      const newestFirst = dates[0] > dates[dates.length - 1];
      let up = 0, down = 0;
      for (let i = 1; i < table.rows.length; i++) {
        const [older, newer] = newestFirst ? [table.rows[i], table.rows[i - 1]] : [table.rows[i - 1], table.rows[i]];
        const before = amountOf(older[cBal]), after = amountOf(newer[cBal]), a = amountOf(newer[cAmt]);
        if (before === null || after === null || !a) continue;
        if (Math.abs(before + a - after) < 0.01) up++;
        else if (Math.abs(before - a - after) < 0.01) down++;
      }
      if (up !== down) pos = up > down ? 'in' : 'out';
    }
  }
  const rows = table.rows.map((r, i) => {
    const d = cDate >= 0 ? parseDate(r[cDate], { order: ord, year }) : null;
    const merchant = (cDesc >= 0 ? r[cDesc] : '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const ref = cRef >= 0 ? (String(r[cRef] || '').replace(/\s+/g, '').match(/[\w./:-]{3,40}/)?.[0] || '') : '';
    const balance = cBal >= 0 ? amountOf(r[cBal]) : null;
    let amount = null, kind = null;
    if (cOut >= 0 || cIn >= 0) {
      const o = cOut >= 0 ? parseAmount(r[cOut]) : null;
      const n = cIn >= 0 ? parseAmount(r[cIn]) : null;
      const net = round2((n ? Math.abs(n.n) : 0) - (o ? Math.abs(o.n) : 0));
      if (net) { amount = Math.abs(net); kind = net > 0 ? 'income' : 'expense'; }
    } else if (cAmt >= 0) {
      const a = parseAmount(r[cAmt]);
      if (a && a.n) {
        amount = Math.abs(a.n);
        const isIn = a.mark === 'cr' ? true : a.mark === 'dr' ? false : (a.n > 0) === (pos === 'in');
        kind = isIn ? 'income' : 'expense';
      }
    }
    const problem = !d ? 'date' : !amount ? 'amount' : null;
    let at = null;
    if (d && Number.isFinite(d.min)) { const [y, mo, dd] = d.iso.split('-').map(Number); at = new Date(y, mo - 1, dd, Math.floor(d.min / 60), d.min % 60).getTime(); }
    return { i, date: d?.iso || null, at, amount, kind, merchant, ref, balance, problem };
  });
  // The closing balance: the balance on the latest row (statements run oldest-first or newest-first).
  const dated = rows.filter((r) => r.date && r.balance !== null);
  let closing = null;
  if (dated.length) {
    const newestFirst = dated.length > 1 && dated[0].date > dated[dated.length - 1].date;
    const last = newestFirst ? dated[0] : dated[dated.length - 1];
    closing = { date: last.date, balance: last.balance };
  }
  return { rows, order: ord, positive: pos, closing };
}

// ---------------------------------------------------------------- matching, importing, reconciling
// `target`: { accountId } or { cardId }. Rows already in Pitaka get `match` (the entry, one per row).
// On a wallet's statement, a row naming another of your wallets ("Transfer to GoTyme Bank", "Cash In
// from BPI") gets `other`: it's a transfer between your own wallets, not spending or income.
export function markExisting(rows, target) {
  const others = target.accountId ? S.db.accounts.filter((a) => a.id !== target.accountId) : [];
  const shaped = rows.map((r) => {
    if (r.problem || !others.length) return { ...r, other: null };
    // "Cash In from BPI" is a top-up from BPI, not from your Cash wallet.
    const m = matchWallet(r.merchant.replace(/\bcash[ -]?(in|out)\b/gi, ' '), { accounts: others });
    return { ...r, other: !m.conflict && m.accountId ? m.accountId : null };
  });
  const ok = shaped.filter((r) => !r.problem);
  const marked = matchRows(ok, S.db.txns, target);
  const byI = new Map(marked.map((r) => [r.i, r]));
  return shaped.map((r) => byI.get(r.i) || { ...r, match: null, score: 0 });
}

// Which rows can be imported, and why not. Card statements: payments to the card are logged from the
// wallet that paid, so they're only marked.
export function rowStatus(r, target) {
  if (r.problem === 'date') return 'bad-date';
  if (r.problem === 'amount') return 'no-amount';
  if (r.match) return 'existing';
  if (target.cardId && r.kind === 'income') return 'card-payment';
  return r.other ? 'transfer' : 'new';
}

// Adds the new rows and marks the existing ones "on the statement", in one save. Returns what Undo needs.
export function importRows(rows, target, { inst = '' } = {}) {
  const out = { created: [], confirmed: [] };
  S.transaction(() => {
    for (const r of rows) {
      const conf = { via: 'statement', inst, ref: r.ref || undefined };
      if (r.match) {
        if (!(r.match.conf || []).some((c) => c.via === 'statement')) out.confirmed.push({ id: r.match.id, before: S.confirmTxn(r.match.id, conf, { merchant: r.merchant, ref: r.ref, at: r.at || undefined }) });
        continue;
      }
      const status = rowStatus(r, target);
      if (status === 'transfer') {
        const [from, to] = r.kind === 'expense' ? [target.accountId, r.other] : [r.other, target.accountId];
        out.created.push(S.saveTxn({ kind: 'transfer', amount: r.amount, date: r.date, at: r.at || undefined, accountId: from, toAccountId: to, note: r.merchant, merchant: r.merchant, ref: r.ref || undefined, src: 'statement', conf: [conf] }).id);
        continue;
      }
      if (status !== 'new') continue;
      const cat = r.kind === 'expense' ? guessCategory(r.merchant, S.db.categories) : null;
      const t = S.saveTxn({
        kind: r.kind, amount: r.amount, date: r.date, at: r.at || undefined, ...(target.cardId ? { cardId: target.cardId } : { accountId: target.accountId }),
        categoryId: cat?.id || null, note: r.merchant, merchant: r.merchant, ref: r.ref || undefined, src: 'statement', conf: [conf],
      });
      out.created.push(t.id);
    }
  });
  return out;
}
export function undoImport({ created = [], confirmed = [] }) {
  S.transaction(() => {
    for (const id of created) S.deleteTxn(id);
    for (const c of confirmed) if (S.txn(c.id)) S.setTxnFields(c.id, c.before);
  });
}

const endOfDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };
// The statement's closing balance against Pitaka's balance for that wallet at the end of that day.
export function closingCheck(accountId, closing) {
  if (!accountId || !closing || closing.balance === null || !S.account(accountId)) return null;
  // Before the wallet's starting balance there is nothing to compare: that money is already in it.
  if (S.account(accountId).openingDate && closing.date < S.account(accountId).openingDate) return null;
  const pitaka = S.balanceAt(accountId, endOfDay(closing.date));
  return { date: closing.date, statement: closing.balance, pitaka, diff: round2(closing.balance - pitaka) };
}
// Makes Pitaka agree with the statement: a visible "Balance fix" on the closing date, and the wallet is
// marked as checked against it.
export function reconcile(accountId, check) {
  let fix = null;
  S.transaction(() => {
    if (check.diff) fix = S.saveTxn({ kind: 'adjust', accountId, direction: check.diff > 0 ? 'up' : 'down', amount: Math.abs(check.diff), reason: 'correction', date: check.date, note: 'To match the statement', src: 'statement' });
    S.setAccountChecked(accountId, { amount: check.statement, at: endOfDay(check.date), via: 'statement', ok: true });
  });
  return fix;
}
// Which wallet a statement is for, from its file name and title ("GCash Transaction History"; the rows
// below name other wallets in transfers),
// when exactly one of your wallets is named there. Returns an account id or null.
export function guessWallet(name, text) {
  const m = matchWallet(`${name || ''} ${String(text || '').slice(0, 160)}`.replace(/[_.-]+/g, ' '), { accounts: S.db.accounts });
  return !m.conflict && m.accountId ? m.accountId : null;
}
export const pdfText = (pages) => pages.flat().slice(0, 300).map((i) => i.str).join(' ');
export const lastStatementCheck = (accountId) => { const c = S.account(accountId)?.checked; return c && c.via === 'statement' ? c : null; };
// A wallet is due for its monthly check when it has entries and wasn't checked against a statement in
// the last 35 days.
export function reconcileDue(accountId, now = Date.now()) {
  const c = lastStatementCheck(accountId);
  if (c && now - c.at < 35 * 86400000) return false;
  return S.db.txns.some((t) => t.accountId === accountId || t.toAccountId === accountId);
}
