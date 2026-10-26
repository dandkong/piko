import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { ConversationActivity } from "../../shared/chat";

type NativeActivity = {
  generation?: { retry?: unknown; deferred?: unknown; message?: { content: readonly { type: string; text?: string; thinking?: string }[] } };
  tools?: readonly { name: string; status: string }[];
  nestedTools?: readonly { name: string; status: string }[];
};

/** Snapshot recovery uses native slots, never replayed tool-start notifications or UI message IDs. */
export function activityFromLive(live: NativeActivity, busy: boolean): ConversationActivity {
  if (!busy) return { kind: "idle" };
  const tool = [...(live.tools ?? []), ...(live.nestedTools ?? [])].findLast(slot => slot.status === "running");
  if (tool) return { kind: "tool", name: tool.name };
  if (live.generation?.retry || live.generation?.deferred) return { kind: "thinking" };
  const block = live.generation?.message?.content.findLast(block =>
    block.type === "text" ? !!block.text?.trim() : block.type === "thinking" ? !!block.thinking?.trim() : true);
  return { kind: block?.type === "text" ? "replying" : "thinking" };
}

/** Small live display projection. Execution ownership and durable state stay in the Harness. */
export class ConversationActivityProjection {
  private running = false;
  private replying = false;
  private readonly tools = new Map<string, string>();
  private current: ConversationActivity = { kind: "idle" };

  constructor(private readonly emit: (activity: ConversationActivity) => void) {}

  restore(snapshot: SnapshotEvent) {
    this.running = !!snapshot.run || snapshot.inbox.some(item => item.mode !== "write");
    this.tools.clear();
    for (const slot of [...snapshot.tools, ...snapshot.nestedTools])
      if (slot.status === "running") this.tools.set(slot.callId, slot.name);
    const activity = activityFromLive(snapshot, this.running);
    this.replying = activity.kind === "replying";
    this.publish(activity);
  }

  apply(event: AgentEvent) {
    switch (event.type) {
      case "snapshot": this.restore(event); return;
      case "run_start":
        this.running = true; this.replying = false; this.tools.clear(); break;
      case "run_end":
        this.running = false; this.replying = false; this.tools.clear(); break;
      case "tool_execution_start":
        this.running = true; this.replying = false;
        this.tools.set(event.toolCallId, event.toolName); break;
      case "tool_execution_end": this.tools.delete(event.toolCallId); break;
      case "message_start":
        if (event.message.role === "assistant")
          this.replying = activityFromLive({ generation: { message: event.message } }, true).kind === "replying";
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta" && change.delta.trim()) this.replying = true;
          else if (change.type === "thinking_delta" || change.type === "thinking_start" || change.type === "toolcall_start") this.replying = false;
          else if (change.type === "message") this.replying = activityFromLive({ generation: { message: change.message } }, true).kind === "replying";
          else if (change.type === "block" || change.type === "text_start")
            this.replying = change.block.type === "text" && !!change.block.text.trim();
        }
        break;
      case "message_end":
        if (event.entry.kind === "pi.assistant") this.replying = false;
        break;
      case "auto_retry_start":
      case "deferred_poll": this.replying = false; break;
      default: return;
    }
    const tool = [...this.tools.values()].at(-1);
    this.publish(!this.running ? { kind: "idle" } : tool !== undefined ? { kind: "tool", name: tool } : { kind: this.replying ? "replying" : "thinking" });
  }

  private publish(activity: ConversationActivity) {
    if (JSON.stringify(this.current) === JSON.stringify(activity)) return;
    this.current = activity;
    this.emit(activity);
  }
}
