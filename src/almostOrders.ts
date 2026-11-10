// Customers who got the order summary but no order was saved after it: the customer answered something other than a
// clear yes («تمم 56», «شكرا على حسن المعاملة», 👍 on «نثبتلك؟», "when my salary comes"), the assistant asked again and
// the chat stopped. Nobody saw them: they aren't orders and the chat isn't with the team. The home page lists them,
// and Telegram tells the team once about each one (answered, or quiet for 45 minutes), and about customers who sent
// their phone number but never got to the summary.
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

// Telegram, once per summary, for the sales team to call: no order came of it and the team hasn't written since.
// - the customer answered it (words or a reaction) at least 20 minutes ago;
// - or they went quiet on it for 45 minutes: two customers who had given name, phone and address never answered
//   «نثبّتلك؟» and nobody called them (Nov 2026).
// Within a day of the summary: older ones are on the home page only.
const QUIET_MS = 45 * 60 * 1000;

export function checkAlmostOrders() {
  const now = Date.now();
  const seen = db.prepare("SELECT 1 FROM almost_orders WHERE customer = ? AND summary_at = ? AND notified_at IS NOT NULL");
  const mark = db.prepare(
    `INSERT INTO almost_orders (customer, summary_at, notified_at) VALUES (?, ?, ?)
     ON CONFLICT (customer, summary_at) DO UPDATE SET notified_at = excluded.notified_at`,
  );
  for (const a of almostOrders(1)) {
    if (a.teamWrote || seen.get(a.customer, a.summaryAt)) continue;
    const quiet = !a.answered;
    if (quiet ? now - a.summaryAt < QUIET_MS : !a.lastAt || now - a.lastAt < 20 * 60 * 1000) continue;
    mark.run(a.customer, a.summaryAt, now);
    log(`wa:${a.customer}`, `got the order summary, ${quiet ? "went quiet" : "answered"}, and no order was saved: the team is told`);
    const link = a.customer.startsWith("cw:") ? "" : dashboardLink(`/inbox/${a.customer}`, "فتح المحادثة");
    void notify(
      "order",
      [
        quiet ? "📞 <b>زبون بعت كل معلوماته وسكت عند «نثبّتلك؟»</b>" : "🟠 <b>زبون وصل لملخص الطلب وما انحفظ طلب</b>",
        esc(customerLabel(a.customer)),
        esc([a.name, a.address, a.item, a.total].filter(Boolean).join(" · ")),
        quiet ? "ما رد على سؤال التثبيت. اتصلوا فيه وأكدوا، وإذا موافق سجّلوا الطلب." : `آخر شي كتبو: «${esc(a.lastText.replace(/\s+/g, " ").slice(0, 160))}»`,
        quiet ? "" : "شوفوا المحادثة: إذا موافق سجّلوا الطلب، وإذا لأ اضغطوا «مش طلب» بصفحة اليوم.",
        link,
      ]
        .filter(Boolean)
        .join("\n"),
    ).catch(() => {});
  }
  checkPhonesWithoutOrder(now, seen, mark);
}

// A Libyan mobile in what the customer wrote: 09[1-5] and 7 digits, or +218 9…, Arabic digits and spaces allowed.
export function libyanMobileIn(text: string): string | undefined {
  const plain = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/(?<=\d)[\s-](?=\d)/g, "");
  const m = plain.match(/(?<!\d)(?:\+?218|00218|0)(9[1-5]\d{7})(?!\d)/);
  return m ? `0${m[1]}` : undefined;
}

// The customer sent their phone number (often with their name and town) but never got to the summary: the assistant
// asked something else again and they stopped. Once per chat a day, 45 minutes after, when no order or summary came.
type Statement = ReturnType<typeof db.prepare>;
function checkPhonesWithoutOrder(now: number, seen: Statement, mark: Statement) {
  const rows = db
    .prepare(
      `SELECT m.customer, m.text, m.created_at AS at FROM messages m
       WHERE m.role = 'customer' AND m.history = 0 AND m.created_at > ? AND m.created_at < ? AND m.customer NOT LIKE 'cw:%'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer = m.customer AND o.created_at > ?)
         AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.customer = m.customer AND s.history = 0 AND s.created_at > m.created_at - 600000
                         AND (s.source = 'staff' OR (s.source = 'ai' AND s.text LIKE '%الإجمالي%' AND s.text LIKE '%الاسم%')))
       ORDER BY m.id`,
    )
    .all(now - DAY, now - QUIET_MS, now - 14 * DAY) as { customer: string; text: string; at: number }[];
  const told = new Set<string>();
  for (const r of rows) {
    if (told.has(r.customer)) continue;
    const phone = libyanMobileIn(r.text);
    if (!phone) continue;
    told.add(r.customer);
    const day = Math.floor(r.at / DAY) * DAY; // one alert per chat a day
    if (seen.get(r.customer, -day)) continue;
    // The customer may still be writing: wait until they've been quiet for a while.
    const after = db
      .prepare("SELECT MAX(created_at) AS at FROM messages WHERE customer = ? AND history = 0 AND role = 'customer'")
      .get(r.customer) as { at: number };
    if (now - after.at < QUIET_MS) continue;
    mark.run(r.customer, -day, now);
    log(`wa:${r.customer}`, "sent a phone number, no summary or order came of it: the team is told");
    void notify(
      "order",
      [
        "📞 <b>زبون بعت رقمه وما انسجّل طلب</b>",
        esc(customerLabel(r.customer)),
        `الرقم اللي بعتو: ${esc(phone)} · «${esc(r.text.replace(/\s+/g, " ").slice(0, 120))}»`,
        "ما وصل لملخص الطلب. اتصلوا فيه وكمّلوا الطلب.",
        dashboardLink(`/inbox/${r.customer}`, "فتح المحادثة"),
      ].join("\n"),
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
