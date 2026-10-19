// The "Connect your iPhone" guide (js/guide.js): docs/SETUP-SHORTCUTS.md matches it, it only names
// real Shortcuts actions, and what each shortcut's Dictionary sends is accepted by the relay and read by
// Pitaka, end to end.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, S, fresh, cat } from './env.mjs';
import { mockD1 } from './env-relay.mjs';

const G = await import(`${APP}/js/guide.js`);
const worker = (await import(`${APP}/relay/worker.js`)).default;
const R = await import(`${APP}/js/relay-client.js`);
const Y = await import(`${APP}/js/sync.js`);
const X = await import(`${APP}/js/inbox.js`);

// The iOS 26 Shortcuts actions the guide may name, as the app labels them. "Get File from Folder" is the
// one that takes a path; the document picker is a separate action (Select File).
const ACTIONS = new Set(['Text', 'Set Variable', 'Get File from Folder', 'If', 'Otherwise', 'End If', 'Get Dictionary from Input', 'Get Dictionary Value', 'Split Text', 'Ask for Input', 'Choose from List',
  'Random Number', 'Dictionary', 'Append to Text File', 'Show Notification', 'Get Contents of URL', 'Save File']);

describe('guide', () => {
  test('docs/SETUP-SHORTCUTS.md is up to date (node tools/make-docs.mjs)', () => {
    const page = readFileSync(new URL('../docs/SETUP-SHORTCUTS.md', import.meta.url), 'utf8');
    assert.equal(page, `${G.guideMarkdown()}\n`);
  });
  test('only real Shortcuts actions, every If closed, tokens only in Copy values', () => {
    for (const s of G.SHORTCUTS) {
      const names = s.steps.map((x) => x.a);
      for (const a of names) assert.ok(ACTIONS.has(a), `${s.id}: ${a}`);
      assert.equal(names.filter((a) => a === 'If').length, names.filter((a) => a === 'End If').length, s.id);
      for (const st of s.steps) assert.ok(!/\{TOKEN\}|\{URL\}/.test(st.d), `${s.id}: ${st.a} names a secret in its text`);
      assert.ok(names.includes('Append to Text File'), `${s.id} keeps a copy in iCloud Drive`);
      assert.ok(names.indexOf('Append to Text File') < names.indexOf('Get Contents of URL'), `${s.id} saves the copy before sending`);
    }
  });
  test('each POST sends the same keys and values as the Dictionary, as JSON fields', () => {
    for (const s of G.SHORTCUTS) {
      const dict = s.steps.find((x) => x.a === 'Dictionary');
      const posts = s.steps.filter((x) => x.a === 'Get Contents of URL' && x.copy === '{URL}/in');
      assert.equal(posts.length, 1, s.id);
      assert.match(posts[0].d, /Request Body \*\*JSON\*\*/, `${s.id} posts JSON fields`);
      assert.deepEqual(posts[0].keys, dict.keys, `${s.id}: the POST and the Dictionary match`);
    }
  });
  test('fill() puts in your values, or readable stand-ins', () => {
    assert.equal(G.fill('{URL}/in', { url: 'https://r.x.workers.dev' }), 'https://r.x.workers.dev/in');
    assert.equal(G.fill('Bearer {TOKEN}'), 'Bearer <your write token>');
  });
  test('the ids the shortcuts make are ids the relay and Pitaka accept', () => {
    for (const p of ['kp', 'qt', 'bal', 'sms', 'em', 'wl']) assert.match(`${p}-20261013124100-123456`, /^[A-Za-z0-9._:-]{6,64}$/);
  });
});

describe('guide: each shortcut end to end', () => {
  // What each shortcut's JSON body holds when it runs (all Text fields, as the guide says).
  const sample = {
    keypad: { type: 'entry', amount: '150', category: '🍜 Food', wallet: 'GCash', note: '' },
    text: { type: 'text', text: 'grab 175 gcash' },
    balance: { type: 'balance', wallet: 'GCash', amount: '5000' },
    sms: { type: 'sms', sender: 'GCash', text: 'You have paid P289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref. No. 9876543210123.' },
    email: { type: 'email', from: 'alerts@bank.example', subject: 'Transaction alert', body: 'PHP 1,200.00 was charged to your card ending 1234 at LAZADA.' },
    wallet: { type: 'wallet', merchant: 'Starbucks', amount: '₱180.00', card: 'BPI Gold' },
  };
  test('the Dictionary keys match what the relay accepts and Pitaka reads', async () => {
    fresh();
    S.saveAccount({ name: 'GCash', kind: 'ewallet', opening: 5000, openingDate: '2026-10-01' });
    await S.flush();
    const env = { DB: mockD1(), ADMIN_SECRET: 'correct-horse-battery-staple', LIMIT_IN_PER_MIN: '1000', LIMIT_READ_PER_MIN: '1000' };
    R.useFetch((url, init = {}) => worker.fetch(new Request(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': '10.7.0.1' } }), env));
    const { relay } = await Y.pairWith('https://pitaka-relay.example.workers.dev', 'correct-horse-battery-staple');
    for (const s of G.SHORTCUTS) {
      const body = s.steps.find((x) => x.a === 'Get Contents of URL' && x.copy === '{URL}/in');
      const keys = body.keys.map(([k]) => k);
      const item = { ...sample[s.id], id: `${s.id}-20261013124100-123456`, at: '2026-10-13T12:41:00+08:00' };
      assert.deepEqual(Object.keys(item).sort(), [...keys].sort(), `${s.id}: the sample has the guide's keys`);
      assert.equal(item.type, body.keys.find(([k]) => k === 'type')[1].replaceAll('`', ''));
      assert.ok(s.types.includes(item.type));
      assert.equal((await R.send(relay, item)).ok, true, s.id);
    }
    const got = await Y.collect({ force: true });
    assert.equal(got.out.ids.length + got.out.tests.length, G.SHORTCUTS.length);
    const byType = (t) => S.db.inbox.find((x) => x.type === t);
    for (const s of G.SHORTCUTS) {
      const it = byType(s.types[0]);
      assert.ok(it, s.id);
      for (const [k, v] of Object.entries(sample[s.id])) if (k !== 'type' && v) assert.equal(it.raw[k], v, `${s.id}.${k} reached Pitaka`);
    }
    const kp = S.db.txns.find((t) => t.amount === 150);
    assert.deepEqual([kp?.categoryId, kp?.src], [cat('Food').id, 'quick'], 'the keypad entry became an expense');
    assert.ok(S.db.txns.some((t) => t.amount === 175 && t.categoryId === cat('Transport').id), 'quick text was read');
  });
  test('a Files catch-up line from Append to Text File is the same item, so it is never added twice', () => {
    fresh();
    const line = JSON.stringify({ type: 'entry', id: 'kp-20261013124100-654321', amount: '99', category: '🍜 Food', wallet: 'Cash', note: 'x', at: '2026-10-13T12:41:00+08:00' });
    const a = X.processItems(X.parseJsonl(`${line}\n`).items, { src: 'file' });
    const b = X.processItems(X.parseJsonl(`${line}\n${line}\n`).items, { src: 'relay' });
    assert.equal(a.created.length, 1);
    assert.equal(b.created.length, 0);
    assert.equal(b.duplicates, 2, 'both copies were already there');
  });
});
