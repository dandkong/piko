import { Trash2, MoreHorizontal, Pencil } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SIDE_CHAT_TITLE_LIMIT, type SideChat, type UpdateSideChat } from "../../../../../shared/side-chats";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { TextInputDialogContent } from "../../components/TextInputDialog";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { TactilePressable } from "../../components/TactilePressable";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { colors, radii } from "../../theme";

export type SideChatActions = {
  sideChats?: SideChat[]; activeSideChatId?: string; sideChatBusy?: boolean; sideChatError?: string;
  onRefreshSideChats?: () => void; onSelectSideChat?: (id: string) => void;
  onCreateSideChat?: () => Promise<void>;
  onUpdateSideChat?: (id: string, change: UpdateSideChat) => Promise<boolean>;
  onDeleteSideChat?: (id: string) => Promise<boolean>;
};
export function SideChatList({ sideChats = [], activeSideChatId, sideChatBusy, sideChatError,
  onRefreshSideChats, onSelectSideChat, onUpdateSideChat, onDeleteSideChat }: SideChatActions) {
  const [menu, setMenu] = useState<{ chat: SideChat; left: number; top: number }>();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<SideChat>();
  const [renamed, setRenamed] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const anchors = useRef(new Map<string, View>());
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
  const save = async (id: string) => {
    if (!renamed.trim() || savingRef.current || sideChatBusy) return;
    savingRef.current = true; setSaving(true); setRenameError("");
    try {
      if (await onUpdateSideChat?.(id, { title: renamed.trim() })) setEditing(undefined);
      else setRenameError("保存失败，请重试。");
    } catch { setRenameError("保存失败，请重试。"); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const dismiss = () => { if (!savingRef.current) { setMenu(undefined); setEditing(undefined); setDeleting(undefined); } };
  const remove = async () => {
    if (!deleting || savingRef.current || sideChatBusy) return;
    savingRef.current = true; setSaving(true); setDeleteError("");
    try {
      if (await onDeleteSideChat?.(deleting.id)) setDeleting(undefined);
      else setDeleteError("删除失败，请重试。");
    } catch { setDeleteError("删除失败，请重试。"); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const openMenu = (chat: SideChat) => anchors.current.get(chat.id)?.measureInWindow((x, y, w, h) => {
    setMenu({ chat, left: Math.max(10, Math.min(width - 186, x + w - 176)), top: Math.max(10, Math.min(height - 126, y + h + 4)) });
  });
  return <View style={styles.list}>
    {sideChatError ? <View>
      <Text accessibilityLiveRegion="polite" style={styles.error}>{sideChatError}</Text>
      <TextButton label="重新加载旁聊" disabled={sideChatBusy} onPress={onRefreshSideChats}><Text style={styles.muted}>重试</Text></TextButton>
    </View> : null}
    {!visible.length && <Text style={[styles.muted, { padding: 12 }]}>还没有旁聊</Text>}
    {visible.map(chat => <View key={chat.id}>
      <View style={styles.row}>
        <TactilePressable accessibilityRole="button" accessibilityLabel={`打开旁聊：${chat.title}`} accessibilityState={{ selected: activeSideChatId === chat.id }}
          onPress={() => onSelectSideChat?.(chat.id)} variant="plain" selected={activeSideChatId === chat.id} scaleTo={1}
          style={{ flex: 1, minWidth: 0 }} faceStyle={styles.titleRow} testID={`side-chat-${chat.id}`}>
          <Text numberOfLines={1} style={styles.text}>{chat.title}</Text>
        </TactilePressable>
        <View collapsable={false} ref={node => { if (node) anchors.current.set(chat.id, node); else anchors.current.delete(chat.id); }}>
          <IconButton label={`旁聊菜单：${chat.title}`} hint="重命名或删除" size="sm" variant="plain"
            accessibilityState={{ expanded: menu?.chat.id === chat.id }} onPress={sideChatBusy ? undefined : () => openMenu(chat)}>
            <MoreHorizontal size={20} strokeWidth={1.8} color={colors.muted} />
          </IconButton>
        </View>
      </View>
    </View>)}
    <Modal transparent visible={!!menu || !!editing || !!deleting} animationType="fade" onRequestClose={() => { if (!deleting) dismiss(); }}>
      {editing ? <TextInputDialogContent title="重命名旁聊" inputLabel="新的旁聊名称" value={renamed} onChangeText={setRenamed}
        maxLength={SIDE_CHAT_TITLE_LIMIT} busy={saving} disabled={sideChatBusy} error={renameError}
        onCancel={dismiss} onConfirm={() => void save(editing)} testID="side-chat-rename-dialog" /> : deleting ? <ConfirmationDialogContent
        title={`删除「${deleting.title}」？`}
        message="将永久删除聊天内容和所属后台执行，无法恢复。附件、工作区文件和历史备份不会删除。"
        onCancel={dismiss}
        onConfirm={() => void remove()}
        confirmLabel="确认删除旁聊"
        cancelLabel="取消删除旁聊"
        busyLabel="删除中…"
        busy={saving || !!sideChatBusy}
        error={deleteError}
        testID="side-chat-delete-dialog"
      /> : menu ? <AnchoredMenuContent
        left={menu.left}
        top={menu.top}
        width={176}
        closeLabel="关闭旁聊菜单"
        onClose={dismiss}
        testID="side-chat-menu"
        actions={[
          {
            id: "rename",
            label: "重命名",
            accessibilityLabel: "重命名旁聊",
            icon: <Pencil size={18} strokeWidth={1.8} color={colors.text} />,
            onPress: () => { setEditing(menu.chat.id); setRenamed(menu.chat.title); setRenameError(""); setMenu(undefined); },
          },
          {
            id: "delete",
            label: "删除",
            accessibilityLabel: "删除旁聊",
            icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
            destructive: true,
            onPress: () => { setDeleting(menu.chat); setDeleteError(""); setMenu(undefined); },
          },
        ]}
      /> : null}
    </Modal>
  </View>;
}
const styles = StyleSheet.create({
  list: { gap: 6 }, row: { flexDirection: "row", alignItems: "center", gap: 4 },
  titleRow: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, alignItems: "flex-start", justifyContent: "center", borderRadius: radii.control },
  text: { color: colors.text, fontSize: 15 }, muted: { color: colors.muted, fontSize: 13 }, error: { color: colors.danger, fontSize: 13, padding: 12 },
});
