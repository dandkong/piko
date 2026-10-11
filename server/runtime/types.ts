import type { ConversationResponse, SubmissionReceipt, StreamEvent } from "../../shared/chat";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
export type SessionEvent = StreamEvent;
export class SessionCancelledError extends Error { constructor() { super("Reply stopped."); } }
/** Only this boundary crosses into the native adapter. */
export interface ChatSession {
  readonly isStreaming: boolean;
  snapshot(): Promise<ConversationResponse>;
  submit(text: string, requestId: string): Promise<{ submission: SubmissionReceipt; duplicate: boolean }>;
  submission(requestId: string): Promise<SubmissionReceipt | undefined>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  abort(commandId?: string): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface ChatRuntime {
  isModelReady(): Promise<boolean>;
  createSession(): Promise<ChatSession>;
  readHistory(): Promise<ConversationResponse>;
  describe?(): Promise<RuntimeDescription>;
  configure?(selection: RuntimeSelection): Promise<void>;
  compact?(): Promise<CompactionResult>;
  stop?(commandId?: string): Promise<boolean>;
  dispose?(): Promise<void>;
}
