import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { configure, defineDoc, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { internalInput } from "./input-origin";
import { messageText } from "./pi-history";
import { MEMORY_CURATION_MAX_INPUT_CHARS, buildMemoryCurationPrompt, localDate, redactMemorySecrets, type MemoryCurationMessage } from "../domain/memory-curation";

export const MEMORY_CURATION_KIND = "piko.memory-curation";
export const MEMORY_CURATION_IDLE_MS = 30 * 60_000;
export function memoryCurationIsDue(idleSince: number | null, now: number, busy: boolean, retryAfter: number | null): boolean {
  return !busy && idleSince !== null && now - idleSince >= MEMORY_CURATION_IDLE_MS && (retryAfter === null || now >= retryAfter);
}
const MEMORY_CURATION_POLL_MS = 15_000;
const MEMORY_CURATION_RETRY_MS = 30 * 60_000;
const CURATOR_AGENT_INSTRUCTIONS = "You are Piko's memory curator. Edit the workspace memory files directly with the read/write/edit tools, and verify tool results before reporting changes. The workspace is not a security sandbox.";
// The curator edits files directly; a shell is not needed to maintain two Markdown paths.
const CURATOR_AGENT_TOOLS = (CodingTools.tools ?? []).filter(tool => tool.name !== "bash");

export type MemoryCurationState = {
  initialized: boolean;
  cursor: number;
  idleSince: number | null;
  activeTaskId: number | null;
  retryAfter: number | null;
};
export const MemoryCurationDoc = defineDoc<MemoryCurationState>({
  kind: MEMORY_CURATION_KIND, version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ initialized: false, cursor: 0, idleSince: null, activeTaskId: null, retryAfter: null }),
});

type CurationInput = { fromEntryId: number; throughEntryId: number; timezone: string; requestedAt: number };
type CurationCheckpoint = { phase: "curation"; childId?: number };
type CurationResult = { reviewedThrough: number };
type CurationTask = ReturnType<typeof createCurationTask>;
type Runtime = TaskRuntime<CurationInput, CurationCheckpoint, CurationResult, object>;
type CollectedMessages = { messages: MemoryCurationMessage[]; throughEntryId: number };

async function rootHighWater(tx: Tx): Promise<number> {
  const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1);
  return page.items[0]?.id ?? 0;
}

function safeError(): string { return "Memory review failed; it can be retried."; }

/** Collect only external, user-visible root chat text. Internal reports and tool results are not memory input. */
async function collectMessages(tx: Tx, from: number, through: number, timezone: string, bindings: ReadonlyMap<number, string>, now: number): Promise<CollectedMessages> {
  const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
  if (through > from) do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: (from + 1) as EntryId,
      maxEntryId: through as EntryId, order: "ascending" }, 500, cursor);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);

  const internalUsers = new Set<number>(); const internalAnswers = new Set<number>();
  for (const entry of entries) {
    if (entry.kind !== "pi.user") continue;
    const requestId = bindings.get(entry.id);
    if (!await internalInput(tx, requestId)) continue;
    internalUsers.add(entry.id);
    const submission = requestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId) : undefined;
    if (submission?.type === "input" && submission.status === "done") internalAnswers.add(submission.answer);
  }

  const messages: MemoryCurationMessage[] = []; let chars = 0; let processed = from;
  for (const entry of entries) {
    if ((entry.kind !== "pi.user" && entry.kind !== "pi.assistant") || internalUsers.has(entry.id) || internalAnswers.has(entry.id)) {
      processed = entry.id; continue;
    }
    const parts = (entry.model ?? []).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({ timestamp: typeof message.timestamp === "number" ? message.timestamp : now, content: redactMemorySecrets(messageText(message.content)).trim() }))
      .filter(message => message.content.length > 0);
    if (!parts.length) { processed = entry.id; continue; }
    const role = entry.kind === "pi.user" ? "user" : "assistant";
    const cost = parts.reduce((sum, part) => sum + part.content.length, 0);
    if (messages.length && chars + cost > MEMORY_CURATION_MAX_INPUT_CHARS) break;
    let remaining = MEMORY_CURATION_MAX_INPUT_CHARS - chars;
    for (const part of parts) {
      if (remaining <= 0) break;
      const content = part.content.length > remaining ? `${part.content.slice(0, remaining)}\n[This message was abbreviated for memory review.]` : part.content;
      messages.push({ role, date: localDate(part.timestamp, timezone), content });
      remaining -= Math.min(part.content.length, remaining);
    }
    chars += Math.min(cost, MEMORY_CURATION_MAX_INPUT_CHARS - chars);
    processed = entry.id;
    if (chars >= MEMORY_CURATION_MAX_INPUT_CHARS) break;
  }
  return { messages, throughEntryId: Math.max(from, processed) };
}

function createCurationTask(workspace: string, bindings: () => ReadonlyMap<number, string>) {
  const fail = async (taskId: TaskId<CurationResult>, runtime: Runtime, ctx: typeof context) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (state.activeTaskId === Number(taskId)) { state.activeTaskId = null; state.retryAfter = runtime.now() + MEMORY_CURATION_RETRY_MS; }
      return { status: "terminal", outcome: { status: "failed", error: { message: safeError() } } } as const;
    }, ctx);
  };
  const completeWithoutModel = async (task: { id: TaskId<CurationResult>; input: CurationInput }, runtime: Runtime, ctx: typeof context) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (state.cursor === task.input.fromEntryId) state.cursor = task.input.throughEntryId;
      if (state.activeTaskId === Number(task.id)) state.activeTaskId = null;
      state.retryAfter = null;
      return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: task.input.throughEntryId } } } as const;
    }, ctx);
  };

  return defineTask<CurationInput, CurationCheckpoint, CurationResult>({
    name: MEMORY_CURATION_KIND, version: 1, initial: () => ({ phase: "curation" }),
    phases: {
      curation: async (taskRecord, runtime, ctx) => {
        try {
          let collected: CollectedMessages | undefined;
          await runtime.commit(async tx => { collected = await collectMessages(tx, taskRecord.input.fromEntryId, taskRecord.input.throughEntryId,
            taskRecord.input.timezone, bindings(), taskRecord.input.requestedAt); return undefined; }, ctx);
          if (!collected?.messages.length) { await completeWithoutModel(taskRecord, runtime, ctx); return; }
          const agent = await runtime.agent(ctx);
          if (!agent.model) throw new Error("No model is configured for memory review.");

          let childId = taskRecord.state.checkpoint.childId as ConversationId | undefined;
          if (childId === undefined) {
            await runtime.commit(async tx => {
              const child = await tx.createConversation({ ownership: { kind: "task", taskId: taskRecord.id } });
              await configure(tx, child.id, { model: agent.model, thinkingLevel: agent.thinkingLevel,
                extensions: [CodingTools], tools: CURATOR_AGENT_TOOLS, cwd: workspace, instructions: CURATOR_AGENT_INSTRUCTIONS });
              childId = child.id;
              return { status: "running", checkpoint: { phase: "curation", childId: Number(child.id) } } as const;
            }, ctx);
          }
          const child = await runtime.conversation(childId!, ctx);
          if (!child) throw new Error("Memory review conversation is unavailable.");
          const memoryBytes = await stat(join(workspace, "MEMORY.md")).then(value => value.size).catch(() => 0);
          const prompt = buildMemoryCurationPrompt(collected!.messages, { bytes: memoryBytes });
          const submission = await child.submit({ type: "input", content: prompt, requestId: `piko:memory-curation:${taskRecord.id}`, whenBusy: "reject" }, ctx);
          const settled = await submission.wait(ctx);
          if (settled.status !== "done" || settled.type !== "input") throw new Error("Memory review generation did not complete.");
          await runtime.commit(async tx => {
            const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
            if (state.cursor !== taskRecord.input.fromEntryId) throw new Error("Memory review cursor changed before commit.");
            state.cursor = taskRecord.input.throughEntryId;
            if (state.activeTaskId === Number(taskRecord.id)) state.activeTaskId = null;
            state.retryAfter = null;
            return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: taskRecord.input.throughEntryId } } } as const;
          }, ctx);
        } catch {
          if (runtime.signal.aborted) return;
          await fail(taskRecord.id, runtime, ctx);
        }
      },
    },
    abort: async (taskRecord, runtime, ctx) => {
      await runtime.commit(async tx => {
        const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
        if (state.activeTaskId === Number(taskRecord.id)) {
          state.activeTaskId = null;
          state.retryAfter = runtime.now() + MEMORY_CURATION_RETRY_MS;
        }
        return { status: "terminal", outcome: { status: "aborted", reason: "Memory review interrupted." } } as const;
      }, ctx);
    },
  });
}

export class MemoryCurationService {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<"started" | "nothing-new">;
  private closing = false;
  private readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  constructor(private readonly harness: Harness, private readonly task: CurationTask, private readonly bindings: () => ReadonlyMap<number, string>,
    private readonly now = Date.now) {}

  async start(): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      const highWater = await rootHighWater(tx);
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!state.initialized) {
        state.initialized = true;
        state.cursor = highWater; // Deliberately do not backfill history from before memory review was enabled.
        state.idleSince = null;
      } else if (!busy && state.idleSince === null && highWater > state.cursor) state.idleSince = this.now();
      if (state.activeTaskId !== null) {
        const active = await tx.task(state.activeTaskId as TaskId);
        if (!active || active.state.status === "terminal") state.activeTaskId = null;
      }
    }, context);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick().catch(error => this.log(error)); }, MEMORY_CURATION_POLL_MS);
      this.timer.unref();
    }
  }

  close(): void { this.closing = true; clearInterval(this.timer); this.timer = undefined; }

  async onRunStart(): Promise<void> {
    await this.harness.commit(async tx => { (await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID)).idleSince = null; }, context);
  }
  async onRunEnd(): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      state.idleSince = this.now(); state.retryAfter = null;
    }, context);
  }

  private log(error: unknown): void {
    console.warn("Piko memory review:", error instanceof Error ? error.message : "failed");
  }

  tick(): Promise<"started" | "nothing-new"> { return this.drive(); }

  private drive(): Promise<"started" | "nothing-new"> {
    if (this.closing) return Promise.resolve("nothing-new");
    if (this.pending) return this.pending;
    this.pending = this.schedule().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async schedule(): Promise<"started" | "nothing-new"> {
    const snapshot = await this.harness.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (!state.initialized) return undefined;
      if (state.activeTaskId !== null) {
        const active = await tx.task(state.activeTaskId as TaskId);
        if (active && active.state.status !== "terminal") return { kind: "active" as const };
        state.activeTaskId = null;
      }
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!memoryCurationIsDue(state.idleSince, this.now(), busy, state.retryAfter)) {
        if (busy) state.idleSince = null;
        return undefined;
      }
      const highWater = await rootHighWater(tx) || state.cursor;
      if (highWater <= state.cursor) { state.retryAfter = null; return undefined; }
      const batch = await collectMessages(tx, state.cursor, highWater, this.timezone, this.bindings(), this.now());
      if (!batch.messages.length) {
        state.cursor = highWater;
        state.retryAfter = null;
        return { kind: "empty" as const };
      }
      return { kind: "batch" as const, fromEntryId: state.cursor, throughEntryId: batch.throughEntryId, highWater };
    }, context);
    if (!snapshot || snapshot.kind === "active" || snapshot.kind === "empty") return "nothing-new";

    let result: number | undefined;
    await this.harness.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (state.activeTaskId !== null || state.cursor !== snapshot.fromEntryId) return;
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!memoryCurationIsDue(state.idleSince, this.now(), busy, state.retryAfter)) return;
      if ((await rootHighWater(tx)) > snapshot.highWater) return;
      const id = await tx.createTask(this.task, { fromEntryId: snapshot.fromEntryId, throughEntryId: snapshot.throughEntryId,
        timezone: this.timezone, requestedAt: this.now() },
      { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
      result = Number(id); state.activeTaskId = Number(id); state.retryAfter = null;
    }, context);
    return result === undefined ? "nothing-new" : "started";
  }
}

export function createMemoryCurationExtension(options: { workspace: string; bindings: () => ReadonlyMap<number, string> }) {
  const task = createCurationTask(options.workspace, options.bindings);
  return { task, extension: defineExtension({ name: "piko-memory-curation", tasks: [task] }) };
}
