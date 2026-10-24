# AI customer support agent: الثوب العربي (WhatsApp · Instagram · Messenger)

One AI agent (OpenAI) answers customers on all three channels and hands the chat to the team when it isn't sure.

```
WhatsApp  ──► 360dialog (Coexistence) ──webhook──►┐
                                                  ├──► this server ──► OpenAI
Instagram ─┐                                      │
Messenger ─┴─► Chatwoot (Agent Bot) ──webhook────►┘
```

## How it behaves

- Answers only from the files in `knowledge/`. It never invents prices or policies.
- Replies in the customer's language and dialect (mainly Libyan Arabic), and only about the brand.
- Hands off to the team when it doesn't know, for orders/complaints, when the customer asks for a person, or when it gets a photo/voice note.
- If several messages arrive quickly, it waits 4 seconds and answers them together.
- If OpenAI or the channel fails, the chat goes to the team. No customer is left with a stuck bot.

**WhatsApp (Coexistence):** the number stays in the WhatsApp Business app on the phone.
- When the AI hands off, or **when a team member replies from the app**, the AI stays silent with that customer for `HUMAN_PAUSE_HOURS` (default 12h).
- The team simply answers in the app as usual.

**Instagram / Messenger (Chatwoot):** new chats are *pending* (the AI answers). On handoff the chat becomes *open*, gets a private note with the reason, and the team answers in Chatwoot.

## 1. Brand knowledge

Edit the files in `knowledge/` and replace everything in `[brackets]`. Changes go live within a minute.

## 2. Settings

```bash
cp .env.example .env
```

Fill in `.env`: `OPENAI_API_KEY`, `WEBHOOK_TOKEN`, `D360_API_KEY` (WhatsApp), `CHATWOOT_BOT_TOKEN` (Instagram/Messenger). A channel without its key is simply off.

## 3. Test in the terminal (no WhatsApp needed)

```bash
npm install
npm run chat
```

## 4. Go live

1. Deploy the server (`npm start`) at a public HTTPS address, e.g. `https://bot.yourdomain.com`.
   - Run **one** instance.
   - Keep the `data/` folder (the conversation database) on persistent disk.
2. **WhatsApp:** `npm run set-webhook -- https://bot.yourdomain.com`
3. **Instagram/Messenger:**
   1. Chatwoot → Settings → Bots → Add bot, with webhook URL `https://bot.yourdomain.com/webhook/<WEBHOOK_TOKEN>`.
   2. Put the bot's token in `CHATWOOT_BOT_TOKEN`.
   3. In each inbox → Bot configuration → select the bot.
4. Health check: `https://bot.yourdomain.com/health`.

## Commands

| Command | What it does |
|---|---|
| `npm run chat` | Test the AI in the terminal |
| `npm run dev` | Run locally, restarting on code changes |
| `npm start` | Run the server |
| `npm run set-webhook -- <url>` | Point 360dialog WhatsApp webhooks at this server |
| `npm run typecheck` | Type-check the code |
