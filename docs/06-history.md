# History: features and decisions

What was built, in order, and the request or problem behind it. Dates are 2026.

## Oct 24–25: the base
- AI agent for WhatsApp, Instagram and Messenger; Coexistence chat history imported; admin dashboard.
- Photos and voice notes (download, transcribe, vision); product photo catalog the AI can send.
- The bot collects orders: summary → confirm → `submit_order`; Orders page.
- Telegram alerts and the supervisor ("المشرف العام").
- Selling style like the team; real product knowledge; everything product-specific editable from the dashboard.
- Openings by situation; automatic follow-up; firm on price; sales research notes (docs/sales-research.md).
- Libyan wording: استاذ / استاذة only when clearly a woman, sizes 56–62, full salaam reply, [photos] placement.
- Second-look reply check (below 80/100 → team). Detailed address (area, street, landmark).
- Learning from handoffs: the team's answers become lessons, approved from the dashboard or Telegram.
- Team can send photos from the inbox; record a team order from the dashboard.

## Oct 26
- Orders Excel (download + daily Telegram sheet); don't take phrases as names; drop stale replies.
- "No returns: tries it on while the courier is there."
- Responses API with reasoning; cheaper/flex models for background work; cost per call in the dashboard.
- WhatsApp usernames without a number; no "تمام" loops; Leads page.
- **Darb Assabil**: send an order from the dashboard; only the address goes to the courier; payment line; areas.
- **Payment method** on every order (request: "if bank transfer, send price 0 and note it; prefer cash").
- **Google Maps location** ask (request: Darb accepts a Maps link).
- **Messenger + Instagram** straight from Meta (waiting for credentials).
- **Stock** per colour and size; old-ad photo check.

## Oct 27
- No silence when the customer answers our question; a reply written next to no_reply is still sent.
  (Request: "there are a lot of cases the AI doesn't answer and doesn't send it to the team.")
- **Darb tracking and money** (الفلوس page); 16 old orders linked to their shipments.
- "من أي بلد" asked once per chat (it had been repeated in 139 chats).
- Fix "No tool output found"; photo loop fix; multiple photos from the inbox.
- Orders page: unsent orders highlighted; filters, search, Darb status.
- Product photos exported to the owner's Downloads.
- Dualhook reconnect after 503/403 (the AI and follow-ups were paused until it came back).

## Oct 28
- **Order tracking** answers and customer updates.
- #35 wrong city: diagnosed (the city guess, not the AI); SH vs branch numbers; track by Darb id.
- **Redirect** a cancelled shipment to a matching order.
- Two orders for one customer (#42/#31): the same-order check now compares colour/size/quantity; a pin after
  ordering is a correction.
- **Location after ordering is checked with Darb first** (request: "make sure this mistake doesn't happen again").
- **Resend** a shipment deleted at Darb, in one click, then as the send form with city/area editable.
- **No placeholder addresses** ("اللوكيشن المرسل من الزبون"); #35 fixed by hand.

## Oct 29
- **The CEO's System Prompt v2** reviewed and merged (not pasted), tested on 27 cases, deployed; live knowledge
  written; team pause set to 12 h. Decisions: 👍 asks "نثبّت استاذ؟"; 12 h pause; remove the 5 conflicting
  lessons; confirm-before-shipping is a separate later step.

## Oct 29–30
- The team rewrote much of the live knowledge from the dashboard (see 05-selling-rules.md). The code was not
  changed to match.

## Oct 31
- Review of the last 23 hours (07-review-2026-10-31.md). This docs folder.
