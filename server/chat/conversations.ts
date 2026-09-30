import type { Message } from "../../shared/chat";
import type { ChatSession } from "../runtime/types";
import { ChatRun } from "./run";

type Conversation = { session: ChatSession; touchedAt: number };
type StoreOptions = { idleSessionMs: number; maxSessions: number };

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly pending = new Map<string, Promise<Conversation>>();
  private readonly runs = new Map<string, ChatRun>();
  private readonly retiredRunIds = new Map<string, Set<string>>();

  constructor(
    private readonly createSession: () => Promise<ChatSession>,
    private readonly options: StoreOptions,
  ) { }

  get size() { return this.conversations.size; }

  isStreaming(sessionId: string): boolean {
    return this.runs.get(sessionId)?.active || (this.conversations.get(sessionId)?.session.isStreaming ?? false);
  }

  run(sessionId: string): ChatRun | undefined { return this.runs.get(sessionId); }

  startRun(sessionId: string, runId: string, message: string): ChatRun {
    for (const [id, run] of this.runs) {
      if (id !== sessionId && !run.active && !this.conversations.has(id) && !this.pending.has(id)) {
        this.runs.delete(id);
        this.retiredRunIds.delete(id);
      }
    }
    const existing = this.runs.get(sessionId);
    if (existing?.snapshot.id === runId) {
      if (existing.snapshot.message !== message) throw new Error("This runId was already used for another message.");
      return existing;
    }
    if (this.isStreaming(sessionId)) throw new Error("This conversation is already responding.");
    if (this.retiredRunIds.get(sessionId)?.has(runId)) throw new Error("This reply is no longer available. Reload the conversation.");
    if (existing) {
      const retired = this.retiredRunIds.get(sessionId) ?? new Set<string>();
      retired.add(existing.snapshot.id);
      this.retiredRunIds.set(sessionId, retired);
    }
    const run = new ChatRun(runId, message, this.history(sessionId).map((item) => ({ ...item })));
    // Reserve the turn before asynchronous session creation to prevent concurrent prompts.
    this.runs.set(sessionId, run);
    void run.execute(() => this.get(sessionId));
    return run;
  }

  history(sessionId: string): Message[] {
    const run = this.runs.get(sessionId);
    if (run?.active) return run.history();
    const conversation = this.conversations.get(sessionId);
    if (!conversation) return run?.history() ?? [];
    conversation.touchedAt = Date.now();
    const messages = conversation.session.messages;
    return run && !run.started ? run.history() : messages;
  }

  delete(sessionId: string): void {
    if (this.isStreaming(sessionId) || this.pending.has(sessionId)) throw new Error("Stop the active reply before deleting this conversation.");
    this.conversations.get(sessionId)?.session.dispose();
    this.conversations.delete(sessionId);
    this.runs.delete(sessionId);
    this.retiredRunIds.delete(sessionId);
  }

  async get(sessionId: string): Promise<Conversation> {
    const now = Date.now();
    for (const [id, value] of this.conversations) {
      if (now - value.touchedAt > this.options.idleSessionMs && !this.isStreaming(id)) {
        value.session.dispose();
        this.conversations.delete(id);
        this.runs.delete(id);
        this.retiredRunIds.delete(id);
      }
    }

    const existing = this.conversations.get(sessionId);
    if (existing) {
      existing.touchedAt = now;
      return existing;
    }
    const pending = this.pending.get(sessionId);
    if (pending) {
      const conversation = await pending;
      conversation.touchedAt = Date.now();
      return conversation;
    }

    if (this.conversations.size + this.pending.size >= this.options.maxSessions) {
      const oldest = [...this.conversations.entries()]
        .filter(([id]) => !this.isStreaming(id))
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) throw new Error("Piko is busy with other conversations. Try again shortly.");
      oldest[1].session.dispose();
      this.conversations.delete(oldest[0]);
      this.runs.delete(oldest[0]);
      this.retiredRunIds.delete(oldest[0]);
    }
    const creation = this.createSession().then((session) => ({ session, touchedAt: Date.now() }))
      .then((created) => {
        this.conversations.set(sessionId, created);
        return created;
      })
      .finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, creation);
    return creation;
  }

}
