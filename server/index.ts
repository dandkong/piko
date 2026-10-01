import { createApp } from "./app";
import { readServerConfig } from "./config";
import { ConversationStore } from "./chat/conversations";
import { createPiRuntime } from "./runtime/pi";
import { initializeWorkspace, resolveWorkspacePaths } from "./domain/workspace";
import { ChatRepository } from "./domain/chat-repository";
import { acquireBackendLock } from "./domain/backend-lock";

const config = readServerConfig();
const paths = initializeWorkspace(resolveWorkspacePaths());
const releaseLock = acquireBackendLock(paths.state);
process.on("exit", releaseLock);
const repository = new ChatRepository(paths.database, paths.workspace);
const runtime = createPiRuntime(paths);
// Validate the canonical conversation before accepting requests, without creating an agent.
runtime.readHistory(repository.context(repository.main.sessionId));
const conversations = new ConversationStore((context) => runtime.createSession(context), config, repository, runtime.readHistory);
const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  // Allow the 15-second SSE heartbeat to arrive before Bun's default idle timeout.
  idleTimeout: 60,
  fetch: createApp({ config, runtime, conversations }),
});

console.log(`Piko API listening at http://${server.hostname}:${server.port}`);
console.log("Pi model credentials are read from the Pi agent profile; read, write, edit and bash are enabled in the assistant workspace.");
console.log(`Piko workspace: ${paths.workspace}`);
console.log(`Piko main conversation: ${repository.main.sessionId}; state: ${paths.state}`);
