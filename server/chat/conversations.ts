import { CHAT_PAGE_SIZE, type ConversationResponse, type StreamEvent } from "../../shared/chat";
import type { CompactionEvent } from "../../shared/runtime";
import type { BackgroundReply, InputSource, ChatRuntime, ChatSession } from "../runtime/types";
import { normalizeMessage } from "./input";
/** Conversation-wide observation. The runtime owns input ordering and maintenance. */
export class ConversationStore {
  private listeners = new Set<(event: StreamEvent) => void>();
  private opening?: Promise<ChatSession>;
  private session?: ChatSession;
  private unsubscribe?: () => void;
  private closing = false;
  private pump?: Promise<void>;
  private dirty = false;
  private messages = new Map<string, Extract<StreamEvent, { type: "message" }>>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly runtime: ChatRuntime, readonly conversationId?: string) {}
  get size() { return this.session ? 1 : 0; }
  isStreaming() { return this.session?.isStreaming ?? false; }
  async get(): Promise<ChatSession> {
    if (this.closing) throw new Error("Piko is shutting down.");
    return this.opening ??= this.runtime.createSession(this.conversationId).then(session => {
      this.session = session;
      this.unsubscribe = session.subscribe(event => {
        // Tool activity is live-only and channel-specific; it never changes history.
        if (event.type === "tool" || event.type === "tool-clear" || event.type === "compaction") return;
        if (event.type === "error") this.publish(event);
        else if (event.type === "message") {
          if (event.previousId) this.messages.delete(event.previousId);
          this.messages.set(event.message.id, event);
        } else this.dirty = true;
        if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 50);
      });
      return session;
    }).catch(error => { this.opening = undefined; throw error; });
  }
  private publish(event: StreamEvent) {
    for (const listener of this.listeners) listener(event);
  }
  /** Coalesce output into consistent conversation snapshots, never per-input replies. */
  async flush() {
    if (this.pump) return this.pump;
    this.pump = (async () => {
      while ((this.dirty || this.messages.size) && !this.closing) {
        const messages = [...this.messages.values()]; this.messages.clear();
        for (const message of messages) this.publish(message);
        if (this.dirty) {
          this.dirty = false;
          const conversation = await (await this.get()).snapshot({ limit: CHAT_PAGE_SIZE });
          this.publish({ type: "snapshot", conversation });
        }
      }
    })().catch(error => this.publish({ type: "error", message: error instanceof Error ? error.message : "Could not read conversation." })).finally(() => { this.pump = undefined; });
    return this.pump;
  }
  async snapshot(options?: { limit: number }): Promise<ConversationResponse> { return (await this.get()).snapshot(options); }
  async history(before?: string) { return (await this.get()).history(before, CHAT_PAGE_SIZE); }
  async submit(message: string, requestId: string, source?: InputSource, attachments?: readonly string[]) {
    message = normalizeMessage(message, !!attachments?.length);
    const result = await (await this.get()).submit(message, requestId, source, attachments);
    this.dirty = true; await this.flush(); return result;
  }
  async subscribeBackgroundReplies(listener: (reply: BackgroundReply) => Promise<void>) {
    return (await this.get()).subscribeBackgroundReplies(listener);
  }
  /** Live tool calls only; they are never part of saved history. */
  async subscribeToolActivity(listener: (event: Extract<StreamEvent, { type: "tool" } | { type: "tool-clear" }>) => void) {
    return (await this.get()).subscribe(event => {
      if (event.type === "tool" || event.type === "tool-clear") listener(event);
    });
  }
  /** Main-session lifecycle notifications are separate from the SSE/chat transcript. */
  async subscribeCompactions(listener: (event: CompactionEvent) => void) {
    return (await this.get()).subscribe(event => { if (event.type === "compaction") listener(event); });
  }
  async stop(commandId?: string) { const result = await (await this.get()).abort(commandId); this.dirty = true; await this.flush(); return result; }
  async changeRuntime<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    finally { this.dirty = true; await this.flush(); }
  }
  /** Initial state joins the same publication line as live updates, avoiding snapshot/live-update races. */
  async observe(listener: (event: StreamEvent) => void): Promise<() => void> {
    await this.get();
    let buffering = true; const pending: StreamEvent[] = [];
    const receive = (event: StreamEvent) => { if (buffering) pending.push(event); else listener(event); };
    this.listeners.add(receive);
    try {
      this.dirty = true; await this.flush();
      // A finished pump may still be clearing its promise when observation is attached.
      if (!pending.some(event => event.type === "snapshot")) await this.flush();
      const index = pending.findLastIndex(event => event.type === "snapshot");
      if (index < 0) throw new Error("Could not read conversation snapshot.");
      for (const event of pending.slice(index)) listener(event);
      buffering = false;
      return () => { this.listeners.delete(receive); };
    } catch (error) { this.listeners.delete(receive); throw error; }
  }
  async close() {
    if (this.closing) return;
    const session = this.session ?? (this.opening && await this.opening);
    await session?.abort(); await this.pump;
    this.closing = true; clearTimeout(this.timer); this.unsubscribe?.(); this.listeners.clear();
    await session?.dispose();
  }
}
