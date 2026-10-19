// Writes docs/SETUP-SHORTCUTS.md from js/guide.js, so the page and the in-app guide never drift apart.
// node tools/make-docs.mjs   (tests/guide.test.mjs fails when the page is out of date)
import { writeFileSync } from 'node:fs';
import { guideMarkdown } from '../js/guide.js';

writeFileSync(new URL('../docs/SETUP-SHORTCUTS.md', import.meta.url), `${guideMarkdown()}\n`);
console.log('docs/SETUP-SHORTCUTS.md written');
