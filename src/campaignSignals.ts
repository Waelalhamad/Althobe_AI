// What a past customer's words say about them, for the campaign groups that depend on it (src/campaigns.ts):
// someone who asked for a discount, someone whose size we don't have. Pure functions on text, so they can be tuned
// against real chats and tested. A wrong match here sends an offer to someone it doesn't fit from the number every
// sale runs on, so when in doubt: no match.

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const westernDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

// The customer's own words in a saved message: not the ad the chat started from, not a reaction or a photo, not our
// message they answered. "[voice note] text" is their speech, so it stays.
export function customerWords(text: string): string {
  let t = text.trim();
  if (/^\[sent /.test(t) ||/^\[(edited|from a|system)/.test(t)) return "";
  t = t.replace(/^\[from the ad[^\]]*\]\s*/, "");
  t = t.replace(/^\[answering (?:our|their own) message\s*«[\s\S]*?»\]\s*/, "");
  t = t.replace(/^\[voice note\]\s*/, "");
  return t.trim();
}

// --- A discount ------------------------------------------------------------------------------

const DISCOUNT_WORDS = /خصم|خصومات|حسم|تخفيض|تخفيظ|ديسكاونت|discount/i;
const DISCOUNT_PHRASES = [
  /(?:^|\s)[اآأإ]خر\s*سعر/,
  /من\s*(?:ال)?[اأإ]خر\s*(?:سعر|كم)|كم\s*من\s*(?:ال)?[اأإ]خر/,
  /(?:تنزل|ننزل|تنزلو|تنزلوا|ينزل|انزل|نزّل|نزل|نزلي|نزلولي|تنقص|تنقصو|انقص|نقصلي|نقصني)\S*\s*(?:لي\s*|لنا\s*)?(?:من\s*|في\s*)?(?:ال)?سعر/,
  /سعر\s*[اأإ]قل|[اأإ]قل\s*سعر|سعر\s*[اأإ]خف|سعر\s*مخفّ?ض/,
  /ارخص\s*شوي|أرخص\s*شوي|ارخص\s*شوية|أرخص\s*شوية/,
];

// The customer asked us to lower the price.
export function asksForDiscount(text: string): boolean {
  const t = customerWords(text);
  return !!t && (DISCOUNT_WORDS.test(t) || DISCOUNT_PHRASES.some((r) => r.test(t)));
}

// Why the AI (or the team) handed a chat over, as it was written (Arabic or English): a discount was the reason.
const HANDOFF_DISCOUNT = /خصم|تخفيض|حسم|ديسكاونت|discount|سعر\s*(?:أقل|اقل|مخفض)|تنزيل\s*(?:ال)?سعر/i;
// A trader or a wholesale price is not a discount on one set: that goes to the team, not to a clearance offer.
const WHOLESALE = /جملة|جمله|wholesale|تاجر|تجار|مندوب|موزع|مشروع|محل(?:ات)?\s*(?:ه|ي|نا)/i;
export const handoffIsDiscount = (reason: string) => HANDOFF_DISCOUNT.test(reason) && !WHOLESALE.test(reason);

// A handoff or note about a complaint, a return or a bad delivery: not for an offer.
const UNHAPPY = /شكوى|شكاوي|اشتك|استرجاع|ارجاع|إرجاع|مرتجع|ترجيع|تالف|معيب|غاضب|بلاغ|complain|refund|angry/i;
export const handoffIsComplaint = (reason: string) => UNHAPPY.test(reason);

// --- A size we don't have --------------------------------------------------------------------

// Our biggest set size is 62 (up to about 105 kg); one product goes to 64.
export const MAX_KG = 105;
const KG_MAX_PLAUSIBLE = 220;

const WEIGHT_WORD = /(?:وزن[^\s\d]{0,6}|weight)[^\d\n]{0,15}(?<![\d.,])(\d{2,3})(?![\d.,]*\d)(?!\s*(?:جرام|غرام|جم(?![؀-ۿ])|g\b|متر|سم))/gi;
const WEIGHT_UNIT = /(?<![\d.,])(\d{2,3})\s*(?:كيلو|كغ|كج|كلغ|kg|kilo)/gi;

// The customer's weight in kg when they gave one: the heaviest number they said as a weight.
export function statedWeight(text: string): number | undefined {
  const t = westernDigits(customerWords(text));
  const weights = [...t.matchAll(WEIGHT_WORD), ...t.matchAll(WEIGHT_UNIT)]
    .map((m) => Number(m[1]))
    .filter((w) => w >= 40 && w <= KG_MAX_PLAUSIBLE);
  return weights.length ? Math.max(...weights) : undefined;
}

const BIG_SIZE = [
  // «مقاس 64», «رقم 66», «نلبس 64», «في 64», «يوجد مقاس 64»
  /(?:مقاس\S*|قياس\S*|رقم\S*|نمرة|size|سايز|نلبس\S*|ألبس|البس|متوفر|يوجد|عندكم|عندك|فيه|في|موجود)\s*(?:مقاس\s*|رقم\s*)?(?<![\d.])6[3-8](?![\d.,]*\d)(?!\s*(?:كيلو|كغ|كج|كلغ|kg|سم|متر))/i,
  /^\s*6[3-8]\s*[.؟?!]?\s*$/,
  // «62 63», «62 او 64»: only sizes, one of them above 62
  /^(?=(?:.*?(?<![\d.])6[3-8](?![\d.,]*\d)))\s*(?:\d{2}\s*(?:[,،/-]|و|او|أو)?\s*)+$/,
  // «أكبر من 62», «مقاس أكبر», «في مقاس اكبر»
  /[اأإ]كبر\s*من\s*(?:مقاس\s*)?(?:ال)?62/,
  /مقاس(?:ات)?\s*(?:[اأإ]كبر|[اأإ]كثر|اوسع|أوسع)(?![؀-ۿ])/,
  // (not a bare «أكبر مقاس كم؟»: someone asking what our biggest size is isn't necessarily bigger than it)
  /(?:[اأإ]كبر|اوسع|أوسع)\s*من\s*(?:هيك|كدا|هذا)(?![؀-ۿ])/,
  // 4XL and up (3XL is the size we sell as 60 to 62)
  /(?<![\d.a-z])(?:[4-9]\s*x|xxxx+)\s*l?(?![a-z])/i,
];

// The customer asked for a size above 62, or said a weight above 105 kg.
export function tooBigFor62(text: string): string | undefined {
  const w = statedWeight(text);
  if (w && w > MAX_KG) return `وزنه ${w} كغ`;
  const t = westernDigits(customerWords(text));
  if (t && BIG_SIZE.some((r) => r.test(t))) return "سأل عن مقاس أكبر من 62";
  return undefined;
}

// Our reply told them there is nothing bigger than 62 («للأسف أكبر مقاس 62», «ما عندنا 64», «أكبر مقاس 62 يلبس من 100
// ل 105»). The list «56، 58، 60، 62» the AI gives to everyone, and a bare «أكبر مقاس 62», don't say it was too small.
export function toldNoBiggerSize(text: string): boolean {
  const t = westernDigits(text);
  if (/(?:للأسف|للاسف|ما\s*عندنا|ماعندنا|لا\s*يوجد|ما\s*في)[^.\n]{0,40}[اأإ]كبر[^.\n]{0,15}62/.test(t)) return true;
  if (/لو\s*تقصد\s*المقاس\s*6[3-9][^.\n]{0,30}[اأإ]كبر\s*مقاس\s*عندنا\s*62/.test(t)) return true;
  return /[اأإ]كبر\s*مقاس[^.\n]{0,20}62[^.\n]{0,12}(?:100|105)/.test(t);
}
