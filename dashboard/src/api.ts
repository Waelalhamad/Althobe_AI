// Typed calls to the agent server's /dashboard/api.
const BASE = "/dashboard/api";
// Conversations per page in the inbox list.
export const PAGE = 200;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

// --- Types (match src/dashboard on the server) -------------------------------------

export type Totals = {
  conversations: number;
  newCustomers: number;
  customerMessages: number;
  staffMessages: number;
  aiReplies: number;
  handoffs: number;
  orders: number;
  teamOrders?: number;
  errors: number;
  aiConversations: number;
  aiOnlyConversations: number;
  costUsd: number;
  tokens: { prompt: number; cached: number; completion: number; reasoning: number };
  latency: { avgMs: number; p50Ms: number; p90Ms: number };
};

export type DailyRow = {
  day: string;
  conversations: number;
  customerMessages: number;
  staffMessages: number;
  aiReplies: number;
  handoffs: number;
  orders: number;
  errors: number;
  costUsd: number;
};

export type AiCallRow = { customer: string; channel: string; action: "reply" | "handoff" | "error"; reason: string | null; at: number };

export type FunnelDay = { day: string; chats: number; beforePrice: number; afterPrice: number; booking: number; ordered: number };

// Local dates (YYYY-MM-DD, both included) and optionally only some hours of each day (hourTo excluded, 0 = midnight).
export type OverviewQuery = { from: string; to: string; hourFrom?: number; hourTo?: number };

export type Overview = {
  range: { from: number; to: number; hourFrom?: number; hourTo?: number };
  funnel: FunnelDay[];
  funnelTotal: FunnelDay;
  previousFunnelTotal: FunnelDay;
  period: Totals;
  // The same numbers for the period just before (same length, same hours).
  previous: Totals;
  daily: DailyRow[];
  hourly: { hour: number; customerMessages: number }[];
  recentHandoffs: AiCallRow[];
};

export type ConversationFilter = "all" | "unanswered" | "ai" | "paused" | "handoff";

export type Channel = "whatsapp" | "messenger" | "instagram" | "chatwoot";
export const CHANNEL_LABEL: Record<Channel, string> = { whatsapp: "واتساب", messenger: "ماسنجر", instagram: "إنستغرام", chatwoot: "Instagram / Messenger" };
export function channelOf(customer: string): Channel {
  if (customer.startsWith("fb:")) return "messenger";
  if (customer.startsWith("ig:")) return "instagram";
  if (customer.startsWith("cw:")) return "chatwoot";
  return "whatsapp";
}

export type ConversationSummary = {
  customer: string;
  // The WhatsApp / Facebook / Instagram profile name.
  name: string;
  total: number;
  lastAt: number;
  lastText: string;
  lastSource: "customer" | "ai" | "staff";
  pausedUntil: number | null;
  pauseReason: string | null;
};

export type Message = {
  id: number;
  role: "customer" | "business";
  source: "customer" | "ai" | "staff";
  text: string;
  at: number;
  history: number;
  mediaType: "image" | "audio" | "video" | "document" | "sticker" | null;
  mediaFile: string | null; // "media/x.jpg" or "catalog/x.jpg"
};

export type OrderStatus = "new" | "confirmed" | "delivered" | "cancelled";
// product: which product (empty on orders saved before there could be several).
export type OrderItem = { product?: string; color: string; size: string; quantity: number };
export type Order = {
  id: number;
  customer: string;
  channel: Channel;
  name: string;
  phone: string;
  city: string;
  address: string;
  items: OrderItem[];
  total: string;
  notes: string;
  // How the customer pays (empty on orders from before it was asked).
  payment?: Payment | "";
  status: OrderStatus;
  source?: "ai" | "team";
  // The Darb Assabil shipment made from it.
  darbRef?: string | null;
  darbStatus?: string | null;
  darbAt?: number | null;
  // From Darb's copy (synced every 15 minutes): the latest event, and the money.
  // The first number ("SH2457684"); darbRef becomes the branch's number once the branch takes the shipment.
  darbSh?: string | null;
  darbEvent?: string | null;
  darbEventAt?: number | null;
  darbPaidAt?: number | null;
  darbAmount?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Payment = "cash" | "transfer";
export const PAYMENT_LABEL: Record<Payment, string> = { cash: "كاش عند الاستلام", transfer: "تحويل مصرفي" };

// Stock: pieces left per color and size; held = pieces in open orders not sent yet.
export type StockProduct = {
  product: string;
  colors: string[];
  sizes: string[];
  cells: { color: string; size: string; quantity: number; held: number }[];
  updatedAt: number;
};

export type RedirectCandidate = { orderId: number; reference: string; city: string; matches: number };
export type RedirectMatch = {
  orderId: number;
  name: string;
  phone: string;
  status: OrderStatus;
  total: number;
  payment: Payment;
  address: string;
  area: string;
  shipment: { reference: string; status: string } | null;
  createdAt: number;
};
export type RedirectView = {
  shipment: { reference: string; sh: string | null; status: string; city: string; area: string };
  pickedUp: boolean;
  areas: string[];
  matches: RedirectMatch[];
};

// Where an order's shipment is at Darb Assabil (the orders page filter).
export type DarbFilter = "unsent" | "waiting" | "on_way" | "delayed" | "delivered" | "paid" | "returned";
export type OrderFilters = { status?: OrderStatus; darb?: DarbFilter; payment?: Payment; source?: "ai" | "team"; q?: string };

export type DarbZone = { city: string; areas: string[] };
export type DarbPreview = {
  zones: DarbZone[];
  guess?: { city: string; area: string };
  previous?: { city: string; area: string } | null;
  notes: string;
  internalNotes: string;
  payment: Payment;
  total: number;
  phone: string;
  lines: { title: string; quantity: number }[];
  darbRef: string | null;
};
export type DarbShipment = { city: string; area: string; notes: string; total: number; payment?: Payment | "" };

// A shipment as Darb Assabil has it (copied every 15 minutes), and where its money stands.
export type MoneyStage = "paid" | "at_darb" | "on_way" | "returned" | "cancelled";
export type DarbTracked = {
  id: string;
  reference: string;
  sh: string | null;
  status: string;
  stage: MoneyStage;
  name: string;
  phone: string;
  city: string;
  area: string;
  amount: number;
  shipping: number;
  deliveredAt: number | null;
  paidAt: number | null;
  payoutRef: string | null;
  lastEvent: string;
  lastEventAt: number | null;
  createdAt: number;
  orderId: number | null;
};
export type DarbTimeline = DarbTracked & { timeline: { type: string; text: string; at: number }[] };
export type Money = {
  stages: Record<MoneyStage, { count: number; amount: number }>;
  shipping: number;
  payouts: { reference: string | null; at: number; amount: number; count: number }[];
  transfers: { count: number; amount: number };
  wallet: number | null;
  lastSync: number | null;
  shipments: DarbTracked[];
};

// What the team fills in the order form (and what the AI drafts from a chat).
export type OrderInput = Pick<Order, "name" | "phone" | "city" | "address" | "items" | "total" | "notes" | "payment">;

export type CatalogItem = {
  id: string;
  product?: string;
  name: string;
  description: string;
  file: string;
  mime: string;
  createdAt: number;
};

// URL of a stored photo/voice note (needs the login cookie).
export const mediaUrl = (file: string) => `${BASE}/media/${file}`;

export type ConversationDetail = {
  customer: string;
  name: string;
  username: string;
  messages: Message[];
  aiCalls: { action: string; reason: string | null; latencyMs: number; promptTokens: number; completionTokens: number; at: number }[];
  pausedUntil: number | null;
  pauseReason: string | null;
  windowOpenUntil: number | null;
};

export type Settings = {
  aiReplies: boolean;
  testNumbers: string[];
  model: string;
  reasoningEffort: string;
  humanPauseHours: number;
  teamPauseMinutes: number;
  debounceMs: number;
  historyLimit: number;
  timezoneOffsetHours: number;
  channels: { whatsapp: string | null; whatsappPhoneNumberId: string | null; chatwoot: boolean; meta: boolean; metaWebhook: string | null; openai: boolean };
  channelReplies: { messenger: boolean; instagram: boolean };
  historySync: { phase?: number; chunk?: number; progress?: number; error?: string; at: number } | null;
};

export type Lesson = {
  id: number;
  customer: string;
  status: "waiting" | "pending" | "approved" | "ignored" | "skipped" | "unanswered" | "merged";
  reason: string;
  question: string;
  answer: string;
  teamReply: string;
  note: string;
  seen: number;
  retest: string;
  asked: string;
  createdAt: number;
  updatedAt: number;
};
export type LessonsView = { pending: Lesson[]; unanswered: Lesson[]; waiting: number; approved: Lesson[]; done: Lesson[] };
export type KnowledgeFile = { name: string; size: number; updatedAt: number };
export type EventRow = { id: number; conversation: string; message: string; at: number };
export type ChatTurn = { role: "customer" | "business"; text: string; image?: string };
export type LeadFilter = "all" | "ordered" | "no_order" | "ad";
export type Lead = {
  customer: string;
  name: string;
  waName: string;
  username: string;
  phone: string;
  city: string;
  firstAt: number;
  lastAt: number;
  lastText: string;
  messages: number;
  fromAd: boolean;
  orders: number;
  lastStatus: OrderStatus | null;
  spent: number;
  stage: "ordered" | "cancelled" | "no_order";
};
export type LeadsQuery = { filter: LeadFilter; q?: string; from?: string; to?: string };
const leadsParams = (q: LeadsQuery) => new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])));

export type Decision =
  | (
      | { action: "reply"; text: string; photos: string[]; confidence?: number }
      | { action: "none"; reason: string }
      | { action: "handoff"; reason: string; messageToCustomer: string; silent?: boolean }
      | {
          action: "order";
          order: { name: string; phone: string; city: string; address: string; items: OrderItem[]; total: string; notes: string };
          messageToCustomer: string;
        }
    ) & {
      usage?: { model: string; promptTokens: number; cachedTokens: number; completionTokens: number; reasoningTokens: number; latencyMs: number };
    };

// --- Calls ------------------------------------------------------------------------------

export const api = {
  login: (password: string) => post<{ ok: true }>("/login", { password }),
  logout: () => post<{ ok: true }>("/logout"),
  overview: (q: OverviewQuery) =>
    request<Overview>(
      `/overview?${new URLSearchParams({ from: q.from, to: q.to, ...(q.hourFrom !== undefined && q.hourTo !== undefined ? { hourFrom: String(q.hourFrom), hourTo: String(q.hourTo) } : {}) })}`,
    ),
  conversations: (filter: ConversationFilter, q: string, limit = PAGE) =>
    request<ConversationSummary[]>(`/conversations?filter=${filter}&q=${encodeURIComponent(q)}&limit=${limit}`),
  conversation: (customer: string) => request<ConversationDetail>(`/conversations/${encodeURIComponent(customer)}`),
  pause: (customer: string, hours?: number) => post(`/conversations/${encodeURIComponent(customer)}/pause`, { hours }),
  answerWaiting: () => post<{ queued: number; withTeam: number }>("/answer-waiting"),
  resume: (customer: string) => post(`/conversations/${encodeURIComponent(customer)}/resume`),
  send: (customer: string, text: string, image?: string) => post(`/conversations/${encodeURIComponent(customer)}/send`, { text, image }),
  learning: () => request<LessonsView>("/learning"),
  approveLesson: (id: number, question: string, answer: string) => post<Lesson>(`/learning/${id}/approve`, { question, answer }),
  ignoreLesson: (id: number) => post(`/learning/${id}/ignore`),
  handoffs: (days: number) => request<(AiCallRow & { id: number; stillWithTeam: boolean })[]>(`/handoffs?days=${days}`),
  events: (q: string) => request<EventRow[]>(`/events?q=${encodeURIComponent(q)}&limit=300`),
  settings: () => request<Settings>("/settings"),
  saveSettings: (patch: Partial<Pick<Settings, "aiReplies" | "testNumbers" | "teamPauseMinutes" | "channelReplies">>) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  knowledge: () => request<KnowledgeFile[]>("/knowledge"),
  knowledgeFile: (name: string) => request<{ name: string; body: string }>(`/knowledge/${encodeURIComponent(name)}`),
  saveKnowledge: (name: string, body: string) =>
    request(`/knowledge/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ body }) }),
  deleteKnowledge: (name: string) => request(`/knowledge/${encodeURIComponent(name)}`, { method: "DELETE" }),
  stock: () => request<{ products: StockProduct[]; suggestions: { product: string; colors: string[] }[] }>("/stock"),
  saveStock: (product: string, cells: { color: string; size: string; quantity: number }[]) =>
    request(`/stock/${encodeURIComponent(product)}`, { method: "PUT", body: JSON.stringify({ cells }) }),
  checkStock: (items: OrderItem[]) => post<{ missing: string[] }>("/stock/check", { items }),
  deleteStock: (product: string) => request(`/stock/${encodeURIComponent(product)}`, { method: "DELETE" }),
  playground: (messages: ChatTurn[], customerType: "new" | "returning" | "order" = "new") =>
    post<Decision>("/playground", { messages, customerType }),
  orders: (f: OrderFilters = {}) =>
    request<{
      counts: Partial<Record<OrderStatus, number>>;
      darbCounts: Record<DarbFilter, number>;
      unsent: number;
      orders: Order[];
      darb: boolean;
    }>(`/orders?${new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => Boolean(e[1])))}`),
  darbPreview: (id: number) => request<DarbPreview>(`/orders/${id}/darb`),
  darbQuote: (id: number, s: DarbShipment) => post<{ shipping: number; charges: number }>(`/orders/${id}/darb/quote`, s),
  updateDarb: (id: number, s: DarbShipment) => post<{ ok: boolean }>(`/orders/${id}/darb/update`, s),
  sendToDarb: (id: number, s: DarbShipment) => post<{ reference: string; status: string }>(`/orders/${id}/darb`, s),
  linkDarb: (id: number, number: string, force = false) => post<DarbTracked>(`/orders/${id}/darb/link`, { number, force }),
  unlinkDarb: (id: number) => post<{ ok: boolean }>(`/orders/${id}/darb/unlink`),
  darbMatches: (id: number) => request<DarbTracked[]>(`/orders/${id}/darb/matches`),
  // A cancelled or refused shipment given to another order in the same city.
  darbRedirects: () => request<RedirectCandidate[]>("/darb/redirects"),
  redirectMatches: (id: number) => request<RedirectView>(`/orders/${id}/darb/redirect`),
  redirect: (id: number, body: { to: number; area: string; notes: string; total: number; payment: Payment }) =>
    post<{ ok: boolean; pickedUp: boolean; ownCancelled: string }>(`/orders/${id}/darb/redirect`, body),
  trackDarb: (id: number) => request<DarbTimeline>(`/orders/${id}/darb/track`),
  resendDarb: (id: number, s: DarbShipment) => post<{ id: string; reference: string }>(`/orders/${id}/darb/resend`, s),
  syncDarb: () => post<{ shipments: number; changes: number }>("/darb/sync"),
  money: (from?: number, to?: number) => request<Money>(`/money?${new URLSearchParams({ ...(from && { from: String(from) }), ...(to && { to: String(to) }) })}`),
  createOrder: (order: OrderInput & { customer?: string; status: OrderStatus; message?: string }) =>
    post<{ id: number; messageError?: string }>("/orders", order),
  updateOrder: (id: number, order: OrderInput) => request(`/orders/${id}`, { method: "PUT", body: JSON.stringify(order) }),
  ordersExportUrl: (q: { from?: string; to?: string; status?: OrderStatus }) =>
    `${BASE}/orders/export?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])))}`,
  sendOrdersSheet: () => post<{ orders: number }>("/orders/export/telegram"),
  leads: (q: LeadsQuery) => request<{ counts: Record<LeadFilter, number>; leads: Lead[] }>(`/leads?${leadsParams(q)}`),
  leadsExportUrl: (q: LeadsQuery) => `${BASE}/leads/export?${leadsParams(q)}`,
  orderDraft: (customer: string) => post<OrderInput>(`/conversations/${encodeURIComponent(customer)}/order-draft`),
  setOrderStatus: (id: number, status: OrderStatus) =>
    request(`/orders/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  catalog: () => request<CatalogItem[]>("/catalog"),
  addPhoto: (photo: { product: string; name: string; description: string; mime: string; data: string }) =>
    post<CatalogItem>("/catalog", photo),
  updatePhoto: (id: string, patch: { product?: string; name?: string; description?: string }) =>
    request<CatalogItem>(`/catalog/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePhoto: (id: string) => request(`/catalog/${id}`, { method: "DELETE" }),
  telegram: () => request<TelegramStatus>("/telegram"),
  saveTelegram: (patch: { token?: string; chatId?: string; muted?: NotifyKind[] }) =>
    request<TelegramStatus>("/telegram", { method: "PUT", body: JSON.stringify(patch) }),
  telegramGroups: () => request<TelegramChat[]>("/telegram/groups"),
  telegramTest: () => post<{ ok: true }>("/telegram/test"),
  supervisor: (days: number) => request<SupervisorView>(`/supervisor?days=${days}`),
  saveSupervisor: (patch: Partial<SupervisorSettings>) =>
    request<SupervisorSettings>("/supervisor/settings", { method: "PUT", body: JSON.stringify(patch) }),
  runSupervisor: () => post<{ reviewed: number }>("/supervisor/run"),
  supervisorReport: () => post<{ id: number }>("/supervisor/report"),
  resolveAlert: (id: number) => post(`/supervisor/alerts/${id}/resolve`),
  followUp: () => request<FollowUpView>("/followup"),
  saveFollowUp: (patch: Partial<FollowUpSettings> & { tracking?: { enabled: boolean } }) =>
    request<FollowUpView>("/followup", { method: "PUT", body: JSON.stringify(patch) }),
  playgroundVoice: (audio: string) => post<{ text: string }>("/playground/voice", { audio }),
  playgroundFollowUp: (messages: ChatTurn[], customerType: "new" | "returning" | "order" = "new") =>
    post<{ text?: string; usage?: NonNullable<Decision["usage"]> }>("/playground/followup", { messages, customerType }),
};

export type FollowUpSettings = { enabled: boolean; afterMinutes: number };
export type FollowUpView = {
  settings: FollowUpSettings;
  stats: {
    days: number;
    sent: number;
    replied: number;
    skipped: number;
    // The A/B test of two follow-up messages, since it started.
    test: { variant: "A" | "B"; sent: number; replied: number; ordered: number; since: number | null }[];
  };
  // Order tracking updates to customers (left with Darb, in their city, delivered).
  tracking: { enabled: boolean; stats: { days: number; sent: number; pending: number; skipped: number } };
};

// --- Telegram + supervisor -----------------------------------------------------------------

export type NotifyKind = "order" | "handoff" | "lesson" | "error" | "supervisor" | "report" | "sheet";
export type TelegramChat = { id: number; title?: string; type: string; username?: string };
export type TelegramStatus = {
  tokenSet: boolean;
  tokenHint: string | null;
  bot: { id: number; username: string; first_name: string } | null;
  chatId: string | null;
  chat: TelegramChat | null;
  error: string | null;
  muted: NotifyKind[];
  last: { ok: boolean; error?: string; at: number } | null;
};

export type SupervisorSettings = {
  enabled: boolean;
  reviews: boolean;
  unansweredMinutes: number;
  escalateMinutes: number;
  orderConfirmHours: number;
  workStart: number;
  workEnd: number;
  reportHour: number;
  dailyReviewCap: number;
};

export type IssueType =
  | "slow_reply"
  | "unanswered_question"
  | "irrelevant_reply"
  | "rude_or_cold"
  | "wrong_info"
  | "missed_sale"
  | "no_follow_up"
  | "order_not_handled"
  | "unclear_message"
  | "other";

export type ReviewIssue = {
  who: "team" | "ai";
  type: IssueType;
  severity: "low" | "medium" | "high";
  quote: string;
  problem: string;
  advice: string;
};

export type Review = {
  id: number;
  customer: string;
  score: number;
  outcome: "ordered" | "interested" | "lost" | "no_reply_needed" | "support";
  summary: string;
  praise: string;
  issues: ReviewIssue[];
  at: number;
};

export type SupervisorAlert = {
  id: number;
  kind: "unanswered" | "order_unconfirmed" | "review" | "silence";
  customer: string | null;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  at: number;
  resolvedAt: number | null;
};

export type ResponseStats = { replies: number; p50Min: number; p90Min: number; slow: number; team: number; ai: number };

export type DayReport = {
  id: number;
  day: string;
  text: string;
  at: number;
  stats: {
    conversations: number;
    orders: number;
    teamMessages: number;
    reviews: number;
    avgScore: number | null;
    waitingNow: number;
    response: ResponseStats;
  };
};

export type SupervisorView = {
  settings: SupervisorSettings;
  waiting: { customer: string; since: number; minutes: number; lastText: string; messages: number }[];
  response: ResponseStats;
  reviews: Review[];
  issues: Partial<Record<IssueType, { team: number; ai: number }>>;
  avgScore: number | null;
  alerts: SupervisorAlert[];
  reports: DayReport[];
  unconfirmedOrders: number;
  costUsd: number;
};
