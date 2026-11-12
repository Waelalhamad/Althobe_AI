// The Libya employee: his cash (a log of money in and out, the balance is their sum) and his own stock count.
// His stock is his alone: the AI, the orders and the team's stock page never read or change it.
import { db } from "./store.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_cash (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    direction   TEXT    NOT NULL,          -- 'in' | 'out'
    amount      REAL    NOT NULL,          -- Libyan dinars, always > 0
    kind        TEXT    NOT NULL,
    note        TEXT    NOT NULL DEFAULT '',
    by_role     TEXT    NOT NULL,          -- 'staff' | 'admin': who wrote it
    at          INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staff_stock (
    product     TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    size        TEXT    NOT NULL,
    quantity    INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (product, color, size)
  );
  CREATE TABLE IF NOT EXISTS staff_stock_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product     TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    size        TEXT    NOT NULL,
    qty_before  INTEGER,                   -- null: the cell was just added
    qty_after   INTEGER,                   -- null: the cell was removed
    by_role     TEXT    NOT NULL,
    at          INTEGER NOT NULL
  );
`);

export type Role = "staff" | "admin";

// What a line is for. A mistake is never deleted: the opposite line with «تصحيح» undoes it.
export const CASH_KINDS = {
  in: ["درب السبيل", "زبون", "تصحيح", "غيره"],
  out: ["تحويل للشركة", "مصروف", "راتب", "تصحيح", "غيره"],
} as const;

export type CashRow = { id: number; direction: "in" | "out"; amount: number; kind: string; note: string; byRole: Role; at: number };

export function cashBalance(): number {
  const r = db.prepare("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) AS b FROM staff_cash").get() as { b: number };
  return r.b;
}

export function listCash(limit: number): CashRow[] {
  return db
    .prepare("SELECT id, direction, amount, kind, note, by_role AS byRole, at FROM staff_cash ORDER BY at DESC, id DESC LIMIT ?")
    .all(limit) as CashRow[];
}

// Checks the line and saves it; returns an error in Arabic for the screen, or the saved row.
export function addCash(input: { direction?: unknown; amount?: unknown; kind?: unknown; note?: unknown }, by: Role): CashRow | string {
  const direction = input.direction === "in" || input.direction === "out" ? input.direction : undefined;
  if (!direction) return "اختار استلمت أو دفعت";
  const amount = Math.round(Number(input.amount) * 1000) / 1000;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return "اكتب المبلغ صح";
  const kind = String(input.kind ?? "");
  if (!(CASH_KINDS[direction] as readonly string[]).includes(kind)) return "اختار النوع";
  const note = String(input.note ?? "").trim().slice(0, 500);
  const at = Date.now();
  const r = db
    .prepare("INSERT INTO staff_cash (direction, amount, kind, note, by_role, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(direction, amount, kind, note, by, at);
  return { id: Number(r.lastInsertRowid), direction, amount, kind, note, byRole: by, at };
}

// --- His stock ---------------------------------------------------------------------

export type StaffStockRow = { product: string; color: string; size: string; quantity: number; updatedAt: number };
export type StaffStockLogRow = { id: number; product: string; color: string; size: string; before: number | null; after: number | null; byRole: Role; at: number };

export function listStaffStock(): StaffStockRow[] {
  return db
    .prepare("SELECT product, color, size, quantity, updated_at AS updatedAt FROM staff_stock ORDER BY product, color, rowid")
    .all() as StaffStockRow[];
}

export function staffStockLog(limit: number): StaffStockLogRow[] {
  return db
    .prepare(`SELECT id, product, color, size, qty_before AS "before", qty_after AS "after", by_role AS byRole, at FROM staff_stock_log ORDER BY at DESC, id DESC LIMIT ?`)
    .all(limit) as StaffStockLogRow[];
}

const clean = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

function logChange(product: string, color: string, size: string, before: number | null, after: number | null, by: Role, at: number) {
  db.prepare("INSERT INTO staff_stock_log (product, color, size, qty_before, qty_after, by_role, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    product,
    color,
    size,
    before,
    after,
    by,
    at,
  );
}

function current(product: string, color: string, size: string): number | null {
  const r = db.prepare("SELECT quantity FROM staff_stock WHERE product = ? AND color = ? AND size = ?").get(product, color, size) as
    | { quantity: number }
    | undefined;
  return r ? r.quantity : null;
}

// Sets one cell (adds it when new). Every change is logged with who made it.
export function setStaffStock(input: { product?: unknown; color?: unknown; size?: unknown; quantity?: unknown }, by: Role): string | undefined {
  const product = clean(input.product);
  const color = clean(input.color);
  const size = clean(input.size) || "ستاندرد";
  const quantity = Number(input.quantity);
  if (!product || !color) return "اكتب المنتج واللون";
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100_000) return "العدد لازم يكون رقم صحيح";
  const before = current(product, color, size);
  if (before === quantity) return;
  const at = Date.now();
  db.prepare(
    "INSERT INTO staff_stock (product, color, size, quantity, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (product, color, size) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at",
  ).run(product, color, size, quantity, at);
  logChange(product, color, size, before, quantity, by, at);
}

// Removes a whole product, a color of it, or a single size (the log keeps what each had).
export function removeStaffStock(input: { product?: unknown; color?: unknown; size?: unknown }, by: Role): string | undefined {
  const product = clean(input.product);
  if (!product) return "اختار المنتج";
  const color = clean(input.color);
  const size = clean(input.size);
  const rows = listStaffStock().filter((r) => r.product === product && (!color || r.color === color) && (!size || r.size === size));
  const at = Date.now();
  for (const r of rows) {
    db.prepare("DELETE FROM staff_stock WHERE product = ? AND color = ? AND size = ?").run(r.product, r.color, r.size);
    logChange(r.product, r.color, r.size, r.quantity, null, by, at);
  }
}
