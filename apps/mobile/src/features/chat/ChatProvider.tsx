import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { useChat } from "./useChat";

export type ChatStore = ReturnType<typeof useChat>;
const ChatContext = createContext<ChatStore | undefined>(undefined);

/** Key this provider by conversation ID. Hidden providers retain drafts, pending inputs and scroll state. */
export function ChatProvider({
  children,
  conversationId,
  active = true,
  onActiveChat,
}: {
  children: ReactNode;
  conversationId?: string;
  active?: boolean;
  onActiveChat?: (id: string | undefined, chat: ChatStore) => void;
}) {
  const chat = useChat(conversationId, active);
  useLayoutEffect(() => {
    if (active) onActiveChat?.(conversationId, chat);
  }, [active, conversationId, chat, onActiveChat]);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatStore() {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChatStore must be used inside ChatProvider.");
  return value;
}
