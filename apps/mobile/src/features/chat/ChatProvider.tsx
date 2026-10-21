import { createContext, useContext, type ReactNode } from "react";
import { useChat } from "./useChat";

type ChatStore = ReturnType<typeof useChat>;
const ChatContext = createContext<ChatStore | undefined>(undefined);

/** Key this provider by conversation ID. Hidden providers retain drafts, pending inputs and scroll state. */
export function ChatProvider({ children, conversationId, active = true }: { children: ReactNode; conversationId?: string; active?: boolean }) {
  const chat = useChat(conversationId, active);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatStore() {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChatStore must be used inside ChatProvider.");
  return value;
}
