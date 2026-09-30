import type { Message, StreamEvent } from "../../shared/chat";

/** Piko's runtime boundary; only the Pi adapter knows SDK-specific objects. */
export interface ChatSession {
  readonly isStreaming: boolean;
  readonly messages: Message[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: StreamEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ChatRuntime {
  isModelReady(): Promise<boolean>;
  createSession(): Promise<ChatSession>;
}
