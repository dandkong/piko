import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Play,
  Trash2,
} from "lucide-react-native";
import { ActivityIndicator, Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { TaskExecution, AssistantTask } from "../../../../../shared/tasks";
import { AnchoredMenuContent } from "../../components/AnchoredMenu";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { controlSizes, radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { TactileListRow } from "../../components/TactileListRow";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { MarkdownContent } from "../../components/MarkdownContent";
import type { TaskExecutionPreviewTarget } from "./TaskExecutionPreviewPanel";
import { useTasks } from "./useTasks";
import { ErrorNotice } from "../../components/ErrorNotice";
import { useTranslation } from "../../i18n";

type FinishedExecution = TaskExecution & {
  status: Exclude<TaskExecution["status"], "running">;
};
const isFinished = (run: TaskExecution): run is FinishedExecution =>
  run.status !== "running";
const dayTime = (value: number | string, locale: string) =>
  new Date(value).toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const statusKeys = {
  completed: "tasks.completed",
  failed: "tasks.failed",
  stopped: "tasks.stopped",
  interrupted: "tasks.interrupted",
} as const satisfies Record<FinishedExecution["status"], string>;
const scheduleLabel = (task: AssistantTask) => task.scheduleText;
type MenuState = { task: AssistantTask; left: number; top: number };

/** The assistant's standing commitments: the task list stays lean, and detail shows finished records. */
export function TasksScreen({
  topInset,
  bottomInset,
  onPreviewExecution,
  onToast,
}: {
  topInset: number;
  bottomInset: number;
  onPreviewExecution: (target: TaskExecutionPreviewTarget) => void;
  onToast: (message: string) => void;
}) {
  const { colors } = useTheme();
  const { t, language } = useTranslation();
  const styles = useThemeStyles(createStyles);
  const {
    tasks,
    selected,
    detail,
    loading,
    busy,
    error,
    openSections,
    openTask,
    toggleArchive,
    runTask,
    deleteTask,
    deleteError,
    clearDeleteError,
    reload,
    toggleSection,
  } = useTasks(onToast);
  const [menu, setMenu] = useState<MenuState>();
  const [pendingDelete, setPendingDelete] = useState<AssistantTask>();
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const anchors = useRef(new Map<string, ComponentRef<typeof View>>());
  const { width, height } = useWindowDimensions();
  useDismissOnBack(!!menu, () => setMenu(undefined));
  useEffect(() => { setMenu(undefined); }, [width, height]);
  const openMenu = (task: AssistantTask) => anchors.current.get(task.id)?.measureInWindow((x, y, w, h) => {
    const menuWidth = 176;
    const menuHeight = (task.status === "active" ? 3 : 2) * 48 + 16;
    const below = y + h + 4;
    const top = below + menuHeight <= height - 10 ? below : Math.max(10, y - menuHeight - 4);
    setMenu({ task, left: Math.max(10, Math.min(width - menuWidth - 10, x + w - menuWidth)), top });
  });
  const confirmDelete = (task: AssistantTask) => {
    setMenu(undefined);
    clearDeleteError();
    setPendingDelete(task);
  };
  const remove = async () => {
    if (!pendingDelete || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      if (await deleteTask(pendingDelete)) setPendingDelete(undefined);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  const currentTask = detail?.task;
  const activeTasks = tasks.filter((value) => value.status === "active");
  const archivedTasks = tasks.filter((value) => value.status === "archived");
  const records = detail?.executions.filter(isFinished) ?? [];
  const renderTask = (value: AssistantTask) => {
    return (
      <TactileListRow key={value.id} surfaceVariant="card" disabled={busy} style={styles.row}>
        <TactilePressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => openTask(value.id)}
          scaleTo={1}
          style={styles.cardBodyHit}
          faceStyle={styles.cardBody}
          stateFill={false}
          variant="plain"
        >
          <Text style={styles.name}>{value.title}</Text>
          <Text style={styles.meta}>{scheduleLabel(value)}</Text>
        </TactilePressable>
        <View
          collapsable={false}
          style={styles.menuSlot}
          ref={(node) => {
            if (node) anchors.current.set(value.id, node);
            else anchors.current.delete(value.id);
          }}
        >
          <TactilePressable
            accessibilityRole="button"
            accessibilityLabel={t("tasks.menu", { title: value.title })}
            accessibilityHint={t("tasks.menuHint")}
            accessibilityState={{ expanded: menu?.task.id === value.id }}
            disabled={busy}
            onPress={() => openMenu(value)}
            scaleTo={0.94}
            style={styles.menuHit}
            faceStyle={styles.menuFace}
            stateFill={false}
            variant="plain"
            testID="task-item-menu-button"
          >
            <MoreVertical size={20} strokeWidth={1.8} color={colors.muted} />
          </TactilePressable>
        </View>
      </TactileListRow>
    );
  };
  const renderSection = (
    key: "active" | "archived",
    label: string,
    values: AssistantTask[],
  ) => {
    const expanded = openSections[key];
    return (
      <View key={key} style={styles.sectionGroup}>
        <TactilePressable
          accessibilityHint={t(expanded ? "tasks.collapse" : "tasks.expand", { label })}
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => toggleSection(key)}
          scaleTo={1}
          style={styles.sectionHit}
          faceStyle={styles.sectionHeader}
          variant="plain"
        >
          <Text style={styles.section}>{label}</Text>
          {expanded ? (
            <ChevronDown size={16} color={colors.muted} />
          ) : (
            <ChevronUp size={16} color={colors.muted} />
          )}
        </TactilePressable>
        {expanded && !!values.length && (
          <View style={styles.sectionTasks}>{values.map(renderTask)}</View>
        )}
      </View>
    );
  };

  return (
    <Screen testID="tasks-screen" topInset={topInset} bottomInset={bottomInset}>
      <ScreenHeader
        title={currentTask?.title ?? t("tasks.title")}
        action={
          selected ? (
            <TextButton label={t("tasks.back")} onPress={() => openTask()}>
              <Text style={styles.backText}>{t("tasks.back")}</Text>
            </TextButton>
          ) : undefined
        }
      />
      {!!error && <ErrorNotice message={error} actionLabel={t("tasks.reload")} onAction={reload} busy={loading}
        testID="tasks-load-error" />}
      {loading && (
        <ActivityIndicator
          accessibilityLabel={t("tasks.loading")}
          color={colors.muted}
        />
      )}

      {!selected && (!loading || tasks.length > 0) && (
        <>
          {renderSection("active", t("tasks.active"), activeTasks)}
          {renderSection("archived", t("tasks.archived"), archivedTasks)}
          {!error && !activeTasks.length && !archivedTasks.length && (
            <Text style={styles.empty}>
              {t("tasks.empty")}
            </Text>
          )}
        </>
      )}

      {currentTask && (
        <>
          <ScreenCard>
            <MarkdownContent content={currentTask.prompt} />
            <Text style={styles.meta}>{scheduleLabel(currentTask)}</Text>
          </ScreenCard>

          {!!records.length && <Text style={styles.section}>{t("tasks.records")}</Text>}
          {!!records.length && (
            <View style={styles.timeline}>
              {records.map((run, index) => {
                const content = (
                  <>
                    <View style={styles.entryHeader}>
                      <Text style={styles.meta}>{dayTime(run.startedAt, language)}</Text>
                      <View style={styles.entryMeta}>
                        {run.status !== "completed" && (
                          <Text
                            style={[
                              styles.meta,
                              run.status === "failed" && styles.error,
                            ]}
                          >
                            {t(statusKeys[run.status])}
                          </Text>
                        )}
                      </View>
                    </View>
                    {run.preview ? (
                      <Text numberOfLines={2} style={styles.preview}>
                        {run.preview}
                      </Text>
                    ) : run.status === "completed" ? (
                      <Text style={styles.meta}>{t("tasks.noAnswer")}</Text>
                    ) : null}
                  </>
                );
                return (
                  <View key={run.id} style={styles.timelineRow}>
                    <View style={styles.rail}>
                      <View style={styles.dot} />
                      {index < records.length - 1 && (
                        <View style={styles.railLine} />
                      )}
                    </View>
                    <View
                      style={[
                        styles.timelineBody,
                        index === records.length - 1 && styles.timelineBodyLast,
                      ]}
                    >
                      <TactilePressable
                        accessibilityHint={t("tasks.readHint")}
                        accessibilityLabel={t("tasks.read", { time: dayTime(run.startedAt, language), status: t(statusKeys[run.status]) })}
                        accessibilityRole="button"
                        onPress={() => onPreviewExecution({ taskId: currentTask.id, executionId: run.id })}
                        scaleTo={1}
                        style={styles.entryHit}
                        faceStyle={styles.entry}
                        variant="plain"
                        testID="task-execution-row"
                      >
                        {content}
                      </TactilePressable>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          {!records.length && (
            <Text style={styles.empty}>{t("tasks.noRecords")}</Text>
          )}
        </>
      )}

      <Modal
        transparent
        visible={!!menu || !!pendingDelete}
        animationType="fade"
        onRequestClose={() => { if (!pendingDelete) setMenu(undefined); }}
      >
        {pendingDelete ? (
          <ConfirmationDialogContent
            title={t("tasks.deleteTitle", { title: pendingDelete.title })}
            message={t("tasks.deleteMessage")}
            onCancel={() => { setPendingDelete(undefined); clearDeleteError(); }}
            onConfirm={() => void remove()}
            busy={deleting || busy}
            error={deleteError}
            testID="task-delete-dialog"
          />
        ) : menu ? (
          <AnchoredMenuContent
            left={menu.left}
            top={menu.top}
            width={176}
            closeLabel={t("tasks.closeMenu")}
            onClose={() => setMenu(undefined)}
            testID="task-item-menu"
            actions={[
              ...(menu.task.status === "active" ? [{
                id: "run",
                label: t("tasks.run"),
                accessibilityLabel: t("tasks.runNamed", { title: menu.task.title }),
                hint: t("tasks.runHint"),
                icon: <Play size={18} strokeWidth={1.8} color={colors.text} />,
                disabled: busy || menu.task.latest?.status === "running",
                onPress: () => { setMenu(undefined); void runTask(menu.task); },
              }] : []),
              {
                id: menu.task.status === "archived" ? "restore" : "archive",
                label: t(menu.task.status === "archived" ? "tasks.restore" : "tasks.archive"),
                accessibilityLabel: t(menu.task.status === "archived" ? "tasks.restoreNamed" : "tasks.archiveNamed", { title: menu.task.title }),
                hint: t(menu.task.status === "archived" ? "tasks.restoreHint" : "tasks.archiveHint"),
                icon: menu.task.status === "archived"
                  ? <ArchiveRestore size={18} strokeWidth={1.8} color={colors.text} />
                  : <Archive size={18} strokeWidth={1.8} color={colors.text} />,
                disabled: busy || (menu.task.status === "active" && menu.task.latest?.status === "running"),
                onPress: () => { setMenu(undefined); void toggleArchive(menu.task); },
              },
              {
                id: "delete",
                label: t("common.delete"),
                accessibilityLabel: t("tasks.deleteNamed", { title: menu.task.title }),
                hint: t(menu.task.latest?.status === "running" ? "tasks.stopFirst" : "tasks.deleteHint"),
                icon: <Trash2 size={18} strokeWidth={1.8} color={colors.danger} />,
                destructive: true,
                disabled: busy || menu.task.latest?.status === "running",
                onPress: () => confirmDelete(menu.task),
              },
            ]}
          />
        ) : null}
      </Modal>
    </Screen>
  );
}

function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
  backText: { fontSize: 14, color: colors.text },
  row: { flexDirection: "row", alignItems: "stretch", gap: 0 },
  entryHit: { width: "100%" },
  entry: {
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 10,
    padding: 4,
    borderRadius: radii.control,
  },
  timeline: { marginTop: 2 },
  timelineRow: { flexDirection: "row", gap: 12 },
  rail: { width: 10, alignItems: "center" },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    marginTop: 10,
    backgroundColor: colors.lineStrong,
  },
  railLine: { flex: 1, width: 1, marginTop: 4, backgroundColor: colors.line },
  timelineBody: { flex: 1, paddingBottom: 18 },
  timelineBodyLast: { paddingBottom: 0 },
  entryMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardBodyHit: { flex: 1, minWidth: 0, alignSelf: "stretch" },
  cardBody: {
    flex: 1,
    alignSelf: "stretch",
    minHeight: 72,
    alignItems: "stretch",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopLeftRadius: radii.card,
    borderBottomLeftRadius: radii.card,
  },
  menuSlot: { width: 52, alignItems: "center", justifyContent: "center" },
  menuHit: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  menuFace: { width: controlSizes.md, height: controlSizes.md, alignSelf: "center", borderRadius: controlSizes.md / 2, alignItems: "center", justifyContent: "center" },
  sectionGroup: { gap: 12 },
  sectionTasks: { gap: 12 },
  sectionHit: { width: "100%" },
  sectionHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    borderRadius: radii.control,
  },
  section: { fontSize: 13, fontWeight: "500", color: colors.muted },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  preview: { fontSize: 14, color: colors.text, lineHeight: 21 },
  entryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  empty: { fontSize: 14, color: colors.muted, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
  });
}
