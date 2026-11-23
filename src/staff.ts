// The Libya employee: his money (a log of money in and out of his cash box and of his bank account, each balance
// is the sum of its lines) and his own stock count.
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
// البيان: what the money was for, in his words (required; the note under it stays optional).
if (!(db.prepare("PRAGMA table_info(staff_cash)").all() as { name: string }[]).some((c) => c.name === "statement")) {
  db.exec("ALTER TABLE staff_cash ADD COLUMN statement TEXT NOT NULL DEFAULT ''");
}
// Why a stock cell changed: '' a normal edit, 'opening' the opening count.
if (!(db.prepare("PRAGMA table_info(staff_stock_log)").all() as { name: string }[]).some((c) => c.name === "reason")) {
  db.exec("ALTER TABLE staff_stock_log ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
}
// The opening count of his stock was made (once): when and by whom. Its cells are the log lines with reason 'opening'.
db.exec("CREATE TABLE IF NOT EXISTS staff_opening (part TEXT PRIMARY KEY, at INTEGER NOT NULL, by_role TEXT NOT NULL)");

// The account a line belongs to: 'cash' his cash box, 'bank' his bank account (lines from before it existed are cash).
if (!(db.prepare("PRAGMA table_info(staff_cash)").all() as { name: string }[]).some((c) => c.name === "account")) {
  db.exec("ALTER TABLE staff_cash ADD COLUMN account TEXT NOT NULL DEFAULT 'cash'");
}
// Money moved between his box and his bank is two lines, each pointing at the other (undoing one undoes both).
if (!(db.prepare("PRAGMA table_info(staff_cash)").all() as { name: string }[]).some((c) => c.name === "pair")) {
  db.exec("ALTER TABLE staff_cash ADD COLUMN pair INTEGER");
}
export type Role = "staff" | "admin";
export type Account = "cash" | "bank";
const ACCOUNT_NAME: Record<Account, string> = { cash: "الصندوق", bank: "البنك" };
const accountOf = (v: unknown): Account | undefined => (v === "cash" || v === "bank" ? v : undefined);

// What a line is for. A mistake is never deleted: the opposite line with «تصحيح» undoes it.
// The opening count of each account is a line of its own kind, made only through setOpeningCash (never a chip on the form).
export const OPENING = "رصيد افتتاحي";
// Money moved between his box and his bank: never a chip on the form either (moveCash writes both lines).
export const MOVE = { toBank: { cash: "إيداع بالبنك", bank: "إيداع من الصندوق" }, toCash: { bank: "سحب للصندوق", cash: "سحب من البنك" } } as const;
export const MOVE_KINDS: string[] = [MOVE.toBank.cash, MOVE.toBank.bank, MOVE.toCash.bank, MOVE.toCash.cash];

export const CASH_KINDS = {
  cash: {
    in: ["درب السبيل", "زبون", "تصحيح", "غيره"],
    out: ["تحويل للشركة", "مصروف", "راتب", "تصحيح", "غيره"],
  },
  bank: {
    in: ["درب السبيل", "تحويل زبون", "من الشركة", "تصحيح", "غيره"],
    out: ["تحويل للشركة", "مصروف", "راتب", "عمولة البنك", "تصحيح", "غيره"],
  },
} as const;

// undoes: the line this correction cancels; undoneBy: the correction that cancelled this line;
// pair: the other side of money moved between his box and his bank.
export type CashRow = {
  id: number;
  account: Account;
  direction: "in" | "out";
  amount: number;
  kind: string;
  statement: string;
  note: string;
  byRole: Role;
  at: number;
  undoes: number | null;
  undoneBy: number | null;
  pair: number | null;
};

export function cashBalance(account: Account = "cash"): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) AS b FROM staff_cash WHERE account = ?")
    .get(account) as { b: number };
  return Math.round(r.b * 1000) / 1000;
}

export const balances = (): Record<Account, number> => ({ cash: cashBalance("cash"), bank: cashBalance("bank") });

const SELECT_CASH = `SELECT c.id, c.account, c.direction, c.amount, c.kind, c.statement, c.note, c.by_role AS byRole, c.at, c.undoes, c.pair,
  (SELECT u.id FROM staff_cash u WHERE u.undoes = c.id) AS undoneBy FROM staff_cash c`;

export function listCash(limit: number): CashRow[] {
  return db.prepare(`${SELECT_CASH} ORDER BY c.at DESC, c.id DESC LIMIT ?`).all(limit) as CashRow[];
}

const DIRECTION = { in: "استلم", out: "دفع" } as const;
const dinars = (n: number) => `${Math.round(n * 1000) / 1000} د.ل`;

// The team hears of every line the employee writes (lines the team writes itself aren't announced).
function announce(row: CashRow) {
  if (row.byRole !== "staff") return;
  const where = ACCOUNT_NAME[row.account];
  if (row.kind === OPENING) {
    notify("staff", `📋 <b>موظف ليبيا: الجرد الافتتاحي ${row.account === "bank" ? "للبنك" : "للمصاري"}</b>
${row.account === "bank" ? "بحسابو" : "معو"}: <b>${dinars(row.amount)}</b>`);
    return;
  }
  const sign = row.direction === "in" ? "➕" : "➖";
  notify(
    "staff",
    `${row.account === "bank" ? "🏦" : "💵"} <b>موظف ليبيا ${DIRECTION[row.direction]}</b> (${where}) ${sign} ${dinars(row.amount)} · ${esc(row.kind)}${row.statement ? `
📝 ${esc(row.statement)}` : ""}${row.note ? `
${esc(row.note)}` : ""}
${row.account === "bank" ? "بالبنك" : "معو"} هلق: <b>${dinars(cashBalance(row.account))}</b>`,
  );
}

type Line = { account: Account; direction: "in" | "out"; amount: number; kind: string; statement: string; note: string; undoes: number | null; pair?: number | null };

function write(l: Line, by: Role, at: number): CashRow {
  const r = db
    .prepare("INSERT INTO staff_cash (account, direction, amount, kind, statement, note, by_role, at, undoes, pair) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(l.account, l.direction, l.amount, l.kind, l.statement, l.note, by, at, l.undoes, l.pair ?? null);
  return { ...l, pair: l.pair ?? null, id: Number(r.lastInsertRowid), byRole: by, at, undoneBy: null };
}

function insert(l: Line, by: Role): CashRow {
  const row = write(l, by, Date.now());
  announce(row);
  return row;
}

// Two lines that point at each other (money moved, or the undoing of money moved), written together.
function insertPair(a: Line, b: Line, by: Role): [CashRow, CashRow] {
  const at = Date.now();
  db.exec("BEGIN");
  try {
    const first = write(a, by, at);
    const second = write({ ...b, pair: first.id }, by, at);
    db.prepare("UPDATE staff_cash SET pair = ? WHERE id = ?").run(second.id, first.id);
    db.exec("COMMIT");
    return [{ ...first, pair: second.id }, second];
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const amountOf = (v: unknown) => Math.round(Number(v) * 1000) / 1000;
const statementOf = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 200);

// Checks the line and saves it; returns an error in Arabic for the screen, or the saved row.
export function addCash(
  input: { account?: unknown; direction?: unknown; amount?: unknown; kind?: unknown; statement?: unknown; note?: unknown },
  by: Role,
): CashRow | string {
  const account = input.account === undefined ? "cash" : accountOf(input.account);
  if (!account) return "اختار الصندوق أو البنك";
  const direction = input.direction === "in" || input.direction === "out" ? input.direction : undefined;
  if (!direction) return "اختار استلمت أو دفعت";
  const amount = amountOf(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return "اكتب المبلغ صح";
  const kind = String(input.kind ?? "");
  if (!(CASH_KINDS[account][direction] as readonly string[]).includes(kind)) return "اختار النوع";
  const statement = statementOf(input.statement);
  if (statement.length < 2) return direction === "in" ? "اكتب البيان: من مين وعن شو" : "اكتب البيان: وين انصرفت";
  const note = String(input.note ?? "").trim().slice(0, 500);
  // A double tap on a slow connection: the same line again within half a minute is saved once.
  const twin = db
    .prepare("SELECT id FROM staff_cash WHERE account = ? AND direction = ? AND amount = ? AND kind = ? AND statement = ? AND note = ? AND by_role = ? AND at > ?")
    .get(account, direction, amount, kind, statement, note, by, Date.now() - 30_000);
  if (twin) return "هالحركة انسجلت هلق، شوفها بالسجل";
  return insert({ account, direction, amount, kind, statement, note, undoes: null }, by);
}

// He put cash from his box into the bank (to 'bank') or took it out of the bank into his box (to 'cash'):
// one line out of one account and one into the other; neither is money that came in or went out.
export function moveCash(input: { to?: unknown; amount?: unknown; note?: unknown }, by: Role): [CashRow, CashRow] | string {
  const to = accountOf(input.to);
  if (!to) return "اختار إيداع بالبنك أو سحب من البنك";
  const amount = amountOf(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return "اكتب المبلغ صح";
  const note = String(input.note ?? "").trim().slice(0, 500);
  const from: Account = to === "bank" ? "cash" : "bank";
  const kinds = to === "bank" ? MOVE.toBank : MOVE.toCash;
  const twin = db
    .prepare("SELECT id FROM staff_cash WHERE account = ? AND direction = 'out' AND amount = ? AND kind = ? AND by_role = ? AND at > ?")
    .get(from, amount, kinds[from], by, Date.now() - 30_000);
  if (twin) return "هالحركة انسجلت هلق، شوفها بالسجل";
  const statement = to === "bank" ? "إيداع من الصندوق بالبنك" : "سحب من البنك للصندوق";
  const lines = insertPair(
    { account: from, direction: "out", amount, kind: kinds[from], statement, note, undoes: null },
    { account: to, direction: "in", amount, kind: kinds[to], statement, note, undoes: null },
    by,
  );
  if (by === "staff") {
    notify(
      "staff",
      `🔁 <b>موظف ليبيا ${to === "bank" ? "أودع بالبنك" : "سحب من البنك"}</b> ${dinars(amount)}${note ? `
${esc(note)}` : ""}
معو: <b>${dinars(cashBalance("cash"))}</b> · بالبنك: <b>${dinars(cashBalance("bank"))}</b>`,
    );
  }
  return lines;
}

// The opening line of an account still in force (undoing it with «اعكسها» lets the count be made again).
export function openingCash(account: Account = "cash"): CashRow | undefined {
  return db
    .prepare(`${SELECT_CASH} WHERE c.account = ? AND c.kind = ? AND c.undoes IS NULL AND NOT EXISTS (SELECT 1 FROM staff_cash u WHERE u.undoes = c.id)`)
    .get(account, OPENING) as CashRow | undefined;
}

// The money he holds (or has in the bank) when the log starts (0 is fine).
export function setOpeningCash(input: { amount?: unknown; account?: unknown }, by: Role): CashRow | string {
  const account = input.account === undefined ? "cash" : accountOf(input.account);
  if (!account) return "اختار الصندوق أو البنك";
  if (openingCash(account)) return `الجرد الافتتاحي ${account === "bank" ? "للبنك" : "للمصاري"} انسجل قبل. إذا فيه غلط، اعكسو من السجل وسجّلو من جديد`;
  const amount = amountOf(input.amount);
  if (input.amount === "" || input.amount === null || input.amount === undefined || !Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    return "اكتب المبلغ صح";
  }
  const statement = account === "bank" ? "الجرد الافتتاحي: المصاري يلي كانت بحسابو بالبنك" : "الجرد الافتتاحي: المصاري يلي كانت معو";
  return insert({ account, direction: "in", amount, kind: OPENING, statement, note: "", undoes: null }, by);
}

// Cancels a line with the opposite one (kind «تصحيح»), never by deleting it. Money moved between his box and his
// bank is undone on both sides at once.
export function undoCash(id: number, by: Role): CashRow | string {
  const row = db.prepare(`${SELECT_CASH} WHERE c.id = ?`).get(id) as CashRow | undefined;
  if (!row) return "الحركة مو موجودة";
  if (by === "staff" && row.byRole !== "staff") return "هاي الحركة سجّلتها الإدارة، بس هي بتعكسها";
  if (row.undoes !== null) return "هاي حركة تصحيح، ما بتنعكس";
  if (row.undoneBy !== null) return "هالحركة انعكست قبل";
  const back = (r: CashRow): Line => {
    const what = r.statement || r.note;
    return {
      account: r.account,
      direction: r.direction === "in" ? "out" : "in",
      amount: r.amount,
      kind: "تصحيح",
      statement: `عكس «${r.kind}» ${dinars(r.amount)}${what ? `: ${what}` : ""}`.slice(0, 200),
      note: "",
      undoes: r.id,
    };
  };
  if (row.pair !== null) {
    const other = db.prepare(`${SELECT_CASH} WHERE c.id = ?`).get(row.pair) as CashRow | undefined;
    if (other && other.undoneBy === null) return insertPair(back(row), back(other), by)[0];
  }
  return insert(back(row), by);
}

// --- His stock ---------------------------------------------------------------------

export type StaffStockRow = { product: string; color: string; size: string; quantity: number; updatedAt: number };
export type StaffStockLogRow = {
  id: number;
  product: string;
  color: string;
  size: string;
  before: number | null;
  after: number | null;
  byRole: Role;
  at: number;
  reason: string;
};

export function listStaffStock(): StaffStockRow[] {
  return db
    .prepare("SELECT product, color, size, quantity, updated_at AS updatedAt FROM staff_stock ORDER BY product, color, rowid")
    .all() as StaffStockRow[];
}

export function staffStockLog(limit: number): StaffStockLogRow[] {
  return db
    .prepare(`SELECT id, product, color, size, qty_before AS "before", qty_after AS "after", by_role AS byRole, at, reason FROM staff_stock_log ORDER BY at DESC, id DESC LIMIT ?`)
    .all(limit) as StaffStockLogRow[];
}

const clean = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

function logChange(product: string, color: string, size: string, before: number | null, after: number | null, by: Role, at: number, reason = "") {
  db.prepare("INSERT INTO staff_stock_log (product, color, size, qty_before, qty_after, by_role, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    product,
    color,
    size,
    before,
    after,
    by,
    at,
    reason,
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

// --- The opening count of his stock ------------------------------------------------------

export type OpeningItem = { product: string; color: string; size: string; quantity: number };
export type OpeningStock = { at: number; byRole: Role; items: OpeningItem[] };

// What he had when the log started, as counted (later − / + don't change it).
export function openingStock(): OpeningStock | undefined {
  const head = db.prepare("SELECT at, by_role AS byRole FROM staff_opening WHERE part = 'stock'").get() as { at: number; byRole: Role } | undefined;
  if (!head) return;
  const items = db
    .prepare("SELECT product, color, size, qty_after AS quantity FROM staff_stock_log WHERE reason = 'opening' ORDER BY id")
    .all() as OpeningItem[];
  return { at: head.at, byRole: head.byRole, items };
}

// Saves the whole count at once (all or nothing), once. A cell already there takes the counted number.
export function setOpeningStock(input: { items?: unknown }, by: Role): OpeningStock | string {
  if (openingStock()) return "الجرد الافتتاحي للمخزون انسجل قبل. غيّر الأعداد بـ − و + من المخزون";
  const raw = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : [];
  const cells = new Map<string, OpeningItem>();
  for (const item of raw) {
    const product = clean(item?.product);
    const color = clean(item?.color);
    const size = clean(item?.size) || "ستاندرد";
    const quantity = Number(item?.quantity);
    if (!product || !color) return "كل سطر بدو منتج ولون";
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100_000) return `العدد لازم يكون رقم صحيح (${product} ${color} ${size})`;
    cells.set(`${product}|${color}|${size}`, { product, color, size, quantity });
  }
  // No items is a count too: he holds no stock yet.
  if (cells.size > 2000) return "كتير أسطر";
  const at = Date.now();
  db.exec("BEGIN");
  try {
    for (const c of cells.values()) {
      const before = current(c.product, c.color, c.size);
      db.prepare(
        "INSERT INTO staff_stock (product, color, size, quantity, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (product, color, size) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at",
      ).run(c.product, c.color, c.size, c.quantity, at);
      logChange(c.product, c.color, c.size, before, c.quantity, by, at, "opening");
    }
    db.prepare("INSERT INTO staff_opening (part, at, by_role) VALUES ('stock', ?, ?)").run(at, by);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const pieces = [...cells.values()].reduce((n, c) => n + c.quantity, 0);
  if (by === "staff") {
    notify("staff", `📋 <b>موظف ليبيا: الجرد الافتتاحي للمخزون</b>
${cells.size} سطر · <b>${pieces} قطعة</b>`);
  }
  return openingStock()!;
}
