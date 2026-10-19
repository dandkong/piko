import { createContext, useContext, type ReactNode } from "react";
import { useChat } from "./useChat";

type ChatStore = ReturnType<typeof useChat>;
const ChatContext = createContext<ChatStore | undefined>(undefined);

/** One chat subscription for the whole shell: the composer and the conversation share it. */
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatStore() {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChatStore must be used inside ChatProvider.");
  return value;
}
