import type { Message, StreamEvent } from "../../shared/chat";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";

export class SessionCancelledError extends Error {
  constructor() { super("Reply stopped."); }
}

export type SessionEvent = StreamEvent;

/** Piko's runtime boundary; only the Pi adapter knows SDK-specific objects. */
export interface ChatSession {
  readonly isStreaming: boolean;
  readonly messages: Message[];
  prompt(text: string, run?: { id: string; createdAt: number }): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  /** Opaque native session identity, without a second conversation checkpoint. */
  exportState?(): unknown;
}

export type SessionContext = { threadId: string; state?: unknown; interruptedRunIds: string[] };
export type SessionHistory = { messages: Message[]; runs: Map<string, { message: string }> };
export type HistoryReader = (context: SessionContext) => SessionHistory | Promise<SessionHistory>;

export interface ChatRuntime {
  isModelReady(): Promise<boolean>;
  createSession(context?: SessionContext): Promise<ChatSession>;
  /** Read native history without creating an agent or accessing model credentials. */
  readHistory: HistoryReader;
  describe?(context: SessionContext): Promise<RuntimeDescription>;
  configure?(context: SessionContext, selection: RuntimeSelection): Promise<void>;
  compact?(context: SessionContext): Promise<CompactionResult>;
  stop?(context: SessionContext): Promise<void>;
  dispose?(): Promise<void>;
}
