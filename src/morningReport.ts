import { db, getSetting, setSetting } from "./store.js";
import { log } from "./scheduler.js";
import { localDay } from "./dashboard/queries.js";
import { dashboardLink, esc, notify } from "./telegram.js";

// Every morning, what is stuck on the way to the customer, so no order is forgotten: orders waiting for the
// team's confirmation, confirmed ones not sent to Darb, and shipments Darb reports late or coming back.
export const MORNING_HOUR = 11;
const WAITING_HOURS = 6;
const MAX_LINES = 15;
const HOUR = 60 * 60 * 1000;

type Row = { id: number; customer: string; name: string; city: string; created_at: number; darb_ref: string | null };

function line(o: Row): string {
  const hours = Math.round((Date.now() - o.created_at) / HOUR);
  const age = hours >= 48 ? `${Math.round(hours / 24)} يوم` : `${hours} س`;
  const link = o.customer.startsWith("cw:") ? "" : ` ${dashboardLink(`/inbox/${o.customer}`, "المحادثة")}`;
  return `• #${o.id} ${esc(o.name)} · ${esc(o.city)} · ${age}${o.darb_ref ? ` · <code>${esc(o.darb_ref)}</code>` : ""}${link}`;
}

function section(title: string, rows: Row[]): string[] {
  if (!rows.length) return [];
  const more = rows.length > MAX_LINES ? [`… و${rows.length - MAX_LINES} كمان`] : [];
  return ["", `<b>${title} (${rows.length})</b>`, ...rows.slice(0, MAX_LINES).map(line), ...more];
}

const select = (where: string, ...params: number[]) =>
  db
    .prepare(`SELECT id, customer, name, city, created_at, darb_ref FROM orders WHERE ${where} ORDER BY created_at`)
    .all(...params) as Row[];

export function morningReport(): string {
  const parts = [
    ...section(`🕐 ناطرة تأكيد أكتر من ${WAITING_HOURS} ساعات`, select("status = 'new' AND created_at < ?", Date.now() - WAITING_HOURS * HOUR)),
    ...section("📦 مؤكدة وما انبعتت لدرب", select("status = 'confirmed' AND (darb_ref IS NULL OR darb_ref = '')")),
    ...section("⏳ متأخرة عند درب", select("status IN ('new', 'confirmed') AND darb_status = 'delayed'")),
    ...section("↩️ راجعة أو ملغية عند درب", select("status != 'cancelled' AND darb_status IN ('returning', 'cancelled')")),
    ...section("⚠️ ملغية عنا وانسلّمت عند درب", select("status = 'cancelled' AND darb_status = 'completed'")),
  ];
  return parts.length ? `☀️ <b>شو واقف اليوم</b>\n${parts.join("\n")}` : "☀️ <b>شو واقف اليوم</b>\n✅ ما في شي واقف.";
}

// Once a day at MORNING_HOUR (dashboard time), checked by the supervisor's 5-minute tick.
export async function maybeSendMorningReport(localHour: number) {
  const today = localDay(Date.now());
  if (localHour !== MORNING_HOUR || getSetting("morning_report_day") === today) return;
  setSetting("morning_report_day", today);
  await notify("report", morningReport());
  log("orders", "morning report sent");
}
