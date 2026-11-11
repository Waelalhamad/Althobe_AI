// Product photos the AI may send to customers. Managed from the dashboard, stored on the volume.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { dataPath, saveFile } from "./media.js";

export type CatalogItem = {
  id: string; // short id the AI uses, e.g. "p3"
  product?: string; // which product the photo shows, e.g. "الثوب العربي" (empty = the store's only product)
  name: string; // e.g. "رصاصي"
  description: string; // colors, sizes in stock, anything the AI should know about this photo
  file: string; // "catalog/<id>.jpg"
  mime: string;
  createdAt: number;
};

const INDEX = path.resolve(config.dataDir, "catalog", "catalog.json");

// How a photo we sent is named in the chat ("[sent product photo: …]") and in its WhatsApp caption: with its model
// when it isn't our set ("فروة أبو شهري مطرز شبك - بني"), so the AI knows which embroidery a customer means when they
// point at a photo. The fur's 3 models share colors: "بني" alone didn't say which one (Nov 2026).
export function photoLabel(item: CatalogItem, setName: RegExp): string {
  const product = item.product?.trim();
  return product && !setName.test(product) ? `${product} - ${item.name}` : item.name;
}

export function listCatalog(): CatalogItem[] {
  try {
    return JSON.parse(fs.readFileSync(INDEX, "utf8")) as CatalogItem[];
  } catch {
    return [];
  }
}

function saveIndex(items: CatalogItem[]) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(items, null, 2));
}

export function addCatalogItem(input: { product: string; name: string; description: string; data: Buffer; mime: string }): CatalogItem {
  const items = listCatalog();
  let n = items.length + 1;
  while (items.some((i) => i.id === `p${n}`)) n++;
  const id = `p${n}`;
  // A random suffix in the file name so the public photo URL can't be guessed before it is sent.
  const file = saveFile("catalog", `${id}-${crypto.randomBytes(6).toString("hex")}`, input.data, input.mime);
  const item = { id, product: input.product, name: input.name, description: input.description, file, mime: input.mime, createdAt: Date.now() };
  saveIndex([...items, item]);
  return item;
}

export function updateCatalogItem(
  id: string,
  patch: { product?: string; name?: string; description?: string },
): CatalogItem | undefined {
  const items = listCatalog();
  const item = items.find((i) => i.id === id);
  if (!item) return undefined;
  if (typeof patch.product === "string") item.product = patch.product;
  if (typeof patch.name === "string") item.name = patch.name;
  if (typeof patch.description === "string") item.description = patch.description;
  saveIndex(items);
  return item;
}

export function deleteCatalogItem(id: string): boolean {
  const items = listCatalog();
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  const full = dataPath(item.file);
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
  saveIndex(items.filter((i) => i.id !== id));
  return true;
}

// Public link WhatsApp downloads the photo from (served by /catalog/<file>).
export function publicPhotoUrl(item: CatalogItem): string {
  if (!config.publicUrl) throw new Error("PUBLIC_URL is not set, so WhatsApp can't fetch product photos");
  return `${config.publicUrl}/${item.file}`;
}

// The list the AI sees, so it knows which photos exist and what each shows.
export function catalogForPrompt(): string {
  const items = listCatalog();
  if (!items.length) return "(No product photos uploaded yet. You cannot send photos.)";
  // Grouped by product, so the AI sends the photos of the product the customer asks about.
  const groups = new Map<string, CatalogItem[]>();
  for (const i of items) {
    const product = i.product?.trim() ?? "";
    groups.set(product, [...(groups.get(product) ?? []), i]);
  }
  // Several photos of one color (angles, the embroidery up close) on one line: the first one shows the color, the others
  // are for a customer who wants to see it better.
  const many = items.some((i) => items.filter((j) => j.product === i.product && j.name === i.name).length > 1);
  return (
    [...groups]
      .map(([product, photos]) => {
        const names = new Map<string, CatalogItem[]>();
        for (const p of photos) names.set(p.name, [...(names.get(p.name) ?? []), p]);
        const lines = [...names]
          .map(([name, ps]) => {
            const description = ps.find((p) => p.description)?.description;
            return `- ${ps.map((p) => p.id).join(", ")}: ${name}${description ? ` — ${description}` : ""}`;
          })
          .join("\n");
        return product ? `${product}:\n${lines}` : lines;
      })
      .join("\n\n") +
    (many
      ? "\n\nA line with several ids is several photos of the same color. To show the colors, send the FIRST id of each; send the others only when the customer wants to see that color better (closer, other angles)."
      : "")
  );
}
