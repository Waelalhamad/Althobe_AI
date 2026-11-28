# Operations

## Deploy
```
git push && railway up --detach --service agent
```
- The owner runs it (from Claude Code: `! git push && railway up --detach --service agent`).
- Check: `railway deployment list --service agent` until the top line says SUCCESS; logs with
  `railway logs --service agent`.
- A deploy gives a few minutes of **502** while the new container starts. Deploy at quiet hours (customers write
  most in the evening, Libya time = UTC+2).
- The bot is **live with real customers**: test locally before deploying.

## Environment (Railway variables; names only)
`OPENAI_API_KEY`, `DASHBOARD_PASSWORD`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN`, `DUALHOOK_API_KEY`,
`DARB_API_KEY`, `DARB_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `META_VERIFY_TOKEN`
(set), `META_APP_ID` / `META_APP_SECRET` / `META_ACCESS_TOKEN` (missing), `CHATWOOT_BOT_TOKEN`,
`CHATWOOT_WEBHOOK_SECRET`, `PUBLIC_URL`.
- Secrets are never committed and never pasted in chat; set them with `railway variable set --stdin`.
- Keys that were exposed in chat and should be rotated: the Dualhook key, the Darb key.

## Settings (dashboard → Settings, saved in the DB, win over env)
AI on/off, per-channel switches, test numbers, model (`gpt-5-mini`), reasoning effort (low), `humanPauseHours`
(12), `teamPauseMinutes` (**720** since Oct 29), `debounceMs` (4000), `historyLimit` (20), timezone (+2).

## The knowledge
- Live files are on the volume (`/data/knowledge`): `00-how-we-talk`, `01-brand`, `02-products`, `03-sizes`,
  `04-shipping-payment-returns`, `05-faq`, `06-lessons` (lessons exist **only live**).
- The repo's `knowledge/` only seeds an empty volume. **The live files have changed a lot since the repo copy**
  (the team's edits of Oct 29–30, see 05-selling-rules.md). Before editing, read the live file.
- Edit from the dashboard (Knowledge page) or `PUT /dashboard/api/knowledge/:name` with `{body}`. Takes effect
  within 60 s. Never overwrite `06-lessons.md` wholesale: edit from the live text.

## Dashboard API (for scripts)
`POST /dashboard/api/login {password}` → cookie. Useful routes: `GET /conversations?limit=&q=&filter=`,
`GET /conversations/:customer`, `POST /conversations/:customer/pause`, `GET /orders`, `PUT /orders/:id`,
`POST /orders/:id/darb/resend`, `GET/PUT /knowledge/:name`, `GET/PUT /settings`, `GET /darb/redirects`.

## Testing locally
- `npx tsc --noEmit` (root) and `npm run build --prefix dashboard`.
- Small scripts `src/__x.mts` run with `npx tsx` against a copy of the database, deleted afterwards.
- Replays: real chats pulled from the dashboard (read only), cut after a customer message, run through
  `decideReply` with a scratch `KNOWLEDGE_DIR`, compared with what the bot really said. Needed env:
  `DATABASE_PATH`, `DATA_DIR`, `KNOWLEDGE_DIR`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5-mini`,
  `OPENAI_REASONING_EFFORT=low`, dummy `WA_PHONE_NUMBER_ID`, `DUALHOOK_*`, `WEBHOOK_TOKEN`.
- A fake Darb server (forwards GETs, records writes) was used to test resend/redirect without touching real
  shipments.

## House rules (agreed with the owner)
- Never commit keys or `.env`. Customer chat data stays out of the repo.
- Don't delete data permanently; cancel orders instead, and only when the owner asks.
- Messages to customers are sent only after the owner approves the exact text.
- Real Darb shipment changes need the owner's OK at that moment.
- Don't touch the Railway project "althobe".
- Editing gotcha: Python heredocs mangle `\n` `\s` in regex/template code; use a real editor for those.
- `curl` from the dev machine returns 000 against Railway; use Node `fetch`.
