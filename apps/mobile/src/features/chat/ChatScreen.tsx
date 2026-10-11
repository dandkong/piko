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
import { TypingIndicator } from "../../components/TypingIndicator";
import { colors } from "../../theme";
import { ChatComposer } from "./ChatComposer";
import { AssistantMessage } from "./AssistantMessage";
import { styles } from "./styles";
import { useChat } from "./useChat";

export function ChatScreen() {
  const { ready, messages, draft, setDraft, loading, busy, submitting, error, status, send, stop, retry } = useChat();
  const listRef = useRef<FlatList<Message>>(null);
  const listMetrics = useRef({ contentHeight: 0, viewportHeight: 0 });
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const { width } = useWindowDimensions();
  const scrollToLatest = (animated: boolean) => {
    const { contentHeight, viewportHeight } = listMetrics.current;
    // The measured content height includes the list's bottom padding.
    listRef.current?.scrollToOffset({ offset: Math.max(0, contentHeight - viewportHeight), animated });
  };
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
          <TypingIndicator />
        ) : item.role === "assistant" ? (
          <AssistantMessage content={item.content} streaming={item.id.startsWith("live-")} />
        ) : (
          <Text selectable style={styles.messageText}>{item.content}</Text>
        )}
      </View>
    );
  };

  return (
    <AppShell wide={width >= 900} status={status} onHeaderHeightChange={setHeaderHeight}>
      <KeyboardAvoidingView style={styles.main} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.conversationViewport}>
          <FlatList
            ref={listRef}
            style={styles.conversation}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            ItemSeparatorComponent={() => <View style={{ height: 13 }} />}
            // This inset scrolls with the messages, letting the list extend behind the header.
            contentContainerStyle={[styles.messageList, { paddingTop: headerHeight + 12 }]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
              const nearEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
              followLatest.current = nearEnd;
              setAwayFromLatest(messages.length > 0 && !nearEnd);
            }}
            scrollEventThrottle={100}
            onContentSizeChange={(_, height) => {
              listMetrics.current.contentHeight = height;
              if (messages.length > 0 && followLatest.current) scrollToLatest(false);
            }}
            onLayout={({ nativeEvent: { layout } }) => {
              listMetrics.current.viewportHeight = layout.height;
              if (messages.length > 0 && followLatest.current) scrollToLatest(false);
            }}
            ListEmptyComponent={loading ? (
              <View style={styles.centerState}>
                <ActivityIndicator color={colors.blueDark} />
                <Text style={styles.muted}>Opening your conversation…</Text>
              </View>
            ) : null}
            ListFooterComponent={(
              <View>
                {busy && !messages.some(message => message.id.startsWith("live-") && message.content.trim()) && (
                  <View accessibilityLabel="Piko is working"
                    style={[styles.bubble, styles.assistantBubble, styles.typing, { marginTop: 13 }]}>
                    <TypingIndicator />
                  </View>
                )}
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
                        <Text style={styles.retryButtonText}>Try again</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            )}
          />
          {awayFromLatest && (
            <View pointerEvents="box-none" style={styles.latestButtonOverlay}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Latest messages"
                onPress={() => {
                  followLatest.current = true;
                  setAwayFromLatest(false);
                  scrollToLatest(true);
                }}
                hitSlop={6}
                style={({ pressed }) => [styles.latestButton, pressed && styles.pressed]}
              >
                <ArrowDown size={22} strokeWidth={1.8} color={colors.text} />
              </Pressable>
            </View>
          )}
        </View>
        <ChatComposer
          draft={draft} onChange={setDraft} loading={loading} busy={busy}
          ready={ready && !submitting} onSend={(text) => void send(text)} onStop={stop}
        />
      </KeyboardAvoidingView>
    </AppShell>
  );
}
