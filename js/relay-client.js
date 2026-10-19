// Talking to the inbox relay (relay/worker.js): pairing, collecting and acknowledging items, publishing
// the shortcut config. Only fetch and WebCrypto, so the tests run it under Node against the real Worker.
//
// Pairing makes an ECDH P-256 key pair whose private key can't be exported (it stays in IndexedDB on
// this phone), plus two random 256-bit tokens. The relay only ever sees the public key and the tokens'
// SHA-256 hashes.

const INFO = 'pitaka-relay-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

// `reason`, when the relay gives one: 'paired-again' or 'token-replaced' (with code 'auth'), 'pair-paused'.
export class RelayError extends Error {
  constructor(message, code, status = 0, reason = '') { super(message); this.name = 'RelayError'; this.code = code; this.status = status; this.reason = reason; }
}

let fetchFn = (...a) => globalThis.fetch(...a);
// Tests route requests straight to the Worker.
export function useFetch(fn) { fetchFn = fn; }

export const b64u = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export function fromB64u(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const newToken = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
export async function sha256hex(s) {
  return [...new Uint8Array(await subtle().digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// A setup secret to paste into Cloudflare as ADMIN_SECRET (never kept by Pitaka).
export const newAdminSecret = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(24)));

// "pitaka-relay.name.workers.dev" or a pasted URL -> "https://pitaka-relay.name.workers.dev".
export function relayUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new RelayError('Paste your relay address first', 'invalid');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new RelayError("That doesn't look like a web address", 'invalid'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new RelayError('The relay address must start with https://', 'invalid');
  if (u.username || u.password || u.search || u.hash) throw new RelayError('Use just the address, like https://pitaka-relay.you.workers.dev', 'invalid');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

async function call(base, path, { method = 'GET', token, body, timeout = 15000 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl?.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (e) {
    throw new RelayError(e?.name === 'AbortError' ? 'The relay took too long to answer' : "Couldn't reach the relay", 'network');
  } finally { if (timer) clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return data || {};
  const msg = typeof data?.error === 'string' ? data.error : `The relay answered ${res.status}`;
  const reason = typeof data?.reason === 'string' ? data.reason : '';
  // A paused pairing lasts an hour, not "a minute": its own code, so the relay's message is shown.
  const code = res.status === 401 ? 'auth' : res.status === 403 ? 'origin' : res.status === 409 ? 'unpaired' : res.status === 429 ? (reason === 'pair-paused' ? 'paused' : 'busy') : res.status === 507 ? 'full' : res.status >= 500 ? 'server' : 'invalid';
  throw new RelayError(msg, code, res.status, reason);
}

// Checks that an address is a Pitaka relay. Returns { paired }.
export async function probe(url) {
  const r = await call(relayUrl(url), '/');
  if (r?.service !== 'pitaka-relay') throw new RelayError("That address answers, but it isn't a Pitaka relay", 'invalid');
  return { paired: !!r.paired };
}

// Pairs with the relay. Returns { relay: { url, read, write, pairedAt }, privateKey, pending }: keep
// `relay` and `privateKey` in the secrets store (never in a backup). `keepWrite`: the write token your
// shortcuts already have (after a restore or on a new phone), so they keep working unchanged.
export const isToken = (s) => typeof s === 'string' && /^[\w-]{43}$/.test(s);
export async function pair(url, adminSecret, { keepWrite = '' } = {}) {
  const base = relayUrl(url);
  const secret = String(adminSecret || '').trim();
  if (!secret) throw new RelayError('Enter the setup secret (ADMIN_SECRET)', 'invalid');
  const keys = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const jwk = await subtle().exportKey('jwk', keys.publicKey);
  const keep = String(keepWrite || '').trim();
  if (keep && !isToken(keep)) throw new RelayError("That write token isn't complete: copy all 43 characters from your shortcut", 'invalid');
  const read = newToken();
  const write = keep || newToken();
  const r = await call(base, '/pair', { method: 'POST', token: secret, body: { publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, readHash: await sha256hex(read), writeHash: await sha256hex(write) } });
  return { relay: { url: base, read, write, pairedAt: Date.now() }, privateKey: keys.privateKey, pending: Number(r.pending) || 0 };
}

// One sealed item -> the object your shortcut sent. Throws if it wasn't sealed to this key.
export async function openBox(privateKey, box) {
  if (!box || box.v !== 1 || box.alg !== 'ECDH-ES+A256GCM') throw new RelayError('Unknown item format', 'invalid');
  const epk = fromB64u(box.epk);
  const eph = await subtle().importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
  const hk = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64u(box.iv), additionalData: enc.encode(INFO) }, key, fromB64u(box.ct));
  return JSON.parse(dec.decode(pt));
}

// Everything waiting on the relay, opened. Nothing is deleted until ack(). Items that can't be opened
// (sealed for an earlier pairing) come back in `unreadable` so the caller can say so and clear them.
export async function collect(relay, privateKey, { maxPages = 20 } = {}) {
  const items = [];
  const unreadable = [];
  let after = '';
  for (let page = 0; page < maxPages; page++) {
    const r = await call(relay.url, `/pull${after ? `?after=${encodeURIComponent(after)}` : ''}`, { token: relay.read });
    for (const x of r.items || []) {
      try { items.push({ key: x.key, item: await openBox(privateKey, x.box) }); } catch { unreadable.push(x.key); }
    }
    if (!r.more || !r.after) break;
    after = r.after;
  }
  return { items, unreadable };
}

// Deletes collected items from the relay.
export async function ack(relay, keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 500) deleted += Number((await call(relay.url, '/ack', { method: 'POST', token: relay.read, body: { keys: keys.slice(i, i + 500) } })).deleted) || 0;
  return deleted;
}

export const publishConfig = (relay, cfg) => call(relay.url, '/config', { method: 'PUT', token: relay.read, body: cfg });
export const readConfig = (relay, token = relay.write) => call(relay.url, '/config', { token });
export const status = (relay) => call(relay.url, '/status', { token: relay.read });

// Sends an item with the write token, as a shortcut would ("Send a test from Pitaka").
export const send = (relay, item) => call(relay.url, '/in', { method: 'POST', token: relay.write, body: item });

// A new write token; the old one stops working at once (every shortcut needs the new one).
export async function rotateWrite(relay) {
  const write = newToken();
  await call(relay.url, '/rotate', { method: 'POST', token: relay.read, body: { writeHash: await sha256hex(write) } });
  return { ...relay, write };
}
