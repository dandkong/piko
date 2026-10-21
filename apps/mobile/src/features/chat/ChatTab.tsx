import { useEffect, useRef, useState } from "react";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { ArrowDown, RotateCcw } from "lucide-react-native";
import { CHAT_PAGE_SIZE, type Message } from "../../../../../shared/chat";
import { TypingIndicator } from "../../components/TypingIndicator";
import { colors } from "../../theme";
import { AssistantMessage } from "./AssistantMessage";
import { useChatStore } from "./ChatProvider";
import { styles } from "./styles";
import { useChatAnchor } from "./useChatAnchor";

export const MESSAGE_GAP = 13;

/** The conversation stays mounted while another tab is shown, keeping draft and scroll position. */
export function ChatTab({ hidden, headerHeight, footerHeight, keyboardLift, keyboardLiftAmount }: {
  hidden: boolean;
  headerHeight: number;
  footerHeight: number;
  keyboardLift: SharedValue<number>;
  keyboardLiftAmount: number;
}) {
  const { messages, loading, busy, error, retry, hasOlder, loadingOlder, olderError, loadOlder } = useChatStore();
  const listRef = useRef<FlatList<Message>>(null);
  const arrowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));
  const listMetrics = useRef({ contentHeight: 0, viewportHeight: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const webScroller = () => {
    if (Platform.OS !== "web" || typeof HTMLElement === "undefined") return;
    const node = listRef.current?.getNativeScrollRef();
    return node instanceof HTMLElement ? node : undefined;
  };
  const scrollTo = (offset: number, animated: boolean) => {
    const node = webScroller();
    if (node) {
      if (animated) node.scrollTo({ top: offset, behavior: "smooth" });
      else node.scrollTop = offset;
      return;
    }
    listRef.current?.scrollToOffset({ offset, animated });
  };
  const anchor = useChatAnchor({
    scrollTo,
    onAwayChange: setAwayFromLatest,
    indexOf: testId => messages.findIndex(message => `chat-message-${message.id}` === testId),
    seek: index => listRef.current?.scrollToIndex({ index, animated: false }),
  });
  const fetchOlder = () => void loadOlder(() => anchor.detach());
  useEffect(() => { if (busy) anchor.follow(false); }, [busy]);
  // Attach before the first page paints: onLayout only arrives after the list has laid out once.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let frame = 0; let attempts = 0;
    const attach = () => {
      const node = webScroller();
      if (node) { anchor.watch(node); return; }
      if (++attempts < 240) frame = requestAnimationFrame(attach);
    };
    attach();
    return () => cancelAnimationFrame(frame);
  }, []);

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
    <View style={[styles.main, hidden && { display: "none" }]}>
      <View testID="chat-conversation-viewport" style={styles.conversationViewport}>
        <FlatList
          testID="chat-list"
          ref={listRef}
          // Mount a whole history page at once: batching grows the scroll height in steps and each
          // step snaps to the bottom again, which reads as jumping on load.
          initialNumToRender={CHAT_PAGE_SIZE}
          maxToRenderPerBatch={CHAT_PAGE_SIZE}
          windowSize={CHAT_PAGE_SIZE * 2 + 1}
          updateCellsBatchingPeriod={0}
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
          // Native keeps the reader's cell in place when history is prepended; web uses the anchor hook.
          maintainVisibleContentPosition={Platform.OS !== "web" ? { minIndexForVisible: 0 } : undefined}
          onScrollToIndexFailed={({ index, averageItemLength }) => listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            if (contentOffset.y <= 120 && hasOlder && !loadingOlder && !olderError) fetchOlder();
            // Web reads geometry from the DOM observers; native reports it through this event.
            if (Platform.OS !== "web") anchor.observe(contentOffset.y, contentSize.height, layoutMeasurement.height);
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_, height) => {
            listMetrics.current.contentHeight = height;
            if (Platform.OS !== "web") anchor.sync(height, listMetrics.current.viewportHeight);
          }}
          onLayout={({ nativeEvent: { layout } }) => {
            listMetrics.current.viewportHeight = layout.height;
            const node = webScroller();
            if (node) anchor.watch(node);
            if (Platform.OS !== "web") anchor.sync(listMetrics.current.contentHeight, layout.height);
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
              onPress={() => anchor.follow(true)}
              hitSlop={6}
              style={({ pressed }) => [styles.latestButton, pressed && styles.pressed]}
            >
              <ArrowDown size={22} strokeWidth={1.8} color={colors.text} />
            </Pressable>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
