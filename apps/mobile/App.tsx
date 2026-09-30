import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ArrowUp, CircleHelp, Compass, House, RotateCcw, Settings2, Square } from "lucide-react-native";
import type { Message, StreamEvent } from "../../src/shared/chat";
import {
  checkHealth,
  getOrCreateSessionId,
  isAbortError,
  loadConversation,
  streamMessage,
} from "./src/api";

const colors = {
  background: "#f7f5f0",
  surface: "#fffefa",
  ink: "#292a28",
  muted: "#85857f",
  line: "#e8e5de",
  accent: "#b85d42",
  accentSoft: "#f3e5dc",
  assistant: "#fffefa",
  error: "#a64134",
};

function MobilePiko() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<FlatList<Message>>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const id = await getOrCreateSessionId();
        if (!active) return;
        setSessionId(id);
        const [history, health] = await Promise.all([loadConversation(id), checkHealth()]);
        if (!active) return;
        setMessages(history);
        setConnected(health.ok && health.modelReady);
        if (!health.modelReady) setError("Piko is running, but no model is configured yet.");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    async (text = draft) => {
      const content = text.trim();
      if (!content || busy || !sessionId) return;

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        createdAt: Date.now(),
      };
      const assistantId = `assistant-${Date.now()}`;
      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: "assistant", content: "", createdAt: Date.now() },
      ]);
      setDraft("");
      setBusy(true);
      setError("");
      setConnected(true);
      const controller = new AbortController();
      abortRef.current = controller;
      let receivedStreamError = false;

      const handleEvent = (event: StreamEvent) => {
        if (event.type === "delta") {
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, content: item.content + event.text } : item,
            ),
          );
        } else if (event.type === "error") {
          receivedStreamError = true;
          setConnected(false);
          setError(event.message);
        }
      };

      try {
        await streamMessage(sessionId, content, controller.signal, handleEvent);
        const history = await loadConversation(sessionId);
        if (!receivedStreamError) setMessages(history);
      } catch (cause) {
        if (!isAbortError(cause)) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        setMessages((current) => current.filter((item) => item.id !== assistantId || item.content));
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, draft, sessionId],
  );

  const stop = () => abortRef.current?.abort();
  const renderMessage = ({ item }: ListRenderItemInfo<Message>) => (
    <View style={[styles.messageRow, item.role === "user" ? styles.userRow : styles.assistantRow]}>
      {item.role === "assistant" && <Text style={styles.messageLabel}>PIKO</Text>}
      <View style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
        {item.content ? (
          <Text selectable style={[styles.messageText, item.role === "user" && styles.userText]}>
            {item.content}
          </Text>
        ) : busy ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : null}
      </View>
    </View>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
        <StatusBar style="dark" />
        <View style={styles.header}>
          <View style={styles.brand}>
            <Image source={require("./assets/capybara.png")} style={styles.avatar} />
            <View>
              <Text style={styles.brandName}>Piko</Text>
              <View style={styles.statusLine}>
                <View style={[styles.statusDot, connected ? styles.onlineDot : styles.offlineDot]} />
                <Text style={styles.statusText}>{connected ? "Ready when you are" : "Local assistant"}</Text>
              </View>
            </View>
          </View>
          <Pressable accessibilityLabel="Help" style={styles.headerButton}>
            <CircleHelp size={19} color={colors.muted} />
          </Pressable>
        </View>

        <KeyboardAvoidingView
          style={styles.main}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={8}
        >
          {loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.centerText}>Opening your workspace…</Text>
            </View>
          ) : messages.length === 0 ? (
            <View style={styles.welcome}>
              <View style={styles.welcomeMark}>
                <Image source={require("./assets/capybara.png")} style={styles.welcomeAvatar} />
              </View>
              <Text style={styles.eyebrow}>A LITTLE ROOM FOR EVERYTHING</Text>
              <Text style={styles.welcomeTitle}>What’s on your mind?</Text>
              <Text style={styles.welcomeCopy}>
                A quiet place to think, make plans, and get things done — with Pi at the heart of it.
              </Text>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(item) => item.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.messageList}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            />
          )}

          {error && messages.length > 0 ? (
            <View style={styles.inlineError}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  const lastUserMessage = [...messages].reverse().find((item) => item.role === "user");
                  if (lastUserMessage) void send(lastUserMessage.content);
                }}
                style={styles.retryButton}
              >
                <RotateCcw size={13} color={colors.accent} />
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.composerWrap}>
            <View style={styles.composer}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Write a message…"
                placeholderTextColor="#99978f"
                style={styles.input}
                multiline
                maxLength={12_000}
                editable={!busy && !loading}
                blurOnSubmit={false}
                returnKeyType="default"
                accessibilityLabel="Message Piko"
              />
              <Pressable
                accessibilityLabel={busy ? "Stop response" : "Send message"}
                accessibilityRole="button"
                disabled={(!draft.trim() && !busy) || loading}
                onPress={busy ? stop : () => void send()}
                style={({ pressed }) => [
                  styles.sendButton,
                  (!draft.trim() && !busy) || loading ? styles.sendDisabled : null,
                  pressed ? styles.sendPressed : null,
                ]}
              >
                {busy ? <Square size={15} color="#fff" fill="#fff" /> : <ArrowUp size={18} color="#fff" />}
              </Pressable>
            </View>
            <Text style={styles.composerHint}>Piko runs on your own Pi-powered workspace.</Text>
          </View>
        </KeyboardAvoidingView>

        <View style={styles.tabBar}>
          <Tab icon={<House size={18} color={colors.accent} />} label="Chat" active />
          <Tab icon={<Compass size={18} color={colors.muted} />} label="Explore" />
          <Tab icon={<Settings2 size={18} color={colors.muted} />} label="Settings" />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Tab({ icon, label, active = false }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" style={styles.tab} disabled={!active}>
      {icon}
      <Text style={[styles.tabLabel, active && styles.activeTabLabel]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return <MobilePiko />;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 66,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.background,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 11 },
  avatar: { width: 39, height: 39, borderRadius: 14, backgroundColor: colors.accentSoft },
  brandName: { color: colors.ink, fontSize: 17, fontWeight: "700", letterSpacing: -0.4 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  onlineDot: { backgroundColor: "#709274" },
  offlineDot: { backgroundColor: "#c59b57" },
  statusText: { color: colors.muted, fontSize: 11 },
  headerButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  main: { flex: 1 },
  centerState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  centerText: { color: colors.muted, fontSize: 14 },
  welcome: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
    paddingBottom: 22,
  },
  welcomeMark: {
    width: 92,
    height: 92,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 31,
    backgroundColor: colors.accentSoft,
    marginBottom: 24,
  },
  welcomeAvatar: { width: 78, height: 78, borderRadius: 24 },
  eyebrow: { color: colors.accent, fontSize: 10, fontWeight: "700", letterSpacing: 1.3, marginBottom: 10 },
  welcomeTitle: { color: colors.ink, fontSize: 28, fontWeight: "600", letterSpacing: -0.8, textAlign: "center" },
  welcomeCopy: { maxWidth: 310, color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: "center", marginTop: 12 },
  messageList: { flexGrow: 1, paddingHorizontal: 18, paddingVertical: 22, gap: 18 },
  messageRow: { maxWidth: 760, width: "100%", alignSelf: "center", gap: 6 },
  userRow: { alignItems: "flex-end" },
  assistantRow: { alignItems: "flex-start" },
  messageLabel: { color: colors.muted, fontSize: 9, fontWeight: "700", letterSpacing: 1, marginLeft: 3 },
  bubble: { maxWidth: "91%", borderRadius: 20, paddingHorizontal: 15, paddingVertical: 12 },
  userBubble: { backgroundColor: colors.accent, borderBottomRightRadius: 6 },
  assistantBubble: { backgroundColor: colors.assistant, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 6 },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  userText: { color: "#fff" },
  inlineError: { paddingHorizontal: 20, paddingVertical: 8 },
  errorText: { color: colors.error, fontSize: 12, lineHeight: 18, textAlign: "center" },
  retryButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 6, padding: 5 },
  retryText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  composerWrap: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, backgroundColor: colors.background },
  composer: {
    maxWidth: 760,
    width: "100%",
    minHeight: 56,
    maxHeight: 160,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 21,
    backgroundColor: colors.surface,
    paddingLeft: 15,
    paddingRight: 8,
    paddingVertical: 7,
  },
  input: { flex: 1, maxHeight: 138, minHeight: 36, color: colors.ink, fontSize: 15, lineHeight: 21, paddingTop: 8, paddingBottom: 7 },
  sendButton: { width: 38, height: 38, borderRadius: 15, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: "#c8c3bb" },
  sendPressed: { opacity: 0.78 },
  composerHint: { maxWidth: 760, width: "100%", alignSelf: "center", marginTop: 7, color: colors.muted, fontSize: 10, textAlign: "center" },
  tabBar: {
    minHeight: 59,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingBottom: Platform.OS === "ios" ? 2 : 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.background,
  },
  tab: { minWidth: 78, alignItems: "center", justifyContent: "center", gap: 3, paddingVertical: 7 },
  tabLabel: { color: colors.muted, fontSize: 10 },
  activeTabLabel: { color: colors.accent, fontWeight: "600" },
});
