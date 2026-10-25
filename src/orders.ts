// Text forms of an order the AI collected, for the team (logs, Chatwoot notes).
import type { CollectedOrder } from "./agent.js";
import { customerLabel, dashboardLink, esc, notify } from "./telegram.js";

export function orderItemsText(order: CollectedOrder): string {
  return order.items
    .map((i) => [`${i.quantity} ×`, i.product, i.color, i.size && `مقاس ${i.size}`].filter(Boolean).join(" "))
    .join("، ");
}

// One line, e.g. for the activity log and handoff reasons.
export function orderOneLine(order: CollectedOrder): string {
  return `${order.name} · ${order.phone} · ${order.city} ${order.address} · ${orderItemsText(order)} · ${order.total}`;
}

// The team's usual order format, for a Chatwoot private note.
export function orderNote(id: number, order: CollectedOrder): string {
  return [
    `🧾 طلب جديد #${id} (جمعه المساعد، لازم تأكيد)`,
    `الاسم: ${order.name}`,
    `الرقم: ${order.phone}`,
    `العنوان: ${order.city} - ${order.address}`,
    `الطلب: ${orderItemsText(order)}`,
    `الاجمالي: ${order.total}`,
    ...(order.notes ? [`ملاحظات: ${order.notes}`] : []),
  ].join("\n");
}

// Telegram: new order for the team to confirm.
// byTeam: the team recorded it from the dashboard (already agreed with the customer).
export function notifyOrder(id: number, customer: string, order: CollectedOrder, byTeam = false) {
  const link = customer.startsWith("cw:") ? "" : dashboardLink(`/inbox/${customer}`, "فتح المحادثة");
  notify(
    "order",
    [
      byTeam ? `🛍 <b>طلب جديد #${id}</b> (سجّلو الفريق من اللوحة)` : `🛍 <b>طلب جديد #${id}</b> (جمعه المساعد، بدو تأكيد)`,
      `الاسم: ${esc(order.name)}`,
      `الرقم: <code>${esc(order.phone)}</code>`,
      `العنوان: ${esc(order.city)} - ${esc(order.address)}`,
      `الطلب: ${esc(orderItemsText(order))}`,
      `الاجمالي: <b>${esc(order.total)}</b>`,
      ...(order.notes ? [`ملاحظات: ${esc(order.notes)}`] : []),
      `${esc(customerLabel(customer))} ${link}`,
    ].join("\n"),
  );
}

// Telegram: the AI didn't know the answer (or the customer needs a person).
// learns: the AI didn't know, so it will learn from what the team writes back (learning.ts).
export function notifyHandoff(customer: string, reason: string, learns = false) {
  const link = customer.startsWith("cw:") ? "" : dashboardLink(`/inbox/${customer}`, "فتح المحادثة");
  const hint = learns ? "\n📚 ردو عليه بالواتساب متل العادة، والمساعد بيتعلم من جوابكن (بعد موافقتكن)." : "";
  notify("handoff", `🙋 <b>زبون بدو حدا من الفريق</b>\n${esc(customerLabel(customer))}\nالسبب: ${esc(reason)}${hint}\n${link}`);
}
