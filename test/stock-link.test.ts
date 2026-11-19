// Orders and stock: an order takes its pieces from the product it means, and gives back exactly those pieces.
// A wrong match here sells pieces we don't have and hides ones we do (order 73 gave a set back to the wrong product).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-stock-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");

const { db, saveOrder, setOrderStatus, updateOrder, setProductStock, listStock, stockProductFor, unmatchedOrderItems, heldStock, setStockAlias } =
  await import("../src/store.ts");

const MAIN = "طقم عربي ثلاث قطع";
const WHITE = "طقم أبيض مطرز"; // sorts before the main set: it used to catch every "طقم …" name
setProductStock(WHITE, [{ color: "أبيض", size: "58", quantity: 1 }]);
setProductStock("طقم مطرز موج", [{ color: "فضي", size: "58", quantity: 3 }]);
setProductStock("طقم مطرز زخرفة", [{ color: "فضي", size: "58", quantity: 3 }]);
setProductStock(MAIN, [
  { color: "فضي", size: "58", quantity: 5 },
  { color: "أسود", size: "60", quantity: 2 },
]);
const qty = (product: string, color: string, size: string) => listStock().find((r) => r.product === product && r.color === color && r.size === size)?.quantity;
const order = (items: { product?: string; color: string; size: string; quantity: number }[]) =>
  saveOrder({ customer: "218910000001", channel: "whatsapp", name: "x", phone: "0910000000", city: "طرابلس", address: "x", items, total: "335", notes: "" });

test("the main set's old names mean the main set, never the first set on the list", () => {
  for (const name of ["طقم عربي 3 قطع", "الطقم العربي 3 قطع", "الثوب العربي", "طقم عربي ثلاث قطع", "", undefined]) assert.equal(stockProductFor(name), MAIN, String(name));
  assert.equal(stockProductFor("طقم موج"), "طقم مطرز موج");
  // Fits two products: none, not a guess.
  assert.equal(stockProductFor("طقم مطرز"), undefined);
  assert.equal(stockProductFor("طقم"), undefined);
});

test("an order under an old name takes from the main set and its cancel gives back there", () => {
  const id = order([{ product: "طقم عربي 3 قطع", color: "فضي", size: "58", quantity: 1 }]);
  assert.equal(qty(MAIN, "فضي", "58"), 4);
  assert.equal(qty(WHITE, "أبيض", "58"), 1);
  assert.deepEqual(heldStock().map((h) => [h.orderId, h.product]), [[id, MAIN]]);
  setOrderStatus(id, "cancelled");
  assert.equal(qty(MAIN, "فضي", "58"), 5);
  assert.equal(qty(WHITE, "أبيض", "58"), 1);
  setOrderStatus(id, "new");
  assert.equal(qty(MAIN, "فضي", "58"), 4);
  setOrderStatus(id, "cancelled");
});

test("what was taken is given back even after the names change", () => {
  const id = order([{ product: "طقم عربي 3 قطع", color: "أسود", size: "60", quantity: 1 }]);
  assert.equal(qty(MAIN, "أسود", "60"), 1);
  // The alias now points elsewhere: the cancel still returns the piece where it came from.
  setStockAlias("طقم عربي 3 قطع", WHITE);
  setOrderStatus(id, "cancelled");
  assert.equal(qty(MAIN, "أسود", "60"), 2);
  assert.equal(qty(WHITE, "أبيض", "58"), 1);
  setStockAlias("طقم عربي 3 قطع", MAIN);
});

test("a piece that fits no product takes nothing and is flagged", () => {
  const before = listStock();
  const id = order([
    { product: "طقم مطرز", color: "فضي", size: "58", quantity: 1 }, // موج or زخرفة?
    { product: MAIN, color: "فضي", size: "58", quantity: 1 },
  ]);
  assert.equal(qty("طقم مطرز موج", "فضي", "58"), 3);
  assert.equal(qty("طقم مطرز زخرفة", "فضي", "58"), 3);
  assert.equal(qty(MAIN, "فضي", "58"), 4);
  assert.deepEqual(
    unmatchedOrderItems().map((u) => [u.orderId, u.item.product]),
    [[id, "طقم مطرز"]],
  );
  // The team fixes the name: it takes its piece, and the flag goes.
  updateOrder(id, {
    name: "x", phone: "0910000000", city: "طرابلس", address: "x", total: "335", notes: "",
    items: [
      { product: "طقم مطرز موج", color: "فضي", size: "58", quantity: 1 },
      { product: MAIN, color: "فضي", size: "58", quantity: 1 },
    ],
  });
  assert.equal(qty("طقم مطرز موج", "فضي", "58"), 2);
  assert.equal(qty(MAIN, "فضي", "58"), 4);
  assert.deepEqual(unmatchedOrderItems(), []);
  setOrderStatus(id, "cancelled");
  assert.deepEqual(listStock().map((r) => r.quantity), before.map((r) => r.quantity));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM order_stock WHERE order_id = ?").get(id) as { n: number }).n, 0);
});

test("a renamed product keeps its stock, its open orders and its old name", async () => {
  const { renameStockProduct, stockProductFor: forName } = await import("../src/store.ts");
  const id = order([{ product: "طقم موج", color: "فضي", size: "58", quantity: 1 }]);
  assert.equal(qty("طقم مطرز موج", "فضي", "58"), 2);
  assert.deepEqual(renameStockProduct("طقم مطرز موج", "طقم موج شتوي"), { orders: 1 });
  assert.equal(qty("طقم موج شتوي", "فضي", "58"), 2);
  assert.equal(forName("طقم مطرز موج"), "طقم موج شتوي");
  const items = JSON.parse((db.prepare("SELECT items FROM orders WHERE id = ?").get(id) as { items: string }).items);
  assert.equal(items[0].product, "طقم موج شتوي");
  assert.throws(() => renameStockProduct("طقم موج شتوي", MAIN));
  setOrderStatus(id, "cancelled");
  assert.equal(qty("طقم موج شتوي", "فضي", "58"), 3);
});

test("a deleted photo's id is never given to another photo", async () => {
  const { addCatalogItem, deleteCatalogItem, listCatalog } = await import("../src/catalog.ts");
  const add = () => addCatalogItem({ product: "طقم مطرز موج", name: "فضي", description: "", data: Buffer.from("x"), mime: "image/jpeg" }).id;
  const a = add();
  const b = add();
  deleteCatalogItem(b);
  const c = add();
  assert.notEqual(c, b);
  deleteCatalogItem(a);
  assert.ok(![a, b].includes(add()));
  assert.equal(new Set(listCatalog().map((i) => i.id)).size, listCatalog().length);
});

test("the order summary names a clearance set by its own name, and a loose set name is sent back", async () => {
  const { orderSummary } = await import("../src/agent.ts");
  const base = { name: "علي", phone: "0910000000", city: "طرابلس", address: "طرابلس", notes: "", payment: "cash" as const };
  assert.match(orderSummary({ ...base, total: "", items: [{ product: "الثوب العربي", color: "فضي", size: "58", quantity: 1 }] } as never), /المنتج: طقم عربي 3 قطع[\s\S]*385 دينار/);
  const clearance = orderSummary({ ...base, total: "400 دينار", items: [{ product: "طقم مطرز زخرفة", color: "فضي", size: "58", quantity: 1 }] } as never);
  assert.match(clearance, /المنتج: طقم مطرز زخرفة/);
  assert.match(clearance, /الإجمالي: 400 دينار/);
});

test("a hidden color is counted and sold, but never listed or sent unasked", async () => {
  const { stockForPrompt, isHiddenPhoto, customerNamed, missingStock } = await import("../src/stock.ts");
  setProductStock("طقم تجربة مخفي", [
    { color: "رصاصي", size: "58", quantity: 4 },
    { color: "رصاصي غامق", size: "58", quantity: 6, hidden: true },
  ]);
  const text = stockForPrompt();
  const own = text.slice(text.indexOf("طقم تجربة مخفي:"));
  assert.match(own, /- رصاصي: available in 58/);
  assert.doesNotMatch(own.split("HIDDEN (only")[0]!, /رصاصي غامق/);
  assert.match(text, /HIDDEN \(only for a customer who names the color himself\):\n[\s\S]*- طقم تجربة مخفي · رصاصي غامق: 58/);
  // Saved again without the flag (an old dashboard page): it stays hidden.
  setProductStock("طقم تجربة مخفي", [
    { color: "رصاصي", size: "58", quantity: 4 },
    { color: "رصاصي غامق", size: "58", quantity: 6 },
  ]);
  assert.ok(isHiddenPhoto({ product: "طقم تجربة مخفي", name: "رصاصي غامق" }));
  assert.ok(!isHiddenPhoto({ product: "طقم تجربة مخفي", name: "رصاصي" }));
  assert.ok(customerNamed("رصاصي غامق", ["عندك الرصاصي الغامق مقاس 58؟"]));
  assert.ok(!customerNamed("رصاصي غامق", ["شن الألوان اللي عندكم؟", "رصاصي"]));
  // Still sold to who asks: an order for it is checked against its pieces.
  assert.deepEqual(missingStock([{ product: "طقم تجربة مخفي", color: "رصاصي غامق", size: "58", quantity: 1 }]), []);
  setProductStock("طقم تجربة مخفي", [{ color: "رصاصي", size: "58", quantity: 4 }, { color: "رصاصي غامق", size: "58", quantity: 6, hidden: false }]);
  assert.ok(!isHiddenPhoto({ product: "طقم تجربة مخفي", name: "رصاصي غامق" }));
});

test("sizes come from the stock per product, and a sale is said as written", async () => {
  const { stockForPrompt } = await import("../src/stock.ts");
  const { setSale } = await import("../src/store.ts");
  setProductStock("طقم سادة فرملة وجهين", [
    { color: "بني", size: "62", quantity: 2 },
    { color: "بني", size: "64", quantity: 3 },
    { color: "أسود", size: "66", quantity: 0 },
  ]);
  setSale("طقم سادة فرملة وجهين", 20, "");
  const text = stockForPrompt();
  assert.match(text, /Sizes in stock \(any color\):[\s\S]*- طقم سادة فرملة وجهين: 62, 64\n/);
  assert.match(text, /largest size we have right now is 64 \(طقم سادة فرملة وجهين\)/);
  assert.match(text, /طقم سادة فرملة وجهين — ON SALE «تنزيلات 20%»:/);
  assert.match(text, /never work out, guess or say a price «before»/);
  // The main set isn't on sale.
  assert.doesNotMatch(text, /طقم عربي ثلاث قطع — ON SALE/);
  setSale("طقم سادة فرملة وجهين", null, "");
  assert.doesNotMatch(stockForPrompt(), /ON SALE/);
});
