import { fetch } from "expo/fetch";
import { Platform } from "react-native";

const DEFAULT_API_URL = Platform.OS === "web" && !__DEV__ ? ""
  : Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787";
export const API_URL = (process.env.EXPO_PUBLIC_PIKO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, init);
}

export async function readJson<T>(response: Response): Promise<T> {
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

export async function requestJson<T>(path: string): Promise<T> {
  return readJson<T>(await apiFetch(path));
}
