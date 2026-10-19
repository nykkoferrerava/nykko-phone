// The service worker precaches every file the app loads, so Pitaka opens offline after an update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const sw = read('sw.js');
const files = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

test('every module, vendored file, icon and the shell are in FILES, and all of them exist', () => {
  const want = ['index.html', 'app.css', 'manifest.webmanifest',
    ...readdirSync(path.join(root, 'js')).map((f) => `js/${f}`),
    ...readdirSync(path.join(root, 'vendor/pdfjs')).filter((f) => f.endsWith('.mjs')).map((f) => `vendor/pdfjs/${f}`),
    ...readdirSync(path.join(root, 'icons')).map((f) => `icons/${f}`)];
  assert.deepEqual(want.filter((f) => !files.includes(f)), [], 'missing from FILES in sw.js');
  assert.deepEqual(files.filter((f) => !existsSync(path.join(root, f))), [], 'listed in FILES but not in the repository');
});
test('every relative import and every file index.html refers to is precached', () => {
  const refs = new Set();
  for (const f of readdirSync(path.join(root, 'js'))) {
    for (const m of read(`js/${f}`).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|new URL\(\s*)['"](\.\.?\/[^'"]+)['"]/g)) refs.add(path.posix.normalize(`js/${m[1]}`));
  }
  for (const m of read('index.html').matchAll(/(?:src|href)="(?:\.\/)?([^"#:]+)"/g)) refs.add(m[1]);
  assert.deepEqual([...refs].filter((f) => !files.includes(f)), []);
});
test('the version was bumped for v3', () => {
  assert.match(sw, /const VERSION = 'pitaka-v3/);
});
