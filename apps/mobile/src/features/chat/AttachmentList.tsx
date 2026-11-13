import { Linking, Text, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import type { MessageAttachment } from "../../../../../shared/chat";
import { API_URL } from "../../api/client";
import { useTheme } from "../../theme";
import { useTranslation } from "../../i18n";
import { TactilePressable } from "../../components/TactilePressable";
import { useChatStyles } from "./styles";

/** Attachments render the same way for images and other files; only the name is shown. */
export function AttachmentList({ attachments }: { attachments?: MessageAttachment[] }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useChatStyles();
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachmentRow}>
      {attachments.map(item => (
        <TactilePressable
          key={item.id}
          accessibilityLabel={t("chat.openAttachment", { name: item.id })}
          accessibilityRole="link"
          faceStyle={styles.attachmentChip}
          hitSlop={6}
          onPress={() => void Linking.openURL(`${API_URL}${item.url}`)}
          scaleTo={0.98}
          variant="soft"
        >
          <Paperclip size={13} strokeWidth={1.8} color={colors.muted} />
          <Text numberOfLines={1} style={styles.attachmentName}>{item.id}</Text>
        </TactilePressable>
      ))}
    </View>
  );
}
