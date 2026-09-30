import { isRunActive, type Message, type RunSnapshot, type StreamEvent } from "../../shared/chat";
import type { ChatSession } from "../runtime/types";

const MAX_REPLAY_EVENTS = 2048;

/** A reply owns its runtime subscription independently of any HTTP connection. */
export class ChatRun {
  private state: RunSnapshot;
  private session?: ChatSession;
  private promptStarted = false;
  private events: StreamEvent[] = [];
  private listeners = new Set<(event: StreamEvent) => void>();

  constructor(id: string, message: string, readonly baseMessages: Message[]) {
    this.state = { id, message, status: "queued", text: "", createdAt: Date.now(), lastEventId: 0 };
  }

  get snapshot(): RunSnapshot { return { ...this.state }; }
  get active(): boolean { return isRunActive(this.state); }
  get started(): boolean { return this.promptStarted; }

  history(): Message[] {
    return [...this.baseMessages, {
      id: `user-${this.state.id}`, role: "user", content: this.state.message, createdAt: this.state.createdAt,
    }];
  }

  canReplay(after: number): boolean {
    return after <= this.state.lastEventId && after >= (this.events[0]?.sequence ?? 1) - 1;
  }

  subscribe(after: number, listener: (event: StreamEvent) => void): () => void {
    for (const event of this.events) if (event.sequence! > after) listener(event);
    if (this.active) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: StreamEvent): void {
    const recorded = { ...event, runId: this.state.id, sequence: ++this.state.lastEventId };
    this.events.push(recorded);
    if (this.events.length > MAX_REPLAY_EVENTS) this.events.shift();
    for (const listener of this.listeners) listener(recorded);
    if (!this.active) this.listeners.clear();
  }

  async execute(getSession: () => Promise<{ session: ChatSession; touchedAt: number }>): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let conversation: { session: ChatSession; touchedAt: number } | undefined;
    try {
      conversation = await getSession();
      if (!this.active) return;
      this.session = conversation.session;
      if (this.session.isStreaming) throw new Error("This conversation is already responding.");
      this.state.status = "running";
      let agentError: string | undefined;
      unsubscribe = this.session.subscribe((event) => {
        if (event.type === "delta") {
          this.state.text += event.text;
          this.emit(event);
        } else if (event.type === "error") agentError = event.message;
      });
      this.promptStarted = true;
      await this.session.prompt(this.state.message);
      if (this.snapshot.status === "cancelling") this.finish("cancelled");
      else if (agentError) this.finish("failed", agentError);
      else this.finish("succeeded");
    } catch (error) {
      if (this.active) {
        if (this.state.status === "cancelling") this.finish("cancelled");
        else this.finish("failed", error instanceof Error ? error.message : "Pi could not complete this reply.");
      }
    } finally {
      unsubscribe?.();
      if (conversation) conversation.touchedAt = Date.now();
    }
  }

  private finish(status: "succeeded" | "failed" | "cancelled", error?: string): void {
    this.state.status = status;
    if (error) this.state.error = error;
    this.emit(status === "succeeded" ? { type: "done" }
      : status === "cancelled" ? { type: "cancelled" }
        : { type: "error", message: error! });
  }

  async cancel(): Promise<void> {
    if (!this.active || this.state.status === "cancelling") return;
    if (!this.session) { this.finish("cancelled"); return; }
    this.state.status = "cancelling";
    try {
      await this.session.abort();
    } catch (error) {
      if (this.state.status === "cancelling") this.state.status = "running";
      throw error;
    }
  }
}
