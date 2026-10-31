// The checks that decide whether a customer's order is saved, confirmed or flagged. Run before every deploy
// (npm run build): a broken one silently refuses every order, as a regex that lost its backslashes once did.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A throwaway database and the repo's knowledge files, never the live ones.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-test-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");

const { libyanMobile, sizeForWeight, summaryAnswered, orderSummary, addressGaps } = await import("../src/agent.ts");
const { BOOKED } = await import("../src/supervisor.ts");

test("Libyan mobile numbers in every form customers write them", () => {
  for (const ok of ["0944569150", "944569150", "218944569150", "+218 94 456 9150", "00218944569150", "092-531-6390", "٠٩٢٥٣١٦٣٩٠"]) {
    assert.ok(libyanMobile(ok), ok);
  }
  for (const bad of ["094456915", "09445691500", "0964569150", "0214569150", "905529834877", ""]) {
    assert.ok(!libyanMobile(bad), bad);
  }
});

test("size for weight follows the size table", () => {
  assert.equal(sizeForWeight(60), "56");
  assert.equal(sizeForWeight(80), "56");
  assert.equal(sizeForWeight(81), "58");
  assert.equal(sizeForWeight(95), "60");
  assert.equal(sizeForWeight(105), "62");
  assert.equal(sizeForWeight(130), undefined);
});

test("an order needs a summary the customer answered", () => {
  const details = { role: "customer" as const, text: "علي الهادي طبرق جوار قهوت الاقواس 0944569150" };
  const summary = { role: "business" as const, text: "المنتج: طقم عربي 3 قطع\nنثبّتلك الطلب استاذ؟" };
  assert.equal(summaryAnswered([details]), false);
  assert.equal(summaryAnswered([details, { role: "business", text: "باهي استاذ" }]), false);
  assert.equal(summaryAnswered([details, summary]), false);
  assert.equal(summaryAnswered([details, summary, { role: "customer", text: "تم" }]), true);
});

test("our own summary has every line the team expects", () => {
  const text = orderSummary({
    name: "علي الهادي",
    phone: "0944569150",
    city: "طبرق",
    address: "طبرق - جوار قهوت الاقواس",
    items: [{ product: "طقم عربي 3 قطع", color: "كريمي", size: "56", quantity: 1 }],
    total: "385 دينار",
    notes: "",
  });
  for (const line of ["المنتج:", "اللون: كريمي", "المقاس: 56", "العدد: 1", "الاسم: علي الهادي", "الرقم: 0944569150", "العنوان: طبرق", "الإجمالي: 385 دينار", "الدفع: كاش", "نثبّتلك"]) {
    assert.ok(text.includes(line), line);
  }
});

test("address gaps", () => {
  assert.deepEqual(addressGaps({ city: "طبرق", address: "طبرق - جوار قهوت الاقواس" }), []);
  assert.ok(addressGaps({ city: "", address: "" }).length);
});

test("'booked' words the supervisor watches for", () => {
  for (const said of ["تمام استاذ، تم الحجز 🙏", "تم تثبيت طلبك", "ثبتنالك الطلب", "تم تأكيد الطلب"]) assert.ok(BOOKED.test(said), said);
  assert.ok(!BOOKED.test("ابعتلي اسمك ورقمك باش نحجزلك"));
});

// Regexes written through a script once lost their backslashes ("[1-5]d{7}" instead of "[1-5]\d{7}") and
// every phone was refused. A regex class letter right after a bracket, bar or slash with no backslash is that.
test("no regex lost its backslashes", () => {
  const files = ["src", "dashboard/src"].flatMap((dir) =>
    fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(dir, f)),
  );
  const broken = files.flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (/(?<=[\]\)\/|(?:^])[dDsSwW](?:[*+?]|\{\d)/.test(line) ? [`${file}:${i + 1}`] : [])),
  );
  assert.deepEqual(broken, []);
});
