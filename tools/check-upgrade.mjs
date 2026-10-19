// Checks that an installed v2 Pitaka updates to this version through its service worker and keeps its
// data. Needs git, Playwright and a Chromium (set CHROMIUM=/path/to/chromium if Playwright has none).
//   node tools/check-upgrade.mjs [v2-commit]
//
// 1. Serves the v2 code (default: commit b8ac339) on localhost, loads v2 data made by v2 itself
//    (tests/fixtures/v2-data.json), and waits until v2's service worker controls the page.
// 2. Serves this working copy at the same address, reloads, and lets the new worker take over.
// 3. Compares wallets, debts and entries, then reloads once more: the IndexedDB copy is verified and v2's
//    copy is removed.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const v2commit = process.argv[2] || 'b8ac339';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire('/opt/node22/lib/node_modules/')('playwright'); }

const site = mkdtempSync(path.join(tmpdir(), 'pitaka-upgrade-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!f.startsWith(site) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const URL0 = `http://localhost:${server.address().port}/`;
const serve = (fn) => { rmSync(site, { recursive: true, force: true }); execSync(`mkdir -p ${site}`); fn(); };

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
try {
  serve(() => execSync(`git -C ${root} archive ${v2commit} | tar -x -C ${site}`, { shell: '/bin/bash' }));
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${URL0}icons/icon-192.png`);
  await p.evaluate((raw) => { localStorage.clear(); localStorage.setItem('pitaka.data', raw); }, readFileSync(path.join(root, 'tests/fixtures/v2-data.json'), 'utf8'));
  await p.goto(URL0);
  await p.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 8000))]));
  await p.reload();
  await p.waitForTimeout(800);
  // The fixture has a PIN; a person would unlock. (The update waits while the lock screen is up.)
  await p.evaluate(() => { const P = window.pitaka; if (P && !document.querySelector('#lock').hidden) { P.S.updateSettings({ pinHash: null }); P.Lock.close(true); } });
  const v2 = await p.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys(), text: document.querySelector('#main')?.innerText || '' }));
  console.log('v2:', v2.controlled ? 'controlled by its service worker' : 'NOT controlled', v2.caches);
  if (!v2.controlled) fail('v2 never came under its service worker');

  serve(() => cpSync(root, site, { recursive: true, filter: (src) => !/[/\\](\.git|tests|tools|docs|relay|node_modules)([/\\]|$)/.test(src.slice(root.length - 1)) }));
  await p.reload();
  // The new worker installs, v2 switches to it when idle (or from its "New version ready" banner) and the
  // page reloads into v3. Wait until v3 has been up for two checks in a row.
  const isV3 = () => p.evaluate(() => typeof window.pitaka?.S?.storageInfo === 'function').catch(() => false);
  let v3 = false;
  for (let i = 0; i < 60 && !v3; i++) {
    await p.waitForTimeout(500);
    v3 = (await isV3()) && (await p.waitForTimeout(700), await isV3());
    if (!v3) await p.click('[data-action="applyUpdate"]', { timeout: 200 }).catch(() => {});
  }
  if (!v3) fail('the new version never took over');
  await p.waitForTimeout(800);
  const after = await p.evaluate(async () => {
    const S = window.pitaka.S;
    return {
      storage: S.storageInfo(), legacy: !!localStorage.getItem('pitaka.data'), caches: await caches.keys(),
      txns: S.db.txns.length, wallets: S.db.accounts.map((a) => [a.name, S.accountBalance(a.id)]), debt: S.db.debts.reduce((s, d) => s + d.balance, 0),
    };
  });
  console.log('after the update:', JSON.stringify(after));
  const want = { txns: 11, wallets: [['Cash', -1175], ['GCash', 5362], ['BPI Savings', 33500]], debt: 44493.65 };
  if (after.txns !== want.txns || JSON.stringify(after.wallets) !== JSON.stringify(want.wallets) || Math.abs(after.debt - want.debt) > 0.001) fail('the data changed in the update');
  if (after.storage.kind !== 'indexeddb' || after.storage.migration !== 'copied' || !after.legacy) fail('expected a fresh, unverified IndexedDB copy with v2\'s copy kept');
  if (after.caches.some((c) => c === 'pitaka-v2')) fail('the v2 cache is still there');
  await p.reload();
  await p.waitForTimeout(1200);
  const later = await p.evaluate(() => ({ storage: window.pitaka.S.storageInfo(), legacy: !!localStorage.getItem('pitaka.data'), txns: window.pitaka.S.db.txns.length }));
  console.log('next launch:', JSON.stringify(later));
  if (later.storage.migration !== 'verified' || later.legacy || later.txns !== want.txns) fail('the copy wasn\'t verified on the next launch');
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  if (!process.exitCode) console.log('OK: v2 updated to this version with its data intact');
} finally {
  await browser.close();
  server.close();
  rmSync(site, { recursive: true, force: true });
}
