// The dashboard's JSON API, under /dashboard/api. Everything except login needs the session cookie.
import crypto from "node:crypto";
import express from "express";
import { config } from "../config.js";
import fs from "node:fs";
import { decideReply, draftOrder, writeFollowUp, type ChatTurn } from "../agent.js";
import { addCatalogItem, deleteCatalogItem, listCatalog, updateCatalogItem } from "../catalog.js";
import { dataPath, transcribe } from "../media.js";
import { answerIfWaiting, answerWaiting, latinDigits, localPhone, sendTeamMessage } from "../channels/whatsapp.js";
import { notifyOrder } from "../orders.js";
import { sendToDarb, shipmentPreview, shipmentQuote, updateDarbShipment, type ShipmentInput } from "../darb.js";
import { darbMatches, darbMoney, linkDarb, PhoneMismatch, syncDarb, trackOrder, unlinkDarb } from "../darbTrack.js";
import { leadsWorkbook, ordersWorkbook, sendDailySheet, sheetName, type SheetRange } from "../ordersSheet.js";
import { approveLesson, ignoreLesson, lessonsView } from "../learning.js";
import {
  deleteKnowledgeFile,
  listKnowledgeFiles,
  readKnowledgeFile,
  validKnowledgeName,
  writeKnowledgeFile,
} from "../knowledge.js";
import { log } from "../scheduler.js";
import { missingStock } from "../stock.js";
import { aiRepliesEnabled, channelRepliesEnabled, META_CHANNELS, setAiReplies, setChannelReplies, setTestNumbers, testNumbers } from "../settings.js";
import {
  channelOf,
  db,
  deleteProductStock,
  listStock,
  setProductStock,
  stockName,
  stockRowFor,
  type OrderItem,
  getSetting,
  ORDER_STATUSES,
  pauseAi,
  recordAiCall,
  resumeAi,
  saveOrder,
  setOrderStatus,
  updateOrder,
  type OrderFields,
  setTeamPauseMinutes,
  teamPauseMinutes,
  type OrderStatus,
} from "../store.js";
import * as queries from "./queries.js";
import { findGroups, sendTest, telegramChatId, setMutedKinds, setTelegramChat, setTelegramToken, telegramStatus } from "../telegram.js";
import { followUpSettings, followUpStats, saveFollowUpSettings } from "../followup.js";
import { markTold, saveTrackingSettings, trackingSettings, trackingStats } from "../tracking.js";
import { redirectCandidates, redirectMatches, redirectShipment, tellRedirectChance } from "../darbRedirect.js";
import { generateReport, resolveAlert, runChecks, runReviews, saveSupervisorSettings, supervisorView } from "../supervisor.js";

export const dashboardApi = express.Router();
// Photo uploads and test photos (base64 JSON) need a bigger body than everything else.
const smallJson = express.json({ limit: "1mb" });
const uploadJson = express.json({ limit: "12mb" });
dashboardApi.use((req, res, next) =>
  (req.method === "POST" && (req.path === "/catalog" || req.path.startsWith("/playground") || req.path.endsWith("/send")) ? uploadJson : smallJson)(req, res, next),
);

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
  const answering = answerIfWaiting(req.params.customer);
  log(`wa:${req.params.customer}`, answering ? "AI resumed from the dashboard; answering the waiting message" : "AI resumed from the dashboard");
  res.json({ ok: true });
});

dashboardApi.post("/conversations/:customer/send", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  // Optional photo: "data:image/jpeg;base64,..." (the dashboard shrinks it first).
  const photo = req.body?.image ? /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(String(req.body.image)) : undefined;
  if (req.body?.image && !photo) {
    res.status(400).json({ error: "The photo must be a JPEG or PNG" });
    return;
  }
  const image = photo ? { mime: photo[1]!, data: Buffer.from(photo[2]!, "base64") } : undefined;
  if (image && image.data.length > 5 * 1024 * 1024) {
    res.status(400).json({ error: "WhatsApp accepts photos up to 5 MB" });
    return;
  }
  if ((!text && !image) || text.length > 4096) {
    res.status(400).json({ error: "Message must be 1 to 4096 characters" });
    return;
  }
  if (!config.whatsapp.enabled) {
    res.status(400).json({ error: "WhatsApp sending is not configured" });
    return;
  }
  try {
    await sendTeamMessage(req.params.customer, text, image);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// The AI answers customers left without a reply (not the chats the team is handling).
dashboardApi.post("/answer-waiting", (_req, res) => {
  if (!aiRepliesEnabled()) {
    res.status(400).json({ error: "AI replies are off" });
    return;
  }
  res.json(answerWaiting());
});

// Lessons from the team's answers to handoffs (learning.ts): the owner approves, edits or ignores them.
dashboardApi.get("/learning", (_req, res) => {
  res.json(lessonsView());
});

dashboardApi.post("/learning/:id/approve", (req, res) => {
  const lesson = approveLesson(Number(req.params.id), String(req.body?.question ?? ""), String(req.body?.answer ?? ""));
  if (!lesson) {
    res.status(400).json({ error: "question and answer are required" });
    return;
  }
  res.json(lesson);
});

dashboardApi.post("/learning/:id/ignore", (req, res) => {
  ignoreLesson(Number(req.params.id));
  res.json({ ok: true });
});

dashboardApi.get("/handoffs", (req, res) => {
  res.json(queries.handoffs(intParam(req.query.days, 7, 90)));
});

dashboardApi.get("/orders", (req, res) => {
  const status = ORDER_STATUSES.find((s) => s === req.query.status);
  // unsent=1 is the older form of darb=unsent.
  const darb = queries.DARB_FILTERS.find((f) => f === req.query.darb) ?? (req.query.unsent === "1" ? "unsent" : undefined);
  res.json({
    ...queries.orders({
      status,
      darb,
      payment: req.query.payment === "cash" || req.query.payment === "transfer" ? req.query.payment : undefined,
      source: req.query.source === "ai" || req.query.source === "team" ? req.query.source : undefined,
      q: String(req.query.q ?? "").slice(0, 100),
      limit: intParam(req.query.limit, 200, 1000),
    }),
    darb: config.darb.enabled,
  });
});

// The orders as an Excel file. from / to: local days (YYYY-MM-DD, both included); status: one status or all.
function sheetRange(query: Record<string, unknown>): SheetRange {
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) - config.dashboard.timezoneOffsetHours * 3_600_000 : undefined);
  const from = day(query.from) ?? 0;
  const to = (day(query.to) ?? queries.localDayStart(0)) + 86_400_000;
  return { from, to: Math.max(from + 1, to), status: ORDER_STATUSES.find((s) => s === query.status) };
}

dashboardApi.get("/orders/export", async (req, res) => {
  const range = sheetRange(req.query);
  const { file } = await ordersWorkbook(range);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${sheetName(range)}"`);
  res.send(file);
});

// Leads: everyone who wrote to us or ordered. filter: all | ordered | no_order | ad; from / to as for the orders sheet
// (on the last activity).
const LEAD_FILTERS: queries.LeadFilter[] = ["all", "ordered", "no_order", "ad"];
function leadsQuery(query: Record<string, unknown>) {
  const range = sheetRange(query);
  return {
    filter: LEAD_FILTERS.find((f) => f === query.filter) ?? "all",
    q: typeof query.q === "string" ? query.q.slice(0, 100) : "",
    from: range.from || undefined,
    to: query.to ? range.to : undefined,
    range,
  };
}

dashboardApi.get("/leads", (req, res) => {
  res.json(queries.leads(leadsQuery(req.query)));
});

dashboardApi.get("/leads/export", async (req, res) => {
  const opts = leadsQuery(req.query);
  const { leads } = queries.leads(opts);
  const { from, to } = opts.range;
  const days = !from ? "كل الفترة" : queries.localDay(from) === queries.localDay(to - 1) ? queries.localDay(from) : `من ${queries.localDay(from)} لـ ${queries.localDay(to - 1)}`;
  const label = { all: "", ordered: " · يلي طلبو", no_order: " · يلي ما طلبو", ad: " · من الإعلانات" }[opts.filter];
  const file = await leadsWorkbook(leads, days + label);
  const name = !from ? `leads-all-${queries.localDay(Date.now())}` : `leads-${queries.localDay(from)}_${queries.localDay(to - 1)}`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(file);
});

// Sends the last 24 hours' sheet to the Telegram group now (the same file as the daily one).
dashboardApi.post("/orders/export/telegram", async (_req, res) => {
  if (!telegramChatId()) {
    res.status(400).json({ error: "التلغرام مش مربوط (الإعدادات ← التنبيهات)" });
    return;
  }
  res.json({ orders: await sendDailySheet() });
});

// An order from the dashboard form (the team closed the sale, or corrects an order). Returns an error message if invalid.
function orderFields(body: Record<string, unknown> | undefined): OrderFields | string {
  const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const items = (Array.isArray(body?.items) ? (body.items as Record<string, unknown>[]) : [])
    .map((i) => ({
      product: str(i?.product, 100),
      color: str(i?.color, 100),
      size: str(i?.size, 20),
      quantity: Math.max(1, Math.min(1000, Math.round(Number(i?.quantity) || 1))),
    }))
    .filter((i) => i.product || i.color || i.size);
  const fields = {
    name: str(body?.name, 200),
    phone: latinDigits(str(body?.phone, 40)),
    city: str(body?.city, 100),
    address: str(body?.address),
    items,
    total: str(body?.total, 100),
    notes: str(body?.notes, 2000),
    payment: body?.payment === "transfer" ? ("transfer" as const) : ("cash" as const),
  };
  if (!fields.phone.replace(/\D/g, "")) return "اكتب رقم الزبون";
  if (!items.length) return "اكتب شو طلب (اللون والمقاس)";
  return fields;
}

// 0912345678 → 218912345678 (the chat's id); other numbers: digits only.
function customerFromPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  return /^09\d{8}$/.test(digits) ? `218${digits.slice(1)}` : digits;
}

dashboardApi.post("/orders", async (req, res) => {
  const fields = orderFields(req.body);
  if (typeof fields === "string") {
    res.status(400).json({ error: fields });
    return;
  }
  // A number, or the user ID of a customer who writes from a WhatsApp username ("LY.2863…"), kept as it is.
  const given = String(req.body?.customer ?? "").trim();
  const customer = (/^[A-Z]{2}\.\d+$/.test(given) ? given : given.replace(/\D/g, "")) || customerFromPhone(fields.phone);
  const status = ORDER_STATUSES.find((s) => s === req.body?.status) ?? "confirmed";
  const id = saveOrder({ customer, channel: channelOf(customer), ...fields, source: "team", status });
  log(`wa:${customer}`, `order #${id} recorded by the team (${status})`);
  notifyOrder(id, customer, fields, true);
  // The confirmation to the customer, written in the form, sent from our number like a team message
  // (so the AI also sees the order was taken).
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 2000) : "";
  if (message) {
    try {
      await sendTeamMessage(customer, message);
      log(`wa:${customer}`, `order #${id}: confirmation sent to the customer`);
    } catch (error) {
      res.json({ id, messageError: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  res.json({ id });
});

dashboardApi.put("/orders/:id", (req, res) => {
  const fields = orderFields(req.body);
  if (typeof fields === "string") {
    res.status(400).json({ error: fields });
    return;
  }
  if (!updateOrder(Number(req.params.id), fields)) {
    res.status(404).json({ error: "Unknown order" });
    return;
  }
  log("dashboard", `order #${req.params.id} edited`);
  res.json({ ok: true });
});

// The AI reads the chat and fills the order form; the team checks it and saves.
dashboardApi.post("/conversations/:customer/order-draft", async (req, res) => {
  const customer = req.params.customer;
  const rows = (
    db.prepare("SELECT source, text FROM messages WHERE customer = ? ORDER BY id DESC LIMIT 80").all(customer) as { source: string; text: string }[]
  ).reverse();
  if (!rows.length) {
    res.status(404).json({ error: "No messages in this chat" });
    return;
  }
  const label: Record<string, string> = { customer: "CUSTOMER", ai: "BOT", staff: "TEAM" };
  const transcript = rows.map((m) => `${label[m.source] ?? m.source}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  try {
    const { draft, usage } = await draftOrder(transcript, localPhone(customer));
    recordAiCall({ customer, channel: channelOf(customer), action: "draft", usage });
    if (!draft) {
      res.status(502).json({ error: "ما قدر يقرا المحادثة، عبّي الطلب بإيدك" });
      return;
    }
    res.json(draft);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Darb Assabil: what would be sent (guessed city/area, product lines, amount), its delivery price, and sending it.
function darbInput(body: Record<string, unknown> | undefined): ShipmentInput {
  return {
    city: String(body?.city ?? "").trim(),
    area: String(body?.area ?? "").trim(),
    notes: String(body?.notes ?? "").trim(),
    total: Number(body?.total),
    payment: body?.payment === "cash" || body?.payment === "transfer" ? body.payment : "",
  };
}

async function darbRoute(res: express.Response, run: () => Promise<unknown>) {
  if (!config.darb.enabled) {
    res.status(400).json({ error: "درب السبيل مش مربوط" });
    return;
  }
  try {
    res.json(await run());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

dashboardApi.get("/orders/:id/darb", (req, res) => darbRoute(res, () => shipmentPreview(Number(req.params.id))));
dashboardApi.post("/orders/:id/darb/quote", (req, res) => darbRoute(res, () => shipmentQuote(Number(req.params.id), darbInput(req.body))));
dashboardApi.post("/orders/:id/darb", (req, res) =>
  darbRoute(res, async () => {
    const shipment = await sendToDarb(Number(req.params.id), darbInput(req.body));
    // The customer hears it left once the sync has the shipment (minutes later); right now it isn't synced yet.
    void syncDarb().catch(() => {});
    return shipment;
  }),
);
dashboardApi.post("/orders/:id/darb/update", (req, res) => darbRoute(res, () => updateDarbShipment(Number(req.params.id), darbInput(req.body))));
// Tracking: an order sent by hand gets its shipment by number; the shipment's timeline; the money page.
dashboardApi.post("/orders/:id/darb/link", async (req, res) => {
  try {
    const linked = await linkDarb(Number(req.params.id), String(req.body?.number ?? ""), req.body?.force === true);
    // An order sent before: the customer isn't told now what already happened.
    markTold(Number(req.params.id));
    res.json(linked);
  } catch (error) {
    // 409: the shipment is for another phone; the dashboard asks and sends force.
    res.status(error instanceof PhoneMismatch ? 409 : 502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
// A cancelled or refused shipment given to another order in the same city (src/darbRedirect.ts).
dashboardApi.get("/darb/redirects", (_req, res) => darbRoute(res, () => redirectCandidates()));
dashboardApi.get("/orders/:id/darb/redirect", (req, res) => darbRoute(res, () => redirectMatches(Number(req.params.id))));
dashboardApi.post("/orders/:id/darb/redirect", (req, res) =>
  darbRoute(res, () =>
    redirectShipment(Number(req.params.id), Number(req.body?.to), {
      area: String(req.body?.area ?? ""),
      notes: String(req.body?.notes ?? "").slice(0, 900),
      total: Math.max(0, Number(req.body?.total) || 0),
      payment: req.body?.payment === "transfer" ? "transfer" : "cash",
    }),
  ),
);
dashboardApi.post("/orders/:id/darb/unlink", (req, res) => darbRoute(res, async () => unlinkDarb(Number(req.params.id))));
dashboardApi.get("/orders/:id/darb/matches", (req, res) => darbRoute(res, async () => darbMatches(Number(req.params.id))));
dashboardApi.get("/orders/:id/darb/track", (req, res) => darbRoute(res, () => trackOrder(Number(req.params.id))));
dashboardApi.post("/darb/sync", (_req, res) => darbRoute(res, () => syncDarb()));
dashboardApi.get("/money", (req, res) =>
  darbRoute(res, () => darbMoney(Number(req.query.from) || undefined, Number(req.query.to) || undefined)),
);

dashboardApi.patch("/orders/:id", (req, res) => {
  const status = ORDER_STATUSES.find((s) => s === req.body?.status) as OrderStatus | undefined;
  if (!status || !setOrderStatus(Number(req.params.id), status)) {
    res.status(400).json({ error: "Unknown order or status" });
    return;
  }
  log("dashboard", `order #${req.params.id} marked ${status}`);
  // A cancelled order whose shipment is out: someone in the same city may take it instead (Telegram).
  if (status === "cancelled") void tellRedirectChance(Number(req.params.id)).catch(() => {});
  res.json({ ok: true });
});

dashboardApi.get("/events", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  res.json(queries.events({ q, limit: intParam(req.query.limit, 200, 1000) }));
});

// Photos and voice notes of a chat (and catalog photos), for the inbox.
dashboardApi.get("/media/:folder/:file", (req, res) => {
  const full = dataPath(`${req.params.folder}/${req.params.file}`);
  if (!full || !fs.existsSync(full)) {
    res.status(404).end();
    return;
  }
  res.sendFile(full, { maxAge: "1d" });
});

// --- Product photos -------------------------------------------------------------------

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

dashboardApi.get("/catalog", (_req, res) => {
  res.json(listCatalog());
});

dashboardApi.post("/catalog", (req, res) => {
  const { product, name, description, mime, data } = req.body ?? {};
  const bytes = typeof data === "string" ? Buffer.from(data, "base64") : undefined;
  if (typeof name !== "string" || !name.trim() || !PHOTO_TYPES.includes(mime) || !bytes?.length) {
    res.status(400).json({ error: "Name and a JPG/PNG/WebP photo are required" });
    return;
  }
  // WhatsApp's limit for images is 5 MB.
  if (bytes.length > 5 * 1024 * 1024) {
    res.status(400).json({ error: "Photo must be under 5 MB" });
    return;
  }
  const item = addCatalogItem({ product: String(product ?? "").trim(), name: name.trim(), description: String(description ?? "").trim(), data: bytes, mime });
  log("dashboard", `product photo added: ${item.id} ${item.name}`);
  res.json(item);
});

dashboardApi.patch("/catalog/:id", (req, res) => {
  const item = updateCatalogItem(req.params.id, {
    product: typeof req.body?.product === "string" ? req.body.product.trim() : undefined,
    name: typeof req.body?.name === "string" ? req.body.name.trim() : undefined,
    description: typeof req.body?.description === "string" ? req.body.description.trim() : undefined,
  });
  if (!item) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  res.json(item);
});

dashboardApi.delete("/catalog/:id", (req, res) => {
  if (!deleteCatalogItem(req.params.id)) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  log("dashboard", `product photo deleted: ${req.params.id}`);
  res.json({ ok: true });
});

// --- Stock -------------------------------------------------------------------------

// Each product kept in stock with its colors, sizes and pieces left, plus what open orders (new / confirmed,
// not sent yet) hold of each. Suggestions: the products and colors of the product photos.
dashboardApi.get("/stock", (_req, res) => {
  const rows = listStock();
  const held = new Map<string, number>();
  const open = db.prepare("SELECT items FROM orders WHERE status IN ('new', 'confirmed') AND stock_applied = 1").all() as { items: string }[];
  for (const o of open) {
    for (const item of JSON.parse(o.items) as OrderItem[]) {
      const row = stockRowFor(item, rows);
      if (row) held.set(`${row.product}|${row.color}|${row.size}`, (held.get(`${row.product}|${row.color}|${row.size}`) ?? 0) + item.quantity);
    }
  }
  const products = [...new Set(rows.map((r) => r.product))].map((product) => {
    const mine = rows.filter((r) => r.product === product);
    return {
      product,
      colors: [...new Set(mine.map((r) => r.color))],
      sizes: [...new Set(mine.map((r) => r.size))],
      cells: mine.map((r) => ({ color: r.color, size: r.size, quantity: r.quantity, held: held.get(`${product}|${r.color}|${r.size}`) ?? 0 })),
      updatedAt: Math.max(...mine.map((r) => r.updatedAt)),
    };
  });
  const catalog = listCatalog();
  const suggestions = [...new Set(catalog.map((c) => c.product?.trim() ?? "").filter(Boolean))].map((product) => ({
    product,
    colors: [...new Set(catalog.filter((c) => c.product?.trim() === product).map((c) => c.name.replace(/^اللون\s*[:：]?\s*/, "").trim()))],
  }));
  res.json({ products, suggestions });
});

// Saves one product's whole table: { colors, sizes, cells: [{ color, size, quantity }] }.
dashboardApi.put("/stock/:product", (req, res) => {
  const product = String(req.params.product).trim().slice(0, 100);
  const cells = Array.isArray(req.body?.cells) ? (req.body.cells as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const rows = cells
    .map((c) => ({ color: String(c?.color ?? "").trim().slice(0, 60), size: String(c?.size ?? "").trim().slice(0, 20), quantity: Number(c?.quantity) }))
    .filter((c) => c.color && c.size && Number.isFinite(c.quantity) && Math.abs(c.quantity) < 100_000)
    .filter((c) => {
      const key = `${stockName(c.color)}|${stockName(c.size)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!product || !rows.length) {
    res.status(400).json({ error: "اكتب اسم المنتج، ولون ومقاس واحد على الأقل" });
    return;
  }
  setProductStock(product, rows);
  log("dashboard", `stock saved for ${product}: ${rows.reduce((n, r) => n + Math.max(0, r.quantity), 0)} pieces in ${rows.length} color/size`);
  res.json({ ok: true });
});

// What of these items we don't have (the team's order form warns before saving).
dashboardApi.post("/stock/check", (req, res) => {
  const items = (Array.isArray(req.body?.items) ? (req.body.items as Record<string, unknown>[]) : []).map((i) => ({
    product: String(i?.product ?? ""),
    color: String(i?.color ?? ""),
    size: String(i?.size ?? ""),
    quantity: Math.max(1, Math.round(Number(i?.quantity) || 1)),
  }));
  res.json({ missing: missingStock(items) });
});

dashboardApi.delete("/stock/:product", (req, res) => {
  deleteProductStock(String(req.params.product));
  log("dashboard", `stock no longer kept for ${req.params.product}`);
  res.json({ ok: true });
});

// --- Settings ----------------------------------------------------------------------

function settingsView() {
  let historySync: unknown = null;
  try {
    historySync = JSON.parse(getSetting("history_sync") ?? "null");
  } catch {}
  return {
    aiReplies: aiRepliesEnabled(),
    // Messenger and Instagram can be listen-only on their own.
    channelReplies: Object.fromEntries(META_CHANNELS.map((c) => [c, channelRepliesEnabled(c)])),
    testNumbers: testNumbers(),
    model: config.openai.model,
    reasoningEffort: config.openai.reasoningEffort,
    humanPauseHours: config.whatsapp.humanPauseHours,
    teamPauseMinutes: teamPauseMinutes(),
    debounceMs: config.debounceMs,
    historyLimit: config.historyLimit,
    timezoneOffsetHours: config.dashboard.timezoneOffsetHours,
    channels: {
      whatsapp: config.whatsapp.enabled ? config.whatsapp.provider : null,
      whatsappPhoneNumberId: config.whatsapp.phoneNumberId ?? null,
      chatwoot: config.chatwoot.enabled,
      meta: config.meta.enabled,
      metaWebhook: config.meta.verifyToken && config.publicUrl ? `${config.publicUrl}/meta/webhook` : null,
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
  const pauseMinutes = Math.round(Number(body.teamPauseMinutes));
  if (body.teamPauseMinutes !== undefined && pauseMinutes >= 5 && pauseMinutes <= 24 * 60) {
    setTeamPauseMinutes(pauseMinutes);
    log("dashboard", `AI waits ${pauseMinutes} min after a team reply`);
  }
  for (const channel of META_CHANNELS) {
    const on = body.channelReplies?.[channel];
    if (typeof on === "boolean") {
      setChannelReplies(channel, on);
      log("dashboard", `AI replies on ${channel} turned ${on ? "on" : "off"}`);
    }
  }
  if (Array.isArray(body.testNumbers)) {
    // WhatsApp numbers as digits only, with country code (e.g. 218912345678).
    // "00218..." is the same number as "+218...". Messenger / Instagram chats as "fb:<id>" / "ig:<id>".
    const ids = (body.testNumbers as unknown[]).map((n) => String(n).trim());
    const digits = ids.map((n) => (/^(fb|ig):\d+$/.test(n) ? n : n.replace(/\D/g, "").replace(/^00/, "")));
    const numbers = [...new Set(digits)].filter((n) => /^(fb|ig):\d+$/.test(n) || (n.length >= 8 && n.length <= 15));
    setTestNumbers(numbers);
    log("dashboard", numbers.length ? `test mode on for ${numbers.length} number(s)` : "test mode off");
  }
  res.json(settingsView());
});

// --- Telegram notifications ------------------------------------------------------------------

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

dashboardApi.get("/telegram", async (_req, res) => {
  res.json(await telegramStatus());
});

dashboardApi.put("/telegram", async (req, res) => {
  const body = req.body ?? {};
  try {
    if (typeof body.token === "string" && body.token.trim()) {
      const bot = await setTelegramToken(body.token.trim());
      log("dashboard", `Telegram bot set: @${bot.username}`);
    }
    if (typeof body.chatId === "string" || typeof body.chatId === "number") {
      const chatId = String(body.chatId).trim();
      if (!/^-?\d{3,20}$|^@\w{4,}$/.test(chatId)) {
        res.status(400).json({ error: "Group id looks wrong" });
        return;
      }
      setTelegramChat(chatId);
      log("dashboard", `Telegram group set: ${chatId}`);
    }
    if (Array.isArray(body.muted)) setMutedKinds(body.muted.map(String));
    res.json(await telegramStatus());
  } catch (error) {
    res.status(400).json({ error: `Telegram: ${errorMessage(error)}` });
  }
});

dashboardApi.get("/telegram/groups", async (_req, res) => {
  try {
    res.json(await findGroups());
  } catch (error) {
    res.status(400).json({ error: `Telegram: ${errorMessage(error)}` });
  }
});

dashboardApi.post("/telegram/test", async (_req, res) => {
  try {
    await sendTest();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: `Telegram: ${errorMessage(error)}` });
  }
});

// --- Supervisor ------------------------------------------------------------------------------------

dashboardApi.get("/supervisor", (req, res) => {
  res.json(supervisorView(intParam(req.query.days, 7, 90)));
});

dashboardApi.put("/supervisor/settings", (req, res) => {
  const settings = saveSupervisorSettings(req.body ?? {});
  log("dashboard", "supervisor settings changed");
  res.json(settings);
});

// Review the latest chats now (instead of waiting for the next half hour).
dashboardApi.post("/supervisor/run", async (_req, res) => {
  try {
    runChecks();
    res.json({ reviewed: await runReviews({ force: true, max: 20 }) });
  } catch (error) {
    res.status(502).json({ error: errorMessage(error) });
  }
});

dashboardApi.post("/supervisor/report", async (_req, res) => {
  try {
    res.json({ id: await generateReport() });
  } catch (error) {
    res.status(502).json({ error: errorMessage(error) });
  }
});

dashboardApi.post("/supervisor/alerts/:id/resolve", (req, res) => {
  res.json({ ok: resolveAlert(Number(req.params.id)) });
});

// --- Automatic follow-up ---------------------------------------------------------------------------

dashboardApi.get("/followup", (_req, res) => {
  res.json({ settings: followUpSettings(), stats: followUpStats(7), tracking: { ...trackingSettings(), stats: trackingStats(7) } });
});

dashboardApi.put("/followup", (req, res) => {
  const settings = saveFollowUpSettings(req.body ?? {});
  if (req.body?.tracking) {
    const tracking = saveTrackingSettings(req.body.tracking);
    log("dashboard", `order tracking updates turned ${tracking.enabled ? "on" : "off"}`);
  } else log("dashboard", "follow-up settings changed");
  res.json({ settings, stats: followUpStats(7), tracking: { ...trackingSettings(), stats: trackingStats(7) } });
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

// The test chat from the dashboard: customer and business turns, with test photos only on customer turns.
function playgroundHistory(body: unknown): ChatTurn[] {
  const raw = (body as { messages?: unknown } | undefined)?.messages;
  const turns = Array.isArray(raw) ? raw : [];
  return turns
    .slice(-config.historyLimit)
    .map((t) => t as { role?: unknown; text?: unknown; image?: unknown })
    .filter((t) => (t.role === "customer" || t.role === "business") && typeof t.text === "string")
    .map((t) => {
      const turn: ChatTurn = { role: t.role as ChatTurn["role"], text: String(t.text).slice(0, 4000) || "[sent a photo]" };
      // A test photo, as a data URL, only on customer turns.
      if (t.role === "customer" && typeof t.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(t.image)) {
        turn.image = t.image;
      }
      return turn;
    });
}

// Pretend to be a new customer, a returning one, or one with an order (for testing the opening).
function playgroundBackground(customerType: unknown): string {
  return (
    {
      new: "New customer: first time writing to us (today).",
      returning: "Returning customer: wrote to us before (12 earlier messages, first 20 days ago).",
      order: "Returning customer: wrote to us before (15 earlier messages, first 5 days ago).\nHas order #1 (status: confirmed, 3 days ago).",
    }[String(customerType)] ?? "New customer: first time writing to us (today)."
  );
}

dashboardApi.post("/playground", async (req, res) => {
  const history = playgroundHistory(req.body);
  if (!history.length || history.at(-1)?.role !== "customer") {
    res.status(400).json({ error: "The last message must be from the customer" });
    return;
  }
  try {
    res.json(await decideReply(history, { background: playgroundBackground(req.body?.customerType) }));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// A test voice note recorded in the browser → the text the AI would get, like a WhatsApp voice note.
dashboardApi.post("/playground/voice", async (req, res) => {
  const match = /^data:(audio\/[\w.+-]+)(?:;[^,;]*)*;base64,(.+)$/.exec(String(req.body?.audio ?? ""));
  if (!match) {
    res.status(400).json({ error: "Send the recording as an audio data URL" });
    return;
  }
  try {
    const heard = await transcribe(Buffer.from(match[2]!, "base64"), match[1]!);
    res.json({ text: heard ? `[voice note] ${heard}` : "[voice note, could not understand it]" });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// What the automatic follow-up would send if the customer went quiet now (text is missing when it would skip).
dashboardApi.post("/playground/followup", async (req, res) => {
  const history = playgroundHistory(req.body);
  if (!history.length || history.at(-1)?.role !== "business") {
    res.status(400).json({ error: "The last message must be ours" });
    return;
  }
  try {
    const silentHours = Math.max(1, Math.round(followUpSettings().afterMinutes / 60));
    res.json(await writeFollowUp(history, { background: playgroundBackground(req.body?.customerType), silentHours }));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
