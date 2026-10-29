import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, Linking, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { ChevronDown, ChevronRight, Download, FileText, Folder, MoreVertical, RefreshCw, Trash2 } from "lucide-react-native";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { IconButton } from "../../components/IconButton";
import { Screen } from "../../components/Screen";
import { TactileListRow } from "../../components/TactileListRow";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { colors, controlSizes, radii } from "../../theme";
import { artifactDownloadUrl, deleteArtifact, loadArtifacts } from "./api";

import { artifactMetadata, artifactSortOptions, DEFAULT_ARTIFACT_SORT, isArtifactSort, sortArtifacts, type ArtifactSort } from "./presentation";

const SORT_STORAGE_KEY = "piko.artifacts.sort";
// Keep rapid selections ordered, including when this screen unmounts and opens again.
let sortWrites = Promise.resolve();
type MenuState = { left: number; top: number } & ({ kind: "entry"; entry: ArtifactEntry } | { kind: "sort" });

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
  const [sort, setSort] = useState<ArtifactSort>(DEFAULT_ARTIFACT_SORT);
  const [sortReady, setSortReady] = useState(false);
  const [menu, setMenu] = useState<MenuState>();
  const [pendingDelete, setPendingDelete] = useState<ArtifactEntry>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deletingRef = useRef(false);
  const anchors = useRef(new Map<string, View>());
  const sortAnchor = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const { width, height } = useWindowDimensions();
  const sortedEntries = useMemo(() => sortArtifacts(entries, sort), [entries, sort]);
  const sortOption = artifactSortOptions.find(option => option.value === sort)!;
  const listLoading = loading || !sortReady;

  useEffect(() => {
    let active = true;
    void sortWrites.then(() => AsyncStorage.getItem(SORT_STORAGE_KEY)).then(value => {
      if (active && isArtifactSort(value)) setSort(value);
    }).catch(() => {}).finally(() => { if (active) setSortReady(true); });
    return () => { active = false; };
  }, []);

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
      const top = Math.max(10, below + menuHeight <= height - 10 ? below : y - menuHeight - 4);
      setMenu({
        kind: "entry", entry,
        left: Math.max(10, Math.min(width - menuWidth - 10, x + w - menuWidth)),
        top,
      });
    });
  };
  const openSortMenu = () => {
    sortAnchor.current?.measureInWindow((x, y, w, h) => {
      const menuWidth = Math.min(232, width - 20);
      const menuHeight = artifactSortOptions.length * 48 + 2;
      const below = y + h + 4;
      setMenu({
        kind: "sort",
        left: Math.max(10, Math.min(width - menuWidth - 10, x + w - menuWidth)),
        top: Math.max(10, below + menuHeight <= height - 10 ? below : y - menuHeight - 4),
      });
    });
  };
  const selectSort = (value: ArtifactSort) => {
    setMenu(undefined);
    if (sort === value) return;
    setSort(value);
    sortWrites = sortWrites.then(() => AsyncStorage.setItem(SORT_STORAGE_KEY, value)).catch(() => {});
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
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
    <Screen testID="artifacts-screen" topInset={topInset} bottomInset={bottomInset} scrollRef={scrollRef}>
      <View style={styles.header}>
        {segments.length ? (
          <TextButton
            label="返回产物根目录"
            hint="返回产物根目录"
            onPress={() => navigateTo("")}
            variant="plain"
            style={styles.headerTitleHit}
            faceStyle={styles.headerTitleFace}
          >
            <Text style={styles.headerTitle}>产物</Text>
          </TextButton>
        ) : (
          <Text style={styles.headerTitle}>产物</Text>
        )}
        <View style={styles.headerSpacer} />
        <View ref={sortAnchor} collapsable={false}>
          <TextButton
            label={`排序：${sortOption.label}`}
            hint="选择名称或修改时间排序"
            accessibilityState={{ expanded: menu?.kind === "sort" }}
            disabled={!sortReady}
            onPress={openSortMenu}
            faceStyle={styles.sortFace}
            testID="artifact-sort-button"
          >
            <Text style={styles.sortLabel}>{sortOption.shortLabel}</Text>
            <ChevronDown size={15} strokeWidth={1.8} color={colors.muted} />
          </TextButton>
        </View>
        <IconButton label="刷新产物列表" hint="重新读取当前文件夹" onPress={refresh}>
          <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
        </IconButton>
      </View>
      {!!segments.length && (
        <ScrollView
          horizontal
          style={styles.headerCrumbs}
          contentContainerStyle={styles.breadcrumb}
          showsHorizontalScrollIndicator={false}
          testID="artifact-breadcrumb"
        >
          {segments.map((segment, index) => {
            const value = segments.slice(0, index + 1).join("/");
            const current = index === segments.length - 1;
            return (
              <View key={value} style={styles.crumbSegment}>
                <ChevronRight size={13} color={colors.muted} />
                <TextButton label={`打开文件夹 ${segment}`} onPress={() => navigateTo(value)} variant="plain" style={styles.crumbHit} faceStyle={styles.crumbFace}>
                  <Text numberOfLines={1} style={[styles.crumbText, current && styles.crumbCurrent]}>{segment}</Text>
                </TextButton>
              </View>
            );
          })}
        </ScrollView>
      )}

      {!!downloadError && <Text accessibilityRole="alert" style={styles.error}>{downloadError}</Text>}
      {!!error && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <TextButton label="重试读取产物" onPress={refresh}>
            <Text style={styles.buttonText}>重试</Text>
          </TextButton>
        </View>
      )}
      {listLoading && <ActivityIndicator accessibilityLabel="正在读取产物" color={colors.muted} />}
      {!listLoading && !error && !entries.length && (
        <Text style={styles.empty}>
          {path ? "这个文件夹还没有内容。" : "产物文件夹还没有内容。你可以让 Piko 把文件保存到 artifacts/。"}
        </Text>
      )}
      {!listLoading && !error && sortedEntries.map(entry => (
        <TactileListRow key={entry.path} surfaceVariant="card" style={styles.rowCard}>
          <TactilePressable
            accessibilityRole="button"
            accessibilityLabel={entry.kind === "directory" ? `打开文件夹 ${entry.name}` : `查看文件 ${entry.name}`}
            accessibilityHint={entry.kind === "directory" ? "进入此文件夹" : entry.preview ? "打开内置预览" : "查看文件信息"}
            onPress={() => openEntry(entry)}
            scaleTo={1}
            style={styles.rowHit}
            faceStyle={styles.row}
            stateFill={false}
            variant="plain"
            testID={`artifact-${entry.kind}`}
          >
            {entry.kind === "directory"
              ? <Folder size={21} strokeWidth={1.8} color={colors.muted} />
              : <FileText size={21} strokeWidth={1.8} color={colors.muted} />}
            <View style={styles.rowInfo}>
              <Text numberOfLines={1} style={styles.name}>{entry.name}</Text>
              <Text numberOfLines={1} style={styles.meta}>
                {artifactMetadata(entry)}
              </Text>
            </View>
          </TactilePressable>
          <View
            collapsable={false}
            style={styles.menuSlot}
            ref={node => { if (node) anchors.current.set(entry.path, node); else anchors.current.delete(entry.path); }}
          >
            <TactilePressable
              accessibilityRole="button"
              accessibilityLabel={`更多操作：${entry.kind === "directory" ? "文件夹" : "文件"} ${entry.name}`}
              accessibilityHint={entry.kind === "file" ? "下载或删除" : "删除文件夹"}
              accessibilityState={{ expanded: menu?.kind === "entry" && menu.entry.path === entry.path }}
              onPress={() => openMenu(entry)}
              scaleTo={0.94}
              style={styles.menuHit}
              faceStyle={styles.menuFace}
              stateFill={false}
              variant="plain"
              testID="artifact-item-menu-button"
            >
              <MoreVertical size={20} strokeWidth={1.8} color={colors.muted} />
            </TactilePressable>
          </View>
        </TactileListRow>
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
        ) : menu?.kind === "sort" ? (
          <AnchoredMenuContent
            left={menu.left}
            top={menu.top}
            width={Math.min(232, width - 20)}
            closeLabel="关闭排序菜单"
            label="产物排序"
            onClose={() => setMenu(undefined)}
            testID="artifact-sort-menu"
            actions={artifactSortOptions.map(option => ({
              id: option.value,
              label: option.label,
              accessibilityLabel: option.label,
              selected: option.value === sort,
              onPress: () => selectSort(option.value),
            }))}
          />
        ) : menu?.kind === "entry" ? (
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
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, marginBottom: 4 },
  headerTitle: { fontSize: 22, fontWeight: "600", color: colors.text, flexShrink: 1 },
  headerTitleHit: { flexShrink: 0 },
  headerTitleFace: { minHeight: 44, paddingHorizontal: 0, paddingVertical: 0, justifyContent: "flex-start" },
  headerCrumbs: { minWidth: 0, flexGrow: 0 },
  sortFace: { minHeight: 44, paddingHorizontal: 10, gap: 4 },
  sortLabel: { color: colors.text, fontSize: 13 },
  headerSpacer: { flex: 1, minWidth: 0 },
  breadcrumb: { alignItems: "center", minHeight: 36, paddingRight: 4 },
  crumbSegment: { flexDirection: "row", alignItems: "center", gap: 1 },
  crumbHit: { flexShrink: 0 },
  crumbFace: { minHeight: 32, paddingHorizontal: 4, paddingVertical: 4, gap: 4 },
  crumbText: { maxWidth: 140, color: colors.muted, fontSize: 16 },
  crumbCurrent: { color: colors.muted, fontWeight: "500" },
  rowCard: { flexDirection: "row", alignItems: "stretch", gap: 0 },
  rowHit: { flex: 1, minWidth: 0, alignSelf: "stretch" },
  row: {
    flex: 1,
    alignSelf: "stretch",
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    borderTopLeftRadius: radii.card,
    borderBottomLeftRadius: radii.card,
  },
  menuSlot: { width: 52, alignItems: "center", justifyContent: "center" },
  menuHit: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  menuFace: { width: controlSizes.md, height: controlSizes.md, alignSelf: "center", borderRadius: controlSizes.md / 2, alignItems: "center", justifyContent: "center" },
  rowInfo: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  meta: { color: colors.muted, fontSize: 12 },
  empty: { paddingHorizontal: 4, paddingVertical: 10, color: colors.muted, fontSize: 14, lineHeight: 21 },
  notice: { alignItems: "flex-start", gap: 6 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
