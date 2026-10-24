// The dashboard's JSON API, under /dashboard/api. Everything except login needs the session cookie.
import crypto from "node:crypto";
import express from "express";
import { config } from "../config.js";
import { decideReply, type ChatTurn } from "../agent.js";
import { sendTeamMessage } from "../channels/whatsapp.js";
import {
  deleteKnowledgeFile,
  listKnowledgeFiles,
  readKnowledgeFile,
  validKnowledgeName,
  writeKnowledgeFile,
} from "../knowledge.js";
import { log } from "../scheduler.js";
import { aiRepliesEnabled, setAiReplies, setTestNumbers, testNumbers } from "../settings.js";
import { getSetting, pauseAi, resumeAi } from "../store.js";
import * as queries from "./queries.js";

export const dashboardApi = express.Router();
dashboardApi.use(express.json({ limit: "1mb" }));

// --- Login: a signed cookie that expires; changing DASHBOARD_PASSWORD logs everyone out. ---

const COOKIE = "dashboard_session";
const SESSION_DAYS = 14;

function signingKey(password: string) {
  return crypto.createHash("sha256").update(`dashboard-session:${password}`).digest();
}

function sign(expires: number, password: string) {
  return crypto.createHmac("sha256", signingKey(password)).update(String(expires)).digest("base64url");
}

function validSession(req: express.Request, password: string): boolean {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [expires, signature] = cookie?.split(".") ?? [];
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = sign(Number(expires), password);
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function setSessionCookie(res: express.Response, value: string, maxAgeMs: number) {
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT),
    path: "/dashboard",
    maxAge: maxAgeMs,
  });
}

// Slow down password guessing: 10 wrong tries per IP, then wait 15 minutes.
const failedLogins = new Map<string, { count: number; resetAt: number }>();

dashboardApi.post("/login", (req, res) => {
  const password = config.dashboard.password;
  if (!password) {
    res.status(503).json({ error: "DASHBOARD_PASSWORD is not set on the server" });
    return;
  }
  const ip = req.ip ?? "unknown";
  const failed = failedLogins.get(ip);
  if (failed && failed.resetAt > Date.now() && failed.count >= 10) {
    res.status(429).json({ error: "Too many attempts, try again later" });
    return;
  }
  const given = Buffer.from(String(req.body?.password ?? ""));
  const wanted = Buffer.from(password);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    const entry = failed && failed.resetAt > Date.now() ? failed : { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    entry.count++;
    failedLogins.set(ip, entry);
    res.status(401).json({ error: "Wrong password" });
    return;
  }
  failedLogins.delete(ip);
  const maxAge = SESSION_DAYS * 24 * 60 * 60 * 1000;
  const expires = Date.now() + maxAge;
  setSessionCookie(res, `${expires}.${sign(expires, password)}`, maxAge);
  res.json({ ok: true });
});

dashboardApi.post("/logout", (_req, res) => {
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
});

dashboardApi.use((req, res, next) => {
  const password = config.dashboard.password;
  if (!password) {
    res.status(503).json({ error: "DASHBOARD_PASSWORD is not set on the server" });
    return;
  }
  if (!validSession(req, password)) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  next();
});

// --- Data ------------------------------------------------------------------------

const intParam = (value: unknown, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

dashboardApi.get("/overview", (req, res) => {
  res.json(queries.overview(intParam(req.query.days, 7, 90)));
});

const FILTERS = ["all", "unanswered", "ai", "paused", "handoff"] as const;

dashboardApi.get("/conversations", (req, res) => {
  const filter = FILTERS.find((f) => f === req.query.filter) ?? "all";
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  res.json(queries.conversations({ filter, q, limit: intParam(req.query.limit, 100, 500) }));
});

dashboardApi.get("/conversations/:customer", (req, res) => {
  res.json(queries.conversation(req.params.customer));
});

dashboardApi.post("/conversations/:customer/pause", (req, res) => {
  const hours = Number(req.body?.hours);
  pauseAi(req.params.customer, "paused from the dashboard", hours > 0 && hours <= 24 * 30 ? hours : undefined);
  log(`wa:${req.params.customer}`, "AI paused from the dashboard");
  res.json({ ok: true });
});

dashboardApi.post("/conversations/:customer/resume", (req, res) => {
  resumeAi(req.params.customer);
  log(`wa:${req.params.customer}`, "AI resumed from the dashboard");
  res.json({ ok: true });
});

dashboardApi.post("/conversations/:customer/send", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text || text.length > 4096) {
    res.status(400).json({ error: "Message must be 1 to 4096 characters" });
    return;
  }
  if (!config.whatsapp.enabled) {
    res.status(400).json({ error: "WhatsApp sending is not configured" });
    return;
  }
  try {
    await sendTeamMessage(req.params.customer, text);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

dashboardApi.get("/handoffs", (req, res) => {
  res.json(queries.handoffs(intParam(req.query.days, 7, 90)));
});

dashboardApi.get("/events", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  res.json(queries.events({ q, limit: intParam(req.query.limit, 200, 1000) }));
});

// --- Settings ----------------------------------------------------------------------

function settingsView() {
  let historySync: unknown = null;
  try {
    historySync = JSON.parse(getSetting("history_sync") ?? "null");
  } catch {}
  return {
    aiReplies: aiRepliesEnabled(),
    testNumbers: testNumbers(),
    model: config.openai.model,
    reasoningEffort: config.openai.reasoningEffort,
    humanPauseHours: config.whatsapp.humanPauseHours,
    debounceMs: config.debounceMs,
    historyLimit: config.historyLimit,
    timezoneOffsetHours: config.dashboard.timezoneOffsetHours,
    channels: {
      whatsapp: config.whatsapp.enabled ? config.whatsapp.provider : null,
      whatsappPhoneNumberId: config.whatsapp.phoneNumberId ?? null,
      chatwoot: config.chatwoot.enabled,
      openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    },
    historySync,
  };
}

dashboardApi.get("/settings", (_req, res) => {
  res.json(settingsView());
});

dashboardApi.put("/settings", (req, res) => {
  const body = req.body ?? {};
  if (typeof body.aiReplies === "boolean") {
    setAiReplies(body.aiReplies);
    log("dashboard", `AI replies turned ${body.aiReplies ? "on" : "off"}`);
  }
  if (Array.isArray(body.testNumbers)) {
    // WhatsApp numbers as digits only, with country code (e.g. 218912345678).
    const digits = (body.testNumbers as unknown[]).map((n) => String(n).replace(/\D/g, ""));
    const numbers = [...new Set(digits)].filter((n) => n.length >= 8 && n.length <= 15);
    setTestNumbers(numbers);
    log("dashboard", numbers.length ? `test mode on for ${numbers.length} number(s)` : "test mode off");
  }
  res.json(settingsView());
});

// --- Knowledge files --------------------------------------------------------------------

dashboardApi.get("/knowledge", (_req, res) => {
  res.json(listKnowledgeFiles());
});

dashboardApi.get("/knowledge/:name", (req, res) => {
  const body = readKnowledgeFile(req.params.name);
  if (body === undefined) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.json({ name: req.params.name, body });
});

dashboardApi.put("/knowledge/:name", (req, res) => {
  const body = req.body?.body;
  if (!validKnowledgeName(req.params.name) || typeof body !== "string" || body.length > 200_000) {
    res.status(400).json({ error: "Use a name like 06-offers.md and text under 200,000 characters" });
    return;
  }
  writeKnowledgeFile(req.params.name, body);
  log("dashboard", `knowledge file saved: ${req.params.name}`);
  res.json({ ok: true });
});

dashboardApi.delete("/knowledge/:name", (req, res) => {
  if (!deleteKnowledgeFile(req.params.name)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  log("dashboard", `knowledge file deleted: ${req.params.name}`);
  res.json({ ok: true });
});

// --- Playground: try the AI with the current knowledge; nothing is sent or counted. ---

dashboardApi.post("/playground", async (req, res) => {
  const turns = Array.isArray(req.body?.messages) ? (req.body.messages as unknown[]) : [];
  const history: ChatTurn[] = turns
    .slice(-config.historyLimit)
    .map((t) => t as { role?: unknown; text?: unknown })
    .filter((t) => (t.role === "customer" || t.role === "business") && typeof t.text === "string" && t.text.trim())
    .map((t) => ({ role: t.role as ChatTurn["role"], text: String(t.text).slice(0, 4000) }));
  if (!history.length || history.at(-1)?.role !== "customer") {
    res.status(400).json({ error: "The last message must be from the customer" });
    return;
  }
  try {
    res.json(await decideReply(history));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
