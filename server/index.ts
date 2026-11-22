import { createApp } from "./app";
import { createAuth } from "./auth";
import { readConfigEnvironment } from "./config/files";
import { loadPikoConfig } from "./config";
import { ConversationStores } from "./chat/stores";
import { createPiRuntime } from "./runtime/pi";
import { initializeWorkspace } from "./workspace";
import { acquireBackendLock } from "./domain/backend-lock";
import { clearRuntimeTemp, migrateSentAttachments } from "./runtime/startup-files";
import { TelegramBot } from "./channels/telegram/bot";
import { join, resolve } from "node:path";
import { createWebHandler } from "./web";
import { AttachmentStore } from "./attachments/store";
import { ArtifactStore } from "./artifacts/store";
import { homedir } from "node:os";
import {
  configureLogging,
  logError,
  logInfo,
  logWarn,
} from "./logging";

// A production entry serves the prebuilt website; API development remains independent of Expo exports.
configureLogging(process.env.PIKO_HOME ?? join(homedir(), ".piko"));
logInfo("server.starting", { webEnabled: process.argv.includes("--web") });
let web: Awaited<ReturnType<typeof createWebHandler>> | undefined;
try {
  if (process.argv.includes("--web"))
    web = await createWebHandler(resolve(import.meta.dir, "../apps/mobile/dist/web"));
} catch (error) {
  logError("server.web.initialize_failed");
  throw error;
}
let piko: ReturnType<typeof loadPikoConfig>;
try {
  piko = loadPikoConfig();
} catch (error) {
  logError("server.configuration.failed");
  throw error;
}
const config = piko.http;
const env = readConfigEnvironment(piko.paths.home);
const allowedOrigins = (env.PIKO_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const auth = createAuth(env.PIKO_ACCESS_KEY ?? "", allowedOrigins);
let paths: ReturnType<typeof initializeWorkspace>;
try {
  paths = initializeWorkspace(piko.paths);
} catch (error) {
  logError("server.workspace.initialize_failed");
  throw error;
}
let releaseLock: () => void;
try {
  releaseLock = acquireBackendLock(paths.state);
} catch (error) {
  logError("server.lock.acquire_failed");
  throw error;
}
process.on("exit", releaseLock);
try {
  const migrated = await migrateSentAttachments(paths.state);
  if (migrated) logInfo("attachments.migration.completed", { migrated });
  await clearRuntimeTemp(paths.state);
  logInfo("runtime.temp.cleaned");
} catch {
  logError("runtime.startup_files.failed");
  throw new Error("Cannot prepare attachment or temporary storage.");
}
const runtime = createPiRuntime(paths);
// Telegram and app uploads share one store, outside the workspace; history references these paths.
const attachments = new AttachmentStore(join(paths.state, "attachments"));
const artifacts = new ArtifactStore(paths.workspace);
const chats = new ConversationStores(runtime);
const conversations = chats.main;
// Open and validate native state, withdrawing inherited work before accepting requests.
try {
  await conversations.get();
} catch (error) {
  logError("runtime.start_failed");
  throw error;
}
const server = Bun.serve({
  development: false,
  hostname: config.hostname,
  port: config.port,
  // Leave room for large durable task deletions to compact SQLite before replying.
  idleTimeout: 120,
  fetch: createApp({ config, runtime, conversations, chats, attachments, artifacts, web, auth }),
});

let telegram: TelegramBot | undefined;

logInfo("server.started", {
  host: server.hostname,
  port: server.port,
  webEnabled: !!web,
  telegramEnabled: piko.channels.telegram.enabled,
  runtime: "pi-durable",
});

let stopping = false;
async function shutdown(
  failed = false,
  reason: "signal" | "telegram_failure" | "exit_command" = "signal",
) {
  if (stopping) return;
  stopping = true;
  logInfo("server.shutdown.started", { reason });
  server.stop(true);
  // Keep cleanup ordered, but attempt every resource even when an earlier one fails.
  const resources: [string, () => Promise<void> | void | undefined][] = [
    ["telegram_input", () => telegram?.stopInput()],
    ["conversation_stores", () => chats.close()],
    ["telegram", () => telegram?.close()],
    ["runtime", () => runtime.dispose()],
    ["backend_lock", () => releaseLock()],
  ];
  for (const [resource, close] of resources) {
    try {
      await close();
    } catch {
      failed = true;
      logError("server.shutdown.resource_failed", { resource });
    }
  }
  logInfo("server.shutdown.completed", { failed, exitCode: failed ? 1 : 0 });
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", () => {
  void shutdown(false, "signal");
});
process.on("SIGTERM", () => {
  void shutdown(false, "signal");
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
        void shutdown(true, "telegram_failure");
      },
      () => {
        // Exit nonzero after graceful cleanup so Restart=on-failure can restart the service.
        setTimeout(() => void shutdown(true, "exit_command"), 0);
      },
    );
  } catch {
    logError("telegram.initialization.failed");
    void shutdown(true, "telegram_failure");
  }
}
// Startup is independent of HTTP readiness and is observed even if shutdown races it.
void telegram?.start();
