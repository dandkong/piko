import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, TextInput, type TextStyle, View } from "react-native";
import { ArrowUp, Plus, Square } from "lucide-react-native";
import { MAX_MESSAGE_LENGTH } from "../../../../../shared/chat";
import { colors } from "../../theme";
import { styles } from "./styles";
import { handleComposerKeyDown } from "./composerKeyboard";

// The pill supplies the focus indicator; hide the browser's inner textarea outline.
// React Native's types omit "none", which react-native-web supports.
const webInputStyle = Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : undefined;

type Props = {
  draft: string;
  onChange: (value: string) => void;
  loading: boolean;
  busy: boolean;
  ready: boolean;
  onSend: (text?: string) => void;
  onStop: () => void;
};

export function ChatComposer({ draft, onChange, loading, busy, ready, onSend, onStop }: Props) {
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  const [inputWidth, setInputWidth] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const canSend = !loading && ready && !!draft.trim();
  const showStop = busy && !draft.trim();
  useEffect(() => {
    if (Platform.OS !== "web" || !inputRef.current) return;
    const input = inputRef.current as unknown as HTMLTextAreaElement;
    const onKeyDown = (event: KeyboardEvent) => handleComposerKeyDown(event, canSend, onSend);
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
    <View style={[styles.composer, focused && styles.composerFocused]}>
      <View style={styles.composerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attachments — coming soon"
          accessibilityState={{ disabled: true }}
          disabled
          style={styles.composerButton}
        >
          <Plus size={23} strokeWidth={1.5} color={colors.text} />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={onChange}
          onLayout={Platform.OS === "web" ? (event) => setInputWidth(event.nativeEvent.layout.width) : undefined}
          onContentSizeChange={Platform.OS === "web" ? undefined : (event) => {
            setInputHeight(Math.max(44, Math.min(140, event.nativeEvent.contentSize.height)));
          }}
          placeholder={loading ? "Connecting…" : "Message…"}
          placeholderTextColor="#949B9F"
          selectionColor={colors.blueDark}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, webInputStyle, { height: inputHeight }]}
          multiline
          maxLength={MAX_MESSAGE_LENGTH}
          editable={!loading}
          submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
          returnKeyType="send"
          onSubmitEditing={Platform.OS === "web" ? undefined : (event) => {
            if (!loading && ready && event.nativeEvent.text.trim()) {
              onSend(event.nativeEvent.text);
            }
          }}
          accessibilityLabel="Message Piko"
        />
        <Pressable
          accessibilityLabel={showStop ? "Stop reply" : "Send message"}
          accessibilityRole="button"
          accessibilityState={{ disabled: sendDisabled }}
          disabled={sendDisabled}
          onPress={showStop ? onStop : () => onSend()}
          style={({ pressed }) => [
            styles.composerButton,
            busy || draft.trim() ? styles.sendReady : styles.sendIdle,
            pressed && styles.pressed,
          ]}
        >
          {showStop ? <Square size={18} color={colors.text} fill={colors.text} strokeWidth={0} /> : (
            <ArrowUp size={25} strokeWidth={1.8} color={draft.trim() ? colors.text : "#9CB5C5"} />
          )}
        </Pressable>
      </View>
    </View>
  );
}
