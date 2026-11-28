# Overview

## The business
- **الثوب العربي** (Arab Thobe): a company based in Syria and Turkey that sells one product to customers in **Libya**:
  a 3-piece Arab set (جلبية + سروال + سديري، also called فرملة / قلف / كاط / قولفو).
- Fabric: Toyobo (تويوبو صيني), autumn weight. Sizes 56, 58, 60, 62 (Arab sizes only, no S/M/L). 7 colours:
  رصاصي، بيج، أسود، أبيض، فضي، بني، كريمي. Stock per colour and size is kept in the dashboard.
- Price **385 LYD**, free delivery to the door anywhere in Libya, cash on delivery (preferred) or bank transfer.
  The customer may try it on in front of the courier; there are no returns after receiving.
- Customers come almost entirely from Facebook / Instagram ads ("Click to WhatsApp"). The ad text arrives at the
  start of the first message and the bot sees it as `[from the ad: …]`. The ad's ready-made opening is sometimes
  in Turkish ("Merhaba! Bunun hakkında…") because of the ad account's language.
- Customers write Libyan dialect, often with voice notes, typos, Arabic digits, and reactions (👍 ❤️).

## The people
- **The owner / developer** (the user of these sessions): runs the project, deploys, decides.
- **The CEO**: wrote "AI-Agent-System-Prompt-v2" (the selling rules merged on Oct 29) from an analysis of 904 chats.
- **The team**: answers customers from the WhatsApp Business app on the phone and from the dashboard, confirms
  orders, sends them to Darb Assabil, approves the bot's lessons, gets alerts on Telegram. They also edit the live
  knowledge from the dashboard (they did so ~20 times on Oct 29–30).

## Channels
- **WhatsApp**: the main channel. The number runs in WhatsApp Business **Coexistence** (the team keeps using the
  phone app) through **Dualhook** as the API provider (it replaced 360dialog). Messages the team sends from the
  phone come back to the server, so the bot knows the team replied and pauses.
- **Messenger + Instagram**: built straight on Meta (`src/channels/meta.ts`, `/meta/webhook`), deployed Oct 26,
  waiting for the Meta app credentials. Each channel has its own on/off switch in Settings.
- **Chatwoot**: the older path for Instagram/Messenger (`src/channels/chatwoot.ts`); not the active route.

## Stack
- Node 22 + TypeScript run with `tsx`, Express 5, SQLite (`node:sqlite`), OpenAI SDK.
- Models: `gpt-5-mini` with low reasoning for replies (set in Settings; was `gpt-5.5` earlier), a cheaper model
  and OpenAI's flex tier for background work (reply check, follow-ups, lessons, supervisor), `gpt-4o-transcribe`
  for voice notes.
- Dashboard: React + Vite + Tailwind in `dashboard/`, served by the same server under `/dashboard`.
- Telegram bot for team alerts, lesson approvals and the daily orders sheet.
- Darb Assabil (`v2.sabil.ly`) for shipping, tracking and money.

## Where it runs
- GitHub: `Waelalhamad/Althobe_AI`, branch `main`.
- Railway: service **agent**, live at `https://agent-production-0b5f.up.railway.app` (dashboard at `/dashboard`).
  One instance. A volume holds the database, media, the catalog photos and the **live knowledge**
  (`/data/knowledge`). Another Railway project called "althobe" exists and must not be touched.
