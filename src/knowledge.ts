import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// The files the AI answers from. On Railway this folder is on the volume (KNOWLEDGE_DIR=/data/knowledge)
// so edits made in the dashboard survive redeploys; the first start copies the repo's ./knowledge there.
const KNOWLEDGE_DIR = path.resolve(config.knowledgeDir);
const SEED_DIR = path.resolve("knowledge");

if (!fs.existsSync(KNOWLEDGE_DIR)) {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  if (KNOWLEDGE_DIR !== SEED_DIR && fs.existsSync(SEED_DIR)) {
    for (const file of fs.readdirSync(SEED_DIR).filter(isKnowledgeFile)) {
      fs.copyFileSync(path.join(SEED_DIR, file), path.join(KNOWLEDGE_DIR, file));
    }
  }
}

let cached: { text: string; loadedAt: number } | undefined;
const RELOAD_EVERY_MS = 60_000;

function isKnowledgeFile(name: string) {
  return name.endsWith(".md") || name.endsWith(".txt");
}

// Loads every .md / .txt file in the knowledge folder into one block of text.
// Re-reads the folder at most once a minute, so edits go live without a restart.
export function loadKnowledge(): string {
  if (cached && Date.now() - cached.loadedAt < RELOAD_EVERY_MS) {
    return cached.text;
  }

  const text = listKnowledgeFiles()
    .map((file) => {
      const body = fs.readFileSync(path.join(KNOWLEDGE_DIR, file.name), "utf8").trim();
      return `<document name="${file.name}">\n${body}\n</document>`;
    })
    .join("\n\n");

  cached = { text, loadedAt: Date.now() };
  return text;
}

// --- Editing from the dashboard --------------------------------------------

export function listKnowledgeFiles(): { name: string; size: number; updatedAt: number }[] {
  return fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter(isKnowledgeFile)
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(KNOWLEDGE_DIR, name));
      return { name, size: stat.size, updatedAt: stat.mtimeMs };
    });
}

// Only plain file names like "02-products.md": no folders, so nothing outside the knowledge folder.
export function validKnowledgeName(name: string): boolean {
  return /^[\p{L}\p{N}_ .-]{1,80}\.(md|txt)$/u.test(name) && !name.startsWith(".");
}

export function readKnowledgeFile(name: string): string | undefined {
  if (!validKnowledgeName(name)) return undefined;
  const file = path.join(KNOWLEDGE_DIR, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

export function writeKnowledgeFile(name: string, body: string) {
  if (!validKnowledgeName(name)) throw new Error("Invalid file name");
  fs.writeFileSync(path.join(KNOWLEDGE_DIR, name), body, "utf8");
  cached = undefined; // the AI uses the new text from the next message
}

export function deleteKnowledgeFile(name: string): boolean {
  if (!validKnowledgeName(name)) return false;
  const file = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  cached = undefined;
  return true;
}
