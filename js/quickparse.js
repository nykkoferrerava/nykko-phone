// Quick Add – Text: "150 lunch gcash", "jollibee 289", "grab 175 gotyme", "₱1,200 groceries bpi card",
// "lent mel 500", "sahod 25000 bpi". DOM-free, runs under Node.
//
// It finds the amount wherever it is, the category from names, your keywords and built-in synonyms, the
// wallet or card from names and aliases, income and lending words, and keeps the rest as the note.
// When it isn't sure (two amounts, no category, two wallets, "utang" without a direction) it says so,
// and the entry goes to Review instead of being guessed.

// Built-in synonyms per category key (keys survive renaming; see store.js DEFAULT_CATEGORIES).
export const SYNONYMS = {
  food: ['food', 'lunch', 'dinner', 'breakfast', 'brunch', 'merienda', 'snack', 'snacks', 'almusal', 'tanghalian', 'hapunan', 'kain', 'ulam', 'coffee', 'kape', 'milk tea', 'milktea',
    'jollibee', 'jolibee', 'mcdo', 'mcdonalds', "mcdonald's", 'kfc', 'chowking', 'greenwich', 'mang inasal', 'inasal', 'burger king', 'starbucks', 'tim hortons', 'dunkin', 'pizza', 'burger',
    'shakeys', "shakey's", 'yellow cab', "max's", 'goldilocks', 'red ribbon', 'tokyo tokyo', 'samgyup', 'samgyupsal', 'karinderya', 'carinderia', 'lugaw', 'siomai', 'bakery', 'pandesal', 'grabfood', 'foodpanda', 'food panda', 'jco', 'krispy kreme'],
  groceries: ['grocery', 'groceries', 'supermarket', 'palengke', 'market', 'puregold', 'savemore', 'sm supermarket', 'sm market', 'robinsons supermarket', 'waltermart', 'landers', 's&r', 'snr', 'alfamart', 'uncle johns', 'ministop', '7-eleven', '7 eleven', '7eleven', 'seven eleven'],
  transport: ['transport', 'fare', 'pamasahe', 'grab', 'angkas', 'joyride', 'move it', 'moveit', 'jeep', 'jeepney', 'tricycle', 'trike', 'bus', 'mrt', 'lrt', 'beep', 'taxi', 'uber', 'p2p', 'gas', 'gasolina', 'gasoline', 'fuel', 'diesel', 'petron', 'shell', 'caltex', 'seaoil', 'parking', 'toll', 'autosweep', 'easytrip', 'rfid', 'indrive', 'lalamove'],
  bills: ['bill', 'bills', 'meralco', 'kuryente', 'electric', 'electricity', 'maynilad', 'manila water', 'tubig', 'water bill', 'rent', 'upa', 'association dues', 'condo dues', 'pldt', 'converge', 'sky cable', 'skycable', 'cignal', 'internet bill', 'wifi bill'],
  load: ['load', 'eload', 'e-load', 'prepaid', 'globe', 'smart', 'tnt', 'tm', 'dito', 'gomo', 'sun', 'gigasurf', 'giga', 'data', 'promo', 'regular load'],
  shopping: ['shopping', 'shopee', 'lazada', 'zalora', 'shein', 'tiktok shop', 'uniqlo', 'h&m', 'penshoppe', 'bench', 'mall', 'clothes', 'damit', 'shoes', 'sapatos', 'gadget', 'abenson', 'ace hardware', 'handyman', 'ikea', 'daiso', 'miniso', 'watsons'],
  health: ['health', 'pharmacy', 'mercury', 'mercury drug', 'botika', 'gamot', 'medicine', 'meds', 'doctor', 'checkup', 'check-up', 'hospital', 'clinic', 'dentist', 'vitamins', 'laboratory', 'lab test', 'rose pharmacy', 'southstar', 'generika', 'tgp'],
  fun: ['fun', 'movie', 'movies', 'sine', 'cinema', 'concert', 'gaming', 'games', 'steam', 'bar', 'inuman', 'beer', 'karaoke', 'videoke', 'bowling', 'arcade', 'timezone', 'gala', 'staycation', 'travel'],
  family: ['family', 'padala', 'allowance', 'baon', 'nanay', 'tatay', 'mama', 'papa', 'mom', 'dad', 'pamilya', 'tuition', 'school', 'kids', 'anak'],
  personal: ['haircut', 'gupit', 'salon', 'barber', 'barbershop', 'spa', 'massage', 'nails', 'manicure', 'pedicure', 'skincare', 'grooming', 'toiletries'],
  subscriptions: ['subscription', 'netflix', 'spotify', 'youtube premium', 'youtube', 'disney', 'disney+', 'viu', 'icloud', 'apple music', 'apple one', 'google one', 'prime video', 'hbo', 'canva', 'iwanttfc', 'vivamax', 'crunchyroll', 'chatgpt'],
  other: [],
};
// Words that make it income, lending (they owe you), borrowing (you owe) or ambiguous "utang".
const INCOME = ['sahod', 'sweldo', 'suweldo', 'salary', 'payroll', 'received', 'natanggap', 'income', 'bonus', '13th month', 'refund', 'cashback', 'cash back', 'commission', 'sideline', 'freelance', 'payment received', 'got paid', 'kita', 'tip', 'tips'];
const LEND = ['lent', 'lend', 'pautang', 'pinautang', 'nagpautang', 'loaned', 'pinahiram'];
const BORROW = ['borrowed', 'hiniram', 'hiram', 'nanghiram', 'inutang', 'borrow'];
const UTANG = ['utang'];
const FILLER = ['kay', 'ni', 'si', 'sa', 'to', 'from', 'with', 'using', 'via', 'gamit', 'thru', 'through', 'at', 'for', 'the', 'my', 'ko', 'ang', 'ng', 'na', 'on', 'paid', 'bayad', 'spent', 'and', 'from', '-', '–', '·'];

// Wallet and bank aliases: a word in the text -> words that may appear in your wallet or card names.
export const WALLET_ALIASES = [
  ['gcash', 'g-cash', 'g cash', 'gc'],
  ['gotyme', 'go tyme', 'tyme', 'gotyme bank'],
  ['maya', 'paymaya'],
  ['seabank', 'sea bank', 'maribank'],
  ['bpi'], ['bdo'], ['unionbank', 'union bank', 'ub', 'ubp'], ['metrobank', 'metro bank', 'mbtc'], ['security bank', 'securitybank', 'secbank'],
  ['rcbc'], ['cimb'], ['landbank', 'land bank', 'lbp'], ['pnb'], ['chinabank', 'china bank'], ['eastwest', 'east west'], ['psbank'], ['tonik'], ['coins.ph', 'coins'], ['shopeepay', 'shopee pay'], ['grabpay', 'grab pay'],
  ['cash', 'pera', 'cash on hand', 'coh', 'wallet', 'pitaka'],
];
const CARD_WORDS = ['card', 'credit card', 'cc', 'credit'];

// Dots, apostrophes and hyphens count only inside a word ("coins.ph", "7-eleven"), not at its edges ("gcash.").
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9&+.'-]+/g, ' ').replace(/(^|\s)[.'-]+|[.'-]+(?=\s|$)/g, '$1').trim();
const hasPhrase = (text, phrase) => ` ${words(text)} `.includes(` ${words(phrase)} `);
export const titleCase = (s) => String(s || '').replace(/\b([a-z])/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------- amounts
// ₱1,200 · 1,200.50 · 1.2k · 2k · php 500 · p500 · 500php · 500 pesos. Phone numbers, long references,
// dates and words with digits (7-eleven, 13th) are not amounts. Nor is a part of a mistyped number
// ("12,00", "1,2k"): a digit and a comma right before it, or a comma and a digit right after it.
const AMOUNT_RE = /(?<![\w./-]|\d,)(?:(₱|php|p)\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s?k)?(?:\s?(php|pesos?|peso))?(?![\w/-]|[.,]\d)/gi;
export function findAmounts(text) {
  const out = [];
  for (const m of String(text || '').matchAll(AMOUNT_RE)) {
    const [whole, cur, num, k, after] = m;
    const digits = num.replace(/[,.]/g, '');
    if (/^(?:0?9\d{9}|639\d{9})$/.test(digits) || (!num.includes(',') && !num.includes('.') && digits.length > 7)) continue;
    let n = Number(num.replace(/,/g, ''));
    if (k) n *= 1000;
    n = Math.round(n * 100) / 100;
    if (!(n > 0) || n > 1e9) continue;
    out.push({ value: n, start: m.index, end: m.index + whole.length, marked: !!(cur || after || k) });
  }
  return out;
}

// ---------------------------------------------------------------- categories
// ctx.categories: [{ id, name, emoji, key, also, keywords, hidden }]. Your keywords beat names, names beat synonyms.
function matchCategory(text, categories) {
  const hits = [];
  for (const c of categories) {
    if (c.hidden) continue;
    for (const kw of String(c.keywords || '').split(',').map((x) => x.trim()).filter(Boolean)) if (hasPhrase(text, kw)) hits.push({ c, rank: 3, word: kw });
    const name = c.name.toLowerCase();
    if (hasPhrase(text, name)) hits.push({ c, rank: 2, word: name });
    else {
      // "grocery" for "Groceries", "bill" for "Bills & Utilities"
      for (const w of words(name).split(' ').filter((x) => x.length >= 4)) {
        const stem = w.replace(/(ies|es|s)$/, '');
        for (const t of words(text).split(' ')) if (t.length >= 4 && (t.startsWith(stem) || stem.startsWith(t.replace(/(ies|es|s|y)$/, '')))) hits.push({ c, rank: 1.5, word: t });
      }
    }
    for (const syn of [c.key, ...(c.also || [])].flatMap((k) => SYNONYMS[k] || [])) if (hasPhrase(text, syn) || hasPhrase(text, `${syn}s`)) hits.push({ c, rank: 1 + syn.length / 100, word: hasPhrase(text, syn) ? syn : `${syn}s` });
  }
  if (!hits.length) return { category: null, words: [], conflict: false };
  hits.sort((a, b) => b.rank - a.rank);
  const best = hits[0];
  const rivals = hits.filter((h) => h.c !== best.c && h.rank >= Math.floor(best.rank));
  return { category: best.c, words: hits.filter((h) => h.c === best.c).map((h) => h.word), conflict: rivals.length > 0 };
}

// The category a merchant or a few words point to (null when nothing matches or it's a toss-up).
export function guessCategory(text, categories) {
  const m = matchCategory(text, categories || []);
  return m.conflict ? null : m.category;
}

// ---------------------------------------------------------------- wallets and cards
// ctx.accounts: [{ id, name }], ctx.cards: [{ id, name, lender }]. Returns { accountId | cardId, words, conflict }.
export function matchWallet(text, { accounts = [], cards = [] } = {}) {
  const t = words(text);
  const wantsCard = CARD_WORDS.some((w) => hasPhrase(t, w));
  const found = [];
  const tryList = (list, kind) => {
    for (const a of list) {
      const label = `${a.name} ${a.lender || ''}`;
      if (hasPhrase(t, a.name)) { found.push({ kind, id: a.id, words: [a.name], rank: 3 }); continue; }
      for (const group of WALLET_ALIASES) {
        const said = group.find((al) => hasPhrase(t, al));
        if (said && group.some((al) => hasPhrase(label, al))) { found.push({ kind, id: a.id, words: [said], rank: 2 }); break; }
      }
    }
  };
  tryList(accounts, 'account');
  tryList(cards, 'card');
  if (!found.length) return { accountId: null, cardId: null, words: [], conflict: false, wantsCard };
  // "bpi card" -> the BPI credit card; "bpi" alone -> the BPI wallet if there is one.
  found.sort((a, b) => (wantsCard ? (b.kind === 'card') - (a.kind === 'card') : (b.kind === 'account') - (a.kind === 'account')) || b.rank - a.rank);
  const best = found[0];
  const distinct = new Set(found.filter((f) => f.rank >= best.rank && f.kind === best.kind).map((f) => f.id));
  const usedWords = [...best.words, ...(wantsCard && best.kind === 'card' ? CARD_WORDS.filter((w) => hasPhrase(t, w)) : [])];
  return { accountId: best.kind === 'account' ? best.id : null, cardId: best.kind === 'card' ? best.id : null, words: usedWords, conflict: distinct.size > 1, wantsCard };
}

// ---------------------------------------------------------------- the parser
// ctx: { categories, accounts, cards, defaultAccountId }.
// Returns { ok, kind: 'expense'|'income'|'lend'|'borrow'|'utang', amount, categoryId, accountId, cardId,
//           person, note, merchant, confidence: 'high'|'low', reasons: [] }
export function parseQuick(input, ctx = {}) {
  const text = String(input || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const reasons = [];
  const out = { ok: false, kind: 'expense', amount: null, categoryId: null, accountId: null, cardId: null, person: '', note: '', merchant: '', confidence: 'low', reasons, text };
  if (!text) { reasons.push('empty'); return out; }

  // amount
  const amounts = findAmounts(text);
  const marked = amounts.filter((a) => a.marked);
  const pick = marked.length === 1 ? marked[0] : amounts.length === 1 ? amounts[0] : marked.length ? null : amounts.slice().sort((a, b) => b.value - a.value)[0];
  if (!pick) { reasons.push(amounts.length ? 'several amounts' : 'no amount'); }
  else {
    out.amount = pick.value;
    out.ok = true;
    if (amounts.length > 1 && marked.length !== 1) reasons.push('several amounts');
  }
  const rest = pick ? `${text.slice(0, pick.start)} ${text.slice(pick.end)}` : text;

  // kind
  const lw = words(rest);
  const has = (list) => list.find((w) => hasPhrase(lw, w));
  const lend = has(LEND), borrow = has(BORROW), income = has(INCOME), utang = has(UTANG);
  let marker = null;
  if (lend) { out.kind = 'lend'; marker = lend; }
  else if (borrow || /\butang\s+ko\b/.test(lw)) { out.kind = 'borrow'; marker = borrow || 'utang'; reasons.push('borrowed'); }
  else if (utang) { out.kind = 'utang'; marker = utang; reasons.push('utang: lent or borrowed?'); }
  else if (income) { out.kind = 'income'; marker = income; }

  // wallet or card
  const w = matchWallet(rest, ctx);
  if (w.conflict) reasons.push('two wallets');
  if (out.kind === 'expense' && w.cardId) out.cardId = w.cardId;
  else if (w.accountId) out.accountId = w.accountId;
  else if (w.cardId && out.kind !== 'expense') reasons.push('card for a non-expense');
  if (!out.accountId && !out.cardId) out.accountId = ctx.defaultAccountId || null;

  // what's left: person (lending) or category + note
  let left = ` ${rest} `;
  const drop = (phrase) => { left = left.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu'), '$1 '); };
  for (const x of w.words) drop(x);
  if (marker) drop(marker);
  if (/\butang\s+ko\b/i.test(left)) drop('ko');
  if (['lend', 'borrow', 'utang'].includes(out.kind)) {
    const toks = left.split(/\s+/).filter(Boolean).filter((x) => !FILLER.includes(x.toLowerCase()));
    out.person = titleCase(toks.slice(0, 3).join(' ').toLowerCase()).slice(0, 60);
    if (!out.person) reasons.push('no person');
    out.note = '';
  } else {
    if (out.kind === 'expense') {
      const m = matchCategory(rest, ctx.categories || []);
      if (m.category) out.categoryId = m.category.id;
      else reasons.push('no category');
      if (m.conflict) reasons.push('two categories');
      // a merchant is a synonym that names a business (not a generic word like "lunch")
      const merchantWord = m.words.find((x) => x.length > 2 && !['food', 'lunch', 'dinner', 'breakfast', 'snack', 'snacks', 'grocery', 'groceries', 'fare', 'load', 'bill', 'bills', 'rent', 'gas', 'shopping', 'medicine', 'coffee', 'kape'].includes(x) && !(ctx.categories || []).some((c) => c.name.toLowerCase() === x));
      if (merchantWord) out.merchant = titleCase(merchantWord);
    }
    const note = left.split(/\s+/).filter(Boolean).filter((x, i, a) => !FILLER.includes(x.toLowerCase()) || (i > 0 && i < a.length - 1)).join(' ').trim();
    out.note = note ? note[0].toUpperCase() + note.slice(1) : '';
  }

  // confidence
  const sure = out.ok && !reasons.length && (
    (out.kind === 'expense' && out.categoryId) || out.kind === 'income' || (out.kind === 'lend' && out.person));
  out.confidence = sure ? 'high' : 'low';
  return out;
}
