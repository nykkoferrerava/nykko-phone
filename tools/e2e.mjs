// End-to-end regression: drives the real UI in Chromium (an iPhone 15 in Safari, or installed on the
// Home Screen) through v2's features and v3's flows, against this working copy and a local relay.
//   node tools/e2e.mjs
//
// It serves this folder on http://localhost:8146 and runs the relay (relay/worker.js) with `wrangler dev`
// on 127.0.0.1:8796; the page reaches it as https://pitaka-relay.test.workers.dev, because the CSP only
// allows *.workers.dev. Needs Playwright with a Chromium (CHROMIUM=/path/to/chromium if Playwright has
// none) and wrangler (WRANGLER=/path/to/wrangler, or on PATH). E2E_PORT / E2E_RELAY_PORT change the
// ports; screenshots, downloads and report.json go to E2E_OUT (default: <tmp>/pitaka-e2e).
//
// Taps, typing, the file chooser and downloads are a person's. The window.pitaka hook (localhost only)
// is used to read state for checks, never to change it. Two things are simulated: going to the
// background (a visibilitychange) and the minute that passes there (Date.now runs ahead).
// Prints PASS / FAIL / SKIP per step and exits non-zero on any failure.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire('/opt/node22/lib/node_modules/')('playwright'); }

const PORT = Number(process.env.E2E_PORT) || 8146;
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT) || 8796;
const ORIGIN = `http://localhost:${PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const RELAY_HOST = 'pitaka-relay.test.workers.dev';
const OTHER_HOST = 'someone-else.workers.dev'; // any other Worker: allowed before pairing, blocked after
const ADMIN_SECRET = 'local-dev-secret-0123456789';
const PIN = '1357';
const OUT = process.env.E2E_OUT || path.join(tmpdir(), 'pitaka-e2e');
const FIX = path.join(root, 'tests/fixtures');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'downloads'), { recursive: true });

// ============================================================ the site and the relay
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown' };
const server = createServer((req, res) => {
  let p;
  try { p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch { res.writeHead(400); return res.end(); }
  const f = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!f.startsWith(root) || /[/\\]\.git([/\\]|$)/.test(f) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(f));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); }).catch((e) => {
  console.error(`Can't serve on port ${PORT} (${e.code}). Set E2E_PORT to a free port.`);
  process.exit(2);
});

function findWrangler() {
  const local = [process.env.WRANGLER, path.join(root, 'node_modules/.bin/wrangler'), path.join(root, 'relay/node_modules/.bin/wrangler')].filter(Boolean);
  for (const c of local) if (existsSync(c)) return c;
  try { return execFileSync('which', ['wrangler'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const relayDir = mkdtempSync(path.join(tmpdir(), 'pitaka-e2e-relay-'));
let relayProc = null;
let relayLog = '';
async function startRelay() {
  const bin = findWrangler();
  if (!bin) return 'wrangler not found: set WRANGLER=/path/to/node_modules/.bin/wrangler';
  const toml = readFileSync(path.join(root, 'relay/wrangler.toml'), 'utf8').replace(/^main = .*$/m, `main = ${JSON.stringify(path.join(root, 'relay/worker.js'))}`);
  writeFileSync(path.join(relayDir, 'wrangler.toml'), toml);
  writeFileSync(path.join(relayDir, '.dev.vars'), `ADMIN_SECRET="${ADMIN_SECRET}"\n`);
  relayProc = spawn(bin, ['dev', '--local', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', path.join(relayDir, 'state'), '--var', `ALLOWED_ORIGIN:${ORIGIN}`, '--config', path.join(relayDir, 'wrangler.toml')], {
    cwd: relayDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  relayProc.stdout.on('data', (d) => { relayLog += d; });
  relayProc.stderr.on('data', (d) => { relayLog += d; });
  for (let i = 0; i < 120; i++) {
    if (relayProc.exitCode !== null) return `wrangler dev exited (${relayProc.exitCode}): ${relayLog.slice(-600)}`;
    try { const r = await fetch(`${RELAY}/`); if ((await r.json()).service === 'pitaka-relay') return null; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return `wrangler dev didn't answer on ${RELAY} within a minute: ${relayLog.slice(-600)}`;
}
function stopRelay() {
  if (!relayProc || relayProc.exitCode !== null) return;
  try { process.kill(-relayProc.pid, 'SIGTERM'); } catch { try { relayProc.kill('SIGTERM'); } catch { /* gone */ } }
}
// What a shortcut does: POST /in with the write token, no Origin header.
async function shortcutPost(token, item) {
  const r = await fetch(`${RELAY}/in`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
let seq = 0;
const cid = (p) => `${p}-${Date.now().toString(36)}-${(++seq).toString().padStart(4, '0')}`;

// ============================================================ steps and checks
class Mismatch extends Error {
  constructor(what, expected, actual) {
    super(`${what}: expected ${show(expected)}, got ${show(actual)}`);
    Object.assign(this, { what, expected, actual });
  }
}
const show = (v) => (typeof v === 'string' ? JSON.stringify(v.length > 300 ? `${v.slice(0, 300)}…` : v) : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (actual, expected, what) => { if (!same(actual, expected)) throw new Mismatch(what, expected, actual); };
const near = (actual, expected, what) => { if (!(Math.abs(Number(actual) - Number(expected)) < 0.005)) throw new Mismatch(what, expected, actual); };
const ok = (cond, what, actual) => { if (!cond) throw new Mismatch(what, 'true', actual); };
const has = (text, part, what) => { if (!String(text ?? '').includes(part)) throw new Mismatch(what, `text containing ${JSON.stringify(part)}`, text); };

const results = [];
const failed = new Set();
const NOISE = [/favicon\.ico/, /status of 404 \(Not Found\)/];
let page = null; // the phone in use
let pageErrors = [];
let stepNo = 0;

async function step(name, fn, { id = '', needs = [], allow = [] } = {}) {
  stepNo++;
  const blocked = needs.filter((n) => failed.has(n));
  if (blocked.length) {
    if (id) failed.add(id);
    results.push({ n: stepNo, name, status: 'SKIP', why: `needs ${blocked.join(', ')}` });
    console.log(`SKIP  ${String(stepNo).padStart(2)} ${name}  (needs ${blocked.join(', ')})`);
    return;
  }
  const from = pageErrors.length;
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const errs = pageErrors.slice(from).filter((e) => !NOISE.some((re) => re.test(e)) && !allow.some((re) => re.test(e)));
  if (!err && errs.length) err = new Mismatch('console', 'no errors in the console', errs);
  const ms = Date.now() - t0;
  if (!err) {
    results.push({ n: stepNo, name, status: 'PASS', ms });
    console.log(`PASS  ${String(stepNo).padStart(2)} ${name}`);
    return;
  }
  if (id) failed.add(id);
  let shot = '';
  if (page && !page.isClosed()) {
    shot = path.join(OUT, `fail-${String(stepNo).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}.png`);
    await page.screenshot({ path: shot }).catch(() => { shot = ''; });
  }
  const r = { n: stepNo, name, status: 'FAIL', ms, error: err.message.split('\n')[0].slice(0, 600), expected: err.expected, actual: err.actual, shot, console: errs };
  results.push(r);
  console.log(`FAIL  ${String(stepNo).padStart(2)} ${name}\n        ${r.error}${shot ? `\n        screenshot: ${shot}` : ''}${errs.length ? `\n        console: ${errs.join(' | ').slice(0, 400)}` : ''}`);
}

// ============================================================ the phone
// Init script: records each toast, the theme at first paint, and lets the test move Date.now ahead.
const PROBES = () => {
  const real = Date.now.bind(Date);
  let skew = 0;
  Date.now = () => real() + skew;
  Object.defineProperty(window, '__e2eAdvance', { value: (ms) => { skew += ms; } });
  const paint = { atBody: undefined, atFrame: undefined, bgAtFrame: '' };
  Object.defineProperty(window, '__e2ePaint', { value: paint });
  const mo = new MutationObserver(() => {
    if (document.body && paint.atBody === undefined) { paint.atBody = document.documentElement.getAttribute('data-theme'); mo.disconnect(); }
  });
  mo.observe(document, { childList: true, subtree: true });
  requestAnimationFrame(() => {
    paint.atFrame = document.documentElement.getAttribute('data-theme');
    paint.bgAtFrame = getComputedStyle(document.body || document.documentElement).backgroundColor;
  });
  const toasts = [];
  Object.defineProperty(window, '__e2eToasts', { value: toasts });
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('toast');
    if (t) new MutationObserver(() => { if (!t.hidden && t.innerText.trim()) toasts.push(t.innerText.replace(/\s+/g, ' ').trim()); }).observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
};

let browser;
const dialogs = [];
const downloads = [];
async function phone({ standalone = true, scheme = 'light' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme,
    timezoneId: 'Asia/Manila', locale: 'en-PH', userAgent: UA, acceptDownloads: true,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await ctx.route(`https://${RELAY_HOST}/**`, async (route) => {
    const u = new URL(route.request().url());
    try { await route.fulfill({ response: await route.fetch({ url: `${RELAY}${u.pathname}${u.search}` }) }); } catch { await route.abort('connectionrefused'); }
  });
  await ctx.route(`https://${OTHER_HOST}/**`, (route) => route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: '{"reached":true}' }));
  if (standalone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  await ctx.addInitScript(PROBES);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });
  p.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  p.on('download', (d) => downloads.push(d));
  page = p;
  return { ctx, p };
}
const ready = () => page.waitForFunction(() => !!window.pitaka, null, { timeout: 15000 });
const state = (fn, arg) => page.evaluate(fn, arg);
const tap = (sel, opts) => page.locator(sel).first().tap(opts);
const sleep = (ms) => page.waitForTimeout(ms);
const text = (sel) => page.locator(sel).first().innerText().then((s) => s.replace(/\s+/g, ' ').trim());

async function until(fn, arg, what, expected, probe, timeout = 6000) {
  try { await page.waitForFunction(fn, arg, { timeout }); } catch { throw new Mismatch(what, expected, probe ? await page.evaluate(probe, arg).catch((e) => e.message) : 'timed out'); }
}
// Big numbers count up to their value; wait until each shows what it counts to.
const settle = () => until(() => [...document.querySelectorAll('#main [data-count]')].every((el) => (el.querySelector('.v') || el).textContent === new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(Number(el.dataset.to) || 0)),
  null, 'counted numbers', 'settled', () => [...document.querySelectorAll('#main [data-count]')].map((el) => `${el.dataset.count}: ${el.textContent} -> ${el.dataset.to}`).join(', '), 4000);
const toastMark = () => state(() => window.__e2eToasts.length);
async function toast(mark, part, timeout = 6000) {
  await until(([m, p]) => window.__e2eToasts.slice(m).some((t) => t.includes(p)), [mark, part], 'toast', part, ([m]) => window.__e2eToasts.slice(m).join(' ‖ ') || '(no toast)', timeout);
  return state((m) => window.__e2eToasts.slice(m).join(' ‖ '), mark);
}
async function sheet(title) {
  await until((t) => { const s = document.querySelector('#sheet'); const h = document.querySelector('#sheet-title'); return !!s && !s.hidden && s.classList.contains('open') && !!h && h.textContent.replace(/\s+/g, ' ').trim().includes(t); },
    title, 'open sheet', title, () => { const s = document.querySelector('#sheet'); return s.hidden ? '(no sheet open)' : document.querySelector('#sheet-title')?.textContent.trim(); });
}
const sheetGone = () => until(() => document.querySelector('#sheet').hidden, null, 'sheet', 'closed', () => document.querySelector('#sheet-title')?.textContent.trim(), 4000);
async function closeSheet() {
  if (await state(() => document.querySelector('#sheet').hidden)) return;
  const close = page.locator('#sheet .sheet-head [data-action="closeSheet"]');
  if (await close.count()) await close.first().tap();
  else await page.locator('#sheet .sheet-backdrop').tap({ position: { x: 30, y: 20 } }).catch(() => page.keyboard.press('Escape'));
  await sheetGone();
}
async function tab(name) {
  await closeSheet();
  await tap(`.tabbar [data-tab="${name}"]`);
  await until((n) => document.querySelector(`.tabbar [data-tab="${n}"]`)?.getAttribute('aria-current') === 'page', name, 'tab', name);
}
async function settings() {
  await tab('home');
  await tap('#topbar [data-action="settings"]');
  await sheet('Settings');
}
// Picks the option whose text starts with `label`.
async function pick(sel, label) {
  const loc = page.locator(sel).first();
  const opts = await loc.evaluate((s) => [...s.options].map((o) => [o.value, o.textContent.trim()]));
  const hit = opts.find(([, l]) => l.startsWith(label));
  if (!hit) throw new Mismatch(`option in ${sel}`, label, opts.map(([, l]) => l));
  await loc.selectOption(hit[0]);
}
const bal = (name) => state((n) => { const S = window.pitaka.S; const a = S.db.accounts.find((x) => x.name === n); return a ? S.accountBalance(a.id) : null; }, name);
const debtOf = (name) => state((n) => { const d = window.pitaka.S.db.debts.find((x) => x.name === n); return d ? JSON.parse(JSON.stringify(d)) : null; }, name);
const iso = (n = 0) => state((k) => { const P = window.pitaka; return P.toISO(new Date(Date.now() + k * 86400000)); }, n);
async function unlock(pin = PIN) {
  await until(() => !document.querySelector('#lock').hidden, null, 'lock screen', 'shown', () => 'hidden');
  for (const k of pin) await tap(`#lock [data-k="${k}"]`);
  await until(() => document.querySelector('#lock').hidden, null, 'lock screen', 'gone after the PIN', () => document.querySelector('#lock-err')?.textContent || 'still shown');
}
async function reload({ pin = true } = {}) {
  await page.reload();
  await ready();
  if (pin) await unlock();
}
// "Free to spend until payday" as Home shows it (after its count-up), and as the store has it.
async function homeFree() {
  await tab('home');
  await settle();
  return state(() => {
    const h = document.querySelector('#main .hero.spend');
    const v = h?.querySelector('[data-count="free"] .v')?.textContent;
    const shown = v === undefined ? null : (h.classList.contains('short') ? -1 : 1) * Number(v.replace(/,/g, ''));
    const f = window.pitaka.S.freeToSpend().free;
    return { shown, store: Math.sign(f) * Math.round(Math.abs(f)) };
  });
}
async function freeMoves(before, delta, what) {
  const now = await homeFree();
  eq(now.shown, now.store, `free to spend on Home vs the store (${what})`);
  eq(now.shown - before.shown, delta, `free to spend change (${what})`);
  return now;
}
// The entry form: (+), a kind, then the fields a person fills in.
async function entry({ kind = 'expense', amount, category, note, pay, account, to, debt, date, person }) {
  await closeSheet();
  await tap('.fab');
  await sheet('Add expense');
  if (kind !== 'expense') {
    await tap(`#sheet [data-action="txnKind"][data-kind="${kind}"]`);
    await sheet({ income: 'Add income', debt: 'Pay a debt', transfer: 'Move money', goal: 'Savings' }[kind]);
  }
  if (debt) { await pick('#txn-form [name=debtId]', `${debt.icon} ${debt.name}`); await sleep(150); }
  if (amount !== undefined) { const a = page.locator('#txn-form [name=amount]'); await a.fill(''); await a.pressSequentially(String(amount)); }
  if (category) await page.locator('#txn-form label.cat-opt', { has: page.locator(`small:text-is("${category}")`) }).tap();
  if (note !== undefined) await page.locator('#txn-form [name=note]').fill(note);
  if (person) await page.locator('#txn-form [name=person]').fill(person);
  if (pay) await pick('#txn-form [name=pay]', pay);
  if (account) await pick('#txn-form [name=accountId]', account);
  if (to) await pick('#txn-form [name=toAccountId]', to);
  if (date) await page.locator('#txn-form [name=date]').fill(date);
}
// Saves with the header's Save link (what you reach with the keyboard up), or the big button at the bottom.
async function save(expectToast = 'Saved', { bottom = false } = {}) {
  const m = await toastMark();
  await tap(bottom ? '#txn-form button[type=submit]' : '#sheet .sheet-head button[type=submit][form="txn-form"]');
  await sheetGone();
  return toast(m, expectToast);
}
const txnBy = (note) => state((n) => JSON.parse(JSON.stringify(window.pitaka.S.db.txns.filter((t) => t.note === n))), note);
async function relayCheck() {
  await settings();
  await tap('#sheet [data-action="relaySheet"]');
  await sheet('Inbox relay');
  const m = await toastMark();
  await tap('#sheet [data-action="relayCheck"]');
  return m;
}
async function download(trigger, n = 1) {
  const start = downloads.length;
  await trigger();
  const t0 = Date.now();
  while (downloads.length < start + n && Date.now() - t0 < 8000) await sleep(100);
  const got = downloads.slice(start);
  if (got.length < n) throw new Mismatch('downloads', n, got.map((d) => d.suggestedFilename()));
  const out = [];
  for (const d of got) {
    const file = path.join(OUT, 'downloads', d.suggestedFilename());
    await d.saveAs(file);
    out.push({ name: d.suggestedFilename(), file, text: readFileSync(file, 'utf8') });
  }
  return out;
}
const review = () => state(() => window.pitaka.X.pending().map((x) => ({ id: x.id, reason: x.reason, amount: x.parsed?.amount, text: x.raw?.text || '' })));
const card = (part) => page.locator('#main .review-card', { hasText: part });

// ============================================================ the run
const relayError = await startRelay();
if (relayError) console.log(`relay: ${relayError}`);
browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const ctxs = [];
const S = {}; // what the main scenario learns along the way (ids, tokens, dates)

try {
  // ---------------------------------------------------------------- Safari, before installing
  await step('Install · Safari shows "Install Pitaka first"', async () => {
    const { ctx } = await phone({ standalone: false });
    ctxs.push(ctx);
    await page.goto(`${ORIGIN}/`);
    await ready();
    await until(() => !document.querySelector('#install').hidden, null, 'install screen', 'shown', () => 'hidden');
    eq(await text('#install-h'), 'Install Pitaka first', 'install heading');
    has(await text('#install'), 'Add to Home Screen', 'install steps');
    ok(await state(() => document.querySelector('#onboard').hidden), 'onboarding stays hidden behind the install screen', 'shown');
  });
  await step('Install · "Continue in the browser anyway" goes to the payday step', async () => {
    await tap('#install [data-action="continueBrowser"]');
    await until(() => document.querySelector('#install').hidden && !document.querySelector('#onboard').hidden, null, 'onboarding', 'payday step', () => document.querySelector('#onboard h1')?.textContent);
    eq(await text('#onb-h'), 'When is your next payday?', 'onboarding heading');
  });
  await ctxs.pop().close();

  // ---------------------------------------------------------------- installed: onboarding from empty storage
  {
    const { ctx } = await phone();
    ctxs.push(ctx);
  }
  await step('Onboarding · opens on the payday step when installed', async () => {
    await page.goto(`${ORIGIN}/`);
    await ready();
    ok(await state(() => document.querySelector('#install').hidden), 'no install screen when standalone', 'shown');
    eq(await text('#onb-h'), 'When is your next payday?', 'onboarding heading');
  }, { id: 'onboard' });

  await step('Onboarding · payday picker: only Fridays can be picked', async () => {
    const cells = await state(() => [...document.querySelectorAll('#onboard .payday-pick .day-opt')].map((e) => ({ radio: e.querySelector('input[type=radio]')?.value || null, checked: !!e.querySelector('input:checked') })));
    eq(cells.length, 14, 'days in the strip');
    const fridays = cells.filter((c) => c.radio).map((c) => c.radio);
    eq(fridays.length, 2, 'days that can be picked');
    for (const d of fridays) eq(new Date(`${d}T12:00:00Z`).getUTCDay(), 5, `weekday of ${d} (5 = Friday)`);
    const before = cells.find((c) => c.checked)?.radio;
    ok(before === fridays[0], 'the nearest Friday is picked to start with', before);
    await page.locator('#onboard .payday-pick span.day-opt').first().tap();
    eq(await state(() => document.querySelector('#onboard [name=payAnchor]:checked')?.value), before, 'picked day after tapping a non-Friday');
    await page.locator('#onboard label.day-opt.fri', { has: page.locator(`input[value="${fridays[1]}"]`) }).tap();
    eq(await state(() => document.querySelector('#onboard [name=payAnchor]:checked')?.value), fridays[1], 'picked day after tapping the second Friday');
    await page.locator('#onb-form [name=payAmount]').pressSequentially('25000');
    eq(await page.locator('#onb-form [name=payAmount]').inputValue(), '25,000', 'paycheck as typed');
    await tap('#onb-form button[type=submit]');
    await until(() => document.querySelector('#onb-h')?.textContent === 'Your wallets', null, 'onboarding step', 'Your wallets', () => document.querySelector('#onb-h')?.textContent);
    const s = await state(() => ({ anchor: window.pitaka.S.db.settings.payAnchor, pay: window.pitaka.S.db.settings.payAmount }));
    eq(s, { anchor: fridays[1], pay: 25000 }, 'payday saved');
    S.payday = fridays[1];
  }, { id: 'payday', needs: ['onboard'] });

  await step('Onboarding · wallets and balances', async () => {
    const names = await page.locator('#onb-form [name=wname]').evaluateAll((els) => els.map((e) => e.value));
    eq(names, ['Cash', 'GCash', 'Bank'], 'suggested wallets');
    const bals = page.locator('#onb-form [name=wbal]');
    await bals.nth(0).fill('2000');
    await bals.nth(1).fill('5,000');
    await page.locator('#onb-form [name=wname]').nth(2).fill('BPI Savings');
    await bals.nth(2).fill('20000');
    await tap('#onb-form [data-action="addWalletRow"]');
    await page.locator('#onb-form [name=wname]').nth(3).fill('GoTyme');
    await page.locator('#onb-form [name=wbal]').nth(3).fill('1000');
    await tap('#onb-form button[type=submit]');
    await until(() => document.querySelector('#onb-h')?.textContent === 'Your debts', null, 'onboarding step', 'Your debts', () => document.querySelector('#onb-h')?.textContent);
    const w = await state(() => window.pitaka.S.db.accounts.map((a) => [a.name, a.kind, window.pitaka.S.accountBalance(a.id)]));
    eq(w, [['Cash', 'cash', 2000], ['GCash', 'ewallet', 5000], ['BPI Savings', 'bank', 20000], ['GoTyme', 'bank', 1000]], 'wallets');
  }, { id: 'wallets', needs: ['onboard'] });

  await step('Onboarding · paste debts from a spreadsheet, preview, add', async () => {
    S.phoneDue = await iso(3);
    const [y, m, d] = S.phoneDue.split('-');
    const sheetText = ['Name\tBalance\tMonthly\tTerms\tPaid\tDue date\tLender', `Phone\t12,000\t2,000\t12\t6\t${m}/${d}/${y}\tHome Credit`, 'BPI Credit Card\t15,500\t3,000\t\t\t15\tBPI', 'Tita Mel\t5000\t1000\t\t\t\t'].join('\n');
    await page.locator('#onboard [name=importText]').fill(sheetText);
    await until(() => document.querySelectorAll('#onboard [data-import-preview] tbody tr').length === 3, null, 'preview rows', 3, () => document.querySelector('#onboard [data-import-preview]')?.innerText);
    const rows = await state(() => [...document.querySelectorAll('#onboard [data-import-preview] tbody tr')].map((tr) => ({ name: tr.cells[1].innerText.trim(), type: tr.querySelector('select').value, bal: tr.cells[3].innerText.trim() })));
    eq(rows.map((r) => [r.name, r.bal]), [['Phone', '₱12,000'], ['BPI Credit Card', '₱15,500'], ['Tita Mel', '₱5,000']], 'preview names and balances');
    eq(rows[1].type, 'card', 'BPI Credit Card is read as a card');
    eq(rows[2].type, 'person', 'Tita Mel is read as owed to a person');
    ok(['loan', 'lending', 'installment'].includes(rows[0].type), 'Phone is a scheduled debt', rows[0].type);
    eq(await text('#onboard [data-action="importSave"]'), 'Add 3 debts', 'add button');
    await page.locator('#onboard [data-imp-inc="2"]').tap();
    eq(await text('#onboard [data-action="importSave"]'), 'Add 2 debts', 'add button after unticking Tita Mel');
    await page.locator('#onboard [data-imp-inc="2"]').tap();
    eq(await text('#onboard [data-action="importSave"]'), 'Add 3 debts', 'add button after ticking it again');
    const m0 = await toastMark();
    await tap('#onboard [data-action="importSave"]');
    await toast(m0, 'Added 3 debts');
    await until(() => document.querySelector('#onb-h')?.textContent === 'Add expenses without opening Pitaka', null, 'onboarding step', 'Connect your iPhone', () => document.querySelector('#onb-h')?.textContent);
    const debts = await state(() => window.pitaka.S.db.debts.map((x) => [x.name, x.type, x.balance, x.nextDue]));
    eq(debts.length, 3, 'debts saved');
    eq(debts.find((x) => x[0] === 'Phone')?.[3], S.phoneDue, 'Phone due date');
    S.phoneType = rows[0].type;
  }, { id: 'debts', needs: ['onboard'] });

  await step('Onboarding · Connect: "Set it up now", then the PIN offer', async () => {
    await tap('#onboard [data-action="onbConnect"]');
    await until(() => document.querySelector('#onb-h')?.textContent === "You're all set", null, 'onboarding step', "You're all set", () => document.querySelector('#onb-h')?.textContent);
    has(await text('#onboard'), '4 wallets, 3 debts', 'summary line');
    has(await text('#onboard'), 'Lock with a PIN?', 'PIN offer');
    await tap('#onboard [data-action="onbPin"]');
    await until(() => !document.querySelector('#lock').hidden, null, 'lock screen', 'shown', () => 'hidden');
    eq(await text('#lock-title'), 'Choose a 4-digit PIN', 'lock title');
    for (const k of PIN) await tap(`#lock [data-k="${k}"]`);
    eq(await text('#lock-title'), 'Enter the same PIN again', 'lock title after 4 digits');
    const m0 = await toastMark();
    for (const k of PIN) await tap(`#lock [data-k="${k}"]`);
    await toast(m0, 'PIN set');
    await sheet('Connect your iPhone');
    const s = await state(() => ({ pin: !!window.pitaka.S.db.settings.pinHash, onboarded: window.pitaka.S.db.settings.onboarded, onboard: document.querySelector('#onboard').hidden, lock: document.querySelector('#lock').hidden }));
    eq(s, { pin: true, onboarded: true, onboard: true, lock: true }, 'after setting the PIN');
    await closeSheet();
  }, { id: 'pin', needs: ['onboard'] });

  // ---------------------------------------------------------------- Home basics
  await step('Home · "Next payday" line', async () => {
    await tab('home');
    const want = await state((d) => {
      const P = window.pitaka; const dt = P.parseISO(d); const now = new Date();
      const n = Math.round((dt - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
      const opts = { weekday: 'short', month: 'short', day: 'numeric' };
      if (dt.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
      return `Next payday: ${dt.toLocaleDateString('en-PH', opts)} · ${n} day${n === 1 ? '' : 's'}`;
    }, S.payday);
    eq(await text('#main .top .sub'), want, 'payday line');
  }, { needs: ['payday'] });

  // ---------------------------------------------------------------- entries
  await step('Entries · add an expense (free to spend drops by it)', async () => {
    S.free = await homeFree();
    eq(S.free.shown, S.free.store, 'free to spend on Home vs the store');
    await entry({ amount: 250, category: 'Food', note: 'Lunch', pay: 'GCash' });
    await save('Saved', { bottom: true });
    const [t] = await txnBy('Lunch');
    ok(t && t.kind === 'expense' && t.amount === 250, 'Lunch saved as a ₱250 expense', t);
    eq(await bal('GCash'), 4750, 'GCash balance');
    S.free = await freeMoves(S.free, -250, 'after a ₱250 expense');
    S.lunchId = t.id;
  }, { id: 'expense', needs: ['wallets'] });

  await step('Entries · the last toast doesn\'t cover the next form\'s Save button', async () => {
    // Right after a save, "Saved · Undo" shows for 6 seconds. Open the form again and look at the Save button.
    await entry({ amount: 5, category: 'Food', note: 'Toast check', pay: 'Cash' });
    await save('Saved', { bottom: true });
    await tap('.fab');
    await sheet('Add expense');
    await page.locator('#txn-form button[type=submit]').scrollIntoViewIfNeeded();
    await sleep(400);
    const hits = await state(() => {
      const b = document.querySelector('#txn-form button[type=submit]').getBoundingClientRect();
      return [0.1, 0.3, 0.5, 0.6, 0.7, 0.9].map((f) => { const el = document.elementFromPoint(b.x + b.width * f, b.y + b.height / 2); return el?.closest('#toast') ? `toast (${el.closest('.toast-action') ? 'its Undo button' : 'text'}) at ${Math.round(f * 100)}%` : ''; }).filter(Boolean);
    });
    await closeSheet();
    const [t] = await txnBy('Toast check');
    if (t) { await tab('home'); await page.locator('#main .list .row', { hasText: 'Toast check' }).first().tap(); await sheet('Edit entry'); await tap('#txn-form [data-action="deleteTxn"]'); await sheetGone(); }
    eq(hits, [], 'what a tap on the Save button reaches while the last toast shows');
  }, { needs: ['wallets'] });

  await step('Entries · add income', async () => {
    await entry({ kind: 'income', amount: 25000, note: 'Salary', account: 'BPI Savings' });
    await save('Saved');
    eq(await bal('BPI Savings'), 45000, 'BPI Savings balance');
    S.free = await freeMoves(S.free, 25000, 'after ₱25,000 income');
  }, { needs: ['wallets'] });

  await step('Entries · move money between wallets', async () => {
    await entry({ kind: 'transfer', amount: 1000, account: 'BPI Savings', to: 'GCash', note: 'Cash-in' });
    await save('Saved');
    eq([await bal('BPI Savings'), await bal('GCash')], [44000, 5750], 'BPI Savings and GCash');
    S.free = await freeMoves(S.free, 0, 'after a transfer');
  }, { needs: ['wallets'] });

  await step('Entries · pay a debt (its due date moves, free to spend stays)', async () => {
    const before = await debtOf('Phone');
    await entry({ kind: 'debt', debt: { icon: S.phoneType === 'loan' ? '🏦' : S.phoneType === 'installment' ? '🧾' : '📱', name: 'Phone' } });
    eq(await page.locator('#txn-form [name=amount]').inputValue(), '2,000', 'amount filled in from the schedule');
    eq(await text('#txn-form [name=instOut]'), '1 payment', 'covers');
    await pick('#txn-form [name=accountId]', 'GCash');
    await save('Saved');
    const after = await debtOf('Phone');
    eq(after.balance, before.balance - 2000, 'Phone balance');
    const next = await state((d) => window.pitaka.advance(d, 'monthly'), before.nextDue);
    eq(after.nextDue, next, 'Phone next due');
    eq(await bal('GCash'), 3750, 'GCash balance');
    S.free = await freeMoves(S.free, 0, 'after paying a debt that was due before payday');
  }, { id: 'debtpay', needs: ['debts'] });

  await step('Entries · edit an entry', async () => {
    await tab('home');
    await page.locator('#main .list .row', { hasText: 'Lunch' }).first().tap();
    await sheet('Edit entry');
    await page.locator('#txn-form [name=amount]').fill('300');
    await save('Changes saved');
    const [t] = await txnBy('Lunch');
    eq([t?.id, t?.amount], [S.lunchId, 300], 'Lunch after editing');
    eq(await bal('GCash'), 3700, 'GCash balance');
    S.free = await freeMoves(S.free, -50, 'after raising Lunch by ₱50');
  }, { needs: ['expense'] });

  await step('Entries · delete, then Undo', async () => {
    await tab('home');
    await page.locator('#main .list .row', { hasText: 'Lunch' }).first().tap();
    await sheet('Edit entry');
    const m0 = await toastMark();
    await tap('#txn-form [data-action="deleteTxn"]');
    await sheetGone();
    await toast(m0, 'Deleted');
    eq((await txnBy('Lunch')).length, 0, 'Lunch entries after delete');
    eq(await bal('GCash'), 4000, 'GCash after delete');
    const m1 = await toastMark();
    await tap('#toast .toast-action');
    await toast(m1, 'Entry restored');
    const [t] = await txnBy('Lunch');
    eq([t?.id, t?.amount], [S.lunchId, 300], 'Lunch after Undo');
    eq(await bal('GCash'), 3700, 'GCash after Undo');
    S.free = await freeMoves(S.free, 0, 'after delete and Undo');
  }, { needs: ['expense'] });

  await step('Entries · fee on a debt (adjustment)', async () => {
    await tab('debts');
    await tap('#main .segmented [data-action="debtsTab"][data-sub="owe"]');
    await page.locator('#main .card.debt', { hasText: 'BPI Credit Card' }).tap();
    await sheet('BPI Credit Card');
    await tap('#sheet [data-action="feeForm"]');
    await sheet('Fee or interest');
    await page.locator('#txn-form [name=amount]').pressSequentially('150');
    eq(await page.locator('#txn-form [name=reason]').inputValue(), 'fee', 'reason');
    eq(await page.locator('#txn-form [name=direction]').inputValue(), 'up', 'effect');
    await save('Saved');
    eq((await debtOf('BPI Credit Card')).balance, 15650, 'card balance after a ₱150 fee');
    S.free = await freeMoves(S.free, 0, 'after a card fee');
  }, { needs: ['debts'] });

  await step('Entries · card purchase raises the card balance, not a wallet', async () => {
    const walletsBefore = await state(() => window.pitaka.S.totalCash());
    await entry({ amount: 1200, category: 'Shopping', note: 'Shoes', pay: 'BPI Credit Card' });
    has(await text('#txn-form'), "Card purchases are added to that card's balance.", 'hint under Paid with');
    await save('Saved');
    const [t] = await txnBy('Shoes');
    ok(t && t.cardId && !t.accountId, 'Shoes is on the card', t);
    eq((await debtOf('BPI Credit Card')).balance, 16850, 'card balance');
    eq(await state(() => window.pitaka.S.totalCash()), walletsBefore, 'money in wallets');
    S.free = await freeMoves(S.free, 0, 'after a card purchase');
  }, { needs: ['debts'] });

  await step('Entries · installments: one payment that covers two', async () => {
    const before = await debtOf('Phone');
    await entry({ kind: 'debt', debt: { icon: S.phoneType === 'loan' ? '🏦' : S.phoneType === 'installment' ? '🧾' : '📱', name: 'Phone' }, amount: 4000 });
    await sleep(200);
    eq(await text('#txn-form [name=instOut]'), '2 payments', 'covers (suggested from the amount)');
    const plus2 = await state((d) => window.pitaka.advance(window.pitaka.advance(d, 'monthly'), 'monthly'), before.nextDue);
    const want = await state((d) => `Next due date moves to ${window.pitaka.parseISO(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', ...(window.pitaka.parseISO(d).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}.`, plus2);
    eq(await text('#txn-form [data-inst-hint]'), want, 'hint');
    await tap('#txn-form [data-action="inst"][data-d="1"]');
    eq(await text('#txn-form [name=instOut]'), '3 payments', 'covers after +');
    await tap('#txn-form [data-action="inst"][data-d="-1"]');
    eq(await text('#txn-form [name=instOut]'), '2 payments', 'covers after −');
    await pick('#txn-form [name=accountId]', 'BPI Savings');
    await save('Saved');
    const after = await debtOf('Phone');
    eq([after.balance, after.nextDue], [before.balance - 4000, plus2], 'Phone balance and next due');
    const t = await state(() => window.pitaka.S.db.txns.filter((x) => x.kind === 'debt').at(-1));
    eq(t.installments, 2, 'payment covers');
    S.free = await freeMoves(S.free, -4000, 'after paying ahead');
  }, { needs: ['debtpay'] });

  await step('Entries · a note that looks like a spreadsheet formula', async () => {
    await entry({ amount: 10, category: 'Other', note: '=1+1', pay: 'Cash' });
    await save('Saved');
    eq((await txnBy('=1+1')).length, 1, 'entries with that note');
    S.free = await freeMoves(S.free, -10, 'after ₱10 from Cash');
  }, { needs: ['wallets'] });

  await step('Entries · fix a wallet balance, then Undo', async () => {
    await tab('home');
    await page.locator('#main .wallets .wallet', { hasText: 'GoTyme' }).tap();
    await sheet('GoTyme');
    await tap('#sheet [data-action="walletForm"][data-focus="balance"]');
    await sheet('Edit wallet');
    await page.locator('#wallet-form [name=balance]').fill('1,250');
    const m0 = await toastMark();
    await tap('#wallet-form button[type=submit]');
    await sheet('GoTyme');
    const t = await toast(m0, 'Balance fixed');
    has(t, '+₱250 recorded as a balance fix', 'toast');
    eq(await bal('GoTyme'), 1250, 'GoTyme after the fix');
    const fix = await state(() => window.pitaka.S.db.txns.filter((x) => x.kind === 'adjust' && x.accountId).map((x) => [x.amount, x.direction, x.reason]));
    eq(fix, [[250, 'up', 'correction']], 'balance fix entries');
    const m1 = await toastMark();
    await tap('#toast .toast-action');
    await toast(m1, 'Entry removed');
    eq(await bal('GoTyme'), 1000, 'GoTyme after Undo');
    await closeSheet();
    S.free = await freeMoves(S.free, 0, 'after a balance fix and its Undo');
  }, { needs: ['wallets'] });

  // ---------------------------------------------------------------- Home: budgets, bills, subscriptions
  await step('Home · budget at 75% shows "on track"', async () => {
    await tab('plan');
    await tap('#main [data-action="planTab"][data-sub="budgets"]');
    await page.locator('#main .row', { hasText: 'Food' }).first().tap();
    await sheet('Edit category');
    await page.locator('#cat-form [name=limit]').fill('400');
    await tap('#cat-form button[type=submit]');
    await sheetGone();
    eq(await state(() => window.pitaka.S.db.categories.find((c) => c.name === 'Food').limit), 400, 'Food limit');
    await tab('home');
    has(await text('#main'), 'Your budget is on track', 'Home budgets');
    ok(!(await text('#main')).includes('Budgets to watch'), 'no "Budgets to watch" under 80%', await text('#main'));
  }, { needs: ['expense'] });

  await step('Home · budget at 80% or more is shown to watch', async () => {
    await entry({ amount: 50, category: 'Food', note: 'Kape', pay: 'GCash' });
    const t = await save('Saved');
    has(t, 'Food: ₱50 left this pay period', 'budget warning in the toast');
    await tab('home');
    const sec = page.locator('#main section', { hasText: 'Budgets to watch' });
    ok(await sec.count(), 'a "Budgets to watch" section', await text('#main'));
    has(await sec.innerText(), 'Food', 'budgets to watch');
    has(await sec.innerText(), '₱350', 'Food spent');
    ok(await sec.locator('.progress.warning').count(), 'Food bar is in the warning colour', await sec.innerHTML());
    S.free = await freeMoves(S.free, -50, 'after ₱50 more on Food');
  }, { needs: ['expense'] });

  await step('Home · a bill due before payday, then "Paid" moves its due date', async () => {
    S.billDue = await iso(2);
    await tab('plan');
    await tap('#main [data-action="planTab"][data-sub="bills"]');
    await tap('#main [data-action="billForm"]');
    await sheet('New bill');
    await page.locator('#bill-form [name=name]').fill('Meralco');
    await page.locator('#bill-form [name=amount]').fill('2500');
    await page.locator('#bill-form [name=nextDue]').fill(S.billDue);
    await pick('#bill-form [name=categoryId]', '💡 Bills');
    const m0 = await toastMark();
    await tap('#bill-form button[type=submit]');
    await sheetGone();
    await toast(m0, 'Bill added');
    S.free = await freeMoves(S.free, -2500, 'after adding a ₱2,500 bill due before payday');
    const row = page.locator('#main section', { has: page.locator('h2:text-is("Due before payday")') }).locator('.row', { hasText: 'Meralco' });
    ok(await row.count(), 'Meralco under "Due before payday"', await text('#main'));
    const gBefore = await bal('GCash');
    const m1 = await toastMark();
    await row.locator('[data-action="markPaid"]').tap();
    const t = await toast(m1, 'Meralco paid');
    has(t, '₱2,500 from GCash', 'paid from');
    const b = await state(() => window.pitaka.S.db.bills.find((x) => x.name === 'Meralco'));
    eq(b.nextDue, await state((d) => window.pitaka.advance(d, 'monthly'), S.billDue), 'Meralco next due');
    eq(await bal('GCash'), gBefore - 2500, 'GCash after paying the bill');
    S.free = await freeMoves(S.free, 0, 'after paying the bill');
    const due = page.locator('#main section', { has: page.locator('h2:text-is("Due before payday")') });
    ok(!(await due.locator('.row', { hasText: 'Meralco' }).count()), 'Meralco no longer due before payday', await due.innerText().catch(() => '(no section)'));
  }, { needs: ['wallets'] });

  await step('Home · repeated Netflix charges suggest a subscription bill', async () => {
    await entry({ amount: 549, category: 'Subscriptions', note: 'Netflix', pay: 'GCash', date: await iso(-31) });
    await save('Saved');
    await entry({ amount: 549, category: 'Subscriptions', note: 'Netflix', pay: 'GCash' });
    await save('Saved');
    S.free = await freeMoves(S.free, -549, 'after this month\'s Netflix');
    const sec = page.locator('#main section', { hasText: 'Looks like a subscription' });
    ok(await sec.count(), 'a subscription suggestion on Home', await text('#main'));
    has(await sec.innerText(), 'Netflix', 'suggestion');
    has(await sec.innerText(), '₱549', 'suggestion amount');
    const m0 = await toastMark();
    await sec.locator('[data-action="addSubBill"]').tap();
    await toast(m0, 'Netflix added to your bills');
    const b = await state(() => window.pitaka.S.db.bills.find((x) => x.name === 'Netflix'));
    ok(b && b.amount === 549 && b.frequency === 'monthly', 'Netflix bill', b);
    ok(!(await page.locator('#main section', { hasText: 'Looks like a subscription' }).count()), 'suggestion gone', await text('#main'));
  }, { needs: ['wallets'] });

  await step('Home · a savings goal sets money aside until it is deposited', async () => {
    await tab('plan');
    await tap('#main [data-action="planTab"][data-sub="goals"]');
    await tap('#main [data-action="goalForm"]');
    await sheet('New goal');
    await page.locator('#goal-form [name=name]').fill('Japan trip');
    await page.locator('#goal-form [name=target]').fill('30000');
    await page.locator('#goal-form [name=deadline]').fill(await iso(120));
    const m0 = await toastMark();
    await tap('#goal-form button[type=submit]');
    await sheetGone();
    await toast(m0, 'Goal added');
    const plan = await state(() => { const S = window.pitaka.S; return S.goalPlan(S.db.goals.find((g) => g.name === 'Japan trip')); });
    ok(plan.perPayday > 0 && plan.setAsideNow === plan.perPayday, 'a per-payday amount to set aside', plan);
    S.free = await freeMoves(S.free, -plan.setAsideNow, 'after adding a goal');
    has(await text('#main .hero.spend'), `Set aside ₱${plan.setAsideNow.toLocaleString('en-PH')}`, 'hero');
    await page.locator('#main .row', { hasText: 'Japan trip' }).first().tap();
    await sheet('Japan trip');
    await tap('#sheet [data-action="goalMoney"]:not([data-w])');
    await sheet('Savings');
    await page.locator('#txn-form [name=amount]').pressSequentially(String(plan.perPayday));
    await pick('#txn-form [name=accountId]', 'BPI Savings');
    const bpi = await bal('BPI Savings');
    await save('Saved');
    eq(await state(() => window.pitaka.S.db.goals.find((g) => g.name === 'Japan trip').saved), plan.perPayday, 'saved in the goal');
    eq(await bal('BPI Savings'), bpi - plan.perPayday, 'BPI Savings');
    S.free = await freeMoves(S.free, 0, 'after putting this payday\'s amount in the goal');
  }, { needs: ['wallets'] });

  // ---------------------------------------------------------------- money owed to you
  await step('Receivables · lend ₱1,500 to Mel', async () => {
    await tab('debts');
    await tap('#main .segmented [data-action="debtsTab"][data-sub="owed"]');
    has(await text('#main'), 'Nobody owes you', 'empty state');
    await tap('#main [data-action="lendForm"]');
    await sheet('Lend money');
    await page.locator('#txn-form [name=amount]').pressSequentially('1500');
    await page.locator('#txn-form [name=person]').fill('Mel');
    await pick('#txn-form [name=accountId]', 'BPI Savings');
    const bpi = await bal('BPI Savings');
    await save('Saved');
    const r = await state(() => window.pitaka.S.db.receivables.find((x) => x.name === 'Mel'));
    eq(r?.balance, 1500, 'Mel owes');
    eq(await bal('BPI Savings'), bpi - 1500, 'BPI Savings');
    await settle();
    has(await text('#main .debts-hero'), 'Owed to you ₱1,500', 'Owed to you total');
  }, { id: 'lend', needs: ['wallets'] });

  await step('Receivables · Mel pays back ₱600 into Cash', async () => {
    await page.locator('#main .row', { hasText: 'Mel' }).first().tap();
    await sheet('Mel');
    await tap('#sheet [data-action="collectForm"]');
    await sheet('Got paid back');
    eq(await page.locator('#txn-form [name=amount]').inputValue(), '1,500', 'amount filled in with what Mel owes');
    await page.locator('#txn-form [name=amount]').fill('600');
    await pick('#txn-form [name=accountId]', 'Cash');
    const cash = await bal('Cash');
    await save('Saved');
    eq(await state(() => window.pitaka.S.db.receivables.find((x) => x.name === 'Mel').balance), 900, 'Mel owes');
    eq(await bal('Cash'), cash + 600, 'Cash');
    await settle();
    has(await text('#main .debts-hero'), 'Owed to you ₱900', 'Owed to you total');
    has(await text('#main .row:has-text("Mel")'), '₱600 of ₱1,500 paid back', 'Mel row');
  }, { needs: ['lend'] });

  // ---------------------------------------------------------------- categories
  const openCat = async (name) => {
    await settings();
    await tap('#sheet [data-action="catManager"]');
    await sheet('Categories');
    await page.locator('#sheet .row', { has: page.locator(`.title:text-is("${name}")`) }).tap();
    await sheet('Edit category');
  };
  await step('Categories · rename and change the emoji', async () => {
    await openCat('Fun');
    await page.locator('#cat-form [name=name]').fill('Gimik');
    await tap('#cat-form [data-action="pickEmoji"][data-e="🍺"]');
    eq(await page.locator('#cat-form [name=emoji]').inputValue(), '🍺', 'emoji field');
    await tap('#cat-form button[type=submit]');
    await sheetGone();
    const c = await state(() => window.pitaka.S.db.categories.find((x) => x.key === 'fun'));
    eq([c?.name, c?.emoji], ['Gimik', '🍺'], 'category');
  });
  await step('Categories · reorder', async () => {
    await settings();
    await tap('#sheet [data-action="catManager"]');
    await sheet('Categories');
    await tap('#sheet [data-action="catManager"][data-reorder="1"]');
    const before = await state(() => window.pitaka.S.db.categories.map((c) => c.name));
    await tap('#sheet [aria-label="Move Gimik up"]');
    await sleep(200);
    const after = await state(() => window.pitaka.S.db.categories.map((c) => c.name));
    eq(after.indexOf('Gimik'), before.indexOf('Gimik') - 1, 'Gimik position');
    eq(await state(() => [...document.querySelectorAll('#sheet .row .title')].map((e) => e.textContent)), after, 'order on screen');
  });
  await step('Categories · hide one (gone from the entry form)', async () => {
    await openCat('Health');
    await page.locator('#cat-form label.switch-row').tap();
    ok(await page.locator('#cat-form [name=hidden]').isChecked(), 'hide switch on', 'off');
    await tap('#cat-form button[type=submit]');
    await sheetGone();
    eq(await state(() => window.pitaka.S.db.categories.find((x) => x.name === 'Health')?.hidden), true, 'Health hidden');
    await tap('.fab');
    await sheet('Add expense');
    const cats = await state(() => [...document.querySelectorAll('#txn-form .cat-opt small')].map((e) => e.textContent));
    ok(!cats.includes('Health') && cats.includes('Food'), 'entry form categories without Health', cats);
    await closeSheet();
  });
  await step('Categories · merge Shopping into Other (its entries move)', async () => {
    const ids = await state(() => Object.fromEntries(window.pitaka.S.db.categories.map((c) => [c.name, c.id])));
    const moving = await state((id) => window.pitaka.S.db.txns.filter((t) => t.categoryId === id).map((t) => t.id), ids.Shopping);
    ok(moving.length >= 1, 'Shopping has entries', moving);
    await openCat('Shopping');
    await pick('#cat-form [name=intoId]', '📦 Other');
    const m0 = await toastMark();
    await tap('#cat-form [data-action="catMerge"]');
    const t = await toast(m0, 'Merged into Other');
    has(t, `${moving.length} entr${moving.length === 1 ? 'y' : 'ies'} moved`, 'merge toast');
    ok(dialogs.at(-1)?.startsWith('Merge Shopping into Other?'), 'asked first', dialogs.at(-1));
    const now = await state((list) => list.map((id) => window.pitaka.S.txn(id)?.categoryId), moving);
    eq(now, moving.map(() => ids.Other), 'categories of the moved entries');
    eq(await state(() => window.pitaka.S.db.categories.some((c) => c.name === 'Shopping')), false, 'Shopping still there');
    await closeSheet();
  });

  // ---------------------------------------------------------------- the relay
  const otherFetch = () => state(async (host) => {
    const v = [];
    const onV = (e) => v.push(`${e.violatedDirective} ${e.blockedURI}`);
    document.addEventListener('securitypolicyviolation', onV);
    let r;
    try { r = await fetch(`https://${host}/ping`).then((x) => `reached ${x.status}`); } catch (e) { r = `blocked (${e.name})`; }
    await new Promise((res) => setTimeout(res, 150));
    document.removeEventListener('securitypolicyviolation', onV);
    return { r, v };
  }, OTHER_HOST);
  await step('Relay · before pairing, any *.workers.dev address is allowed', async () => {
    if (relayError) throw new Mismatch('local relay', 'running', relayError);
    const r = await otherFetch();
    eq(r.r, 'reached 200', `fetch https://${OTHER_HOST}`);
  }, { id: 'relayup', allow: [/someone-else/] });
  await step('Relay · pair through the form (wrong secret first)', async () => {
    await settings();
    await tap('#sheet [data-action="relaySheet"]');
    await sheet('Inbox relay');
    await page.locator('#relay-form [name=url]').fill(RELAY_HOST);
    await page.locator('#relay-form [name=secret]').fill('not-the-secret-000000');
    await tap('#relay-form button[type=submit]');
    await until(() => !!document.querySelector('#relay-form .form-err:not([hidden])'), null, 'pairing error', 'shown', () => document.querySelector('#sheet')?.innerText.slice(0, 200));
    has(await text('#relay-form .form-err'), "That setup secret isn't the one in Cloudflare (ADMIN_SECRET).", 'error for a wrong secret');
    await page.locator('#relay-form [name=secret]').fill(ADMIN_SECRET);
    const m0 = await toastMark();
    await tap('#relay-form button[type=submit]');
    await toast(m0, 'Paired with your relay', 10000);
    await until(() => !!document.querySelector('#write-token'), null, 'paired sheet', 'write token shown', () => document.querySelector('#sheet')?.innerText.slice(0, 200));
    S.write = await text('#write-token');
    ok(/^[\w-]{43}$/.test(S.write), 'write token shown in full after pairing', S.write);
    has(await text('#sheet'), `Paired with your relay ${RELAY_HOST}`, 'paired sheet');
    eq(await state(() => window.pitaka.S.db.settings.relayUrl), `https://${RELAY_HOST}`, 'relay address saved');
    await closeSheet();
  }, { id: 'pair', needs: ['relayup'], allow: [/status of 401/] });
  await step('Relay · the CSP narrows to the paired relay and blocks other hosts', async () => {
    eq(await state(() => document.querySelector('meta[data-relay-csp]')?.content), `connect-src 'self' https://${RELAY_HOST}`, 'second policy');
    const r = await otherFetch();
    ok(r.r.startsWith('blocked'), `fetch https://${OTHER_HOST} blocked`, r);
    ok(r.v.some((x) => x.startsWith('connect-src') && x.includes(OTHER_HOST)), 'a connect-src violation was reported', r.v);
    const mine = await state((h) => fetch(`https://${h}/`).then((x) => x.json()).then((j) => j.service).catch((e) => e.message), RELAY_HOST);
    eq(mine, 'pitaka-relay', 'the paired relay still answers');
  }, { needs: ['pair'], allow: [/someone-else|Content Security Policy|connect-src/] });
  await step('Relay · a Quick Add POST like the shortcut\'s, then Check now', async () => {
    const r = await shortcutPost(S.write, { type: 'entry', id: cid('kp'), amount: '150', category: '🍜 Food', wallet: 'GCash' });
    eq(r.status, 200, 'relay answer to the shortcut');
    const m0 = await relayCheck();
    const t = await toast(m0, '1 new entry from Quick Add', 10000);
    has(t, '1 new entry from Quick Add ₱150 · Food · GCash saved', 'toast');
    const e = await state(() => window.pitaka.S.db.txns.filter((x) => x.src === 'quick' && x.amount === 150));
    eq(e.length, 1, 'Quick Add entries');
    await closeSheet();
  }, { needs: ['pair'] });
  await step('Relay · "lent mel 500" by quick text is collected on reload', async () => {
    const mel = await state(() => window.pitaka.S.db.receivables.find((x) => x.name === 'Mel')?.balance);
    const r = await shortcutPost(S.write, { type: 'text', id: cid('qt'), text: 'lent mel 500' });
    eq(r.status, 200, 'relay answer');
    await page.reload(); // the toast log starts again with the page
    await ready();
    ok(await state(() => !document.querySelector('#lock').hidden), 'the PIN screen comes first', 'no lock');
    await unlock();
    const t = await toast(0, '1 new entry from Quick Add', 10000);
    has(t, '₱500 · Lent', 'toast');
    eq(await state(() => window.pitaka.S.db.receivables.find((x) => x.name === 'Mel')?.balance), mel + 500, 'Mel owes');
    eq(await state(() => document.querySelector('meta[data-relay-csp]')?.content), `connect-src 'self' https://${RELAY_HOST}`, 'narrowed CSP after reload');
    await tab('debts');
    await tap('#main .segmented [data-action="debtsTab"][data-sub="owed"]');
    await settle();
    has(await text('#main .debts-hero'), `Owed to you ₱${(mel + 500).toLocaleString('en-PH')}`, 'Owed to you total');
  }, { needs: ['pair', 'lend'] });
  await step('Relay · Send a test', async () => {
    await settings();
    await tap('#sheet [data-action="relaySheet"]');
    await sheet('Inbox relay');
    const m0 = await toastMark();
    await tap('#sheet [data-action="relayTest"]');
    const t = await toast(m0, 'Test received', 10000);
    has(t, 'Your shortcut reached Pitaka through the relay.', 'toast');
  }, { needs: ['pair'] });
  await step('Relay · make a new write token (the old one stops working)', async () => {
    const old = S.write;
    await sheet('Inbox relay');
    const m0 = await toastMark();
    await tap('#sheet [data-action="relayRotate"]');
    await toast(m0, 'New write token made', 10000);
    ok(dialogs.at(-1)?.startsWith('Make a new write token?'), 'asked first', dialogs.at(-1));
    S.write = await text('#write-token');
    ok(/^[\w-]{43}$/.test(S.write) && S.write !== old, 'a new token is shown', S.write);
    eq((await shortcutPost(old, { type: 'test', id: cid('t'), source: 'e2e' })).status, 401, 'relay answer to the old token');
    eq((await shortcutPost(S.write, { type: 'test', id: cid('t'), source: 'e2e' })).status, 200, 'relay answer to the new token');
    const m1 = await toastMark();
    await tap('#sheet [data-action="relayCheck"]');
    await toast(m1, 'Test received', 10000);
    await closeSheet();
  }, { id: 'rotate', needs: ['pair'] });

  await step('Relay · Undo in the toast puts a collected item back in Review', async () => {
    eq((await shortcutPost(S.write, { type: 'entry', id: cid('kp'), amount: '95', category: '🚕 Transport', wallet: 'Cash', note: 'Undo me' })).status, 200, 'relay answer');
    const m0 = await relayCheck();
    await toast(m0, '1 new entry from Quick Add', 10000);
    eq((await txnBy('Undo me')).length, 1, 'entry collected');
    const m1 = await toastMark();
    await tap('#toast .toast-action');
    await toast(m1, 'Undone. The items are in Review.');
    eq((await txnBy('Undo me')).length, 0, 'entry after Undo');
    eq((await review()).map((x) => [x.amount, x.reason]), [[95, 'undone']], 'Review');
    await closeSheet();
    await tab('home');
    await tap('#topbar [data-tab="review"]');
    const m2 = await toastMark();
    await card('₱95').locator('[data-action="reviewIgnore"]').tap();
    await toast(m2, 'Ignored');
  }, { needs: ['rotate'] });

  // ---------------------------------------------------------------- Review
  const gcash = (amount) => `GCash: Your payment of PHP ${amount} was successful. Thank you for using GCash.`;
  await step('Review · alerts arrive: one is added on its own, the rest wait', async () => {
    // Two entries you typed with the same amount an alert will report.
    await entry({ amount: 75, category: 'Food', note: 'Coffee', pay: 'GCash' });
    await save('Saved');
    await entry({ amount: 75, category: 'Food', note: 'Snack', pay: 'GCash' });
    await save('Saved');
    const day = await state(() => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`; });
    const sms = [
      gcash('64.00'), gcash('52.00'), gcash('75.00'), gcash('41.00'), gcash('31.00'), gcash('32.00'), gcash('33.00'),
      `You have sent PHP 700.00 of GCash to JUAN DELA CRUZ 09171234567 on ${day}. Ref. No. 5555555555555.`,
      'You have paid PHP 289.00 to JOLLIBEE FOODS CORP. Ref No. 9876543210123.',
    ];
    for (const t of sms) eq((await shortcutPost(S.write, { type: 'sms', id: cid('sms'), sender: 'GCash', text: t })).status, 200, 'relay answer');
    eq((await shortcutPost(S.write, { type: 'sms', id: cid('sms'), sender: 'MyBank', text: 'MyBank: Purchase 1,234.50 at SM SUPERMARKET on 10/19. Thank you.' })).status, 200, 'relay answer');
    const m0 = await relayCheck();
    const t = await toast(m0, '1 new entry from SMS', 10000);
    has(t, '₱289 · Food · GCash saved', 'toast');
    has(t, '9 to review', 'toast');
    await closeSheet();
    await tab('home');
    has(await text('#main .review-nudge'), '9 to review', 'Home review card');
    await tap('#main .review-nudge');
    await until(() => document.querySelector('#main h1')?.textContent === 'Review', null, 'screen', 'Review', () => document.querySelector('#main h1')?.textContent);
    has(await text('#main .top'), '9 waiting for you', 'Review header');
    const p = await review();
    const reasons = Object.fromEntries(p.map((x) => [x.amount ?? 'none', x.reason]));
    eq(reasons, { 64: 'unsure', 52: 'unsure', 75: 'duplicate', 41: 'unsure', 31: 'unsure', 32: 'unsure', 33: 'unsure', 700: 'sent', none: 'unparsed' }, 'why each item waits');
  }, { id: 'review', needs: ['rotate'] });
  await step('Review · Accept', async () => {
    const m0 = await toastMark();
    await card('₱64').locator('[data-action="reviewAccept"]').tap();
    await toast(m0, 'Added');
    const t = await state(() => { const S = window.pitaka.S; const t = S.db.txns.find((x) => x.amount === 64); return t && { kind: t.kind, src: t.src, wallet: S.account(t.accountId)?.name }; });
    eq(t, { kind: 'expense', src: 'sms', wallet: 'GCash' }, 'entry from the SMS');
    ok(!(await card('₱64').count()), 'item left Review', await text('#main'));
  }, { needs: ['review'] });
  await step('Review · Edit before adding', async () => {
    await card('₱52').locator('[data-action="reviewEdit"]').tap();
    await sheet('Add expense');
    eq(await page.locator('#txn-form [name=amount]').inputValue(), '52', 'amount from the SMS');
    await page.locator('#txn-form label.cat-opt', { has: page.locator('small:text-is("Transport")') }).tap();
    await page.locator('#txn-form [name=note]').fill('Jeep');
    await save('Saved');
    const [t] = await txnBy('Jeep');
    ok(t && t.amount === 52 && t.categoryId === (await state(() => window.pitaka.S.db.categories.find((c) => c.name === 'Transport').id)), 'edited entry', t);
    const it = await state((id) => window.pitaka.S.db.inbox.find((x) => x.result?.txnId === id)?.status, t.id);
    eq(it, 'done', 'item settled by the edited entry');
  }, { needs: ['review'] });
  await step('Review · Link to an entry you already typed', async () => {
    const c = card('₱75');
    has(await c.innerText(), 'Possible duplicate', 'chip');
    await c.locator('[data-action="reviewLink"]').tap();
    await sheet('Which entry is it?');
    const rows = await state(() => [...document.querySelectorAll('#sheet .row .title')].map((e) => e.textContent));
    ok(rows.includes('Coffee') && rows.includes('Snack'), 'both ₱75 entries offered', rows);
    const m0 = await toastMark();
    await page.locator('#sheet .row', { hasText: 'Coffee' }).tap();
    await toast(m0, 'Linked to your entry');
    const [coffee] = await txnBy('Coffee');
    ok((coffee.conf || []).some((x) => x.via === 'sms'), 'Coffee is confirmed by the SMS', coffee);
    eq(await state(() => window.pitaka.S.db.txns.filter((x) => x.amount === 75).length), 2, '₱75 entries (none added)');
  }, { needs: ['review'] });
  await step('Review · Mark as a transfer', async () => {
    const c = card('₱700');
    has(await c.innerText(), 'Sent money', 'chip');
    await c.locator('[data-action="reviewTransfer"]').tap();
    await sheet('Went to which wallet?');
    const m0 = await toastMark();
    await page.locator('#sheet .row', { hasText: 'BPI Savings' }).tap();
    await toast(m0, 'Saved as a transfer');
    const t = await state(() => { const S = window.pitaka.S; const t = S.db.txns.find((x) => x.amount === 700); return t && { kind: t.kind, from: S.account(t.accountId)?.name, to: S.account(t.toAccountId)?.name }; });
    eq(t, { kind: 'transfer', from: 'GCash', to: 'BPI Savings' }, 'entry');
  }, { needs: ['review'] });
  await step('Review · Teach a format', async () => {
    const c = card('MyBank');
    has(await c.innerText(), 'Unknown format', 'chip');
    await c.locator('[data-action="reviewTeach"]').tap();
    await sheet('Teach this format');
    await page.locator('#tok-text .tok', { hasText: '1,234.50' }).tap();
    await page.locator('#sheet label', { has: page.locator('input[value="merchant"]') }).tap();
    await page.locator('#tok-text .tok', { hasText: /^SM$/ }).tap();
    await page.locator('#tok-text .tok', { hasText: 'SUPERMARKET' }).tap();
    eq(await text('#teach-preview'), 'Reads ₱1,234.50 · SM SUPERMARKET', 'preview');
    await pick('#teach-form [name=target]', 'GoTyme');
    const m0 = await toastMark();
    await tap('#teach-form button[type=submit]');
    await sheetGone();
    const t = await toast(m0, 'Format saved');
    has(t, '1 of 1 waiting item read', 'toast');
    const e = await state(() => { const S = window.pitaka.S; const t = S.db.txns.find((x) => x.amount === 1234.5); return t && { kind: t.kind, wallet: S.account(t.accountId)?.name, merchant: t.merchant }; });
    eq(e, { kind: 'expense', wallet: 'GoTyme', merchant: 'SM SUPERMARKET' }, 'entry from the taught message');
  }, { id: 'teach', needs: ['review'] });
  await step('Review · the next message in that format is read automatically', async () => {
    eq((await shortcutPost(S.write, { type: 'sms', id: cid('sms'), sender: 'MyBank', text: 'MyBank: Purchase 99.00 at 7-ELEVEN on 10/20. Thank you.' })).status, 200, 'relay answer');
    const m0 = await relayCheck();
    const t = await toast(m0, '1 new entry from SMS', 10000);
    has(t, 'GoTyme saved', 'toast');
    await closeSheet();
    const e = await state(() => { const S = window.pitaka.S; const t = S.db.txns.find((x) => x.amount === 99); const it = t && S.db.inbox.find((x) => x.result?.txnId === t.id); return t && { wallet: S.account(t.accountId)?.name, merchant: t.merchant, status: it?.status, parser: it?.parsed?.parser }; });
    eq(e, { wallet: 'GoTyme', merchant: '7-ELEVEN', status: 'auto', parser: 'template' }, 'entry');
  }, { needs: ['teach'] });
  await step('Review · Ignore', async () => {
    await tab('home');
    await tap('#topbar [data-tab="review"]');
    const m0 = await toastMark();
    await card('₱41').locator('[data-action="reviewIgnore"]').tap();
    await toast(m0, 'Ignored');
    eq(await state(() => window.pitaka.S.db.inbox.find((x) => x.parsed?.amount === 41)?.status), 'ignored', 'item');
    eq(await state(() => window.pitaka.S.db.txns.some((x) => x.amount === 41)), false, 'an entry was added');
  }, { needs: ['review'] });
  await step('Review · select several: Accept, then Ignore the rest', async () => {
    await tap('#topbar [data-action="reviewSelect"]');
    await page.locator('#main .review-card', { hasText: '₱31' }).locator('[data-review-select]').tap();
    await page.locator('#main .review-card', { hasText: '₱32' }).locator('[data-review-select]').tap();
    has(await text('#main .select-bar'), '2 selected', 'select bar');
    const m0 = await toastMark();
    await tap('#main .select-bar [data-action="reviewAcceptMany"]');
    await toast(m0, 'Accepted 2');
    eq(await state(() => [31, 32].map((a) => window.pitaka.S.db.txns.some((x) => x.amount === a))), [true, true], 'entries for ₱31 and ₱32');
    const left = (await review()).length;
    await tap('#topbar [data-action="reviewSelect"]');
    await tap('#main .select-bar [data-action="reviewSelectAll"]');
    const m1 = await toastMark();
    await tap('#main .select-bar [data-action="reviewIgnoreMany"]');
    await toast(m1, `Ignored ${left}`);
    eq((await review()).length, 0, 'items left in Review');
    has(await text('#main'), 'Nothing to review', 'Review screen');
  }, { needs: ['review'] });
  await step('Review · Undo something added on its own', async () => {
    const row = page.locator('#main section', { hasText: 'Added on their own' }).locator('.row', { hasText: 'JOLLIBEE' });
    ok(await row.count(), 'the ₱289 Jollibee entry under "Added on their own"', await text('#main'));
    const m0 = await toastMark();
    await row.locator('[data-action="reviewUndo"]').tap();
    await toast(m0, 'Undone. It is back in Review.');
    eq(await state(() => window.pitaka.S.db.txns.some((x) => x.amount === 289)), false, 'the ₱289 entry is still there');
    const it = await review();
    eq(it.map((x) => [x.amount, x.reason]), [[289, 'undone']], 'Review');
    const m1 = await toastMark();
    await card('₱289').locator('[data-action="reviewIgnore"]').tap();
    await toast(m1, 'Ignored');
  }, { needs: ['review'] });

  await step('Security · typed, relay and alert text shows as text, never as markup', async () => {
    const evil = (n) => `<img src=x onerror="window.__xss=${n}">`;
    await entry({ amount: 11, category: 'Other', note: `${evil(1)}typed`, pay: 'Cash' });
    await save('Saved');
    eq((await shortcutPost(S.write, { type: 'entry', id: cid('kp'), amount: '12', category: '📦 Other', wallet: 'Cash', note: `${evil(2)}relay` })).status, 200, 'relay answer');
    eq((await shortcutPost(S.write, { type: 'sms', id: cid('sms'), sender: 'GCash', text: `Your payment of PHP 13.00 to ${evil(3)}SHOP was successful.` })).status, 200, 'relay answer');
    eq((await shortcutPost(S.write, { type: 'sms', id: cid('sms'), sender: `<b>Bank</b>${evil(4)}`, text: `${evil(5)} hello, no amount here` })).status, 200, 'relay answer');
    const m0 = await relayCheck();
    await toast(m0, '2 new entries from', 10000);
    await closeSheet();
    const check = async (where) => {
      const r = await state(() => ({ xss: window.__xss, imgs: document.querySelectorAll('img[src="x"], [onerror]').length + [...document.querySelectorAll('b')].filter((b) => b.textContent === 'Bank').length, text: document.querySelector('#main').innerText }));
      eq(r.xss, undefined, `script ran from text on ${where}`);
      eq(r.imgs, 0, `elements made from text on ${where}`);
      return r.text;
    };
    has(await (async () => { await tab('home'); return check('Home'); })(), '<img src=x onerror="window.__xss=1">typed', 'Home shows the typed note as text');
    await tap('#main section:has(h2:text("Recent")) [data-action="tab"][data-tab="activity"]');
    await until(() => document.querySelector('#main h1')?.textContent === 'Activity', null, 'screen', 'Activity', () => document.querySelector('#main h1')?.textContent);
    const act = await check('Activity');
    has(act, 'relay', 'Activity');
    has(act, '<img src=x onerror="window.__xss=2">relay', 'the relay note as text');
    await tab('home');
    await tap('#topbar [data-tab="review"]');
    const rv = await check('Review');
    has(rv, '<img src=x onerror="window.__xss=5"> hello, no amount here', 'the alert text as text');
    has(rv, '<b>Bank</b>', 'the sender as text');
    has(rv, 'SHOP', 'the auto-added alert');
    const m1 = await toastMark();
    await card('hello, no amount').locator('[data-action="reviewIgnore"]').tap();
    await toast(m1, 'Ignored');
  }, { needs: ['rotate'] });

  // ---------------------------------------------------------------- Reports and CSV
  await step('Reports · this month', async () => {
    await tab('reports');
    const want = await state(() => { const S = window.pitaka.S; const k = window.pitaka.toISO(new Date()).slice(0, 7); const s = S.monthSummary(k); return { income: s.income, spent: s.spent, saved: s.saved, debtPaid: s.debtPaid, label: new Date().toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }) }; });
    eq(await text('#main .month-nav b'), want.label, 'month');
    const tiles = await state(() => Object.fromEntries([...document.querySelectorAll('#main .tiles.four .tile')].map((t) => [t.querySelector('.label').textContent, Number(t.querySelector('.num').textContent.replace(/[₱,]/g, ''))])));
    eq(tiles, { Income: Math.round(want.income), Spent: Math.round(want.spent), Saved: Math.round(want.saved), 'Debt paid': Math.round(want.debtPaid) }, 'tiles');
    ok(want.debtPaid >= 6000 && want.income >= 25000, 'the month has the income and debt payments logged', want);
  });
  await step('Reports · pay period', async () => {
    await tap('#main [data-action="reportMode"][data-sub="period"]');
    const want = await state(() => {
      const S = window.pitaka.S; const p = S.periodSummary(); const f = (d) => window.pitaka.parseISO(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
      return { label: `${f(p.start)} – ${f(p.end)}`, income: p.income, spent: p.spent, saved: p.saved, debtPaid: p.debtPaid, lent: p.lent };
    });
    eq(await text('#main .month-nav b'), want.label, 'pay period');
    const tiles = await state(() => Object.fromEntries([...document.querySelectorAll('#main .tiles.four .tile')].map((t) => [t.querySelector('.label').textContent, Number(t.querySelector('.num').textContent.replace(/[₱,]/g, ''))])));
    eq(tiles, { Income: Math.round(want.income), Spent: Math.round(want.spent), Saved: Math.round(want.saved), 'Debt paid': Math.round(want.debtPaid) }, 'tiles');
    ok(want.lent > 0, 'money lent this pay period', want.lent);
    has(await text('#main'), `Lent out ₱${Math.round(want.lent).toLocaleString('en-PH')}`, 'lending line');
    await tap('#main [data-action="period"][data-d="-1"]');
    ok((await text('#main .month-nav b')) !== want.label, 'previous pay period shown', await text('#main .month-nav b'));
    await tap('#main [data-action="period"][data-d="1"]');
    eq(await text('#main .month-nav b'), want.label, 'back to this pay period');
  });
  await step('Reports · CSV export (download, content, formula guard)', async () => {
    await tap('#topbar [data-action="exportSheet"]');
    await sheet('Export CSV');
    await page.locator('#export-form label.check', { has: page.locator('input[value="debts"]') }).tap();
    const files = await download(() => tap('#export-form button[type=submit]'), 2);
    const tx = files.find((f) => f.name.startsWith('pitaka-transactions-'));
    const debts = files.find((f) => f.name.startsWith('pitaka-debts-'));
    ok(tx && debts, 'transactions and debts files', files.map((f) => f.name));
    ok(tx.text.startsWith('﻿Date,Time,Type,Amount,Wallet change,Category'), 'BOM and header row', tx.text.slice(0, 80));
    ok(tx.text.includes('\r\n'), 'CRLF line endings', '');
    const lines = tx.text.split('\r\n');
    const lunch = lines.find((l) => l.includes(',Lunch,'));
    ok(lunch && lunch.includes(',Expense,300,-300,Food,GCash,'), 'the Lunch row', lunch);
    ok(lines.some((l) => l.includes(",'=1+1,")), "the =1+1 note is written as '=1+1", lines.filter((l) => l.includes('=1+1')));
    const cells = lines.flatMap((l) => l.split(','));
    ok(!cells.some((c) => /^["]?[=+@]/.test(c) || /^["]?-[^0-9]/.test(c)), 'no cell starts like a formula', cells.filter((c) => /^["]?[=+@-]/.test(c) && !/^-?[0-9]/.test(c)));
    has(debts.text, 'BPI Credit Card', 'debts file');
    await sheetGone();
  });

  // ---------------------------------------------------------------- statement import
  const pickStatement = async () => {
    await settings();
    await tap('#sheet [data-action="statementSheet"]');
    await sheet('Import a statement');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), tap('#sheet [data-action="stmtFile"]')]);
    await fc.setFiles(path.join(FIX, 'statement-gcash.pdf'));
  };
  await step('Statement · locked GCash PDF: wrong, then right password', async () => {
    await pickStatement();
    await sheet('Statement password');
    await page.locator('#stmt-pw [name=pw]').fill('wrong-password');
    await tap('#stmt-pw button[type=submit]');
    await until(() => !!document.querySelector('#stmt-pw .form-err'), null, 'password error', 'shown', () => document.querySelector('#sheet')?.innerText.slice(0, 300), 15000);
    has(await text('#stmt-pw .form-err'), "That password didn't open it.", 'error');
    await page.locator('#stmt-pw [name=pw]').fill('pitaka1234');
    await tap('#stmt-pw button[type=submit]');
    await until(() => !!document.querySelector('#sheet .stmt-rows'), null, 'rows to check', 'shown', () => document.querySelector('#sheet')?.innerText.slice(0, 300), 15000);
    await sheet('Check the rows');
    has(await text('#sheet .stmt-sum'), 'statement-gcash.pdf · GCash', 'statement for');
    const rows = await state(() => [...document.querySelectorAll('#sheet .stmt-row')].map((r) => r.className.replace('row stmt-row ', '')));
    eq(rows.length, 6, 'rows');
    ok(rows.includes('transfer'), 'the transfer to GoTyme is recognised', rows);
    S.stmtRows = rows;
  }, { id: 'stmt' });
  await step('Statement · import, balance check, Undo', async () => {
    const before = await state(() => window.pitaka.S.db.txns.length);
    const n = S.stmtRows.filter((r) => r === 'new' || r === 'transfer').length;
    eq(await text('#sheet [data-action="stmtImport"]'), `Import ${n} entries`, 'import button');
    const m0 = await toastMark();
    await tap('#sheet [data-action="stmtImport"]');
    await toast(m0, `${n} entries imported`);
    await sheet('Statement balance');
    has(await text('#sheet'), 'Statement, end of', 'balance check');
    has(await text('#sheet'), 'Pitaka, same day', 'balance check');
    eq(await state(() => window.pitaka.S.db.txns.length), before + n, 'entries after import');
    const m1 = await toastMark();
    await tap('#toast .toast-action');
    await toast(m1, 'Import undone');
    eq(await state(() => window.pitaka.S.db.txns.length), before, 'entries after Undo');
    await closeSheet();
  }, { needs: ['stmt'] });
  await step('Statement · import again, then re-import shows "In Pitaka"', async () => {
    await pickStatement();
    await sheet('Statement password');
    await page.locator('#stmt-pw [name=pw]').fill('pitaka1234');
    await tap('#stmt-pw button[type=submit]');
    await until(() => !!document.querySelector('#sheet .stmt-rows'), null, 'rows', 'shown', null, 15000);
    const m0 = await toastMark();
    await tap('#sheet [data-action="stmtImport"]');
    await toast(m0, 'entries imported');
    await closeSheet();
    await pickStatement();
    await sheet('Statement password');
    await page.locator('#stmt-pw [name=pw]').fill('pitaka1234');
    await tap('#stmt-pw button[type=submit]');
    await until(() => !!document.querySelector('#sheet .stmt-rows'), null, 'rows', 'shown', null, 15000);
    const rows = await state(() => [...document.querySelectorAll('#sheet .stmt-row')].map((r) => [r.className.replace('row stmt-row ', ''), r.innerText.includes('In Pitaka')]));
    eq(rows.map((r) => r[0]), S.stmtRows.map(() => 'existing'), 'every row is already in Pitaka');
    ok(rows.every((r) => r[1]), 'each row says "In Pitaka"', rows);
    eq(await text('#sheet [data-action="stmtImport"]'), 'Mark them as on the statement', 'button');
    const dump = await state(async () => {
      const out = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
      for (const { name } of await indexedDB.databases()) {
        const dbx = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const s of dbx.objectStoreNames) out.push(JSON.stringify(await new Promise((res) => { const r = dbx.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); })));
        dbx.close();
      }
      return out.join('\n');
    });
    ok(!dump.includes('pitaka1234'), 'the statement password is stored nowhere', 'found in storage');
    await closeSheet();
  }, { needs: ['stmt'] });

  // ---------------------------------------------------------------- Files catch-up
  const importJsonl = async () => {
    await settings();
    await tap('#sheet [data-action="inboxSettings"]');
    await sheet('Inbox and alerts');
    const m0 = await toastMark();
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), tap('#sheet [data-action="importInbox"]')]);
    await fc.setFiles(path.join(FIX, 'inbox-catchup.jsonl'));
    return m0;
  };
  await step('Files · catch up from inbox.jsonl (a duplicate line is added once)', async () => {
    const lines = readFileSync(path.join(FIX, 'inbox-catchup.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ids = [...new Set(lines.map((l) => l.id))];
    ok(lines.length === 3 && ids.length === 2, 'fixture: three lines, one repeated', lines.map((l) => l.id));
    const m0 = await importJsonl();
    await toast(m0, '2 new entries from Files');
    const got = await state((list) => list.map((c) => window.pitaka.S.db.inbox.filter((x) => x.cid === c).length), ids);
    eq(got, [1, 1], 'inbox items per id');
    eq(await state(() => window.pitaka.S.db.txns.filter((x) => x.note === 'Tricycle' || x.note === 'Jeepney').map((x) => x.note).sort()), ['Jeepney', 'Tricycle'], 'entries');
    const m1 = await importJsonl();
    const t = await toast(m1, 'Nothing new in that file');
    has(t, '3 already in Pitaka', 'toast');
    await closeSheet();
  });

  // ---------------------------------------------------------------- calendar, backup
  await step('Calendar · .ics for one debt and for all due dates', async () => {
    await tab('debts');
    await tap('#main .segmented [data-action="debtsTab"][data-sub="owe"]');
    await page.locator('#main .card.debt', { hasText: 'Phone' }).tap();
    await sheet('Phone');
    const [f] = await download(() => tap('#sheet [data-action="calendar"][data-kind="debt"]'));
    eq(f.name, 'Phone.ics', 'file name');
    const d = await debtOf('Phone');
    for (const part of ['BEGIN:VCALENDAR', 'SUMMARY:Pay Phone (₱2\\,000)', `DTSTART;VALUE=DATE:${d.nextDue.replace(/-/g, '')}`, 'RRULE:FREQ=MONTHLY', 'END:VCALENDAR']) has(f.text, part, 'Phone.ics');
    await settings();
    const [all] = await download(() => tap('#sheet [data-action="calendarAll"]'));
    eq(all.name, 'pitaka-due-dates.ics', 'file name');
    for (const n of ['Phone', 'BPI Credit Card', 'Meralco', 'Netflix']) has(all.text, `SUMMARY:Pay ${n}`, 'pitaka-due-dates.ics');
    await closeSheet();
  });
  await step('Backup · export has no PIN, relay tokens or key', async () => {
    await settings();
    const [f] = await download(() => tap('#sheet [data-action="exportData"]'));
    ok(/^pitaka-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f.name), 'file name', f.name);
    const b = JSON.parse(f.text);
    const sec = await state(async () => { const r = await window.pitaka.S.secrets.get('relay'); return { read: r?.read, write: r?.write }; });
    eq(b.app, 'pitaka', 'app');
    eq(b.txns.length, await state(() => window.pitaka.S.db.txns.length), 'entries in the backup');
    for (const k of ['pinHash', 'pinSalt', 'pinFails', 'pinLockUntil']) ok(!(k in b.settings), `no ${k} in the backup`, b.settings[k]);
    ok(sec.read && sec.write, 'the relay tokens exist on the phone', sec);
    ok(!f.text.includes(sec.read) && !f.text.includes(sec.write), 'no relay token in the backup', 'found');
    ok(!/"d"\s*:|relayKey|privateKey/.test(f.text), 'no private key in the backup', 'found');
    eq(b.settings.relayUrl, `https://${RELAY_HOST}`, 'relay address (to offer pairing again)');
    S.backup = f.file;
    S.backupCount = b.txns.length;
    await closeSheet();
  }, { id: 'backup' });

  // ---------------------------------------------------------------- lock and privacy
  const background = (ms) => state(async (away) => {
    const set = (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set(true);
    const cover = { privacy: document.body.classList.contains('privacy'), main: getComputedStyle(document.querySelector('#main')).visibility };
    window.__e2eAdvance(away);
    await new Promise((r) => setTimeout(r, 50));
    set(false);
    await new Promise((r) => setTimeout(r, 50));
    return { cover, privacyAfter: document.body.classList.contains('privacy'), lock: !document.querySelector('#lock').hidden };
  }, ms);
  await step('Security · a short trip to the background: app-switcher cover, no lock', async () => {
    await tab('home');
    const r = await background(5000);
    eq(r.cover, { privacy: true, main: 'hidden' }, 'cover while in the background');
    eq([r.privacyAfter, r.lock], [false, false], 'cover gone and no lock after 5 seconds away');
  }, { needs: ['pin'] });
  await step('Security · over a minute in the background locks; wrong then right PIN', async () => {
    const r = await background(61000);
    eq(r.lock, true, 'locked after 61 seconds away');
    eq(await text('#lock-title'), 'Enter PIN', 'lock title');
    ok(await state(() => document.querySelector('#main').inert), 'the app behind the lock is inert', 'not inert');
    for (const k of '0000') await tap(`#lock [data-k="${k}"]`);
    await until(() => document.querySelector('#lock-err').textContent.includes('Wrong PIN'), null, 'lock error', 'Wrong PIN', () => document.querySelector('#lock-err').textContent);
    await unlock();
    ok(!(await state(() => document.querySelector('#main').inert)), 'the app is usable again', 'inert');
  }, { needs: ['pin'] });

  await step('Security · five wrong PINs make you wait 30 seconds', async () => {
    const r = await background(61000);
    eq(r.lock, true, 'locked after 61 seconds away');
    const wrong = async () => {
      const before = await state(() => window.pitaka.S.db.settings.pinFails || 0);
      for (const k of '2468') await tap(`#lock [data-k="${k}"]`);
      await until((b) => (window.pitaka.S.db.settings.pinFails || 0) === b + 1 && !window.pitaka.Lock.busy, before, 'wrong tries', before + 1, () => window.pitaka.S.db.settings.pinFails);
      return text('#lock-err');
    };
    eq(await wrong(), 'Wrong PIN', 'message after 1 wrong try');
    eq(await wrong(), 'Wrong PIN. 3 more tries before a short wait.', 'message after 2');
    await wrong();
    await wrong();
    eq(await wrong(), 'Too many wrong PINs. Try again in 30 seconds.', 'message after 5');
    ok(await state(() => [...document.querySelectorAll('#lock [data-k]')].every((b) => b.disabled)), 'keypad disabled', 'enabled');
    await state(() => window.__e2eAdvance(31000));
    await until(() => [...document.querySelectorAll('#lock [data-k]')].every((b) => !b.disabled), null, 'keypad', 'enabled after 30 seconds', () => document.querySelector('#lock-err').textContent, 4000);
    await unlock();
    eq(await state(() => window.pitaka.S.db.settings.pinFails), 0, 'wrong tries after unlocking');
  }, { needs: ['pin'] });

  // ---------------------------------------------------------------- theme
  await step('Theme · Dark is kept across a reload, with no flash of the light theme', async () => {
    await settings();
    await tap('#sheet [data-action="setTheme"][data-theme="dark"]');
    eq(await state(() => document.documentElement.getAttribute('data-theme')), 'dark', 'data-theme now');
    await until(() => document.querySelector('#sheet [data-theme="dark"]')?.getAttribute('aria-pressed') === 'true', null, 'Dark button', 'pressed', () => document.querySelector('#sheet [data-theme="dark"]')?.getAttribute('aria-pressed'));
    await page.reload();
    await ready();
    const p = await state(() => window.__e2ePaint);
    eq([p.atBody, p.atFrame], ['dark', 'dark'], 'data-theme when <body> is parsed and at the first frame (system theme is light)');
    eq(p.bgAtFrame, 'rgb(0, 0, 0)', 'background at the first frame');
    await unlock();
    eq(await state(() => window.pitaka.S.db.settings.theme), 'dark', 'saved with the data');
  }, { id: 'dark' });
  await step('Theme · back to System', async () => {
    await settings();
    await tap('#sheet [data-action="setTheme"][data-theme="system"]');
    await page.reload();
    await ready();
    const p = await state(() => window.__e2ePaint);
    eq([p.atBody, p.atFrame], [null, null], 'no data-theme at first paint');
    await unlock();
  }, { needs: ['dark'] });

  // ---------------------------------------------------------------- touch
  const drag = async (dy) => {
    const box = await page.locator('#sheet .grabber-zone').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / 10 }] }); await sleep(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
  await step('Touch · a short drag springs back, a long one dismisses the sheet', async () => {
    await settings();
    await drag(24);
    await sleep(500);
    ok(await state(() => !document.querySelector('#sheet').hidden && document.querySelector('#sheet').classList.contains('open')), 'sheet still open after a 24 px drag', 'closed');
    await drag(260);
    await sheetGone();
  });
  await ctxs.pop().close();

  // ---------------------------------------------------------------- a new phone: restore the backup
  {
    const { ctx } = await phone();
    ctxs.push(ctx);
  }
  await step('Restore · on a new phone, from the welcome screen', async () => {
    await page.goto(`${ORIGIN}/`);
    await ready();
    eq(await text('#onb-h'), 'When is your next payday?', 'onboarding heading');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), tap('#onboard [data-action="importData"]')]);
    const nav = page.waitForEvent('load', { timeout: 15000 });
    await fc.setFiles(S.backup);
    await nav;
    await ready();
    ok(dialogs.at(-1)?.startsWith(`Replace Pitaka's data with this backup (${S.backupCount} entries)?`), 'asked first', dialogs.at(-1));
    await sheet('Backup restored');
    const s = await state(() => ({ txns: window.pitaka.S.db.txns.length, pin: !!window.pitaka.S.db.settings.pinHash, onboarded: window.pitaka.S.db.settings.onboarded, lock: !document.querySelector('#lock').hidden, onboard: !document.querySelector('#onboard').hidden }));
    eq(s, { txns: S.backupCount, pin: false, onboarded: true, lock: false, onboard: false }, 'after restoring');
    has(await text('#sheet'), 'This backup was paired with your relay.', 're-pair offer');
  }, { id: 'restore', needs: ['backup'] });
  await step('Restore · pair again keeping the shortcuts\' write token', async () => {
    await tap('#sheet [data-action="relaySheet"][data-from="restored"]');
    await sheet('Inbox relay');
    eq(await page.locator('#relay-form [name=url]').inputValue(), `https://${RELAY_HOST}`, 'relay address filled in from the backup');
    await page.locator('#relay-form [name=secret]').fill(ADMIN_SECRET);
    await page.locator('#relay-form details summary').tap();
    await page.locator('#relay-form [name=keepWrite]').fill(S.write);
    const m0 = await toastMark();
    await tap('#relay-form button[type=submit]');
    await toast(m0, 'Paired with your relay', 10000);
    eq(await text('#write-token'), S.write, 'write token kept');
    eq((await shortcutPost(S.write, { type: 'entry', id: cid('kp'), amount: '88', category: '🍜 Food', wallet: 'Cash' })).status, 200, 'the old shortcut token still works');
    const m1 = await toastMark();
    await tap('#sheet [data-action="relayCheck"]');
    await toast(m1, '1 new entry from Quick Add', 10000);
  }, { needs: ['restore', 'pair'] });
} catch (e) {
  results.push({ n: ++stepNo, name: 'the run itself', status: 'FAIL', error: e.stack || String(e) });
  console.log(`FAIL  the run stopped: ${e.stack || e}`);
} finally {
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  server.close();
  stopRelay();
  rmSync(relayDir, { recursive: true, force: true });
}

// ============================================================ report
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), counts, results, console: pageErrors }, null, 2));
console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped. Report: ${path.join(OUT, 'report.json')}`);
for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  FAIL ${r.n} ${r.name}: ${r.error}`);
process.exitCode = counts.FAIL || counts.SKIP ? 1 : 0;
