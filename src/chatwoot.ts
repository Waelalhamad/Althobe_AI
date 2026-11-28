import { config } from "./config.js";
import type { ChatTurn } from "./agent.js";

// Chatwoot REST API message_type values.
const INCOMING = 0;
const OUTGOING = 1;

type ChatwootMessage = {
  id: number;
  content: string | null;
  message_type: number;
  private: boolean;
  created_at: number;
  attachments?: { file_type: string }[];
};

async function api<T>(path: string, init: RequestInit = {}, token = config.chatwoot.botToken): Promise<T> {
  const url = `${config.chatwoot.baseUrl}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      api_access_token: token,
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Chatwoot ${init.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// Recent conversation turns, oldest first, without private notes and system events.
export async function getHistory(accountId: number, conversationId: number): Promise<ChatTurn[]> {
  const data = await api<{ payload: ChatwootMessage[] }>(
    `/accounts/${accountId}/conversations/${conversationId}/messages`,
    {},
    config.chatwoot.userToken ?? config.chatwoot.botToken,
  );

  return data.payload
    .filter((m) => !m.private && (m.message_type === INCOMING || m.message_type === OUTGOING))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-config.historyLimit)
    .map((m) => ({
      role: m.message_type === INCOMING ? "customer" : "business",
      text: describeMessage(m),
    }));
}

function describeMessage(m: ChatwootMessage): string {
  const parts: string[] = [];
  if (m.content?.trim()) parts.push(m.content.trim());
  for (const a of m.attachments ?? []) {
    parts.push(`[customer sent a ${a.file_type} attachment]`);
  }
  return parts.join("\n") || "[empty message]";
}

export async function sendReply(accountId: number, conversationId: number, content: string) {
  await api(`/accounts/${accountId}/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, message_type: "outgoing", private: false }),
  });
}

// Internal note visible only to the team in Chatwoot.
export async function addPrivateNote(accountId: number, conversationId: number, content: string) {
  await api(`/accounts/${accountId}/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, message_type: "outgoing", private: true }),
  });
}

// Moves the conversation from "pending" (bot) to "open" so human agents see and handle it.
export async function handOffToHuman(accountId: number, conversationId: number) {
  await api(`/accounts/${accountId}/conversations/${conversationId}/toggle_status`, {
    method: "POST",
    body: JSON.stringify({ status: "open" }),
  });
}

// ---- The dashboard's Messenger tab: the Chatwoot conversations of the page the assistant answers (its inbox has our
// bot, whose webhook is this server). Read with the agent's token; a bot token can't list conversations.

type ChatwootConversation = {
  id: number;
  status: "open" | "pending" | "resolved" | "snoozed";
  unread_count: number;
  last_activity_at: number;
  meta?: { sender?: { name?: string } };
  last_non_activity_message?: { content: string | null; message_type: number; sender_type?: string; attachments?: { file_type: string }[] } | null;
};
type FullMessage = ChatwootMessage & { sender_type?: string; attachments?: { file_type: string; data_url?: string }[] };

const readToken = () => config.chatwoot.userToken ?? config.chatwoot.botToken;
let ours: { accountId: number; inboxIds: number[]; at: number } | undefined;
async function ourInboxes() {
  if (ours && Date.now() - ours.at < 10 * 60_000) return ours;
  const profile = await api<{ account_id: number }>("/profile", {}, readToken());
  const accountId = profile.account_id;
  const inboxes = await api<{ payload: { id: number }[] }>(`/accounts/${accountId}/inboxes`, {}, readToken());
  const inboxIds: number[] = [];
  for (const inbox of inboxes.payload) {
    const bot = await api<{ agent_bot?: { outgoing_url?: string } | null }>(`/accounts/${accountId}/inboxes/${inbox.id}/agent_bot`, {}, readToken()).catch(() => ({ agent_bot: null }));
    if (bot.agent_bot?.outgoing_url?.includes(config.webhookToken)) inboxIds.push(inbox.id);
  }
  ours = { accountId, inboxIds, at: Date.now() };
  return ours;
}

// Who wrote a Chatwoot message, in the dashboard's words.
const sourceOf = (m: { message_type: number; sender_type?: string }) =>
  m.message_type === INCOMING ? "customer" : m.sender_type === "AgentBot" ? "ai" : "staff";

export type TeamFilter = "all" | "unanswered" | "ai" | "paused" | "handoff";
// Newest first, like the WhatsApp list. "ai": the assistant has it (pending); "paused"/"handoff": with the team (open).
export async function messengerConversations(filter: TeamFilter, limit: number) {
  const { accountId, inboxIds } = await ourInboxes();
  const status = filter === "ai" ? "pending" : filter === "paused" || filter === "handoff" ? "open" : "all";
  const found: ChatwootConversation[] = [];
  for (const inboxId of inboxIds) {
    for (let page = 1; page <= Math.ceil(limit / 25); page++) {
      const data = await api<{ data: { payload: ChatwootConversation[] } }>(
        `/accounts/${accountId}/conversations?inbox_id=${inboxId}&status=${status}&page=${page}`,
        {},
        readToken(),
      );
      found.push(...data.data.payload);
      if (data.data.payload.length < 25) break;
    }
  }
  return found
    .map((c) => {
      const last = c.last_non_activity_message;
      return {
        customer: `cw:${c.id}`,
        name: c.meta?.sender?.name ?? "",
        total: 0,
        lastAt: c.last_activity_at * 1000,
        lastText: last ? (last.content?.trim() || (last.attachments?.length ? `[${last.attachments[0]!.file_type}]` : "")) : "",
        lastSource: last ? sourceOf(last) : "customer",
        pausedUntil: null,
        pauseReason: null,
        status: c.status,
        unread: c.unread_count,
        url: `${config.chatwoot.baseUrl}/app/accounts/${accountId}/conversations/${c.id}`,
      };
    })
    .filter((c) => filter !== "unanswered" || c.lastSource === "customer")
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit);
}

// One conversation's latest messages (oldest first), with the customer's name and where to open it in Chatwoot.
export async function messengerConversation(conversationId: number) {
  const { accountId } = await ourInboxes();
  const [conv, data] = await Promise.all([
    api<ChatwootConversation>(`/accounts/${accountId}/conversations/${conversationId}`, {}, readToken()),
    api<{ payload: FullMessage[] }>(`/accounts/${accountId}/conversations/${conversationId}/messages`, {}, readToken()),
  ]);
  return {
    name: conv.meta?.sender?.name ?? "",
    status: conv.status,
    url: `${config.chatwoot.baseUrl}/app/accounts/${accountId}/conversations/${conversationId}`,
    messages: data.payload
      .filter((m) => !m.private && (m.message_type === INCOMING || m.message_type === OUTGOING))
      .sort((a, b) => a.created_at - b.created_at)
      .map((m) => {
        const file = m.attachments?.[0];
        const type = file?.file_type === "image" || file?.file_type === "audio" || file?.file_type === "video" ? file.file_type : file ? "document" : null;
        return {
          id: m.id,
          role: m.message_type === INCOMING ? "customer" : "business",
          source: sourceOf(m),
          text: m.content?.trim() ?? "",
          at: m.created_at * 1000,
          history: 0,
          mediaType: type,
          mediaFile: file?.data_url ?? null,
        };
      }),
  };
}
