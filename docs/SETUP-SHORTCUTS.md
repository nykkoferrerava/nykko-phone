# Connect your iPhone: shortcuts and automations

<!-- Generated from js/guide.js by `node tools/make-docs.mjs`. Edit js/guide.js, not this file. -->

Pitaka shows these same steps in the app (Settings → Connect your iPhone) with your relay address, write
token and lists filled in, a Copy button for each, and a Test button that tells you when a shortcut reached
Pitaka. Here, `<your relay address>` and the like stand for those values.

Shortcuts only collect what you type, or what your bank sends you, and post it to your relay. They never
log in anywhere, read other apps or decide anything. Pitaka picks everything up the next time you open it.

## Before you start

- Set up your relay first (in Pitaka: Settings → Inbox relay). Each shortcut needs its address and write token.
- In the Files app, open **iCloud Drive → Shortcuts** and make a folder named `Pitaka`. Your shortcuts keep their lists and a backup copy of everything they send there. Their file actions use that **Shortcuts** folder: if one shows a different Folder, tap it and choose iCloud Drive → Shortcuts.
- Names below are the actions as the iOS 26 Shortcuts app shows them. Find each one with the search field at the bottom of the shortcut editor. A new action goes at the end; drag it to move it.
- When you tap a field, the bar above the keyboard has **Select Variable** and items like **Current Date** and **Shortcut Input** (swipe it sideways for more). Tap a variable after inserting it to choose a format or a detail.
- "Tap the arrow" means the arrow on an action that shows its other options (Apple's guide calls it **Show More**).
- The first time a shortcut uses your relay or the Pitaka folder, Shortcuts asks for permission: tap **Always Allow**. Run each automation once with ▶ (its Test step) so you get to answer.

## Quick Add – Keypad

**Double-tap the back of your iPhone.** Asks for the amount, the category and the wallet, then sends them to Pitaka. About five seconds, without opening Pitaka.

### Set up

1. Shortcuts → **+** (top right). Tap the name at the top (**New Shortcut**) → **Rename**, and type `Pitaka Keypad`.

### Actions, in order

1. **Get File from Folder** — Folder **Shortcuts**, path `Pitaka/config.json`. Turn off **Error If Not Found**.
2. **If** — Input **File**, condition **has any value**. Shortcuts adds Otherwise and End If below it: the next actions go between If and Otherwise (drag them there).
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
17. **Ask for Input** — Input Type **Number**. Prompt `Amount ₱`. Tap the arrow and check that **Allow Decimal Numbers** is on.
18. **Set Variable** — Variable Name `Amount`.
19. **Choose from List** — List **Categories**. Tap the arrow: Prompt `Category`.
20. **Set Variable** — Variable Name `Category`.
21. **Choose from List** — List **Wallets**. Tap the arrow: Prompt `Wallet or card`.
22. **Set Variable** — Variable Name `Wallet`.
23. **Ask for Input** — Input Type **Text**. Prompt `Note (optional)`. When it runs, you can leave the note empty.
24. **Set Variable** — Variable Name `Note`.
25. **Random Number** — Minimum `100000`, Maximum `999999`.
26. **Text** — Type `kp-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
27. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
28. **Dictionary** — Tap **Add new item** → **Text** for each key below.

   | Key | Value |
   | --- | --- |
   | `type` | `entry` |
   | `id` | **ID** |
   | `amount` | **Amount** |
   | `category` | **Category** |
   | `wallet` | **Wallet** |
   | `note` | **Note** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

29. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
30. **Show Notification** — Type `₱`, insert **Amount**, type ` · `, insert **Category**, type ` · `, insert **Wallet**, type ` saved`.
31. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `entry` |
   | `id` | **ID** |
   | `amount` | **Amount** |
   | `category` | **Category** |
   | `wallet` | **Wallet** |
   | `note` | **Note** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

32. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **GET**. Headers: **Add new header**, Key `Authorization`, the same value as above. This fetches your latest lists from Pitaka.

   `<your relay address>/config`

   Authorization value: `Bearer <your write token>`
33. **Save File** — Turn off **Ask Where to Save**. Folder **Shortcuts**, Subpath `Pitaka/config.json`. Turn on **Overwrite If File Exists**.

### Then

- In the iPhone **Settings** app: **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → under Shortcuts, choose **Pitaka Keypad**.

### Test it

Run it, enter `1`, any category and wallet, and the note `test`. A test never becomes an entry. In Pitaka, open Settings → Connect your iPhone → Quick Add – Keypad and tap **Test** first: it shows ✓ when the shortcut arrives.

## Quick Add – Text

**Triple-tap the back of your iPhone.** One box: type it the way you say it, like `jollibee 289 gcash`, `grab 175`, `sahod 25000 bpi` or `lent mel 500`. Pitaka reads it; anything it isn't sure about waits in Review.

### Set up

1. Shortcuts → **+** (top right). Tap the name at the top (**New Shortcut**) → **Rename**, and type `Pitaka Text`.

### Actions, in order

1. **Ask for Input** — Input Type **Text**. Prompt `What did you spend?`
2. **Set Variable** — Variable Name `Said`.
3. **Random Number** — Minimum `100000`, Maximum `999999`.
4. **Text** — Type `qt-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
5. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
6. **Dictionary** — Tap **Add new item** → **Text** for each key below.

   | Key | Value |
   | --- | --- |
   | `type` | `text` |
   | `id` | **ID** |
   | `text` | **Said** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

7. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
8. **Show Notification** — Type `Sent to Pitaka: `, insert **Said**.
9. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `text` |
   | `id` | **ID** |
   | `text` | **Said** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

### Then

- In the iPhone **Settings** app: **Accessibility** → **Touch** → **Back Tap** → **Triple Tap** → under Shortcuts, choose **Pitaka Text**.

### Test it

Run it and type `test`. In Pitaka, open Settings → Connect your iPhone → Quick Add – Text and tap **Test** first: it shows ✓ when the shortcut arrives.

## Update Balance

**Whenever you look at your GCash or bank app.** Type the balance the app shows. If Pitaka disagrees, Review offers a visible balance fix (never a hidden change).

### Set up

1. Shortcuts → **+** (top right). Tap the name at the top (**New Shortcut**) → **Rename**, and type `Pitaka Balance`. Add it to your Home Screen or to the Shortcuts widget if you like.

### Actions, in order

1. **Get File from Folder** — Folder **Shortcuts**, path `Pitaka/config.json`. Turn off **Error If Not Found**.
2. **If** — Input **File**, condition **has any value**. Shortcuts adds Otherwise and End If below it: the next actions go between If and Otherwise (drag them there).
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
12. **Choose from List** — List **Wallets**. Tap the arrow: Prompt `Which wallet?`
13. **Set Variable** — Variable Name `Wallet`.
14. **Ask for Input** — Input Type **Number**. Prompt `Balance the app shows ₱`. Tap the arrow and check that **Allow Decimal Numbers** is on.
15. **Set Variable** — Variable Name `Balance`.
16. **Random Number** — Minimum `100000`, Maximum `999999`.
17. **Text** — Type `bal-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
18. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
19. **Dictionary** — Tap **Add new item** → **Text** for each key below.

   | Key | Value |
   | --- | --- |
   | `type` | `balance` |
   | `id` | **ID** |
   | `wallet` | **Wallet** |
   | `amount` | **Balance** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

20. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
21. **Show Notification** — Type `Balance sent: `, insert **Wallet**, type ` ₱`, insert **Balance**.
22. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `balance` |
   | `id` | **ID** |
   | `wallet` | **Wallet** |
   | `amount` | **Balance** |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

23. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **GET**. Headers: **Add new header**, Key `Authorization`, the same value as above. This fetches your latest lists from Pitaka.

   `<your relay address>/config`

   Authorization value: `Bearer <your write token>`
24. **Save File** — Turn off **Ask Where to Save**. Folder **Shortcuts**, Subpath `Pitaka/config.json`. Turn on **Overwrite If File Exists**.

### Test it

Run it and type the balance your app shows right now. In Pitaka, open Settings → Connect your iPhone → Update Balance and tap **Test** first: it shows ✓ when the shortcut arrives.

## SMS alerts

**When GCash or your bank texts you.** Each alert goes to Pitaka. It matches alerts to what you logged (₱289 at Jollibee is one purchase, not two) and adds what you didn't log. Formats it can't read wait in Review, where you can teach them.

### Set up

1. Shortcuts → **Automation** → **+** (top right; the first time it's **New Automation**).
2. **Message** → **Message Contains**: a word that every alert from that bank has, typed the way the alerts write it (for example `GCash`). Or use **Sender** if the bank texts you from a number saved in your contacts.
3. Choose **Run Immediately**. If **Notify When Run** is there, turn it off (for Message and Email automations iOS may show a notification each time anyway). Tap **Next**, then **New Blank Automation**, and add the actions below.
4. Make one automation for each bank that texts you: GCash, GoTyme, Maya, BPI, BDO, UnionBank, Metrobank, Security Bank, RCBC, SeaBank, CIMB.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `sms-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Tap **Add new item** → **Text** for each key below. For **sender**, type the bank's name exactly as listed above, like `GCash`.

   | Key | Value |
   | --- | --- |
   | `type` | `sms` |
   | `id` | **ID** |
   | `sender` | `GCash` (the bank this automation is for) |
   | `text` | **Shortcut Input** (tap it: **Content**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `sms` |
   | `id` | **ID** |
   | `sender` | `GCash` (the bank this automation is for) |
   | `text` | **Shortcut Input** (tap it: **Content**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

### Test it

In the automation, tap ▶ (play). It runs without a message, which Pitaka counts as a test. In Pitaka, open Settings → Connect your iPhone → SMS alerts and tap **Test** first: it shows ✓ when the shortcut arrives.

## Email alerts (optional)

**When an alert email arrives in Mail.** For banks that email instead of texting. Same matching as SMS. Only the sender, subject and text of alert emails are sent. It only sees mail that arrives in Apple's Mail app.

### Set up

1. Shortcuts → **Automation** → **+** (top right; the first time it's **New Automation**).
2. **Email** → **Sender**: the bank's alert address (or **Subject Contains**: a word in every alert subject).
3. Choose **Run Immediately**. If **Notify When Run** is there, turn it off (for Message and Email automations iOS may show a notification each time anyway). Tap **Next**, then **New Blank Automation**, and add the actions below.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `em-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Tap **Add new item** → **Text** for each key below.

   | Key | Value |
   | --- | --- |
   | `type` | `email` |
   | `id` | **ID** |
   | `from` | **Shortcut Input** (tap it: **Sender**) |
   | `subject` | **Shortcut Input** (tap it: **Subject**) |
   | `body` | **Shortcut Input** (tap it: **Content**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `email` |
   | `id` | **ID** |
   | `from` | **Shortcut Input** (tap it: **Sender**) |
   | `subject` | **Shortcut Input** (tap it: **Subject**) |
   | `body` | **Shortcut Input** (tap it: **Content**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

### Test it

In the automation, tap ▶ (play). In Pitaka, open Settings → Connect your iPhone → Email alerts and tap **Test** first: it shows ✓ when the shortcut arrives.

## Apple Wallet (optional)

**When you tap a card in Apple Wallet.** Each tap-to-pay with a card in Apple Wallet is sent the moment it happens. If the automation doesn't list any of your cards, skip this. The trigger is known to miss some payments, so keep your SMS or email alerts too.

### Set up

1. Shortcuts → **Automation** → **+** (top right; the first time it's **New Automation**).
2. **Transaction** (it may say **Wallet**) → **When I tap**: choose your cards. Leave the categories and merchants as they are.
3. Choose **Run Immediately**. If **Notify When Run** is there, turn it off (for Message and Email automations iOS may show a notification each time anyway). Tap **Next**, then **New Blank Automation**, and add the actions below.

### Actions, in order

1. **Random Number** — Minimum `100000`, Maximum `999999`.
2. **Text** — Type `wl-`, insert **Current Date** (tap it: Date Format **Custom**, Format String `yyyyMMddHHmmss`), type `-`, insert **Random Number**.
3. **Set Variable** — Variable Name `ID`. Pitaka uses it to never add the same thing twice.
4. **Dictionary** — Tap **Add new item** → **Text** for each key below.

   | Key | Value |
   | --- | --- |
   | `type` | `wallet` |
   | `id` | **ID** |
   | `merchant` | **Shortcut Input** (tap it: **Merchant**) |
   | `amount` | **Shortcut Input** (tap it: **Amount**) |
   | `card` | **Shortcut Input** (tap it: **Card or Pass**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

5. **Append to Text File** — Append **Dictionary**. Folder **Shortcuts**, File Path `Pitaka/inbox.jsonl`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.
6. **Get Contents of URL** — Paste the URL below. Tap the arrow to show more: Method **POST**. Headers: **Add new header**, Key `Authorization`, value below. Request Body **JSON**: add a **Text** field for each key below, with the same value you gave it in the Dictionary.

   `<your relay address>/in`

   Authorization value: `Bearer <your write token>`

   | Key | Value |
   | --- | --- |
   | `type` | `wallet` |
   | `id` | **ID** |
   | `merchant` | **Shortcut Input** (tap it: **Merchant**) |
   | `amount` | **Shortcut Input** (tap it: **Amount**) |
   | `card` | **Shortcut Input** (tap it: **Card or Pass**) |
   | `at` | **Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**) |

### Test it

In the automation, tap ▶ (play). In Pitaka, open Settings → Connect your iPhone → Apple Wallet and tap **Test** first: it shows ✓ when the shortcut arrives.

## When something doesn't arrive

- **No relay, or offline:** everything is still in iCloud Drive/Shortcuts/Pitaka/inbox.jsonl. In Pitaka: Settings → Inbox and alerts → **Import from Files**. Nothing is added twice.
- **Shortcuts shows an error at Get Contents of URL:** check the relay address and write token (in Pitaka: Settings → Inbox relay → Copy), and that you're online. The backup copy was already saved.
- **The shortcut runs, but Test never shows ✓:** the write token probably changed (you made a new one, or paired again). Paste the new one into each Get Contents of URL.
- **Choose from List has nothing to choose:** the last fetch of your lists failed, usually because of the write token. Fix the token in both Get Contents of URL actions, then in the Files app delete iCloud Drive → Shortcuts → Pitaka → config.json. The next run uses the lists typed into the shortcut and fetches them again.
- **An alert landed in Review as "Unknown format":** tap **Teach** and mark the amount, merchant and balance. Pitaka reads that format from then on.

