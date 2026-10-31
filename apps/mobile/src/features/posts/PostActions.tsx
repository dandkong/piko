import { useEffect, useRef, useState } from "react";
import { Modal, View, useWindowDimensions } from "react-native";
import { MoreVertical, Trash2 } from "lucide-react-native";
import type { PostSummary } from "../../../../../shared/posts";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { IconButton } from "../../components/IconButton";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { colors } from "../../theme";
import { deletePost } from "./api";

/** Card and reader share one menu/confirmation flow, never stack native Modals. */
export function PostActions({ post, onDeleted, inRow = false }: {
  post: PostSummary; onDeleted: (id: string) => void; inRow?: boolean;
}) {
  const anchor = useRef<View>(null);
  const deleting = useRef(false);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { width, height } = useWindowDimensions();
  useDismissOnBack(!!menu, () => setMenu(undefined));
  useEffect(() => { setMenu(undefined); }, [width, height]);
  const remove = async () => {
    if (deleting.current) return;
    deleting.current = true; setBusy(true); setError("");
    try {
      await deletePost(post.id);
      setConfirm(false);
      onDeleted(post.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      deleting.current = false; setBusy(false);
    }
  };
  return <>
    <View ref={anchor} collapsable={false}>
      <IconButton label={`更多操作：帖子 ${post.title}`} hint="删除帖子" variant="plain" stateFill={!inRow}
        accessibilityState={{ expanded: !!menu }} testID="post-menu-button"
        onPress={() => anchor.current?.measureInWindow((x, y, w, h) => {
          setMenu({ left: Math.max(10, Math.min(width - 186, x + w - 176)),
            top: Math.max(10, y + h + 68 <= height - 10 ? y + h + 4 : y - 68) });
        })}>
        <MoreVertical size={20} strokeWidth={1.8} color={colors.muted} />
      </IconButton>
    </View>
    <Modal transparent visible={!!menu || confirm} animationType="fade"
      onRequestClose={() => { if (!confirm) setMenu(undefined); }}>
      {confirm ? <ConfirmationDialogContent title={`删除「${post.title}」？`}
        message="将永久删除这篇帖子及其专属生成记录，无法恢复。不会删除聊天、记忆文件、附件、工作区产物或历史备份。"
        onCancel={() => setConfirm(false)} onConfirm={() => void remove()}
        confirmLabel="删除" cancelLabel="取消" busyLabel="删除中…" busy={busy} error={error}
        testID="post-delete-dialog" />
        : menu ? <AnchoredMenuContent left={menu.left} top={menu.top} closeLabel="关闭帖子菜单"
          onClose={() => setMenu(undefined)} testID="post-actions-menu"
          actions={[{ id: "delete", label: "删除", accessibilityLabel: `删除帖子 ${post.title}`,
            destructive: true, icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
            onPress: () => { setMenu(undefined); setError(""); setConfirm(true); } }]} /> : null}
    </Modal>
  </>;
}
