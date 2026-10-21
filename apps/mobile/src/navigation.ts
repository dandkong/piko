import { MessageCircle, PanelsTopLeft, Shapes, SquareCheck } from "lucide-react-native";

/** Primary navigation is shared by the bottom tabs and the drawer. */
export const navigation = [
  { label: "Chat", icon: MessageCircle, hint: "Main conversation" },
  { label: "Posts", icon: PanelsTopLeft, hint: "Assistant posts" },
  { label: "Artifacts", icon: Shapes, hint: "Files and results" },
  { label: "Tasks", icon: SquareCheck, hint: "Recurring work" },
] as const;

export type AppTab = (typeof navigation)[number]["label"];
