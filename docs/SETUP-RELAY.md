# Setting up your inbox relay

The relay is a tiny program (a Cloudflare Worker) that you own, on Cloudflare's free plan. Your shortcuts
send what you type and the alerts your bank texts you to it; it seals each item so only your iPhone can
open it, and holds it until Pitaka opens and collects it. Then it deletes it. Anything Pitaka doesn't
collect is deleted after 30 days.

**You don't need the relay to use Pitaka.** Without it, Quick Add still works through iCloud Drive
(Settings → Inbox and alerts → Import from Files); you just do that step yourself.

It takes about 10 minutes, once. No coding. Pick one of the two ways below.

## What the relay can and can't see

- It stores each item **encrypted to a key that never leaves your iPhone** (ECDH P-256 + AES-256-GCM, a new
  key for every item). Cloudflare, and anyone who could read the database, sees only scrambled bytes.
- It keeps **hashes** of your two tokens, never the tokens.
- It keeps your category and wallet names unencrypted, because your shortcuts read them to show their
  lists. Nothing else.
- It **never logs** what's sent to it, and from a browser it only answers your Pitaka address.
- It never asks for, stores or sends a bank, GCash or GoTyme password, OTP or MPIN. Nothing in Pitaka does.

## Before you start

1. A free Cloudflare account: <https://dash.cloudflare.com/sign-up>. Open **Workers & Pages**: your
   `workers.dev` subdomain is shown next to **Your subdomain**. If Cloudflare asks you to choose one, pick
   something like your name. Your relay's address will be `https://pitaka-relay.<your subdomain>.workers.dev`.
2. A **setup secret**. In Pitaka: Settings → **Inbox relay** → **Make one** → **Copy**. Keep it in your
   password manager or Notes until you've paired. (Pitaka doesn't keep it.)

## Way 1: in the Cloudflare dashboard

1. **Create the database.** Dashboard → **Storage & databases** → **D1 SQL database**
   ([direct link](https://dash.cloudflare.com/?to=/:account/workers/d1)) → **Create Database**. Name it
   `pitaka-relay`. Leave **Location** on automatic (it picks a place near you) or choose Asia-Pacific →
   **Create**. The relay makes its own tables.
2. **Create the Worker.** **Workers & Pages** → **Create application** → **Start with Hello World!** →
   **Get started**. Name it `pitaka-relay` → **Deploy**.
3. **Paste the code.** On the Worker's page select **Edit code** (the `</>` icon). Select everything in
   `worker.js` and delete it. Open [`relay/worker.js`](../relay/worker.js) in this repository, tap **Raw**,
   copy all of it, paste it into the editor, then **Deploy**.
4. **Connect the database.** On the Worker's page open the **Bindings** tab → **Add binding** →
   **D1 database** → **Add binding**. **Variable name** `DB`, database `pitaka-relay` → **Add binding**.
5. **Add the settings.** Worker → **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `ADMIN_SECRET`, value: your setup secret.
   - Select **Add variable**: type **Text**, name `ALLOWED_ORIGIN`, value: your Pitaka address, for example
     `https://nykkoferrerava.github.io`.

   Then **Deploy**.
6. **Optional: a daily clean-up.** Worker → **Settings** → **Triggers** → **Cron Triggers** → add the
   schedule `17 19 * * *` (once a day, 3:17 AM in Manila). Without it, old items are still deleted, the
   next time anything reaches the relay.
7. **Optional: no request logs.** Cloudflare turns on **Workers Logs** for new Workers, which records each
   request's address and time (never what's inside: that's sealed). You can turn it off in the Worker's
   settings. Way 2 turns it off for you.
8. **Check it.** Open `https://pitaka-relay.<your subdomain>.workers.dev/` in Safari. You should see
   `{"ok":true,"service":"pitaka-relay","paired":false}`.

## Way 2: with GitHub Actions

This repository includes a workflow (`.github/workflows/deploy-relay.yml`) that creates the database,
deploys the Worker with its settings, adds the daily clean-up and turns off request logs. After the first
run it redeploys by itself whenever `relay/` changes.

1. **Make a Cloudflare API token.** Dashboard → your profile icon → **My Profile** → **API Tokens** →
   **Create Token** → template **Edit Cloudflare Workers** → **Use template**. Under **Permissions** add a
   row: **Account** · **D1** · **Edit**. Under **Account Resources** choose your account; under **Zone
   Resources** choose **All zones** (fine if you have none). **Continue to summary** → **Create Token**, and
   copy it (it's shown only once).
2. **Find your account ID.** Dashboard → **Workers & Pages** → **Account details** → the copy button next
   to **Account ID**. It's 32 letters and digits.
3. **Add three repository secrets.** GitHub → this repository → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 2
   - `RELAY_ADMIN_SECRET`: your setup secret

   `ALLOWED_ORIGIN` is set to `https://<your GitHub name>.github.io` for you. If Pitaka lives somewhere
   else (your own domain), also add a **variable** on the **Variables** tab: `RELAY_ALLOWED_ORIGIN`, value
   your Pitaka address.
4. **Run it.** GitHub → **Actions** → **Deploy relay** → **Run workflow**. When it's green, open the run:
   its summary shows your relay's address. If it's red, open it and read the first red line: it says what
   to fix (a missing secret, the D1 permission, choosing a `workers.dev` subdomain). Fix that and select
   **Run workflow** again. Running it again is always safe: it finds the same database.

## Pair Pitaka

In Pitaka: Settings → **Inbox relay**. Paste the relay address and the setup secret → **Pair**.

Pitaka makes a key pair (the private half can't be copied off the phone) and two random tokens, and gives
the relay only the public key and the tokens' hashes:

- the **write token** goes into your shortcuts (Settings → Inbox relay → Copy). It can only add items;
- the **read token** stays inside Pitaka. It collects and deletes.

Then build your shortcuts: Settings → **Connect your iPhone** (or [SETUP-SHORTCUTS.md](SETUP-SHORTCUTS.md)).

Once paired, Pitaka only connects to that relay (its Content-Security-Policy is narrowed to it), collects
whenever you open it or come back to it, and sends the relay your current category and wallet names when
they change.

## Later

- **After a restore or on a new phone:** backups never include the tokens or the key. Pitaka offers to pair
  again; paste the write token from one of your shortcuts into "Your shortcuts already have a write token?"
  and they keep working unchanged.
- **If the write token leaked** (say, in a screenshot): Settings → Inbox relay → **Make a new write token**,
  then paste it into each shortcut.
- **Pairing again** with the setup secret replaces both tokens and the key. Items still waiting for the old
  pairing can't be opened any more; Pitaka tells you how many and clears them (Quick Add entries are still
  in iCloud Drive: Import from Files). The old tokens then get "This relay was paired again on …".
- **If you see "paired again" and it wasn't you,** someone has your setup secret. Make a new one in Pitaka
  and put it in Cloudflare as `ADMIN_SECRET` (Way 1: step 5; Way 2: replace the `RELAY_ADMIN_SECRET`
  secret and run the workflow again). Then pair again.
- **Ten wrong setup secrets in an hour,** from anyone, pause pairing for an hour, so nobody can keep
  guessing. To pair during a pause, also paste the write token from one of your shortcuts.
- **Free plan limits** are far above one person's use: 100,000 Worker requests a day, and for the database
  5 million rows read and 100,000 rows written a day, 5 GB stored. Each item is a few rows. The day starts
  at 8:00 AM Manila time (midnight UTC). Anyone who knows your relay's address could use up a day's
  requests; Cloudflare then answers with an error until the next day. Your shortcuts also save every item
  in iCloud Drive, so Import from Files catches up.
- **To remove it:** delete the `pitaka-relay` Worker and the `pitaka-relay` database in Cloudflare, and
  unpair in Pitaka.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Pitaka: "Couldn't reach the relay" | Check the address. Check `ALLOWED_ORIGIN` in Cloudflare is your Pitaka address, like `https://<name>.github.io`. |
| Pitaka: "The relay doesn't accept this address" | Set `ALLOWED_ORIGIN` in Cloudflare to the address Pitaka shows. |
| Pitaka: "That setup secret isn't the one in Cloudflare" | Copy `ADMIN_SECRET` again; it must be 16 characters or more. |
| Pitaka: "Too many wrong setup secrets…" | Wait an hour, or also paste the write token from one of your shortcuts. |
| Pitaka: "The relay no longer accepts Pitaka" or "paired again" | See **Later**: pairing again. |
| `{"error":"The DB binding (a D1 database) is missing"}` | Way 1, step 4: the binding's variable name must be `DB`. |
| A shortcut runs, but its entry never shows up in Pitaka | Shortcuts doesn't show the relay's answer, so a wrong or old write token looks like nothing happened (add **Show Result** after **Get Contents of URL** to see the reason). Copy the write token again from Settings → Inbox relay into every **Get Contents of URL** action in that shortcut. Until then, Import from Files catches up. |
| Shortcuts: "Use POST for /in" | In that **Get Contents of URL**, set **Method** to **POST**. |
| Shortcuts: "slow down" or "too many wrong tokens" | Too many requests in a minute. Wait a minute. |
| GitHub: the Deploy relay run is red | Open it and read the first red line; it says what to fix. Then **Run workflow** again. |
