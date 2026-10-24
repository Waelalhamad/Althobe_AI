import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { handleWhatsAppWebhook } from "./channels/whatsapp.js";
import { handleChatwootEvent } from "./channels/chatwoot.js";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, whatsapp: config.whatsapp.enabled, chatwoot: config.chatwoot.enabled });
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
app.post("/whatsapp/:token", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  const payload = readJson(req, res);
  if (payload === undefined) return;
  res.status(200).json({ received: true });
  try {
    handleWhatsAppWebhook(payload);
  } catch (error) {
    console.error("WhatsApp webhook handling failed:", error);
  }
});

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
  const channels = [config.whatsapp.enabled && `WhatsApp (${config.whatsapp.provider})`, config.chatwoot.enabled && "Chatwoot"]
    .filter(Boolean)
    .join(" + ");
  console.log(
    `AI agent listening on port ${config.port} (model: ${config.openai.model}; channels: ${channels || "none configured"})`,
  );
});
