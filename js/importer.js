// Turns a list of debts pasted from Google Sheets / Excel (tab-separated) or a CSV file into drafts
// that store.saveDebt() accepts. Pure: reads nothing, saves nothing. Column names are matched loosely,
// in English or Filipino, so a sheet made for yourself usually works as-is.
import { today, toISO, parseISO, round2 } from './util.js';

const MAX_ROWS = 200;

// Online lending / buy-now-pay-later apps common in the Philippines (matched as whole words).
const LENDING_APPS = [
  'gloan', 'ggives', 'gcredit', 'tala', 'cashalo', 'home credit', 'homecredit', 'billease', 'atome', 'sloan',
  'spaylater', 'shopee paylater', 'shopee pay later', 'lazpaylater', 'lazada paylater', 'juanhand', 'juan hand',
  'digido', 'maya credit', 'maya easy credit', 'maya loan', 'mocasa', 'plentina', 'kviku', 'finbro', 'moneycat',
  'cash express', 'cashexpress', 'pesoloan', 'peso loan', 'zuki', 'online loans pilipinas', 'acom', 'welcome finance',
];
const BANKS = ['bpi', 'bdo', 'metrobank', 'rcbc', 'security bank', 'eastwest', 'unionbank', 'citibank', 'citi', 'hsbc', 'pnb', 'aub', 'chinabank', 'landbank', 'psbank', 'sss', 'pag ibig', 'pagibig', 'gsis'];
const PERSON_WORDS = ['kay', 'tita', 'tito', 'ate', 'kuya', 'mama', 'papa', 'nanay', 'tatay', 'lola', 'lolo', 'friend', 'kaibigan', 'pinsan', 'cousin', 'mom', 'dad', 'boss', 'officemate', 'kapitbahay', 'neighbor'];

// Header -> field. First matching rule wins, so the specific ones come first.
const HEADER_RULES = [
  ['type', /^(type|uri|kind|klase|category)$/],
  ['minDue', /\bmin(imum)?\b/],
  ['paidAmount', /\b(amount|total) paid\b|\bpaid amount\b/],
  ['creditLimit', /\blimit\b/],
  ['balance', /\b(balance|natitira\w*|remaining|outstanding|owed|left|balanse)\b/],
  ['paymentAmount', /\b(amount due|due amount|installment amount|payment amount|monthly payment|amort\w*|per month|hulog|hulugan|bayad kada)\b/],
  ['paymentsMade', /\b(paid|nabayaran\w*|made|bayad na)\b/],
  ['totalPayments', /\b(terms?|months|no of payments|number of payments|total payments|ilang buwan|buwan|installments|gives)\b|^total$/],
  ['paymentAmount', /\b(payment|monthly|bayad|installment)\b/],
  ['amount', /\b(amount|principal|original|loan amount|hiniram|halaga|borrowed)\b/],
  ['nextDue', /\b(due|petsa|date|deadline|kailan|next)\b/],
  ['rate', /\b(rate|interest|tubo|apr)\b|%/],
  ['lender', /\b(lender|bank|app|from|kanino|creditor|provider|company|nagpautang)\b/],
  ['frequency', /\b(frequency|how often|schedule|every|tuwing|kada)\b/],
  ['notes', /\b(notes?|remarks?|comments?|tala)\b/],
  ['name', /\b(name|debt|utang|pangalan|item|description|account|loan|card|credit card|para saan|what)\b/],
];
// Column order used when the paste has no header row.
const POSITIONAL = ['name', 'balance', 'paymentAmount', 'totalPayments', 'paymentsMade', 'nextDue', 'lender'];

const MONTHS = {
  jan: 0, january: 0, enero: 0, feb: 1, february: 1, pebrero: 1, mar: 2, march: 2, marso: 2, apr: 3, april: 3, abril: 3,
  may: 4, mayo: 4, jun: 5, june: 5, hunyo: 5, jul: 6, july: 6, hulyo: 6, aug: 7, august: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, setyembre: 8, oct: 9, october: 9, oktubre: 9, nov: 10, november: 10, nobyembre: 10,
  dec: 11, december: 11, disyembre: 11,
};

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// True when `phrase` appears in `text` as whole words.
const hasWords = (text, phrase) => ` ${words(text)} `.includes(` ${phrase} `);
const anyOf = (text, phrases) => phrases.some((p) => hasWords(text, p));

// ---- table parsing (tab, comma or semicolon separated, with "quoted, cells") ----
function pickDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  if (first.includes('\t')) return '\t';
  const outside = first.replace(/"[^"]*"/g, '');
  const commas = (outside.match(/,/g) || []).length, semis = (outside.match(/;/g) || []).length;
  if (!commas && !semis) return '\t';
  return semis > commas ? ';' : ',';
}
function parseTable(text, delim) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map((cells, i) => ({ n: i + 1, cells: cells.map((c) => c.trim()) }));
}

function headerField(h) {
  const w = words(h);
  if (!w && !h.includes('%')) return null;
  for (const [field, re] of HEADER_RULES) if (re.test(w) || (field === 'rate' && h.includes('%'))) return field;
  return null;
}

// ---- cell values ----
function money(s) {
  const t = String(s).replace(/^(php|p)(?=\s*[\d.])/i, '').replace(/[₱,\s ]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
  return round2(Number(t));
}
// "12", "12 months", "6/12", "6 of 12" -> { n, of }
function count(s) {
  const m = String(s).toLowerCase().match(/^(\d{1,4})(?:\s*(?:\/|of|out of|sa)\s*(\d{1,4}))?\s*[a-z.]*$/);
  return m ? { n: Number(m[1]), of: m[2] ? Number(m[2]) : null } : null;
}
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
function nextDayOfMonth(day, from) {
  const t = parseISO(from);
  for (let k = 0; k < 2; k++) {
    const y = t.getFullYear(), m = t.getMonth() + k;
    const d = new Date(y, m, Math.min(day, lastDay(y, m)));
    if (toISO(d) >= from) return toISO(d);
  }
  return null;
}
function validYMD(y, m, d) {
  if (m < 0 || m > 11 || d < 1 || d > lastDay(y, m)) return null;
  return toISO(new Date(y, m, d));
}
// Returns { date } or { date, dueDays } or { error }.
function dueDate(s, now) {
  const t = String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return { date: null };
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return wrap(validYMD(+m[1], m[2] - 1, +m[3]));
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const a = +m[1], b = +m[2];
    return wrap(a > 12 ? validYMD(y, b - 1, a) : validYMD(y, a - 1, b)); // month first, as Sheets in PH shows it
  }
  // "5 & 20", "5th and 20th", "15/30": twice a month
  if ((m = t.match(/^(?:every |tuwing |kada )?(\d{1,2})(?:st|nd|rd|th)?\s*(?:&|and|at|,|\/)\s*(\d{1,2})(?:st|nd|rd|th)?$/))) {
    const days = [+m[1], +m[2]].sort((x, y) => x - y);
    if (days[0] >= 1 && days[1] <= 31 && days[0] !== days[1]) {
      const date = days.map((d) => nextDayOfMonth(d, now)).sort()[0];
      return { date, dueDays: days };
    }
  }
  // "15", "15th", "every 15th": the next time that day comes
  if ((m = t.match(/^(?:every |tuwing |kada )?(\d{1,2})(?:st|nd|rd|th)?(?: of the month| ng buwan)?$/)) && +m[1] >= 1 && +m[1] <= 31) return { date: nextDayOfMonth(+m[1], now) };
  // "Oct 15", "October 15, 2026", "15 Oct 2026"
  if ((m = t.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?$/)) && MONTHS[m[1]] !== undefined) return wrap(monthDay(MONTHS[m[1]], +m[2], m[3], now));
  if ((m = t.match(/^(\d{1,2}) ([a-z]+)\.?,? ?(\d{4})?$/)) && MONTHS[m[2]] !== undefined) return wrap(monthDay(MONTHS[m[2]], +m[1], m[3], now));
  // Excel date serial number (days since 1899-12-30)
  if ((m = t.match(/^(\d{5})$/)) && +m[1] > 30000 && +m[1] < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + +m[1] * 864e5);
    return wrap(validYMD(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return { error: true };
}
const wrap = (date) => (date ? { date } : { error: true });
function monthDay(month, day, year, now) {
  if (year) return validYMD(+year, month, day);
  const y = parseISO(now).getFullYear();
  const d = validYMD(y, month, day);
  if (!d) return null;
  // Without a year: this year, unless that was more than two months ago.
  const twoMonthsAgo = toISO(new Date(y, parseISO(now).getMonth() - 2, parseISO(now).getDate()));
  return d < twoMonthsAgo ? validYMD(y + 1, month, day) : d;
}
function frequency(s) {
  const t = words(s);
  if (!t) return null;
  if (/\b(once|one time|onetime|isang bayaran|lump sum|1x)\b/.test(t)) return { freq: 'once' };
  if (/\b(biweekly|bi weekly|every 2 weeks|every two weeks|kada 2 linggo|every other week)\b/.test(t)) return { freq: 'biweekly' };
  if (/\b(weekly|lingguhan|every week|kada linggo)\b/.test(t)) return { freq: 'weekly' };
  if (/\b(semi ?monthly|twice a month|kinsenas|kinsenahan|2x a month)\b/.test(t)) return { freq: 'semimonthly' };
  const two = t.match(/^(\d{1,2}) (\d{1,2})$/); // "15/30", "5 & 20"
  if (two && +two[1] !== +two[2] && +two[1] >= 1 && +two[2] <= 31) return { freq: 'semimonthly', dueDays: [+two[1], +two[2]].sort((a, b) => a - b) };
  if (/\b(quarterly|every 3 months|kada 3 buwan)\b/.test(t)) return { freq: 'quarterly' };
  if (/\b(yearly|annual|annually|taon|taunan)\b/.test(t)) return { freq: 'yearly' };
  if (/\b(monthly|buwanan|every month|kada buwan|month)\b/.test(t)) return { freq: 'monthly' };
  return null;
}
function explicitType(s) {
  const t = words(s);
  if (!t) return null;
  if (/\b(credit card|card|cc)\b/.test(t)) return 'card';
  if (/\b(app|online|lending|ola|paylater|bnpl)\b/.test(t)) return 'lending';
  if (/\b(installment|hulugan|gadget|appliance)\b/.test(t)) return 'installment';
  if (/\b(person|friend|family|tao|kaibigan|kamag anak|relative|personal)\b/.test(t)) return 'person';
  if (/\b(loan|bank|salary)\b/.test(t)) return 'loan';
  return null;
}
function guessType({ name, lender, terms, nextDue, cardColumns }) {
  const text = `${name} ${lender}`;
  if (anyOf(text, LENDING_APPS)) return 'lending';
  if (cardColumns || anyOf(text, ['card', 'credit card', 'credit', 'cc', 'mastercard', 'visa'])) return 'card';
  if (anyOf(name, ['loan', 'salary loan', 'car loan', 'housing loan'])) return 'loan';
  if (anyOf(text, PERSON_WORDS)) return 'person';
  const hasLender = !!lender || anyOf(name, BANKS);
  if (!hasLender && !terms && !nextDue) return 'person';
  if (terms) return 'installment';
  return 'loan';
}

// ---- main ----
export function parseDebtRows(text) {
  const warnings = [];
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) return { rows: [], warnings: ['Nothing to import. Copy the rows from your sheet (with the header row) and paste them here.'] };
  const delim = pickDelimiter(src);
  let table = parseTable(src, delim).filter((r) => r.cells.some((c) => c));
  if (!table.length) return { rows: [], warnings: ['Nothing to import.'] };

  // Header row: at least one known column name and no numbers in it.
  const first = table[0].cells;
  const fields = first.map(headerField);
  const isHeader = fields.some(Boolean) && !first.some((c) => Number.isFinite(money(c)));
  const map = {};
  if (isHeader) {
    fields.forEach((f, i) => { if (f && map[f] === undefined) map[f] = i; });
    table = table.slice(1);
    // A plain "Amount" column is the balance unless there is a separate balance column.
    if (map.amount !== undefined && map.balance === undefined) { map.balance = map.amount; delete map.amount; }
    if (map.name === undefined && map.lender === undefined) warnings.push('No "Name" column found. Add a column called Name so each debt has a name.');
  } else {
    POSITIONAL.forEach((f, i) => { map[f] = i; });
    warnings.push('No column names found, so columns were read as: Name, Balance, Payment, Terms, Paid, Due date, Lender. Add a header row if that is wrong.');
  }
  if (table.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS} rows were read.`);
    table = table.slice(0, MAX_ROWS);
  }
  const now = today();
  const rows = [];
  for (const { n, cells } of table) {
    const row = buildRow(cells, map, n, now, warnings);
    if (row) rows.push(row);
  }
  if (!rows.length && !warnings.length) warnings.push('No debts found in what you pasted.');
  return { rows, warnings };
}

function buildRow(cells, map, n, now, warnings) {
  const get = (f) => (map[f] === undefined ? '' : cells[map[f]] || '');
  let name = get('name').slice(0, 60);
  const lender = get('lender').slice(0, 60);
  if (!name && !lender) {
    warnings.push(`Row ${n}: no name, skipped.`);
    return null;
  }
  name = name || lender;
  if (/^(grand )?(total|totals|subtotal|kabuuan)\b/i.test(name)) {
    warnings.push(`Row ${n}: looks like a total row, skipped.`);
    return null;
  }
  const who = `Row ${n} (${name})`;
  const num = (f, label) => {
    const raw = get(f);
    if (!raw) return null;
    const v = money(raw);
    if (Number.isFinite(v)) return v;
    warnings.push(`${who}: couldn't read "${raw}" as the ${label}.`);
    return null;
  };
  const cnt = (f, label) => {
    const raw = get(f);
    if (!raw) return null;
    const c = count(raw);
    if (c) return c;
    warnings.push(`${who}: couldn't read "${raw}" as the ${label}.`);
    return null;
  };

  let balance = num('balance', 'balance');
  let payment = num('paymentAmount', 'payment amount');
  const minDue = num('minDue', 'minimum due');
  const creditLimit = num('creditLimit', 'credit limit');
  const original = num('amount', 'amount');
  const paidAmount = num('paidAmount', 'amount paid');
  const termsCell = cnt('totalPayments', 'number of payments');
  const madeCell = cnt('paymentsMade', 'payments made');
  let terms = termsCell ? termsCell.n : null;
  let made = madeCell ? madeCell.n : 0;
  if (!terms && madeCell?.of) terms = madeCell.of; // "6/12" in the Paid column

  let rate = 0;
  const rateRaw = get('rate');
  if (rateRaw) {
    const r = Number(rateRaw.replace(/%|\s/g, ''));
    if (Number.isFinite(r) && r >= 0 && r <= 100) rate = round2(r);
    else warnings.push(`${who}: couldn't read "${rateRaw}" as the interest rate.`);
  }
  const due = dueDate(get('nextDue'), now);
  if (due.error) warnings.push(`${who}: couldn't read "${get('nextDue')}" as a date.`);
  const freqRaw = get('frequency');
  const fr = frequency(freqRaw);
  if (freqRaw && !fr) warnings.push(`${who}: couldn't tell how often "${freqRaw}" is, so monthly was used.`);
  const nextDue = due.date || null;
  const dueDays = due.dueDays || fr?.dueDays || null;
  const freq = dueDays ? 'semimonthly' : fr?.freq || 'monthly';

  if (balance === null) {
    if (payment && terms) balance = round2(payment * Math.max(0, terms - made));
    else if (original !== null) balance = round2(Math.max(0, original - (paidAmount || 0)));
  }
  if (balance === null) {
    warnings.push(`${who}: no balance found, skipped.`);
    return null;
  }

  // A minimum due or a credit limit only makes sense for a credit card.
  const cardColumns = minDue !== null || creditLimit !== null;
  const type = explicitType(get('type')) || guessType({ name, lender, terms, nextDue, cardColumns });
  const draft = {
    type, name, lender: lender === name ? '' : lender, balance,
    paymentAmount: 0, plannedPayment: 0, creditLimit: creditLimit || 0,
    frequency: freq, totalPayments: 0, paymentsMade: 0, nextDue, rate, notes: get('notes').slice(0, 500),
  };
  if (original) draft.original = original;
  if (type === 'card') {
    draft.paymentAmount = minDue || 0;
    draft.plannedPayment = payment || 0;
    draft.frequency = 'monthly';
  } else if (type === 'person') {
    draft.plannedPayment = payment || minDue || 0;
  } else {
    payment = payment || minDue;
    if (!payment && terms) payment = round2(balance / Math.max(1, terms - made));
    if (payment && !terms) terms = made + Math.max(1, Math.ceil(round2(balance / payment) - 1e-9));
    if (!payment || !terms) {
      terms = 1; made = 0; payment = balance;
      draft.frequency = 'once';
      warnings.push(`${who}: no payment schedule found, so it was set as one payment of the full balance. You can edit it after importing.`);
    }
    if (made > terms) {
      warnings.push(`${who}: ${made} payments made is more than the ${terms} total, so it was set to ${terms}.`);
      made = terms;
    }
    Object.assign(draft, { paymentAmount: payment, totalPayments: terms, paymentsMade: made });
  }
  if (draft.frequency === 'semimonthly' && dueDays) draft.dueDays = dueDays;
  return draft;
}
