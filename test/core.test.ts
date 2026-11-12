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
      .flatMap((line, i) => (/(?<=[\]\)\/|(?:^])[dDsSwW](?:[*+?]|\{\d)|(?<![\\\w])p\{L\}/.test(line) ? [`${file}:${i + 1}`] : [])),
  );
  assert.deepEqual(broken, []);
});

test("the price goes with free delivery and cash on delivery", async () => {
  const { priceProblems, withPaymentTerms } = await import("../src/agent.ts");
  const asked = [{ role: "customer" as const, text: "[from the ad: «الثوب العربي» 385] السلام عليكم، بكم؟" }];
  assert.deepEqual(priceProblems("385 دينار، والتوصيل مجاني لباب بيتك والدفع عند الاستلام 😊", asked), []);
  assert.equal(priceProblems("سعره 385 دينار 😊", asked).length, 1);
  // From the ad without asking: no price in the first reply ("عليكم" isn't "كم").
  const notAsked = [{ role: "customer" as const, text: "[from the ad: «الثوب العربي» 385] السلام عليكم، نبي نطلب الثوب العربي" }];
  assert.equal(priceProblems("385 دينار، والتوصيل مجاني والدفع عند الاستلام", notAsked).length, 1);
  assert.deepEqual(priceProblems("حياك الله استاذ 😊 طقم كامل 3 قطع", notAsked), []);
  // A summary isn't checked.
  assert.deepEqual(priceProblems("المنتج: طقم\nالإجمالي: 385 دينار", notAsked), []);

  assert.equal(withPaymentTerms("سعره 385 دينار، والتوصيل مجاني 😊\nشن اللون اللي عجبك؟", asked), "سعره 385 دينار، والتوصيل مجاني، والدفع عند الاستلام 😊\nشن اللون اللي عجبك؟");
  assert.equal(withPaymentTerms("385 دينار.", asked), "385 دينار، والتوصيل مجاني لباب بيتك والدفع عند الاستلام");
  const said = [...asked, { role: "business" as const, text: "385 دينار والدفع عند الاستلام" }];
  assert.equal(withPaymentTerms("385 دينار بس", said), "385 دينار بس");
});

test("one color is never booked in two sizes (try both, return one)", async () => {
  const { twoSizesOneColor } = await import("../src/agent.ts");
  assert.deepEqual(twoSizesOneColor([{ color: "أسود", size: "56" }, { color: "أسود", size: "58" }]), ["أسود"]);
  assert.deepEqual(twoSizesOneColor([{ color: "أبيض", size: "58" }, { color: "أسود", size: "58" }]), []);
  assert.deepEqual(twoSizesOneColor([{ color: "بني", size: "56" }, { color: "بني", size: 56 }]), []);
});

test("a message that corrects itself is caught", async () => {
  const { selfCorrects, styleProblems } = await import("../src/agent.ts");
  assert.ok(selfCorrects("باهي استاذة، المقاسات 62 المتوفرة عندنا: أبيض، أبيض؟ لا — غلط. نعيد: أبيض، أسود، بيج، فضي."));
  assert.ok(selfCorrects("المتوفر: أسود، أسود، بني"));
  assert.ok(selfCorrects("مقاس 58 لا - غلط، 60"));
  assert.ok(!selfCorrects("المتوفر عندنا: أبيض، أسود، بيج، فضي. شن اللون اللي تبيه؟"));
  assert.ok(!selfCorrects("لا استاذ، التوصيل مجاني لباب بيتك"));
  assert.ok(styleProblems("شن اللون اللي تريديه؟").some((p) => p.includes("تريديه")));
});

test("a phone number found inside what the customer wrote", async () => {
  const { libyanMobileIn } = await import("../src/almostOrders.ts");
  assert.equal(libyanMobileIn("عبدو الفرجاني0911398059"), "0911398059");
  assert.equal(libyanMobileIn("رقمي ٠٩٢٣٢٦١١٤٩"), "0923261149");
  assert.equal(libyanMobileIn("+218 94 456 9150 بنغازي"), "0944569150");
  assert.equal(libyanMobileIn("الوزن 95 والطول 170"), undefined);
  assert.equal(libyanMobileIn("09445691500"), undefined);
});

test("Dualhook's upstream failure is a passing send error", async () => {
  const { isPassingSendError } = await import("../src/channels/whatsapp.ts");
  assert.ok(isPassingSendError(404, '{"error":{"message":"Upstream request failed"}}'));
  assert.ok(!isPassingSendError(400, '{"error":{"message":"Recipient phone number not in allowed list","code":131030}}'));
});

test("a color with only a few pieces left is marked for the AI", async () => {
  const { stockForPrompt } = await import("../src/stock.ts");
  const { db } = await import("../src/store.ts");
  const put = db.prepare("INSERT OR REPLACE INTO stock (product, color, size, quantity, updated_at) VALUES (?, ?, ?, ?, 0)");
  put.run("فروة تجربة", "فضي", "ستاندرد", 2);
  put.run("فروة تجربة", "بني", "ستاندرد", 40);
  const text = stockForPrompt();
  assert.match(text, /- فضي: available in ستاندرد — ONLY A FEW LEFT/);
  assert.doesNotMatch(text, /- بني: available in ستاندرد — ONLY A FEW LEFT/);
});

test("a photo we send is named with its model, except the set's", async () => {
  const { photoLabel } = await import("../src/catalog.ts");
  const { SET_NAME } = await import("../src/store.ts");
  const item = { id: "p36", name: "بني", description: "", file: "", mime: "", createdAt: 0 };
  assert.equal(photoLabel({ ...item, product: "فروة أبو شهري مطرز حلزون" }, SET_NAME), "فروة أبو شهري مطرز حلزون - بني");
  assert.equal(photoLabel({ ...item, product: "الطقم العربي" }, SET_NAME), "بني");
  assert.equal(photoLabel(item, SET_NAME), "بني");
});

test("an order for the set in a chat about the fur only is caught", async () => {
  const { wrongProduct } = await import("../src/agent.ts");
  const set = [{ product: "طقم عربي ثلاث قطع", color: "أسود", size: "56", quantity: 1 }];
  const fur = [{ product: "فروة أبو شهري مطرز حلزون", color: "أسود", size: "ستاندرد", quantity: 1 }];
  assert.equal(wrongProduct(set, { fur: true, set: false }).length, 1);
  assert.equal(wrongProduct(fur, { fur: true, set: false }).length, 0);
  assert.equal(wrongProduct(set, { fur: true, set: true }).length, 0);
  assert.equal(wrongProduct(fur, { fur: false, set: true }).length, 1);
  assert.equal(wrongProduct(set, undefined).length, 0);
});
