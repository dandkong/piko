/** IDs are native conversation IDs, opaque outside the runtime adapter. */
export type SideChat = { id: string; title: string; createdAt: number; archivedAt: number | null };
export type CreateSideChat = { requestId: string; title: string };
export type UpdateSideChat = { title?: string; archived?: boolean };
export const SIDE_CHAT_TITLE_LIMIT = 100;
export function chatPath(conversationId?: string): string {
  return conversationId ? `/api/side-chats/${encodeURIComponent(conversationId)}/chat` : "/api/chat";
}
