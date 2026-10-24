// Reads settings from environment variables (.env). Fails fast if something required is missing.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),

  openai: {
    // OPENAI_API_KEY is read by the OpenAI SDK itself.
    model: optional("OPENAI_MODEL", "gpt-5-mini"),
    // How much the model "thinks" before answering. Thinking tokens are billed,
    // and shop questions need little of it. Values: minimal | low | medium | high
    reasoningEffort: optional("OPENAI_REASONING_EFFORT", "low") as "minimal" | "low" | "medium" | "high",
  },

  // WhatsApp Cloud API with Coexistence (number stays in the WhatsApp Business app).
  // Provider "dualhook" (default, cheapest) or "360dialog".
  whatsapp: {
    provider: optional("WHATSAPP_PROVIDER", "dualhook") as "dualhook" | "360dialog",
    get enabled() {
      return Boolean(
        this.provider === "dualhook" ? process.env.DUALHOOK_API_KEY?.trim() : process.env.D360_API_KEY?.trim(),
      );
    },
    dualhook: {
      baseUrl: optional("DUALHOOK_BASE_URL", "https://api.dualhook.com/v25.0").replace(/\/+$/, ""),
      get apiKey() {
        return required("DUALHOOK_API_KEY");
      },
    },
    d360: {
      baseUrl: optional("D360_BASE_URL", "https://waba-v2.360dialog.io").replace(/\/+$/, ""),
      get apiKey() {
        return required("D360_API_KEY");
      },
    },
    // Our number's Phone Number ID (from the provider dashboard). Required for Dualhook;
    // also used to ignore webhooks that aren't for our number.
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID?.trim() || undefined,
    // Meta's webhook verification (GET hub.challenge) checks this value. Set the same value in Dualhook.
    verifyToken: process.env.WA_VERIFY_TOKEN?.trim() || undefined,
    // When the team replies from the WhatsApp Business app, or the AI hands off,
    // the AI stays silent with that customer for this many hours.
    humanPauseHours: Number(optional("HUMAN_PAUSE_HOURS", "12")),
  },

  // Instagram + Messenger through Chatwoot.
  chatwoot: {
    enabled: Boolean(process.env.CHATWOOT_BOT_TOKEN?.trim()),
    baseUrl: optional("CHATWOOT_BASE_URL", "https://app.chatwoot.com").replace(/\/+$/, ""),
    // Access token of the Agent Bot (Settings → Bots → your bot).
    get botToken() {
      return required("CHATWOOT_BOT_TOKEN");
    },
    // Optional: if Chatwoot signs deliveries (X-Chatwoot-Signature), set the webhook secret here.
    webhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET?.trim() || undefined,
  },

  // Secret part of the webhook URLs: https://your-server/whatsapp/<WEBHOOK_TOKEN>
  get webhookToken() {
    return required("WEBHOOK_TOKEN");
  },

  // "off" = listen-only: store incoming messages but never reply. Use while the knowledge files aren't ready.
  aiReplies: optional("AI_REPLIES", "on") !== "off",

  databasePath: optional("DATABASE_PATH", "data/agent.db"),

  // Folder with the knowledge files the AI answers from (editable in the dashboard).
  knowledgeDir: optional("KNOWLEDGE_DIR", "knowledge"),

  dashboard: {
    // Password for /dashboard. The dashboard stays locked while this is not set.
    password: process.env.DASHBOARD_PASSWORD?.trim() || undefined,
    // Clock used for "today" and the daily charts. Libya is UTC+2 all year.
    timezoneOffsetHours: Number(optional("DASHBOARD_TZ_OFFSET_HOURS", "2")),
    // OpenAI prices in US$ per 1M tokens, for the cost estimate (gpt-5-mini by default).
    price: {
      input: Number(optional("OPENAI_PRICE_INPUT", "0.25")),
      cachedInput: Number(optional("OPENAI_PRICE_CACHED_INPUT", "0.025")),
      output: Number(optional("OPENAI_PRICE_OUTPUT", "2")),
    },
  },

  // Wait this long after the customer's last message before replying,
  // so several quick messages ("hi" / "price?" / "size M") get one answer.
  debounceMs: Number(optional("REPLY_DEBOUNCE_MS", "4000")),

  // How many recent messages of the conversation the AI sees.
  historyLimit: Number(optional("HISTORY_LIMIT", "20")),
};
