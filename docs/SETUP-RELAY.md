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
- It **never logs** what's sent to it, and it only answers your Pitaka address from a browser.
- It never asks for, stores or sends a bank, GCash or GoTyme password, OTP or MPIN. Nothing in Pitaka does.

## Before you start

1. A free Cloudflare account: <https://dash.cloudflare.com/sign-up>. The first time you open
   **Workers & Pages**, Cloudflare asks you to pick a `workers.dev` subdomain (for example your name).
   Your relay's address will be `https://pitaka-relay.<that subdomain>.workers.dev`.
2. A **setup secret**. In Pitaka: Settings → **Inbox relay** → **Make one** → **Copy**. Keep it in your
   password manager or Notes until you've paired. (Pitaka doesn't keep it.)

## Way 1: in the Cloudflare dashboard

1. **Create the database.** Dashboard → **Storage & Databases** → **D1 SQL Database** → **Create**.
   Name it `pitaka-relay`, keep the default location, **Create**. (The relay makes its own tables.)
2. **Create the Worker.** Dashboard → **Workers & Pages** → **Create** → **Create Worker** (start from
   "Hello World"). Name it `pitaka-relay` → **Deploy**.
3. **Paste the code.** On the Worker's page tap **Edit code**. Select everything in `worker.js` and
   delete it. Open [`relay/worker.js`](../relay/worker.js) in this repository, tap **Raw**, copy all of it,
   paste it into the editor, then **Deploy**.
4. **Connect the database.** Worker → **Settings** → **Bindings** → **Add binding** → **D1 database**.
   Variable name `DB`, database `pitaka-relay` → **Add binding**.
5. **Add the settings.** Worker → **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `ADMIN_SECRET`, value: your setup secret.
   - Type **Text**, name `ALLOWED_ORIGIN`, value: your Pitaka address without the path, for example
     `https://nykkoferrerava.github.io`.

   **Deploy** (or **Save**) when Cloudflare asks.
6. **Check it.** Open `https://pitaka-relay.<your subdomain>.workers.dev/` in Safari. You should see
   `{"ok":true,"service":"pitaka-relay","paired":false}`.

## Way 2: with GitHub Actions

This repository includes a workflow (`.github/workflows/deploy-relay.yml`) that creates the database,
deploys the Worker and sets its settings for you, and redeploys whenever `relay/` changes.

1. **Make a Cloudflare API token.** Dashboard → your profile icon → **My Profile** → **API Tokens** →
   **Create Token** → template **Edit Cloudflare Workers** → **Use template**. Under **Permissions** add
   **Account** · **D1** · **Edit**. **Continue to summary** → **Create Token**, and copy it (it's shown once).
2. **Find your account ID.** Dashboard → **Workers & Pages**: it's under **Account details** on the right
   (or in the address bar after `dash.cloudflare.com/`).
3. **Add three repository secrets.** GitHub → this repository → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 2
   - `RELAY_ADMIN_SECRET`: your setup secret
4. **Run it.** GitHub → **Actions** → **Deploy relay** → **Run workflow**. When it's green, open the run:
   the last step shows your relay's address. `ALLOWED_ORIGIN` is set to `https://<your GitHub name>.github.io`
   for you.

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
  in iCloud Drive: Import from Files).
- **Free plan limits** are far above one person's use: 100,000 requests and 100,000 database writes a day.
- **To remove it:** delete the `pitaka-relay` Worker and the `pitaka-relay` database in Cloudflare, and
  unpair in Pitaka.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Pitaka: "Couldn't reach the relay" | Check the address. Check `ALLOWED_ORIGIN` is exactly your Pitaka address (`https://<name>.github.io`, no path, no slash at the end). |
| Pitaka: "That setup secret isn't the one in Cloudflare" | Copy `ADMIN_SECRET` again; it must be 16 characters or more. |
| `{"error":"The DB binding (a D1 database) is missing"}` | Step 4 of Way 1: the binding's variable name must be `DB`. |
| Shortcuts: "401" or "wrong token" | The write token changed. Copy it again from Settings → Inbox relay. |
| Shortcuts: "429" | Too many requests in a minute (or too many wrong tokens). Wait a minute. |
