import type { Message } from "../../shared/chat";
import type { ChatSession, SessionContext, HistoryReader } from "../runtime/types";
import { submissionHash, type ChatRepository, type RunRecord, type TelegramInput, type TelegramReceipt } from "../domain/chat-repository";
import { ChatRun } from "./run";
import { normalizeMessage } from "./input";

type Conversation = { session: ChatSession; touchedAt: number };
type StoreOptions = { idleSessionMs: number; maxSessions: number };

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly pending = new Map<string, Promise<Conversation>>();
  private readonly runs = new Map<string, ChatRun>();
  private readonly executions = new Set<Promise<void>>();
  private storageFailure?: Error;
  private closing = false;

  constructor(
    private readonly createSession: (context?: SessionContext) => Promise<ChatSession>,
    private readonly options: StoreOptions,
    private readonly repository: ChatRepository,
    private readonly readHistory: HistoryReader,
  ) {}

  get size() { return this.conversations.size; }
  get main() { return this.repository.main; }
  context() { return this.repository.context(this.main.sessionId); }
  get unavailableReason() { return this.storageFailure?.message; }
  accepts(sessionId: string): boolean { return this.main.thread.id === sessionId; }

  isStreaming(sessionId: string): boolean {
    return this.runs.get(sessionId)?.active || (this.conversations.get(sessionId)?.session.isStreaming ?? false);
  }

  async run(sessionId: string, runId?: string): Promise<ChatRun | undefined> {
    const cached = this.runs.get(sessionId);
    if (cached && (!runId || cached.snapshot.id === runId)) return cached;
    const record = runId ? this.repository.run(sessionId, runId) : this.repository.latest(sessionId);
    if (!record) return undefined;
    const content = (await this.readHistory(this.repository.context(sessionId))).runs.get(record.id);
    const { inputHash: _, ...metadata } = record;
    return new ChatRun({ ...metadata, message: content?.message ?? "", text: content?.text ?? "" },
      (state, runtimeState) => this.repository.checkpoint(sessionId, state, runtimeState));
  }

  async startRun(sessionId: string, runId: string, message: string, retryOfRunId?: string): Promise<ChatRun> {
    this.requireAvailable();
    message = normalizeMessage(message);
    if (!this.accepts(sessionId)) throw new Error("This client uses an old conversation. Reload to open the main conversation.");
    const previous = this.repository.run(sessionId, runId);
    if (previous) {
      if (previous.inputHash !== submissionHash(message) || previous.retryOfRunId !== retryOfRunId) throw new Error("This runId was already used for another submission.");
      return (await this.run(sessionId, runId))!;
    }
    // Validate canonical history before reserving an execution.
    await this.readHistory(this.repository.context(sessionId));
    this.requireAvailable();
    // Another submission may have reserved this identity while history was read.
    if (this.repository.run(sessionId, runId)) {
      const record = this.repository.reserve(sessionId, runId, message, retryOfRunId);
      return (await this.run(sessionId, record.id))!;
    }
    if (this.isStreaming(sessionId)) throw new Error("This conversation is already responding.");
    return this.launchRun(sessionId, this.repository.reserve(sessionId, runId, message, retryOfRunId), message);
  }

  async startTelegram(input: TelegramInput, message: string): Promise<TelegramReceipt & { run?: ChatRun }> {
    this.requireAvailable();
    let invalid = false;
    try { message = normalizeMessage(message); } catch { invalid = true; }
    const sessionId = this.main.sessionId;
    await this.readHistory(this.context());
    this.requireAvailable();
    const receipt = this.repository.admitTelegram(sessionId, input, message, invalid, this.isStreaming(sessionId));
    if (!receipt.runId) return receipt;
    const run = receipt.duplicate ? await this.run(sessionId, receipt.runId)
      : this.launchRun(sessionId, this.repository.run(sessionId, receipt.runId)!, message);
    return { ...receipt, run };
  }

  private requireAvailable(): void {
    if (this.storageFailure) throw this.storageFailure;
    if (this.closing) throw new Error("Piko is shutting down.");
  }

  async stopTelegram(input: TelegramInput, message: string): Promise<boolean> {
    this.requireAvailable();
    const receipt = this.repository.rememberTelegramStop(this.main.sessionId, input, message);
    if (!receipt.runId) return false;
    const run = await this.run(this.main.sessionId, receipt.runId);
    if (run?.active) await run.cancel();
    return true;
  }

  private launchRun(sessionId: string, record: RunRecord, message: string): ChatRun {
    const { inputHash: _, ...metadata } = record;
    const run = new ChatRun({ ...metadata, message, text: "" },
      (state, runtimeState) => this.repository.checkpoint(sessionId, state, runtimeState));
    this.runs.set(sessionId, run);
    const execution = run.execute(() => this.get(sessionId)).catch((error) => {
      this.storageFailure = new Error("Reply storage is unavailable. Fix the storage issue and restart Piko to recover saved history.");
      console.error("Reply persistence failed:", error);
    });
    this.executions.add(execution);
    void execution.finally(() => this.executions.delete(execution));
    return run;
  }

  async history(sessionId: string): Promise<Message[]> {
    const messages = (await this.readHistory(this.repository.context(sessionId))).messages;
    const run = this.runs.get(sessionId);
    if (!run?.active) return messages;
    // Completed native fragments of this execution are already included in its live snapshot.
    const visible = messages.filter((message) => message.runId !== run.snapshot.id || message.role !== "assistant");
    if (!visible.some((message) => message.runId === run.snapshot.id && message.role === "user")) {
      visible.push({ id: `user-${run.snapshot.id}`, role: "user", content: run.snapshot.message,
        createdAt: run.snapshot.createdAt, runId: run.snapshot.id });
    }
    return visible;
  }

  delete(_sessionId: string): never { throw new Error("Deleting the persistent main conversation is not available."); }

  async get(sessionId: string): Promise<Conversation> {
    const now = Date.now();
    for (const [id, value] of this.conversations) {
      if (now - value.touchedAt > this.options.idleSessionMs && !this.isStreaming(id)) {
        await value.session.dispose();
        this.conversations.delete(id);
      }
    }
    const existing = this.conversations.get(sessionId);
    if (existing) { existing.touchedAt = now; return existing; }
    const pending = this.pending.get(sessionId);
    if (pending) {
      const conversation = await pending;
      conversation.touchedAt = Date.now();
      return conversation;
    }
    if (this.conversations.size + this.pending.size >= this.options.maxSessions) {
      const oldest = [...this.conversations.entries()].filter(([id]) => !this.isStreaming(id))
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) throw new Error("Piko is busy with other conversations. Try again shortly.");
      await oldest[1].session.dispose();
      this.conversations.delete(oldest[0]);
      this.runs.delete(oldest[0]);
    }
    const context = this.repository.context(sessionId);
    const creation = this.createSession(context).then(async (session) => {
      if (session.exportState) {
        try { this.repository.saveRuntime(sessionId, session.exportState()); }
        catch (error) { await session.dispose(); throw error; }
      }
      const created = { session, touchedAt: Date.now() };
      this.conversations.set(sessionId, created);
      return created;
    }).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, creation);
    return creation;
  }

  async dispose(): Promise<void> {
    if ([...this.runs.values()].some((run) => run.active) || this.pending.size) throw new Error("Stop active replies before disposing the conversation store.");
    for (const value of this.conversations.values()) await value.session.dispose();
    this.conversations.clear();
    this.runs.clear();
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.runs.values()].filter(run => run.active).map(run => run.cancel()));
    await Promise.all([...this.executions]);
    await this.dispose();
  }
}
