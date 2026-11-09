// The blacklist: customers whose orders came back or were cancelled through their own doing (didn't answer the courier,
// changed their mind). The AI doesn't answer a blacklisted customer and tells the team instead; the team decides.
// Candidates are suggested from Darb's courier notes; a return caused by size or specs is never the customer's fault.
import { db } from "./store.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS blacklist (
    customer    TEXT PRIMARY KEY,
    reason      TEXT NOT NULL DEFAULT '',
    added_at    INTEGER NOT NULL,
    notified_at INTEGER           -- when the customer was sent the message
  );
`);

export function isBlacklisted(customer: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM blacklist WHERE customer = ?").get(customer));
}

export function addToBlacklist(customer: string, reason = "") {
  db.prepare("INSERT INTO blacklist (customer, reason, added_at) VALUES (?, ?, ?) ON CONFLICT (customer) DO UPDATE SET reason = excluded.reason")
    .run(customer, reason.trim().slice(0, 300), Date.now());
}

export function removeFromBlacklist(customer: string) {
  db.prepare("DELETE FROM blacklist WHERE customer = ?").run(customer);
}

export function markNotified(customer: string) {
  db.prepare("UPDATE blacklist SET notified_at = ? WHERE customer = ?").run(Date.now(), customer);
}

// The message to a blacklisted customer, in Libyan.
export function blacklistMessage(name: string): string {
  const hello = name.trim() ? `السلام عليكم ${name.trim()}` : "السلام عليكم";
  return `${hello}،
بخصوص طلبك من شركة الثوب العربي: الطلبية اتلغات وراجعت لعنا، وحبينا نسألك شن صار؟
الطلبات اللي ترجع تكلفنا شحن وتجهيز وتعب، وكان الواضح إنك غير جاد في الطلب، عشان هكي تم تحويلك للقائمة السوداء وما نقدروش نقبلو منك طلبات جديدة.
وإن كان عندك ظرف أو سبب ثاني، ردلنا وإن شاء الله نراجعو الموضوع.`;
}

export type BlacklistRow = { customer: string; name: string; reason: string; addedAt: number; notifiedAt: number | null };

export function listBlacklist(): BlacklistRow[] {
  const rows = db
    .prepare(
      `SELECT b.customer, b.reason, b.added_at AS addedAt, b.notified_at AS notifiedAt,
              COALESCE((SELECT o.name FROM orders o WHERE o.customer = b.customer ORDER BY o.id DESC LIMIT 1),
                       (SELECT c.wa_name FROM customers c WHERE c.customer = b.customer), '') AS name
       FROM blacklist b ORDER BY b.added_at DESC`,
    )
    .all() as BlacklistRow[];
  return rows;
}

// Courier notes that say the customer is the cause, and the ones that say it isn't (size, specs, a swap).
const CUSTOMER_FAULT = /no response|no longer needed|لغيت|الغاء|إلغاء|ما عاد|مقفل|لا يرد|لم يرد|مردش|ما يردش|عدم (?:وجود )?رد|لا يوجد رد|عدم الرد|مش موجود|خارج/i;
const NOT_THEIR_FAULT = /specs|مقاس|المقاس|ليس المطلوب|مواصفات|replacement|استبدال|غير مناسب/i;

export type Candidate = {
  customer: string;
  name: string;
  phone: string;
  city: string;
  reason: string;
  orderId: number;
  amount: number;
  status: string;
};

// Customers with a returned/cancelled shipment for a reason that is theirs, no delivered order, not on the list yet.
export function blacklistCandidates(): Candidate[] {
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.customer, o.name, o.phone, o.city, d.status, d.amount, d.timeline
       FROM orders o JOIN darb_shipments d ON d.id = o.darb_id
       WHERE d.status IN ('released','returning','returned','cancelled')
         AND o.customer NOT IN (SELECT customer FROM blacklist)
         AND o.customer NOT IN (SELECT o2.customer FROM orders o2 JOIN darb_shipments d2 ON d2.id = o2.darb_id WHERE d2.status = 'completed')
       ORDER BY o.id DESC`,
    )
    .all() as (Candidate & { timeline: string })[];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (seen.has(r.customer)) continue;
    let notes: string[] = [];
    try {
      notes = (JSON.parse(r.timeline) as { type: string; remarks?: string }[])
        .filter((t) => ["cancelled", "delayed"].includes(t.type) && t.remarks)
        .map((t) => String(t.remarks).trim());
    } catch {
      /* a broken timeline is just no notes */
    }
    if (notes.some((n) => NOT_THEIR_FAULT.test(n))) continue;
    const why = notes.filter((n) => CUSTOMER_FAULT.test(n));
    if (why.length === 0) continue;
    seen.add(r.customer);
    out.push({ customer: r.customer, name: r.name, phone: r.phone, city: r.city, reason: why[why.length - 1]!, orderId: r.orderId, amount: r.amount, status: r.status });
  }
  return out;
}

// One alert per blacklisted customer per hour when they write, so the team sees it (the AI stays out).
const alerted = new Map<string, number>();
export function shouldAlert(customer: string): boolean {
  const last = alerted.get(customer) ?? 0;
  if (Date.now() - last < 60 * 60 * 1000) return false;
  alerted.set(customer, Date.now());
  return true;
}
