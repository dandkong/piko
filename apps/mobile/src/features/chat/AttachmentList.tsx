import { Linking, Platform, Text, View } from "react-native";
import { FileText, Pause, Play } from "lucide-react-native";
import type { MessageAttachment } from "../../../../../shared/chat";
import { API_URL } from "../../api/client";
import { useTheme } from "../../theme";
import { useTranslation } from "../../i18n";
import { TactilePressable } from "../../components/TactilePressable";
import { useChatStyles } from "./styles";
import { useAudioPlayback } from "./AudioPlayback";

const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav"]);
function canPreviewAudio(mime: string): boolean {
  if (!AUDIO_TYPES.has(mime)) return false;
  if (Platform.OS !== "web" || typeof document === "undefined") return true;
  return !!document.createElement("audio").canPlayType(mime);
}

function AudioAttachment({ item }: { item: MessageAttachment }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useChatStyles();
  const player = useAudioPlayback();
  const active = player.id === item.url;
  const playing = active && player.playing;
  const url = `${API_URL}${item.url}${item.url.includes("?") ? "&" : "?"}play=1`;
  return <View>
    <TactilePressable
      accessibilityRole="button"
      accessibilityLabel={t(playing ? "chat.pauseAudio" : "chat.playAudio")}
      accessibilityState={{ selected: playing }}
      style={styles.attachmentHit}
      faceStyle={styles.attachmentChip}
      onPress={() => player.toggle(item.url, url)}
      scaleTo={1}
      variant="plain"
    >
      <View style={styles.attachmentIcon}>
        {playing ? <Pause size={21} strokeWidth={1.8} color={colors.muted} /> : <Play size={21} strokeWidth={1.8} color={colors.muted} />}
      </View>
      <Text numberOfLines={1} style={styles.attachmentName}>{item.name ?? item.id}</Text>
    </TactilePressable>
    {active && player.error ? <Text accessibilityRole="alert" style={styles.audioError}>{t("chat.audioFailed")}</Text> : null}
  </View>;
}

/** A supported audio file plays in place; other attachments open normally. */
export function AttachmentList({ attachments }: { attachments?: MessageAttachment[] }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useChatStyles();
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachmentRow}>
      {attachments.map(item => canPreviewAudio(item.mime) ? <AudioAttachment key={item.url} item={item} /> : (
        <TactilePressable
          key={item.id}
          accessibilityLabel={t("chat.openAttachment", { name: item.name ?? item.id })}
          accessibilityRole="link"
          style={styles.attachmentHit}
          faceStyle={styles.attachmentChip}
          onPress={() => void Linking.openURL(`${API_URL}${item.url}`)}
          scaleTo={1}
          variant="plain"
        >
          <View style={styles.attachmentIcon}>
            <FileText size={21} strokeWidth={1.8} color={colors.muted} />
          </View>
          <Text numberOfLines={1} style={styles.attachmentName}>{item.name ?? item.id}</Text>
        </TactilePressable>
      ))}
    </View>
  );
}
