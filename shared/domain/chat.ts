/** Business identities are independent of a Pi session and its compacted context. */
export type Workspace = { id: string; path: string; createdAt: number };
export type Thread = {
  id: string;
  workspaceId: string;
  kind: "main" | "side";
  parentThreadId: string | null;
  createdAt: number;
};
export type MainConversation = { workspace: Workspace; thread: Thread; sessionId: string };
