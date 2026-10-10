import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { SessionEvent } from "./types";
import { messageText } from "./pi-history";

/** Transient text projection of native events. Full raw entries remain the history authority. */
export class PiReplyEvents {
  private runId?: string;
  private nativeRunId?: string;
  private completed = "";
  private blocks = new Map<number, string>();
  private ended = new Set<number>();
  private emitted = "";

  constructor(private readonly emit: (event: SessionEvent) => void) {}

  get snapshot() { return { text: this.emitted, messageEnds: [...this.boundaries] }; }
  private boundaries: number[] = [];

  begin(runId: string) {
    this.runId = runId; this.completed = ""; this.blocks.clear(); this.ended.clear(); this.emitted = ""; this.boundaries = [];
  }

  finish() { this.runId = undefined; this.blocks.clear(); }

  apply(event: AgentEvent) {
    if (event.type === "entry_appended" || event.type === "message_end") this.marker(event.entry);
    if (!this.runId || this.nativeRunId !== this.runId) return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.content(event.message.content); this.publish();
    } else if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "message") this.content(change.message.content);
        else if (change.type === "block" || change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start") {
          this.blocks.set(change.contentIndex, change.block.type === "text" ? change.block.text : "");
        } else if (change.type === "text_delta") {
          this.blocks.set(change.contentIndex, (this.blocks.get(change.contentIndex) ?? "") + change.delta);
        }
      }
      this.publish();
    } else if (event.type === "message_end" && event.entry.kind === "pi.assistant" && !this.ended.has(event.entry.id)) {
      const message = event.entry.model?.[0];
      if (message?.role !== "assistant") return;
      this.content(message.content); this.publish();
      this.completed += this.partial(); this.blocks.clear(); this.ended.add(event.entry.id);
      this.boundaries.push(this.completed.length);
      this.emit({ type: "message_end", offset: this.completed.length });
    }
  }

  /** A watch snapshot may omit older entries after compaction/reset: reconcile against full raw history. */
  restore(entries: readonly EntryRecord[], snapshot?: SnapshotEvent) {
    let nativeRunId: string | undefined;
    let completed = "";
    const boundaries: { id: number; offset: number }[] = [];
    for (const entry of entries) {
      if (entry.kind === "piko.run") nativeRunId = this.markerId(entry);
      if (!this.runId || nativeRunId !== this.runId || entry.kind !== "pi.assistant") continue;
      completed += (entry.model ?? []).filter(message => message.role === "assistant")
        .map(message => messageText(message.content)).join("");
      boundaries.push({ id: entry.id, offset: completed.length });
    }
    this.nativeRunId = nativeRunId;
    if (!this.runId) return;
    this.completed = completed;
    this.boundaries = boundaries.map(boundary => boundary.offset);
    this.content(snapshot?.run && nativeRunId === this.runId ? snapshot.generation?.message?.content : undefined);
    this.publish();
    for (const boundary of boundaries) {
      if (this.ended.has(boundary.id)) continue;
      this.ended.add(boundary.id); this.emit({ type: "message_end", offset: boundary.offset });
    }
  }

  private marker(entry: EntryRecord) {
    if (entry.kind === "piko.run") this.nativeRunId = this.markerId(entry);
  }

  private markerId(entry: EntryRecord) {
    const data = entry.data;
    return data && typeof data === "object" && !Array.isArray(data) && typeof data.runId === "string" ? data.runId : undefined;
  }

  private content(content: unknown) {
    this.blocks.clear();
    if (Array.isArray(content)) content.forEach((block, index) => {
      this.blocks.set(index, block?.type === "text" ? block.text : "");
    });
  }

  private partial() { return [...this.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join(""); }

  private publish() {
    const text = this.completed + this.partial();
    if (text === this.emitted) return;
    this.emit(text.startsWith(this.emitted) ? { type: "delta", text: text.slice(this.emitted.length) } : { type: "replace", text });
    this.emitted = text;
  }
}
