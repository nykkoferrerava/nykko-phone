// Captures the real Pitaka app for the ad: screencast clips of real interactions (CDP screencast, PNG,
// every frame, stitched with ffmpeg), crisp stills of each key state, and UI pieces as transparent PNG
// layers. Writes public/gen/capture/ and a manifest (capture.json) with what each screen really says, so
// every number and label in the ad comes from here.
//
//   node capture/capture.mjs            (from video/; serves the repo with python3 -m http.server 8123)
//
// Taps and typing go through the real UI. The localhost test hook (window.pitaka) is used to set up
// states (switch tabs, feed items to the real inbox pipeline exactly as sync.js does after a relay pull)
// and to read state; it never draws UI.
//
// Clips are recorded in slow motion: the page's clocks and CSS animations run SLOW times slower while
// the screencast runs, so every animation is sampled SLOW times more often. Frame timestamps are divided
// by SLOW when the clip is stitched, so clips play back at the app's real speed.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, stagedData, timeScript } from './stage.mjs';

const VIDEO = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(VIDEO, '..');
const OUT = path.join(VIDEO, 'public/gen/capture');
const TMP = path.join(VIDEO, '.cache/capture-frames');
const PORT = Number(process.env.CAPTURE_PORT) || 8123;
const ORIGIN = `http://localhost:${PORT}`;
const CHROMIUM = process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const INTER = path.join(VIDEO, 'node_modules/@fontsource/inter/files');
const GCASH_OPENING = Number(process.env.GCASH_OPENING ?? 2289);
const SLOW = Number(process.env.CAPTURE_SLOW) || 4;
const DSF = 3;
const VW = 393, VH = 852;

rmSync(OUT, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
for (const d of ['stills', 'clips', 'layers']) mkdirSync(path.join(OUT, d), { recursive: true });
mkdirSync(TMP, { recursive: true });

const manifest = { now: NOW, viewport: { width: VW, height: VH, dsf: DSF }, slow: SLOW, stills: {}, clips: {}, layers: {}, boxes: {}, facts: {}, staging: { gcashOpening: GCASH_OPENING } };
const log = (...a) => console.log('[capture]', ...a);

// ------------------------------------------------------------ the site
let server = null;
async function serve() {
  try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return log(`using the server already on ${ORIGIN}`); } catch { /* start one */ }
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('python3 -m http.server did not start');
}

// ------------------------------------------------------------ the phone
// Inter, injected by this script only (the app asks for the system font, which on an iPhone is SF Pro;
// Inter reads the same way and has an open licence).
const INTER_CSS = `
${[400, 500, 600, 700, 800].map((w) => `@font-face { font-family: 'Inter'; font-weight: ${w}; src: url('/__capture/inter-${w}.woff2') format('woff2'); }`).join('\n')}
html, body, button, input, select, textarea { font-family: 'Inter', system-ui, sans-serif !important; }
input, textarea { caret-color: transparent; }
`;

let browser, ctx, page, cdp;
async function open() {
  ctx = await browser.newContext({
    viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, isMobile: true, hasTouch: true, colorScheme: 'light',
    timezoneId: 'Asia/Manila', locale: 'en-PH', serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  await ctx.addInitScript(timeScript, Date.parse(NOW));
  await ctx.addInitScript((data) => {
    if (localStorage.getItem('pitaka.capture.seeded')) return;
    localStorage.setItem('pitaka.data', data);
    localStorage.setItem('pitaka.capture.seeded', '1');
  }, JSON.stringify(stagedData({ gcashOpening: GCASH_OPENING })));
  // The app's CSP allows fonts from 'self' only, so Inter is served from this origin.
  await ctx.route('**/__capture/inter-*.woff2', (route) => {
    const w = route.request().url().match(/inter-(\d+)\.woff2/)[1];
    route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(path.join(INTER, `inter-latin-${w}-normal.woff2`)) });
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('console.error', m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) log('http', r.status(), r.url()); });
  cdp = await ctx.newCDPSession(page);
  await cdp.send('Animation.enable');
  await page.goto(`${ORIGIN}/`);
  await ready();
}
async function ready() {
  await page.waitForFunction(() => !!window.pitaka, null, { timeout: 15000 });
  await page.addStyleTag({ content: INTER_CSS });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.family.includes('Inter') && f.status === 'loaded').length);
  if (fonts < 3) log('warning: Inter faces loaded:', fonts);
  await page.waitForTimeout(500);
}
async function reload() { await page.reload(); await ready(); }

let scale = 1; // real seconds per app second while recording
const sleep = (ms) => page.waitForTimeout(ms * scale);
const ev = (fn, arg) => page.evaluate(fn, arg);
const text = (sel) => page.locator(sel).first().innerText().then((s) => s.replace(/\s+/g, ' ').trim());
const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout: timeout * scale });
async function settle() {
  await until(() => [...document.querySelectorAll('#main [data-count]')].every((el) => (el.querySelector('.v') || el).textContent === new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(Number(el.dataset.to) || 0)), null, 5000).catch(() => {});
}
async function tab(name) {
  await closeSheet();
  await tap(`.tabbar [data-tab="${name}"]`);
  await until((n) => document.querySelector(`.tabbar [data-tab="${n}"]`)?.getAttribute('aria-current') === 'page', name);
  await sleep(700);
}
async function setTab(name) { await ev((t) => { window.pitaka.ui.tab = t; window.pitaka.render(); }, name); await sleep(700); }
async function sheet(title) {
  await until((t) => { const s = document.querySelector('#sheet'); const h = document.querySelector('#sheet-title'); return !!s && !s.hidden && s.classList.contains('open') && !!h && h.textContent.replace(/\s+/g, ' ').includes(t); }, title, 20000);
  await sleep(500);
}
async function closeSheet() {
  const st = await ev(() => { const s = document.querySelector('#sheet'); return s.hidden ? 'hidden' : s.classList.contains('open') ? 'open' : 'closing'; });
  if (st === 'hidden') return;
  if (st === 'open') await ev(() => window.pitaka.ACTIONS.closeSheet({}));
  await until(() => document.querySelector('#sheet').hidden, null, 5000);
}
async function hideToast() { await ev(() => { const t = document.querySelector('#toast'); t.hidden = true; document.body.classList.remove('toast-on'); }); }
async function toastText() { return ev(() => { const t = document.querySelector('#toast'); return t.hidden ? '' : t.innerText.replace(/\s+/g, ' ').trim(); }); }
async function waitToast(part, timeout = 10000) {
  await until((p) => { const t = document.querySelector('#toast'); return !t.hidden && t.innerText.replace(/\s+/g, ' ').includes(p); }, part, timeout);
  return toastText();
}
const box = (loc) => loc.boundingBox().then((b) => (b ? { x: +b.x.toFixed(1), y: +b.y.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) } : null)).catch(() => null);
const sectionIndex = (head) => ev((h) => [...document.querySelectorAll('#main section')].findIndex((s) => s.querySelector('h2')?.textContent.startsWith(h)), head);

// ------------------------------------------------------------ recording
let rec = null;
async function recStart(name, { slow = SLOW } = {}) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  rec = { name, dir, frames: [], taps: [], marks: [], slow };
  const r = rec;
  cdp.on('Page.screencastFrame', r.onFrame = (f) => {
    const file = path.join(dir, `f${String(r.frames.length).padStart(5, '0')}.png`);
    r.frames.push({ file, t: f.metadata.timestamp });
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  scale = slow;
  await ev((s) => window.__timeScale(1 / s), slow);
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / slow });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: VW * DSF, maxHeight: VH * DSF });
  // Nudge a paint so the clip starts on the current screen.
  await ev(() => { document.body.style.outline = '0px solid transparent'; requestAnimationFrame(() => { document.body.style.outline = ''; }); });
  await sleep(150);
}
function mark(label) { if (rec) rec.marks.push({ label, wall: Date.now() / 1000 }); }
async function recStop(meta = {}) {
  await sleep(250);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', rec.onFrame);
  await ev(() => window.__timeScale(1));
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  scale = 1;
  const r = rec; rec = null;
  if (!r.frames.length) throw new Error(`no frames for ${r.name}`);
  // Each frame is held until the next one; durations are app time (real time / slow).
  const lines = [];
  for (let i = 0; i < r.frames.length; i++) {
    const dur = (i + 1 < r.frames.length ? r.frames[i + 1].t - r.frames[i].t : 0.25 * r.slow) / r.slow;
    lines.push(`file '${r.frames[i].file}'`, `duration ${Math.max(dur, 1 / 240).toFixed(5)}`);
  }
  lines.push(`file '${r.frames.at(-1).file}'`);
  const list = path.join(r.dir, 'list.txt');
  writeFileSync(list, lines.join('\n'));
  const out = path.join(OUT, 'clips', `${r.name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'scale=1080:-2:flags=lanczos,fps=60,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-movflags', '+faststart', out]);
  const t0 = r.frames[0].t;
  const span = (r.frames.at(-1).t - t0) / r.slow;
  manifest.clips[r.name] = {
    file: `gen/capture/clips/${r.name}.mp4`, duration: +(span + 0.25).toFixed(3), frames: r.frames.length,
    sampledFps: +(r.frames.length / Math.max(0.001, span)).toFixed(1),
    // tap and mark times in clip seconds; tap points in CSS px of the 393×852 screen
    taps: r.taps.map((x) => ({ sel: x.sel, x: x.x, y: x.y, t: +((x.wall - t0) / r.slow).toFixed(3) })),
    marks: r.marks.map((x) => ({ label: x.label, t: +((x.wall - t0) / r.slow).toFixed(3) })),
    ...meta,
  };
  log(`clip ${r.name}: ${r.frames.length} frames over ${span.toFixed(2)} s of app time (~${(r.frames.length / span).toFixed(0)} fps sampled)`);
}

// A real tap; its centre point (CSS px) and time go in the clip's tap log.
async function tapLoc(loc, label) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (rec && b) rec.taps.push({ sel: label, x: +(b.x + b.width / 2).toFixed(1), y: +(b.y + b.height / 2).toFixed(1), wall: Date.now() / 1000 });
  await loc.tap();
}
const tap = (sel) => tapLoc(page.locator(sel).first(), sel);
async function type(sel, value, delay = 150) {
  const loc = page.locator(sel).first();
  await loc.fill('');
  for (const ch of String(value)) { await loc.press(ch === '.' ? 'Period' : ch); await sleep(delay); }
}

// ------------------------------------------------------------ stills and layers
async function still(name) {
  const file = path.join(OUT, 'stills', `${name}.png`);
  await page.screenshot({ path: file });
  manifest.stills[name] = { file: `gen/capture/stills/${name}.png`, scrollY: await ev(() => window.scrollY) };
}
// A UI piece on a transparent background, padded so its shadow is kept. Records where it sits on screen.
async function layer(name, sel, { pad = 36, hide = [], scroll = true } = {}) {
  const loc = page.locator(sel).first();
  if (scroll) await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  const style = await page.addStyleTag({ content: `html, body, #main, .view, .view-static { background: transparent !important; } .tabbar, .fab, #topbar { visibility: hidden !important; } ${hide.map((h) => `${h} { visibility: hidden !important; }`).join('\n')}` });
  await page.waitForTimeout(120);
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const clip = { x, y, width: Math.min(VW - x, b.width + pad * 2), height: Math.min(VH - y, b.height + pad * 2) };
  const file = path.join(OUT, 'layers', `${name}.png`);
  await page.screenshot({ path: file, clip, omitBackground: true });
  await style.evaluate((s) => s.remove());
  manifest.layers[name] = { file: `gen/capture/layers/${name}.png`, box: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) }, clip, scale: DSF };
}
const toastLayer = (name) => layer(name, '#toast', { pad: 30, scroll: false });

// ------------------------------------------------------------ the inbox (what the relay delivers)
// What sync.js does with a relay pull once it has opened the items: cleanRaw, the real pipeline, a
// durable save, then the real "1 new entry from …" toast.
let seq = 0;
async function deliver(items, from) {
  return ev(async ([its, fromLabel]) => {
    const P = window.pitaka;
    const clean = its.map((x) => P.X.cleanRaw(x)).filter(Boolean);
    const out = P.X.processItems(clean, { src: 'relay' });
    await P.S.flush();
    P.render({ keepScroll: true });
    P.announce(out, fromLabel);
    const S = P.S;
    const entries = out.created.map((id) => S.txn(id)).filter(Boolean).map((t) => ({ kind: t.kind, amount: t.amount, note: t.note, merchant: t.merchant, category: t.categoryId ? S.cat(t.categoryId).name : null, wallet: S.account(t.accountId)?.name || null, person: t.receivableId ? S.receivable(t.receivableId)?.name : null }));
    return { created: out.created.length, confirmed: out.confirmed.filter(Boolean).length, paired: out.paired.length, review: out.review.length, entries };
  }, [items.map((x) => ({ at: Date.now(), ...x, id: x.id || `ad-${x.type}-${++seq}` })), from]);
}

// ------------------------------------------------------------ facts read off the screens
async function homeFacts() {
  return ev(() => {
    const t = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);
    const h = document.querySelector('#main .hero.spend');
    const sec = (head) => [...document.querySelectorAll('#main section')].find((s) => s.querySelector('h2')?.textContent.startsWith(head));
    return {
      paydayLine: document.querySelector('#main').innerText.split('\n').find((l) => l.startsWith('Next payday')) || null,
      heroLabel: t(h?.querySelector('.label')),
      free: t(h?.querySelector('.big')),
      freeValue: Number(h?.querySelector('[data-count="free"]')?.dataset.to),
      split: [...(h?.querySelectorAll('.split > div') || [])].map((d) => ({ label: t(d.querySelector('.label')), value: t(d.querySelector('.num')) })),
      wallets: [...document.querySelectorAll('#main .wallets .wallet:not(.add)')].map((w) => ({ name: t(w.querySelector('.label')), value: t(w.querySelector('.num')) })),
      tiles: [...document.querySelectorAll('#main .tiles .tile')].map((x) => t(x)),
      sections: [...document.querySelectorAll('#main section h2')].map((x) => x.childNodes[0]?.textContent.trim()),
      due: t(sec('Due before payday')?.querySelector('ul, p')),
      watch: t(sec('Budgets to watch')?.querySelector('ul')),
      goals: t(sec('Savings goals')?.querySelector('ul')),
    };
  });
}
async function homeBoxes() {
  const b = {
    title: await box(page.locator('#main h1').first()),
    paydayLine: await box(page.getByText(/^Next payday/).first()),
    hero: await box(page.locator('#main .hero.spend')),
    heroBig: await box(page.locator('#main .hero.spend .big')),
    wallets: await box(page.locator('#main .wallets')),
    tiles: await box(page.locator('#main .tiles')),
    tabbar: await box(page.locator('.tabbar')),
    fab: await box(page.locator('.fab')),
    settings: await box(page.locator('#topbar [data-action="settings"]')),
  };
  for (const [k, head] of [['due', 'Due before payday'], ['watch', 'Budgets to watch'], ['goals', 'Savings goals']]) {
    const i = await sectionIndex(head);
    if (i >= 0) b[k] = await box(page.locator('#main section').nth(i));
  }
  b.scrollY = await ev(() => window.scrollY);
  return b;
}

// ============================================================ the run
await serve();
browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--font-render-hinting=none'] });

// ---------------------------------------------------------------- a side session: "sahod 25000"
// Its own fresh copy of the demo data, so the main story's pay period keeps a single paycheck.
await open();
await setTab('home');
await recStart('quick-text-sahod');
await sleep(400);
const sahod = await deliver([{ type: 'text', text: 'sahod 25000' }], 'Quick Add');
mark('delivered');
manifest.facts.quickTextSahod = { said: 'sahod 25000', result: sahod, toast: await waitToast('Quick Add') };
await sleep(900);
await still('quick-text-sahod');
await toastLayer('toast-quick-text-sahod');
await sleep(1200);
await recStop({ note: '"sahod 25000" from the Back Tap text shortcut (separate fresh session)' });
log('sahod', JSON.stringify(manifest.facts.quickTextSahod));
await ctx.close();

// ---------------------------------------------------------------- the main session
await open();
log('storage', await ev(() => window.pitaka.S.storageInfo?.().kind));

// ---------------------------------------------------------------- Home
await setTab('home');
await settle();
manifest.facts.home = await homeFacts();
manifest.boxes.home = await homeBoxes();
log('home', JSON.stringify(manifest.facts.home));
await still('home');
await layer('hero', '#main .hero.spend', { pad: 60, scroll: false });
await layer('hero-plate', '#main .hero.spend', { pad: 60, scroll: false, hide: ['#main .hero.spend .big'] });
await layer('wallets', '#main .wallets', { pad: 30, scroll: false });
await layer('tiles', '#main .tiles', { pad: 30, scroll: false });
for (const [name, head] of [['due', 'Due before payday'], ['watch', 'Budgets to watch'], ['goals', 'Savings goals']]) {
  const i = await sectionIndex(head);
  if (i >= 0) await layer(`section-${name}`, `#main section >> nth=${i}`, { pad: 30 });
}
await ev(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

// A slow scroll down Home: Due before payday and Budgets to watch come into view.
await recStart('home-scroll');
await sleep(600);
mark('scroll');
await ev(() => new Promise((done) => {
  const t0 = performance.now(); const to = Math.min(330, document.documentElement.scrollHeight - innerHeight);
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const step = (now) => { const p = Math.min(1, (now - t0) / 1800); window.scrollTo(0, to * ease(p)); if (p < 1) requestAnimationFrame(step); else done(); };
  requestAnimationFrame(step);
}));
mark('scrolled');
await sleep(800);
await still('home-scrolled');
await recStop({ note: 'Home, scrolled down to Due before payday and Budgets to watch' });
manifest.boxes.homeScrolled = await homeBoxes();
await ev(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

// ---------------------------------------------------------------- Add expense (real taps and typing)
await recStart('add-expense');
await sleep(500);
await tap('.fab'); mark('fab');
await sheet('Add expense');
mark('amount');
await type('#txn-form [name=amount]', '120', 170);
await sleep(300);
await tapLoc(page.locator('#txn-form label.cat-opt', { has: page.locator('small:text-is("Food")') }), 'Food');
mark('food');
await sleep(600);
await still('add-expense-filled');
await tap('#sheet .sheet-head button[type=submit][form="txn-form"]'); mark('save');
manifest.facts.addExpense = { amount: 120, category: 'Food', toast: await waitToast('Saved') };
await sleep(500);
await still('add-expense-toast');
await toastLayer('toast-saved');
await sleep(1500);
await recStop({ note: 'tap +, type 120, pick Food, Save: "Saved" with Undo; free to spend counts down' });
log('add expense', JSON.stringify(manifest.facts.addExpense));
await hideToast();

// ---------------------------------------------------------------- Quick Add (Back Tap keypad), collected as Pitaka opens
await reload();
await setTab('home');
await settle();
manifest.facts.homeBeforeQuickAdd = await homeFacts();
await recStart('quick-add-toast');
await sleep(500);
const QA = { amount: '150', category: '🍜 Food', wallet: 'GCash' };
const qa = await deliver([{ type: 'entry', ...QA }], 'Quick Add');
mark('delivered');
manifest.facts.quickAdd = { sent: QA, result: qa, toast: await waitToast('1 new entry from Quick Add') };
await sleep(700);
await still('quick-add-toast');
await toastLayer('toast-quick-add');
await sleep(1600);
await recStop({ note: 'the relay delivers a Back Tap keypad entry when Pitaka opens; free to spend counts down by 150' });
manifest.facts.homeAfterQuickAdd = await homeFacts();
log('quick add', JSON.stringify(manifest.facts.quickAdd));
await hideToast();

// ---------------------------------------------------------------- Quick text (triple tap)
manifest.facts.quickText = [];
for (const [i, said] of ['jollibee 289 gcash', 'lent mel 500'].entries()) {
  await setTab('home');
  await recStart(`quick-text-${i + 1}`);
  await sleep(400);
  const r = await deliver([{ type: 'text', text: said }], 'Quick Add');
  mark('delivered');
  manifest.facts.quickText.push({ said, result: r, toast: await waitToast('Quick Add') });
  await sleep(800);
  await still(`quick-text-${i + 1}`);
  await toastLayer(`toast-quick-text-${i + 1}`);
  await sleep(1100);
  await recStop({ note: `"${said}" from the Back Tap text shortcut` });
  await hideToast();
}
log('quick text', JSON.stringify(manifest.facts.quickText));

// ---------------------------------------------------------------- Alerts: the GCash text about the ₱289 you typed
await setTab('home');
await recStart('alert-merge');
await sleep(400);
const MERGE_SMS = { sender: 'GCash', text: 'You have paid PHP 289.00 to JOLLIBEE FOODS CORP. Ref No. 9876543210123.' };
const merge = await deliver([{ type: 'sms', ...MERGE_SMS }], 'SMS');
mark('delivered');
await sleep(600);
manifest.facts.alertMerge = {
  sms: MERGE_SMS, result: merge, toast: await toastText(),
  jollibeeToday: await ev(() => window.pitaka.S.db.txns.filter((t) => t.amount === 289 && t.date === window.pitaka.toISO(new Date())).map((t) => ({ note: t.note, merchant: t.merchant, confirmedBy: (t.conf || []).map((c) => c.inst) }))),
};
await still('alert-merge-toast');
await toastLayer('toast-alert-merge');
await sleep(1600);
await recStop({ note: 'the GCash SMS about the ₱289 Jollibee typed earlier confirms it instead of adding a second one' });
log('merge', JSON.stringify(manifest.facts.alertMerge));
await hideToast();

// ---------------------------------------------------------------- Alerts that fill in, and the ones that wait in Review
const day = await ev(() => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`; });
const SMS = [
  { sender: 'BPI', text: 'BPI: Your card ending 4821 was used for PHP 1,234.50 at SM SUPERMARKET.' },
  { sender: 'GCash', text: 'GCash: Your payment of PHP 64.00 was successful. Thank you for using GCash.' },
  { sender: 'GCash', text: `You have sent PHP 700.00 of GCash to JUAN DELA CRUZ 09171234567 on ${day}. Ref. No. 5555555555555.` },
  { sender: 'MyBank', text: 'MyBank: Purchase 450.00 at MERCURY DRUG on 10/19. Thank you.' },
];
await setTab('home');
await recStart('alerts-arrive');
await sleep(400);
const rv = await deliver(SMS.map((s) => ({ type: 'sms', ...s })), 'SMS');
mark('delivered');
manifest.facts.alerts = { sms: SMS, result: rv, toast: await toastText() };
await sleep(800);
await still('alerts-toast');
await toastLayer('toast-alerts');
await sleep(1400);
await recStop({ note: 'four bank and GCash texts arrive: one is added on its own, three wait in Review' });
log('alerts', JSON.stringify(manifest.facts.alerts));
await hideToast();

await setTab('review');
await page.waitForTimeout(300);
const reviewCards = () => ev(() => [...document.querySelectorAll('#main .review-card')].map((c) => ({ src: c.querySelector('.rc-src')?.innerText.trim(), chip: c.querySelector('.chip')?.innerText.trim(), main: c.querySelector('.rc-main')?.innerText.trim(), quote: c.querySelector('.quote')?.innerText.trim(), actions: [...c.querySelectorAll('.rc-actions button')].map((b) => b.innerText.trim()) })));
manifest.facts.review = await reviewCards();
log('review', JSON.stringify(manifest.facts.review));
await still('review');
const nCards = await ev(() => document.querySelectorAll('#main .review-card').length);
for (let i = 0; i < nCards; i++) await layer(`review-card-${i + 1}`, `#main .review-card >> nth=${i}`, { pad: 24 });
await ev(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
const card = (part) => page.locator('#main .review-card', { hasText: part });
await recStart('review-actions');
await sleep(600);
if (await card('₱64').count()) {
  await tapLoc(card('₱64').locator('[data-action="reviewAccept"]'), 'Accept'); mark('accept');
  manifest.facts.reviewAccept = await waitToast('Added').catch(() => toastText());
  await sleep(1300);
}
if (await card('₱700').count()) {
  await tapLoc(card('₱700').locator('[data-action="reviewTransfer"]'), 'Transfer'); mark('transfer');
  await sheet('Went to which wallet?');
  await still('review-transfer-sheet');
  await sleep(400);
  await tapLoc(page.locator('#sheet .row', { hasText: 'BPI Savings' }), 'BPI Savings'); mark('to-bpi');
  manifest.facts.reviewTransfer = await waitToast('Saved as a transfer').catch(() => toastText());
  await sleep(1300);
}
await recStop({ note: 'Review: Accept the ₱64, then mark the ₱700 as a transfer to BPI Savings' });
await hideToast();
await ev(() => window.scrollTo(0, 0));

await recStart('review-teach');
await sleep(500);
if (await card('MyBank').count()) {
  await tapLoc(card('MyBank').locator('[data-action="reviewTeach"]'), 'Teach'); mark('teach');
  await sheet('Teach this format');
  await sleep(300);
  await tapLoc(page.locator('#tok-text .tok', { hasText: '450.00' }), '450.00'); mark('amount');
  await sleep(500);
  await tapLoc(page.locator('#sheet label', { has: page.locator('input[value="merchant"]') }), 'Merchant');
  await sleep(300);
  await tapLoc(page.locator('#tok-text .tok', { hasText: /^MERCURY$/ }), 'MERCURY');
  await sleep(250);
  await tapLoc(page.locator('#tok-text .tok', { hasText: /^DRUG$/ }), 'DRUG'); mark('merchant');
  await sleep(400);
  const opts = await page.locator('#teach-form [name=target]').evaluate((s) => [...s.options].map((o) => [o.value, o.textContent.trim()]));
  const bpi = opts.find(([, l]) => l.startsWith('BPI Savings'));
  if (bpi) await page.locator('#teach-form [name=target]').selectOption(bpi[0]);
  await sleep(500);
  manifest.facts.teachPreview = await text('#teach-preview');
  await still('review-teach');
  await layer('teach-tokens', '#tok-text', { pad: 24, scroll: false });
  await tap('#teach-form button[type=submit]'); mark('save');
  manifest.facts.teachSaved = await waitToast('Format saved').catch(() => toastText());
  await sleep(1500);
}
await recStop({ note: 'Teach this format: tap the amount, then the merchant, pick the wallet, save' });
log('teach', manifest.facts.teachPreview, '|', manifest.facts.teachSaved);
await hideToast();
await setTab('review');
manifest.facts.reviewAfter = await reviewCards();
await still('review-after');

// ---------------------------------------------------------------- Statement import (real file chooser and password)
await tab('home');
await recStart('statement');
await sleep(400);
await tap('#topbar [data-action="settings"]'); mark('settings');
await sheet('Settings');
await tap('#sheet [data-action="statementSheet"]'); mark('statement');
await sheet('Import a statement');
await still('statement-pick');
const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 * SLOW }), tap('#sheet [data-action="stmtFile"]')]);
await fc.setFiles(path.join(REPO, 'tests/fixtures/statement-gcash.pdf'));
mark('file');
await sheet('Statement password');
await sleep(300);
await still('statement-password');
mark('password');
await type('#stmt-pw [name=pw]', 'pitaka1234', 80);
await sleep(300);
await still('statement-password-typed');
await tap('#stmt-pw button[type=submit]'); mark('unlock');
await until(() => !!document.querySelector('#sheet .stmt-rows'), null, 30000);
await sheet('Check the rows');
mark('rows');
await sleep(1000);
manifest.facts.statementRows = await ev(() => [...document.querySelectorAll('#sheet .stmt-row')].map((r) => ({ cls: r.className.replace('row stmt-row ', ''), text: r.innerText.replace(/\s+/g, ' ').trim() })));
manifest.facts.statementSum = await text('#sheet .stmt-sum').catch(() => null);
manifest.facts.statementButton = await text('#sheet [data-action="stmtImport"]');
await still('statement-rows');
await tap('#sheet [data-action="stmtImport"]'); mark('import');
manifest.facts.statementToast = await waitToast('imported', 15000).catch(() => toastText());
await sheet('Statement balance').catch(() => {});
mark('balance');
manifest.facts.statementBalance = await text('#sheet');
await sleep(700);
await still('statement-balance');
await layer('statement-match', '#sheet .ok-row', { pad: 24, scroll: false }).catch((e) => log('match layer', e.message));
await sleep(1500);
await recStop({ note: 'Settings → Import a statement: the locked GCash PDF, its password, the rows, Import, the balance check' });
log('statement', JSON.stringify({ rows: manifest.facts.statementRows, toast: manifest.facts.statementToast, balance: manifest.facts.statementBalance }));
await closeSheet();
await hideToast();

// ---------------------------------------------------------------- Debts
await recStart('debts');
await sleep(300);
await tab('debts'); mark('debts');
await settle();
await sleep(900);
manifest.facts.debts = await ev(() => document.querySelector('#main').innerText.replace(/\n+/g, ' | '));
await still('debts');
await tap('#main .segmented [data-action="debtsTab"][data-sub="owed"]'); mark('owed');
await settle();
await sleep(1100);
manifest.facts.debtsOwed = await ev(() => document.querySelector('#main').innerText.replace(/\n+/g, ' | '));
await still('debts-owed');
await recStop({ note: 'Debts: you owe, then owed to you' });
await tap('#main .segmented [data-action="debtsTab"][data-sub="owe"]');
await page.waitForTimeout(700);
await layer('debts-hero', '#main .debts-hero', { pad: 30, scroll: false });
const debtFree = await ev(() => [...document.querySelectorAll('#main .tile')].findIndex((t) => t.innerText.includes('Debt-free by')));
if (debtFree >= 0) await layer('debt-free', `#main .tile >> nth=${debtFree}`, { pad: 30, scroll: false });

// ---------------------------------------------------------------- Plan: goals, bills, budgets
await recStart('plan');
await sleep(300);
await tab('plan'); mark('goals');
await sleep(800);
await still('plan-goals');
manifest.facts['plan-goals'] = await ev(() => document.querySelector('#main').innerText.replace(/\n+/g, ' | '));
for (const sub of ['bills', 'budgets']) {
  const b = page.locator(`#main [data-action="planTab"][data-sub="${sub}"]`);
  if (await b.count()) { await tapLoc(b, sub); mark(sub); await sleep(1200); await still(`plan-${sub}`); manifest.facts[`plan-${sub}`] = await ev(() => document.querySelector('#main').innerText.replace(/\n+/g, ' | ')); }
}
await recStop({ note: 'Plan: goals, bills, budgets' });

// ---------------------------------------------------------------- Reports: pay period
await recStart('reports');
await sleep(300);
await tab('reports'); mark('reports');
await sleep(500);
await tap('#main [data-action="reportMode"][data-sub="period"]'); mark('period');
await settle();
await sleep(1300);
manifest.facts.reportPeriod = await ev(() => document.querySelector('#main').innerText.replace(/\n+/g, ' | '));
await still('reports-period');
await recStop({ note: 'Reports → Pay period' });
await layer('report-tiles', '#main .tiles.four', { pad: 30, scroll: false }).catch(() => {});

// ---------------------------------------------------------------- Home at the end
await tab('home');
await settle();
await page.waitForTimeout(600);
manifest.facts.homeEnd = await homeFacts();
await still('home-end');

execFileSync('cp', [path.join(REPO, 'icons/icon-512.png'), path.join(OUT, 'icon-512.png')]);
writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(manifest, null, 2));
log('wrote', path.join(OUT, 'capture.json'));
await browser.close();
if (server) server.kill();
