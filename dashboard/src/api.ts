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

export type CatalogItem = { id: string; name: string; description: string; file: string; mime: string; createdAt: number };

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
  | ({ action: "reply"; text: string; photos: string[] } | { action: "handoff"; reason: string; messageToCustomer: string }) & {
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
  catalog: () => request<CatalogItem[]>("/catalog"),
  addPhoto: (photo: { name: string; description: string; mime: string; data: string }) => post<CatalogItem>("/catalog", photo),
  updatePhoto: (id: string, patch: { name?: string; description?: string }) =>
    request<CatalogItem>(`/catalog/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePhoto: (id: string) => request(`/catalog/${id}`, { method: "DELETE" }),
};
