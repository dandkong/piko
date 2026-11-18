import { Platform, Text, View } from "react-native";
import { Download, FileText, Pause, Play } from "lucide-react-native";
import type { MessageAttachment } from "../../../../../shared/chat";
import { API_URL } from "../../api/client";
import { useTheme } from "../../theme";
import { useTranslation } from "../../i18n";
import { IconButton } from "../../components/IconButton";
import { TactilePressable } from "../../components/TactilePressable";
import { downloadFile } from "../../utils/download";
import { useChatStyles } from "./styles";
import { useAudioPlayback } from "./AudioPlayback";
import { attachmentActionUrl } from "./api";

const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav"]);
function canPreviewAudio(mime: string): boolean {
  if (!AUDIO_TYPES.has(mime)) return false;
  if (Platform.OS !== "web" || typeof document === "undefined") return true;
  return !!document.createElement("audio").canPlayType(mime);
}

function AttachmentRow({ item, onPreview, onDownloadError }: {
  item: MessageAttachment;
  onPreview: (item: MessageAttachment) => void;
  onDownloadError: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useChatStyles();
  const player = useAudioPlayback();
  const audio = canPreviewAudio(item.mime);
  const active = audio && player.id === item.url;
  const playing = active && player.playing;
  const name = item.name ?? item.id;
  return <View>
    <View style={styles.attachmentActions}>
      <TactilePressable
        accessibilityRole="button"
        accessibilityLabel={audio ? t(playing ? "chat.pauseAudio" : "chat.playAudio") : t("chat.openAttachment", { name })}
        accessibilityState={audio ? { selected: playing } : undefined}
        style={styles.attachmentHit}
        faceStyle={styles.attachmentChip}
        onPress={() => audio ? player.toggle(item.url, `${API_URL}${attachmentActionUrl(item.url, "play")}`) : onPreview(item)}
        scaleTo={1}
        variant="plain"
      >
        <View style={styles.attachmentIcon}>
          {audio ? (playing ? <Pause size={21} strokeWidth={1.8} color={colors.muted} /> : <Play size={21} strokeWidth={1.8} color={colors.muted} />)
            : <FileText size={21} strokeWidth={1.8} color={colors.muted} />}
        </View>
        <Text numberOfLines={1} style={styles.attachmentName}>{name}</Text>
      </TactilePressable>
      <IconButton label={t("artifacts.downloadNamed", { name })} variant="plain" size="md"
        onPress={() => void downloadFile(`${API_URL}${attachmentActionUrl(item.url, "download")}`).catch(onDownloadError)}>
        <Download size={19} strokeWidth={1.8} color={colors.muted} />
      </IconButton>
    </View>
    {active && player.error ? <Text accessibilityRole="alert" style={styles.audioError}>{t("chat.audioFailed")}</Text> : null}
  </View>;
}

/** Audio plays in place; other files open the shared preview, with download always separate. */
export function AttachmentList({ attachments, onPreview, onDownloadError }: {
  attachments?: MessageAttachment[];
  onPreview: (item: MessageAttachment) => void;
  onDownloadError: () => void;
}) {
  const styles = useChatStyles();
  if (!attachments?.length) return null;
  return <View style={styles.attachmentRow}>
    {attachments.map(item => <AttachmentRow key={item.url} item={item} onPreview={onPreview} onDownloadError={onDownloadError} />)}
  </View>;
}
