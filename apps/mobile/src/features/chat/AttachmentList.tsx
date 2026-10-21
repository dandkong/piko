import { Linking, Pressable, Text, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import type { MessageAttachment } from "../../../../../shared/chat";
import { API_URL } from "../../api/client";
import { colors } from "../../theme";
import { styles } from "./styles";

/** Attachments render the same way for images and other files; only the name is shown. */
export function AttachmentList({ attachments }: { attachments?: MessageAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachmentRow}>
      {attachments.map(item => (
        <Pressable key={item.id} accessibilityRole="link" accessibilityLabel={`Open ${item.id}`}
          onPress={() => void Linking.openURL(`${API_URL}${item.url}`)}
          style={({ pressed }) => [styles.attachmentChip, pressed && styles.pressed]}>
          <Paperclip size={13} strokeWidth={1.8} color={colors.muted} />
          <Text numberOfLines={1} style={styles.attachmentName}>{item.id}</Text>
        </Pressable>
      ))}
    </View>
  );
}
