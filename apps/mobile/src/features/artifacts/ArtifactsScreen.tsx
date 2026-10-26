import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { ChevronRight, Download, FileText, Folder, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react-native";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { IconButton } from "../../components/IconButton";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { colors, radii } from "../../theme";
import { artifactDownloadUrl, deleteArtifact, loadArtifacts } from "./api";

const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const modifiedAt = (value: number) => new Date(value).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

type MenuState = { entry: ArtifactEntry; left: number; top: number };

/** Workspace/artifacts browser; task execution folders remain separate. */
export function ArtifactsScreen({
  topInset,
  bottomInset,
  onPreview,
}: {
  topInset: number;
  bottomInset: number;
  onPreview: (file: ArtifactEntry) => void;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<ArtifactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<MenuState>();
  const [pendingDelete, setPendingDelete] = useState<ArtifactEntry>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deletingRef = useRef(false);
  const anchors = useRef(new Map<string, View>());
  const { width, height } = useWindowDimensions();

  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useDismissOnBack(!!menu, () => setMenu(undefined));
  useEffect(() => { setMenu(undefined); }, [width, height]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDownloadError("");
    void loadArtifacts(path, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setEntries(result.entries);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setEntries([]);
      setError("无法读取产物文件夹，请检查连接后重试。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision]);

  const segments = path ? path.split("/") : [];
  const navigateTo = (value: string) => setPath(value);
  const openEntry = (entry: ArtifactEntry) => {
    if (entry.kind === "directory") navigateTo(entry.path);
    else onPreview(entry);
  };
  const openMenu = (entry: ArtifactEntry) => {
    anchors.current.get(entry.path)?.measureInWindow((x, y, w, h) => {
      const menuWidth = 176;
      const menuHeight = entry.kind === "file" ? 112 : 64;
      const below = y + h + 4;
      const top = below + menuHeight <= height - 10 ? below : Math.max(10, y - menuHeight - 4);
      setMenu({
        entry,
        left: Math.max(10, Math.min(width - menuWidth - 10, x + w - menuWidth)),
        top,
      });
    });
  };
  const download = (entry: ArtifactEntry) => {
    setMenu(undefined);
    setDownloadError("");
    void Linking.openURL(artifactDownloadUrl(entry.path)).catch(() => {
      setDownloadError("无法开始下载，请检查连接后重试。");
    });
  };
  const confirmDelete = (entry: ArtifactEntry) => {
    setMenu(undefined);
    setDeleteError("");
    setPendingDelete(entry);
  };
  const remove = async () => {
    if (!pendingDelete || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteArtifact(pendingDelete.path);
      setPendingDelete(undefined);
      refresh();
    } catch {
      setDeleteError("删除失败，请重试。");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <Screen testID="artifacts-screen" topInset={topInset} bottomInset={bottomInset}>
      <ScreenHeader
        title="产物"
        action={
          <IconButton label="刷新产物列表" hint="重新读取当前文件夹" onPress={refresh}>
            <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
          </IconButton>
        }
      />

      <ScrollView
        horizontal
        contentContainerStyle={styles.breadcrumb}
        showsHorizontalScrollIndicator={false}
        testID="artifact-breadcrumb"
      >
        <TextButton label="产物根目录" onPress={() => navigateTo("")} variant="plain">
          <Text style={[styles.crumbText, !segments.length && styles.crumbCurrent]}>产物</Text>
        </TextButton>
        {segments.map((segment, index) => {
          const value = segments.slice(0, index + 1).join("/");
          const current = index === segments.length - 1;
          return (
            <View key={value} style={styles.crumbSegment}>
              <ChevronRight size={15} color={colors.muted} />
              <TextButton
                label={`打开文件夹 ${segment}`}
                onPress={() => navigateTo(value)}
                variant="plain"
              >
                <Text numberOfLines={1} style={[styles.crumbText, current && styles.crumbCurrent]}>{segment}</Text>
              </TextButton>
            </View>
          );
        })}
      </ScrollView>

      {!!downloadError && <Text accessibilityRole="alert" style={styles.error}>{downloadError}</Text>}
      {!!error && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <TextButton label="重试读取产物" onPress={refresh}>
            <Text style={styles.buttonText}>重试</Text>
          </TextButton>
        </View>
      )}
      {loading && <ActivityIndicator accessibilityLabel="正在读取产物" color={colors.blueDark} />}
      {!loading && !error && !entries.length && (
        <Text style={styles.empty}>
          {path ? "这个文件夹还没有内容。" : "产物文件夹还没有内容。你可以让 Piko 把文件保存到 artifacts/。"}
        </Text>
      )}
      {!loading && !error && entries.map(entry => (
        <ScreenCard key={entry.path} style={styles.rowCard}>
          <TactilePressable
            accessibilityRole="button"
            accessibilityLabel={entry.kind === "directory" ? `打开文件夹 ${entry.name}` : `查看文件 ${entry.name}`}
            accessibilityHint={entry.kind === "directory" ? "进入此文件夹" : entry.preview ? "打开内置预览" : "查看文件信息"}
            onPress={() => openEntry(entry)}
            scaleTo={1}
            style={styles.rowHit}
            faceStyle={styles.row}
            variant="plain"
            testID={`artifact-${entry.kind}`}
          >
            {entry.kind === "directory"
              ? <Folder size={21} strokeWidth={1.8} color={colors.muted} />
              : <FileText size={21} strokeWidth={1.8} color={colors.muted} />}
            <View style={styles.rowInfo}>
              <Text numberOfLines={1} style={styles.name}>{entry.name}</Text>
              <Text numberOfLines={1} style={styles.meta}>
                {entry.kind === "directory" ? "文件夹" : fileSize(entry.size ?? 0)} · {modifiedAt(entry.modifiedAt)}
              </Text>
            </View>
            <ChevronRight size={18} strokeWidth={1.8} color={colors.muted} />
          </TactilePressable>
          <View
            collapsable={false}
            ref={node => { if (node) anchors.current.set(entry.path, node); else anchors.current.delete(entry.path); }}
          >
            <IconButton
              label={`更多操作：${entry.kind === "directory" ? "文件夹" : "文件"} ${entry.name}`}
              hint={entry.kind === "file" ? "下载或删除" : "删除文件夹"}
              size="sm"
              variant="plain"
              accessibilityState={{ expanded: menu?.entry.path === entry.path }}
              onPress={() => openMenu(entry)}
              testID="artifact-item-menu-button"
            >
              <MoreHorizontal size={20} strokeWidth={1.8} color={colors.muted} />
            </IconButton>
          </View>
        </ScreenCard>
      ))}

      <Modal
        transparent
        visible={!!menu || !!pendingDelete}
        animationType="fade"
        onRequestClose={() => { if (!pendingDelete) setMenu(undefined); }}
      >
        {pendingDelete ? (
          <ConfirmationDialogContent
            title={`删除「${pendingDelete.name}」？`}
            message={pendingDelete.kind === "directory"
              ? "将永久删除这个文件夹及其中的全部内容，无法恢复。"
              : "将永久删除这个文件，无法恢复。"}
            onCancel={() => setPendingDelete(undefined)}
            onConfirm={() => void remove()}
            confirmLabel="删除"
            cancelLabel="取消"
            busyLabel="删除中…"
            busy={deleting}
            error={deleteError}
            testID="artifact-delete-dialog"
          />
        ) : menu ? (
          <AnchoredMenuContent
            left={menu.left}
            top={menu.top}
            closeLabel="关闭产物菜单"
            onClose={() => setMenu(undefined)}
            testID="artifact-item-menu"
            actions={[
              ...(menu.entry.kind === "file" ? [{
                id: "download",
                label: "下载",
                accessibilityLabel: `下载 ${menu.entry.name}`,
                icon: <Download size={18} strokeWidth={1.8} color={colors.text} />,
                onPress: () => download(menu.entry),
              }] : []),
              {
                id: "delete",
                label: "删除",
                accessibilityLabel: `删除 ${menu.entry.name}`,
                hint: menu.entry.kind === "directory" ? "永久删除文件夹及其中全部内容" : "永久删除文件",
                icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
                destructive: true,
                onPress: () => confirmDelete(menu.entry),
              },
            ]}
          />
        ) : null}
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  breadcrumb: { alignItems: "center", minHeight: 42, paddingRight: 4 },
  crumbSegment: { flexDirection: "row", alignItems: "center", gap: 2 },
  crumbText: { maxWidth: 180, color: colors.muted, fontSize: 14 },
  crumbCurrent: { color: colors.text, fontWeight: "600" },
  rowCard: { padding: 4, flexDirection: "row", alignItems: "center", gap: 4 },
  rowHit: { flex: 1, minWidth: 0 },
  row: {
    width: "100%",
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 12,
    paddingHorizontal: 10,
    borderRadius: radii.control,
  },
  rowInfo: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  meta: { color: colors.muted, fontSize: 12 },
  empty: { paddingHorizontal: 4, paddingVertical: 10, color: colors.muted, fontSize: 14, lineHeight: 21 },
  notice: { alignItems: "flex-start", gap: 6 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
