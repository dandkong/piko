import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID, type AgentEventStream, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { ConversationResponse } from "../../shared/chat";
import type { WorkspacePaths } from "../../server/domain/workspace";
import { createPiRuntime, DurableChatSession } from "../../server/runtime/pi";
import { sessionDirectory } from "../../server/runtime/pi-context";
import { runtimePaths } from "../../server/runtime/config/paths";
import { entriesFromTransaction, inputsFromStorage, projectPiHistory } from "../../server/runtime/pi-history";
import { internalInput } from "../../server/runtime/input-origin";

export type TestChatSession = DurableChatSession & { prompt(text: string, input: { id: string; createdAt: number }): Promise<void> };

/** Test-only completion barrier: native settlement and delivered output are separate assertions. */
function testSession(session: DurableChatSession): TestChatSession {
  return Object.assign(session, { async prompt(text: string, input: { id: string; createdAt: number }) {
    const finals = new Set(session.messages.map(message => message.id));
    const delivered = Promise.withResolvers<void>(); let answer: string | undefined;
    const unsubscribe = session.subscribe(event => {
      if (event.type === "message" && event.final) {
        finals.add(event.message.id);
        if (event.message.id === answer) delivered.resolve();
      }
    });
    // Tests also inject a failed/lagging consumer; inspect its native watch only here, not in the product API.
    const stream = (session as unknown as { eventStream: AgentEventStream }).eventStream;
    try {
      const admitted = await session.submit(text, input.id);
      const handle = (await session.nativeHarness.submission(Number(admitted.submission.id) as SubmissionId, ctx))!;
      const settled = await handle.wait(ctx);
      await session.native.waitForIdle(ctx);
      if (settled.status === "unanswered") throw new Error(typeof settled.detail === "string" ? settled.detail : settled.reason === "aborted" ? "Reply stopped." : settled.reason);
      if (settled.type === "input" && settled.status === "done") {
        answer = `pi-${settled.answer}`;
        if (finals.has(answer)) delivered.resolve();
        await Promise.race([
          delivered.promise,
          stream.closed.then(end => { throw end.reason === "listener_error" ? end.error : new Error(`Durable event stream closed: ${end.reason}`); }),
        ]);
      }
    } finally { unsubscribe(); }
  } });
}

/** Offline inspection is a test utility, never a second production storage-opening path. */
async function readSavedHistory(paths: WorkspacePaths): Promise<ConversationResponse> {
  const directory = sessionDirectory(runtimePaths(paths.home).sessions);
  if (!existsSync(join(directory, "main.jsonl"))) return { messages: [], busy: false };
  const storage = await openNodeJsonlStorage(directory, ctx, { fsync: true });
  const session = createSession(storage);
  try {
    return await session.commit(async tx => {
      if (!await tx.conversation(ROOT_CONVERSATION_ID)) throw new Error("Durable root conversation is missing.");
      const entries = await entriesFromTransaction(tx); const inputs = await inputsFromStorage(storage); const hidden = new Set<number>();
      for (const [entry, requestId] of inputs) if (await internalInput(tx, requestId)) hidden.add(entry);
      return { ...projectPiHistory(entries, inputs, hidden), busy: false };
    }, ctx);
  } finally { await session.close(ctx); }
}

export function createTestRuntime(paths: WorkspacePaths, options: Parameters<typeof createPiRuntime>[1] = {}) {
  const runtime = createPiRuntime(paths, options); let session: TestChatSession | undefined;
  return { ...runtime,
    createSession: async () => session = testSession(await runtime.createSession() as DurableChatSession),
    readHistory: async () => session && !session.closePromise ? session.snapshot() : readSavedHistory(paths),
  };
}
