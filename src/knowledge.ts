import fs from "node:fs";
import path from "node:path";

const KNOWLEDGE_DIR = path.resolve("knowledge");

let cached: { text: string; loadedAt: number } | undefined;
const RELOAD_EVERY_MS = 60_000;

// Loads every .md / .txt file in ./knowledge into one block of text.
// Re-reads the folder at most once a minute, so edits go live without a restart.
export function loadKnowledge(): string {
  if (cached && Date.now() - cached.loadedAt < RELOAD_EVERY_MS) {
    return cached.text;
  }

  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .sort();

  const text = files
    .map((file) => {
      const body = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8").trim();
      return `<document name="${file}">\n${body}\n</document>`;
    })
    .join("\n\n");

  cached = { text, loadedAt: Date.now() };
  return text;
}
