import { createApp } from "./app";
import { loadPikoConfig } from "./config";
import { ConversationStore } from "./chat/conversations";
import { createPiRuntime } from "./runtime/pi";
import { initializeWorkspace } from "./domain/workspace";
import { acquireBackendLock } from "./domain/backend-lock";
import { TelegramBot } from "./channels/telegram/bot";

const piko = loadPikoConfig();
for (const warning of piko.warnings) console.warn(warning);
const config = piko.http;
const paths = initializeWorkspace(piko.paths);
const releaseLock = acquireBackendLock(paths.state);
process.on("exit", releaseLock);
const runtime = createPiRuntime(paths);
// Open and validate native state, withdrawing inherited work before accepting requests.
await runtime.createSession();
const conversations = new ConversationStore(runtime);
const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  // Allow the 15-second SSE heartbeat to arrive before Bun's default idle timeout.
  idleTimeout: 60,
  fetch: createApp({ config, runtime, conversations }),
});

let telegram: TelegramBot | undefined;
if (piko.channels.telegram.enabled) {
  try { telegram = new TelegramBot(piko.channels.telegram, conversations, runtime); }
  catch { console.warn("Telegram initialization failed; RN remains available."); }
}

console.log(`Piko API listening at http://${server.hostname}:${server.port}`);
console.log(`pi-durable runtime; model configuration: ${paths.home}/config; read, write, edit and bash are enabled.`);
console.log(`Piko workspace: ${paths.workspace}`);
console.log(`Piko main conversation: root; state: ${paths.state}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  let failed = false;
  // Keep cleanup ordered, but attempt every resource even when an earlier one fails.
  for (const close of [() => telegram?.stopInput(), () => conversations.close(), () => telegram?.close(),
    () => runtime.dispose?.(), () => releaseLock()]) {
    try { await close(); }
    catch { failed = true; console.error("A Piko resource failed to close."); }
  }
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
// Startup is independent of HTTP readiness and is observed even if shutdown races it.
void telegram?.start();
