# How the bot sells

The rules live in two places, and they must agree:
1. **The code's instructions** (`INSTRUCTIONS` in `src/agent.ts`) plus the code checks. Change = commit + deploy.
2. **The knowledge files** on the live volume. Change = the dashboard, live in a minute. The team edits these.

When the two disagree the model gets mixed signals, and the reply check (which reads the knowledge) flags replies
the instructions asked for. That is the main cause of the bad handoffs in the Oct 31 review.

## The CEO's v2 (merged Oct 29, commit c3177b4)
From the analysis of 904 chats:
- Knowledge rewritten with instructions in formal Arabic and examples in Libyan dialect (the old files were in
  Syrian dialect, which is where "سعرو" came from).
- Price at once when asked, with a trust line; size by weight (table in 03-sizes); an objections table; delivery
  time by city; bank account details in the chat when the customer chooses a transfer.
- 1–2 messages per turn; Arabic only; no "من أي بلد" for +218 numbers; photos once per chat.
- 👍 on the summary is **not** a confirmation: ask once "نثبّت استاذ؟".
- "عاجل" handoffs for problems with a confirmed or sent order; 3+ sets went to the team (CEO's version).
- Team pause 12 h. Five lessons that contradicted the rules were removed.
- Before/after on 19 real chats: non-Libyan words 7 → 0, country asks 4 → 0, max bubbles 4 → 2, price with the
  trust line 0/5 → 5/5.

## The team's edits on the live knowledge (Oct 29 22:00 → Oct 30 22:21, ~20 saves)
They changed direction on several points. The live knowledge now says:
- **Don't mention trying it on or returns** unless the customer asks, and only once they've shown they're serious
  (chose colour and size, or started giving name/address). The trust line with the price is now
  "التوصيل مجاني والدفع عند الاستلام". Never "ما في أي مخاطرة". Reason: try-on talk brings non-serious orders that
  come back, and each return costs shipping.
- **"وين مكانكم / عندكم محل"**: never say "ما عندناش محل". Answer: "شركة الثوب العربي موجودة في سوريا وتركيا،
  وتشحن لكل الدول العربية ولكل مناطق ليبيا، ونوصّلولك لباب بيتك…" and ask the city. Not a handoff.
- **Quantity**: any number of sets is a normal order (770, 1155, 1540, 1925). Only a **discount** request or
  wholesale (>10) goes to the team, with "نشوف الإدارة ونخبرك استاذ 🙏".
- **Handoff only** for: a discount / wholesale; a problem with a confirmed or delivered order; "I transferred" or a
  receipt; outside Libya; asks for a person; questions about owners/staff, rude or angry customers.
- **"لحظة نتأكدلك ونرجعلك" only** for the transfer/receipt case and order problems. Otherwise answer and keep
  selling, or a short "حاضر استاذ 🙏".
- Fabric questions (summer, ironing) are answered ("ينكوى عادي"), never handed off.
- Unknown towns: ask which city it belongs to; never a handoff.
- "Later / after the salary / next week": "على راحتك استاذ…", not a booking and not a handoff.
- Over 105 kg: say honestly 62 is the largest and probably won't fit; if they insist, a responsibility line first.
- Returns at the door: the customer pays the delivery fee (the team said so in chats: "ممكن مع دفع قيمة التوصيل").
- Always ask name and phone even if the WhatsApp number is known.
- Jenzour and الماية added to the west-of-Tripoli delivery row.

## Where the code still says the opposite (as of Oct 31)
| Topic | Code instructions / checks say | Live knowledge says |
|---|---|---|
| Unsure | "If you don't know… hand off… 'لحظة نتأكدلك ونرجعلك'" (line ~58, 111, 118) + the reply check hands off below 80 | Don't hand off because you're unsure; answer with what you know |
| Company / address | Silent handoff for "the exact address" (line ~59) | Answer with the Syria/Turkey line, never hand off |
| Price | Price "with the try-before-you-pay … line" (line ~69) | Never mention try-on with the price |
| Payment question | "transfer now, or cash on delivery after trying it on" (line ~91) | No try-on mention |
| Quantity | Handoff message "الفريق يتواصل معاك بخصوص الكمية" (line ~118) | Any quantity is a normal order |
| Returns | "there are no returns, the customer tries it on" (line ~113) | Try-on only on explicit ask; refusing at the door costs the delivery fee |
| Default handoff text | "حاضر، لحظة نتأكدلك ونرجعلك 🙏" (tool description, line ~214) | "حاضر استاذ 🙏" |

The repo's `knowledge/` is also behind the live files. See 08-open-issues.md for the fix.
