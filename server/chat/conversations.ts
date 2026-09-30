import type { Message } from "../../shared/chat";
import type { ChatSession } from "../runtime/types";

type Conversation = { session: ChatSession; touchedAt: number };
type StoreOptions = { idleSessionMs: number; maxSessions: number };

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly pending = new Map<string, Promise<Conversation>>();

  constructor(
    private readonly createSession: () => Promise<ChatSession>,
    private readonly options: StoreOptions,
  ) { }

  get size() { return this.conversations.size; }

  isStreaming(sessionId: string): boolean {
    return this.conversations.get(sessionId)?.session.isStreaming ?? false;
  }

  history(sessionId: string): Message[] {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) return [];
    conversation.touchedAt = Date.now();
    return conversation.session.messages;
  }

  delete(sessionId: string): void {
    this.conversations.get(sessionId)?.session.dispose();
    this.conversations.delete(sessionId);
  }

  async get(sessionId: string): Promise<Conversation> {
    const now = Date.now();
    for (const [id, value] of this.conversations) {
      if (now - value.touchedAt > this.options.idleSessionMs && !value.session.isStreaming) {
        value.session.dispose();
        this.conversations.delete(id);
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
        .filter(([, value]) => !value.session.isStreaming)
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) throw new Error("Piko is busy with other conversations. Try again shortly.");
      oldest[1].session.dispose();
      this.conversations.delete(oldest[0]);
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
