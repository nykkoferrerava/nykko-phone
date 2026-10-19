// For the relay tests: the app's folder, without env.mjs's frozen clock, a mocked D1 database, and
// quiet about node:sqlite (behind the mock) being experimental.
import { pathToFileURL } from 'node:url';

export const APP = process.env.PITAKA_DIR ? pathToFileURL(process.env.PITAKA_DIR).href.replace(/\/$/, '') : new URL('..', import.meta.url).href.replace(/\/$/, '');

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));

// D1's binding API over node:sqlite (imported after the warning filter above). Like D1, binding
// `undefined` is an error.
const { DatabaseSync } = await import('node:sqlite');
export function mockD1() {
  const sql = new DatabaseSync(':memory:');
  const stmt = (q, args = []) => ({
    bind(...a) {
      if (a.some((v) => v === undefined)) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
      return stmt(q, a);
    },
    async first() { return sql.prepare(q).get(...args) ?? null; },
    async all() { return { success: true, results: sql.prepare(q).all(...args), meta: {} }; },
    async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}
