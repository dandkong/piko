import { useEffect, useState } from "react";
import { Platform, Pressable, TextInput, type TextStyle, View } from "react-native";
import { ArrowUp, Plus, Square } from "lucide-react-native";
import { MAX_MESSAGE_LENGTH } from "../../../../../shared/chat";
import { colors } from "../../theme";
import { styles } from "./styles";

// The pill supplies the focus indicator; hide the browser's inner textarea outline.
// React Native's types omit "none", which react-native-web supports.
const webInputStyle = Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : undefined;

type Props = {
  draft: string;
  onChange: (value: string) => void;
  loading: boolean;
  busy: boolean;
  ready: boolean;
  onSend: () => void;
  onStop: () => void;
};

export function ChatComposer({ draft, onChange, loading, busy, ready, onSend, onStop }: Props) {
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  useEffect(() => {
    if (!draft) setInputHeight(44);
  }, [draft]);
  const sendDisabled = !busy && (!draft.trim() || loading || !ready);
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
          value={draft}
          onChangeText={onChange}
          onContentSizeChange={(event) => setInputHeight(Math.max(44, Math.min(140, event.nativeEvent.contentSize.height)))}
          placeholder={loading ? "Connecting…" : "Message…"}
          placeholderTextColor="#949B9F"
          selectionColor={colors.blueDark}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, webInputStyle, { height: inputHeight }]}
          multiline
          maxLength={MAX_MESSAGE_LENGTH}
          editable={!loading}
          submitBehavior="newline"
          accessibilityLabel="Message Piko"
        />
        <Pressable
          accessibilityLabel={busy ? "Stop reply" : "Send message"}
          accessibilityRole="button"
          accessibilityState={{ disabled: sendDisabled }}
          disabled={sendDisabled}
          onPress={busy ? onStop : onSend}
          style={({ pressed }) => [
            styles.composerButton,
            busy || draft.trim() ? styles.sendReady : styles.sendIdle,
            pressed && styles.pressed,
          ]}
        >
          {busy ? <Square size={18} color={colors.text} fill={colors.text} strokeWidth={0} /> : (
            <ArrowUp size={25} strokeWidth={1.8} color={draft.trim() ? colors.text : "#9CB5C5"} />
          )}
        </Pressable>
      </View>
    </View>
  );
}
