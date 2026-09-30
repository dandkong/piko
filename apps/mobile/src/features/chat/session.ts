import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { isSessionId } from "../../../../../shared/chat";

const SESSION_KEY = "piko.mobile.sessionId";

export async function getOrCreateSessionId(): Promise<string> {
  const existing = await AsyncStorage.getItem(SESSION_KEY);
  if (isSessionId(existing)) return existing;

  const sessionId = randomUUID();
  await AsyncStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}
