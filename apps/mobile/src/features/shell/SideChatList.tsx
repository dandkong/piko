import { Trash2, MoreVertical, RefreshCw } from "lucide-react-native";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { DEFAULT_SIDE_CHAT_TITLE, type SideChat } from "../../../../../shared/side-chats";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { TactileListRow } from "../../components/TactileListRow";
import { TactilePressable } from "../../components/TactilePressable";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { controlSizes, radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";
import { ErrorNotice } from "../../components/ErrorNotice";
import { errorMessage } from "../../api/errors";
import { useTranslation } from "../../i18n";

export type SideChatActions = {
  sideChats?: SideChat[]; activeSideChatId?: string; sideChatBusy?: boolean; sideChatLoading?: boolean; sideChatError?: string;
  onRefreshSideChats?: () => void; onSelectSideChat?: (id: string) => void;
  onCreateSideChat?: () => Promise<void>;
  onGenerateSideChatTitle?: (id: string) => Promise<boolean>;
  onDeleteSideChat?: (id: string) => Promise<boolean>;
};
export function SideChatList({ sideChats = [], activeSideChatId, sideChatBusy, sideChatLoading, sideChatError,
  onRefreshSideChats, onSelectSideChat, onGenerateSideChatTitle, onDeleteSideChat }: SideChatActions) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemeStyles(createStyles);
  const [menu, setMenu] = useState<{ chat: SideChat; left: number; top: number }>();
  const [deleting, setDeleting] = useState<SideChat>();
  const [deleteError, setDeleteError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const anchors = useRef(new Map<string, ComponentRef<typeof View>>());
  const { width, height } = useWindowDimensions();
  const visible = sideChats;
  useDismissOnBack(
    !!menu,
    () => {
      if (!savingRef.current) setMenu(undefined);
    },
    { capture: true },
  );
  useEffect(() => { setMenu(undefined); }, [width, height]);
  const dismiss = () => { if (!savingRef.current) { setMenu(undefined); setDeleting(undefined); } };
  const remove = async () => {
    if (!deleting || savingRef.current || sideChatBusy) return;
    savingRef.current = true; setSaving(true); setDeleteError("");
    try {
      if (await onDeleteSideChat?.(deleting.id)) setDeleting(undefined);
      else setDeleteError(t("side.deleteFailed"));
    } catch (cause) { setDeleteError(errorMessage(cause, t("posts.deleteUnconfirmed"), t)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const openMenu = (chat: SideChat) => anchors.current.get(chat.id)?.measureInWindow((x, y, w, h) => {
    setMenu({ chat, left: Math.max(10, Math.min(width - 186, x + w - 176)), top: Math.max(10, Math.min(height - 126, y + h + 4)) });
  });
  return <View style={styles.list}>
    {sideChatError ? <ErrorNotice message={sideChatError} actionLabel={t("side.reload")} onAction={onRefreshSideChats}
      busy={sideChatBusy || sideChatLoading} testID="side-chat-load-error" /> : null}
    {!visible.length && !sideChatError && !sideChatLoading && <Text style={[styles.muted, { padding: 12 }]}>{t("side.empty")}</Text>}
    {visible.map(chat => {
      const title = chat.title.trim() || DEFAULT_SIDE_CHAT_TITLE;
      const active = activeSideChatId === chat.id;
      return <TactileListRow key={chat.id} surfaceVariant="compact" selected={active} style={styles.row}>
        <TactilePressable accessibilityRole="button" accessibilityLabel={t("side.open", { title })} accessibilityState={{ selected: active }}
          onPress={() => onSelectSideChat?.(chat.id)} variant="plain" selected={active} stateFill={false} scaleTo={1}
          style={styles.titleHit} faceStyle={styles.titleRow} testID={`side-chat-${chat.id}`}>
          <Text numberOfLines={1} style={styles.text}>{title}</Text>
        </TactilePressable>
        <View collapsable={false} style={styles.menuSlot} ref={node => { if (node) anchors.current.set(chat.id, node); else anchors.current.delete(chat.id); }}>
          <TactilePressable accessibilityRole="button" accessibilityLabel={t("side.menu", { title })} accessibilityHint={t("side.menuHint")}
            accessibilityState={{ expanded: menu?.chat.id === chat.id }} disabled={!!sideChatBusy}
            onPress={() => openMenu(chat)} scaleTo={0.94} stateFill={false} style={styles.menuHit} faceStyle={styles.menuFace} variant="plain">
            <MoreVertical size={20} strokeWidth={1.8} color={colors.muted} />
          </TactilePressable>
        </View>
      </TactileListRow>;
    })}
    <Modal transparent visible={!!menu || !!deleting} animationType="fade" onRequestClose={() => { if (!deleting) dismiss(); }}>
      {deleting ? <ConfirmationDialogContent
        title={t("tasks.deleteTitle", { title: deleting.title.trim() || DEFAULT_SIDE_CHAT_TITLE })}
        message={t("side.deleteMessage")}
        onCancel={dismiss}
        onConfirm={() => void remove()}
        busy={saving || !!sideChatBusy}
        error={deleteError}
        testID="side-chat-delete-dialog"
      /> : menu ? <AnchoredMenuContent
        left={menu.left}
        top={menu.top}
        width={176}
        closeLabel={t("side.closeMenu")}
        onClose={dismiss}
        testID="side-chat-menu"
        actions={[
          {
            id: "generate-title",
            label: t("side.generateTitle"),
            accessibilityLabel: t("side.generateTitleLabel"),
            icon: <RefreshCw size={18} strokeWidth={1.8} color={colors.text} />,
            onPress: () => { const id = menu.chat.id; setMenu(undefined); void onGenerateSideChatTitle?.(id); },
          },
          {
            id: "delete",
            label: t("common.delete"),
            accessibilityLabel: t("side.delete"),
            icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
            destructive: true,
            onPress: () => { setDeleting(menu.chat); setDeleteError(""); setMenu(undefined); },
          },
        ]}
      /> : null}
    </Modal>
  </View>;
}
function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
  list: { gap: 6 }, row: { minHeight: 52, flexDirection: "row", alignItems: "stretch", gap: 0 },
  titleHit: { flex: 1, minWidth: 0, alignSelf: "stretch" },
  titleRow: { flex: 1, alignSelf: "stretch", minHeight: 52, paddingHorizontal: 12, paddingVertical: 10, alignItems: "flex-start", justifyContent: "center", borderRadius: radii.control },
  menuSlot: { width: 52, alignItems: "center", justifyContent: "center" },
  menuHit: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  menuFace: { width: controlSizes.md, height: controlSizes.md, alignSelf: "center", borderRadius: controlSizes.md / 2, alignItems: "center", justifyContent: "center" },
  text: { color: colors.text, fontSize: 15 }, muted: { color: colors.muted, fontSize: 13 }, error: { color: colors.danger, fontSize: 13, padding: 12 },
  });
}
