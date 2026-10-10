import { isRunActive, type RunSnapshot, type StreamEvent } from "../../shared/chat";
import type { ChatSession, SessionEvent } from "../runtime/types";
import { SessionCancelledError } from "../runtime/types";
import type { MessageEvent } from "../../shared/messages";

const MAX_REPLAY_EVENTS = 2048;
/** A submission receipt observes conversation output independently of HTTP connections. */
export class ChatRun {
  private state: RunSnapshot;
  private session?: ChatSession;
  private promptStarted = false;
  private events: StreamEvent[] = [];
  private listeners = new Set<(event: StreamEvent) => void>();
  private pendingMessage?: MessageEvent;
  private output = new Map<string, MessageEvent>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private storageError?: unknown;

  constructor(snapshot: RunSnapshot, private readonly checkpoint: (snapshot: RunSnapshot, runtimeState?: unknown) => void,
    private readonly cancelExecution?: () => Promise<void>) {
    this.state = { ...snapshot };
  }

  get snapshot(): RunSnapshot { return { ...this.state }; }
  /** Transient independent message snapshots for delivery; native history owns persisted content. */
  get outputs(): readonly MessageEvent[] { return [...this.output.values()]; }
  get active(): boolean { return isRunActive(this.state); }
  canReplay(after: number): boolean {
    // A restored Run has metadata but no persistent SSE event log.
    if (!this.events.length && this.state.lastEventId > 0) return false;
    return after <= this.state.lastEventId && after >= (this.events[0]?.sequence ?? 1) - 1;
  }

  subscribe(after: number, listener: (event: StreamEvent) => void): () => void {
    for (const event of this.events) if (event.sequence! > after) listener(event);
    if (this.active) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private persist(next: RunSnapshot, event?: StreamEvent): void {
    if (this.storageError) throw this.storageError;
    if (event?.type === "message" || event?.type === "refresh") return;
    try {
      this.checkpoint(next,
        event && !isRunActive(next) && this.promptStarted ? this.session?.exportState?.() : undefined);
    } catch (error) {
      // Do not report completion after a failed native flush or metadata transaction.
      this.storageError = error;
      void this.session?.abort().catch((cause) => console.error("Could not stop reply after a storage failure:", cause));
      throw error;
    }
  }

  private emit(event: StreamEvent, changes: Partial<RunSnapshot> = {}): void {
    const recorded = { ...event, runId: this.state.id, sequence: this.state.lastEventId + 1 };
    const next = { ...this.state, ...changes, lastEventId: recorded.sequence };
    this.persist(next, recorded);
    this.state = next;
    this.events.push(recorded);
    if (this.events.length > MAX_REPLAY_EVENTS) this.events.shift();
    for (const listener of this.listeners) listener(recorded);
    if (!this.active) this.listeners.clear();
  }

  private flushMessage(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pendingMessage) return;
    const event = this.pendingMessage;
    if (event.previousId) this.output.delete(event.previousId);
    this.output.set(event.message.id, event);
    this.emit(event);
    this.pendingMessage = undefined;
  }

  async execute(getSession: () => Promise<{ session: ChatSession; touchedAt: number }>): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let conversation: { session: ChatSession; touchedAt: number } | undefined;
    try {
      conversation = await getSession();
      if (!this.active) return;
      this.session = conversation.session;
      const running = { ...this.state, status: "running" as const };
      this.persist(running);
      this.state = running;
      let agentError: string | undefined;
      const receive = (event: SessionEvent) => {
        if (event.type === "message") {
          if (this.pendingMessage && this.pendingMessage.message.id !== event.message.id) this.flushMessage();
          this.pendingMessage = event;
          if (event.final || this.state.lastEventId === 0) this.flushMessage();
          else if (!this.flushTimer) this.flushTimer = setTimeout(() => {
            try { this.flushMessage(); }
            catch (error) {
              agentError = error instanceof Error ? error.message : "Could not save reply.";
              void this.session?.abort().catch((cause) => console.error("Could not stop reply after a storage failure:", cause));
            }
          }, 50);
        } else if (event.type === "error") agentError = event.message;
        else if (event.type === "refresh") { this.flushMessage(); this.emit(event); }
      };
      unsubscribe = this.session.subscribe(receive);
      const partial = this.session.messages.find(message => message.id.startsWith("live-"));
      if (partial) receive({ type: "message", message: partial, final: false });
      this.promptStarted = true;
      await this.session.prompt(this.state.message, { id: this.state.id, createdAt: this.state.createdAt });
      if (this.snapshot.status === "cancelling") this.finish("cancelled");
      else if (agentError) this.finish("failed", agentError);
      else this.finish("succeeded");
    } catch (error) {
      if (this.storageError) throw this.storageError;
      if (this.active) {
        if (this.state.status === "cancelling" || error instanceof SessionCancelledError) this.finish("cancelled");
        else this.finish("failed", error instanceof Error ? error.message : "Pi could not complete this reply.");
      }
    } finally {
      clearTimeout(this.flushTimer);
      unsubscribe?.();
      if (conversation) conversation.touchedAt = Date.now();
    }
  }

  private finish(status: "succeeded" | "failed" | "cancelled", error?: string): void {
    this.flushMessage();
    this.emit(status === "succeeded" ? { type: "done" }
      : status === "cancelled" ? { type: "cancelled" }
        : { type: "error", message: error! }, { status, ...(error && { error }) });
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    if (this.cancelExecution) return this.cancelExecution();
    return this.cancelCurrent();
  }

  async cancelCurrent(): Promise<void> {
    if (!this.active || this.state.status === "cancelling") return;
    if (!this.session) { this.finish("cancelled"); return; }
    const cancelling = { ...this.state, status: "cancelling" as const };
    this.persist(cancelling);
    this.state = cancelling;
    try {
      await this.session.abort();
    } catch (error) {
      if (this.state.status === "cancelling") {
        const running = { ...this.state, status: "running" as const };
        this.persist(running);
        this.state = running;
      }
      throw error;
    }
  }
}
