// Product photos the AI may send to customers. Managed from the dashboard, stored on the volume.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { dataPath, saveFile } from "./media.js";

export type CatalogItem = {
  id: string; // short id the AI uses, e.g. "p3"
  name: string; // e.g. "ثوب عربي — رصاصي"
  description: string; // colors, sizes in stock, anything the AI should know about this photo
  file: string; // "catalog/<id>.jpg"
  mime: string;
  createdAt: number;
};

const INDEX = path.resolve(config.dataDir, "catalog", "catalog.json");

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

export function addCatalogItem(input: { name: string; description: string; data: Buffer; mime: string }): CatalogItem {
  const items = listCatalog();
  let n = items.length + 1;
  while (items.some((i) => i.id === `p${n}`)) n++;
  const id = `p${n}`;
  // A random suffix in the file name so the public photo URL can't be guessed before it is sent.
  const file = saveFile("catalog", `${id}-${crypto.randomBytes(6).toString("hex")}`, input.data, input.mime);
  const item = { id, name: input.name, description: input.description, file, mime: input.mime, createdAt: Date.now() };
  saveIndex([...items, item]);
  return item;
}

export function updateCatalogItem(id: string, patch: { name?: string; description?: string }): CatalogItem | undefined {
  const items = listCatalog();
  const item = items.find((i) => i.id === id);
  if (!item) return undefined;
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
  return items.map((i) => `- ${i.id}: ${i.name}${i.description ? ` — ${i.description}` : ""}`).join("\n");
}
