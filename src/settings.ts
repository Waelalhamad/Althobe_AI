// Settings the team can change from the dashboard without a redeploy.
// A value saved in the dashboard wins over the environment variable.
import { config } from "./config.js";
import { channelOf, getSetting, setSetting, type Channel } from "./store.js";

// AI_REPLIES: "on" = the AI answers customers, "off" = listen-only.
export function aiRepliesEnabled(): boolean {
  const saved = getSetting("ai_replies");
  return saved === undefined ? config.aiReplies : saved === "on";
}

export function setAiReplies(on: boolean) {
  setSetting("ai_replies", on ? "on" : "off");
}

// Each channel can be listen-only on its own. Messenger and Instagram start listen-only.
export const META_CHANNELS = ["messenger", "instagram"] as const;
export function channelRepliesEnabled(channel: Channel): boolean {
  const saved = getSetting(`ai_replies_${channel}`);
  return saved === undefined ? channel === "whatsapp" || channel === "chatwoot" : saved === "on";
}

export function setChannelReplies(channel: Channel, on: boolean) {
  setSetting(`ai_replies_${channel}`, on ? "on" : "off");
}

// Test mode: when the list is not empty, the AI only answers these conversations (WhatsApp numbers,
// or "fb:…" / "ig:…" for Messenger and Instagram), so it can be tried on real chats safely.
export function testNumbers(): string[] {
  const saved = getSetting("test_numbers");
  if (!saved) return [];
  try {
    const list = JSON.parse(saved) as unknown;
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function setTestNumbers(numbers: string[]) {
  setSetting("test_numbers", JSON.stringify(numbers));
}

// Should the AI answer this conversation right now? Explains why not, for the log.
export function aiBlockedReason(customer?: string): string | undefined {
  if (!aiRepliesEnabled()) return "listen-only mode (AI replies are off)";
  if (customer && !channelRepliesEnabled(channelOf(customer))) return `listen-only on ${channelOf(customer)}`;
  const test = testNumbers();
  if (test.length > 0 && !(customer && test.includes(customer))) {
    return "test mode (AI only answers the test numbers)";
  }
  return undefined;
}
