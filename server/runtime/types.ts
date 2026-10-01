import type { Message, StreamEvent } from "../../shared/chat";

/** Piko's runtime boundary; only the Pi adapter knows SDK-specific objects. */
export interface ChatSession {
  readonly isStreaming: boolean;
  readonly messages: Message[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: StreamEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  /** Opaque pointer to durable native context; business storage commits its own checkpoint. */
  exportState?(): unknown;
}

export type SessionContext = { threadId: string; state?: unknown; recovery: Array<{ runId: string; message: string; text: string; status: string }> };

export interface ChatRuntime {
  isModelReady(): Promise<boolean>;
  createSession(context?: SessionContext): Promise<ChatSession>;
}
