# Pitaka v3 plan

v3 keeps everything v2 does and adds capture from the iPhone (Back Tap, SMS, email, Wallet), a Review
inbox, statement import, receivables and a premium UI. It stays a plain PWA: ES modules, CSS and HTML,
no build step, served by GitHub Pages.

## Architecture

```
Shortcuts (Back Tap, automations) ──POST /in──▶ relay Worker (encrypts, D1, 30-day expiry)
                                  └─append──▶ iCloud Drive/Shortcuts/Pitaka/inbox.jsonl (offline copy)
Pitaka (on open / foreground) ──GET /pull──▶ decrypt ──▶ inbox.js pipeline ──▶ store.js ──▶ IndexedDB
                                                         quickparse / alerts / reconcile
                              ──POST /ack (only after the save is durable)
                              ──PUT /config (categories + wallets for the shortcuts)
```

DOM-free modules (all run under `node --test`):

| File | Job |
| --- | --- |
| `js/storage.js` | Storage adapters: IndexedDB (app), localStorage (fallback, v2-compatible), memory (tests). |
| `js/store.js` | All data logic. Synchronous mutations with tracked change sets; durable, atomic flush. |
| `js/quickparse.js` | `150 lunch gcash` → amount, category, wallet, kind, note, confidence. |
| `js/alerts.js` | Institution parser registry (all labelled `unverified`), teachable templates. |
| `js/reconcile.js` | Duplicate detection, linking, reference merge, transfer pairing, statement row matching. |
| `js/inbox.js` | Pipeline: raw items → parsed events → reconcile → auto-apply or Review. Undo per batch. |
| `js/statements.js` | PDF text items / CSV → table → column mapping → rows. |
| `js/csv.js` | CSV export with escaping and a formula-injection guard. |
| `js/insights.js` | Subscription detection, budget status. |
| `js/guide.js` | Single source for the "Connect your iPhone" guide (in-app and `docs/SETUP-SHORTCUTS.md`). |
| `js/relay-client.js` | Pairing, pull, ack, config, ECDH-ES + AES-GCM decrypt (WebCrypto; testable in Node). |
| `relay/worker.js` | The Cloudflare Worker (single file, so it can be pasted into the dashboard). |

## Storage (milestone 2)

- IndexedDB database `pitaka`: `meta` (schema, migration state, core document), `txns` and `inbox`
  (one record each, so years of entries never rewrite everything), `secrets` (relay tokens, the
  non-extractable private key; never exported).
- `store.js` keeps its synchronous API. Every mutation still runs through `tx()`: a throw inside rolls
  memory back exactly. Changes are staged and written in one IndexedDB transaction; `await S.flush()`
  resolves once they are durable. If the write fails, memory is rolled back to the last durable state and
  `flush()` rejects with `StoreError` (UI handlers await it before closing a sheet, as v2 did with the sync
  throw). Concurrent changes during a write are handled (layered undo).
- Migration from v2's `localStorage['pitaka.data']`: copy → read back and compare → mark `copied`. The
  old key is never written by v3 and is removed only after a later launch finds the IndexedDB copy intact
  (`verified`). If IndexedDB is unusable, Pitaka falls back to the v2 key (still readable by v2).
- `navigator.storage.persist()` on boot. Raw alert text older than N days (setting, default 90) is trimmed
  to the parsed fields.

## UI foundation (milestone 3)

Theme setting (System / Light / Dark, applied before first paint by `js/boot.js`, live `theme-color`),
audited tokens, large-title header that collapses into a translucent bar, floating glass tab bar,
drag-to-dismiss sheets with spring easing, `-apple-system-body` type scale (follows Dynamic Type),
tabular numerals, count-up hero, haptics via `<input type=checkbox switch>`, reduced motion, SVG sprite
for all chrome.

## Features (milestone 4)

- Payday on Friday: "When is your next payday?" picker limited to the next two Fridays; `payAnchor`
  stays the 14-day anchor. Home shows "Next payday: Fri, Oct 23 · 5 days".
- Receivables (owed to you): `lend` / `collect` entries move wallet money; "Owed to you" total.
- Categories: rename, emoji, reorder, add, hide, merge (moves entries and bills), keywords for quick text.
- Bills: one-tap "Mark paid" on Home; subscription suggestions from repeated expenses.
- Wallet balance fixes become visible, undoable `adjust` entries (reason `correction`).
- CSV export (transactions with date range + wallet filter, debts, goals, receivables).
- Pay-period report (income, spending, saved, debt paid, top categories and merchants).

## Capture and Review (milestones 5–7)

- Quick add keypad/text, SMS, email, Wallet and balance items share one pipeline.
- Only high-confidence results apply automatically; everything else lands in Review (unparsed,
  low-confidence, possible duplicate, balance drift, transfer?). Every automatic change can be undone.
- Teach this format: tap amount / merchant / balance / reference → saved template
  (`You have paid {amount} to {merchant}…`), editable in Settings → Inbox and alerts → Alert formats; part of backups.
- Relay: Cloudflare Worker + D1 (chosen over KV for strong consistency; justified in the code), write/read token scopes, constant-time compare,
  rate limits, ECDH-ES (P-256) + AES-GCM per item, ack-then-delete, 30-day expiry, CORS to the Pages origin.
- Statement import: vendored pdf.js (lazy, precached), password prompt never stored, CSV, column mapping
  preview reusing the debt-import table, existing rows marked, reconciliation of the closing balance.

## Guide and docs (milestone 8)

In-app "Connect your iPhone" checklist with Copy and Test buttons, mirrored in `docs/SETUP-SHORTCUTS.md`
(generated from `js/guide.js`, checked by a test). Each shortcut appends a Dictionary to inbox.jsonl and
posts the same keys as Request Body JSON fields (what a Dictionary sends as a File body isn't documented).
Action names follow the iOS 26 Shortcuts app. `docs/SETUP-RELAY.md`, `docs/ALERT-FORMATS.md`, README.

## Verification (milestone 9)

`node --test tests/*.test.mjs` before every commit; security pass (escaping, CSP, no third-party
requests, secrets out of backups/logs/URLs); Playwright screenshots at iPhone 15 size in light and dark;
scripted v2 → v3 upgrade check through the real service worker.

## Platform limits accepted up front

- A shortcut can't open the home-screen app, so entries appear the next time Pitaka opens or returns to
  the foreground.
- iOS doesn't let any app read push notifications, so GoTyme (push-only) relies on balance checks and
  statements.
- Shortcuts stops on a network error; the shortcut writes the JSON line to iCloud Drive first, so nothing
  is lost, and caches the config it fetched last time for the category and wallet lists.
- Built-in alert formats are best-effort and labelled unverified until real samples confirm them.
