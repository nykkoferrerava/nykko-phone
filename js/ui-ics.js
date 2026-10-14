// Calendar reminders as .ics files (Calendar on iPhone opens them with "Add All").
import * as S from './store.js';
import { db } from './store.js';
import { peso, addDays, parseISO } from './util.js';

// RFC 5545 TEXT escaping.
export const icsText = (s) => String(s ?? '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r\n|\r|\n/g, '\\n');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export function rrule(freq, iso, dueDay, dueDays) {
  const date = parseISO(iso);
  const day = Number(dueDay) || date.getDate();
  // "Last day it can be" for days that some months don't have (29–31).
  const lastOf = (d) => `;BYMONTHDAY=${range(28, d).join(',')};BYSETPOS=-1`;
  switch (freq) {
    case 'weekly': return 'FREQ=WEEKLY';
    case 'biweekly': return 'FREQ=WEEKLY;INTERVAL=2';
    case 'semimonthly': {
      const days = (Array.isArray(dueDays) && dueDays.length === 2 ? dueDays : [15, 31]).map((d) => (Number(d) >= 31 ? -1 : Number(d)));
      return `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')}`;
    }
    case 'monthly': return `FREQ=MONTHLY${day >= 29 ? lastOf(day) : ''}`;
    case 'quarterly': return `FREQ=MONTHLY;INTERVAL=3${day >= 29 ? lastOf(day) : ''}`;
    case 'yearly': return date.getMonth() === 1 && day === 29 ? 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1' : 'FREQ=YEARLY';
    default: return '';
  }
}

export function billEntry(b) {
  if (!b || b.done || !b.nextDue) return null;
  return { uid: `bill-${b.id}`, name: b.name, amount: b.amount, due: b.nextDue, freq: b.frequency || 'monthly', dueDay: b.dueDay, dueDays: b.dueDays };
}
export function debtEntry(d) {
  if (!d || !(d.balance > 0) || !d.nextDue) return null;
  const freq = d.type === 'card' ? 'monthly' : d.frequency || (d.type === 'person' ? 'once' : 'monthly');
  const amount = d.type === 'card' ? d.plannedPayment || d.minDue || d.paymentAmount : d.paymentAmount || d.plannedPayment;
  const left = S.paymentsLeft(d);
  return { uid: `debt-${d.id}`, name: d.name, amount, due: d.nextDue, freq, dueDay: d.dueDay, dueDays: d.dueDays, count: Number.isFinite(left) && left > 0 ? left : 0 };
}

// Fold lines longer than 75 octets (UTF-8 aware).
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(entries) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pitaka//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of entries) {
    let rule = e.freq === 'once' ? '' : rrule(e.freq, e.due, e.dueDay, e.dueDays);
    if (rule && e.count) rule += `;COUNT=${e.count}`;
    const title = `Pay ${e.name}${e.amount ? ` (${peso(e.amount)})` : ''}`;
    lines.push(
      'BEGIN:VEVENT', `UID:${e.uid}@pitaka`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.due.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(e.due, 1).replace(/-/g, '')}`,
      `SUMMARY:${icsText(title)}`,
    );
    if (rule) lines.push(`RRULE:${rule}`);
    lines.push(
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Pay ${e.name} tomorrow`)}`, 'TRIGGER:-PT15H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`${e.name} is due today`)}`, 'TRIGGER:PT9H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function icsFileName(name) {
  const base = String(name ?? '').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base ? `${base}.ics` : 'pitaka-reminder.ics';
}

// Share sheet when the phone supports sharing files, else a download. Returns 'shared' | 'cancelled' | 'downloaded'.
export async function deliverFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

export function icsForItem(kind, item) {
  const e = kind === 'bill' ? billEntry(item) : debtEntry(item);
  if (!e) return null;
  return new File([buildIcs([e])], icsFileName(item.name), { type: 'text/calendar' });
}
export function icsForAll() {
  const entries = [...db.bills.map(billEntry), ...db.debts.map(debtEntry)].filter(Boolean);
  if (!entries.length) return null;
  return new File([buildIcs(entries)], 'pitaka-due-dates.ics', { type: 'text/calendar' });
}
