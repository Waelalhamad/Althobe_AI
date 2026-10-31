import { addressGaps, libyanMobile, sizeForWeight, type CollectedOrder } from "./agent.js";
import { darbZones, guessZone } from "./darb.js";
import { missingStock } from "./stock.js";
import { db } from "./store.js";

// Most AI orders are complete and plain: the team only re-checks them. Those are confirmed at once; the team
// still sends them to Darb by hand. Returns why an order still needs the team (empty: confirm it).
export async function autoConfirmGaps(id: number, customer: string, order: CollectedOrder): Promise<string[]> {
  const gaps: string[] = [];
  if (!libyanMobile(order.phone)) gaps.push("الرقم مش رقم موبايل ليبي كامل");
  if (addressGaps(order).length) gaps.push("العنوان ناقص");
  if (order.payment === "transfer") gaps.push("الدفع تحويل، بدو تأكد من وصول المبلغ");

  const quantity = order.items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
  if (quantity > 3) gaps.push(`${quantity} أطقم`);
  if (order.items.some((i) => !String(i.color ?? "").trim() || !String(i.size ?? "").trim())) gaps.push("لون أو مقاس ناقص");
  if (missingStock(order.items).length) gaps.push("مش موجود بالمخزون");

  // The size must be the one the size table gives for the weight the customer said.
  if (!order.weightKg) gaps.push("ما في وزن");
  else {
    const fits = sizeForWeight(order.weightKg);
    if (!fits) gaps.push(`الوزن ${order.weightKg} كغ أكبر من جدول المقاسات`);
    else if (order.items.some((i) => String(i.size).trim() !== fits)) gaps.push(`الوزن ${order.weightKg} كغ بيجيه ${fits}، والمطلوب غيره`);
  }
  if (/مسؤولي|الفريق يحدد|الفريق يأكد|يتأكد/.test(order.notes)) gaps.push("بالملاحظات شي للفريق");

  const open = db
    .prepare("SELECT id FROM orders WHERE customer = ? AND id != ? AND status IN ('new', 'confirmed') AND created_at > ?")
    .get(customer, id, Date.now() - 14 * 24 * 60 * 60 * 1000) as { id: number } | undefined;
  if (open) gaps.push(`في طلب تاني مفتوح #${open.id}`);

  // Darb must know the place (a city with its area), or the team picks it anyway.
  if (!gaps.length) {
    const place = await darbZones()
      .then((zones) => guessZone(zones, order.city, order.address))
      .catch(() => undefined);
    if (!place?.area) gaps.push("المنطقة مش واضحة لدرب");
  }
  return gaps;
}
