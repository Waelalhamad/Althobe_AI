// Test the AI in your terminal, without Chatwoot or WhatsApp:  npm run chat
import readline from "node:readline/promises";
import { decideReply, type ChatTurn } from "../src/agent.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history: ChatTurn[] = [];

console.log('Chat with the AI as if you were a customer. Type "exit" to quit, "reset" to start over.\n');

while (true) {
  const text = (await rl.question("Customer: ")).trim();
  if (!text) continue;
  if (text === "exit") break;
  if (text === "reset") {
    history.length = 0;
    console.log("(conversation reset)\n");
    continue;
  }

  history.push({ role: "customer", text });
  const decision = await decideReply(history);

  if (decision.action === "reply") {
    if (decision.photos.length) console.log(`AI → sends photos: ${decision.photos.join(", ")}`);
    console.log(`AI: ${decision.text}\n`);
    history.push({ role: "business", text: decision.text });
  } else if (decision.action === "order") {
    console.log(`AI → ORDER (not saved in this test): ${JSON.stringify(decision.order, null, 2)}`);
    console.log(`AI: ${decision.messageToCustomer}\n`);
    history.push({ role: "business", text: decision.messageToCustomer });
  } else if (decision.action === "none") {
    console.log(`AI → no reply (${decision.reason})
`);
  } else {
    console.log(`AI → HANDOFF to human (${decision.reason})`);
    console.log(`AI: ${decision.messageToCustomer}\n`);
    history.push({ role: "business", text: decision.messageToCustomer });
  }
}

rl.close();
