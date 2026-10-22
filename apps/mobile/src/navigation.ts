import { MessageCircle, PanelsTopLeft, Shapes, SquareCheck } from "lucide-react-native";

/** Primary navigation is shared by the bottom tabs and the drawer. */
export const navigation = [
  { label: "Chat", title: "聊天", icon: MessageCircle, hint: "主会话" },
  { label: "Tasks", title: "任务", icon: SquareCheck, hint: "进行中的工作" },
  { label: "Posts", title: "帖子", icon: PanelsTopLeft, hint: "助手主动发布的内容" },
  { label: "Artifacts", title: "产物", icon: Shapes, hint: "文件与结果" },
] as const;

export type AppTab = (typeof navigation)[number]["label"];
