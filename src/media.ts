// Photos and voice notes: download from WhatsApp, keep on disk, turn voice into text for the AI.
import fs from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { config } from "./config.js";

const DATA_DIR = path.resolve(config.dataDir);

// Resolves a stored path like "media/x.jpg" inside DATA_DIR; undefined if it would leave the media folders.
export function dataPath(file: string): string | undefined {
  const full = path.resolve(DATA_DIR, file);
  const allowed = ["media", "catalog"].some((dir) => full.startsWith(path.join(DATA_DIR, dir) + path.sep));
  return allowed ? full : undefined;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.split(";")[0]!.trim()] ?? "bin";
}

// Downloads a WhatsApp media file by its media id (from the webhook) through Dualhook or 360dialog.
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
  const wa = config.whatsapp;
  let res: Response;
  if (wa.provider === "360dialog") {
    // 360dialog: ask for the media URL, then download it through 360dialog with the same key.
    const headers = { "D360-API-KEY": wa.d360.apiKey };
    const meta = await fetch(`${wa.d360.baseUrl}/${mediaId}`, { headers });
    if (!meta.ok) throw new Error(`360dialog media lookup failed: ${meta.status}`);
    const { url } = (await meta.json()) as { url?: string };
    if (!url) throw new Error("360dialog media lookup returned no url");
    const proxied = new URL(url);
    proxied.host = new URL(wa.d360.baseUrl).host;
    res = await fetch(proxied, { headers });
  } else {
    res = await fetch(`${wa.dualhook.baseUrl}/${mediaId}/content`, {
      headers: { Authorization: `Bearer ${wa.dualhook.apiKey}` },
    });
  }
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "application/octet-stream" };
}

// Saves a file under DATA_DIR/<folder>/ and returns its stored path ("media/abc.jpg").
export function saveFile(folder: "media" | "catalog", baseName: string, data: Buffer, mime: string): string {
  const dir = path.join(DATA_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const safeBase = baseName.replace(/[^A-Za-z0-9_-]/g, "_").slice(-80);
  const file = `${folder}/${safeBase}.${extensionFor(mime)}`;
  fs.writeFileSync(path.join(DATA_DIR, file), data);
  return file;
}

// "data:image/jpeg;base64,..." for sending a stored photo to the AI.
export function fileAsDataUrl(file: string, mime?: string): string | undefined {
  const full = dataPath(file);
  if (!full || !fs.existsSync(full)) return undefined;
  const type = mime ?? (file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg");
  return `data:${type};base64,${fs.readFileSync(full).toString("base64")}`;
}

let client: OpenAI | undefined;

// Voice note → text. The prompt nudges the model towards the shop's words and the Libyan dialect.
export async function transcribe(data: Buffer, mime: string): Promise<string> {
  client ??= new OpenAI();
  const result = await client.audio.transcriptions.create({
    model: config.media.transcribeModel,
    file: await toFile(data, `voice.${extensionFor(mime)}`, { type: mime.split(";")[0] }),
    prompt: "رسالة صوتية من زبون ليبي لمحل ملابس: ثوب عربي، مقاس، لون، توصيل، طرابلس، بنغازي، دينار.",
  });
  return result.text.trim();
}
