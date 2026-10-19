// "Connect your iPhone" in the app: the checklist, each shortcut's steps with your values and Copy
// buttons, and Test, which watches for the shortcut's next item (js/guide.js has the steps).
import * as S from './store.js';
import * as Sync from './sync.js';
import { SHORTCUTS, BEFORE, shortcut, fill } from './guide.js';
import { esc } from './util.js';
import { $, icon, openSheet, sheetHead, toast, haptic } from './ui-core.js';
import { relaySheet, docsLink, copyText, relayMessage, guideHooks } from './ui-connect.js';

const values = () => {
  const cfg = S.shortcutConfig();
  const i = Sync.info();
  return { url: i.url, token: i.write, categories: cfg.categories.join('\n'), wallets: cfg.wallets.join('\n') };
};
// `code` and **bold** from the guide text, after escaping.
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const needsRelay = (tpl) => /\{(URL|TOKEN)\}/.test(tpl);
const arrived = (s) => S.db.inbox.some((x) => s.types.includes(x.type));

let from = 'settings';
export function connectGuide(origin = from) {
  from = origin || 'settings';
  const paired = Sync.paired();
  const done = SHORTCUTS.filter(arrived).length;
  const core = SHORTCUTS.filter((s) => !s.optional);
  const coreDone = core.filter(arrived).length + (paired ? 1 : 0);
  openSheet(`${sheetHead('Connect your iPhone', { back: from === 'settings' ? ['Settings', 'settings'] : null, close: 'Done' })}
    <p class="pad meta">Log expenses with a double-tap on the back of your iPhone, and let GCash and bank alerts fill in Pitaka. Your shortcuts only collect and send; Pitaka does the rest when you open it.</p>
    <div class="card row ok-row"><span class="icon accent" aria-hidden="true">${icon('phone')}</span><span class="grow"><span class="title">${coreDone} of ${core.length + 1} set up</span><span class="meta">${done ? `${done} shortcut${done === 1 ? '' : 's'} already reached Pitaka` : 'Start with the relay, then Quick Add'}</span></span></div>
    <ol class="list card guide-list">
      ${row('relaySheet', 'cloud', 'Inbox relay', paired ? `Paired with ${Sync.relayHost()}` : 'First · a free Cloudflare Worker you own, about 10 minutes', paired, 'data-from="connect"')}
      ${SHORTCUTS.map((s) => row('shortcutGuide', s.icon, s.title, s.when, arrived(s), `data-id="${esc(s.id)}"`, s.optional)).join('')}
    </ol>
    <h3>Before you build them</h3>
    <ul class="pad guide-before">${BEFORE.map((b) => `<li>${md(b)}</li>`).join('')}</ul>
    <div class="list card">${docsLink('SETUP-SHORTCUTS.md', 'All the steps on one page')}${docsLink('SETUP-RELAY.md', 'Setting up the relay')}</div>`);
}
function row(action, ic, title, meta, ok, extra = '', optional = false) {
  return `<li><button type="button" class="row" data-action="${action}" ${extra}><span class="icon ${ok ? 'accent' : ''}" aria-hidden="true">${icon(ok ? 'check-circle' : ic)}</span><span class="grow"><span class="title">${esc(title)}${optional ? ' <span class="chip">Optional</span>' : ''}</span><span class="meta">${esc(meta)}</span></span>${ok ? '<span class="sr-only">Done</span>' : ''}<span class="chev" aria-hidden="true">${icon('right')}</span></button></li>`;
}

// ------------------------------------------------------------------ one shortcut
export function shortcutGuide(id) {
  const s = shortcut(id);
  if (!s) return;
  const v = values();
  const paired = Sync.paired();
  const copyRow = (label, tpl, k, extra = '') => {
    const shown = tpl.includes('{TOKEN}') ? fill(tpl, { ...v, token: v.token ? '•'.repeat(12) + v.token.slice(-4) : '' }) : fill(tpl, v);
    const off = needsRelay(tpl) && !paired;
    return `<div class="g-copy${tpl.includes('\n') || tpl.startsWith('{CAT') || tpl.startsWith('{WAL') ? ' block' : ''}">${label ? `<span class="meta">${esc(label)}</span>` : ''}<code>${esc(shown)}</code><button type="button" class="btn small tinted" data-action="copy" data-k="g" data-s="${esc(s.id)}" data-i="${k}" ${extra} ${off ? 'disabled' : ''} aria-label="Copy ${esc(label || 'this')}">${icon('copy')}Copy</button></div>`;
  };
  openSheet(`${sheetHead(esc(s.title), { back: ['Connect', 'connectGuide'] })}
    <p class="pad"><b>${esc(s.when)}.</b> ${md(s.what)}</p>
    ${paired ? '' : `<div class="banner warning" role="status">${icon('cloud')}<div><strong>Pair your relay first</strong><span class="meta">The steps need its address and write token. Until then they show where those go.</span></div><button type="button" class="btn small primary" data-action="relaySheet" data-from="connect">Set up</button></div>`}
    <h3>Set up</h3>
    <ol class="guide-steps">${s.setup.map((x, i) => `<li><span class="g-n">${i + 1}</span><div class="g-body"><p>${md(x)}</p></div></li>`).join('')}</ol>
    <h3>Actions, in order</h3>
    <ol class="guide-steps">${s.steps.map((st, i) => `<li><span class="g-n">${i + 1}</span><div class="g-body">
      <p><b class="g-act">${esc(st.a)}</b> ${md(st.d)}</p>
      ${st.copy ? copyRow('', st.copy, `${i}`) : ''}
      ${st.copy2 ? copyRow(st.copy2[0], st.copy2[1], `${i}`, 'data-w="2"') : ''}
      ${st.keys ? `<table class="g-keys"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${st.keys.map(([k, val]) => `<tr><td><code>${esc(k)}</code></td><td>${md(val)}</td></tr>`).join('')}</tbody></table>` : ''}
    </div></li>`).join('')}</ol>
    ${s.after.length ? `<h3>Then</h3><ol class="guide-steps">${s.after.map((x, i) => `<li><span class="g-n">${i + 1}</span><div class="g-body"><p>${md(x)}</p></div></li>`).join('')}</ol>` : ''}
    <h3>Test it</h3>
    <div class="card g-test">
      <p>${md(s.test)}</p>
      <p class="meta" id="g-test" aria-live="polite">${arrived(s) ? `${icon('check-circle')} This one has reached Pitaka before.` : 'Tap Test, then run it.'}</p>
      <button type="button" class="btn primary block" data-action="testShortcut" data-id="${esc(s.id)}" ${paired ? '' : 'disabled'}>${icon('refresh')}Test</button>
    </div>`);
}

// The value a guide Copy button copies, with your relay, token and lists filled in.
export function guideCopy({ s, i, w }) {
  const st = shortcut(s)?.steps[Number(i)];
  if (!st) return;
  const tpl = w === '2' ? st.copy2?.[1] : st.copy;
  if (!tpl) return;
  if (needsRelay(tpl) && !Sync.paired()) return toast('Pair your relay first', { sub: 'Settings → Inbox relay' });
  return copyText(fill(tpl, values()), tpl.includes('{TOKEN}') ? 'Copied, with your write token' : 'Copied');
}
guideHooks.copy = guideCopy;

// ------------------------------------------------------------------ Test
// Watches for the shortcut's next item for three minutes while its page is open. The relay stamps when
// it received an item; a little slack covers a phone clock that runs ahead.
let watch = null;
const say = (html) => { const el = $('#g-test'); if (el) el.innerHTML = html; return !!el; };
export function testShortcut(id) {
  const s = shortcut(id);
  if (!s || !Sync.paired()) return;
  if (watch) clearTimeout(watch.timer);
  watch = { s, since: Date.now() - 15000, until: Date.now() + 3 * 60 * 1000, timer: 0 };
  say(`${icon('clock')} Waiting… run <b>${esc(s.name)}</b> now, then come back here.`);
  tick();
}
async function tick() {
  const w = watch;
  if (!w) return;
  clearTimeout(w.timer);
  if (!$('#g-test')) { watch = null; return; } // the page was closed
  try { await Sync.collect({ force: true }); } catch (e) { say(`${icon('alert')} ${esc(relayMessage(e))}`); }
  if (watch !== w) return;
  const got = S.db.inbox.find((x) => w.s.types.includes(x.type) && x.receivedAt >= w.since);
  if (got) {
    watch = null;
    haptic();
    say(`${icon('check-circle')} <b>Arrived.</b> ${esc(w.s.title)} reaches Pitaka.`);
    toast(`${w.s.title} works`, { icon: 'check-circle', sub: got.status === 'test' ? 'It was a test, so nothing was added.' : 'Pitaka handled what it sent.' });
    return;
  }
  if (Date.now() > w.until) {
    watch = null;
    say(`${icon('alert')} Nothing arrived in 3 minutes. Check the relay address and token in Get Contents of URL, and that the shortcut ran without an error.`);
    return;
  }
  w.timer = setTimeout(tick, 3000);
}
// Back from the Shortcuts app: look at once.
document.addEventListener('visibilitychange', () => { if (!document.hidden && watch) tick(); });

export const GUIDE_ACTIONS = {
  connectGuide: ({ from: f }) => connectGuide(f || from),
  shortcutGuide: ({ id }) => shortcutGuide(id),
  testShortcut: ({ id }) => testShortcut(id),
  relayFromGuide: () => relaySheet('connect'),
};
