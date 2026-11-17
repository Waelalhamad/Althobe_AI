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
What our team wrote about each product (its fabric, material, feel, season, care…). It is true, and above the knowledge documents wherever they differ or say we don't know something about that product (like «لا نعرف عنه أكثر من اسمه»): when the customer asks, answer from it in a few words, proudly and in their dialect, then carry on selling. Bring a detail up yourself only where it helps (a price objection, «شن الخامة؟», «يدفّي؟»), one at a time, never the whole list. Never add anything that isn't written here or in the knowledge: if it isn't there, say «نتأكدلك استاذ».
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
  let anyPush = false; // marked pieces with no special price: shown first at their usual price
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
      const priced = onOffer.length > 0 && offer!.price > 0;
      if (priced) anyClearance = true;
      if (onOffer.length && !priced) anyPush = true;
      lines.push(
        left.length
          ? `- ${color}: available in ${left.join(", ")}${out.length ? ` (sold out: ${out.join(", ")})` : ""}` +
              // A color on offer is shown even when few are left: the offer is how they go.
              (priced
                ? ` — CLEARANCE OFFER${oneSize ? "" : ` in size ${onOffer.join(", ")}`}: ${offer!.price} دينار instead of the usual price`
                : onOffer.length
                  ? ` — PUSH FIRST${oneSize ? "" : ` in size ${onOffer.join(", ")}`}`
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
  - In the summary and in submit_order, an offer piece's price is the offer price (total = the sum of each piece's price). The total holds that one number only («الإجمالي: 300 دينار»), never the usual price next to it: the courier collects the number written there.`
    : "";
  // In Nov 2026 the fur's last honey حلزون and beige سلسلة pieces were to go first, at the usual price.
  const pushRules = anyPush
    ? `
- A color marked "PUSH FIRST" is one our team wants sold first (the last pieces of that color), at its usual price:
  - When you show or list the colors (of the product, or of the model they chose), send its photo first and name it first, and recommend it in a few words as a beautiful choice («العسلي لونه فخم ومميز 👌»). You may add «الكمية محدودة» once in the chat. For a product with sizes, only when the customer's size is one marked.
  - Never say it's the last pieces, leftovers or a clearance, never the number of pieces, and never press: if they prefer another color, sell that one gladly.
  - This holds every time colors are shown, a first reply too (a customer from a model's ad gets that model's colors right away: the marked one goes first). Only a message that shows the models (one photo per model, to choose the embroidery) keeps the photos its knowledge document names.`
    : "";
  return `

# Stock right now
This list is the truth about what we have, above anything the knowledge documents say about availability. Never take an order for a color or size that isn't available here.
- If the customer wants a color or size that is sold out, say kindly that exact color or size is finished right now (e.g. "البيج خلص حالياً استاذ", or for one size "مقاس 58 خلص بالأسود حالياً") and offer what we have in their size (other colors), or another size only if it would fit them. Never say how many pieces are left.
- Don't send photos of a color that is sold out in every size, and don't offer it.
- A color marked "ONLY A FEW LEFT" is almost gone: don't send its photo or name it when you show or list the colors yourself (show the others). If the customer asks for it, picks it from a photo or our ad names it, it is available: say so with "الكمية محدودة" in a few words (never the number) and carry on with their order.
- Before calling submit_order, check every item against this list. If one is sold out (even when the summary was already sent and the customer confirmed), don't call submit_order: tell them kindly it just ran out and offer what we have in their size.
- A color or size missing from this list isn't kept in stock here: answer from the knowledge documents.${clearanceRules}${pushRules}
${lines.join("\n")}`;
}

// Photos with the colors the team marked (to sell first, or on offer) first, the rest in the AI's order: the AI
// named the marked color first but still sent its photo second (Nov 2026).
export function markedFirst<T extends { product?: string; name: string }>(photos: T[]): T[] {
  const marked = listClearance();
  const rows = listStock();
  const isMarked = (p: T) =>
    marked.some(
      (m) =>
        stockName(m.product) === stockName(p.product ?? "") &&
        m.cells.some(
          (c) =>
            stockName(c.color) === stockName(p.name) &&
            rows.some((r) => r.product === m.product && stockName(r.color) === stockName(c.color) && stockName(r.size) === stockName(c.size) && r.quantity > 0),
        ),
    );
  return [...photos.filter(isMarked), ...photos.filter((p) => !isMarked(p))];
}

// An order at a product's offer price where not every piece is on offer: the model gave the special price to the
// wrong color or size. Only the model ties the price to the piece, so this is checked before saving.
export function offerPriceProblems(items: OrderItem[], total: string): string[] {
  const amount = Number(total.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[,٬]/g, "").match(/\d+/)?.[0]);
  if (!amount) return [];
  const rows = listStock();
  const count = items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
  for (const offer of listClearance()) {
    if (!(offer.price > 0) || amount !== offer.price * count) continue;
    const notOnOffer = items.filter((i) => {
      const row = stockRowFor(i, rows);
      return !(
        row &&
        stockName(row.product) === stockName(offer.product) &&
        row.quantity > 0 &&
        offer.cells.some((c) => stockName(c.color) === stockName(row.color) && stockName(c.size) === stockName(row.size))
      );
    });
    if (notOnOffer.length)
      return [
        `The total ${amount} is the special offer price, but ${notOnOffer.map((i) => `${i.color} ${i.size}`.trim()).join(", ")} isn't on offer: only the pieces marked "CLEARANCE OFFER" in the stock list have that price. Put that piece's usual price in the total and send the summary again.`,
      ];
  }
  return [];
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
