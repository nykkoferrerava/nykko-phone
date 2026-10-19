// Formatting, dates and small helpers. All dates are local 'YYYY-MM-DD' strings.

const MINUS = '\u2212'; // real minus sign, easier to read than a hyphen

// Same text as Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }) (tests compare them),
// without starting Intl on the way to the first render.
const group = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ',');
export function peso(n, { whole = false } = {}) {
  const v = Number(n);
  const cents = Number.isFinite(v) ? Math.round(v * 100) : 0;
  if (cents === 0) return '₱0';
  const abs = Math.abs(cents);
  // Drop the centavos when they're zero so lists stay readable.
  const s = whole || abs % 100 === 0 ? `₱${group(Math.round(abs / 100))}` : `₱${group(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? MINUS + s : s;
}

// Compact amounts for chart axes and tight tiles: ₱500, ₱1.5k, ₱2.5M, ₱500B.
export function pesoShort(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '₱0';
  const units = ['', 'k', 'M', 'B'];
  let x = Math.abs(v), i = 0;
  // Move up a unit whenever the rounded number would show 4+ digits (999,950 -> ₱1M, not ₱1000k).
  while (i < units.length - 1 && (i ? shortRound(x) : Math.round(x)) >= 1000) { x /= 1000; i++; }
  const num = i ? shortRound(x) : Math.round(x);
  const sign = v < 0 && num !== 0 ? MINUS : '';
  return `${sign}₱${num.toLocaleString('en-US', { maximumFractionDigits: 1 })}${units[i]}`;
}
const shortRound = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);

// "|| 0" also turns -0 into 0 so totals never print as "−₱0".
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100 || 0;

// Strict: "1234", "1,234.50", "₱500", " 500 ". Anything else (letters, signs, exponents) is NaN.
export function parseAmount(s) {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? round2(s) : NaN;
  if (typeof s !== 'string') return NaN;
  const t = s.replace(/[₱,\s\u00a0]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
  return round2(Number(t));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- dates ----
export function toISO(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = () => toISO(new Date());

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();

// Adds months keeping the intended day (e.g. 31st -> 28th in Feb -> 31st in Mar).
export function addMonths(iso, n, keepDay) {
  const d = parseISO(iso);
  const day = keepDay || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(day, lastDayOf(t.getFullYear(), t.getMonth())));
  return toISO(t);
}
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}
export const monthKey = (iso) => iso.slice(0, 7);
export function monthLabel(key, long = false) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-PH', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
}
export function shiftMonth(key, n) {
  return addMonths(key + '-01', n).slice(0, 7);
}
export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const d = parseISO(iso);
  const o = { ...opts };
  if (d.getFullYear() !== new Date().getFullYear() && !o.year) o.year = 'numeric';
  return d.toLocaleDateString('en-PH', o);
}
export function relDay(iso) {
  const n = daysBetween(today(), iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

// ---- recurring schedules ----
export const FREQS = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
  once: 'One time',
};

// Due days for "twice a month": [first, second], 31 = last day of the month.
export const DEFAULT_DUE_DAYS = [15, 31];
function semiDays(y, m, dueDays) {
  const [a, b] = Array.isArray(dueDays) && dueDays.length === 2 ? dueDays : DEFAULT_DUE_DAYS;
  const last = lastDayOf(y, m);
  return [...new Set([Math.min(a, last), Math.min(b, last)])].sort((x, z) => x - z);
}

// Next occurrence after `iso` on a schedule. keepDay = intended day of month (e.g. 31).
export function advance(iso, freq, keepDay, dueDays) {
  switch (freq) {
    case 'weekly': return addDays(iso, 7);
    case 'biweekly': return addDays(iso, 14);
    case 'semimonthly': {
      const d = parseISO(iso), y = d.getFullYear(), m = d.getMonth();
      const day = semiDays(y, m, dueDays).find((x) => x > d.getDate());
      if (day) return toISO(new Date(y, m, day));
      return toISO(new Date(y, m + 1, semiDays(y, m + 1, dueDays)[0]));
    }
    case 'monthly': return addMonths(iso, 1, keepDay);
    case 'quarterly': return addMonths(iso, 3, keepDay);
    case 'yearly': return addMonths(iso, 12, keepDay);
    default: return null;
  }
}

// One step back along a schedule: the exact inverse of advance() for dates on the schedule.
export function retreat(iso, freq, keepDay, dueDays) {
  switch (freq) {
    case 'weekly': return addDays(iso, -7);
    case 'biweekly': return addDays(iso, -14);
    case 'semimonthly': {
      const d = parseISO(iso), y = d.getFullYear(), m = d.getMonth();
      const day = semiDays(y, m, dueDays).filter((x) => x < d.getDate()).pop();
      if (day) return toISO(new Date(y, m, day));
      const prev = semiDays(y, m - 1, dueDays);
      return toISO(new Date(y, m - 1, prev[prev.length - 1]));
    }
    case 'monthly': return addMonths(iso, -1, keepDay);
    case 'quarterly': return addMonths(iso, -3, keepDay);
    case 'yearly': return addMonths(iso, -12, keepDay);
    default: return null;
  }
}

// Number of payments per month, for "monthly obligations" totals.
export const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, once: 0 };
