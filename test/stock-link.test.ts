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
