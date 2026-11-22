import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { API_URL, apiFetch, readJson, setApiUrl, setSessionToken, setUnauthorizedHandler } from "./client";
import { clearSession, readSession, saveSession } from "./auth-storage";
import { useLanguage } from "../i18n";
import { radii, useTheme } from "../theme";
import { TextButton } from "../components/TextButton";

const LogoutContext = createContext<() => void>(() => {});
export function useLogout() { return useContext(LogoutContext); }

export function AuthGate({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const { language } = useLanguage();
  const zh = language === "zh-CN";
  const [state, setState] = useState<"checking" | "login" | "ready">("checking");
  const [url, setUrl] = useState(API_URL);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setUnauthorizedHandler(() => { setSessionToken(undefined); void clearSession(); setState("login"); });
    void (async () => {
      try {
        const saved = await readSession();
        if (saved) { setApiUrl(saved.url); setUrl(saved.url); setSessionToken(saved.token); }
        const result = await readJson<{ authenticated: boolean }>(await apiFetch("/api/auth/session"));
        if (active) setState(result.authenticated ? "ready" : "login");
      } catch { if (active) setState("login"); }
    })();
    return () => { active = false; setUnauthorizedHandler(undefined); };
  }, []);
  const login = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (Platform.OS !== "web") {
        const parsed = new URL(url.trim());
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid URL");
        setSessionToken(undefined); setApiUrl(parsed.origin);
      }
      const result = await readJson<{ token?: string }>(await apiFetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json", ...(Platform.OS !== "web" ? { "X-Piko-Client": "native" } : {}) }, body: JSON.stringify({ key }),
      }));
      if (Platform.OS !== "web") {
        if (!result.token) throw new Error("missing token");
        await saveSession({ url: API_URL, token: result.token });
        setSessionToken(result.token);
      }
      setKey(""); setState("ready");
    } catch { setError(zh ? "无法登录，请检查地址和密钥。" : "Unable to sign in. Check the address and key."); }
    finally { setBusy(false); }
  };
  const logout = () => {
    void apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setSessionToken(undefined); void clearSession(); setKey(""); setState("login");
  };
  if (state === "ready") return <LogoutContext.Provider value={logout}>{children}</LogoutContext.Provider>;
  return <View style={[styles.root, { backgroundColor: colors.canvas }]}>
    {state === "checking" ? <ActivityIndicator color={colors.text} /> : <View style={styles.form}>
      <Text style={[styles.title, { color: colors.text }]}>Piko</Text>
      {Platform.OS !== "web" ? <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder={zh ? "服务器地址" : "Server URL"} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.line }]} /> : null}
      <TextInput value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={zh ? "访问密钥" : "Access key"} placeholderTextColor={colors.muted} onSubmitEditing={() => void login()} style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      <TextButton label={zh ? "进入" : "Sign in"} variant="primary" disabled={busy || !key} onPress={() => void login()}><Text style={{ color: colors.text }}>{busy ? "…" : zh ? "进入" : "Sign in"}</Text></TextButton>
    </View>}
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }, form: { width: "100%", maxWidth: 360, gap: 16 }, title: { fontSize: 28, fontWeight: "600", textAlign: "center", marginBottom: 8 }, input: { minHeight: 48, borderWidth: 1, borderRadius: radii.control, paddingHorizontal: 14 } });
