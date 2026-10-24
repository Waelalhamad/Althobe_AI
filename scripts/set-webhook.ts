// 360dialog only (Dualhook: set the webhook URL in the Dualhook dashboard).
// Tells 360dialog where to send WhatsApp messages:  npm run set-webhook -- https://bot.yourdomain.com
import { config } from "../src/config.js";

const publicUrl = process.argv[2]?.replace(/\/+$/, "");
if (!publicUrl?.startsWith("https://")) {
  console.error("Usage: npm run set-webhook -- https://your-public-server-address");
  process.exit(1);
}

const url = `${publicUrl}/whatsapp/${config.webhookToken}`;
const res = await fetch(`${config.whatsapp.d360.baseUrl}/v1/configs/webhook`, {
  method: "POST",
  headers: { "D360-API-KEY": config.whatsapp.d360.apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ url }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`360dialog refused the webhook (${res.status}): ${body}`);
  process.exit(1);
}
console.log(`Webhook set. 360dialog will send WhatsApp messages to ${publicUrl}/whatsapp/<WEBHOOK_TOKEN>`);
