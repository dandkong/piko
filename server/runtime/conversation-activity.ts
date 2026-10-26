import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { ConversationActivity } from "../../shared/chat";

type NativeActivity = {
  generation?: { retry?: unknown; deferred?: unknown; message?: { content: readonly { type: string; text?: string; thinking?: string }[] } };
  tools?: readonly { name: string; status: string }[];
  nestedTools?: readonly { name: string; status: string }[];
};

/** Native state restores an active tool/text; absent evidence starts with the thinking placeholder. */
export function activityFromLive(live: NativeActivity, busy: boolean): ConversationActivity {
  if (!busy) return { kind: "idle" };
  const tool = [...(live.tools ?? []), ...(live.nestedTools ?? [])].findLast(slot => slot.status === "running");
  if (tool) return { kind: "tool", name: tool.name };
  if (live.generation?.retry || live.generation?.deferred) return { kind: "thinking" };
  const block = live.generation?.message?.content.findLast(block =>
    block.type === "text" ? !!block.text?.trim() : block.type === "thinking" ? !!block.thinking?.trim() : true);
  return { kind: block?.type === "text" ? "replying" : "thinking" };
}

/** Last observed activity, held until another tool/text arrives or the native run ends. */
export class ConversationActivityProjection {
  private current: ConversationActivity = { kind: "idle" };

  constructor(private readonly emit: (activity: ConversationActivity) => void) {}

  snapshot(live: NativeActivity, busy: boolean): ConversationActivity {
    const native = activityFromLive(live, busy);
    // A state refresh between activities must not undo the most recent tool/text notification.
    return busy && (this.current.kind === "tool" || this.current.kind === "replying") ? this.current : native;
  }

  restore(snapshot: SnapshotEvent) {
    const busy = !!snapshot.run || snapshot.inbox.some(item => item.mode !== "write");
    const native = activityFromLive(snapshot, busy);
    this.publish(native.kind === "thinking" ? this.snapshot(snapshot, busy) : native);
  }

  apply(event: AgentEvent) {
    switch (event.type) {
      case "snapshot": this.restore(event); return;
      case "run_start": this.publish({ kind: "thinking" }); return;
      case "run_end": this.publish({ kind: "idle" }); return;
      case "tool_execution_start": this.publish({ kind: "tool", name: event.toolName }); return;
      case "message_start":
        if (event.message.role === "assistant" && event.message.content.some(block => block.type === "text" && !!block.text.trim()))
          this.publish({ kind: "replying" });
        return;
      case "message_update":
        if (event.changes.some(change =>
          change.type === "text_delta" && !!change.delta.trim() ||
          change.type === "message" && change.message.content.some(block => block.type === "text" && !!block.text.trim()) ||
          (change.type === "block" || change.type === "text_start") && change.block.type === "text" && !!change.block.text.trim()))
          this.publish({ kind: "replying" });
        return;
      default: return;
    }
  }

  private publish(activity: ConversationActivity) {
    if (JSON.stringify(this.current) === JSON.stringify(activity)) return;
    this.current = activity;
    this.emit(activity);
  }
}
