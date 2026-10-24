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
    console.log(`AI: ${decision.text}\n`);
    history.push({ role: "business", text: decision.text });
  } else {
    console.log(`AI → HANDOFF to human (${decision.reason})`);
    console.log(`AI: ${decision.messageToCustomer}\n`);
    history.push({ role: "business", text: decision.messageToCustomer });
  }
}

rl.close();
