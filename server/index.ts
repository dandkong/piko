import { createApp } from "./app";
import { readServerConfig } from "./config";
import { ConversationStore } from "./chat/conversations";
import { createPiRuntime } from "./runtime/pi";

const config = readServerConfig();
const runtime = createPiRuntime();
const conversations = new ConversationStore(() => runtime.createSession(), config);
const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: createApp({ config, runtime, conversations }),
});

console.log(`Piko API listening at http://${server.hostname}:${server.port}`);
console.log("Pi model credentials are read from the Pi agent profile; coding tools are disabled.");
