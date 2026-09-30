import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { consumeSse, type Message, type StreamEvent } from "../../../src/shared/chat";

const DEFAULT_API_URL = Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787";
export const API_URL = (process.env.EXPO_PUBLIC_PIKO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
const SESSION_KEY = "piko.mobile.sessionId";

type Health = {
  ok: boolean;
  modelReady: boolean;
  provider?: string;
};

export async function getOrCreateSessionId(): Promise<string> {
  const existing = await AsyncStorage.getItem(SESSION_KEY);
  if (existing) return existing;

  const sessionId = randomUUID();
  await AsyncStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function checkHealth(): Promise<Health> {
  return readJson<Health>(await fetch(`${API_URL}/api/health`));
}

export async function loadConversation(sessionId: string): Promise<Message[]> {
  const result = await readJson<{ messages: Message[] }>(
    await fetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}`),
  );
  return result.messages;
}

export async function streamMessage(
  sessionId: string,
  message: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });

  if (!response.ok) {
    await readJson<unknown>(response);
    return;
  }
  if (!response.body) throw new Error("This runtime did not provide a streaming response body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const parsed = consumeSse(pending, done);
      pending = parsed.remainder;
      parsed.events.forEach(onEvent);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
