import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Modal, View, useWindowDimensions } from "react-native";
import { MoreVertical, Trash2 } from "lucide-react-native";
import type { PostSummary } from "../../../../../shared/posts";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { IconButton } from "../../components/IconButton";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { useTheme } from "../../theme";
import { deletePost } from "./api";
import { errorMessage } from "../../api/errors";
import { useTranslation } from "../../i18n";

/** Card menu and confirmation share one Modal. The reader has no delete actions. */
export function PostActions({ post, onDeleted, inRow = false }: {
  post: PostSummary; onDeleted: (id: string) => void; inRow?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const anchor = useRef<ComponentRef<typeof View>>(null);
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
      setError(errorMessage(cause, t("posts.deleteUnconfirmed"), t));
    } finally {
      deleting.current = false; setBusy(false);
    }
  };
  return <>
    <View ref={anchor} collapsable={false}>
      <IconButton label={t("posts.menu", { title: post.title })} hint={t("posts.delete")} variant="plain" stateFill={!inRow}
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
      {confirm ? <ConfirmationDialogContent title={t("posts.deleteTitle", { title: post.title })}
        message={t("posts.deleteMessage")}
        onCancel={() => setConfirm(false)} onConfirm={() => void remove()}
        busy={busy} error={error}
        testID="post-delete-dialog" />
        : menu ? <AnchoredMenuContent left={menu.left} top={menu.top} closeLabel={t("posts.closeMenu")}
          onClose={() => setMenu(undefined)} testID="post-actions-menu"
          actions={[{ id: "delete", label: t("common.delete"), accessibilityLabel: t("posts.deleteNamed", { title: post.title }),
            destructive: true, icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
            onPress: () => { setMenu(undefined); setError(""); setConfirm(true); } }]} /> : null}
    </Modal>
  </>;
}
