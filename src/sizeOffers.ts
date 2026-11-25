// Offer photos by size («كشخة», Nov 2026): a template's quick-reply button («ابعتولي الصور») answered without the AI.
// The customer gets only the offer's models that are in stock in their size right now, each photo with its model and
// the final price the team wrote for it. A customer whose size we don't know is asked first; their answer is saved
// on their record and the same request carries on.
// Each offer belongs to a template (the same button text may sit in several ads), set up on the Campaigns page with
// its own photos. Nothing here sends anything until the team switches an offer on.
import crypto from "node:crypto";
import { config } from "./config.js";
import { db, hasSizes, isAiPaused, listStock, pauseAi, saveMessage, stockName, type StockRow } from "./store.js";
import { customerWords, statedWeight, westernDigits } from "./campaignSignals.js";
import { dataPath, saveFile } from "./media.js";
import { addBackgroundNote, onBeforeReply, replyLater, sendImage, sendText } from "./channels/whatsapp.js";
import { notifyHandoff } from "./orders.js";
import { log } from "./scheduler.js";
import fs from "node:fs";

db.exec(`
  CREATE TABLE IF NOT EXISTS size_offers (
    template    TEXT    PRIMARY KEY,       -- the template's name at Meta
    label       TEXT    NOT NULL,          -- the discount as the customer reads it, e.g. «30٪»
    button      INTEGER NOT NULL DEFAULT 0, -- which quick-reply button (0 = the first) asks for the photos
    active      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS size_offer_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template    TEXT    NOT NULL,
    file        TEXT    NOT NULL,          -- "catalog/offer-<random>.jpg", served publicly for WhatsApp
    mime        TEXT    NOT NULL,
    sizes       TEXT    NOT NULL,          -- JSON ["58", "60"]: the sizes the post was made for; [] = any
    models      TEXT    NOT NULL,          -- JSON [{ product, color, price }]: every model on the photo, final price in دينار
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS size_offer_requests (
    customer    TEXT    NOT NULL,
    template    TEXT    NOT NULL,
    status      TEXT    NOT NULL,          -- 'asking' (waiting for the size) | 'sending' | 'sent' | 'none' | 'failed'
    size        TEXT    NOT NULL DEFAULT '',
    sent        TEXT    NOT NULL DEFAULT '[]', -- JSON ids of the photos already sent for this size
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (customer, template)
  );
`);
// The customer's size, kept on their record once they told us (or the only size of their last order).
if (!(db.prepare("PRAGMA table_info(customers)").all() as { name: string }[]).some((c) => c.name === "size")) {
  db.exec("ALTER TABLE customers ADD COLUMN size TEXT NOT NULL DEFAULT ''");
}

export type OfferModel = { product: string; color: string; price: number };
export type OfferPhoto = { id: number; template: string; file: string; mime: string; sizes: string[]; models: OfferModel[] };
export type SizeOffer = { template: string; label: string; button: number; active: boolean };

const DAY = 24 * 60 * 60 * 1000;
// A customer asked for their size answers within this time; later, the chat has moved on.
const ASK_TTL = 2 * DAY;
// A second tap on the button soon after: the photos are already in the chat.
const RESEND_AFTER = 6 * 60 * 60 * 1000;
// How long a failed photo waits before its second try (shorter in tests).
export const timing = { retryWait: 20_000 };
// A request still 'sending' after this long was cut by a restart: a tap resumes it.
const STUCK_AFTER = 5 * 60 * 1000;

// --- Texts (the spec's words) -----------------------------------------------------------------

export const ASK_SIZE = "يا أستاذ، تذكّرنا بقياسك باش نبعثولك الموديلات اللي على قياسك؟";
export const CLARIFY_SIZE = "يا أستاذ، قياسك بالضبط كم؟ اكتبلنا رقم واحد (مثلاً 58) باش نبعثولك الموديلات اللي على قياسك.";
export const introText = (label: string) => `يا أستاذ، هادي الموديلات اللي متوفّرة على قياسك. عاملين عليها خصم ${label}، وسعر كل موديل تلقاه مع صورته 👇`;
export const noneText = (label: string) => `يا أستاذ، توا مافيش موديلات على قياسك ضمن عرض الـ${label}.`;
export const modelLine = (m: OfferModel) => `${m.product} - ${m.color}: ${m.price} دينار`;

// --- Offers (the Campaigns page) ----------------------------------------------------------------

type OfferRow = { template: string; label: string; button: number; active: number };
const toOffer = (r: OfferRow): SizeOffer => ({ template: r.template, label: r.label, button: r.button, active: r.active === 1 });

export function getOffer(template: string): SizeOffer | undefined {
  const r = db.prepare("SELECT template, label, button, active FROM size_offers WHERE template = ?").get(template) as OfferRow | undefined;
  return r && toOffer(r);
}

export function offerPhotos(template: string): OfferPhoto[] {
  const rows = db.prepare("SELECT * FROM size_offer_photos WHERE template = ? ORDER BY id").all(template) as {
    id: number;
    template: string;
    file: string;
    mime: string;
    sizes: string;
    models: string;
  }[];
  return rows.map((r) => ({ ...r, sizes: JSON.parse(r.sizes) as string[], models: JSON.parse(r.models) as OfferModel[] }));
}

export function listOffers() {
  const offers = (db.prepare("SELECT template, label, button, active FROM size_offers ORDER BY updated_at DESC").all() as OfferRow[]).map(toOffer);
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM size_offer_requests WHERE template = ? GROUP BY status");
  return offers.map((o) => ({
    ...o,
    photos: offerPhotos(o.template),
    requests: Object.fromEntries((counts.all(o.template) as { status: string; n: number }[]).map((r) => [r.status, r.n])),
  }));
}

export function saveOffer(input: { template: string; label: string; button: number; active: boolean }) {
  const template = input.template.trim();
  const label = input.label.trim().slice(0, 20);
  if (!/^[a-z0-9_]{1,512}$/.test(template)) throw new Error("اسم القالب غلط");
  if (!label) throw new Error("اكتب الخصم مثل ما بيقراه الزبون (مثلاً 30٪)");
  const button = Math.min(2, Math.max(0, Math.round(input.button) || 0));
  if (input.active && !offerPhotos(template).length) throw new Error("زيد صور العرض قبل ما تشغّله");
  db.prepare(
    `INSERT INTO size_offers (template, label, button, active, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (template) DO UPDATE SET label = excluded.label, button = excluded.button, active = excluded.active, updated_at = excluded.updated_at`,
  ).run(template, label, button, input.active ? 1 : 0, Date.now());
}

export function deleteOffer(template: string) {
  for (const p of offerPhotos(template)) deleteOfferPhoto(p.id);
  db.prepare("DELETE FROM size_offers WHERE template = ?").run(template);
}

const sizeList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((s) => westernDigits(String(s)).trim()).filter((s) => /^\d{2}$/.test(s)))] : [];

export function addOfferPhoto(input: { template: string; data: Buffer; mime: string; sizes: unknown; models: unknown }): OfferPhoto {
  if (!getOffer(input.template)) throw new Error("احفظ العرض بالأول");
  const rows = listStock();
  const models = (Array.isArray(input.models) ? input.models : []).map((m: Record<string, unknown>) => {
    const product = String(m?.product ?? "").trim();
    const color = String(m?.color ?? "").trim();
    const price = Math.round(Number(westernDigits(String(m?.price ?? ""))));
    // Picked from the stock list, so "available in their size" is always checked against the real stock.
    if (!rows.some((r) => r.product === product && r.color === color)) throw new Error(`«${product} - ${color}» مش بالمخزون`);
    if (!(price > 0 && price < 100_000)) throw new Error(`اكتب سعر «${product} - ${color}» النهائي بالدينار`);
    return { product, color, price };
  });
  if (!models.length) throw new Error("اختار الموديل (أو الموديلات) اللي بالصورة");
  const file = saveFile("catalog", `offer-${crypto.randomBytes(8).toString("hex")}`, input.data, input.mime);
  const id = Number(
    db
      .prepare("INSERT INTO size_offer_photos (template, file, mime, sizes, models, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.template, file, input.mime, JSON.stringify(sizeList(input.sizes)), JSON.stringify(models), Date.now()).lastInsertRowid,
  );
  return offerPhotos(input.template).find((p) => p.id === id)!;
}

export function deleteOfferPhoto(id: number): boolean {
  const row = db.prepare("SELECT file FROM size_offer_photos WHERE id = ?").get(id) as { file: string } | undefined;
  if (!row) return false;
  const full = dataPath(row.file);
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
  db.prepare("DELETE FROM size_offer_photos WHERE id = ?").run(id);
  return true;
}

// The quick-reply button of a template with an offer carries "offer:<template>" back to us, so a tap is known by its
// template and never by its words. Added to every send of that template (the campaign and the test).
export function offerButtonComponent(template: string): Record<string, unknown> | undefined {
  const offer = getOffer(template);
  if (!offer) return undefined;
  return { type: "button", sub_type: "quick_reply", index: String(offer.button), parameters: [{ type: "payload", payload: `offer:${template}` }] };
}

// --- Which photos ---------------------------------------------------------------------------------

// The model is in stock in this size right now (not hidden). A one-size product (the fur) only needs the color.
export function modelAvailable(m: OfferModel, size: string, rows: StockRow[]): boolean {
  const cells = rows.filter((r) => stockName(r.product) === stockName(m.product) && stockName(r.color) === stockName(m.color));
  const sized = hasSizes(m.product, rows);
  return cells.some((c) => !c.hidden && c.quantity > 0 && (!sized || stockName(c.size) === stockName(size)));
}

// The photos for a size: a post made for that size (or for any) whose every model is in stock in it. A post that
// shows a model they can't have isn't sent; that model's own photo is. Posts with more models come first, and a
// model already shown isn't shown again.
export function pickPhotos(photos: OfferPhoto[], size: string, rows: StockRow[]): OfferPhoto[] {
  const key = (m: OfferModel) => `${stockName(m.product)}|${stockName(m.color)}`;
  const shown = new Set<string>();
  const picked: OfferPhoto[] = [];
  const ordered = [...photos].sort((a, b) => b.models.length - a.models.length || a.id - b.id);
  for (const p of ordered) {
    if (p.sizes.length && !p.sizes.some((s) => stockName(s) === stockName(size))) continue;
    if (!p.models.every((m) => modelAvailable(m, size, rows))) continue;
    if (p.models.some((m) => shown.has(key(m)))) continue;
    for (const m of p.models) shown.add(key(m));
    picked.push(p);
  }
  // Back in the order the team added them.
  return picked.sort((a, b) => a.id - b.id);
}

// --- The customer's size ----------------------------------------------------------------------------

// What the customer answered to «تذكّرنا بقياسك»: one size, or several / a weight (ask again), or nothing about a size.
export function sizeAnswer(text: string): { size: string } | "unclear" | undefined {
  const t = westernDigits(customerWords(text));
  if (!t) return undefined;
  if (statedWeight(t)) return "unclear";
  const sizes = [...new Set([...t.matchAll(/(?<![\d.,])(\d{2})(?![\d.,]*\d)/g)].map((m) => m[1]!).filter((n) => Number(n) >= 40 && Number(n) <= 70))];
  if (sizes.length === 1) return { size: sizes[0]! };
  if (sizes.length > 1) return "unclear";
  return undefined;
}

// Saved on their record, or else the one size of their last order (a set; the fur's «ستاندرد» is no size).
export function knownSize(customer: string): string | undefined {
  const saved = (db.prepare("SELECT size FROM customers WHERE customer = ?").get(customer) as { size: string } | undefined)?.size;
  if (saved) return saved;
  const last = db.prepare("SELECT items FROM orders WHERE customer = ? ORDER BY id DESC LIMIT 1").get(customer) as { items: string } | undefined;
  if (!last) return undefined;
  const sizes = new Set(
    (JSON.parse(last.items) as { size?: string }[]).map((i) => westernDigits(String(i.size ?? "")).trim()).filter((s) => /^\d{2}$/.test(s)),
  );
  return sizes.size === 1 ? [...sizes][0] : undefined;
}

export function saveSize(customer: string, size: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO customers (customer, first_seen, updated_at, size) VALUES (?, ?, ?, ?)
     ON CONFLICT (customer) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at`,
  ).run(customer, now, now, size);
}

// --- A tap on the button, an answer with the size ------------------------------------------------------

type RequestRow = { customer: string; template: string; status: string; size: string; sent: string; created_at: number; updated_at: number };
const getRequest = (customer: string, template: string) =>
  db.prepare("SELECT * FROM size_offer_requests WHERE customer = ? AND template = ?").get(customer, template) as RequestRow | undefined;
function setRequest(customer: string, template: string, fields: { status: string; size?: string; sent?: number[] }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO size_offer_requests (customer, template, status, size, sent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (customer, template) DO UPDATE SET status = excluded.status,
       size = CASE WHEN ? THEN excluded.size ELSE size END, sent = CASE WHEN ? THEN excluded.sent ELSE sent END, updated_at = excluded.updated_at`,
  ).run(customer, template, fields.status, fields.size ?? "", JSON.stringify(fields.sent ?? []), now, now, fields.size !== undefined ? 1 : 0, fields.sent ? 1 : 0);
}

// Which offer a tap asks for: the payload we put on the button, or else the template message it answers.
export function tappedOffer(m: { buttonPayload?: string; isButton?: boolean; replyTo?: string; customer: string }): SizeOffer | undefined {
  let template: string | undefined;
  if (m.buttonPayload?.startsWith("offer:")) template = m.buttonPayload.slice("offer:".length);
  else if (m.isButton && m.replyTo) {
    template = (
      db
        .prepare("SELECT c.template FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign WHERE r.wamid = ? AND r.customer = ?")
        .get(m.replyTo, m.customer) as { template: string } | undefined
    )?.template;
    // The template's other button («إيقاف»): recorded as an opt-out just before this.
    if (template && db.prepare("SELECT 1 FROM campaign_optouts WHERE customer = ?").get(m.customer)) return undefined;
  }
  const offer = template ? getOffer(template) : undefined;
  return offer?.active ? offer : undefined;
}

// Customers whose photos are going out right now, with their last message then: what they write meanwhile is
// answered by the AI at the end.
const busy = new Map<string, number>();
const lastCustomerId = (customer: string) =>
  (db.prepare("SELECT MAX(id) AS id FROM messages WHERE customer = ? AND role = 'customer'").get(customer) as { id: number | null }).id ?? 0;

// Called for every customer message the AI would answer. true: handled here, the AI stays out of it.
export function claimMessage(m: { customer: string; text: string; buttonPayload?: string; isButton?: boolean; replyTo?: string; lastId?: number }): boolean {
  if (busy.has(m.customer)) return true;
  const offer = tappedOffer(m);
  if (offer) {
    const req = getRequest(m.customer, offer.template);
    const age = req ? Date.now() - req.updated_at : Infinity;
    if ((req?.status === "sent" && age < RESEND_AFTER) || (req?.status === "sending" && age < STUCK_AFTER)) {
      log(`wa:${m.customer}`, `offer ${offer.template}: tapped again, photos already sent`);
      return true;
    }
    const size = knownSize(m.customer);
    // A tap long after the photos went: all of them again (stock may have changed). A request cut short: the rest.
    if (size) void run(m.customer, offer, size, req?.status === "sent" || req?.status === "none");
    else void ask(m.customer, offer.template, ASK_SIZE);
    return true;
  }
  // An answer to «تذكّرنا بقياسك».
  const asking = db
    .prepare("SELECT * FROM size_offer_requests WHERE customer = ? AND status = 'asking' AND updated_at > ? ORDER BY updated_at DESC LIMIT 1")
    .get(m.customer, Date.now() - ASK_TTL) as RequestRow | undefined;
  const pending = asking && getOffer(asking.template);
  if (!pending?.active) return false;
  const answer = sizeAnswer(m.text);
  if (!answer) return false; // something else: the AI answers, the request waits for the size
  if (answer === "unclear") {
    // Asked once already: the AI takes it from here (a weight → the size it fits), and their number still counts.
    const ours = db.prepare("SELECT text FROM messages WHERE customer = ? AND role = 'business' ORDER BY id DESC LIMIT 1").get(m.customer) as
      | { text: string }
      | undefined;
    if (ours?.text === CLARIFY_SIZE) return false;
    void ask(m.customer, pending.template, CLARIFY_SIZE);
    return true;
  }
  saveSize(m.customer, answer.size);
  log(`wa:${m.customer}`, `offer ${pending.template}: size ${answer.size} saved`);
  void run(m.customer, pending, answer.size);
  return true;
}

async function ask(customer: string, template: string, text: string) {
  busy.set(customer, lastCustomerId(customer));
  try {
    setRequest(customer, template, { status: "asking" });
    const wamid = await sendText(customer, text);
    saveMessage({ customer, role: "business", source: "ai", text, wamid });
    log(`wa:${customer}`, `offer ${template}: asked for the size`);
  } catch (error) {
    failed(customer, template, `ما قدرنا نسأل الزبون عن قياسه لعرض الصور: ${String(error).slice(0, 150)}`);
  } finally {
    done(customer);
  }
}

// Sends what fits their size. Photos that fail are tried again once; still failing, the team gets the request with
// the photos left, and it stays open ('failed') until they send them.
async function run(customer: string, offer: SizeOffer, size: string, fresh = false) {
  busy.set(customer, lastCustomerId(customer));
  try {
    const before = getRequest(customer, offer.template);
    const already = new Set<number>(before && !fresh && before.size === size ? (JSON.parse(before.sent) as number[]) : []);
    const photos = pickPhotos(offerPhotos(offer.template), size, listStock());
    setRequest(customer, offer.template, { status: "sending", size, sent: [...already] });
    if (!photos.length) {
      const text = noneText(offer.label);
      saveMessage({ customer, role: "business", source: "ai", text, wamid: await sendText(customer, text) });
      setRequest(customer, offer.template, { status: "none" });
      log(`wa:${customer}`, `offer ${offer.template}: nothing in size ${size}`);
      return;
    }
    let left = photos.filter((p) => !already.has(p.id));
    for (let round = 0; round < 2 && left.length; round++) {
      if (round) await new Promise((r) => setTimeout(r, timing.retryWait));
      for (const p of left) {
        if (isAiPaused(customer)) break; // the team took the chat over
        const lines = p.models.map(modelLine).join("\n");
        const caption = already.size === 0 ? `${introText(offer.label)}\n\n${lines}` : lines;
        try {
          const wamid = await sendImage(customer, `${config.publicUrl}/${p.file}`, caption);
          saveMessage({
            customer,
            role: "business",
            source: "ai",
            text: `[sent offer photo: ${p.models.map((m) => `${m.product} - ${m.color}`).join(" + ")}] ${caption}`,
            wamid,
            media: { type: "image", file: p.file, mime: p.mime },
          });
          already.add(p.id);
          setRequest(customer, offer.template, { status: "sending", sent: [...already] });
        } catch (error) {
          log(`wa:${customer}`, `offer ${offer.template}: photo ${p.id} failed: ${String(error).slice(0, 200)}`);
        }
      }
      left = left.filter((p) => !already.has(p.id));
    }
    if (left.length && !isAiPaused(customer)) {
      const names = left.flatMap((p) => p.models.map((m) => `${modelLine(m)}`)).join("، ");
      failed(customer, offer.template, `طلب صور عرض الـ${offer.label} (مقاس ${size}) وما قدرنا نبعتله: ${names}. ابعتولو ياهن من التطبيق.`);
      return;
    }
    setRequest(customer, offer.template, { status: left.length ? "failed" : "sent" });
    log(`wa:${customer}`, `offer ${offer.template}: ${already.size} photo(s) sent for size ${size}`);
  } catch (error) {
    failed(customer, offer.template, `طلب صور عرض (مقاس ${size}) وصار خطأ: ${String(error).slice(0, 150)}`);
  } finally {
    done(customer);
  }
}

function failed(customer: string, template: string, reason: string) {
  setRequest(customer, template, { status: "failed" });
  pauseAi(customer, `AI handoff: ${reason}`);
  log(`wa:${customer}`, `offer ${template}: handed to the team: ${reason}`);
  notifyHandoff(customer, reason);
}

// Whatever they wrote while the photos went out gets its answer now.
function done(customer: string) {
  const before = busy.get(customer) ?? 0;
  busy.delete(customer);
  if (lastCustomerId(customer) > before && !isAiPaused(customer)) replyLater(customer);
}

// For the AI afterwards: the prices on the photos are this customer's prices, not the knowledge's.
export function offerNote(customer: string): string | undefined {
  const rows = db
    .prepare("SELECT * FROM size_offer_requests WHERE customer = ? AND status IN ('asking', 'sent', 'failed', 'sending') AND updated_at > ?")
    .all(customer, Date.now() - 7 * DAY) as RequestRow[];
  const lines: string[] = [];
  const asking: string[] = [];
  for (const r of rows) {
    const offer = getOffer(r.template);
    if (r.status === "asking") {
      if (offer && Date.now() - r.updated_at < ASK_TTL) asking.push(offer.label);
      continue;
    }
    const sent = new Set(JSON.parse(r.sent) as number[]);
    const models = offerPhotos(r.template).filter((p) => sent.has(p.id)).flatMap((p) => p.models);
    if (offer && models.length) lines.push(`size ${r.size}, «خصم ${offer.label}»: ${models.map(modelLine).join(" · ")}`);
  }
  const ask = asking.length
    ? `We asked this customer their size to send our «خصم ${asking[0]}» offer photos: they go out by themselves as soon as the customer writes their size as one number. If they give a weight or aren't sure, tell them the size it fits from the size table and ask them to write that number; don't send other photos for it meanwhile.`
    : "";
  if (!lines.length) return ask || undefined;
  return `${ask ? `${ask}
` : ""}We sent this customer our offer photos for their size, each with its final price:\n${lines.join("\n")}\nThose prices are right for those models in that size, above the knowledge's prices and «السعر ثابت»: quote them, and use them in the summary and in submit_order (total = the sum of each piece's price). Never reduce them again, and for those models say this offer's words, not the stock list's ON SALE words. Any other model or size keeps its usual price. Their size is the one above unless they say otherwise.`;
}

onBeforeReply(claimMessage);
addBackgroundNote(offerNote);
