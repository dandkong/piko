import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { ArrowDown, RotateCcw } from "lucide-react-native";
import type { Message } from "../../../../../shared/chat";
import { AppShell } from "../../components/AppShell";
import { colors } from "../../theme";
import { ChatComposer } from "./ChatComposer";
import { styles } from "./styles";
import { useChat } from "./useChat";

const suggestions = [
  "Help me plan my day",
  "Turn an idea into a plan",
  "Help me write something",
];

export function ChatScreen() {
  const { sessionId, messages, draft, setDraft, loading, busy, error, status, send, stop, retry } = useChat();
  const listRef = useRef<FlatList<Message>>(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const { width } = useWindowDimensions();
  useEffect(() => {
    if (busy) {
      followLatest.current = true;
      setAwayFromLatest(false);
    }
  }, [busy]);

  const renderMessage = ({ item }: ListRenderItemInfo<Message>) => {
    const waitingForText = busy && item.role === "assistant" && item.id === messages.at(-1)?.id && !item.content.trim();
    if (!item.content.trim() && !waitingForText) return null;
    return (
      <View
        accessibilityLabel={waitingForText ? "Piko is working" : undefined}
        style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble, waitingForText && styles.typing]}
      >
        {waitingForText ? (
          [0.4, 0.75, 0.5].map((opacity) => (
            <View key={opacity} style={[styles.typingDot, { opacity }]} />
          ))
        ) : (
          <Text selectable style={styles.messageText}>{item.content}</Text>
        )}
      </View>
    );
  };

  return (
    <AppShell wide={width >= 900} status={status}>
      <KeyboardAvoidingView style={styles.main} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          ref={listRef}
          style={styles.conversation}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          ItemSeparatorComponent={() => <View style={{ height: 13 }} />}
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            const nearEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
            followLatest.current = nearEnd;
            setAwayFromLatest(messages.length > 0 && !nearEnd);
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (messages.length > 0 && followLatest.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          ListEmptyComponent={loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.blueDark} />
              <Text style={styles.muted}>Opening your conversation…</Text>
            </View>
          ) : (
            <View style={styles.welcome}>
              <Text style={styles.welcomeTitle}>A little help. A lot more room for life.</Text>
              <Text style={styles.welcomeCopy}>
                Tell me what’s on your mind. I can help you think, make a plan, and find the words.
              </Text>
              <View style={styles.suggestions}>
                {suggestions.map((text) => (
                  <Pressable
                    key={text}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy || !sessionId }}
                    disabled={busy || !sessionId}
                    onPress={() => void send(text)}
                    style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
                  >
                    <Text style={styles.suggestionText}>{text}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          ListFooterComponent={(
            <View>
              {!!error && (
                <View style={styles.errorNotice}>
                  <Text style={styles.errorText}>{error}</Text>
                  {messages.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={retry}
                      style={styles.retryButton}
                    >
                      <RotateCcw size={14} color={colors.text} />
                      <Text style={styles.suggestionText}>Try again</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          )}
        />
        {awayFromLatest && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              followLatest.current = true;
              setAwayFromLatest(false);
              listRef.current?.scrollToEnd({ animated: true });
            }}
            style={styles.latestButton}
          >
            <ArrowDown size={15} color={colors.text} />
            <Text style={styles.suggestionText}>Latest messages</Text>
          </Pressable>
        )}
        <ChatComposer
          draft={draft} onChange={setDraft} loading={loading} busy={busy}
          ready={!!sessionId} onSend={() => void send()} onStop={stop}
        />
      </KeyboardAvoidingView>
    </AppShell>
  );
}
