// "Connect your iPhone": the shortcuts and automations, step by step. One source for the in-app guide
// (js/ui-guide.js fills in your relay address, write token and lists) and docs/SETUP-SHORTCUTS.md
// (guideMarkdown(), checked by tests/guide.test.mjs). DOM-free.
//
// Shortcuts only collect and post: they never read balances from apps, log in anywhere or decide
// anything. Each one also appends the same line to iCloud Drive/Shortcuts/Pitaka/inbox.jsonl, so nothing
// is lost when the relay can't be reached (Settings -> Inbox and alerts -> Import from Files).
//
// Placeholders filled in by fill(): {URL} relay address, {TOKEN} write token, {CATEGORIES} and
// {WALLETS} your lists, one per line.

export const FOLDER = 'Pitaka';
export const INBOX_FILE = `${FOLDER}/inbox.jsonl`;
export const CONFIG_FILE = `${FOLDER}/config.json`;
export const INSTITUTIONS = ['GCash', 'GoTyme', 'Maya', 'BPI', 'BDO', 'UnionBank', 'Metrobank', 'Security Bank', 'RCBC', 'SeaBank', 'CIMB'];

// A step: { a: action name as Shortcuts shows it, d: what to set (`code` is typed exactly, **bold** is a
// menu choice or a variable), copy: text for a Copy button, keys: [[key, value]] for a Dictionary }.
const step = (a, d, extra = {}) => ({ a, d, ...extra });
const at = ['at', '**Current Date** (tap it: Date Format **ISO 8601**, Include ISO 8601 Time **on**)'];

const id = (prefix) => [
  step('Random Number', 'Minimum `100000`, Maximum `999999`.'),
  step('Text', `Type \`${prefix}-\`, insert **Current Date** (tap it: Date Format **Custom**, Format String \`yyyyMMddHHmmss\`), type \`-\`, insert **Random Number**.`, { copy: 'yyyyMMddHHmmss' }),
  step('Set Variable', 'Variable Name `ID`. Pitaka uses it to never add the same thing twice.'),
];
const lists = (which = ['categories', 'wallets']) => [
  step('Get File', `Turn off **Show Document Picker**. File Path \`${CONFIG_FILE}\`. Turn off **Error If Not Found**.`, { copy: CONFIG_FILE }),
  step('If', 'Input **File**, condition **has any value**.'),
  step('Get Dictionary from Input', 'Input **File**.'),
  step('Set Variable', 'Variable Name `Config`.'),
  ...which.flatMap((k) => [
    step('Get Dictionary Value', `Get **Value** for \`${k}\` in **Config**.`, { copy: k }),
    step('Set Variable', `Variable Name \`${k === 'categories' ? 'Categories' : 'Wallets'}\`.`),
  ]),
  step('Otherwise', 'Already there: Shortcuts added it with the If. Until the relay has sent your lists once, these are used:'),
  ...which.flatMap((k) => [
    step('Text', k === 'categories' ? 'Your categories, one per line.' : 'Your wallets and cards, one per line.', { copy: k === 'categories' ? '{CATEGORIES}' : '{WALLETS}', block: true }),
    step('Split Text', 'Split **Text** by **New Lines**.'),
    step('Set Variable', `Variable Name \`${k === 'categories' ? 'Categories' : 'Wallets'}\`.`),
  ]),
  step('End If', 'Already there: Shortcuts added it with the If.'),
];
const save = step('Append to Text File', `Append **Dictionary** to File Path \`${INBOX_FILE}\`. Turn on **Make New Line**. This copy in iCloud Drive is your backup for when the relay can't be reached.`, { copy: INBOX_FILE });
const post = step('Get Contents of URL', 'URL below. Tap the arrow: Method **POST**; Headers: add one, Key `Authorization`, Value below; Request Body **File**, choose **Dictionary**.', { copy: '{URL}/in', copy2: ['Authorization value', 'Bearer {TOKEN}'] });
const refresh = [
  step('Get Contents of URL', 'URL below. Tap the arrow: Method **GET**; Headers: Key `Authorization`, the same Value as above. This fetches your latest lists from Pitaka.', { copy: '{URL}/config', copy2: ['Authorization value', 'Bearer {TOKEN}'] }),
  step('Save File', `Turn off **Ask Where to Save**. Destination Path \`${CONFIG_FILE}\`. Turn on **Overwrite If File Exists**.`, { copy: CONFIG_FILE }),
];
const automation = (trigger) => [
  'Shortcuts → **Automation** → **+** (New Automation).',
  trigger,
  'Choose **Run Immediately** and turn off **Notify When Run**. Tap **Next**, then **New Blank Automation**, and add the actions below.',
];

export const SHORTCUTS = [
  {
    id: 'keypad', title: 'Quick Add – Keypad', name: 'Pitaka Keypad', icon: 'vibrate', types: ['entry'],
    when: 'Double-tap the back of your iPhone',
    what: 'Asks for the amount, the category and the wallet, then sends them to Pitaka. About five seconds, without opening Pitaka.',
    setup: ['Shortcuts → **+** (new shortcut). Name it `Pitaka Keypad`.'],
    steps: [
      ...lists(),
      step('Ask for Input', 'Input Type **Number**. Prompt `Amount ₱`.', { copy: 'Amount ₱' }),
      step('Set Variable', 'Variable Name `Amount`.'),
      step('Choose from List', 'List **Categories**. Prompt `Category`.'),
      step('Set Variable', 'Variable Name `Category`.'),
      step('Choose from List', 'List **Wallets**. Prompt `Wallet or card`.'),
      step('Set Variable', 'Variable Name `Wallet`.'),
      step('Ask for Input', 'Input Type **Text**. Prompt `Note (optional)`.'),
      step('Set Variable', 'Variable Name `Note`.'),
      ...id('kp'),
      step('Dictionary', 'Add these keys (all **Text**):', { keys: [['type', '`entry`'], ['id', '**ID**'], ['amount', '**Amount**'], ['category', '**Category**'], ['wallet', '**Wallet**'], ['note', '**Note**'], at] }),
      save,
      step('Show Notification', 'Type `₱`, insert **Amount**, type ` · `, insert **Category**, type ` · `, insert **Wallet**, type ` saved`.', { copy: ' · ' }),
      post,
      ...refresh,
    ],
    after: ['Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → choose **Pitaka Keypad**.'],
    test: 'Run it, enter `1`, any category and wallet, and the note `test`. A test never becomes an entry.',
  },
  {
    id: 'text', title: 'Quick Add – Text', name: 'Pitaka Text', icon: 'edit', types: ['text'],
    when: 'Triple-tap the back of your iPhone',
    what: 'One box: type it the way you say it, like `jollibee 289 gcash`, `grab 175`, `sahod 25000 bpi` or `lent mel 500`. Pitaka reads it; anything it isn\'t sure about waits in Review.',
    setup: ['Shortcuts → **+**. Name it `Pitaka Text`.'],
    steps: [
      step('Ask for Input', 'Input Type **Text**. Prompt `What did you spend?`', { copy: 'What did you spend?' }),
      step('Set Variable', 'Variable Name `Said`.'),
      ...id('qt'),
      step('Dictionary', 'Add these keys (all **Text**):', { keys: [['type', '`text`'], ['id', '**ID**'], ['text', '**Said**'], at] }),
      save,
      step('Show Notification', 'Type `Sent to Pitaka: `, insert **Said**.'),
      post,
    ],
    after: ['Settings → **Accessibility** → **Touch** → **Back Tap** → **Triple Tap** → choose **Pitaka Text**.'],
    test: 'Run it and type `test`.',
  },
  {
    id: 'balance', title: 'Update Balance', name: 'Pitaka Balance', icon: 'wallet', types: ['balance'],
    when: 'Whenever you look at your GCash or bank app',
    what: 'Type the balance the app shows. If Pitaka disagrees, Review offers a visible balance fix (never a hidden change).',
    setup: ['Shortcuts → **+**. Name it `Pitaka Balance`. Add it to your Home Screen or to the Shortcuts widget if you like.'],
    steps: [
      ...lists(['wallets']),
      step('Choose from List', 'List **Wallets**. Prompt `Which wallet?`'),
      step('Set Variable', 'Variable Name `Wallet`.'),
      step('Ask for Input', 'Input Type **Number**. Prompt `Balance the app shows ₱`.', { copy: 'Balance the app shows ₱' }),
      step('Set Variable', 'Variable Name `Balance`.'),
      ...id('bal'),
      step('Dictionary', 'Add these keys (all **Text**):', { keys: [['type', '`balance`'], ['id', '**ID**'], ['wallet', '**Wallet**'], ['amount', '**Balance**'], at] }),
      save,
      step('Show Notification', 'Type `Balance sent: `, insert **Wallet**, type ` ₱`, insert **Balance**.'),
      post,
      ...refresh,
    ],
    after: [],
    test: 'Run it and type the balance your app shows right now.',
  },
  {
    id: 'sms', title: 'SMS alerts', name: 'one automation per bank', icon: 'message', types: ['sms'], automation: true,
    when: 'When GCash or your bank texts you',
    what: 'Each alert goes to Pitaka. It matches alerts to what you logged (₱289 at Jollibee is one purchase, not two) and adds what you didn\'t log. Formats it can\'t read wait in Review, where you can teach them.',
    setup: [
      ...automation('**Message** → **Sender**: choose the bank (save its number as a contact first if you need to). Or **Message Contains**: a word every alert from it has.'),
      `Make one automation for each sender: ${INSTITUTIONS.join(', ')}.`,
    ],
    steps: [
      ...id('sms'),
      step('Dictionary', 'Add these keys (all **Text**). For **sender**, type the bank\'s name exactly as listed above, like `GCash`.', { keys: [['type', '`sms`'], ['id', '**ID**'], ['sender', '`GCash` (the bank this automation is for)'], ['text', '**Shortcut Input** (tap it: **Content**)'], at] }),
      save,
      post,
    ],
    after: [],
    test: 'In the automation, tap ▶ (play). It runs without a message, which Pitaka counts as a test.',
  },
  {
    id: 'email', title: 'Email alerts', name: 'optional', icon: 'mail', types: ['email'], automation: true, optional: true,
    when: 'When an alert email arrives in Mail',
    what: 'For banks that email instead of texting. Same matching as SMS. Only the sender, subject and text of alert emails are sent.',
    setup: automation('**Email** → **Sender**: the bank\'s alert address (or **Subject Contains**: a word in every alert subject).'),
    steps: [
      ...id('em'),
      step('Dictionary', 'Add these keys (all **Text**):', { keys: [['type', '`email`'], ['id', '**ID**'], ['from', '**Shortcut Input** (tap it: **Sender**)'], ['subject', '**Shortcut Input** (tap it: **Subject**)'], ['body', '**Shortcut Input** (tap it: the message text)'], at] }),
      save,
      post,
    ],
    after: [],
    test: 'In the automation, tap ▶ (play).',
  },
  {
    id: 'wallet', title: 'Apple Wallet', name: 'optional', icon: 'card', types: ['wallet'], automation: true, optional: true,
    when: 'When you tap a card in Apple Wallet',
    what: 'If your card supports transaction automations, each tap-to-pay is sent the moment it happens. Many Philippine cards don\'t offer this; if the card isn\'t listed, skip it.',
    setup: automation('**Transaction** → choose your cards → leave the categories as they are.'),
    steps: [
      ...id('wl'),
      step('Dictionary', 'Add these keys (all **Text**):', { keys: [['type', '`wallet`'], ['id', '**ID**'], ['merchant', '**Shortcut Input** (tap it: **Merchant**)'], ['amount', '**Shortcut Input** (tap it: **Amount**)'], ['card', '**Shortcut Input** (tap it: **Card or Pass**)'], at] }),
      save,
      post,
    ],
    after: [],
    test: 'In the automation, tap ▶ (play).',
  },
];
export const shortcut = (id) => SHORTCUTS.find((s) => s.id === id);

export const BEFORE = [
  'Set up your relay first (Settings → Inbox relay). Each shortcut needs its address and write token.',
  'In the Files app, open **iCloud Drive → Shortcuts** and make a folder named `Pitaka`. Your shortcuts keep their lists and a backup copy of everything they send there.',
  'Names below are the actions as the iOS 26 Shortcuts app shows them: search for them with the search field at the bottom of the shortcut editor.',
];

// Fills the placeholders for one person; missing values become readable stand-ins.
export function fill(text, v = {}) {
  return String(text)
    .replaceAll('{URL}', v.url || '<your relay address>')
    .replaceAll('{TOKEN}', v.token || '<your write token>')
    .replaceAll('{CATEGORIES}', v.categories || '<your categories, one per line>')
    .replaceAll('{WALLETS}', v.wallets || '<your wallets and cards, one per line>');
}

// docs/SETUP-SHORTCUTS.md, generated from the steps above (node tools/make-docs.mjs).
export function guideMarkdown() {
  const out = [
    '# Connect your iPhone: shortcuts and automations',
    '',
    '<!-- Generated from js/guide.js by `node tools/make-docs.mjs`. Edit js/guide.js, not this file. -->',
    '',
    'Pitaka shows these same steps in the app (Settings → Connect your iPhone) with your relay address, write',
    'token and lists filled in, a Copy button for each, and a Test button that tells you when a shortcut reached',
    'Pitaka. Here, `<your relay address>` and the like stand for those values.',
    '',
    'Shortcuts only collect what you type, or what your bank sends you, and post it to your relay. They never',
    'log in anywhere, read other apps or decide anything. Pitaka picks everything up the next time you open it.',
    '',
    '## Before you start',
    '',
    ...BEFORE.map((b) => `- ${b}`),
    '',
  ];
  for (const s of SHORTCUTS) {
    out.push(`## ${s.title}${s.optional ? ' (optional)' : ''}`, '', `**${s.when}.** ${s.what}`, '');
    out.push('### Set up', '', ...s.setup.map((x, i) => `${i + 1}. ${x}`), '');
    out.push('### Actions, in order', '');
    s.steps.forEach((st, i) => {
      out.push(`${i + 1}. **${st.a}** — ${st.d}`);
      if (st.copy && st.block) out.push('', '   ```', `   ${fill(st.copy)}`, '   ```', '');
      else if (st.copy?.includes('{')) out.push('', `   \`${fill(st.copy)}\``, '');
      if (st.copy2) out.push(`   ${st.copy2[0]}: \`${fill(st.copy2[1])}\``);
      if (st.keys) {
        out.push('', '   | Key | Value |', '   | --- | --- |');
        for (const [k, v] of st.keys) out.push(`   | \`${k}\` | ${v} |`);
        out.push('');
      }
    });
    out.push('');
    if (s.after.length) out.push('### Then', '', ...s.after.map((x) => `- ${x}`), '');
    out.push('### Test it', '', `${s.test} In Pitaka, open Settings → Connect your iPhone → ${s.title} and tap **Test** first: it shows ✓ when the shortcut arrives.`, '');
  }
  out.push('## When something doesn\'t arrive', '',
    '- **No relay, or offline:** everything is still in iCloud Drive/Shortcuts/Pitaka/inbox.jsonl. In Pitaka: Settings → Inbox and alerts → **Import from Files**. Nothing is added twice.',
    '- **"Couldn\'t connect" in Shortcuts:** check the relay address and token (Settings → Inbox relay → Copy), and that you\'re online.',
    '- **401 / wrong token:** the write token changed (you made a new one, or paired again). Paste the new one into each Get Contents of URL.',
    '- **An alert landed in Review as "Unknown format":** tap **Teach** and mark the amount, merchant and balance. Pitaka reads that format from then on.',
    '');
  return out.filter((line, i, a) => !(line === '' && a[i - 1] === '')).join('\n');
}
