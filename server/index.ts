import { createApp } from "./app";
import { loadPikoConfig } from "./config";
import { ConversationStores } from "./chat/stores";
import { createPiRuntime } from "./runtime/pi";
import { initializeWorkspace } from "./workspace";
import { acquireBackendLock } from "./domain/backend-lock";
import { TelegramBot } from "./channels/telegram/bot";
import { join, resolve } from "node:path";
import { createWebHandler } from "./web";
import { AttachmentStore } from "./attachments";

// A production entry serves the prebuilt website; API development remains independent of Expo exports.
const web = process.argv.includes("--web")
  ? await createWebHandler(resolve(import.meta.dir, "../apps/mobile/dist/web"))
  : undefined;
const piko = loadPikoConfig();
const config = piko.http;
const paths = initializeWorkspace(piko.paths);
const releaseLock = acquireBackendLock(paths.state);
process.on("exit", releaseLock);
const runtime = createPiRuntime(paths);
// Telegram and app uploads share one store, outside the workspace; history references these paths.
const attachments = new AttachmentStore(join(paths.state, "attachments"));
void attachments
  .sweep(30 * 24 * 60 * 60 * 1000)
  .then((removed) => {
    if (removed) console.log(`Removed ${removed} expired attachment(s).`);
  })
  .catch(() => console.warn("Piko attachment cleanup failed."));
const chats = new ConversationStores(runtime);
const conversations = chats.main;
// Open and validate native state, withdrawing inherited work before accepting requests.
await conversations.get();
const server = Bun.serve({
  development: false,
  hostname: config.hostname,
  port: config.port,
  // Allow the 15-second SSE heartbeat to arrive before Bun's default idle timeout.
  idleTimeout: 60,
  fetch: createApp({ config, runtime, conversations, chats, attachments, web }),
});

let telegram: TelegramBot | undefined;

console.log(`Piko API listening at http://${server.hostname}:${server.port}`);
if (web) console.log("Piko Web is available at the same address.");
console.log(
  `pi-durable runtime; model configuration: ${paths.home}/config; read, write, edit and bash are enabled.`,
);
console.log(`Piko workspace: ${paths.workspace}`);
console.log(`Piko main conversation: root; state: ${paths.state}`);

let stopping = false;
async function shutdown(failed = false) {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  // Keep cleanup ordered, but attempt every resource even when an earlier one fails.
  for (const close of [
    () => telegram?.stopInput(),
    () => chats.close(),
    () => telegram?.close(),
    () => runtime.dispose(),
    () => releaseLock(),
  ]) {
    try {
      await close();
    } catch {
      failed = true;
      console.error("A Piko resource failed to close.");
    }
  }
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
// Fatal Telegram failures exit cleanly with a failure code so the service manager can restart.
if (piko.channels.telegram.enabled) {
  try {
    telegram = new TelegramBot(
      piko.channels.telegram,
      conversations,
      runtime,
      attachments,
      undefined,
      () => {
        void shutdown(true);
      },
    );
  } catch {
    console.warn("Telegram initialization failed; restarting service.");
    void shutdown(true);
  }
}
// Startup is independent of HTTP readiness and is observed even if shutdown races it.
void telegram?.start();
