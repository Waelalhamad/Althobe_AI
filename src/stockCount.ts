// The Libya warehouse count (جرد): the warehouse keeper counts our stock (the `stock` table the assistant sells from)
// without seeing its numbers, and sends it. Nothing changes until the team approves it: then each counted cell
// moves by (counted − what the system had when he sent it), so orders saved in between stay counted.
// He can't add, rename or delete anything: a piece missing from the list is a free-text line or the note, never a product.
import crypto from "node:crypto";
import { listCatalog } from "./catalog.js";
import { saveFile } from "./media.js";
import { db, listStock, stockName } from "./store.js";
import { esc, notify } from "./telegram.js";
import type { Role } from "./staff.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS stock_counts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    by_role     TEXT    NOT NULL,
    status      TEXT    NOT NULL,          -- 'pending' | 'approved' | 'rejected'
    cells       TEXT    NOT NULL,          -- JSON CountCell[]: every stock cell when sent, with the system's number then
    extras      TEXT    NOT NULL,          -- JSON CountExtra[]: pieces he found that aren't on the list
    note        TEXT    NOT NULL,
    photos      TEXT    NOT NULL,          -- JSON ["media/…jpg"]
    decided_at  INTEGER,
    reason      TEXT    NOT NULL DEFAULT '' -- why the team rejected it
  );
`);

export type CountCell = { product: string; color: string; size: string; system: number; counted: number | null };
export type CountExtra = { product: string; color: string; size: string; quantity: number | null };
export type StockCount = {
  id: number;
  at: number;
  byRole: Role;
  status: "pending" | "approved" | "rejected";
  cells: CountCell[];
  extras: CountExtra[];
  note: string;
  photos: string[];
  decidedAt: number | null;
  reason: string;
};

// What he sees: every product, color and size we keep, with the color's photos and the product's description. No numbers.
export type SheetColor = { color: string; photos: string[]; sizes: string[] };
export type SheetProduct = { product: string; about: string; colors: SheetColor[] };

export function countSheet(): SheetProduct[] {
  const catalog = listCatalog();
  const products: SheetProduct[] = [];
  for (const r of listStock()) {
    let p = products.find((x) => x.product === r.product);
    if (!p) {
      const first = catalog.find((c) => c.product && stockName(c.product) === stockName(r.product) && c.description.trim());
      p = { product: r.product, about: first ? first.description.split("\n")[0]!.trim().slice(0, 160) : "", colors: [] };
      products.push(p);
    }
    let c = p.colors.find((x) => x.color === r.color);
    if (!c) {
      const photos = catalog
        .filter((i) => i.product && stockName(i.product) === stockName(r.product) && stockName(i.name) === stockName(r.color))
        .map((i) => i.file)
        .slice(0, 4);
      c = { color: r.color, photos, sizes: [] };
      p.colors.push(c);
    }
    c.sizes.push(r.size);
  }
  // Sizes in their natural order (56, 58, 60…), the text ones («ستاندرد») last.
  for (const p of products) for (const c of p.colors) c.sizes.sort((a, b) => (Number(a) || Infinity) - (Number(b) || Infinity) || a.localeCompare(b));
  return products;
}

type Raw = { id: number; at: number; by_role: Role; status: StockCount["status"]; cells: string; extras: string; note: string; photos: string; decided_at: number | null; reason: string };
const parse = (r: Raw): StockCount => ({
  id: r.id,
  at: r.at,
  byRole: r.by_role,
  status: r.status,
  cells: JSON.parse(r.cells) as CountCell[],
  extras: JSON.parse(r.extras) as CountExtra[],
  note: r.note,
  photos: JSON.parse(r.photos) as string[],
  decidedAt: r.decided_at,
  reason: r.reason,
});

export function listCounts(limit = 20): StockCount[] {
  return (db.prepare("SELECT * FROM stock_counts ORDER BY id DESC LIMIT ?").all(limit) as Raw[]).map(parse);
}

function getCount(id: number): StockCount | undefined {
  const r = db.prepare("SELECT * FROM stock_counts WHERE id = ?").get(id) as Raw | undefined;
  return r ? parse(r) : undefined;
}

// For his phone: whether a count is waiting for the team, and how the last one ended. Never the system's numbers.
export function countStatus() {
  const last = listCounts(1)[0];
  return last ? { id: last.id, at: last.at, status: last.status, decidedAt: last.decidedAt, reason: last.reason } : null;
}

const text = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const count = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : undefined;
};

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// He sends the count. Every cell must be one of ours; a blank one is "not counted". Returns an error in Arabic, or the id.
export function submitCount(
  input: { counts?: unknown; extras?: unknown; note?: unknown; photos?: unknown },
  by: Role,
): { id: number } | string {
  if (db.prepare("SELECT 1 FROM stock_counts WHERE status = 'pending'").get()) return "في جرد مبعوت لسا ما راجعتو الإدارة. استنى ردّها";
  const stock = listStock();
  const key = (p: string, c: string, s: string) => `${p}|${c}|${s}`;
  const given = new Map<string, number | null>();
  for (const item of (Array.isArray(input.counts) ? input.counts : []) as Record<string, unknown>[]) {
    const k = key(String(item?.product ?? ""), String(item?.color ?? ""), String(item?.size ?? ""));
    if (!stock.some((r) => key(r.product, r.color, r.size) === k)) return "في سطر مو من القائمة. حدّث الصفحة وجرّب مرة تانية";
    const n = count(item?.counted);
    if (n === undefined) return `العدد لازم يكون رقم صحيح (${text(item?.product, 60)} ${text(item?.color, 30)} ${text(item?.size, 20)})`;
    given.set(k, n);
  }
  const extras: CountExtra[] = [];
  for (const e of ((Array.isArray(input.extras) ? input.extras : []) as Record<string, unknown>[]).slice(0, 50)) {
    const line = { product: text(e?.product, 80), color: text(e?.color, 60), size: text(e?.size, 30), quantity: count(e?.quantity) ?? null };
    if (line.color || line.size) extras.push(line);
  }
  const note = String(input.note ?? "").trim().slice(0, 3000);
  const photos: string[] = [];
  for (const p of ((Array.isArray(input.photos) ? input.photos : []) as unknown[]).slice(0, 4)) {
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(String(p ?? ""));
    if (!m || !PHOTO_TYPES.includes(m[1]!)) return "الصورة لازم تكون jpg أو png";
    const data = Buffer.from(m[2]!, "base64");
    if (data.length > 4 * 1024 * 1024) return "الصورة كبيرة كتير";
    photos.push(saveFile("media", `count-${crypto.randomBytes(12).toString("hex")}`, data, m[1]!));
  }
  const counted = [...given.values()].filter((n) => n !== null).length;
  if (!counted && !extras.length && !note) return "ما في ولا عدد مكتوب";

  const cells: CountCell[] = stock.map((r) => ({
    product: r.product,
    color: r.color,
    size: r.size,
    system: r.quantity,
    counted: given.get(key(r.product, r.color, r.size)) ?? null,
  }));
  const at = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO stock_counts (at, by_role, status, cells, extras, note, photos) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
      .run(at, by, JSON.stringify(cells), JSON.stringify(extras), note, JSON.stringify(photos)).lastInsertRowid,
  );
  const differ = cells.filter((c) => c.counted !== null && c.counted !== c.system).length;
  notify(
    "staff",
    `📋 <b>جرد مستودع ليبيا وصل</b>
انعدّ ${counted} من ${cells.length} خانة · <b>${differ}</b> فيها فرق${extras.length ? ` · ${extras.length} قطعة مش بالقائمة` : ""}${note ? `
📝 ${esc(note.slice(0, 300))}` : ""}
راجعو واعتمدو من اللوحة (موظف ليبيا ← الجرد).`,
  );
  return { id };
}

// The team approves: each counted cell still in stock moves by (counted − system when sent). Returns the cells changed.
export function approveCount(id: number): { changed: number } | string {
  const c = getCount(id);
  if (!c) return "الجرد مو موجود";
  if (c.status !== "pending") return "هالجرد انراجع قبل";
  let changed = 0;
  const at = Date.now();
  db.exec("BEGIN");
  try {
    const update = db.prepare("UPDATE stock SET quantity = quantity + ?, updated_at = ? WHERE product = ? AND color = ? AND size = ?");
    for (const cell of c.cells) {
      if (cell.counted === null || cell.counted === cell.system) continue;
      changed += Number(update.run(cell.counted - cell.system, at, cell.product, cell.color, cell.size).changes);
    }
    db.prepare("UPDATE stock_counts SET status = 'approved', decided_at = ? WHERE id = ?").run(at, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { changed };
}

export function rejectCount(id: number, reason: unknown): true | string {
  const c = getCount(id);
  if (!c) return "الجرد مو موجود";
  if (c.status !== "pending") return "هالجرد انراجع قبل";
  db.prepare("UPDATE stock_counts SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ?").run(Date.now(), text(reason, 300), id);
  return true;
}
