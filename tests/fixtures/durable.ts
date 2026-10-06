import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { initializeWorkspace, resolveWorkspacePaths } from "../../server/domain/workspace";
import { createPiRuntime } from "../../server/runtime/pi";
import { ChatRepository } from "../../server/domain/chat-repository";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export function cleanup(fn: () => Promise<unknown> | void) { cleanups.push(fn); }

export async function fixture(tokensPerSecond = 100_000) {
  const root = await mkdtemp(join(tmpdir(), "piko-durable-test-"));
  cleanup(async () => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    await rm(root, { recursive: true, force: true });
  });
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  const faux = fauxProvider({ tokensPerSecond, models: [
    { id: "fast", name: "Fast", reasoning: false, contextWindow: 250_000 },
    { id: "reasoning", name: "Reasoning", reasoning: true, contextWindow: 250_000 },
  ] });
  const models = createModels(); models.setProvider(faux.provider);
  const createRuntime = () => { const runtime = createPiRuntime(paths, { models }); cleanup(() => runtime.dispose!()); return runtime; };
  const runtime = createRuntime();
  const input = { threadId: crypto.randomUUID(), interruptedRunIds: [] as string[] };
  return { root, paths, faux, models, runtime, input, createSession: () => runtime.createSession(input), createRuntime };
}

export function repository(paths: Awaited<ReturnType<typeof fixture>>["paths"]) {
  const repo = new ChatRepository(paths.database, paths.workspace);
  cleanup(() => repo.close()); return repo;
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for durable state");
    await Bun.sleep(10);
  }
}
