import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { ArrowDown, RotateCcw } from "lucide-react-native";
import { CHAT_PAGE_SIZE, type Message } from "../../../../../shared/chat";
import { TypingIndicator } from "../../components/TypingIndicator";
import { colors } from "../../theme";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { AssistantMessage } from "./AssistantMessage";
import { AttachmentList } from "./AttachmentList";
import { useChatStore } from "./ChatProvider";
import { styles } from "./styles";
import { formatTimestamp, shouldShowTimestamp } from "./time-divider";

export const MESSAGE_GAP = 13;
const MessageSeparator = () => <View style={{ height: MESSAGE_GAP }} />;

/** Only the visible conversation mounts a list; each visit starts at the latest message. */
export function ChatTab({ headerHeight, footerHeight }: {
  headerHeight: number;
  footerHeight: number;
}) {
  const { messages, loading, busy, submitting, error, retry, hasOlder, loadingOlder, olderError, loadOlder } = useChatStore();
  const listRef = useRef<FlatList<Message>>(null);
  const following = useRef(true);
  const dragging = useRef(false);
  const metrics = useRef({ contentHeight: 0, viewportHeight: 0, offset: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);

  const scrollToLatest = (animated: boolean) => {
    if (dragging.current || !metrics.current.viewportHeight || !metrics.current.contentHeight) return;
    following.current = true;
    // Let onScroll hide the button on arrival, not before the scroll animation.
    // scrollToEnd approximates unmeasured rows; the measured content box is exact.
    const offset = Math.max(0, metrics.current.contentHeight - metrics.current.viewportHeight);
    if (!animated) metrics.current.offset = offset;
    listRef.current?.scrollToOffset({ offset, animated });
  };
  // Only a local send reveals the new exchange; resuming a busy snapshot does not.
  useEffect(() => { if (submitting) scrollToLatest(false); }, [submitting]);

  const fetchOlder = () => void loadOlder();
  const renderMessage = ({ item, index }: ListRenderItemInfo<Message>) => {
    const waitingForText = busy && item.role === "assistant" && item.id === messages.at(-1)?.id && !item.content.trim();
    const hasContent = !!item.content.trim();
    if (!hasContent && !item.attachments?.length && !waitingForText) return null;
    const previous = messages[index - 1];
    const divider = shouldShowTimestamp(previous?.createdAt, item.createdAt)
      ? <Text accessibilityLabel="消息时间" style={styles.timeDivider}>{formatTimestamp(item.createdAt)}</Text> : null;
    return (
      <>
        {divider}
        <View
          testID={`chat-message-${item.id}`}
          accessibilityLabel={waitingForText ? "Piko 正在工作" : undefined}
          style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble, waitingForText && styles.typing]}
        >
          {waitingForText ? (
            <TypingIndicator />
          ) : (
            <View style={{ gap: 7 }}>
              <AttachmentList attachments={item.attachments} />
              {hasContent ? (item.role === "assistant" ? (
                <AssistantMessage content={item.content} streaming={item.id.startsWith("live-")} />
              ) : (
                <Text selectable style={styles.messageText}>{item.content}</Text>
              )) : null}
            </View>
          )}
        </View>
      </>
    );
  };

  return (
    <View style={styles.main}>
      <View testID="chat-conversation-viewport" style={styles.conversationViewport}>
        <FlatList
          testID="chat-list"
          ref={listRef}
          // Mount a whole history page at once so the first paint already has its full height.
          initialNumToRender={CHAT_PAGE_SIZE}
          maxToRenderPerBatch={CHAT_PAGE_SIZE}
          windowSize={CHAT_PAGE_SIZE * 2 + 1}
          updateCellsBatchingPeriod={0}
          style={styles.conversation}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          ItemSeparatorComponent={MessageSeparator}
          // Reserve one message gap at each measured content boundary; fade extents are visual only.
          contentContainerStyle={[styles.messageList, {
            paddingTop: headerHeight + MESSAGE_GAP,
            paddingBottom: footerHeight + MESSAGE_GAP,
          }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => {
            dragging.current = true;
            following.current = false;
          }}
          onScrollEndDrag={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            dragging.current = false;
            if (!layoutMeasurement.height) return;
            // A short upward drag is still reading intent, even inside the follow threshold.
            const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height <= 1;
            following.current = atBottom;
            setAwayFromLatest(!atBottom);
          }}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            if (!layoutMeasurement.height) return;
            const movingUp = contentOffset.y < metrics.current.offset - 0.5;
            metrics.current.offset = contentOffset.y;
            const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
            // Web wheels do not emit begin/end drag. Detach on upward movement too.
            const follow = !dragging.current && !movingUp && distance <= 1;
            following.current = follow;
            setAwayFromLatest(!follow);
            if (contentOffset.y <= 120 && hasOlder && !loadingOlder && !olderError) fetchOlder();
          }}
          scrollEventThrottle={16}
          onLayout={({ nativeEvent: { layout } }) => {
            if (!layout.height) return;
            metrics.current.viewportHeight = layout.height;
            if (following.current) scrollToLatest(false);
          }}
          // Layout callbacks are not new messages and must never override a drag.
          onContentSizeChange={(_, height) => {
            if (!height) return;
            const changed = height !== metrics.current.contentHeight;
            metrics.current.contentHeight = height;
            if (changed && following.current && !dragging.current) scrollToLatest(false);
          }}
          ListHeaderComponent={hasOlder ? (
            <View style={{ height: 40, alignItems: "center", justifyContent: "center" }}>
              {loadingOlder ? <ActivityIndicator accessibilityLabel="正在加载更早的消息" color={colors.blueDark} size="small" /> : (
                <Pressable accessibilityRole="button" onPress={fetchOlder}>
                  <Text style={styles.muted}>{olderError ? "历史记录加载失败，点击重试" : "加载更早的消息"}</Text>
                </Pressable>
              )}
            </View>
          ) : null}
          ListEmptyComponent={loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.blueDark} />
              <Text style={styles.muted}>正在打开对话…</Text>
            </View>
          ) : null}
          ListFooterComponent={(
            <View>
              {busy && !messages.some(message => message.id.startsWith("live-") && message.content.trim()) && (
                <View accessibilityLabel="Piko 正在工作"
                  style={[styles.bubble, styles.assistantBubble, styles.typing, { marginTop: 13 }]}>
                  <TypingIndicator />
                </View>
              )}
              {!!error && (
                <View style={styles.errorNotice}>
                  <Text style={styles.errorText}>{error}</Text>
                  {messages.length > 0 && (
                    <TextButton
                      disabled={busy}
                      label="重试"
                      onPress={retry}
                      style={styles.retryButtonLayout}
                      variant="plain"
                    >
                      <RotateCcw size={14} color={colors.text} />
                      <Text style={styles.retryButtonText}>重试</Text>
                    </TextButton>
                  )}
                </View>
              )}
            </View>
          )}
        />
        {awayFromLatest && (
          <View pointerEvents="box-none" style={[styles.latestButtonOverlay, { bottom: footerHeight + 12 }]}>
            <IconButton
              label="最新消息"
              onPress={() => scrollToLatest(true)}
              style={styles.latestButtonShadow}
            >
              <ArrowDown size={22} strokeWidth={1.8} color={colors.text} />
            </IconButton>
          </View>
        )}
      </View>
    </View>
  );
}
