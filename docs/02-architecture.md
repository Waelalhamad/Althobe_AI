# Architecture

## From a customer message to a reply
1. **Webhook** (`src/channels/whatsapp.ts`): Dualhook posts each message. Text, reactions, locations, photos and
   voice notes are saved in SQLite (`src/store.ts`). Photos and voice notes are downloaded (`src/media.ts`); voice
   becomes text; a customer photo is compared with our current catalog photos and gets a line
   `[photo check: our current product «…», color …]`, `NOT one of our current products` or `can't tell`.
2. **Pauses**: if the team replied (from the phone or the dashboard) the bot stays quiet for the team pause
   (Settings → `teamPauseMinutes`, now **720 = 12 h**). After a handoff or an AI order the chat is paused for the
   team (`humanPauseHours`, 12 h). A new map location after an order runs `locationForOpenOrder` (checks Darb).
3. **Debounce** (`src/scheduler.ts`): replies wait `debounceMs` (4 s) after the last message, one run per customer
   at a time. If the customer writes again while the AI is thinking, the reply is dropped ("superseded") and the
   next run reads everything.
4. **Context**: last `historyLimit` (20) messages, the customer's background (returning, orders, Darb tracking
   lines, location outcome, what the team did in the chat), the product photos already sent.
5. **`decideReply`** (`src/agent.ts`): OpenAI Responses API with tools:
   - `send_product_photos` (catalog ids), `submit_order`, `handoff_to_human` (reason, kind, message, silent),
     `no_reply_needed`.
   - System prompt = the code's `INSTRUCTIONS` + all knowledge files (`src/knowledge.ts`, cached 60 s) + stock.
   - Up to 5 rounds. Guards inside the loop:
     - **Order checks** (`orderProblems` / `addressGaps`): a valid Libyan phone (`intlPhone`), a size on every
       item, a city and a real address, no placeholder words. A failed order goes back to the model ("NOT saved")
       so it asks the customer.
     - **Style checks** (`styleProblems`): non-Libyan words (وش، شنو، عشان، بدك، تريد، الحين…), a reply mostly in
       Latin letters, a wrong bank account number, more than 2 messages. One rewrite, then automatic fixes
       (سعرو → سعره…). A wrong account number is never sent (silent handoff).
     - **Country**: "من أي بلد / انت في ليبيا" is cut for Libyan numbers and after the first ask
       (`withoutRepeatedCountry`).
     - **Reply check** (`checkReply`, cheaper model): lists claims not backed by the knowledge and missed
       questions, with a confidence 0–100. Below **80** the reply gets one rewrite; if it still has unbacked
       claims the chat is handed to the team silently ("المساعد مش متأكد من الجواب").
6. **Sending**: `splitAroundPhotos` / `splitMessages` (`src/typing.ts`): at most 2 text bubbles, photos where the
   AI wrote `[photos]`, a typing pause between bubbles.
7. **Orders**: `submit_order` → same-order check (colour/size/quantity, last 7 days), stock check, save, pause
   the chat, Telegram "🛍 طلب جديد", `DEFAULT_ORDER_MESSAGE` to the customer.
8. **Handoffs**: pause the chat, Telegram "🙋" or, when the reason starts with **عاجل**, "🚨🚨" and the chat tops the
   inbox. Handoffs because the AI didn't know feed **learning**.

## Background jobs
- `src/followup.ts`: one gentle follow-up to a quiet customer (at most once per customer message).
- `src/learning.ts`: after a "didn't know" handoff, the team's answer becomes a lesson to approve (dashboard or
  Telegram buttons). Approved lessons go into `06-lessons.md` (live only).
- `src/supervisor.ts` ("المشرف العام"): every 5 min free checks (unanswered customers, unconfirmed AI orders),
  every 30 min an AI review of chats, reports to Telegram.
- `src/darbTrack.ts`: copies every Darb shipment every 15 min (status, timeline, money). `src/tracking.ts` sends
  the customer updates (left, in your city, delivered) inside WhatsApp's 24 h window.
- `src/ordersSheet.ts`: daily Excel of orders to Telegram; download from the dashboard.

## Data (SQLite on the volume)
messages (with `history` for imported Coexistence history), customers/names, pauses, orders (items JSON, payment,
darb_id / darb_ref, notes), stock, catalog, lessons, ai_calls (usage and cost), events (activity log), settings,
darb_shipments (status, shipping fee, what's ours, payouts), redirects, tracking notices.

## Dashboard (`dashboard/`)
Overview, Inbox (take over, pause, send text and up to 10 photos), Handoffs, Orders (filters, search, Darb status,
send / edit / resend to Darb, redirect, Excel), Leads (الزباين), Stock (المخزون), Catalog, Knowledge editor,
Learning, Money (الفلوس), Supervisor, Activity, Playground (test the bot, record voice), Settings & alerts.

## Key files
| File | Role |
|---|---|
| `src/agent.ts` | INSTRUCTIONS, decideReply, all reply/order/style checks, follow-up writer, lesson judge, order extraction |
| `src/channels/whatsapp.ts` | webhook, respond(), orders, location after order, receipts, photos |
| `src/store.ts` | database, same-order check, pauses |
| `src/darb.ts`, `src/darbTrack.ts`, `src/darbRedirect.ts`, `src/tracking.ts` | courier |
| `src/telegram.ts`, `src/orders.ts` | alerts |
| `src/dashboard/api.ts`, `src/dashboard/queries.ts` | dashboard API |
| `knowledge/*.md` | **seed only**: copied to the volume on first start; the live files are edited from the dashboard |
