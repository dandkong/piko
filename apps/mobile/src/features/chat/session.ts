import AsyncStorage from "@react-native-async-storage/async-storage";
import { isSessionId } from "../../../../../shared/chat";
import type { MainConversation } from "../../../../../shared/domain/chat";
import { requestJson } from "../../api/client";

const SESSION_KEY = "piko.mobile.sessionId";

export async function getMainSessionId(): Promise<string> {
  // Resolve from the backend every launch; a cached client UUID cannot create a new thread.
  const main = await requestJson<MainConversation>("/api/main");
  if (!isSessionId(main.sessionId) || main.thread.kind !== "main" || main.thread.id !== main.sessionId) throw new Error("Invalid main conversation response.");
  await AsyncStorage.removeItem(SESSION_KEY);
  return main.sessionId;
}
