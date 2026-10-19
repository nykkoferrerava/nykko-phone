// The demo data the ad is captured with: tests/fixtures/v2-data.json, plus a few staging edits so the
// screens show what the script talks about. Nothing here is real personal data.
//
// Staging edits (all listed in video/README.md):
// - light theme, no PIN (the fixture has a dummy PIN hash), backup "today" (no backup banner);
// - four made-up Food entries this pay period, so Food passes 80% of its ₱3,000 limit and Home shows
//   "Budgets to watch";
// - GCash's starting balance (Oct 1) is set so the demo GCash statement (tests/fixtures/statement-gcash.pdf)
//   reconciles: after importing it, Pitaka's GCash balance on Oct 12 equals the statement's ending balance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/v2-data.json', import.meta.url));

// The capture's "now": Monday, Oct 19, 2026, 9:41 AM in Manila. Payday is every second Friday from the
// fixture's anchor (Oct 9), so the next one is Fri, Oct 23.
export const NOW = '2026-10-19T09:41:00+08:00';

export const EXTRA_FOOD = [
  { note: 'Mang Inasal', amount: 420, date: '2026-10-14', wallet: 'GCash' },
  { note: 'Samgyup with Mel', amount: 1250, date: '2026-10-16', wallet: 'BPI Savings' },
  { note: 'Coffee', amount: 165, date: '2026-10-17', wallet: 'Cash' },
  { note: 'Lunch', amount: 300, date: '2026-10-18', wallet: 'GCash' },
];

export function stagedData({ gcashOpening } = {}) {
  const d = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  Object.assign(d.settings, { theme: 'light', pinHash: null, pinSalt: null, lastBackupAt: '2026-10-19T00:30:00.000Z' });
  const food = d.categories.find((c) => c.name === 'Food').id;
  const acct = (name) => d.accounts.find((a) => a.name === name).id;
  EXTRA_FOOD.forEach((e, i) => d.txns.push({
    id: `demo-food-${i + 1}`, kind: 'expense', amount: e.amount, date: e.date, note: e.note,
    createdAt: Date.parse(`${e.date}T12:30:00+08:00`), categoryId: food, accountId: acct(e.wallet), fx: {},
  }));
  if (gcashOpening !== undefined) d.accounts.find((a) => a.name === 'GCash').opening = gcashOpening;
  d.settings.entriesAtBackup = d.txns.length;
  return d;
}

// Init script for the page: the clock starts at NOW and keeps running. window.__timeScale(s) slows the
// page's clocks (Date, performance.now, requestAnimationFrame timestamps, timers) by s, so a screencast
// samples every animation s times more often; the clip is sped back up to real time afterwards. CSS
// animations are slowed to match through the DevTools Animation domain.
export const timeScript = (startMs) => {
  const RealDate = Date;
  const rNow = RealDate.now.bind(RealDate);
  const rPerf = performance.now.bind(performance);
  const rTimeout = window.setTimeout.bind(window);
  const rInterval = window.setInterval.bind(window);
  const rRaf = window.requestAnimationFrame.bind(window);
  let scale = 1, rBase = rNow(), vBase = startMs, pBase = rPerf(), vpBase = pBase;
  const vNow = () => Math.floor(vBase + (rNow() - rBase) * scale);
  const vPerf = () => vpBase + (rPerf() - pBase) * scale;
  Object.defineProperty(window, '__timeScale', { value: (s) => { vBase = vNow(); rBase = rNow(); vpBase = vPerf(); pBase = rPerf(); scale = s; } });
  class CaptureDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(vNow()); }
    static now() { return vNow(); }
  }
  // eslint-disable-next-line no-global-assign
  Date = CaptureDate;
  performance.now = vPerf;
  window.setTimeout = (fn, ms, ...a) => rTimeout(fn, (Number(ms) || 0) / scale, ...a);
  window.setInterval = (fn, ms, ...a) => rInterval(fn, (Number(ms) || 0) / scale, ...a);
  window.requestAnimationFrame = (cb) => rRaf(() => cb(vPerf()));
};
