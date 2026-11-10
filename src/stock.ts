// Stock for the AI and the team: what is left per color and size, so nobody sells what we don't have.
import { hasSizes, listStock, stockRowFor, whenStockRunsOut, type OrderItem, type StockRow } from "./store.js";
import { esc, notify } from "./telegram.js";

// Telegram: a color/size just ran out.
whenStockRunsOut((row) => {
  notify("order", `📦 <b>خلص</b>: ${esc(row.product)} · ${esc(row.color)} · مقاس ${esc(row.size)} (الباقي ${row.quantity}). حدّث المخزون من اللوحة إذا وصل جديد.`);
});

// A color with this many pieces or fewer (all sizes) is almost gone: the AI stops showing it first. In Nov 2026 the
// fur's silver had 3 pieces left and the AI kept sending its photo to every customer.
const FEW_LEFT = 3;

// The prompt section: per product, each color with the sizes still available. Empty when no stock is kept.
export function stockForPrompt(): string {
  const rows = listStock();
  if (!rows.length) return "";
  const products = new Map<string, Map<string, StockRow[]>>();
  for (const r of rows) {
    const colors = products.get(r.product) ?? new Map<string, StockRow[]>();
    colors.set(r.color, [...(colors.get(r.color) ?? []), r]);
    products.set(r.product, colors);
  }
  const lines: string[] = [];
  for (const [product, colors] of products) {
    const oneSize = !hasSizes(product, rows);
    lines.push(oneSize ? `${product} (ONE standard size: never ask a size for it, never use the size table; ask the weight only if its knowledge document says so; size "ستاندرد" in submit_order):` : `${product}:`);
    for (const [color, sizes] of colors) {
      const left = sizes.filter((s) => s.quantity > 0).map((s) => s.size);
      const out = sizes.filter((s) => s.quantity <= 0).map((s) => s.size);
      const pieces = sizes.reduce((n, s) => n + Math.max(0, s.quantity), 0);
      lines.push(
        left.length
          ? `- ${color}: available in ${left.join(", ")}${out.length ? ` (sold out: ${out.join(", ")})` : ""}${pieces <= FEW_LEFT ? " — ONLY A FEW LEFT" : ""}`
          : `- ${color}: SOLD OUT in every size`,
      );
    }
  }
  return `

# Stock right now
This list is the truth about what we have, above anything the knowledge documents say about availability. Never take an order for a color or size that isn't available here.
- If the customer wants a color or size that is sold out, say kindly that exact color or size is finished right now (e.g. "البيج خلص حالياً استاذ", or for one size "مقاس 58 خلص بالأسود حالياً") and offer what we have in their size (other colors), or another size only if it would fit them. Never say how many pieces are left.
- Don't send photos of a color that is sold out in every size, and don't offer it.
- A color marked "ONLY A FEW LEFT" is almost gone: don't send its photo or name it when you show or list the colors yourself (show the others). If the customer asks for it, picks it from a photo or our ad names it, it is available: say so with "الكمية محدودة" in a few words (never the number) and carry on with their order.
- Before calling submit_order, check every item against this list. If one is sold out (even when the summary was already sent and the customer confirmed), don't call submit_order: tell them kindly it just ran out and offer what we have in their size.
- A color or size missing from this list isn't kept in stock here: answer from the knowledge documents.
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
