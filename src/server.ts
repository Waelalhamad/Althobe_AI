import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { handleWhatsAppWebhook } from "./channels/whatsapp.js";
import { handleChatwootEvent } from "./channels/chatwoot.js";
import { handleMetaWebhook, startMeta, validMetaSignature } from "./channels/meta.js";
import { DATA_DELETION_PAGE, PRIVACY_PAGE } from "./legal.js";
import { dashboardApi } from "./dashboard/api.js";
import { dataPath } from "./media.js";
import { startSupervisor } from "./supervisor.js";
import { startFollowUps } from "./followup.js";
import { startDarbSync } from "./darbTrack.js";
import "./tracking.js"; // customers hear when their order moves (after each Darb sync)
import { startLearning } from "./learning.js";

const app = express();
app.set("trust proxy", 1); // Railway's proxy: real client IP for the login limit

app.get("/health", (_req, res) => {
  res.json({ ok: true, whatsapp: config.whatsapp.enabled, meta: config.meta.enabled, chatwoot: config.chatwoot.enabled });
});

// Meta's webhook verification when the URL is registered (used by Dualhook's Webhook Override).
app.get("/whatsapp/:token", (req, res) => {
  const verifyToken = config.whatsapp.verifyToken;
  if (
    safeEqual(String(req.params.token), config.webhookToken) &&
    verifyToken &&
    req.query["hub.mode"] === "subscribe" &&
    safeEqual(String(req.query["hub.verify_token"] ?? ""), verifyToken)
  ) {
    res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    return;
  }
  res.status(403).end();
});

// WhatsApp messages. Providers need a 200 within seconds, so we answer first and work after.
// The limit is high because one history-sync chunk can hold thousands of messages.
app.post("/whatsapp/:token", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
  const payload = readJson(req, res);
  if (payload === undefined) return;
  res.status(200).json({ received: true });
  try {
    handleWhatsAppWebhook(payload);
  } catch (error) {
    console.error("WhatsApp webhook handling failed:", error);
  }
});

// Messenger + Instagram straight from Meta. Verification when the URL is registered in the app.
app.get("/meta/webhook", (req, res) => {
  const verifyToken = config.meta.verifyToken;
  if (verifyToken && req.query["hub.mode"] === "subscribe" && safeEqual(String(req.query["hub.verify_token"] ?? ""), verifyToken)) {
    res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    return;
  }
  res.status(403).end();
});

// Every delivery is signed with the app secret; anything else is refused.
app.post("/meta/webhook", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  if (!config.meta.enabled || !validMetaSignature(rawBody(req), req.header("X-Hub-Signature-256"))) {
    res.status(401).end();
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody(req).toString("utf8"));
  } catch {
    res.status(400).end();
    return;
  }
  res.status(200).json({ received: true });
  try {
    handleMetaWebhook(payload as Parameters<typeof handleMetaWebhook>[0]);
  } catch (error) {
    console.error("Meta webhook handling failed:", error);
  }
});

// Public pages the Meta app needs (Basic settings: Privacy Policy URL, Data deletion instructions URL).
app.get("/privacy", (_req, res) => res.type("html").send(PRIVACY_PAGE));
app.get("/data-deletion", (_req, res) => res.type("html").send(DATA_DELETION_PAGE));

// Instagram + Messenger (Chatwoot Agent Bot).
app.post("/webhook/:token", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  const secret = config.chatwoot.webhookSecret;
  if (secret && !validChatwootSignature(req, secret)) {
    res.status(401).end();
    return;
  }
  const event = readJson(req, res);
  if (event === undefined) return;
  res.status(200).json({ received: true });
  handleChatwootEvent(event);
});

// Dashboard: JSON API + the built React app (npm run build → dashboard/dist).
app.use("/dashboard/api", dashboardApi);
const DASHBOARD_DIST = path.resolve("dashboard/dist");
app.use("/dashboard", express.static(DASHBOARD_DIST, { index: false }));
app.get(["/dashboard", "/dashboard/{*page}"], (_req, res) => {
  const index = path.join(DASHBOARD_DIST, "index.html");
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).type("text/plain").send("Dashboard not built. Run: npm run build");
});
app.get("/", (_req, res) => res.redirect("/dashboard"));

// Product photos, public so WhatsApp can download the ones the AI sends. File names are random.
app.get("/catalog/:file", (req, res) => {
  const file = req.params.file;
  const full = /^[\w-]+\.(jpg|png|webp)$/.test(file) ? dataPath(`catalog/${file}`) : undefined;
  if (!full || !fs.existsSync(full)) {
    res.status(404).end();
    return;
  }
  res.sendFile(full, { maxAge: "7d" });
});

// Photos the team sent from the dashboard, public so WhatsApp can download them. Names are 128-bit random.
app.get("/sent/:file", (req, res) => {
  const file = req.params.file;
  const full = /^team-[0-9a-f]{32}\.(jpg|png)$/.test(file) ? dataPath(`media/${file}`) : undefined;
  if (!full || !fs.existsSync(full)) {
    res.status(404).end();
    return;
  }
  res.sendFile(full, { maxAge: "7d" });
});

// Checks the secret token in the URL and parses the raw body. Sends the error response itself.
function readJson(req: express.Request, res: express.Response) {
  if (!safeEqual(String(req.params.token), config.webhookToken)) {
    res.status(404).end();
    return undefined;
  }
  try {
    return JSON.parse(rawBody(req).toString("utf8"));
  } catch {
    res.status(400).end();
    return undefined;
  }
}

function rawBody(req: express.Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Chatwoot signs as: X-Chatwoot-Signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
function validChatwootSignature(req: express.Request, secret: string): boolean {
  const timestamp = req.header("X-Chatwoot-Timestamp");
  const signature = req.header("X-Chatwoot-Signature");
  if (!timestamp || !signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody(req)).digest("hex");
  return safeEqual(signature, expected);
}

app.listen(config.port, () => {
  void config.webhookToken; // fail at startup if missing
  startSupervisor();
  startFollowUps();
  startDarbSync();
  startLearning();
  void startMeta();
  const channels = [
    config.whatsapp.enabled && `WhatsApp (${config.whatsapp.provider})`,
    config.meta.enabled && "Messenger + Instagram",
    config.chatwoot.enabled && "Chatwoot",
  ]
    .filter(Boolean)
    .join(" + ");
  console.log(
    `AI agent listening on port ${config.port} (model: ${config.openai.model}; channels: ${channels || "none configured"})`,
  );
});
