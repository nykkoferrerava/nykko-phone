# Alert formats

Pitaka reads the texts and emails your bank or e-wallet sends you (through your SMS and email
automations) and turns them into entries, or confirms entries you already logged. This page lists the
formats it knows, and how to help it learn the real ones.

## Every built-in format is unverified

The built-in readers in `js/alerts.js` were written from how these alerts are commonly worded, **not from
real messages**. Banks change their wording without notice. So every built-in format is marked
`unverified`, and Pitaka is careful with them:

- a confident reading adds an entry (or confirms one you logged) and can be undone from Review;
- anything it isn't sure about waits in **Review** as "Unknown format" or "Not sure";
- nothing is ever dropped silently.

**Formats you teach always win over the built-in ones.**

Which reader Pitaka uses depends on who sent the alert: an SMS sender name that contains one of the words
below (capitals and spaces don't matter), or an email address that ends with one of the domains.

| Sender | Matched by | What the built-in reader expects (unverified) |
| --- | --- | --- |
| GCash | `GCash`, `@gcash.com` | "You have paid PHP 289.00 to …", "You have received PHP … from …", "You have sent PHP … to …", bill payments, load purchases, cash-in |
| GoTyme | `GoTyme`, `GoTymeBank`, `@gotyme.com.ph`, `@gotymebank.com` | the common phrasing below |
| Maya | `Maya`, `PayMaya`, `@maya.ph`, `@paymaya.com` | the common phrasing below |
| BPI | `BPI`, `@bpi.com.ph` | the common phrasing below |
| BDO | `BDO`, `@bdo.com.ph` | the common phrasing below |
| UnionBank | `UnionBank`, `UnionBankPH`, `UBP`, `@unionbankph.com` | the common phrasing below |
| Metrobank | `Metrobank`, `MBTC`, `@metrobank.com.ph` | the common phrasing below |
| Security Bank | `Security Bank`, `SecBank`, `@securitybank.com` | the common phrasing below |
| RCBC | `RCBC`, `@rcbc.com` | the common phrasing below |
| SeaBank | `SeaBank`, `MariBank`, `@seabank.ph`, `@maribank.ph` | the common phrasing below |
| CIMB | `CIMB`, `@cimb.com`, `@cimbbank.com.ph` | the common phrasing below |
| Apple Wallet | the Wallet automation | merchant, amount and card arrive as separate fields (not as a message), so reading them doesn't depend on wording. The trigger itself can miss a payment. |
| Anyone else | any sender | a peso amount with a card ending, "debited", "credited" and the like, at low confidence: these go to Review |

The common phrasing: "You sent / received / paid ₱… to / from / at …", "Your card ending 1234 was used
for PHP … at …", "PHP … was debited / credited …". Pitaka also reads, when present, the balance after the
transaction ("Your new balance is …", "Avail bal …"), the reference number ("Ref. No. …") and the card's
last four digits.

## Teach Pitaka a format (on your phone)

When an alert lands in Review as **Unknown format**, tap **Teach**. On the **Teach this format** screen:

1. With **Amount** chosen at the top, tap the amount in the message.
2. Choose **Merchant** and tap the merchant's (or person's) words. Do the same with **Balance** and
   **Reference** if the message has them.
3. Under **This message means**, choose money out, money in, or sent to / received from another of your
   wallets, and under **For wallet or card**, the one it's about. Then **Save format**.

Pitaka saves the pattern and reads every later message like it, starting with the one in front of you.

See and edit your formats in Settings → Inbox and alerts → **Alert formats**. Tap one to see its pattern,
written with `{amount}`, `{merchant}`, `{balance}`, `{ref}`, `{#}` (any number), `{w}` (any word) and `{*}`
(anything); paste a message under **Try it on a message** to test it. Your formats are included in backups.

Which wallet or card an alert is for comes from the format, a card's last four digits, or the sender. Map
them in Settings → Inbox and alerts → **Cards and accounts** (for example "card ending 1234 → BPI Gold").

## Send redacted samples so the built-in readers can be fixed

Real samples make the built-in readers right for everyone. To share one safely:

1. Copy the alert text exactly as it arrived.
2. Replace **only** the private parts, keeping everything else (spacing, punctuation, `PHP`/`₱`, capital
   letters, the order of words) exactly the same:
   - your name and other people's names → `JUAN DELA CRUZ`
   - mobile numbers → `09171234567`
   - account and card digits → keep the last four if the message shows them, else `1234`
   - reference numbers → the same number of digits, all `1`s
   - amounts and balances → any other amount **with the same format** (`PHP 1,234.56` stays `PHP x,xxx.xx`)
3. Never include a one-time PIN (OTP) message, a password, an MPIN or a full card number. Pitaka never
   needs them, and they should never be shared.
4. Add who sent it (SMS sender name or the email address's domain), and what it was (a purchase, a
   transfer you received, a bill payment…).
5. Open an issue in this repository titled **Alert format: \<bank\>** with the redacted text, or keep it to
   paste into a future update session.

Example of a good redacted sample:

```
Sender: GCash
What: paid a merchant with QR
You have paid PHP 289.00 to JOLLIBEE FOODS CORP on 10-13-2026 12:41 PM. Ref. No. 1111111111111. Your new balance is PHP 5,073.00.
```
