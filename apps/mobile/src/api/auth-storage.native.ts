import * as SecureStore from "expo-secure-store";
const KEY = "piko.session";
export async function readSession(): Promise<{ url: string; token: string } | undefined> {
  const value = await SecureStore.getItemAsync(KEY);
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return typeof parsed.url === "string" && typeof parsed.token === "string" ? parsed : undefined; } catch { return undefined; }
}
export async function saveSession(session: { url: string; token: string }): Promise<void> { await SecureStore.setItemAsync(KEY, JSON.stringify(session)); }
export async function clearSession(): Promise<void> { await SecureStore.deleteItemAsync(KEY); }
