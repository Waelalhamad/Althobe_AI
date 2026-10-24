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

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.chatwoot.baseUrl}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      api_access_token: config.chatwoot.botToken,
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
