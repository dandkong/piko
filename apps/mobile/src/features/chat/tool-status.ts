import type { ConversationActivity } from "../../../../../shared/chat";

/** Presentation only: every platform receives the same runtime-derived activity. */
export function assistantLiveStatus(activity: ConversationActivity): string {
  switch (activity.kind) {
    case "tool": return toolActivityLabel(activity.name) ?? "思考中…";
    case "replying": return "正在回复";
    case "thinking": return "思考中…";
    case "idle": return "";
    default: { const exhaustive: never = activity; return exhaustive; }
  }
}

export function toolActivityLabel(name: string): string | undefined {
  switch (name) {
    case "read": return "读取文件";
    case "write": return "写入文件";
    case "edit": return "编辑文件";
    case "bash": return "执行命令";
    case "web_search": return "搜索网页";
    case "web_extract": return "提取网页";
    case "sessions_search": return "搜索历史";
    case "sessions_history": return "读取历史";
    case "subagent_list":
    case "subagent_status": return "查看后台";
    case "subagent_spawn":
    case "subagent_send": return "委派工作";
    case "subagent_stop": return "停止委派";
    case "task_list":
    case "task_get": return "查看任务";
    case "task_create": return "创建任务";
    case "task_update": return "更新任务";
    case "task_run": return "运行任务";
    case "task_stop": return "停止任务";
    case "task_archive": return "归档任务";
    case "task_restore": return "恢复任务";
    default: return undefined;
  }
}
