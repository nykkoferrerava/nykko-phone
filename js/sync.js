// Collecting from the relay: when Pitaka opens, when it comes back to the foreground, and from "Check
// now". DOM-free, so the tests run it under Node against the real Worker.
//
//   pull (sealed) -> open with the private key -> inbox pipeline -> saved to disk -> acknowledged
// Items are only deleted from the relay after Pitaka has saved them. If saving fails, they stay on the
// relay and come again next time; the client ids make a second delivery harmless.
import * as S from './store.js';
import * as R from './relay-client.js';
import { cleanRaw, processItems } from './inbox.js';

const state = { relay: null, key: null, loaded: false, running: null, lastOk: 0, lastTry: 0, lastError: null };
const MIN_GAP = 3000; // foreground events come in bursts; one collection covers them

// Reads the pairing from the secrets store (IndexedDB). Call once after S.load().
export async function loadPairing() {
  try {
    state.relay = (await S.secrets.get('relay')) || null;
    state.key = (await S.secrets.get('relayKey')) || null;
  } catch { state.relay = null; state.key = null; }
  if (!state.relay?.url || !state.relay.read || !state.key) { state.relay = null; state.key = null; }
  state.loaded = true;
  return paired();
}
export const paired = () => !!(state.relay && state.key);
export const relayHost = () => { try { return state.relay ? new URL(state.relay.url).host : ''; } catch { return ''; } };
export function info() {
  return { paired: paired(), url: state.relay?.url || '', write: state.relay?.write || '', pairedAt: state.relay?.pairedAt || 0, lastOk: state.lastOk, lastTry: state.lastTry, lastError: state.lastError };
}
// Pairing keeps a private key that can't be exported. Only IndexedDB can hold one across launches.
export const canPair = () => ['indexeddb', 'memory'].includes(S.storageInfo().kind);

// Pairs with a relay. `keepWrite`: a write token your shortcuts already use, so they keep working.
export async function pairWith(url, adminSecret, { keepWrite = '' } = {}) {
  if (!canPair()) throw new R.RelayError("Pitaka can't keep the relay's key with the older storage this phone is using", 'storage');
  // Anything still waiting for the current pairing is collected first.
  if (paired()) await collect({ force: true }).catch(() => {});
  const p = await R.pair(url, adminSecret, { keepWrite });
  await S.secrets.set('relay', p.relay);
  await S.secrets.set('relayKey', p.privateKey);
  await S.secrets.del('relayCfg');
  state.relay = p.relay;
  state.key = p.privateKey;
  state.lastError = null;
  S.updateSettings({ relayUrl: p.relay.url });
  await S.flush();
  await publishConfig().catch(() => {});
  return p;
}

export async function unpair() {
  await S.secrets.del('relay');
  await S.secrets.del('relayKey');
  await S.secrets.del('relayCfg');
  state.relay = null;
  state.key = null;
  state.lastOk = 0;
  state.lastError = null;
}

// The categories and wallets your shortcuts list, sent when they changed since the last time.
export async function publishConfig({ force = false } = {}) {
  if (!paired()) return false;
  const cfg = S.shortcutConfig();
  const sig = JSON.stringify(cfg);
  if (!force && (await S.secrets.get('relayCfg')) === sig) return false;
  await R.publishConfig(state.relay, cfg);
  await S.secrets.set('relayCfg', sig);
  return true;
}

// Where a pull's items came from, for "1 new entry from Quick Add".
const FROM = { entry: 'Quick Add', text: 'Quick Add', sms: 'SMS', email: 'email', wallet: 'Apple Wallet', balance: 'Update Balance' };
function fromLabel(out) {
  const labels = new Set(out.ids.map((id) => FROM[S.inboxItem(id)?.type]).filter(Boolean));
  return labels.size === 1 ? [...labels][0] : 'your iPhone';
}

// One collection. Resolves to null when there was nothing to do, or to
// { out, from, unreadable, skipped } (out: what processItems did). Throws a RelayError or a StoreError.
export function collect({ force = false } = {}) {
  if (!paired()) return Promise.resolve(null);
  if (state.running) return state.running;
  if (!force && Date.now() - state.lastTry < MIN_GAP) return Promise.resolve(null);
  state.lastTry = Date.now();
  state.running = (async () => {
    try {
      const { items, unreadable } = await R.collect(state.relay, state.key);
      const clean = [];
      const skipped = [];
      for (const x of items) { const c = cleanRaw(x.item); if (c) clean.push(c); else skipped.push(x.key); }
      let out = null;
      if (clean.length) {
        out = processItems(clean, { src: 'relay' });
        await S.flush(); // on disk before anything is deleted from the relay
      }
      const done = [...items.map((x) => x.key), ...unreadable];
      if (done.length) await R.ack(state.relay, done).catch(() => { /* collected again next time, then de-duplicated */ });
      await publishConfig().catch(() => {});
      state.lastOk = Date.now();
      state.lastError = null;
      if (!out && !unreadable.length && !skipped.length) return null;
      return { out, from: out ? fromLabel(out) : '', unreadable: unreadable.length, skipped: skipped.length };
    } catch (e) {
      state.lastError = e?.message || 'Collection failed';
      throw e;
    } finally { state.running = null; }
  })();
  return state.running;
}

// A test item sent with the write token, as a shortcut would, then collected: proves the whole path.
export async function selfTest() {
  if (!paired()) throw new R.RelayError('Pair with your relay first', 'unpaired');
  await R.send(state.relay, { type: 'test', id: `pitaka-test-${Date.now().toString(36)}`, source: 'pitaka' });
  return collect({ force: true });
}

export async function status() {
  if (!paired()) return null;
  const r = await R.status(state.relay);
  return { pending: Math.max(0, Math.trunc(Number(r?.pending)) || 0), pairedAt: String(r?.pairedAt || ''), configAt: r?.configAt ? String(r.configAt) : null };
}

// A new write token: every shortcut needs it pasted in again.
export async function rotateWrite() {
  if (!paired()) throw new R.RelayError('Pair with your relay first', 'unpaired');
  const next = await R.rotateWrite(state.relay);
  await S.secrets.set('relay', next);
  state.relay = next;
  return next.write;
}
