// Formatting, dates and small helpers. All dates are local 'YYYY-MM-DD' strings.

const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const pesoFmt0 = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });

export function peso(n, { whole = false } = {}) {
  const v = Number(n) || 0;
  // Drop the centavos when they're zero so lists stay readable.
  if (whole || Math.round(v * 100) % 100 === 0) return pesoFmt0.format(v);
  return pesoFmt.format(v);
}

export function pesoShort(n) {
  const v = Math.abs(Number(n) || 0);
  const s = n < 0 ? '-' : '';
  if (v >= 1e6) return `${s}₱${trim(v / 1e6)}M`;
  if (v >= 1e3) return `${s}₱${trim(v / 1e3)}k`;
  return `${s}₱${Math.round(v)}`;
}
const trim = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function parseAmount(s) {
  const v = parseFloat(String(s ?? '').replace(/[₱,\s]/g, ''));
  return Number.isFinite(v) ? round2(v) : 0;
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
  semimonthly: 'Twice a month (15th & end)',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
  once: 'One time',
};

export function advance(iso, freq, keepDay) {
  switch (freq) {
    case 'weekly': return addDays(iso, 7);
    case 'biweekly': return addDays(iso, 14);
    case 'semimonthly': {
      const d = parseISO(iso);
      const end = lastDayOf(d.getFullYear(), d.getMonth());
      if (d.getDate() < 15) { d.setDate(15); return toISO(d); }
      if (d.getDate() < end) { d.setDate(end); return toISO(d); }
      return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 15));
    }
    case 'monthly': return addMonths(iso, 1, keepDay);
    case 'quarterly': return addMonths(iso, 3, keepDay);
    case 'yearly': return addMonths(iso, 12, keepDay);
    default: return null;
  }
}

// Number of payments per month, for "monthly obligations" totals.
export const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, once: 0 };
