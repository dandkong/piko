import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { Message } from "../../shared/chat";
import type { SessionEvent } from "./types";
import { messageText } from "./pi-history";

/** Projects each native assistant message independently; never binds output to an input. */
export class PiMessageEvents {
  private current?: Message;
  private blocks = new Map<number, string>();
  private seen = new Set<number>();
  constructor(private readonly emit: (event: SessionEvent) => void) {}

  partial(entries: readonly EntryRecord[]): Message | undefined {
    // A history read may run ahead of event delivery and already contain this generation's final entry.
    if (entries.some(entry => entry.kind === "pi.assistant" && !this.seen.has(entry.id))) return undefined;
    return this.current && { ...this.current };
  }

  apply(event: AgentEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.start(event.message.timestamp);
      this.content(event.message.content); this.publish();
    } else if (event.type === "message_update") {
      if (!this.current) return;
      for (const change of event.changes) {
        if (change.type === "message") this.content(change.message.content);
        else if (change.type === "block" || change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start") {
          this.blocks.set(change.contentIndex, change.block.type === "text" ? change.block.text : "");
        } else if (change.type === "text_delta") {
          this.blocks.set(change.contentIndex, (this.blocks.get(change.contentIndex) ?? "") + change.delta);
        }
      }
      this.publish();
    } else if (event.type === "message_end" && event.entry.kind === "pi.assistant") this.complete(event.entry);
  }

  /** Overflow recovery uses full raw history, including entries omitted by compaction/reset. */
  restore(entries: readonly EntryRecord[], snapshot?: SnapshotEvent, initial = false) {
    for (const entry of entries) {
      if (entry.kind !== "pi.assistant") continue;
      if (initial) this.seen.add(entry.id);
      else this.complete(entry);
    }
    const message = snapshot?.run && snapshot.generation?.message;
    if (message) {
      if (!this.current) this.start(message.timestamp);
      this.content(message.content); this.publish();
    } else if (this.current) {
      this.emit({ type: "message", message: { ...this.current, content: "" }, final: true });
      this.current = undefined; this.blocks.clear();
    }
  }

  private start(createdAt: number) {
    this.current ??= { id: `live-${crypto.randomUUID()}`, role: "assistant", content: "", createdAt };
    this.blocks.clear();
  }

  private complete(entry: EntryRecord) {
    if (this.seen.has(entry.id)) return;
    const message = entry.model?.[0];
    if (message?.role !== "assistant") return;
    this.seen.add(entry.id);
    this.emit({ type: "message", message: { id: `pi-${entry.id}`, role: "assistant",
      content: messageText(message.content), createdAt: message.timestamp }, final: true,
      ...(this.current && { previousId: this.current.id }) });
    this.current = undefined; this.blocks.clear();
  }

  private content(content: unknown) {
    this.blocks.clear();
    if (Array.isArray(content)) content.forEach((block, index) => {
      this.blocks.set(index, block?.type === "text" ? block.text : "");
    });
  }

  private publish() {
    if (!this.current) return;
    const content = [...this.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    if (content === this.current.content) return;
    this.current = { ...this.current, content };
    this.emit({ type: "message", message: { ...this.current }, final: false });
  }
}
