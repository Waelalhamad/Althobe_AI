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
const { segmentCustomers, templatePayload, applyStatuses, classifySendError, sendBlocker, isOptOut } = await import("../src/campaigns.ts");

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

test("a campaign goes only to the customers it may reach", () => {
  assert.deepEqual(segmentCustomers("fur_no_order", 30).sort(), [A]);
  assert.deepEqual(segmentCustomers("no_order", 30).sort(), [A, G].sort());
  assert.deepEqual(segmentCustomers("buyers", 30), [H]);
  // Customers who wrote before the days asked for are out.
  assert.deepEqual(segmentCustomers("fur_no_order", 2), []);
});

test("the ad audience keeps everyone but the blacklisted and the opted out", () => {
  assert.deepEqual(segmentCustomers("fur_no_order", 30, true).sort(), [A, C, E, P].sort());
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
