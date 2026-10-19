import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { ArrowDown, RotateCcw } from "lucide-react-native";
import type { Message } from "../../../../../shared/chat";
import { AppShell, type AppTab } from "../../components/AppShell";
import { TasksScreen } from "../tasks/TasksScreen";
import { TypingIndicator } from "../../components/TypingIndicator";
import { colors } from "../../theme";
import { ChatComposer } from "./ChatComposer";
import { AssistantMessage } from "./AssistantMessage";
import { styles } from "./styles";
import { useChat } from "./useChat";
import { captureHistoryAnchor, restoreHistoryAnchor, type WebHistoryAnchor } from "./history-scroll";

const MESSAGE_GAP = 13;

export function ChatScreen() {
  const [tab, setTab] = useState<AppTab>("Chat");
  const { ready, messages, draft, setDraft, loading, busy, submitting, error, status, send, stop, retry,
    hasOlder, loadingOlder, olderError, loadOlder } = useChat();
  const listRef = useRef<FlatList<Message>>(null);
  const keyboardLift = useSharedValue(0);
  const [keyboardLiftAmount, setKeyboardLiftAmount] = useState(0);
  const arrowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));
  const listMetrics = useRef({ contentHeight: 0, viewportHeight: 0 });
  const followLatest = useRef(true);
  const positionedLatest = useRef(false);
  const lastOffset = useRef(0);
  const historyAnchor = useRef<WebHistoryAnchor | undefined>(undefined);
  const webScroller = () => {
    if (Platform.OS !== "web" || typeof HTMLElement === "undefined") return;
    const node = listRef.current?.getNativeScrollRef();
    return node instanceof HTMLElement ? node : undefined;
  };
  const fetchOlder = () => void loadOlder(() => {
    followLatest.current = false;
    const node = webScroller();
    if (node) historyAnchor.current = captureHistoryAnchor(node, headerHeight);
  });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const { width } = useWindowDimensions();
  const scrollToLatest = (animated: boolean) => {
    const { contentHeight, viewportHeight } = listMetrics.current;
    // The measured content height includes the list's bottom padding.
    listRef.current?.scrollToOffset({ offset: Math.max(0, contentHeight - viewportHeight), animated });
  };
  useLayoutEffect(() => {
    // Web may not publish a content-size event when only the overlay inset changes.
    const frame = requestAnimationFrame(() => {
      const node = webScroller();
      if (node) listMetrics.current = { contentHeight: node.scrollHeight, viewportHeight: node.clientHeight };
      if (messages.length > 0 && followLatest.current && !historyAnchor.current) scrollToLatest(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [headerHeight, footerHeight]);
  useEffect(() => {
    if (busy) {
      followLatest.current = true;
      setAwayFromLatest(false);
    }
  }, [busy]);

  const oldestId = messages[0]?.id;
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const node = webScroller();
    if (!anchor || !node) return;
    return restoreHistoryAnchor(node, anchor, () => {
      const index = messages.findIndex(message => `chat-message-${message.id}` === anchor.id);
      if (index >= 0) listRef.current?.scrollToIndex({ index, animated: false, viewOffset: anchor.top - node.getBoundingClientRect().top });
    }, () => {
      historyAnchor.current = undefined;
      lastOffset.current = node.scrollTop;
    });
  }, [oldestId]);

  const renderMessage = ({ item }: ListRenderItemInfo<Message>) => {
    const waitingForText = busy && item.role === "assistant" && item.id === messages.at(-1)?.id && !item.content.trim();
    if (!item.content.trim() && !waitingForText) return null;
    return (
      <View
        testID={`chat-message-${item.id}`}
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
    <AppShell
      wide={width >= 900}
      activeTab={tab}
      onTabChange={value => { Keyboard.dismiss(); setTab(value); }}
      status={status}
      headerHeight={headerHeight}
      footerHeight={footerHeight}
      onHeaderHeightChange={setHeaderHeight}
      onFooterHeightChange={setFooterHeight}
      keyboardLift={keyboardLift}
      onKeyboardLiftChange={setKeyboardLiftAmount}
      composer={tab === "Chat" ? (
        <ChatComposer
          draft={draft} onChange={setDraft} loading={loading} busy={busy}
          ready={ready && !submitting} onSend={(text) => void send(text)} onStop={stop}
        />
      ) : null}
    >
      {tab === "Tasks" && <TasksScreen topInset={headerHeight + MESSAGE_GAP} bottomInset={footerHeight + MESSAGE_GAP} />}
      <View style={[styles.main, tab !== "Chat" && { display: "none" }]}>
        <View testID="chat-conversation-viewport" style={styles.conversationViewport}>
          <FlatList
            testID="chat-list"
            ref={listRef}
            style={styles.conversation}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            ItemSeparatorComponent={() => <View style={{ height: MESSAGE_GAP }} />}
            // Reserve one message gap at each measured content boundary; fade extents are visual only.
            contentContainerStyle={[styles.messageList, {
              paddingTop: headerHeight + MESSAGE_GAP,
              paddingBottom: footerHeight + keyboardLiftAmount + MESSAGE_GAP,
            }]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={Platform.OS !== "web" ? { minIndexForVisible: 0 } : undefined}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              if (historyAnchor.current) listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
            }}
            onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
              if (historyAnchor.current) return;
              const movingUp = contentOffset.y < lastOffset.current - 1;
              lastOffset.current = contentOffset.y;
              if (movingUp && contentOffset.y <= 120 && hasOlder && !loadingOlder && !olderError) fetchOlder();
              const nearEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
              // Initial measurement/auto-scroll may be below the final content height.
              // Only an upward scroll leaves follow mode; downward layout updates do not.
              if (nearEnd || movingUp) followLatest.current = nearEnd;
              setAwayFromLatest(messages.length > 0 && !nearEnd && !followLatest.current);
            }}
            scrollEventThrottle={100}
            onContentSizeChange={(_, height) => {
              listMetrics.current.contentHeight = height;
              if (messages.length > 0 && followLatest.current && !historyAnchor.current) {
                const animate = positionedLatest.current && !loading && (submitting || busy);
                scrollToLatest(animate);
                positionedLatest.current = true;
              }
            }}
            onLayout={({ nativeEvent: { layout } }) => {
              listMetrics.current.viewportHeight = layout.height;
              if (messages.length > 0 && followLatest.current && !historyAnchor.current) {
                scrollToLatest(false);
                positionedLatest.current = true;
              }
            }}
            ListHeaderComponent={hasOlder ? (
              <View style={{ height: 40, alignItems: "center", justifyContent: "center" }}>
                {loadingOlder ? <ActivityIndicator accessibilityLabel="Loading earlier messages" color={colors.blueDark} size="small" /> : (
                  <Pressable accessibilityRole="button" onPress={fetchOlder}>
                    <Text style={styles.muted}>{olderError ? "Couldn't load history. Tap to retry" : "Load earlier messages"}</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
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
            <Animated.View pointerEvents="box-none" style={[styles.latestButtonOverlay, { bottom: footerHeight + 12 }, arrowAnimatedStyle]}>
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
            </Animated.View>
          )}
        </View>
      </View>
    </AppShell>
  );
}
