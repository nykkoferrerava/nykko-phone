// Bank and e-wallet alerts (SMS, email, Apple Wallet) -> what happened. DOM-free, runs under Node.
//
// The built-in formats below were written WITHOUT real sample messages: they are best guesses at how
// GCash, GoTyme, Maya and the banks word their alerts, and every one is labelled `unverified`.
// When a message doesn't match, it goes to Review, where "Teach this format" turns it into a saved
// template (see buildTemplate) that matches the next ones from the same sender exactly.
// docs/ALERT-FORMATS.md lists them and explains how to send redacted samples to tighten them.

// What a message can mean. transfer-out / transfer-in become a transfer when the other side is one of
// your own wallets, otherwise an expense or income (or a question in Review).
export const TEMPLATE_KINDS = ['expense', 'income', 'transfer-out', 'transfer-in'];

const NUM = '([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)';
const CUR = '(?:PHP|Php|php|P|₱)\\s?';
const AMT = `${CUR}${NUM}`;
const PHONE = '(?:\\+?63|0)9\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{4}';
const rx = (src, flags = 'i') => new RegExp(src.replaceAll('AMT', AMT).replaceAll('PHONE', PHONE), flags);

export function parseMoney(s) {
  const t = String(s ?? '').replace(/[₱,\s]/g, '').replace(/^(php|p)/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100) / 100;
  return n > 0 ? n : null;
}
const tidy = (s) => String(s || '').replace(new RegExp(PHONE, 'g'), '').replace(/\s+/g, ' ').replace(/^[\s:,-]+|[\s.,:;-]+$/g, '').slice(0, 80);

// ---------------------------------------------------------------- pieces found in most alerts
const BALANCE = rx('(?:new|available|current|remaining|updated|running|avail\\.?)\\s+(?:account\\s+|wallet\\s+|acct\\s+)?bal(?:ance)?\\.?(?:\\s+(?:is|of|now|:))?\\s*[:=]?\\s*AMT');
const REF = /\bRef(?:erence)?\.?\s*(?:No\.?|Number|#|ID)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9-]{5,39})\b/i;
const LAST4 = /(?:ending(?:\s+in|\s+with)?:?|\*{2,}|[xX]{3,}|card\s+no\.?\s*\**|acct\.?\s*(?:no\.?)?\s*\**)\s*(\d{4})\b/i;
export const balanceOf = (text) => { const m = BALANCE.exec(text); return m ? parseMoney(m[1]) : null; };
export const refOf = (text) => { const m = REF.exec(text); return m && /\d/.test(m[1]) ? m[1] : null; };
export const last4Of = (text) => { const m = LAST4.exec(text); return m ? m[1] : null; };

// ---------------------------------------------------------------- built-in formats (unverified)
// Each rule: [pattern, kind, { amount, merchant, last4 } capture positions, confidence, fixed merchant].
const GCASH_RULES = [
  [rx('You have received\\s+AMT\\s+(?:of GCash\\s+)?from\\s+(.+?)(?:\\s+PHONE)?\\s*(?:on\\s|\\.\\s|w/|with\\b|Your\\b|$)'), 'transfer-in', { amount: 1, merchant: 2 }, 0.85],
  [rx('You have sent\\s+AMT\\s+(?:of GCash\\s+)?to\\s+(.+?)(?:\\s+PHONE)?\\s*(?:on\\s|\\.\\s|with\\b|Your\\b|$)'), 'transfer-out', { amount: 1, merchant: 2 }, 0.85],
  [rx('You have paid\\s+AMT\\s+(?:to|for|at)\\s+(.+?)\\s*(?:on\\s|\\.\\s|via\\b|with\\b|Your\\b|Ref|$)'), 'expense', { amount: 1, merchant: 2 }, 0.85],
  [rx('(?:bill\\s+)?payment of\\s+AMT\\s+(?:to|for)\\s+(.+?)\\s+(?:has been|was|is)\\b'), 'expense', { amount: 1, merchant: 2 }, 0.85],
  [rx('(?:successfully\\s+)?(?:loaded|bought|purchased)\\s+(?:load\\s+)?(?:worth\\s+|of\\s+)?AMT'), 'expense', { amount: 1 }, 0.85, 'Load'],
  [rx('(?:successfully\\s+)?cash(?:ed)?[\\s-]?in\\s+(?:of\\s+)?AMT(?:\\s+(?:via|from|thru|through|at)\\s+(.+?))?\\s*(?:on\\s|\\.\\s|Your\\b|Ref|$)'), 'transfer-in', { amount: 1, merchant: 2 }, 0.8, 'Cash-in'],
  [rx('(?:transfer(?:red)?|sent)\\s+AMT\\s+to\\s+(.+?)\\s+(?:account|acct)'), 'transfer-out', { amount: 1, merchant: 2 }, 0.8],
];
// Phrasing shared by e-wallets and banks.
const COMMON_RULES = [
  [rx('You (?:have )?(?:sent|transferred)\\s+AMT\\s+to\\s+(.+?)(?:\\s+PHONE)?\\s*(?:on\\s|\\.\\s|via\\b|thru\\b|$)'), 'transfer-out', { amount: 1, merchant: 2 }, 0.8],
  [rx('You (?:have )?received\\s+AMT\\s+from\\s+(.+?)(?:\\s+PHONE)?\\s*(?:on\\s|\\.\\s|via\\b|thru\\b|$)'), 'transfer-in', { amount: 1, merchant: 2 }, 0.8],
  [rx('You (?:have )?paid\\s+AMT\\s+(?:to|at|for)\\s+(.+?)\\s*(?:on\\s|\\.\\s|via\\b|using\\b|$)'), 'expense', { amount: 1, merchant: 2 }, 0.8],
  [rx('(?:card|cc)\\b[^.]{0,60}?(?:ending(?:\\s+in)?|\\*+|x{2,})\\s*(\\d{4})[^.]{0,80}?(?:used|charged|purchase|transaction|payment)[^.]{0,40}?AMT[^.]{0,30}?\\b(?:at|@)\\s+(.+?)(?:\\s+on\\s|\\s+dated\\s|\\.\\s|,|$)'), 'expense', { last4: 1, amount: 2, merchant: 3 }, 0.85],
  [rx('AMT[^.]{0,60}?(?:purchase|transaction|charged|spent|used)[^.]{0,40}?\\b(?:at|@)\\s+(.+?)\\s+(?:using|with|on|thru)\\b[^.]{0,60}?(?:ending(?:\\s+in)?|\\*+|x{2,})\\s*(\\d{4})'), 'expense', { amount: 1, merchant: 2, last4: 3 }, 0.85],
  [rx('(?:purchase|transaction)[^.]{0,30}?(?:of|amounting to|for)\\s+AMT[^.]{0,30}?\\b(?:at|@)\\s+(.+?)(?:\\s+on\\s|\\s+using\\s|\\s+with\\s|\\.\\s|,|$)'), 'expense', { amount: 1, merchant: 2 }, 0.8],
  [rx('AMT\\s+(?:has been|was)\\s+(?:debited|deducted|withdrawn)'), 'transfer-out', { amount: 1 }, 0.6],
  [rx('(?:debited|deducted|withdrawn)[^.]{0,40}?AMT'), 'transfer-out', { amount: 1 }, 0.6],
  [rx('AMT\\s+(?:has been|was)\\s+(?:credited|deposited|received)'), 'transfer-in', { amount: 1 }, 0.6],
  [rx('(?:credited|deposited)[^.]{0,40}?AMT(?:[^.]{0,30}?\\bfrom\\s+(.+?)(?:\\s+on\\s|\\.\\s|$))?'), 'transfer-in', { amount: 1, merchant: 2 }, 0.6],
];

const inst = (id, name, senders, domains, rules = COMMON_RULES, wallet = id) => ({ id, name, senders, domains, rules, wallet, unverified: true });
export const PARSERS = [
  inst('gcash', 'GCash', ['gcash'], ['gcash.com'], [...GCASH_RULES, ...COMMON_RULES]),
  inst('gotyme', 'GoTyme', ['gotyme', 'gotymebank'], ['gotyme.com.ph', 'gotymebank.com']),
  inst('maya', 'Maya', ['maya', 'paymaya'], ['maya.ph', 'paymaya.com']),
  inst('bpi', 'BPI', ['bpi'], ['bpi.com.ph']),
  inst('bdo', 'BDO', ['bdo'], ['bdo.com.ph']),
  inst('unionbank', 'UnionBank', ['unionbank', 'unionbankph', 'ubp'], ['unionbankph.com']),
  inst('metrobank', 'Metrobank', ['metrobank', 'mbtc'], ['metrobank.com.ph']),
  inst('securitybank', 'Security Bank', ['securitybank', 'secbank'], ['securitybank.com']),
  inst('rcbc', 'RCBC', ['rcbc'], ['rcbc.com']),
  inst('seabank', 'SeaBank', ['seabank', 'maribank'], ['seabank.ph', 'maribank.ph']),
  inst('cimb', 'CIMB', ['cimb'], ['cimb.com', 'cimbbank.com.ph']),
];
export const parserById = (id) => PARSERS.find((p) => p.id === id);

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Who sent it: an SMS sender name, or an email address, lower case.
export function normSender(item) {
  if (item.type === 'email') return String(item.raw?.from || item.from || '').toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim().slice(0, 80);
  if (item.type === 'wallet') return 'apple wallet';
  return String(item.raw?.sender || item.sender || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}
export function senderParser(sender) {
  const c = compact(sender);
  if (!c) return null;
  return PARSERS.find((p) => p.senders.some((s) => c.includes(s)) || p.domains.some((d) => String(sender).toLowerCase().endsWith(d)));
}

// Plain text of an alert (emails may be HTML).
export function alertText(item) {
  const r = item.raw || item;
  if (item.type === 'email') {
    const body = String(r.body || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8369;|&#x20b1;/gi, '₱').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
    return `${r.subject || ''}\n${body}`.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 8000);
  }
  return String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function runRules(rules, text) {
  for (const [re, kind, at, confidence, fixed] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    const amount = parseMoney(m[at.amount]);
    if (!amount) continue;
    const merchant = tidy(at.merchant ? m[at.merchant] : '') || fixed || '';
    return { kind, amount, merchant, last4: at.last4 ? m[at.last4] : null, confidence };
  }
  return null;
}

// Reads one alert. Returns { ev, parser, inst, confidence, unverified, templateId? } or { ev: null, ... }.
//   ev: { kind, amount, merchant, last4, balanceAfter, reference, walletHint, inst, accountId?, cardId? }
export function parseAlert(item, { templates = [] } = {}) {
  const sender = normSender(item);
  if (item.type === 'wallet') {
    const r = item.raw || item;
    const amount = parseMoney(r.amount);
    if (!amount) return { ev: null, parser: 'wallet', confidence: 0, unverified: false };
    return { ev: { kind: 'expense', amount, merchant: tidy(r.merchant), cardName: String(r.card || r.name || '').trim().slice(0, 60), inst: 'Apple Wallet', last4: last4Of(r.card || '') }, parser: 'wallet', confidence: 0.9, unverified: false };
  }
  const text = alertText(item);
  const extras = { balanceAfter: balanceOf(text), reference: refOf(text), last4: last4Of(text) };
  // 1. Formats you taught Pitaka (this sender first, then templates for any sender).
  const mine = templates.filter((t) => t.sender === sender).concat(templates.filter((t) => t.sender === '*'));
  for (const t of mine) {
    const m = matchTemplate(t.format, text);
    if (!m) continue;
    const p = senderParser(sender);
    return {
      ev: { kind: t.kind, amount: m.amount, merchant: m.merchant || '', last4: extras.last4, balanceAfter: m.balance ?? extras.balanceAfter, reference: m.ref || extras.reference, inst: p?.name || t.label || sender, walletHint: p?.wallet, accountId: t.accountId, cardId: t.cardId },
      parser: 'template', templateId: t.id, confidence: 0.95, unverified: false,
    };
  }
  // 2. The built-in format of whoever sent it.
  const p = senderParser(sender);
  if (p) {
    const hit = runRules(p.rules, text);
    if (hit) return { ev: { ...hit, last4: hit.last4 || extras.last4, balanceAfter: extras.balanceAfter, reference: extras.reference, inst: p.name, walletHint: p.wallet }, parser: p.id, confidence: hit.confidence, unverified: true };
  }
  // 3. Fallback: a peso amount, maybe a card ending and a merchant after "at".
  const any = rx('AMT').exec(text);
  const amount = any ? parseMoney(any[1]) : null;
  if (!amount) return { ev: null, parser: p?.id || null, inst: p?.name, confidence: 0, unverified: true };
  const at = /\b(?:at|@)\s+([A-Z0-9][^.,\n]{1,60}?)(?:\s+on\s|\s+using\s|\.|,|$)/i.exec(text);
  return {
    ev: { kind: 'expense', amount, merchant: tidy(at?.[1]), last4: extras.last4, balanceAfter: extras.balanceAfter, reference: extras.reference, inst: p?.name || '', walletHint: p?.wallet },
    parser: 'generic', confidence: extras.last4 ? 0.5 : 0.3, unverified: true,
  };
}

// ---------------------------------------------------------------- taught formats (templates)
// A format is the message with the variable parts replaced by placeholders:
//   {amount} {balance}  a peso amount, with or without PHP / P / ₱
//   {merchant}          a name (shop, person, biller)
//   {ref}               a reference number
//   {#}                 any number (dates, times, phone numbers)   {w} any word   {*} anything
// Everything else must match literally (spacing is flexible, case is ignored).
const PH = {
  amount: `(?:PHP|Php|php|P|₱)?\\s?${NUM}`,
  balance: `(?:PHP|Php|php|P|₱)?\\s?${NUM}`,
  merchant: '(.+?)',
  ref: '([A-Za-z0-9][A-Za-z0-9-]{3,39})',
  '#': '[0-9]+',
  w: '[A-Za-z]+',
  '*': '[\\s\\S]*?',
};
const FIELDS = ['amount', 'balance', 'merchant', 'ref'];
const escapeLiteral = (s) => s.split(/(\s+)/).map((x) => (/^\s+$/.test(x) ? '\\s+' : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');

export function compileTemplate(format) {
  if (typeof format !== 'string' || !format.trim()) throw new Error('The format is empty');
  if (format.length > 1000) throw new Error('The format is too long');
  const parts = format.trim().split(/(\{[^{}]*\})/);
  let src = '^\\s*';
  const groups = [];
  parts.forEach((part, i) => {
    const m = /^\{([^{}]*)\}$/.exec(part);
    if (!m) { if (part) src += escapeLiteral(part); return; }
    const k = m[1].trim().toLowerCase();
    if (!(k in PH)) throw new Error(`Unknown placeholder {${m[1]}}. Use {amount}, {merchant}, {balance}, {ref}, {#}, {w} or {*}.`);
    if (FIELDS.includes(k)) {
      if (groups.includes(k)) throw new Error(`{${k}} appears twice`);
      groups.push(k);
    }
    const last = parts.slice(i + 1).every((x) => !x.trim());
    src += k === 'merchant' && last ? '([^\\n.]+?)(?=[.\\n]|$)' : PH[k];
  });
  if (!groups.includes('amount')) throw new Error('The format needs {amount}');
  return { re: new RegExp(src, 'i'), groups };
}

// { amount, merchant?, balance?, ref? } or null.
export function matchTemplate(format, text) {
  let c;
  try { c = compileTemplate(format); } catch { return null; }
  const m = c.re.exec(String(text || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const out = {};
  c.groups.forEach((g, i) => { out[g] = m[i + 1]; });
  out.amount = parseMoney(out.amount);
  if (!out.amount) return null;
  if (out.balance !== undefined) out.balance = parseMoney(out.balance);
  if (out.merchant !== undefined) out.merchant = tidy(out.merchant);
  return out;
}

const WORDS = /^(?:AM|PM|Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December|Mon|Monday|Tue|Tuesday|Wed|Wednesday|Thu|Thursday|Fri|Friday|Sat|Saturday|Sun|Sunday)$/i;
// Literal text with the parts that change from message to message (numbers, dates, AM/PM) made general.
function generalize(s) {
  return s.replace(/[{}]/g, ' ').split(/(\s+)/).map((tok) => {
    if (/^\s+$/.test(tok)) return ' ';
    return tok.replace(/[A-Za-z]+/g, (w) => (WORDS.test(w) ? '{w}' : w)).replace(/\d+/g, '{#}');
  }).join('');
}

// "Teach this format": `marks` are the character ranges you tapped, e.g. { amount: [17, 24], merchant: [28, 36] }.
// Returns a format that matches this message and gives back what you marked.
export function buildTemplate(text, marks) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  const spans = [];
  for (const k of FIELDS) {
    const r = marks?.[k];
    if (!r) continue;
    let [a, b] = r.map(Number);
    if (!(a >= 0 && b > a && b <= src.length)) throw new Error(`Tap the ${k === 'ref' ? 'reference number' : k} again`);
    if (k === 'amount' || k === 'balance') {
      const before = src.slice(0, a);
      const cur = /(?:PHP|Php|php|P|₱)\s?$/.exec(before);
      if (cur) a -= cur[0].length;
    }
    spans.push({ k, a, b });
  }
  if (!spans.some((s) => s.k === 'amount')) throw new Error('Tap the amount first');
  spans.sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) if (spans[i].a < spans[i - 1].b) throw new Error('Two of the parts you tapped overlap');
  let out = '';
  let pos = 0;
  for (const s of spans) { out += generalize(src.slice(pos, s.a)); out += `{${s.k}}`; pos = s.b; }
  // Keep the text after the last part up to the end of its sentence; what follows (promos) varies.
  const rest = src.slice(pos);
  const stop = rest.search(/\.(\s|$)/);
  out += generalize(stop >= 0 && stop < 80 ? rest.slice(0, stop + 1) : rest.slice(0, 0));
  const format = out.replace(/\s+/g, ' ').trim();
  const check = matchTemplate(format, src);
  const want = (k) => src.slice(spans.find((s) => s.k === k).a, spans.find((s) => s.k === k).b);
  if (!check || check.amount !== parseMoney(want('amount'))) throw new Error("That format didn't read this message back. Try tapping the parts again.");
  return format;
}
