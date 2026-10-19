import type { ConversationResponse, HistoryPage, SubmissionReceipt, StreamEvent } from "../../shared/chat";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { ItemExecutionDetail, ItemFile, WorkItem, WorkItemCommand, WorkItemDetail, WorkItemReceipt } from "../../shared/work-items";
export type SessionEvent = StreamEvent;
export type InputSource = { channel: "app" } | { channel: "telegram"; botId: string; chatId: string };
export type BackgroundReply = { source: InputSource; knownMessageIds: string[]; requestId: string };
export class RuntimeBusyError extends Error { constructor() { super("Stop the current reply before changing runtime configuration."); } }
/** Only this boundary crosses into the native adapter. */
export interface ChatSession {
  readonly isStreaming: boolean;
  snapshot(options?: { limit: number }): Promise<ConversationResponse>;
  history(before?: string, limit?: number): Promise<HistoryPage>;
  submit(text: string, requestId: string, source?: InputSource): Promise<{ submission: SubmissionReceipt; duplicate: boolean }>;
  subscribeBackgroundReplies(listener: (reply: BackgroundReply) => Promise<void>): () => void;
  submission(requestId: string): Promise<SubmissionReceipt | undefined>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  abort(commandId?: string): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface WorkItemsRuntime {
  list(): Promise<WorkItem[]>;
  detail(id: string, before?: string): Promise<WorkItemDetail>;
  command(command: WorkItemCommand, source?: InputSource): Promise<WorkItemReceipt>;
  result(id: string, executionId: string): Promise<ItemExecutionDetail>;
  file(id: string, executionId: string, path: string): Promise<ItemFile>;
}
export interface ChatRuntime {
  workItems(): Promise<WorkItemsRuntime>;
  isModelReady(): Promise<boolean>;
  createSession(): Promise<ChatSession>;
  describe(): Promise<RuntimeDescription>;
  configure(selection: RuntimeSelection): Promise<void>;
  compact(): Promise<CompactionResult>;
  stop(commandId?: string): Promise<boolean>;
  dispose(): Promise<void>;
}
