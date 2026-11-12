// The Libya employee: his cash (a log of money in and out, the balance is their sum) and his own stock count.
// His stock is his alone: the AI, the orders and the team's stock page never read or change it.
import { db } from "./store.js";
import { esc, notify } from "./telegram.js";

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
// A correction made with «اعكسها» points at the line it undoes (each line can be undone once).
if (!(db.prepare("PRAGMA table_info(staff_cash)").all() as { name: string }[]).some((c) => c.name === "undoes")) {
  db.exec("ALTER TABLE staff_cash ADD COLUMN undoes INTEGER");
}

export type Role = "staff" | "admin";

// What a line is for. A mistake is never deleted: the opposite line with «تصحيح» undoes it.
export const CASH_KINDS = {
  in: ["درب السبيل", "زبون", "تصحيح", "غيره"],
  out: ["تحويل للشركة", "مصروف", "راتب", "تصحيح", "غيره"],
} as const;

// undoes: the line this correction cancels; undoneBy: the correction that cancelled this line.
export type CashRow = {
  id: number;
  direction: "in" | "out";
  amount: number;
  kind: string;
  note: string;
  byRole: Role;
  at: number;
  undoes: number | null;
  undoneBy: number | null;
};

export function cashBalance(): number {
  const r = db.prepare("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) AS b FROM staff_cash").get() as { b: number };
  return r.b;
}

const SELECT_CASH = `SELECT c.id, c.direction, c.amount, c.kind, c.note, c.by_role AS byRole, c.at, c.undoes,
  (SELECT u.id FROM staff_cash u WHERE u.undoes = c.id) AS undoneBy FROM staff_cash c`;

export function listCash(limit: number): CashRow[] {
  return db.prepare(`${SELECT_CASH} ORDER BY c.at DESC, c.id DESC LIMIT ?`).all(limit) as CashRow[];
}

const DIRECTION = { in: "استلم", out: "دفع" } as const;

// The team hears of every line the employee writes (lines the team writes itself aren't announced).
function announce(row: CashRow) {
  if (row.byRole !== "staff") return;
  const sign = row.direction === "in" ? "➕" : "➖";
  notify(
    "staff",
    `💵 <b>موظف ليبيا ${DIRECTION[row.direction]}</b> ${sign} ${row.amount} د.ل · ${esc(row.kind)}${row.note ? `
${esc(row.note)}` : ""}
معو هلق: <b>${Math.round(cashBalance() * 1000) / 1000} د.ل</b>`,
  );
}

function insert(direction: "in" | "out", amount: number, kind: string, note: string, by: Role, undoes: number | null): CashRow {
  const at = Date.now();
  const r = db
    .prepare("INSERT INTO staff_cash (direction, amount, kind, note, by_role, at, undoes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(direction, amount, kind, note, by, at, undoes);
  const row: CashRow = { id: Number(r.lastInsertRowid), direction, amount, kind, note, byRole: by, at, undoes, undoneBy: null };
  announce(row);
  return row;
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
  // A double tap on a slow connection: the same line again within half a minute is saved once.
  const twin = db
    .prepare("SELECT id FROM staff_cash WHERE direction = ? AND amount = ? AND kind = ? AND note = ? AND by_role = ? AND at > ?")
    .get(direction, amount, kind, note, by, Date.now() - 30_000);
  if (twin) return "هالحركة انسجلت هلق، شوفها بالسجل";
  return insert(direction, amount, kind, note, by, null);
}

// Cancels a line with the opposite one (kind «تصحيح»), never by deleting it.
export function undoCash(id: number, by: Role): CashRow | string {
  const row = db.prepare(`${SELECT_CASH} WHERE c.id = ?`).get(id) as CashRow | undefined;
  if (!row) return "الحركة مو موجودة";
  if (by === "staff" && row.byRole !== "staff") return "هاي الحركة سجّلتها الإدارة، بس هي بتعكسها";
  if (row.undoes !== null) return "هاي حركة تصحيح، ما بتنعكس";
  if (row.undoneBy !== null) return "هالحركة انعكست قبل";
  const back = row.direction === "in" ? "out" : "in";
  return insert(back, row.amount, "تصحيح", `عكس «${row.kind}» ${row.amount} د.ل${row.note ? `: ${row.note}` : ""}`.slice(0, 500), by, row.id);
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
