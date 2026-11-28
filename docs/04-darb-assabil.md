# Darb Assabil (the courier)

## API
- Base `https://v2.sabil.ly`, headers `Authorization: apikey <DARB_API_KEY>`, `X-API-VERSION: 1.0.0`,
  `X-ACCOUNT-ID: <DARB_ACCOUNT_ID>` (account "التوب العربي").
- Shipments: `GET/POST /api/local/shipments`, `PATCH` for notes, timeline `GET /api/local/shipments/timeline/:ref`,
  shipping price `POST /api/local/shipments/calculate/shipping`, contacts `POST /api/contacts`,
  rates `GET /api/local/service/rates/public`, trust score `GET /api/contacts/trust/score?phone=`.
- Service: توصيل رجالي (primary). Others: نسائي، فوري.
- A missing shipment returns **200 with `results: []`**, not an error.
- Paging: `offset` is an item offset.

## Numbers
- A shipment starts as `SH2457769`; once Darb takes it, `reference` becomes the branch number (e.g. `2719364`) and
  the SH number stays in `tags`. `?search=<number>` finds both; `?reference=SH…` stops working. We track by
  Darb's `_id`, which never changes. The orders page shows both numbers.

## Sending an order (dashboard → Orders → send)
- City and area guessed from the order; a city with several areas needs the real area chosen.
- Only the address goes to the courier note, with the payment line first ("تحويل مصرفي" or cash); the order's own
  notes stay internal. Bank-transfer orders: the team's rule is amount 0 at Darb and the transfer noted.
- A map link in the address is passed as a Google Maps URL (Darb accepts it).
- `localPhone()`: Libyan numbers as `09…`, foreign as `+…`.

## Tracking and money (`src/darbTrack.ts`, every 15 min)
- Status, timeline, the shipping fee, what's ours (`invoices[]._sums.product.sum`), and payouts
  (`salesWithdrawalAt` / `salesWithdrawalReferences` "TX…"). Money page (الفلوس) shows it; wallet
  `GET /api/wallet/balance/local/lyd`.
- Orders sent by hand in Darb's app were linked to our orders (16 of them on Oct 27).
- The bot answers "where is my order" from the stage; delays, returns and complaints go to the team.
- Customer updates (left / in your city / delivered) from `src/tracking.ts`.

## After the order
- **New location** (`locationForOpenOrder`): not sent → update the address; sent but not picked up
  (pending/booked) → update the address and the courier note at Darb; on its way or Darb not answering → nothing
  changes, the customer is told it can't be changed now, Telegram gets the location.
- **Resend** a shipment deleted at Darb by mistake: from the order's tracking, only when Darb confirms it's gone or
  cancelled; opens the send form prefilled with the old city and area; Darb gives a new number; the order notes
  the old one; the customer isn't told again.
- **Redirect** a cancelled/refused shipment to another customer with the same pieces in the same city (new, or
  confirmed but not picked up); the team checks and confirms.
