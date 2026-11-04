import {
  ActivityIndicator,
  FlatList,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { ArrowDown } from "lucide-react-native";
import { CHAT_PAGE_SIZE, type Message } from "../../../../../shared/chat";
import { useTheme } from "../../theme";
import { IconButton } from "../../components/IconButton";
import { TactilePressable } from "../../components/TactilePressable";
import { MarkdownContent } from "../../components/MarkdownContent";
import { ErrorNotice } from "../../components/ErrorNotice";
import { AttachmentList } from "./AttachmentList";
import { useChatStore } from "./ChatProvider";
import { useChatStyles } from "./styles";
import { formatTimestamp, shouldShowTimestamp } from "./time-divider";
import { useChatScroll } from "./useChatScroll";

export const MESSAGE_GAP = 13;
const MessageSeparator = () => <View style={{ height: MESSAGE_GAP }} />;

/** Only the visible conversation mounts a list; each visit starts at the latest message. */
export function ChatTab({ headerHeight, footerHeight }: {
  headerHeight: number;
  footerHeight: number;
}) {
  const { colors } = useTheme();
  const styles = useChatStyles();
  const { messages, messageKey, loading, submitting, error, errorTone, retryLabel, retryBusy, retry, dismissError, hasOlder, loadingOlder, olderError, loadOlder } = useChatStore();
  const lastMessage = messages[messages.length - 1];
  const assistantStreaming = lastMessage?.role === "assistant" && lastMessage.id.startsWith("live-");
  const scroll = useChatScroll({
    loading,
    submitting,
    onNearStart: () => {
      if (hasOlder && !loadingOlder && !olderError) fetchOlder();
    },
  });
  const fetchOlder = () => void loadOlder(scroll.beforePrepend);
  const renderMessage = ({ item, index }: ListRenderItemInfo<Message>) => {
    const hasContent = !!item.content.trim();
    if (!hasContent && !item.attachments?.length) return null;
    const previous = messages[index - 1];
    const divider = shouldShowTimestamp(previous?.createdAt, item.createdAt)
      ? <Text accessibilityLabel="消息时间" style={styles.timeDivider}>{formatTimestamp(item.createdAt)}</Text> : null;
    return (
      <>
        {divider}
        <View
          testID={`chat-message-${item.id}`}
          style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}
        >
          <View style={{ gap: 7 }}>
            <AttachmentList attachments={item.attachments} />
            {hasContent ? (
              <MarkdownContent
                content={item.content}
                streaming={item.role === "assistant" && item.id.startsWith("live-")}
              />
            ) : null}
          </View>
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
              {loadingOlder ? <ActivityIndicator accessibilityLabel="正在加载更早的消息" color={colors.muted} size="small" /> : (
                <TactilePressable accessibilityRole="button" accessibilityLabel={olderError ? "重试加载更早的消息" : "加载更早的消息"}
                  onPress={fetchOlder} variant="plain" scaleTo={1} faceStyle={styles.loadOlderButton}>
                  <Text style={styles.muted}>{olderError ? "历史记录加载失败，点击重试" : "加载更早的消息"}</Text>
                </TactilePressable>
              )}
            </View>
          ) : undefined}
          ListEmptyComponent={loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.muted}>正在打开对话…</Text>
            </View>
          ) : undefined}
          ListFooterComponent={(
            <View>
              {!!error && (
                <View style={{ marginVertical: 10 }}><ErrorNotice message={error} tone={errorTone}
                  actionLabel={retryLabel} onAction={() => void retry()} busy={retryBusy} onDismiss={dismissError}
                  testID="chat-error-notice" /></View>
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
