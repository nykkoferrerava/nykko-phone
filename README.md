# Pitaka

A personal expense, debt and budget tracker that runs on an iPhone as a home-screen app.
All data stays on the phone (browser storage). There's no server, no account and no tracking.

## Features

- **Home**: what's free to spend until your next payday (bi-weekly pay periods), with bills, debt payments
  and savings set-asides due before payday already taken out. If money is short before payday, it says so.
- **Wallets**: Cash, GCash, Maya, bank accounts. Each entry comes from or goes to a wallet, and transfers
  (cash-in, ATM withdrawal) move money between them without counting as spending.
- **Debts**: credit cards, loans, installments, online lending apps and money owed to people. Each one shows
  payments left (e.g. *8 of 12*), the next due date with overdue and due-soon alerts, the payoff date and its history.
  - **Paste-import**: copy your debt list from Google Sheets or Excel and paste it in; Pitaka reads the columns
    (English or Filipino headers like *utang*, *hulog*, *natitira*) and shows a preview before adding anything.
  - **Fees and interest**: record a late fee, interest or a correction as an adjustment. It changes the balance
    but doesn't count as spending.
  - **Installments**: one payment can cover several scheduled installments, or be an extra/partial payment that
    doesn't move the due date.
  - Card purchases add to the card's balance.
- **Plan**: savings goals that work out how much to set aside each payday, recurring bills, and per-category
  spending limits per pay period.
- **Reports**: monthly totals, spending by category, income vs. spending over 6 months, and total debt over time.
- **Undo**: deleting an entry shows an *Undo* button for a few seconds.
- **PIN lock**: re-locks after a short time in the background, and the screen is hidden in the app switcher.
- **Calendar reminders**: "Remind me" creates a repeating iOS Calendar event with alerts for a bill or debt,
  and "Add all due dates" puts every upcoming bill and debt payment in your calendar in one go.
- **Backup / restore** to a file (Files / iCloud Drive) from Settings, with a reminder when it's been a while
  or you've added a lot since the last backup. Restoring a backup never brings back an old PIN.

## Put it on your iPhone

The app is plain static files with no build step. It has to be served over HTTPS for offline mode and the PIN lock to work.

1. **Host it with GitHub Pages**: repo **Settings → Pages → Build and deployment → Deploy from a branch**,
   pick the branch (e.g. `main`) and `/ (root)`, then Save.
   GitHub Pages for a *private* repo needs GitHub Pro (or another paid plan). On a free plan the repo has to be
   public. Either way, the `github.io` address itself can be opened by anyone who knows it, but it only serves
   the app's code: your data is never uploaded and lives only on your phone.
2. On the iPhone, open `https://<username>.github.io/nykko-phone/` in **Safari**.
3. **Install it first, before entering anything**: tap **Share → Add to Home Screen**, then open Pitaka from
   the home screen. The home-screen app keeps its own storage, separate from Safari, so anything typed into
   the Safari tab stays behind in Safari. Pitaka shows these steps when it's opened in Safari.

Back up regularly (Settings → Save backup file). If the app is deleted from the home screen, its data goes with it.

## Updating

Push the changed files to the branch GitHub Pages serves. It's best to also bump `VERSION` in `sw.js`, and
whenever you add a new file the app loads (for example a new `js/ui-*.js` module), add it to `FILES` in `sw.js`.

Even without a version bump the phone picks up changes: the service worker serves the saved copy instantly and
refreshes it in the background (stale-while-revalidate), so the next launch runs the new files. With a bump,
Pitaka shows "New version ready" and switches over when you're not in the middle of something.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Run tests

```sh
node --test tests/*.test.mjs
```
