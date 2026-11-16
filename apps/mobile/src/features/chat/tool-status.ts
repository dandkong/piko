import type { ConversationActivity } from "../../../../../shared/chat";
import { toolIcon } from "../../../../../shared/tool-icons";
import { translate, type MessageKey } from "../../i18n/messages";
import type { Language } from "../../i18n";

const toolKeys: Record<string, MessageKey> = {
  read: "activity.read", write: "activity.write", edit: "activity.edit", bash: "activity.bash",
  web_search: "activity.searchWeb", web_extract: "activity.extractWeb",
  sessions_search: "activity.searchHistory", sessions_history: "activity.readHistory",
  subagent_list: "activity.background", subagent_status: "activity.background",
  subagent_spawn: "activity.delegate", subagent_send: "activity.delegate", subagent_stop: "activity.stopDelegate",
  task_list: "activity.tasks", task_get: "activity.tasks", task_create: "activity.createTask",
  task_update: "activity.updateTask", task_run: "activity.runTask", task_stop: "activity.stopTask",
  task_archive: "activity.archiveTask", task_restore: "activity.restoreTask",
};

/** Presentation only: every platform receives the same runtime-derived activity. */
export function assistantLiveStatus(activity: ConversationActivity, language: Language = "zh-CN"): string {
  switch (activity.kind) {
    case "tool": return `${toolIcon(activity.name)} ${toolActivityLabel(activity.name, language)}${activity.name === "subagent_spawn" && activity.summary ? `: ${activity.summary}` : ""}`;
    case "replying": return translate(language, "activity.replying");
    case "thinking": return translate(language, "activity.thinking");
    case "idle": return "";
    default: { const exhaustive: never = activity; return exhaustive; }
  }
}

export function toolActivityLabel(name: string, language: Language = "zh-CN"): string {
  return translate(language, Object.hasOwn(toolKeys, name) ? toolKeys[name]! : "activity.tool");
}
