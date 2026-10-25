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
import { useChatScroll } from "./useChatScroll";

export const MESSAGE_GAP = 13;
const MessageSeparator = () => <View style={{ height: MESSAGE_GAP }} />;

/** Only the visible conversation mounts a list; each visit starts at the latest message. */
export function ChatTab({ headerHeight, footerHeight }: {
  headerHeight: number;
  footerHeight: number;
}) {
  const { messages, messageKey, loading, busy, submitting, error, retry, hasOlder, loadingOlder, olderError, loadOlder } = useChatStore();
  const scroll = useChatScroll({
    loading,
    submitting,
    onNearStart: () => {
      if (hasOlder && !loadingOlder && !olderError) fetchOlder();
    },
  });
  const fetchOlder = () => void loadOlder(scroll.beforePrepend);
  const last = messages.at(-1);
  const waitingId = busy && last?.role === "assistant" && !last.content.trim() ? last.id : undefined;
  const renderMessage = ({ item, index }: ListRenderItemInfo<Message>) => {
    const waitingForText = item.id === waitingId;
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
          ref={scroll.listRef}
          // Mount a whole history page at once so the first paint already has its full height.
          initialNumToRender={CHAT_PAGE_SIZE}
          maxToRenderPerBatch={CHAT_PAGE_SIZE}
          windowSize={CHAT_PAGE_SIZE * 2 + 1}
          updateCellsBatchingPeriod={0}
          style={styles.conversation}
          data={messages}
          keyExtractor={messageKey}
          renderItem={renderMessage}
          ItemSeparatorComponent={MessageSeparator}
          // Reserve one message gap at each measured content boundary; fade extents are visual only.
          contentContainerStyle={[styles.messageList, {
            paddingTop: headerHeight + MESSAGE_GAP,
            paddingBottom: footerHeight + MESSAGE_GAP,
          }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          {...scroll.listProps}
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
              {busy && !waitingId && !messages.some(message => message.id.startsWith("live-") && message.content.trim()) && (
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
        {scroll.awayFromLatest && (
          <View pointerEvents="box-none" style={[styles.latestButtonOverlay, { bottom: footerHeight + 12 }]}>
            <IconButton
              label="最新消息"
              onPress={() => scroll.scrollToLatest(true)}
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
