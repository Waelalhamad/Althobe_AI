// Offer photos by size (src/sizeOffers.ts): the spec's acceptance checks, with WhatsApp replaced by a fake sender.
// A mistake here sends a customer models that aren't in their size, or prices that aren't ours.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-offers-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");
process.env.PUBLIC_URL = "https://example.test";
process.env.DUALHOOK_API_KEY = "test";
process.env.WA_PHONE_NUMBER_ID = "111";
// The server's own variables are there when the tests run in its build: replies on, one number, Dualhook.
process.env.AI_REPLIES = "on";
process.env.WHATSAPP_PROVIDER = "dualhook";
process.env.WA_EXTRA_LINES = "";
process.env.REPLY_DEBOUNCE_MS = "600000"; // the AI never gets to answer in these tests

type Sent = { to: string; type: string; caption?: string; body?: string; link?: string; template?: unknown };
const sent: Sent[] = [];
let failImages = 0;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const b = JSON.parse(init?.body ?? "{}");
  if (b.type === "image" && failImages > 0) {
    failImages--;
    return new Response('{"error":{"code":131026}}', { status: 400 });
  }
  sent.push({ to: b.to, type: b.type, caption: b.image?.caption, body: b.text?.body, link: b.image?.link, template: b.template });
  return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
}) as typeof fetch;

const { db, setProductStock, saveContact } = await import("../src/store.ts");
const { handleWhatsAppWebhook } = await import("../src/channels/whatsapp.ts");
const { templatePayload } = await import("../src/campaigns.ts");
const offers = await import("../src/sizeOffers.ts");

const SET = "طقم سادة فرملة وجهين";
const FUR = "فروة أبو شهري مطرز شبك";
setProductStock(SET, [
  { color: "رصاصي", size: "58", quantity: 3 },
  { color: "رصاصي", size: "60", quantity: 0 },
  { color: "أسود", size: "60", quantity: 2 },
  { color: "كحلي", size: "58", quantity: 4, hidden: true },
]);
setProductStock(FUR, [{ color: "بني", size: "ستاندرد", quantity: 5 }]);

const T = "kashkha_30";
offers.saveOffer({ template: T, label: "30٪", button: 0, active: false });
const img = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const grey = offers.addOfferPhoto({ template: T, data: img, mime: "image/jpeg", sizes: [], models: [{ product: SET, color: "رصاصي", price: 270 }] });
const black = offers.addOfferPhoto({ template: T, data: img, mime: "image/jpeg", sizes: [], models: [{ product: SET, color: "أسود", price: 270 }] });
// A post with both colors: only for a size that has both (none here), so the single photos go.
offers.addOfferPhoto({ template: T, data: img, mime: "image/jpeg", sizes: [], models: [{ product: SET, color: "رصاصي", price: 270 }, { product: SET, color: "أسود", price: 270 }] });
const navy = offers.addOfferPhoto({ template: T, data: img, mime: "image/jpeg", sizes: [], models: [{ product: SET, color: "كحلي", price: 270 }] });
// Already on sale in the system at 308: the price on the photo is the team's, never reduced again.
const fur = offers.addOfferPhoto({ template: T, data: img, mime: "image/jpeg", sizes: ["58"], models: [{ product: FUR, color: "بني", price: 308 }] });
offers.saveOffer({ template: T, label: "30٪", button: 0, active: true });

let n = 0;
const tap = (customer: string, payload = `offer:${T}`) =>
  handleWhatsAppWebhook({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, contacts: [{ wa_id: customer }], messages: [{ id: `in.${++n}`, from: customer, timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "ابعتولي الصور", payload } }] } }] }],
  });
const write = (customer: string, body: string) =>
  handleWhatsAppWebhook({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, contacts: [{ wa_id: customer }], messages: [{ id: `in.${++n}`, from: customer, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }],
  });
const settle = () => new Promise((r) => setTimeout(r, 50));
const to = (customer: string) => sent.filter((s) => s.to === customer);

test("pickPhotos: only models in stock (not hidden) in that size, a mixed post only when all of it fits", () => {
  const rows = db.prepare("SELECT product, color, size, quantity, updated_at AS updatedAt, hidden FROM stock").all().map((r: any) => ({ ...r, hidden: r.hidden === 1 }));
  assert.deepEqual(offers.pickPhotos(offers.offerPhotos(T), "58", rows).map((p) => p.id), [grey.id, fur.id]);
  assert.deepEqual(offers.pickPhotos(offers.offerPhotos(T), "60", rows).map((p) => p.id), [black.id]);
  assert.deepEqual(offers.pickPhotos(offers.offerPhotos(T), "62", rows), []);
  assert.ok(!offers.pickPhotos(offers.offerPhotos(T), "58", rows).some((p) => p.id === navy.id));
});

test("sizeAnswer: one size, or ask again for several or a weight", () => {
  assert.deepEqual(offers.sizeAnswer("58"), { size: "58" });
  assert.deepEqual(offers.sizeAnswer("مقاسي ٦٠"), { size: "60" });
  assert.equal(offers.sizeAnswer("58 او 60"), "unclear");
  assert.equal(offers.sizeAnswer("وزني 90 كيلو"), "unclear");
  assert.equal(offers.sizeAnswer("بكم التوصيل"), undefined);
});

test("the template send carries the offer payload on the button", () => {
  const p = templatePayload({ template: T, language: "ar", body: "عرض", image: null }, "218910000001") as any;
  assert.deepEqual(p.template.components.at(-1), { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `offer:${T}` }] });
});

test("a customer whose size is saved gets the matching photos right away, with their final prices", async () => {
  const c = "218910000011";
  saveContact(c, "علي");
  offers.saveSize(c, "58");
  tap(c);
  await settle();
  const out = to(c);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.type === "image"));
  assert.ok(out[0]!.caption!.startsWith(offers.introText("30٪")));
  assert.match(out[0]!.caption!, /رصاصي: 270 دينار/);
  assert.equal(out[1]!.caption, `${FUR} - بني: 308 دينار`);
  // A second tap doesn't send them again.
  tap(c);
  await settle();
  assert.equal(to(c).length, 2);
  // The AI knows the prices it was given.
  assert.match(offers.offerNote(c) ?? "", /270 دينار/);
});

test("a new customer is asked their size first, it's saved, and the same offer's photos follow", async () => {
  const c = "218910000012";
  tap(c);
  await settle();
  assert.deepEqual(to(c).map((s) => s.body), [offers.ASK_SIZE]);
  write(c, "58 ولا 60");
  await settle();
  assert.equal(to(c).at(-1)!.body, offers.CLARIFY_SIZE);
  write(c, "60");
  await settle();
  assert.equal(offers.knownSize(c), "60");
  const photos = to(c).filter((s) => s.type === "image");
  assert.equal(photos.length, 1);
  assert.match(photos[0]!.caption!, /أسود: 270 دينار/);
});

test("two customers on the same button with different sizes each get only their size", async () => {
  const a = "218910000013";
  const b = "218910000014";
  offers.saveSize(a, "58");
  offers.saveSize(b, "60");
  tap(a);
  tap(b);
  await settle();
  assert.ok(to(a).some((s) => /رصاصي/.test(s.caption ?? "")) && !to(a).some((s) => /أسود/.test(s.caption ?? "")));
  assert.ok(to(b).some((s) => /أسود/.test(s.caption ?? "")) && !to(b).some((s) => /رصاصي/.test(s.caption ?? "")));
});

test("a tap long after the photos went sends them again", async () => {
  const c = "218910000018";
  offers.saveSize(c, "60");
  tap(c);
  await settle();
  assert.equal(to(c).length, 1);
  db.prepare("UPDATE size_offer_requests SET updated_at = ? WHERE customer = ?").run(Date.now() - 7 * 60 * 60 * 1000, c);
  tap(c);
  await settle();
  assert.equal(to(c).length, 2);
});

test("a tap without our payload is known by the template message it answers", async () => {
  const c = "218910000019";
  offers.saveSize(c, "60");
  const id = Number(
    db
      .prepare("INSERT INTO campaigns (template, language, segment, days, body, daily_cap, status, created_at) VALUES (?, 'ar', 'no_order', 30, 'x', 50, 'done', ?)")
      .run(T, Date.now()).lastInsertRowid,
  );
  db.prepare("INSERT INTO campaign_recipients (campaign, customer, status, wamid, sent_at, updated_at) VALUES (?, ?, 'read', 'wamid.tpl', ?, ?)").run(id, c, Date.now(), Date.now());
  handleWhatsAppWebhook({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, contacts: [{ wa_id: c }], messages: [{ id: `in.${++n}`, from: c, timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "ابعتولي الصور" }, context: { id: "wamid.tpl" } }] } }] }],
  });
  await settle();
  assert.equal(to(c).filter((s) => s.type === "image").length, 1);
});

test("photos that keep failing go to the team, and the request stays open", async () => {
  const c = "218910000020";
  offers.saveSize(c, "58");
  offers.timing.retryWait = 10;
  failImages = 4; // two photos, two rounds (a 400 is not tried again within a send)
  tap(c);
  await new Promise((r) => setTimeout(r, 400));
  failImages = 0;
  const row = db.prepare("SELECT status FROM size_offer_requests WHERE customer = ?").get(c) as { status: string };
  assert.equal(row.status, "failed");
  assert.ok(db.prepare("SELECT 1 FROM pauses WHERE customer = ? AND reason LIKE 'AI handoff:%'").get(c));
});

test("nothing in their size: the spec's words", async () => {
  const c = "218910000015";
  offers.saveSize(c, "62");
  tap(c);
  await settle();
  assert.deepEqual(to(c).map((s) => s.body), [offers.noneText("30٪")]);
});

test("the size of their last order counts when none was saved", () => {
  const c = "218910000016";
  db.prepare(
    `INSERT INTO orders (customer, channel, name, phone, city, address, items, total, status, created_at, updated_at)
     VALUES (?, 'whatsapp', 'x', '0910000000', 'طرابلس', 'x', ?, '385 دينار', 'delivered', ?, ?)`,
  ).run(c, JSON.stringify([{ product: SET, color: "رصاصي", size: "58", quantity: 1 }]), Date.now(), Date.now());
  assert.equal(offers.knownSize(c), "58");
});

// (Checked on the claim itself: through the webhook, the AI's reply would be scheduled.)
test("a switched-off offer, another payload or an ordinary message is left to the AI", () => {
  const c = "218910000017";
  offers.saveSize(c, "58");
  assert.equal(offers.claimMessage({ customer: c, text: "ابعتولي الصور", buttonPayload: "offer:other_template", isButton: true }), false);
  assert.equal(offers.claimMessage({ customer: c, text: "58" }), false); // never asked for their size
  offers.saveOffer({ template: T, label: "30٪", button: 0, active: false });
  assert.equal(offers.claimMessage({ customer: c, text: "ابعتولي الصور", buttonPayload: `offer:${T}`, isButton: true }), false);
  assert.equal(to(c).length, 0);
});
