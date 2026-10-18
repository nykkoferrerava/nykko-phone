# Pitaka v3: build prompt

> **Run with:** Opus 5.5, effort **xhigh** (Extra High), in a Claude Code session on the
> `nykkoferrerava/nykko-phone` repository.
> Copy everything below the line into the session as the first message.

---

You are continuing work on **Pitaka**, my personal money app for my iPhone. Build **Pitaka v3** as one complete
release, not a minimal version. Work autonomously from start to finish. Commit after each milestone and push when
done. Don't open a pull request unless I ask.

## 0. Who I am and the hard constraints

- **Device:** iPhone 15 on iOS 26.6. I'm the only user, and there will never be other users or an App Store release.
- **No Mac and no Apple Developer account.** Pitaka stays what it is today: a **home-screen web app (PWA)** with
  no build step, served by GitHub Pages and installed from Safari with *Add to Home Screen*. Don't switch to Swift,
  React Native, Expo or any framework. Don't add a bundler. It stays plain ES modules, CSS and HTML.
- **English only** in the UI. **Philippine peso (₱)** everywhere. Time zone is Asia/Manila.
- **No AI features** and no calls to any LLM API.
- **My data stays mine.** Pitaka is on-device first. The only server in this design is a tiny *inbox relay*
  (§4) that briefly holds encrypted items until the app collects them. Never ask for, store or send any bank,
  GCash or GoTyme password, OTP or MPIN. Never scrape a bank website or app.

## 1. Start from the existing app

The baseline is already built and working. Read all of it before changing anything:

- Branch **`claude/expense-debt-tracker-app-x7ilts`** (commits "Add Pitaka…" and "Pitaka v2…").
  Merge it into your working branch first: `git fetch origin claude/expense-debt-tracker-app-x7ilts` then merge.
- Files: `index.html`, `app.css`, `manifest.webmanifest`, `sw.js`, `js/app.js`, `js/store.js` (all data logic,
  DOM-free, runs under Node), `js/ui-core.js`, `js/ui-views.js`, `js/ui-sheets.js`, `js/ui-onboard.js`,
  `js/ui-lock.js`, `js/ui-ics.js`, `js/importer.js`, `js/charts.js`, `js/util.js`, `tests/logic.test.mjs`.
- What v2 already does (keep all of it working, and don't rebuild it from scratch):
  - Home with *free to spend until payday*.
  - Wallets (cash, e-wallet, bank) with transfers.
  - Debts (cards, loans, installments, lending apps, owed to a person) with payments left, due dates, payoff date
    and paste-import from a spreadsheet.
  - Adjustments (fee, interest, penalty, correction).
  - Plan: savings goals, recurring bills and per-category limits per pay period.
  - Reports, undo, PIN lock, app-switcher cover and calendar (.ics) reminders.
  - Backup/restore, and bi-weekly pay periods (`period()` uses `settings.payAnchor` + 14 days).
- Follow the existing conventions: the `ValidationError` / `StoreError` pattern, `tx()` all-or-nothing saves,
  strict vs lenient `rules()`, the `defined()` prototype-pollution guard, CSS custom-property tokens with
  `data-theme`, the comment style and the test style.

## 2. What v3 must deliver

### 2.1 Back Tap quick add, the headline feature

I double-tap or triple-tap the back of my iPhone, add an expense in a few seconds from any screen, and it shows up
in Pitaka.

**Platform facts you must design around (verified, don't fight them):**
- iOS Back Tap (Settings → Accessibility → Touch → Back Tap) can only run a shortcut that is saved in the
  **Shortcuts library**.
- A shortcut **cannot open a home-screen web app**. "Open URL" opens Safari, and the home-screen app has
  **separate storage from Safari**, so a URL like `…/#add?amount=150` would land in the wrong place.
- Signed `.shortcut` files can only be produced on a Mac, so I will **build the shortcuts by hand** from your
  instructions.

**So the design is:** the shortcut collects the entry with native Shortcuts dialogs and posts it to the inbox relay
(§4). Pitaka collects it the next time it opens or comes back to the foreground. It must appear within about a
second of opening, with a subtle "1 new entry from Quick Add" toast that offers Undo.

Two flows (I chose both):

- **(a) Keypad flow (double tap):**
  1. Ask for Input (Number, "Amount ₱").
  2. Choose from List: category.
  3. Choose from List: wallet or card.
  4. Optional note.
  5. Post the entry.
  6. Show a notification such as "₱150 · Food · GCash saved".

  The category and wallet lists must **come from Pitaka**, so renamed and new categories show up in the shortcut.
  Pitaka publishes a small config (category names and emoji, wallet names, default wallet) to the relay, and the
  shortcut fetches it first. If the fetch fails, the shortcut falls back to a short built-in list.
- **(b) Quick text flow (triple tap):**
  1. One Ask for Input (Text) where I type or dictate something like `150 lunch gcash`,
     `jollibee 289`, `grab 175 gotyme`, `₱1,200 groceries bpi card` or `utang kay mel 500`.
  2. Post the raw text.

  Pitaka parses it with an amount + keyword parser in `js/quickparse.js` (DOM-free and tested):
  - Find the amount wherever it is, including `1,200`, `1.2k`, `₱`, `php` and `p`.
  - Match category by name and by synonyms (jollibee/mcdo/lunch → Food, grab/angkas/jeep → Transport,
    meralco → Bills, load/globe/smart → Load & Internet, shopee/lazada → Shopping…).
  - Match the wallet by name or alias (gcash, gotyme, cash, bpi…).
  - Recognise income words (sahod, salary, received) and lending words (utang, lent, pautang).
  - Keep the rest as the note.

  If the parse isn't confident, the entry goes to the **Review** queue (§2.3) instead of being guessed.
- **Offline safety:** before posting, the shortcut appends the same JSON line to an iCloud Drive file
  (`Shortcuts/Pitaka/inbox.jsonl`). Every item carries a client-generated id (timestamp + random), so Pitaka
  removes duplicates. Settings → Inbox has **Import from Files** to read that file through `<input type=file>` as
  a manual catch-up when the relay was unreachable.

### 2.2 Keep wallets in sync: GCash, GoTyme, and any bank or card later

GCash and GoTyme have **no public API for personal accounts**. The BSP Open Finance aggregators (Brankas, Finverse…)
only serve accredited businesses. So "live sync" here means **near-live capture from the alerts my phone already
gets**, plus statement import to reconcile. Build all of the following on one shared pipeline:

1. **SMS alerts (automatic, seconds):** a Shortcuts *Personal Automation → Message* trigger (sender contains
   GCash, or a bank sender ID), set to **Run Immediately**, posts `{type:'sms', sender, text, receivedAt}` to the
   relay.
2. **Email alerts (automatic if I use Apple Mail):** a *Personal Automation → Email* trigger for alert senders
   posts `{type:'email', from, subject, body}`. Make this optional and document it.
3. **Apple Wallet "Transaction" automation:** optional, for any card I add to Apple Wallet. It posts merchant
   and amount. Document it as "if your card supports it".
4. **Balance check (manual, 3 seconds):** a third shortcut (or a menu item in the keypad shortcut),
   "Update balance". I pick a wallet and type what the GCash or GoTyme app shows. Pitaka compares it to the computed
   balance and, if they differ, proposes a *Balance fix* adjustment (reuse the existing `adjust`/`correction`
   kind and `setWalletBalance`). This matters most for GoTyme, because its alerts are mostly push notifications,
   which iOS doesn't let any app read.
5. **Statement import:**
   - GCash transaction-history PDF. It is emailed and password-protected, and the password is entered by me
     in-app and never stored.
   - GoTyme statement PDF.
   - Any bank or card CSV or PDF statement.

   Use a **vendored, version-pinned pdf.js** in `vendor/` (lazy-loaded, added to `sw.js` `FILES`; no CDN at
   runtime). Extract the rows, then show a preview with column mapping (reuse the approach and UI of the debt
   paste-importer). Mark rows that already exist, then import. Statements are also how Pitaka reconciles each wallet
   monthly.

**The alert parser (`js/alerts.js`, DOM-free, heavily tested):**
- A registry of institution parsers: GCash, GoTyme, Maya, BPI, BDO, UnionBank, Metrobank, Security Bank, RCBC,
  SeaBank and CIMB, plus a generic "PHP amount + merchant + card ending" fallback.
- Each parser returns `{kind, amount, merchant, wallet hint, card last4, balanceAfter?, reference?, confidence}`.
- Cover the common GCash events: sent money, received money, paid bills, bought load, QR/merchant payment, cash-in,
  bank transfer out and in. When an alert includes "new balance" or "available balance", record it as a
  **confirmed balance** on the wallet and flag any drift.
- **You don't know the exact message formats, so don't pretend to.** Write the built-in patterns as best-effort,
  label them `unverified` in code, and make the system teachable:
  - **Teach Pitaka:** in the Review queue, an unknown alert has a "Teach this format" action. I tap the amount, the
    merchant and the balance in the message text. Pitaka turns that into a saved template (escaped literal text
    plus typed placeholders), matches future alerts from the same sender with it, and lets me edit or delete it in
    Settings → Alert formats.
  - Templates are part of the backup.
- **Card mapping:** Settings → Cards & accounts maps "card ending 1234" or a sender ID to a wallet or a credit-card
  debt. A credit-card purchase adds to that card's debt balance, which the baseline already does.

**Matching and duplicates (`js/reconcile.js`, DOM-free, tested). This is critical:**
- If I log ₱289 at Jollibee manually and then the GCash SMS for ₱289 arrives, Pitaka must **link** them, not count
  them twice. Match on the same amount, a compatible wallet, a time window (about ±30 minutes, configurable) and
  merchant similarity. A linked entry gets a small "✓ confirmed by GCash" badge.
- The same event arriving by SMS, email and statement must merge into one entry, keyed by reference number when
  there is one.
- **Transfers between my own accounts:** "GCash sent ₱1,000 to GoTyme" followed by GoTyme receiving ₱1,000 must
  pair into one **transfer**, which is not spending.
- **Confidence rule:** only high-confidence matches apply automatically. Everything else goes to Review. Nothing is
  ever silently dropped, and every automatic change can be undone.

### 2.3 The Review inbox
A new screen, reached from a badge on Home. It lists items from the relay or imports that need a decision:
- unparsed alerts
- low-confidence quick-text entries
- possible duplicates
- balance drift

Each item has one-tap actions: Accept, Edit, Link to existing, Mark as transfer, Teach format, Ignore. Accepting
or ignoring several items at once must be possible.

### 2.4 Features I picked (extend the baseline, don't duplicate it)
- **(a) Budgets per category:** already in Plan. Polish the UI. Show progress on Home for categories over 80%.
  Warn me in the quick-add confirmation toast when an entry pushes a category over its limit.
- **(b) Payday budgeting:** **I'm paid every second Friday.** Onboarding and Settings must ask "When is your next
  payday?" with a date picker limited to Fridays, then store `payAnchor`. Show "Next payday: Fri, Oct 23 · 5 days"
  on Home. Keep the 14-day logic and add tests around year boundaries.
- **(c) Recurring bills and subscriptions:** already present. Add "mark as paid" from Home for bills due before
  payday. Detect likely subscriptions from repeated same-amount, same-merchant expenses and suggest adding them.
- **(d) Savings goals:** already present. Keep them, and polish the UI.
- **(e) Utang in both directions:** debts I owe already exist. Add **money owed to me** (receivables): a person,
  an amount, an optional due date, and partial repayments that land in a wallet. Show a "Owed to you" total on the
  Debts screen. Quick text `lent mel 500` or `pautang mel 500` creates one.
- **(j) Reports and CSV export:**
  - Keep the existing reports.
  - Add CSV export of transactions with a date range and wallet filter, plus debts, goals and receivables, through
    the share sheet or download.
  - Add a per-pay-period report: income, spending, saved, debt paid, and top categories and merchants.
- **Categories:** keep the Philippine defaults and make sure I can **rename, re-emoji, reorder, add, hide and
  merge** categories. Merging moves the transactions. Changes must flow to the shortcut config (§2.1).
- Not wanted: split bills, receipt scanning, widgets, Apple Watch, AI.

### 2.5 Premium UI
It must feel like a high-end native fintech app (Revolut / Copilot Money quality), not a web page.

- **Theme:** a three-way **System / Light / Dark** setting, persisted. Update `<meta name="theme-color">` live.
  The tokens already exist in `app.css`: audit and finish them so every surface, chart and sheet is correct in both
  themes.
- **Layout and chrome:**
  - A large-title header that collapses on scroll.
  - A translucent tab bar and sheets (`backdrop-filter`, in the spirit of iOS 26 Liquid Glass).
  - Correct `env(safe-area-inset-*)` everywhere.
  - Bottom sheets with drag-to-dismiss and spring-like easing.
- **Typography and numbers:**
  - System font stack with a deliberate type scale.
  - **Tabular numerals** for all money.
  - A big, confident free-to-spend hero.
  - Animated count-up when a balance changes.
  - Negative and overdue states that are clear without being loud.
- **Icons:** keep emoji for categories, because they're mine to choose. Use one consistent inline SVG icon set for
  all UI chrome, as a self-hosted sprite.
- **Motion and feel:**
  - Respect `prefers-reduced-motion`.
  - Haptic feedback on save and delete through the iOS Safari `<input type="checkbox" switch>` technique, as a
    progressive enhancement that does nothing elsewhere.
  - No layout shift.
  - First render under 300 ms on an iPhone 15.
- **Empty states and onboarding:** thoughtful empty states. A redesigned onboarding with these steps:
  1. Install to the Home Screen (keep the existing Safari detection).
  2. Next payday.
  3. Wallets and starting balances.
  4. Debts (paste-import).
  5. **Connect your iPhone:** the relay pairing and shortcuts guide, §2.6.
- **Accessibility:** 44 pt minimum tap targets, labelled controls, sufficient contrast in both themes, and scaling
  that follows the system text size.

### 2.6 In-app "Connect your iPhone" guide
Build a guided checklist screen (Settings → Connect your iPhone, and an onboarding step). It walks me action by
action through building each shortcut in the Shortcuts app and wiring Back Tap and the automations:
- Quick Add – Keypad
- Quick Add – Text
- Update Balance
- SMS/Email/Wallet automations

For each step give the exact action names as they appear in iOS 26 Shortcuts, the exact field values, and a
**Copy** button for every URL, header and JSON body. Pitaka fills in my relay URL and write token. Add a **Test**
button that confirms Pitaka received a test item from each shortcut. Mirror the same content in
`docs/SETUP-SHORTCUTS.md`. Keep each shortcut as small as possible: shortcuts only collect and post, and all
parsing lives in Pitaka, where it is tested.

## 3. Storage
v2 keeps everything in one `localStorage` key. With raw alerts, templates and years of transactions this will pass
the ~5 MB limit (around 10 entries a day over 5 years is about 18k transactions).
- **Migrate to IndexedDB** behind a small storage adapter, so `store.js` stays DOM-free and Node-testable with an
  in-memory adapter.
- Make the migration one-time, verified (read back and compare) and reversible. Keep the old key until the new
  store has been verified across a later launch.
- Keep `tx()` all-or-nothing semantics.
- Call `navigator.storage.persist()`.
- Raw alert text older than 90 days may be trimmed to the parsed fields (make this a setting).
- Backups include everything except secrets (PIN, relay tokens and the private key), the same rule as v2 for the
  PIN. After a restore, Pitaka asks me to re-pair the relay.

## 4. The inbox relay (`relay/`)
A tiny **Cloudflare Worker** on the free plan, using KV or D1 (your choice; justify it in a comment). It's the
mailbox between the shortcuts and the app.

- **Endpoints:**
  - `POST /in`: needs the write token. Accepts entry, text, sms, email, wallet or balance items, with size limits
    and validation.
  - `GET /config`: needs the write token. Returns the category and wallet lists for the shortcuts.
  - `PUT /config`, `GET /pull`, `POST /ack`: need the read token.
- **Least privilege:** the write token only lives in the shortcuts and can only add items and read the config. The
  read token only lives in Pitaka. Both are random and at least 256 bits. Compare them in constant time. Rate-limit
  requests.
- **Encrypted at rest:**
  - At pairing, Pitaka generates an ECDH P-256 key pair with WebCrypto, keeps the private key **non-extractable in
    IndexedDB**, and registers the public key with the Worker.
  - The Worker encrypts each incoming item immediately (ECDH-ES + AES-GCM, an ephemeral key per item) and stores
    only ciphertext.
  - Pitaka decrypts after pulling, then acks, and the Worker deletes the item.
  - Unacked items expire after 30 days.
  - The Worker never logs request bodies.
- **CORS:** restrict to my GitHub Pages origin.
- **Deployment:** give two paths in `docs/SETUP-RELAY.md`, written for a non-developer:
  1. Cloudflare dashboard: create a Worker, paste the code, create and bind KV, set secrets.
  2. A GitHub Actions workflow using `wrangler` with a `CLOUDFLARE_API_TOKEN` repo secret.

  Pairing in Pitaka: paste the Worker URL and the admin setup secret once. Pitaka creates the tokens and keys and
  shows the write token for the shortcuts.
- **Without a relay:** Pitaka must still be fully usable. Manual entry, statement import and the Files catch-up
  keep working.
- **Tests:** the Worker logic is testable under plain Node (`node --test`) with a mocked KV. Cover auth, both
  token scopes, validation, encrypt and decrypt round-trip, ack and delete, and expiry.

## 5. Quality bar and verification
- **Unit tests:** keep `tests/logic.test.mjs` green and add test files for `quickparse`, `alerts`
  (including templates), `reconcile` (duplicates, linking, transfer pairing, reference merge), receivables,
  payday on Fridays, the storage migration, CSV export (escaping, formula-injection guard on cells starting with
  `= + - @`) and the relay. Run `node --test tests/*.test.mjs` before every commit.
- **Security pass:**
  - Escape all user and alert text rendered to the DOM (alerts are untrusted input).
  - No `innerHTML` with unescaped data.
  - Add a strict CSP `<meta>` that allows only self and the relay origin in `connect-src`.
  - No third-party runtime requests.
  - Secrets never appear in backups, logs or URLs.
- **Visual check:** you can't use a real iPhone. Serve the app locally and drive it with Playwright using the
  pre-installed Chromium:
  - Use an iPhone 15 viewport (393×852, DPR 3, touch, iOS user agent).
  - Screenshot every screen and key sheet in **both light and dark**, including Home, Debts, Plan, Reports,
    Review, Quick Add toast, Connect your iPhone, onboarding and Settings.
  - Review the screenshots critically against §2.5 and fix what looks cheap.
  - Send me the final set.
- **Service worker:** bump `VERSION` in `sw.js` and add every new file to `FILES`. Updating from v2 must keep my
  existing data. Write a test or a scripted check that loads v2 data and opens it with v3.
- **Docs:** update `README.md` (what's new, setup order, limitations). Add `docs/SETUP-RELAY.md`,
  `docs/SETUP-SHORTCUTS.md` and `docs/ALERT-FORMATS.md`, which lists which built-in parsers are unverified and how
  I can send real (redacted) samples so they can be tightened.

## 6. Order of work (commit after each)
1. Merge the baseline, read it, and write a short plan in `docs/V3-PLAN.md`.
2. Storage adapter and IndexedDB migration.
3. Theme setting and premium UI foundation (tokens, header, tab bar, sheets, icons, motion).
4. Payday-on-Friday, receivables, category management, CSV export and the pay-period report.
5. `quickparse`, `alerts`, `reconcile` and the Review inbox.
6. Relay Worker, pairing and the pull-on-open flow.
7. Statement import (pdf.js and CSV).
8. Connect your iPhone guide and docs.
9. Full test run, security pass, Playwright screenshots, final fixes, push.

## 7. When you finish, report back with:
- What was built, and anything you cut or deferred, with the reason.
- Exactly what I must do on my side, in order:
  1. Enable GitHub Pages.
  2. Install or update on the Home Screen.
  3. Deploy the relay.
  4. Pair.
  5. Build the shortcuts.
  6. Set up Back Tap.
  7. Set up the automations.
- Which alert formats are unverified, and the samples you need from me.
- Known limits, stated plainly. For example: GoTyme push notifications can't be captured on iOS; entries appear
  when Pitaka next opens; the GitHub Pages repo must be public on a free plan.
