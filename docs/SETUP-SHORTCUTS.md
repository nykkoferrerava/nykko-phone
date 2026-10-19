# Connect your iPhone: shortcuts and automations

<!-- Generated from js/guide.js by `node tools/make-docs.mjs`. Edit js/guide.js, not this file. -->

Pitaka shows these same steps in the app (Settings → Connect your iPhone) with your relay address, write
token and lists filled in, a Copy button for each, and a Test button that tells you when a shortcut reached
Pitaka. Here, `<your relay address>` and the like stand for those values.

Shortcuts only collect what you type, or what your bank sends you, and post it to your relay. They never
log in anywhere, read other apps or decide anything. Pitaka picks everything up the next time you open it.

## Before you start

- Set up your relay first (Settings → Inbox relay). Each shortcut needs its address and write token.
- In the Files app, open **iCloud Drive → Shortcuts** and make a folder named `Pitaka`. Your shortcuts keep their lists and a backup copy of everything they send there.
- Names below are the actions as the iOS 26 Shortcuts app shows them: search for them with the search field at the bottom of the shortcut editor.

## Quick Add – Keypad

**Double-tap the back of your iPhone.** Asks for the amount, the category and the wallet, then sends them to Pitaka. About five seconds, without opening Pitaka.

### Set up

1. Shortcuts → **+** (new shortcut). Name it `Pitaka Keypad`.

### Actions, in order

1. **Get File** — Turn off **Show Document Picker**. File Path `Pitaka/config.json`. Turn off **Error If Not Found**.
2. **If** — Input **File**, condition **has any value**.
3. **Get Dictionary from Input** — Input **File**.
4. **Set Variable** — Variable Name `Config`.
5. **Get Dictionary Value** — Get **Value** for `categories` in **Config**.
6. **Set Variable** — Variable Name `Categories`.
7. **Get Dictionary Value** — Get **Value** for `wallets` in **Config**.
8. **Set Variable** — Variable Name `Wallets`.
9. **Otherwise** — Already there: Shortcuts added it with the If. Until the relay has sent your lists once, these are used:
10. **Text** — Your categories, one per line.

   ```
   <your categories, one per line>
   ```

11. **Split Text** — Split **Text** by **New Lines**.
12. **Set Variable** — Variable Name `Categories`.
13. **Text** — Your wallets and cards, one per line.

   ```
   <your wallets and cards, one per line>
   ```

14. **Split Text** — Split **Text** by **New Lines**.
15. **Set Variable** — Variable Name `Wallets`.
16. **End If** — Already there: Shortcuts added it with the If.
17. **Ask for Input** — Input Type **Number**. Prompt `Amount ₱`.
18. **Set Variable** — Variable Name `Amount`.
19. **Choose from List** — List **Categories**. Prompt `Category`.
20. **Set Variable** — Variable Name `Category`.
21. **Choose from List** — List **Wallets**. Prompt `Wallet or card`.
22. **Set Variable** — Variable Name `Wallet`.
23. **Ask for Input** — Input Type **Text**. Prompt `Note (optional)`.
24. **Set Variable** — Variable Name `Note`.
25. **Random Number** — Minimum `100000`, Maximum `999999`.
26. **Text** — Type `kp-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
27. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
28. **Dictionary** — Add these keys (all **Text**):

   | Key | Value |
   | --- | --- |
   | `type` | `entry` |
   | `id` | **ID** |
   | `amount` | **Amount** |
   | `category` | **Category** |
   | `wallet` | **Wallet** |
   | `note` | **Note** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

29. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
30. **Show Notification** — Type `₱`, insert **Amount**, type ` · `, insert **Category**, type ` · `, insert **Wallet**, type ` saved`.
31. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`
32. **Get Contents of URL** — URL below. Tap the arrow: Method **GET**; Headers: Key `Authorization`, the same Value as above. This fetches your latest lists from Pitaka.

   `<your relay address>/config`

   Authorization value: `Bearer <your write token>`
33. **Save File** — Turn off **Ask Where to Save**. Destination Path `Pitaka/config.json`. Turn on **Overwrite If File Exists**.

### Then

- Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → choose **Pitaka Keypad**.

### Test it

Run it, enter `1`, any category and wallet, and the note `test`. A test never becomes an entry. In Pitaka, open Settings → Connect your iPhone → Quick Add – Keypad and tap **Test** first: it shows ✓ when the shortcut arrives.

## Quick Add – Text

**Triple-tap the back of your iPhone.** One box: type it the way you say it, like `jollibee 289 gcash`, `grab 175`, `sahod 25000 bpi` or `lent mel 500`. Pitaka reads it; anything it isn't sure about waits in Review.

### Set up

1. Shortcuts → **+**. Name it `Pitaka Text`.

### Actions, in order

1. **Ask for Input** — Input Type **Text**. Prompt `What did you spend?`
2. **Set Variable** — Variable Name `Said`.
3. **Random Number** — Minimum `100000`, Maximum `999999`.
4. **Text** — Type `qt-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
5. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
6. **Dictionary** — Add these keys (all **Text**):

   | Key | Value |
   | --- | --- |
   | `type` | `text` |
   | `id` | **ID** |
   | `text` | **Said** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

7. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
8. **Show Notification** — Type `Sent to Pitaka: `, insert **Said**.
9. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

### Then

- Settings → **Accessibility** → **Touch** → **Back Tap** → **Triple Tap** → choose **Pitaka Text**.

### Test it

Run it and type `test`. In Pitaka, open Settings → Connect your iPhone → Quick Add – Text and tap **Test** first: it shows ✓ when the shortcut arrives.

## Update Balance

**Whenever you look at your GCash or bank app.** Type the balance the app shows. If Pitaka disagrees, Review offers a visible balance fix (never a hidden change).

### Set up

1. Shortcuts → **+**. Name it `Pitaka Balance`. Add it to your Home Screen or to the Shortcuts widget if you like.

### Actions, in order

1. **Get File** — Turn off **Show Document Picker**. File Path `Pitaka/config.json`. Turn off **Error If Not Found**.
2. **If** — Input **File**, condition **has any value**.
3. **Get Dictionary from Input** — Input **File**.
4. **Set Variable** — Variable Name `Config`.
5. **Get Dictionary Value** — Get **Value** for `wallets` in **Config**.
6. **Set Variable** — Variable Name `Wallets`.
7. **Otherwise** — Already there: Shortcuts added it with the If. Until the relay has sent your lists once, these are used:
8. **Text** — Your wallets and cards, one per line.

   ```
   <your wallets and cards, one per line>
   ```

9. **Split Text** — Split **Text** by **New Lines**.
10. **Set Variable** — Variable Name `Wallets`.
11. **End If** — Already there: Shortcuts added it with the If.
12. **Choose from List** — List **Wallets**. Prompt `Which wallet?`
13. **Set Variable** — Variable Name `Wallet`.
14. **Ask for Input** — Input Type **Number**. Prompt `Balance the app shows ₱`.
15. **Set Variable** — Variable Name `Balance`.
16. **Random Number** — Minimum `100000`, Maximum `999999`.
17. **Text** — Type `bal-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
18. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
19. **Dictionary** — Add these keys (all **Text**):

   | Key | Value |
   | --- | --- |
   | `type` | `balance` |
   | `id` | **ID** |
   | `wallet` | **Wallet** |
   | `amount` | **Balance** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

20. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
21. **Show Notification** — Type `Balance sent: `, insert **Wallet**, type ` ₱`, insert **Balance**.
22. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`
23. **Get Contents of URL** — URL below. Tap the arrow: Method **GET**; Headers: Key `Authorization`, the same Value as above. This fetches your latest lists from Pitaka.

   `<your relay address>/config`

   Authorization value: `Bearer <your write token>`
24. **Save File** — Turn off **Ask Where to Save**. Destination Path `Pitaka/config.json`. Turn on **Overwrite If File Exists**.

### Test it

Run it and type the balance your app shows right now. In Pitaka, open Settings → Connect your iPhone → Update Balance and tap **Test** first: it shows ✓ when the shortcut arrives.

## SMS alerts

**When GCash or your bank texts you.** Each alert goes to Pitaka. It matches alerts to what you logged (₱289 at Jollibee is one purchase, not two) and adds what you didn't log. Formats it can't read wait in Review, where you can teach them.

### Set up

1. Shortcuts → **Automation** → **+** (New Automation).
2. **Message** → **Sender**: choose the bank (save its number as a contact first if you need to). Or **Message Contains**: a word every alert from it has.
3. Choose **Run Immediately** and turn off **Notify When Run**. Tap **Next**, then **New Blank Automation**, and add the actions below.
4. Make one automation for each sender: GCash, GoTyme, Maya, BPI, BDO, UnionBank, Metrobank, Security Bank, RCBC, SeaBank, CIMB.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `sms-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Add these keys (all **Text**). For **sender**, type the bank's name exactly as listed above, like `GCash`.

   | Key | Value |
   | --- | --- |
   | `type` | `sms` |
   | `id` | **ID** |
   | `sender` | `GCash` (the bank this automation is for) |
   | `text` | **Shortcut Input** (tap it: **Content**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

### Test it

In the automation, tap ▶ (play). It runs without a message, which Pitaka counts as a test. In Pitaka, open Settings → Connect your iPhone → SMS alerts and tap **Test** first: it shows ✓ when the shortcut arrives.

## Email alerts (optional)

**When an alert email arrives in Mail.** For banks that email instead of texting. Same matching as SMS. Only the sender, subject and text of alert emails are sent.

### Set up

1. Shortcuts → **Automation** → **+** (New Automation).
2. **Email** → **Sender**: the bank's alert address (or **Subject Contains**: a word in every alert subject).
3. Choose **Run Immediately** and turn off **Notify When Run**. Tap **Next**, then **New Blank Automation**, and add the actions below.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `em-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Add these keys (all **Text**):

   | Key | Value |
   | --- | --- |
   | `type` | `email` |
   | `id` | **ID** |
   | `from` | **Shortcut Input** (tap it: **Sender**) |
   | `subject` | **Shortcut Input** (tap it: **Subject**) |
   | `body` | **Shortcut Input** (tap it: the message text) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

### Test it

In the automation, tap ▶ (play). In Pitaka, open Settings → Connect your iPhone → Email alerts and tap **Test** first: it shows ✓ when the shortcut arrives.

## Apple Wallet (optional)

**When you tap a card in Apple Wallet.** If your card supports transaction automations, each tap-to-pay is sent the moment it happens. Many Philippine cards don't offer this; if the card isn't listed, skip it.

### Set up

1. Shortcuts → **Automation** → **+** (New Automation).
2. **Transaction** → choose your cards → leave the categories as they are.
3. Choose **Run Immediately** and turn off **Notify When Run**. Tap **Next**, then **New Blank Automation**, and add the actions below.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `wl-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Add these keys (all **Text**):

   | Key | Value |
   | --- | --- |
   | `type` | `wallet` |
   | `id` | **ID** |
   | `merchant` | **Shortcut Input** (tap it: **Merchant**) |
   | `amount` | **Shortcut Input** (tap it: **Amount**) |
   | `card` | **Shortcut Input** (tap it: **Card or Pass**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary** to File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

### Test it

In the automation, tap ▶ (play). In Pitaka, open Settings → Connect your iPhone → Apple Wallet and tap **Test** first: it shows ✓ when the shortcut arrives.

## When something doesn't arrive

- **No relay, or offline:** everything is still in iCloud Drive/Shortcuts/Pitaka/inbox.jsonl. In Pitaka: Settings → Inbox and alerts → **Import from Files**. Nothing is added twice.
- **"Couldn't connect" in Shortcuts:** check the relay address and token (Settings → Inbox relay → Copy), and that you're online.
- **401 / wrong token:** the write token changed (you made a new one, or paired again). Paste the new one into each Get Contents of URL.
- **An alert landed in Review as "Unknown format":** tap **Teach** and mark the amount, merchant and balance. Pitaka reads that format from then on.

