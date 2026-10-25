// Typed calls to the agent server's /dashboard/api.
const BASE = "/dashboard/api";

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

export type Overview = {
  days: number;
  today: Totals;
  period: Totals;
  daily: DailyRow[];
  hourly: { hour: number; customerMessages: number }[];
  recentHandoffs: AiCallRow[];
};

export type ConversationFilter = "all" | "unanswered" | "ai" | "paused" | "handoff";

export type ConversationSummary = {
  customer: string;
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
  channel: "whatsapp" | "chatwoot";
  name: string;
  phone: string;
  city: string;
  address: string;
  items: OrderItem[];
  total: string;
  notes: string;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
};

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
  debounceMs: number;
  historyLimit: number;
  timezoneOffsetHours: number;
  channels: { whatsapp: string | null; whatsappPhoneNumberId: string | null; chatwoot: boolean; openai: boolean };
  historySync: { phase?: number; chunk?: number; progress?: number; error?: string; at: number } | null;
};

export type KnowledgeFile = { name: string; size: number; updatedAt: number };
export type EventRow = { id: number; conversation: string; message: string; at: number };
export type ChatTurn = { role: "customer" | "business"; text: string; image?: string };
export type Decision =
  | (
      | { action: "reply"; text: string; photos: string[] }
      | { action: "handoff"; reason: string; messageToCustomer: string }
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
  overview: (days: number) => request<Overview>(`/overview?days=${days}`),
  conversations: (filter: ConversationFilter, q: string) =>
    request<ConversationSummary[]>(`/conversations?filter=${filter}&q=${encodeURIComponent(q)}&limit=200`),
  conversation: (customer: string) => request<ConversationDetail>(`/conversations/${encodeURIComponent(customer)}`),
  pause: (customer: string, hours?: number) => post(`/conversations/${encodeURIComponent(customer)}/pause`, { hours }),
  resume: (customer: string) => post(`/conversations/${encodeURIComponent(customer)}/resume`),
  send: (customer: string, text: string) => post(`/conversations/${encodeURIComponent(customer)}/send`, { text }),
  handoffs: (days: number) => request<(AiCallRow & { id: number; stillWithTeam: boolean })[]>(`/handoffs?days=${days}`),
  events: (q: string) => request<EventRow[]>(`/events?q=${encodeURIComponent(q)}&limit=300`),
  settings: () => request<Settings>("/settings"),
  saveSettings: (patch: Partial<Pick<Settings, "aiReplies" | "testNumbers">>) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  knowledge: () => request<KnowledgeFile[]>("/knowledge"),
  knowledgeFile: (name: string) => request<{ name: string; body: string }>(`/knowledge/${encodeURIComponent(name)}`),
  saveKnowledge: (name: string, body: string) =>
    request(`/knowledge/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ body }) }),
  deleteKnowledge: (name: string) => request(`/knowledge/${encodeURIComponent(name)}`, { method: "DELETE" }),
  playground: (messages: ChatTurn[]) => post<Decision>("/playground", { messages }),
  orders: (status?: OrderStatus) =>
    request<{ counts: Partial<Record<OrderStatus, number>>; orders: Order[] }>(`/orders${status ? `?status=${status}` : ""}`),
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
};

// --- Telegram + supervisor -----------------------------------------------------------------

export type NotifyKind = "order" | "handoff" | "error" | "supervisor" | "report";
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
