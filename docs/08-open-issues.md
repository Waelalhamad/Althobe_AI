# Open issues

## Fix next (from the Oct 31 review)
1. **Align the code's instructions with the team's live knowledge** (`src/agent.ts` INSTRUCTIONS and the
   handoff tool text): remove "if unsure hand off with لحظة نتأكدلك", the silent handoff for the company
   address, the try-on line with the price and in the payment answer, the quantity handoff message, the
   "no returns" line; default handoff text "حاضر استاذ 🙏". Let the knowledge decide those business rules.
2. **Reply check**: an unbacked claim should get the rewrite and then the reply without the claim, not a silent
   handoff; never hand off for goodbyes, reactions, "later", city/delivery-time questions.
3. **Order checks**: Libyan mobile must be 09[1-5] + 7 digits; order notes must not claim a receipt or anything the
   customer didn't send.
4. **Copy the live knowledge into the repo's `knowledge/`** so a fresh volume doesn't seed the old rules.
5. Add "مو" to the non-Libyan words; fix استاذ/استاذة when the given name is clearly a man's or a woman's.
6. One rule for refusing at the door (free, or the customer pays delivery) in the live knowledge.

## Waiting on the owner
- Order #42 / #31 (same customer, two orders): cancel #42 and move its new pin to #31? Unanswered.
- Order #35: the team should resend it from tracking and choose the area.
- Meta credentials (`META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`) to switch on Messenger/Instagram.
- Rotate the Dualhook and Darb API keys (both were pasted in chat).

## Later (agreed as separate steps)
- Confirm with the customer before shipping.
- A cancellation-reason log.
- Expected vs actual delivery time per city.
