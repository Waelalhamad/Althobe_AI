// Campaigns (src/campaigns.ts): who gets a template, what is sent, and how delivery reports and refusals are kept.
// A mistake here messages the wrong people from the number every sale runs on.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-campaigns-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");

const { db, saveMessage, saveContact, pauseAi } = await import("../src/store.ts");
const { asksForDiscount, handoffIsDiscount, statedWeight, toldNoBiggerSize, tooBigFor62 } = await import("../src/campaignSignals.ts");
const { segmentCustomers, segmentMembers, templatePayload, applyStatuses, classifySendError, sendBlocker, isOptOut } = await import("../src/campaigns.ts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const say = (customer: string, text: string, ago: number) => saveMessage({ customer, role: "customer", source: "customer", text, createdAt: now - ago });
const order = (customer: string, status: string) =>
  db
    .prepare(
      `INSERT INTO orders (customer, channel, name, phone, city, address, items, total, status, created_at, updated_at)
       VALUES (?, 'whatsapp', 'x', '0910000000', 'طرابلس', 'x', '[]', '335 دينار', ?, ?, ?)`,
    )
    .run(customer, status, now - 5 * DAY, now - 5 * DAY);

const A = "218910000001"; // asked about the fur 3 days ago, no order: gets it
const B = "218910000002"; // asked about the fur, ordered
const C = "218910000003"; // asked about the fur 2 hours ago: still in the 24-hour window
const D = "218910000004"; // asked to stop
const E = "218910000005"; // got another campaign 2 days ago
const F = "LY.123456789"; // a username, no number
const G = "218910000007"; // asked about the set only
const H = "218910000008"; // bought and got it
const P = "218910000009"; // handed to the team
say(A, "بكم الفروة", 3 * DAY);
say(B, "نبي فروة حلزون", 6 * DAY);
order(B, "confirmed");
say(C, "الفروة متوفرة؟", 2 * HOUR);
say(D, "بكم الفروه", 4 * DAY);
db.prepare("INSERT INTO campaign_optouts (customer, reason, created_at) VALUES (?, 'توقف', ?)").run(D, now);
say(E, "صقع والله نبي فروة", 4 * DAY);
db.prepare("INSERT INTO campaign_recipients (campaign, customer, status, sent_at, updated_at) VALUES (99, ?, 'delivered', ?, ?)").run(E, now - 2 * DAY, now);
say(F, "الفروة بكم", 3 * DAY);
say(G, "بكم الطقم", 3 * DAY);
say(H, "بكم الطقم", 20 * DAY);
order(H, "delivered");
say(P, "الفروة", 3 * DAY);
pauseAi(P, "AI handoff: wants a discount", 12);

// The clearance groups: a discount asked for, a size we don't have.
const handoff = (customer: string, reason: string, ago: number) =>
  db.prepare("INSERT INTO ai_calls (customer, channel, action, reason, created_at) VALUES (?, 'whatsapp', 'handoff', ?, ?)").run(customer, reason, now - ago);
const Q = "218910000011"; // asked «في تخفيض؟» 5 days ago, no order
const R = "218910000012"; // said he weighs 120 kg
const S = "218910000013"; // asked for 64, then ordered
const T = "218910000014"; // the AI handed him to the team over a discount
const U = "218910000015"; // a wholesale price, not a discount on one set
const V = "218910000016"; // only the ad's text has «خصم 25%»
const W = "218910000017"; // we told him «للاسف اكبر مقاس 62»
const X = "218910000018"; // asked a discount, then complained
const Y = "201001112222"; // asked a discount, from Egypt
const Z = "218910000020"; // bought and received, then complained
const N = "218910000021"; // weighs 100 kg: 62 fits
say(Q, "السلام عليكم في تخفيض؟", 5 * DAY);
say(R, "[voice note] وزني ١٢٠ كيلو", 4 * DAY);
say(S, "هل يوجد مقاس 64", 6 * DAY);
order(S, "delivered");
say(T, "غالي شوية", 3 * DAY);
handoff(T, "الزبون يطلب خصم ويقول يريد السعر 300 بدلاً من 385", 3 * DAY);
say(U, "كم سعر الجملة", 3 * DAY);
handoff(U, "الزبون يسأل عن سعر جملة (طلب خصم أو سعر جملة)", 3 * DAY);
say(V, "[from the ad: «شركة الثوب العربي» الآن بسعر منخفض خصم 25% طقم ثوب عربي] مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟", 3 * DAY);
say(W, "نبي مقاس يناسبني", 3 * DAY);
saveMessage({ customer: W, role: "business", source: "staff", text: "للاسف اكبر مقاس 62", createdAt: now - 3 * DAY });
say(X, "ممكن خصم؟", 3 * DAY);
handoff(X, "الزبون اشتكى من تأخر التوصيل ويريد استرجاع", 2 * DAY);
say(Y, "في خصم؟", 3 * DAY);
say(Z, "شكرا وصلني", 8 * DAY);
order(Z, "delivered");
handoff(Z, "الزبون يشتكي أن المقاس ضيق ويريد استرجاع", 7 * DAY);
say(N, "وزني 100 كيلو", 3 * DAY);

test("a campaign goes only to the customers it may reach", () => {
  assert.deepEqual(segmentCustomers("fur_no_order", 30).sort(), [A]);
  assert.deepEqual(segmentCustomers("no_order", 30).sort(), [A, G, Q, R, T, U, V, W, N].sort());
  assert.deepEqual(segmentCustomers("buyers", 30).sort(), [H, S].sort()); // Z got her set but complained: no offer
  // Customers who wrote before the days asked for are out.
  assert.deepEqual(segmentCustomers("fur_no_order", 2), []);
});

test("the ad audience keeps everyone but the blacklisted and the opted out", () => {
  assert.deepEqual(segmentCustomers("fur_no_order", 30, true).sort(), [A, C, E, P].sort());
  // A number from abroad still counts for an audience, a complaint too (only the messages need protecting).
  assert.deepEqual(segmentCustomers("discount_no_order", 30, true).sort(), [P, Q, T, X, Y].sort());
});

test("checked again at send time", () => {
  const c = { id: 1, segment: "fur_no_order" };
  assert.equal(sendBlocker(c, A), undefined);
  assert.equal(sendBlocker(c, B), "order on its way");
  assert.equal(sendBlocker(c, C), "wrote recently");
  assert.equal(sendBlocker(c, D), "opted out");
  assert.equal(sendBlocker(c, E), "another campaign this week");
  assert.equal(sendBlocker(c, P), "with the team");
  assert.equal(sendBlocker(c, H), "ordered");
  assert.equal(sendBlocker({ id: 1, segment: "buyers" }, H), undefined);
});

test("the template's name and photo are filled in", () => {
  saveContact(A, "Ali Alhadi");
  const plain = templatePayload({ template: "fur_offer", language: "ar", body: "عندنا فروة جديدة", image: null }, A);
  assert.deepEqual(plain.template, { name: "fur_offer", language: { code: "ar" } });
  const full = templatePayload({ template: "fur_offer", language: "ar", body: "مرحبا {{1}}، عندنا فروة", image: "https://x/p.jpg" }, A);
  assert.deepEqual(full.template.components, [
    { type: "header", parameters: [{ type: "image", image: { link: "https://x/p.jpg" } }] },
    { type: "body", parameters: [{ type: "text", text: "Ali" }] },
  ]);
  assert.equal(full.to, A);
  // No name known: «استاذ».
  const noName = templatePayload({ template: "t", language: "ar", body: "مرحبا {{1}}", image: null }, G);
  assert.deepEqual(noName.template.components, [{ type: "body", parameters: [{ type: "text", text: "استاذ" }] }]);
});

test("delivery reports never go back, and a stop from Meta is kept", () => {
  db.prepare("INSERT INTO campaign_recipients (campaign, customer, status, wamid, sent_at, updated_at) VALUES (1, ?, 'sent', 'wamid.A', ?, ?)").run(A, now, now);
  const status = () => (db.prepare("SELECT status FROM campaign_recipients WHERE wamid = 'wamid.A'").get() as { status: string }).status;
  applyStatuses([{ id: "wamid.A", status: "read" }]);
  assert.equal(status(), "read");
  applyStatuses([{ id: "wamid.A", status: "delivered" }]);
  assert.equal(status(), "read");
  applyStatuses([{ id: "wamid.A", status: "failed", errors: [{ code: 131050, title: "user stopped marketing messages" }] }]);
  assert.equal(status(), "failed");
  assert.ok(db.prepare("SELECT 1 FROM campaign_optouts WHERE customer = ?").get(A));
  applyStatuses([{ id: "wamid.unknown", status: "read" }]); // the AI's own messages: ignored
});

test("Meta's refusals: the run, a passing one, or one customer", () => {
  assert.equal(classifySendError(400, '400 {"error":{"code":132001,"message":"Template name does not exist"}}'), "run_error");
  assert.equal(classifySendError(400, '400 {"error":{"code":131048,"message":"Spam rate limit hit"}}'), "run_error");
  assert.equal(classifySendError(401, "401 bad key"), "run_error");
  assert.equal(classifySendError(503, "503 upstream"), "passing");
  assert.equal(classifySendError(429, "429"), "passing");
  assert.equal(classifySendError(400, '400 {"error":{"code":131026,"message":"Message undeliverable"}}'), "customer");
});

test("a customer asking to stop", () => {
  for (const t of ["توقف", "إيقاف العروض الترويجية", "Stop promotions", "STOP", "الغاء الاشتراك"]) assert.ok(isOptOut(t), t);
  for (const t of ["بكم الفروة", "ما تبعتلي الصور؟", "الطلب وقف عند المندوب", "نبي نوقف الطلب"]) assert.ok(!isOptOut(t), t);
});

test("who asked for a discount and didn't order", () => {
  assert.deepEqual(segmentCustomers("discount_no_order", 30).sort(), [Q, T].sort());
  // Not: wholesale (U), the ad's words (V), a complaint (X), abroad (Y), the team has him (P).
  const why = Object.fromEntries(segmentMembers("discount_no_order", 30).map((m) => [m.customer, m.why]));
  assert.match(why[Q], /تخفيض/);
  assert.match(why[T], /خصم/);
  assert.deepEqual(segmentCustomers("discount_no_order", 2), []);
});

test("whose size we don't have, and didn't order", () => {
  // R: 120 kg; W: told our biggest is 62. Not S (ordered), N (100 kg fits), nor a size question about 60.
  assert.deepEqual(segmentCustomers("size_too_big", 30).sort(), [R, W].sort());
});

test("a sent offer's answers are not read as what the customer asked", () => {
  assert.equal(asksForDiscount("[sent our offer message] عندنا تنزيلات خصم 20%"), false);
  assert.equal(asksForDiscount("[sent a reaction 👍 to: «ما في خصم»]"), false);
  assert.equal(asksForDiscount("[answering our message «السعر ثابت»] طيب في تخفيض لو اخذت اثنين"), true);
});

test("discount words", () => {
  for (const t of ["كم التخفيض", "في تخفيظ", "ديرلي سعر اقل شوي", "آخر سعر", "متقدرش تنزل السعر", "هل في خصم", "ياريت ارخص شوية"]) assert.ok(asksForDiscount(t), t);
  for (const t of ["بكم الطقم", "كم السعر مع التوصيل", "مرحبا", "ولد يلبس 56", "نبي رقم 56 xl"]) assert.ok(!asksForDiscount(t), t);
  assert.ok(handoffIsDiscount("الزبون يسأل عن تخفيض عند شراء 2"));
  assert.ok(!handoffIsDiscount("الزبون يسأل عن سعر الجملة/خصم"));
  assert.ok(!handoffIsDiscount("الزبون يسأل عن التوصيل"));
});

test("weights and sizes above what we have", () => {
  for (const t of ["وزني 120", "الوزن ١٣٠ كيلو", "انا طولي 180ووزني 110كيلو", "الوزن95الطول192 والوزن 106", "هل يوجد مقاس 64", "رقم 66", "64", "٦٥", "62 63", "اكبر من 62", "في مقاس اكبر", "مقاسي XXXXL", "نبي 4x"]) {
    assert.ok(tooBigFor62(t), t);
  }
  for (const t of ["وزني 100", "الوزن 105", "الوزن95الطول192", "نبي رقم 56 xl", "58xl", "مقاس 60", "62", "طولي 190", "وزن الطقم 400 جرام", "لا 60مقاس كبير عليا", "نبي مقاس 62 3x", "0914950567"]) {
    assert.ok(!tooBigFor62(t), t);
  }
  assert.equal(statedWeight("وزني ١٢٠ كيلو"), 120);
  assert.ok(toldNoBiggerSize("للاسف اكبر مقاس متوفر 62"));
  assert.ok(toldNoBiggerSize("ما عندنا 64، أكبر مقاس 62 استاذ."));
  assert.ok(!toldNoBiggerSize("المقاسات المتوفرة: 56، 58، 60، 62 — وأكبر مقاس 62."));
});
