# pdf.js (vendored)

Pitaka reads PDF statements with Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/), copied here so
Pitaka never loads code from another site at runtime.

- Package: `pdfjs-dist@6.4.299` (npm), the **legacy** build (`legacy/build/`). The legacy build carries
  its own polyfills (for example `Math.sumPrecise`, `Map.prototype.getOrInsertComputed`) so it runs on
  iOS 26 Safari and in Node for the tests; the modern build calls those directly.
- Tarball: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz
  (integrity `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`, checked)
- Files, unchanged:
  - `pdf.min.mjs` sha256 `bccc24ea711db8e44503629519904a5292d73b9daaa214bbe7cdcc282b0f4259`
  - `pdf.worker.min.mjs` sha256 `145d2dd3ab0c86151011dba95acfa2d5336e2accd59388ea43dbee0efddaaec6`
- License: Apache-2.0 (`LICENSE`).

Only text is read (`getTextContent`), with `isEvalSupported: false`, so the strict Content-Security-Policy
in index.html (no `unsafe-eval`) is enough. js/statements.js loads it only when a PDF is picked; sw.js
precaches it for offline use.

To update: download the new `pdfjs-dist` tarball, check its integrity against
`npm view pdfjs-dist@<version> dist.integrity`, copy `legacy/build/pdf.min.mjs`,
`legacy/build/pdf.worker.min.mjs` and `LICENSE`, update this file, bump `VERSION` in sw.js and run
`node --test tests/*.test.mjs`.
