// Stock for the AI and the team: what is left per color and size, so nobody sells what we don't have.
import { listStock, stockRowFor, whenStockRunsOut, type OrderItem, type StockRow } from "./store.js";
import { esc, notify } from "./telegram.js";

// Telegram: a color/size just ran out.
whenStockRunsOut((row) => {
  notify("order", `📦 <b>خلص</b>: ${esc(row.product)} · ${esc(row.color)} · مقاس ${esc(row.size)} (الباقي ${row.quantity}). حدّث المخزون من اللوحة إذا وصل جديد.`);
});

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
    lines.push(`${product}:`);
    for (const [color, sizes] of colors) {
      const left = sizes.filter((s) => s.quantity > 0).map((s) => s.size);
      const out = sizes.filter((s) => s.quantity <= 0).map((s) => s.size);
      lines.push(
        left.length
          ? `- ${color}: available in ${left.join(", ")}${out.length ? ` (sold out: ${out.join(", ")})` : ""}`
          : `- ${color}: SOLD OUT in every size`,
      );
    }
  }
  return `

# Stock right now
This list is the truth about what we have, above anything the knowledge documents say about availability. Never take an order for a color or size that isn't available here.
- If the customer wants a color or size that is sold out, say kindly that exact color or size is finished right now (e.g. "البيج خلص حالياً استاذ", or for one size "مقاس 58 خلص بالأسود حالياً") and offer what we have in their size (other colors), or another size only if it would fit them. Never say how many pieces are left.
- Don't send photos of a color that is sold out in every size, and don't offer it.
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
