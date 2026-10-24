// Text forms of an order the AI collected, for the team (logs, Chatwoot notes).
import type { CollectedOrder } from "./agent.js";

export function orderItemsText(order: CollectedOrder): string {
  return order.items.map((i) => `${i.quantity} × ${i.color} مقاس ${i.size}`).join("، ");
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
