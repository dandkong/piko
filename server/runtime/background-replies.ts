import type { BackgroundReply } from "./types";

/** Process-local channel attachment hints, not persisted results or a reliable outbox. */
export class BackgroundReplies {
  private readonly listeners = new Set<
    (reply: BackgroundReply) => Promise<void>
  >();
  private readonly pending: BackgroundReply[] = [];

  async publish(reply: BackgroundReply): Promise<void> {
    if (!this.listeners.size) {
      if (reply.deliver === "all" || reply.source.channel === "telegram")
        this.pending.push(reply);
      return;
    }
    await Promise.allSettled(
      [...this.listeners].map((listener) => listener(reply)),
    );
  }

  subscribe(listener: (reply: BackgroundReply) => Promise<void>): () => void {
    this.listeners.add(listener);
    for (const reply of this.pending.splice(0)) {
      void listener(reply).catch(() =>
        console.warn("Piko background delivery attachment failed."),
      );
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
    this.pending.length = 0;
  }
}
