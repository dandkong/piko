import { useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { Platform, Text, TextInput, type TextStyle, View } from "react-native";
import { ArrowUp, Paperclip, Plus, Square, X } from "lucide-react-native";
import { useTheme } from "../../theme";
import { IconButton } from "../../components/IconButton";
import { TactilePressable } from "../../components/TactilePressable";
import { useChatStyles } from "./styles";
import { handleComposerKeyDown } from "./composerKeyboard";
import type { PendingAttachment } from "./useChatAttachments";

// The composer surface supplies the focus indicator; hide the browser's inner textarea outline.
// React Native's types omit "none", which react-native-web supports.
const webInputStyle =
  Platform.OS === "web"
    ? ({ outlineStyle: "none" } as unknown as TextStyle)
    : undefined;
type Props = {
  draft: string;
  onChange: (value: string) => void;
  loading: boolean;
  busy: boolean;
  submitting: boolean;
  attachments: PendingAttachment[];
  attaching: boolean;
  onAttach: () => void;
  onRemoveAttachment: (id: string) => void;
  onSend: (text?: string) => void;
  onStop: () => void;
};

export function ChatComposer({
  draft,
  onChange,
  loading,
  busy,
  submitting,
  attachments,
  attaching,
  onAttach,
  onRemoveAttachment,
  onSend,
  onStop,
}: Props) {
  const { colors } = useTheme();
  const styles = useChatStyles();
  const [inputHeight, setInputHeight] = useState(44);
  const [inputWidth, setInputWidth] = useState(0);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const canSend =
    !loading && !submitting && (!!draft.trim() || attachments.length > 0);
  const showStop = busy && !draft.trim() && !attachments.length;
  useEffect(() => {
    if (Platform.OS !== "web" || !inputRef.current) return;
    const input = inputRef.current as unknown as HTMLTextAreaElement;
    const onKeyDown = (event: KeyboardEvent) =>
      handleComposerKeyDown(event, canSend, onSend);
    input.addEventListener("keydown", onKeyDown);
    return () => input.removeEventListener("keydown", onKeyDown);
  }, [canSend, onSend]);
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || !inputRef.current) return;
    const input = inputRef.current as unknown as HTMLTextAreaElement;
    // scrollHeight includes the current box height. Collapse it before measuring
    // so deleting text can shrink the composer as well as typing can grow it.
    input.style.height = "0px";
    const height = Math.max(44, Math.min(140, input.scrollHeight));
    input.style.height = `${height}px`;
    setInputHeight(height);
  }, [draft, inputWidth]);
  useEffect(() => {
    if (Platform.OS !== "web" && !draft) setInputHeight(44);
  }, [draft]);
  const sendDisabled = !showStop && !canSend;
  return (
    <View style={styles.composer}>
      {attachments.length > 0 && (
        <View style={styles.composerAttachments}>
          {attachments.map((item) => (
            <View key={item.id} style={styles.composerAttachment}>
              <Paperclip size={13} strokeWidth={1.8} color={colors.muted} />
              <Text numberOfLines={1} style={styles.composerAttachmentName}>
                {item.name || item.id}
              </Text>
              <TactilePressable
                accessibilityLabel={`移除 ${item.name || item.id}`}
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => onRemoveAttachment(item.id)}
                scaleTo={0.9}
                style={styles.attachmentRemoveHit}
                faceStyle={styles.attachmentRemove}
                variant="plain"
              >
                <X size={13} strokeWidth={2} color={colors.muted} />
              </TactilePressable>
            </View>
          ))}
        </View>
      )}
      <View style={styles.composerRow}>
        <IconButton
          disabled={loading || attaching}
          label="添加附件"
          onPress={onAttach}
          variant="plain"
        >
          <Plus size={22} strokeWidth={1.8} color={colors.text} />
        </IconButton>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={onChange}
          onLayout={
            Platform.OS === "web"
              ? (event) => setInputWidth(event.nativeEvent.layout.width)
              : undefined
          }
          onContentSizeChange={
            Platform.OS === "web"
              ? undefined
              : (event) => {
                  setInputHeight(
                    Math.max(
                      44,
                      Math.min(140, event.nativeEvent.contentSize.height),
                    ),
                  );
                }
          }
          placeholder={loading ? "正在连接…" : "发消息…"}
          placeholderTextColor={colors.muted}
          style={[styles.input, webInputStyle, { height: inputHeight }]}
          multiline
          editable={!loading}
          submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
          returnKeyType="send"
          onSubmitEditing={
            Platform.OS === "web"
              ? undefined
              : (event) => {
                  if (!loading && !submitting && event.nativeEvent.text.trim()) {
                    onSend(event.nativeEvent.text);
                  }
                }
          }
          accessibilityLabel="给 Piko 发消息"
        />
        <IconButton
          disabled={sendDisabled}
          label={showStop ? "停止回复" : "发送消息"}
          onPress={showStop ? onStop : () => onSend()}
          variant={showStop ? "soft" : "primary"}
        >
          {showStop ? (
            <Square
              size={18}
              color={colors.text}
              fill={colors.text}
              strokeWidth={0}
            />
          ) : (
            <ArrowUp size={22} strokeWidth={1.8} color={colors.text} />
          )}
        </IconButton>
      </View>
    </View>
  );
}
