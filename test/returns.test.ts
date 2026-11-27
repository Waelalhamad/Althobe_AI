// Returns and the warehouse count: a piece Darb brings back stays held until someone has it in hand («استلمت الراجع»),
// is put back once only, and a count compares the shelf with what should be on it (available + pieces of orders still
// there), so a counted piece held for an order is never sold twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-returns-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");
process.env.TELEGRAM_BOT_TOKEN = "";

const { db, saveOrder, setOrderStatus, setProductStock, listStock, heldStock, onShelfHeld, receiveReturn, undoReceiveReturn } = await import("../src/store.ts");
const { submitCount, approveCount } = await import("../src/stockCount.ts");

const SET = "طقم عربي ثلاث قطع";
setProductStock(SET, [
  { color: "بني", size: "58", quantity: 5 },
  { color: "فضي", size: "60", quantity: 5 },
]);
const qty = (color: string, size: string) => listStock().find((r) => r.product === SET && r.color === color && r.size === size)!.quantity;
const order = (color: string, size: string, quantity = 1) =>
  saveOrder({ customer: "218910000001", channel: "whatsapp", name: "x", phone: "0910000000", city: "طرابلس", address: "x", items: [{ product: SET, color, size, quantity }], total: "385", notes: "", status: "confirmed" });
const darb = (id: number, status: string | null) => db.prepare("UPDATE orders SET darb_id = ?, darb_status = ? WHERE id = ?").run(status ? `d${id}` : null, status, id);
const heldBy = (id: number) => heldStock().filter((h) => h.orderId === id);

test("a return is held until received, then put back once", () => {
  const id = order("بني", "58", 2);
  assert.equal(qty("بني", "58"), 3);
  darb(id, "returning");
  assert.equal(heldBy(id)[0]?.back, true);
  assert.match(String(receiveReturn(id, true, "x")), /لسا ما قالت/); // still on the road: no button
  darb(id, "released");
  assert.equal(heldBy(id).length, 1); // back with us by Darb, nobody confirmed: still held, not sold
  assert.deepEqual(receiveReturn(id, true, "موظف ليبيا"), { pieces: 2 });
  assert.equal(qty("بني", "58"), 5);
  assert.equal(heldBy(id).length, 0);
  assert.match(String(receiveReturn(id, true, "x")), /من قبل/); // a second press adds nothing
  assert.equal(qty("بني", "58"), 5);
  // Cancelled afterwards: nothing more comes back; un-cancelled: nothing is taken (the pieces are on the shelf).
  setOrderStatus(id, "cancelled");
  setOrderStatus(id, "confirmed");
  assert.equal(qty("بني", "58"), 5);
  // Undo: held and taken again.
  assert.equal(undoReceiveReturn(id), true);
  assert.equal(qty("بني", "58"), 3);
  assert.equal(heldBy(id).length, 1);
  receiveReturn(id, true, "x");
  // Darb says delivered after all: the pieces are gone again.
  setOrderStatus(id, "delivered");
  assert.equal(qty("بني", "58"), 3);
  assert.equal(db.prepare("SELECT return_received_at FROM orders WHERE id = ?").get(id)!.return_received_at, null);
});

test("an old return can let its hold go without adding the pieces (the count puts them back); undo holds again", () => {
  const id = order("فضي", "60");
  darb(id, "returned"); // in Darb's returns box: not with us yet
  assert.match(String(receiveReturn(id, false, "x")), /لسا ما قالت/);
  darb(id, "released");
  assert.equal(qty("فضي", "60"), 4);
  assert.deepEqual(receiveReturn(id, false, "الإدارة"), { pieces: 1 });
  assert.equal(qty("فضي", "60"), 4);
  assert.equal(heldBy(id).length, 0);
  assert.equal(undoReceiveReturn(id), true);
  assert.equal(qty("فضي", "60"), 4);
  assert.equal(heldBy(id).length, 1);
  receiveReturn(id, false, "x");
});

test("the count compares the shelf with available + pieces of orders still on it", () => {
  setProductStock(SET, [
    { color: "أسود", size: "56", quantity: 3 },
    { color: "أسود", size: "58", quantity: 3 },
  ]);
  const notSent = order("أسود", "56"); // on the shelf, waiting for Darb
  const booked = order("أسود", "56");
  darb(booked, "booked"); // Darb hasn't picked it up
  const onWay = order("أسود", "56");
  darb(onWay, "on-branch"); // left with the courier
  const back = order("أسود", "58");
  darb(back, "released"); // handed back, not confirmed: on the shelf
  assert.equal(qty("أسود", "56"), 0);
  assert.equal(qty("أسود", "58"), 2);
  const shelf = onShelfHeld();
  assert.equal(shelf.get(`${SET}|أسود|56`), 2); // not the one on its way
  assert.equal(shelf.get(`${SET}|أسود|58`), 1);
  assert.equal(notSent > 0, true);

  // The warehouse counts what is really there: 2 black 56 (both still waiting) and 3 black 58 (with the return).
  const sent = submitCount({ counts: [{ product: SET, color: "أسود", size: "56", counted: 2 }, { product: SET, color: "أسود", size: "58", counted: 3 }] }, "staff");
  assert.ok(typeof sent === "object", String(sent));
  assert.deepEqual(approveCount(sent.id), { changed: 0 }); // nothing to change: no piece sold twice
  assert.equal(qty("أسود", "56"), 0);
  assert.equal(qty("أسود", "58"), 2);
  // Then the return is confirmed: its piece is sold again.
  receiveReturn(back, true, "x");
  assert.equal(qty("أسود", "58"), 3);

  // One black 56 missing from the shelf: available goes down by one (below zero means an order can't be filled).
  const again = submitCount({ counts: [{ product: SET, color: "أسود", size: "56", counted: 1 }] }, "staff");
  assert.ok(typeof again === "object", String(again));
  approveCount(again.id);
  assert.equal(qty("أسود", "56"), -1);
});

test("the returns list: handed back and held → awaiting; before the button → old (the hold is only let go)", async () => {
  const { incomingReturns } = await import("../src/darbRedirect.ts");
  setProductStock(SET, [{ color: "كريمي", size: "56", quantity: 4 }]);
  const ship = (id: number, status: string, at: number) => {
    db.prepare("INSERT INTO darb_shipments (id, reference, status, created_at, synced_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?)").run(`d${id}`, `SH${id}`, status, at, at, at);
    db.prepare("UPDATE orders SET darb_id = ?, darb_ref = ?, darb_status = ? WHERE id = ?").run(`d${id}`, `SH${id}`, status, id);
  };
  const fresh = order("كريمي", "56");
  ship(fresh, "released", Date.now() + 1000);
  const old = order("كريمي", "56");
  ship(old, "released", 1);
  const atDarb = order("كريمي", "56");
  ship(atDarb, "returned", Date.now());
  const list = await incomingReturns();
  const row = (id: number) => list.find((r) => r.orderId === id);
  assert.equal(row(fresh)?.awaiting, true);
  assert.equal(row(fresh)?.old, false);
  assert.equal(row(old)?.awaiting, true);
  assert.equal(row(old)?.old, true);
  assert.equal(row(atDarb)?.awaiting, false);
  assert.equal(row(fresh)?.items[0]?.product, SET);
  receiveReturn(fresh, true, "x");
  const after = await incomingReturns();
  assert.equal(after.find((r) => r.orderId === fresh)?.awaiting, false);
  assert.ok(after.find((r) => r.orderId === fresh)?.receivedAt);
});
