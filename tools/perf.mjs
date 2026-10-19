// How fast Pitaka shows Home, and whether it keeps working offline once installed. Serves this working
// copy on localhost. Needs Playwright and a Chromium (set CHROMIUM=/path/to/chromium if Playwright has none).
//   node tools/perf.mjs [--runs 5] [--cpu 4] [--only speed|offline] [--json results.json]
//
// Speed. For each case, --runs fresh launches on a CPU slowed down --cpu times (CDP CPU throttling, to
// approximate a phone), median shown:
//   Home painted   navigation start to the frame that shows Home's hero (the 'pitaka:first-render' mark
//                  in js/app.js, plus that frame)
//   FCP            First Contentful Paint (the tab bar in index.html usually paints before any module runs)
//   modules        JavaScript files requested before first render, and their size on disk
// Cases: cold = first visit (no service worker, empty caches); warm = installed, the service worker serves
// everything (it is stopped before each launch, as after closing the app). v2 = v2's data in localStorage,
// moved to IndexedDB during the launch; idb = data already in IndexedDB. The fixture's PIN is removed so
// Home is what gets painted.
//
// Offline. After a first visit installs the service worker, the browser goes offline, and Pitaka must still
// open on Home, read a password-protected statement PDF (pdf.js and its worker from the cache), fail the
// relay sync quietly (no banner, no console errors), import from Files, and load every lazy module.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const root = path.resolve(opt('root', repo)) + path.sep; // --root: measure another copy (e.g. an older commit)
const RUNS = Number(opt('runs', 5));
const CPU = Number(opt('cpu', 4));
const ONLY = opt('only', '');
const JSON_OUT = opt('json', '');

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire('/opt/node22/lib/node_modules/')('playwright'); }

// ------------------------------------------------------------------ the site
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.pdf': 'application/pdf' };
// Headers like GitHub Pages: a 10-minute max-age, an ETag and Last-Modified, and 304 on revalidation.
const server = createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!f.startsWith(root) || /[/\\]\.git([/\\]|$)/.test(f) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  const body = readFileSync(f);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const headers = { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', ETag: etag, 'Last-Modified': statSync(f).mtime.toUTCString() };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const ORIGIN = `http://localhost:${server.address().port}`;
const URL0 = `${ORIGIN}/`;
const sizeOf = (pathname) => { try { return statSync(path.join(root, decodeURIComponent(pathname))).size; } catch { return 0; } };

const fixture = JSON.parse(readFileSync(path.join(repo, 'tests/fixtures/v2-data.json'), 'utf8'));
for (const k of ['pinHash', 'pinSalt']) fixture.settings[k] = null;
const RAW = JSON.stringify(fixture);

const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const IPHONE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', timezoneId: 'Asia/Manila', locale: 'en-PH',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
};

// Runs in every page before Pitaka: notes FCP, and the moment the first render is on screen.
function probe() {
  const out = (window.__perf = { fcp: null, mark: null, painted: null, hero: false });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') out.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  } catch { /* no paint timing */ }
  const mark = performance.mark.bind(performance);
  performance.mark = (name, ...rest) => {
    const r = mark(name, ...rest);
    if (name === 'pitaka:first-render' && out.mark === null) {
      out.mark = r.startTime;
      out.hero = !!document.querySelector('#main .hero');
      // rAF runs just before the frame that shows Home is painted; a message posted from it arrives just after.
      // The console message tells tools/perf.mjs without it running anything in the page meanwhile.
      requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { out.painted = performance.now(); console.info('pitaka:painted'); }; ch.port2.postMessage(0); });
    }
    return r;
  };
}

async function newContext(extra = {}) {
  const ctx = await browser.newContext({ ...IPHONE, ...extra });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true })); // "installed"
  await ctx.addInitScript(probe);
  return ctx;
}

// v2's data in localStorage and nothing in IndexedDB, as on the first launch after the update.
async function seedV2(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/sw.js`); // same origin; the service worker leaves this file alone
  await p.evaluate(async (raw) => {
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('pitaka'); r.onsuccess = resolve; r.onerror = () => reject(r.error); });
    localStorage.clear();
    localStorage.setItem('pitaka.data', raw);
  }, RAW);
  await p.close();
}
// Opens Pitaka and waits until Home is on screen.
async function open(ctx, { cpu = 1, stopWorkers = false } = {}) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (stopWorkers) { await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await Promise.all([page.waitForEvent('console', { predicate: (m) => m.text() === 'pitaka:painted', timeout: 30000 }), page.goto(URL0, { waitUntil: 'commit' })]);
  return { page, cdp, errors };
}
// Launches 1 and 2 of the IndexedDB copy: moved, then verified (v2's key removed). Later launches are steady.
async function migrate(ctx) {
  for (let i = 0; i < 2; i++) {
    const { page } = await open(ctx);
    await page.waitForTimeout(600);
    await page.close();
  }
}

async function launch(ctx, opts) {
  const { page, cdp, errors } = await open(ctx, { cpu: CPU, ...opts });
  await page.waitForFunction(() => window.pitaka); // the test hook comes last
  const r = await page.evaluate(() => {
    const P = window.__perf;
    const nav = performance.getEntriesByType('navigation')[0];
    const js = performance.getEntriesByType('resource')
      .filter((e) => /\.m?js$/.test(new URL(e.name).pathname) && e.startTime < P.mark)
      .map((e) => new URL(e.name).pathname);
    return {
      painted: P.painted, mark: P.mark, fcp: P.fcp, hero: P.hero, dcl: nav.domContentLoadedEventStart, workerStart: nav.workerStart,
      viaWorker: nav.workerStart > 0, js, storage: window.pitaka?.S.storageInfo(),
      marks: Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, e.startTime])),
      nav: { workerStart: nav.workerStart, responseStart: nav.responseStart, responseEnd: nav.responseEnd, domInteractive: nav.domInteractive },
      lastModule: Math.max(...performance.getEntriesByType('resource').filter((e) => /\/js\/.*\.js$/.test(e.name) && e.startTime < P.mark).map((e) => e.responseEnd)),
      css: performance.getEntriesByType('resource').find((e) => e.name.endsWith('/app.css'))?.responseEnd,
    };
  });
  r.kb = r.js.reduce((s, f) => s + sizeOf(f), 0) / 1024;
  r.errors = errors;
  await cdp.detach().catch(() => {});
  await page.close();
  return r;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const results = {};

async function speed() {
  const cases = {
    'cold · v2': async () => {
      const ctx = await newContext();
      await seedV2(ctx);
      const r = await launch(ctx);
      await ctx.close();
      return r;
    },
    'cold · idb': async () => {
      const ctx = await newContext();
      await seedV2(ctx);
      await migrate(ctx);
      // Forget the service worker, its caches and the HTTP cache; keep the data.
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' });
      await cdp.send('Network.clearBrowserCache');
      await p.close();
      const r = await launch(ctx);
      await ctx.close();
      return r;
    },
  };
  // Warm: one installed copy per case, launched again and again.
  const warm = {};
  for (const kind of ['v2', 'idb']) {
    const ctx = await newContext();
    const { page } = await open(ctx);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.close();
    await seedV2(ctx);
    if (kind === 'idb') await migrate(ctx);
    warm[kind] = ctx;
    cases[`warm · ${kind}`] = async () => {
      if (kind === 'v2') await seedV2(ctx);
      return launch(ctx, { stopWorkers: true });
    };
  }

  for (const [name, run] of Object.entries(cases)) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await run());
    results[name] = runs;
    const warmCase = name.startsWith('warm');
    for (const r of runs) {
      if (!r.hero) fail(`${name}: Home's hero wasn't in the first render`);
      if (warmCase !== r.viaWorker) fail(`${name}: ${warmCase ? 'not served by' : 'already under'} the service worker`);
      if (r.errors.length) fail(`${name}: ${r.errors.join(' | ')}`);
    }
    const want = name.endsWith('v2') ? 'copied' : 'verified';
    if (runs.some((r) => r.storage?.migration !== want)) fail(`${name}: expected migration '${want}', got ${runs.map((r) => r.storage?.migration).join(',')}`);
  }
  for (const ctx of Object.values(warm)) await ctx.close();

  const ms = (v) => `${Math.round(v)} ms`.padStart(7);
  console.log(`\nFirst render · CPU ${CPU}× slower · median of ${RUNS} launches`);
  console.log('case          Home painted   first-render mark   FCP       module code done   modules before render');
  for (const [name, runs] of Object.entries(results)) {
    const m = (k) => median(runs.map((r) => r[k]));
    console.log(`${name.padEnd(13)} ${ms(m('painted'))}        ${ms(m('mark'))}             ${ms(m('fcp'))}   ${ms(m('dcl'))}            ${median(runs.map((r) => r.js.length))} files · ${Math.round(m('kb'))} KB`);
  }
  if (args.includes('--marks')) {
    for (const [name, runs] of Object.entries(results)) {
      const m = (f) => Math.round(median(runs.map(f)));
      console.log(name, `worker ${m((r) => r.nav.workerStart)} · html ${m((r) => r.nav.responseStart)}-${m((r) => r.nav.responseEnd)} · css ${m((r) => r.css)} · parsed ${m((r) => r.nav.domInteractive)} · last module ${m((r) => r.lastModule)} ·`,
        Object.keys(runs[0].marks).map((k) => `${k} ${m((r) => r.marks[k] ?? NaN)}`).join(' · '));
    }
  }
  console.log(`(all runs, Home painted: ${Object.entries(results).map(([n, rs]) => `${n} ${rs.map((r) => Math.round(r.painted)).join('/')}`).join('; ')})`);
}

async function offline() {
  console.log('\nOffline, after a first visit installed Pitaka');
  const step = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`); if (!ok) failed = true; };
  const ctx = await newContext();
  await seedV2(ctx);
  const first = await ctx.newPage();
  await first.goto(URL0);
  await first.evaluate(() => navigator.serviceWorker.ready);
  await first.waitForFunction(() => navigator.serviceWorker.controller && window.pitaka);
  // A pairing like the one Pitaka keeps (an unexportable key in the secrets store), for a relay that
  // will be out of reach, so the offline launch tries to collect.
  await first.evaluate(async () => {
    const { S } = window.pitaka;
    const key = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])).privateKey;
    await S.secrets.set('relay', { url: 'https://pitaka-relay.test.workers.dev', read: 'r'.repeat(43), write: 'w'.repeat(43), pairedAt: Date.now() });
    await S.secrets.set('relayKey', key);
  });
  await first.close();

  await ctx.setOffline(true);
  // Requests a service worker passes through can slip past the emulation in Chromium; nothing leaves this machine.
  await ctx.route((u) => !u.href.startsWith(ORIGIN), (r) => r.abort('internetdisconnected'));
  const p = await ctx.newPage();
  const errors = [];
  const netLog = []; // the browser's own "Failed to load resource" lines (Safari prints them too); not Pitaka's
  const failedReqs = [];
  const served = new Set();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') (/^Failed to load resource/.test(m.text()) ? netLog : errors).push(m.text()); });
  p.on('requestfailed', (r) => { if (r.url().startsWith(ORIGIN)) failedReqs.push(new URL(r.url()).pathname); });
  p.on('response', (r) => { if (r.url().startsWith(ORIGIN) && r.ok()) served.add(new URL(r.url()).pathname); });
  const tmp = mkdtempSync(path.join(tmpdir(), 'pitaka-offline-'));
  try {
    await p.goto(URL0);
    await p.waitForFunction(() => window.pitaka);
    const home = await p.evaluate(() => ({ hero: !!document.querySelector('#main .hero'), tab: window.pitaka.ui.tab, txns: window.pitaka.S.db.txns.length }));
    step(home.hero && home.tab === 'home' && home.txns === fixture.txns.length, 'opens on Home with the saved data', `${home.txns} entries`);

    // The relay can't be reached: Pitaka tries, then says nothing.
    let relay = null;
    for (let i = 0; i < 40 && !relay?.lastError; i++) {
      await p.waitForTimeout(100);
      relay = await p.evaluate(async () => { const Sync = await import('./js/sync.js'); return { ...Sync.info(), banners: document.querySelector('#banner-slot')?.innerText || '' }; });
    }
    step(relay?.paired && !!relay.lastError && !/relay/i.test(relay.banners) && !errors.length, 'relay sync fails quietly', relay?.lastError ? `"${relay.lastError}", no banner, nothing logged by Pitaka` : 'no attempt seen');

    // A statement PDF: pdf.js and its worker come from the cache.
    await p.evaluate(() => { const P = window.pitaka; P.ACTIONS.walletSheet({ id: P.S.db.accounts.find((a) => a.name === 'GCash').id }); });
    await p.click('#sheet [data-action="statementSheet"]');
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#sheet [data-action="stmtFile"]')]);
    await chooser.setFiles(path.join(repo, 'tests/fixtures/statement-gcash.pdf'));
    await p.waitForSelector('#stmt-pw [name=pw]', { timeout: 20000 });
    await p.fill('#stmt-pw [name=pw]', 'pitaka1234');
    await p.click('#stmt-pw button[type=submit]');
    const rows = await p.waitForSelector('.stmt-rows', { timeout: 20000 }).then(() => p.$$eval('.stmt-row', (els) => els.length), () => 0);
    step(rows > 0 && served.has('/vendor/pdfjs/pdf.min.mjs') && served.has('/vendor/pdfjs/pdf.worker.min.mjs'), 'reads a password-protected statement PDF', `${rows} rows`);
    await p.evaluate(() => window.pitaka.ACTIONS.closeSheet());

    // Import from Files (the shortcuts' inbox.jsonl in iCloud Drive).
    const file = path.join(tmp, 'inbox.jsonl');
    writeFileSync(file, `${JSON.stringify({ id: `offline-${Date.now().toString(36)}-0001`, type: 'entry', amount: 85, category: 'Food', wallet: 'Cash', note: 'Offline lunch' })}\n`);
    const before = await p.evaluate(() => window.pitaka.S.db.inbox.length + window.pitaka.S.db.txns.length);
    await p.evaluate(() => window.pitaka.ACTIONS.inboxSettings());
    const [inbox] = await Promise.all([p.waitForEvent('filechooser'), p.click('#sheet [data-action="importInbox"]')]);
    await inbox.setFiles(file);
    await p.waitForFunction((n) => window.pitaka.S.db.inbox.length + window.pitaka.S.db.txns.length > n, before, { timeout: 10000 }).catch(() => {});
    const after = await p.evaluate(() => window.pitaka.S.db.inbox.length + window.pitaka.S.db.txns.length);
    step(after > before, 'Import from Files works');

    // The modules that load on first use, through the screens that use them.
    await p.evaluate(() => window.pitaka.ACTIONS.add());
    const form = await p.waitForSelector('#txn-form', { timeout: 10000 }).then(() => true, () => false);
    await p.evaluate(() => window.pitaka.ACTIONS.importSheet());
    await p.fill('[data-import-text]', 'Name\tBalance\tMonthly\tDue date\nGLoan\t7480\t1870\t15');
    const pasted = await p.waitForFunction(() => document.querySelector('#sheet')?.innerText.includes('GLoan') && document.querySelector('#sheet [data-action="importSave"]'), null, { timeout: 10000 }).then(() => true, () => false);
    await p.evaluate(() => window.pitaka.ACTIONS.connectGuide({ from: 'settings' }));
    const guide = await p.waitForFunction(() => document.querySelector('#sheet [data-action="shortcutGuide"]'), null, { timeout: 10000 }).then(() => true, () => false);
    await p.evaluate(() => window.pitaka.ACTIONS.closeSheet());
    // Every file the service worker precaches is there offline.
    const missing = await p.evaluate(async (urls) => (await Promise.all(urls.map(async (u) => { try { return (await fetch(u)).ok ? null : u; } catch { return u; } }))).filter(Boolean),
      [...readFileSync(path.join(root, 'sw.js'), 'utf8').matchAll(/'\.\/([^']*)'/g)].map((m) => `./${m[1]}`));
    const lazy = ['/js/ui-sheets.js', '/js/ui-money.js', '/js/ui-onboard.js', '/js/ui-statement.js', '/js/statements.js', '/js/ui-ics.js', '/js/csv.js', '/js/importer.js', '/js/ui-guide.js', '/js/guide.js'];
    const notLoaded = lazy.filter((f) => !served.has(f));
    step(form && pasted && guide && !notLoaded.length && !missing.length && !failedReqs.length, 'lazy modules load offline',
      `entry form ${form ? 'ok' : 'missing'}, debt paste ${pasted ? 'ok' : 'missing'}, guide ${guide ? 'ok' : 'missing'}${notLoaded.length ? `, not loaded: ${notLoaded.join(' ')}` : ''}${missing.length ? `, not cached: ${missing.join(' ')}` : ''}${failedReqs.length ? `, failed: ${failedReqs.join(' ')}` : ''}`);
    step(!errors.length, 'no page errors, and nothing logged by Pitaka', errors.length ? errors.join(' | ') : netLog.length ? `the browser logged ${netLog.length} failed request${netLog.length === 1 ? '' : 's'} to the relay` : '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await ctx.close();
  }
}

try {
  if (ONLY !== 'offline') await speed();
  if (ONLY !== 'speed') await offline();
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ cpu: CPU, runs: RUNS, results }, null, 1));
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exitCode = 1;
