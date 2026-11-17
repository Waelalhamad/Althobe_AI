// Stock for the AI and the team: what is left per color and size, so nobody sells what we don't have.
import { hasSizes, listClearance, listProductDetails, listStock, stockName, stockRowFor, whenStockRunsOut, type OrderItem, type StockRow } from "./store.js";
import { esc, notify } from "./telegram.js";

// Telegram: a color/size just ran out.
whenStockRunsOut((row) => {
  notify("order", `📦 <b>خلص</b>: ${esc(row.product)} · ${esc(row.color)} · مقاس ${esc(row.size)} (الباقي ${row.quantity}). حدّث المخزون من اللوحة إذا وصل جديد.`);
});

// A color with this many pieces or fewer (all sizes) is almost gone: the AI stops showing it first. In Nov 2026 the
// fur's silver had 3 pieces left and the AI kept sending its photo to every customer.
const FEW_LEFT = 3;

// What the team wrote about each product on the stock page (fabric, material…), above the knowledge documents.
function detailsForPrompt(): string {
  const all = listProductDetails();
  if (!all.length) return "";
  return `

# Product details from the team
What our team wrote about each product (its fabric, material, feel, season, care…). It is true, and above any line of the knowledge documents that says we don't know something about that product (like «لا نعرف عنه أكثر من اسمه»): when the customer asks, answer from it in a few words, proudly and in their dialect, then carry on selling. Bring a detail up yourself only where it helps (a price objection, «شن الخامة؟», «يدفّي؟»), one at a time, never the whole list. Never add anything that isn't written here or in the knowledge: if it isn't there, say «نتأكدلك استاذ».
${all.map((d) => `## ${d.product}\n${d.details}`).join("\n\n")}`;
}

// The prompt section: per product, each color with the sizes still available, after the team's product details.
// Empty when neither is kept.
export function stockForPrompt(): string {
  return detailsForPrompt() + stockTable();
}

function stockTable(): string {
  const rows = listStock();
  if (!rows.length) return "";
  const products = new Map<string, Map<string, StockRow[]>>();
  for (const r of rows) {
    const colors = products.get(r.product) ?? new Map<string, StockRow[]>();
    colors.set(r.color, [...(colors.get(r.color) ?? []), r]);
    products.set(r.product, colors);
  }
  const clearance = listClearance();
  let anyClearance = false;
  const lines: string[] = [];
  for (const [product, colors] of products) {
    const oneSize = !hasSizes(product, rows);
    lines.push(oneSize ? `${product} (ONE standard size: never ask a size for it, never use the size table; ask the weight only if its knowledge document says so; size "ستاندرد" in submit_order):` : `${product}:`);
    const offer = clearance.find((c) => stockName(c.product) === stockName(product));
    for (const [color, sizes] of colors) {
      const left = sizes.filter((s) => s.quantity > 0).map((s) => s.size);
      const out = sizes.filter((s) => s.quantity <= 0).map((s) => s.size);
      const pieces = sizes.reduce((n, s) => n + Math.max(0, s.quantity), 0);
      // Marked pieces still in stock.
      const onOffer = offer
        ? left.filter((size) => offer.cells.some((c) => stockName(c.color) === stockName(color) && stockName(c.size) === stockName(size)))
        : [];
      if (onOffer.length) anyClearance = true;
      lines.push(
        left.length
          ? `- ${color}: available in ${left.join(", ")}${out.length ? ` (sold out: ${out.join(", ")})` : ""}` +
              // A color on offer is shown even when few are left: the offer is how they go.
              (onOffer.length
                ? ` — CLEARANCE OFFER${oneSize ? "" : ` in size ${onOffer.join(", ")}`}: ${offer!.price} دينار instead of the usual price`
                : pieces <= FEW_LEFT
                  ? " — ONLY A FEW LEFT"
                  : "")
          : `- ${color}: SOLD OUT in every size`,
      );
    }
  }
  const clearanceRules = anyClearance
    ? `
- A "CLEARANCE OFFER" is our team's own special price for those exact pieces (a color in a size): it's allowed, above «السعر ثابت» and «ما في خصم» in the knowledge, but only for those pieces. Everything else keeps its usual price, and the delivery stays free and the payment the same.
  - For a product with sizes, offer it only once you know the customer's size (they said it, or the size table gave it from their weight) and it's exactly an offer size. Never change their size to fit an offer, and never offer it to someone whose size isn't on offer.
  - Then, once in the chat, tell them in a few words and as good news, with the color's photo if they haven't seen it: «وعندنا عرض خاص على البني مقاس 58: 300 دينار بدل 385 👌 الكمية محدودة». A color they already chose that is on offer in their size: tell them it's on offer at that price. If they want another color, fine: its usual price.
  - For a one-size product, the offer colors can be named first when you show the colors.
  - Say «عرض خاص» or «سعر خاص», never «تصفية», «مكسرة» or «باقي قطع قليلة». Never the number of pieces.
  - In the summary and in submit_order, an offer piece's price is the offer price (total = the sum of each piece's price).`
    : "";
  return `

# Stock right now
This list is the truth about what we have, above anything the knowledge documents say about availability. Never take an order for a color or size that isn't available here.
- If the customer wants a color or size that is sold out, say kindly that exact color or size is finished right now (e.g. "البيج خلص حالياً استاذ", or for one size "مقاس 58 خلص بالأسود حالياً") and offer what we have in their size (other colors), or another size only if it would fit them. Never say how many pieces are left.
- Don't send photos of a color that is sold out in every size, and don't offer it.
- A color marked "ONLY A FEW LEFT" is almost gone: don't send its photo or name it when you show or list the colors yourself (show the others). If the customer asks for it, picks it from a photo or our ad names it, it is available: say so with "الكمية محدودة" in a few words (never the number) and carry on with their order.
- Before calling submit_order, check every item against this list. If one is sold out (even when the summary was already sent and the customer confirmed), don't call submit_order: tell them kindly it just ran out and offer what we have in their size.
- A color or size missing from this list isn't kept in stock here: answer from the knowledge documents.${clearanceRules}
${lines.join("\n")}`;
}

// Items of an order that we don't have enough of (only colors/sizes kept in stock are checked).
export function missingStock(items: OrderItem[]): string[] {
  const rows = listStock();
  const wanted = new Map<StockRow, number>();
  for (const item of items) {
    const row = stockRowFor(item, rows);
    if (row) wanted.set(row, (wanted.get(row) ?? 0) + item.quantity);
  }
  return [...wanted]
    .filter(([row, n]) => row.quantity < n)
    .map(([row, n]) => `${row.color} مقاس ${row.size} (طلب ${n}، الباقي ${Math.max(0, row.quantity)})`);
}
