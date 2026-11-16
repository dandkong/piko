import type { SideChat } from "../../shared/side-chats";
import type { ModelSettingsSnapshot, SaveModelSettings, SaveModelSettingsResult } from "../../shared/settings";
import type { ConversationResponse, ConversationActivity, HistoryPage, MessageEvent, SubmissionReceipt } from "../../shared/chat";
import type { CompactionEvent, CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { TaskExecutionDetail, AssistantTask, AssistantTaskCommand, AssistantTaskDetail, AssistantTaskReceipt } from "../../shared/tasks";
import type { GeneratePost, Post, PostGeneration, PostPage } from "../../shared/posts";
/** Runtime facts. Transport snapshots and channel-specific rendering instructions do not belong here. */
export type SessionEvent =
  | MessageEvent
  | { type: "tool"; activity: { callId: string; name: string; summary: string; status: "running" | "done" | "error"; durationMs?: number } }
  | { type: "run-start" }
  | { type: "run-end"; submissions: readonly SubmissionReceipt[] }
  | { type: "input-applied" }
  | { type: "activity"; activity: ConversationActivity }
  | { type: "invalidated" }
  | { type: "deleted" }
  | { type: "error"; message: string }
  | CompactionEvent;
/** A native compaction task was admitted; its lifecycle observer owns the terminal notification. */
export class CompactionExecutionError extends Error {}
export type InputSource = { channel: "app" } | { channel: "telegram"; botId: string; chatId: string };
export type BackgroundReply = { source: InputSource; knownMessageIds: string[]; requestId: string;
  /** origin: answer where the work started; all: broadcast to every channel (scheduled work). */
  deliver: "origin" | "all" };
export class RuntimeBusyError extends Error { constructor() { super("Stop the current reply before changing runtime configuration."); } }
export class StorageDeletionBlocked extends Error { readonly status = 409; }
export class ModelConfigurationError extends Error {
  readonly status = 409;
}
/** Only this boundary crosses into the native adapter. */
export interface ChatSession {
  readonly isStreaming: boolean;
  snapshot(options?: { limit: number }): Promise<ConversationResponse>;
  history(before?: string, limit?: number): Promise<HistoryPage>;
  submit(text: string, requestId: string, source?: InputSource, attachments?: readonly string[]): Promise<{ submission: SubmissionReceipt; duplicate: boolean }>;
  subscribeBackgroundReplies(listener: (reply: BackgroundReply) => Promise<void>): () => void;
  submission(requestId: string): Promise<SubmissionReceipt | undefined>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  abort(commandId?: string): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface AssistantTasksRuntime {
  list(): Promise<AssistantTask[]>;
  detail(id: string, before?: string): Promise<AssistantTaskDetail>;
  command(command: AssistantTaskCommand, source?: InputSource): Promise<AssistantTaskReceipt>;
  result(id: string, executionId: string): Promise<TaskExecutionDetail>;
}
export type SubagentStatus = "working" | "interrupted" | "stopped" | "failed" | "finished";
export type SubagentListItem = { id: string; title: string; task: string; status: SubagentStatus };
export type SubagentDetail = { id: string; title: string; status: SubagentStatus; detail?: string; recentSteps: string[] };
export interface AssistantSubagentsRuntime {
  list(): Promise<SubagentListItem[]>;
  status(id: string): Promise<SubagentDetail | undefined>;
}
export type WorkspaceSkillDetail = {
  name: string;
  description: string;
  body: string;
  disableModelInvocation: boolean;
};
export interface PostsRuntime {
  list(before?: string, limit?: number): Promise<PostPage>;
  read(id: string): Promise<Post>;
  remove(id: string): Promise<void>;
  generate(command: GeneratePost): Promise<PostGeneration>;
  generation(id: string): Promise<PostGeneration>;
  stop(id: string): Promise<PostGeneration>;
}
export interface ChatRuntime {
  posts(): Promise<PostsRuntime>;
  tasks(): Promise<AssistantTasksRuntime>;
  subagents(): Promise<AssistantSubagentsRuntime>;
  skill(name: string): Promise<WorkspaceSkillDetail | undefined>;
  isModelReady(): Promise<boolean>;
  settings(): Promise<ModelSettingsSnapshot>;
  saveModelSettings(draft: SaveModelSettings): Promise<SaveModelSettingsResult>;
  sideChats: {
    list(): Promise<SideChat[]>;
    create(requestId: string): Promise<SideChat>;
    generateTitle(id: string, requestIds?: readonly string[], signal?: AbortSignal): Promise<SideChat>;
    remove(id: string): Promise<void>;
  };
  createSession(conversationId?: string): Promise<ChatSession>;
  describe(conversationId?: string): Promise<RuntimeDescription>;
  configure(selection: RuntimeSelection): Promise<void>;
  compact(conversationId?: string): Promise<CompactionResult>;
  stop(commandId?: string, conversationId?: string): Promise<boolean>;
  dispose(): Promise<void>;
}
