// For the relay tests: the app's folder, without env.mjs's frozen clock, and quiet about node:sqlite
// (the mocked D1) being experimental.
import { pathToFileURL } from 'node:url';

export const APP = process.env.PITAKA_DIR ? pathToFileURL(process.env.PITAKA_DIR).href.replace(/\/$/, '') : new URL('..', import.meta.url).href.replace(/\/$/, '');

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
