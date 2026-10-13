# Pitaka

A personal expense, debt and budget tracker that runs on an iPhone as a home-screen app.
All data stays on the phone (browser localStorage). There's no server, no account and no tracking.

## Features

- **Home**: what's free to spend until your next payday (bi-weekly pay periods), bills and debt payments due before payday, budget bars and recent entries.
- **Debts**: credit cards, loans, installments, online lending apps and money owed to people. Each one shows
  payments left (e.g. *8 of 12*), the next due date with overdue and due-soon alerts, the payoff date, payment history,
  and for credit cards an interest-aware estimate of how many payments are left. Card purchases add to the card balance.
- **Plan**: savings goals that work out how much to save each payday, recurring bills, and per-category spending limits per pay period.
- **Reports**: monthly totals, spending by category, income vs. spending over 6 months, and total debt over time.
- **PIN lock**, re-locks after 1 minute in the background.
- **Calendar reminders**: "Remind me" creates a repeating iOS Calendar event with alerts for a bill or debt.
- **Backup / restore** to a file (Files / iCloud Drive) from Settings.

## Put it on your iPhone

The app is plain static files with no build step. It has to be served over HTTPS for offline mode and the PIN lock to work.

1. **Host it with GitHub Pages**: repo **Settings → Pages → Build and deployment → Deploy from a branch**,
   pick the branch (e.g. `main`) and `/ (root)`, then Save.
   GitHub Pages for a *private* repo needs GitHub Pro. On a free plan the repo has to be public;
   only the app's code is visible then, never your data, which never leaves your phone.
2. On the iPhone, open `https://<username>.github.io/nykko-phone/` in **Safari**.
3. Tap **Share → Add to Home Screen**, then open Pitaka from the home screen.

Back up regularly (Settings → Save backup file). If the app is deleted from the home screen, its data goes with it.

## Updating

After changing any app file, bump `VERSION` in `sw.js` so phones pick up the new version the next time the app opens.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```
