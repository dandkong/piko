import type { ConversationResponse, StreamEvent } from "../../shared/chat";
import type { BackgroundReply, InputSource, ChatRuntime, ChatSession } from "../runtime/types";
import { normalizeMessage } from "./input";
export class RuntimeBusyError extends Error { constructor() { super("Stop the current reply before changing runtime configuration."); } }
/** Conversation-wide observation and transient replay. Native submissions own execution state. */
export class ConversationStore {
  readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private events: StreamEvent[] = [];
  private listeners = new Set<(event: StreamEvent) => void>();
  private opening?: Promise<ChatSession>;
  private session?: ChatSession;
  private unsubscribe?: () => void;
  private unsubscribeReplies?: () => void;
  private replyListeners = new Set<(reply: BackgroundReply) => Promise<void>>();
  private pendingReplies: BackgroundReply[] = [];
  private closing = false;
  private maintenance = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pump?: Promise<void>;
  private dirty = false;
  private messages = new Map<string, Extract<StreamEvent, { type: "message" }>>();
  private change?: Promise<unknown>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly runtime: ChatRuntime) {}
  get size() { return this.session ? 1 : 0; }
  isStreaming() { return this.maintenance || (this.session?.isStreaming ?? false); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const task = this.tail.catch(() => {}).then(operation); this.tail = task; return task; }
  async get(): Promise<ChatSession> {
    if (this.closing) throw new Error("Piko is shutting down.");
    return this.opening ??= this.runtime.createSession().then(session => {
      this.session = session;
      this.unsubscribeReplies = session.subscribeBackgroundReplies?.(async reply => {
        if (!this.replyListeners.size) { if (reply.source.channel === "telegram") this.pendingReplies.push(reply); return; }
        await Promise.allSettled([...this.replyListeners].map(listener => listener(reply)));
      });
      this.unsubscribe = session.subscribe(event => {
        if (event.type === "error") this.publish(event);
        if (event.type === "message") {
          if (event.previousId) this.messages.delete(event.previousId);
          this.messages.set(event.message.id, event);
        } else this.dirty = true;
        if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 50);
      });
      return session;
    }).catch(error => { this.opening = undefined; throw error; });
  }
  private publish(event: StreamEvent) {
    const recorded = { ...event, epoch: this.epoch, sequence: ++this.sequence };
    this.events.push(recorded); if (this.events.length > 128) this.events.shift();
    for (const listener of this.listeners) listener(recorded);
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
          const conversation = await (await this.get()).snapshot();
          this.publish({ type: "snapshot", conversation });
        }
      }
    })().catch(error => this.publish({ type: "error", message: error instanceof Error ? error.message : "Could not read conversation." })).finally(() => { this.pump = undefined; });
    return this.pump;
  }
  async snapshot(): Promise<ConversationResponse> { return (await this.get()).snapshot(); }
  async submit(message: string, requestId: string, source?: InputSource) {
    message = normalizeMessage(message);
    return this.serial(async () => {
      if (this.maintenance) throw new RuntimeBusyError();
      const result = await (await this.get()).submit(message, requestId, source);
      this.dirty = true; await this.flush(); return result;
    });
  }
  async subscribeBackgroundReplies(listener: (reply: BackgroundReply) => Promise<void>) {
    this.replyListeners.add(listener);
    for (const reply of this.pendingReplies.splice(0)) await listener(reply);
    return () => { this.replyListeners.delete(listener); };
  }
  async stop(commandId?: string) { return this.serial(async () => { const result = await (await this.get()).abort(commandId); this.dirty = true; await this.flush(); return result; }); }
  async changeRuntime<T>(operation: () => Promise<T>): Promise<T> {
    const reserved = await this.serial(async () => {
      await this.get(); if (this.isStreaming()) throw new RuntimeBusyError();
      this.maintenance = true;
      const task = Promise.resolve().then(operation); this.change = task;
      return { task };
    });
    try { return await reserved.task; }
    finally { this.maintenance = false; this.change = undefined; this.dirty = true; await this.flush(); }
  }
  /** Initial state joins the same publication line as live updates, avoiding snapshot/cursor races. */
  async observe(listener: (event: StreamEvent) => void, epoch?: string, after = 0): Promise<() => void> {
    await this.get();
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    if (epoch === this.epoch && after <= this.sequence && after >= first - 1) {
      for (const event of this.events) if (event.sequence! > after) listener(event);
      this.listeners.add(listener); return () => { this.listeners.delete(listener); };
    }
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
    await this.tail.catch(() => {});
    const session = this.session ?? (this.opening && await this.opening);
    await session?.abort(); await this.change?.catch(() => {}); await this.pump;
    this.closing = true; clearTimeout(this.timer); this.unsubscribe?.(); this.unsubscribeReplies?.(); this.replyListeners.clear(); this.pendingReplies = []; this.listeners.clear();
    await this.runtime.dispose?.();
  }
}
