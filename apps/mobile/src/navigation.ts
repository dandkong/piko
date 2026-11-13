import { MessageCircle, PanelsTopLeft, Shapes, SquareCheck } from "lucide-react-native";

/** Primary navigation is shared by the bottom tabs and the drawer. */
export const navigation = [
  { label: "Chat", title: "navigation.chat", icon: MessageCircle, hint: "navigation.chatHint" },
  { label: "Tasks", title: "navigation.tasks", icon: SquareCheck, hint: "navigation.tasksHint" },
  { label: "Posts", title: "navigation.posts", icon: PanelsTopLeft, hint: "navigation.postsHint" },
  { label: "Artifacts", title: "navigation.artifacts", icon: Shapes, hint: "navigation.artifactsHint" },
] as const;

export type AppTab = (typeof navigation)[number]["label"];
