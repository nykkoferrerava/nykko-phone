# Pitaka

A personal expense, debt and budget tracker for one person, running on an iPhone as a home-screen web
app. Pesos (₱), Asia/Manila time, English. Plain HTML, CSS and ES modules: no framework, no bundler, no
build step. Hosted on GitHub Pages.

**Your data stays yours.** Everything lives on the phone. The only server is an optional inbox relay you
own (a free Cloudflare Worker) that briefly holds what your shortcuts send, encrypted so only your
phone can read it. Pitaka never asks for, stores or sends a bank, GCash or GoTyme password, OTP or MPIN,
never scrapes a bank website or app, and has no AI features.

## What's new in v3

- **Quick Add from the back of your iPhone.** Double-tap: amount, category, wallet, done. Triple-tap: type
  it like you'd say it (`jollibee 289 gcash`, `sahod 25000`, `lent mel 500`). Pitaka collects it the moment
  you open it: *1 new entry from Quick Add*, with Undo.
- **Bank and GCash alerts fill in Pitaka.** SMS and email automations (and Apple Wallet taps, where your
  card supports them) send alerts to Pitaka. A ₱289 Jollibee you logged and the GCash text about it are
  one purchase, not two. Transfers between your own wallets are paired. Balances in alerts are checked.
- **Review inbox.** Anything Pitaka isn't sure about waits for you: accept, edit, link to an entry, mark as
  a transfer, ignore, or **teach** it an alert format. Everything automatic can be undone.
- **Statement import.** GCash (password-protected PDF), GoTyme, bank PDFs and CSVs, read on the phone.
  Rows you already have are recognised; then the closing balance is checked against Pitaka's.
- **Payday every second Friday**, with "Next payday: Fri, Oct 23 · 5 days" on Home.
- **Owed to you:** money you lent, with partial repayments into a wallet.
- **Budgets** you're close to (80%+) on Home, and a warning when a quick add goes over.
- **Bills** marked paid from Home, and subscriptions found in your spending.
- **Categories:** rename, emoji, reorder, add, hide, merge (moves the entries).
- **Reports:** pay-period report (income, spending, saved, debt paid, top categories and merchants) and CSV
  export of transactions, debts, goals and money owed to you.
- **Light and dark** (or follow the system), a large-title header, translucent tab bar and sheets you can
  drag down, and support for larger text.
- **Storage moved to IndexedDB**, copied from v2's storage and checked before the old copy is removed.
  Updating from v2 keeps everything.

## Set it up, in this order

1. **Turn on GitHub Pages:** repository **Settings → Pages → Deploy from a branch**, pick the branch and
   `/ (root)`. On GitHub's free plan the repository must be public (the address only serves the app's code;
   your data never leaves your phone).
2. **Install or update on your iPhone:** open `https://<your GitHub name>.github.io/nykko-phone/` in
   **Safari** → **Share → Add to Home Screen**, then open Pitaka from the Home Screen. Install before you
   enter anything: the Home Screen app keeps its own storage. An installed v2 updates itself when you open
   it (your data is kept).
3. **Deploy your relay** (optional, about 10 minutes): [docs/SETUP-RELAY.md](docs/SETUP-RELAY.md).
4. **Pair it:** Pitaka → Settings → **Inbox relay**.
5. **Build your shortcuts:** Pitaka → Settings → **Connect your iPhone** fills in your relay address,
   token and lists, with Copy and Test buttons ([docs/SETUP-SHORTCUTS.md](docs/SETUP-SHORTCUTS.md) has
   the same steps).
6. **Set up Back Tap:** Settings → Accessibility → Touch → Back Tap → Double Tap: *Pitaka Keypad*,
   Triple Tap: *Pitaka Text*.
7. **Set up the automations:** SMS (one per bank), and email or Apple Wallet if you want them.

Back up now and then (Settings → Save backup file). Backups include everything except secrets (the PIN,
the relay's tokens and key); after restoring, Pitaka offers to pair the relay again.

## Good to know (limits)

- **Entries arrive when Pitaka opens.** iOS doesn't let a home-screen web app run in the background, so
  what your shortcuts send waits on the relay (encrypted, up to 30 days) until you open Pitaka.
- **GoTyme (and other app) push notifications can't be captured.** iOS automations can react to SMS and
  email, not to another app's notifications. Use GoTyme's email alerts, its statements, or Update Balance.
- **Alert formats are unverified.** The built-in readers are educated guesses; Pitaka sends anything it
  isn't sure about to Review, and learns formats you teach it. See [docs/ALERT-FORMATS.md](docs/ALERT-FORMATS.md)
  for how to share redacted samples.
- **Apple Wallet automations** only work for cards that support them; many Philippine cards don't.
- **Offline shortcuts** still save to iCloud Drive/Shortcuts/Pitaka/inbox.jsonl; Shortcuts shows an error
  for the part that couldn't reach the relay. Import the file from Settings → Inbox and alerts.
- **GitHub Pages needs a public repository** on the free plan.
- **Storage**: iOS can clear a web app's data if it's unused for weeks and storage isn't protected; Pitaka
  asks for persistent storage and reminds you to back up.

## Run it locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Tests

```sh
node --test tests/*.test.mjs
```

Node 22.13 or later. The relay's tests run the real Worker against an in-memory SQLite stand-in for D1;
the statement tests read real PDFs with the vendored pdf.js.

## What's where

| Path | What |
| --- | --- |
| `index.html`, `app.css`, `sw.js` | the app shell, styles (light and dark tokens), service worker |
| `js/store.js`, `js/storage.js` | the data model and its rules; IndexedDB (with the v2 migration) |
| `js/inbox.js`, `js/quickparse.js`, `js/alerts.js`, `js/reconcile.js` | the capture pipeline: quick text, alert formats, matching |
| `js/statements.js`, `vendor/pdfjs/` | statement import (pdf.js, pinned and vendored) |
| `js/relay-client.js`, `js/sync.js` | pairing with the relay and collecting from it |
| `js/guide.js` | the Connect your iPhone steps (the app and `docs/SETUP-SHORTCUTS.md` come from it) |
| `js/ui-*.js` | screens and sheets |
| `relay/` | the Cloudflare Worker (`worker.js`) and its `wrangler.toml` |
| `.github/workflows/deploy-relay.yml` | optional one-click relay deploy |
| `tools/make-docs.mjs` | regenerates `docs/SETUP-SHORTCUTS.md` |

## Updating

Push to the branch GitHub Pages serves, and bump `VERSION` in `sw.js`. When you add a file the app loads,
add it to `FILES` in `sw.js` too. Pitaka shows "New version ready" and switches when you're not in the
middle of something.
