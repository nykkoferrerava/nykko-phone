// For the relay tests: the app's folder, without env.mjs's frozen clock, a mocked D1 database, and
// quiet about node:sqlite (behind the mock) being experimental.
import { pathToFileURL } from 'node:url';

export const APP = process.env.PITAKA_DIR ? pathToFileURL(process.env.PITAKA_DIR).href.replace(/\/$/, '') : new URL('..', import.meta.url).href.replace(/\/$/, '');

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));

// D1's binding API over node:sqlite (imported after the warning filter above). Like D1, binding
// `undefined` is an error, run() and batch() return the rows of a statement that has any, a batch is
// all-or-nothing, and D1's limit of 100 bound parameters a statement holds.
const { DatabaseSync } = await import('node:sqlite');
export function mockD1() {
  const sql = new DatabaseSync(':memory:');
  const exec = (q, args) => {
    if (args.length > 100) throw new Error('D1_ERROR: too many SQL variables');
    const st = sql.prepare(q);
    if (st.columns().length) { const results = st.all(...args); return { success: true, results, meta: { changes: 0 } }; }
    const r = st.run(...args);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  };
  const stmt = (q, args = []) => ({
    q,
    args,
    bind(...a) {
      if (a.some((v) => v === undefined)) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
      return stmt(q, a);
    },
    async first() { return sql.prepare(q).get(...args) ?? null; },
    async all() { return exec(q, args); },
    async run() { return exec(q, args); },
  });
  return {
    sql,
    prepare: (q) => stmt(q),
    async batch(list) {
      sql.exec('BEGIN');
      try { const out = list.map((s) => exec(s.q, s.args)); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
}
