// The Libya employee's money: his cash box and his bank account have their own balances; money moved between
// them is two linked lines, and undoing either side undoes both.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "althobe-bank-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "agent.db");
process.env.KNOWLEDGE_DIR = path.resolve("knowledge");

const { addCash, balances, moveCash, openingCash, setOpeningCash, undoCash, listCash } = await import("../src/staff.ts");

test("each account keeps its own balance and opening", () => {
  assert.equal(typeof setOpeningCash({ amount: 100 }, "admin"), "object");
  assert.equal(typeof setOpeningCash({ amount: 2000, account: "bank" }, "admin"), "object");
  assert.equal(typeof setOpeningCash({ amount: 5, account: "bank" }, "admin"), "string");
  assert.ok(openingCash("cash") && openingCash("bank"));
  const r = addCash({ account: "bank", direction: "in", amount: 450, kind: "درب السبيل", statement: "تحويل درب" }, "staff");
  assert.equal(typeof r, "object");
  assert.equal(typeof addCash({ account: "bank", direction: "out", amount: 3, kind: "زبون", statement: "xx" }, "staff"), "string");
  assert.equal(typeof addCash({ account: "bank", direction: "out", amount: 3, kind: "عمولة البنك", statement: "عمولة" }, "staff"), "object");
  assert.deepEqual(balances(), { cash: 100, bank: 2447 });
});

test("moving money changes both accounts, undoing it puts both back", () => {
  const moved = moveCash({ to: "bank", amount: 60 }, "staff");
  assert.ok(Array.isArray(moved));
  assert.deepEqual(balances(), { cash: 40, bank: 2507 });
  assert.equal(moved[0].pair, moved[1].id);
  assert.equal(moved[1].pair, moved[0].id);
  assert.equal(typeof moveCash({ to: "bank", amount: 60 }, "staff"), "string"); // a double tap
  assert.equal(typeof undoCash(moved[1].id, "staff"), "object");
  assert.deepEqual(balances(), { cash: 100, bank: 2447 });
  assert.equal(typeof undoCash(moved[0].id, "staff"), "string");
  assert.ok(listCash(100).filter((r) => r.undoes !== null).length === 2);
});
