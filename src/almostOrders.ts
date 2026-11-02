// Customers who got the order summary but no order was saved after it: the customer answered something other than a
// clear yes («تمم 56», «شكرا على حسن المعاملة», 👍 on «نثبتلك؟», "when my salary comes"), the assistant asked again and
// the chat stopped. Nobody saw them: they aren't orders and the chat isn't with the team. The home page lists them,
// and Telegram tells the team once about each one the customer answered.
import { db } from "./store.js";
import { customerLabel, dashboardLink, esc, notify } from "./telegram.js";
import { log } from "./scheduler.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS almost_orders (
    customer     TEXT    NOT NULL,
    summary_at   INTEGER NOT NULL,          -- the summary message this is about
    notified_at  INTEGER,                   -- Telegram told the team
    dismissed_at INTEGER,                   -- the team said it's not an order
    PRIMARY KEY (customer, summary_at)
  );
`);

const DAY = 24 * 60 * 60 * 1000;

export type AlmostOrder = {
  customer: string;
  summaryAt: number;
  name: string;
  address: string;
  item: string; // "بني · 60"
  total: string;
  // What the customer did after the summary: their last message (a reaction reads "[sent a reaction 👍 …]").
  answered: number; // how many messages
  lastText: string;
  lastAt: number | null;
  teamWrote: boolean; // someone of the team wrote after the summary
};

// A line of the summary («الاسم: …»).
function field(summary: string, key: string): string {
  return summary.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
}

// The latest summary per customer in the last `days`, with no order saved since (from 10 minutes before it: the order
// can be saved a moment before the summary's own row) and not dismissed. At least 15 minutes old: the customer may
// still be answering.
export function almostOrders(days = 7): AlmostOrder[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT m.customer, m.text, m.created_at AS at FROM messages m
       WHERE m.source = 'ai' AND m.history = 0 AND m.created_at > ? AND m.created_at < ?
         AND m.text LIKE '%الإجمالي%' AND m.text LIKE '%الاسم%'
         AND m.id = (SELECT MAX(s.id) FROM messages s WHERE s.customer = m.customer AND s.source = 'ai' AND s.history = 0
                     AND s.text LIKE '%الإجمالي%' AND s.text LIKE '%الاسم%')
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer = m.customer AND o.created_at > m.created_at - 600000)
         AND NOT EXISTS (SELECT 1 FROM almost_orders a WHERE a.customer = m.customer AND a.summary_at = m.created_at AND a.dismissed_at IS NOT NULL)
       ORDER BY m.created_at DESC`,
    )
    .all(now - days * DAY, now - 15 * 60 * 1000) as { customer: string; text: string; at: number }[];
  const after = db.prepare(
    `SELECT source, text, created_at AS at FROM messages WHERE customer = ? AND history = 0 AND created_at > ? AND source IN ('customer', 'staff')
     ORDER BY id`,
  );
  return rows.map((r) => {
    const next = after.all(r.customer, r.at) as { source: string; text: string; at: number }[];
    const theirs = next.filter((n) => n.source === "customer");
    const last = theirs.at(-1);
    return {
      customer: r.customer,
      summaryAt: r.at,
      name: field(r.text, "الاسم"),
      address: field(r.text, "العنوان"),
      item: [field(r.text, "اللون"), field(r.text, "المقاس")].filter(Boolean).join(" · "),
      total: field(r.text, "الإجمالي"),
      answered: theirs.length,
      lastText: last?.text ?? "",
      lastAt: last?.at ?? null,
      teamWrote: next.some((n) => n.source === "staff"),
    };
  });
}

export function dismissAlmostOrder(customer: string, summaryAt: number) {
  db.prepare(
    `INSERT INTO almost_orders (customer, summary_at, dismissed_at) VALUES (?, ?, ?)
     ON CONFLICT (customer, summary_at) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
  ).run(customer, summaryAt, Date.now());
}

// Telegram, once per summary: the customer answered it (words or a reaction) at least 20 minutes ago, no order came
// of it, and the team hasn't written since. Within a day of the summary: older ones are on the home page only.
export function checkAlmostOrders() {
  const now = Date.now();
  const seen = db.prepare("SELECT 1 FROM almost_orders WHERE customer = ? AND summary_at = ? AND notified_at IS NOT NULL");
  const mark = db.prepare(
    `INSERT INTO almost_orders (customer, summary_at, notified_at) VALUES (?, ?, ?)
     ON CONFLICT (customer, summary_at) DO UPDATE SET notified_at = excluded.notified_at`,
  );
  for (const a of almostOrders(1)) {
    if (!a.answered || a.teamWrote || !a.lastAt || now - a.lastAt < 20 * 60 * 1000 || seen.get(a.customer, a.summaryAt)) continue;
    mark.run(a.customer, a.summaryAt, now);
    log(`wa:${a.customer}`, "got the order summary, answered, and no order was saved: the team is told");
    const link = a.customer.startsWith("cw:") ? "" : dashboardLink(`/inbox/${a.customer}`, "فتح المحادثة");
    void notify(
      "order",
      [
        "🟠 <b>زبون وصل لملخص الطلب وما انحفظ طلب</b>",
        esc(customerLabel(a.customer)),
        esc([a.name, a.address, a.item, a.total].filter(Boolean).join(" · ")),
        `آخر شي كتبو: «${esc(a.lastText.replace(/\s+/g, " ").slice(0, 160))}»`,
        "شوفوا المحادثة: إذا موافق سجّلوا الطلب، وإذا لأ اضغطوا «مش طلب» بصفحة اليوم.",
        link,
      ]
        .filter(Boolean)
        .join("\n"),
    ).catch(() => {});
  }
}

export function startAlmostOrdersWatch() {
  setInterval(() => {
    try {
      checkAlmostOrders();
    } catch (err) {
      log("almost-orders", `check failed: ${(err as Error).message}`);
    }
  }, 10 * 60 * 1000).unref();
}
