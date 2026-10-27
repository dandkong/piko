import { useEffect, useRef, useState } from "react";
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
import { colors, controlSizes, radii } from "../../theme";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { TactileListRow } from "../../components/TactileListRow";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { AssistantMessage } from "../chat/AssistantMessage";
import { useTasks } from "./useTasks";

type FinishedExecution = TaskExecution & {
  status: Exclude<TaskExecution["status"], "running">;
};
const isFinished = (run: TaskExecution): run is FinishedExecution =>
  run.status !== "running";
const dayTime = (value: number | string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const statusNames: Record<FinishedExecution["status"], string> = {
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};
const scheduleLabel = (task: AssistantTask) => task.scheduleText;
type MenuState = { task: AssistantTask; left: number; top: number };

/** The assistant's standing commitments: the task list stays lean, and detail shows finished records. */
export function TasksScreen({
  topInset,
  bottomInset,
}: {
  topInset: number;
  bottomInset: number;
}) {
  const {
    tasks,
    selected,
    detail,
    open,
    answers,
    loading,
    busy,
    error,
    openSections,
    openTask,
    toggle,
    toggleArchive,
    runTask,
    deleteTask,
    clearError,
    toggleSection,
  } = useTasks();
  const [menu, setMenu] = useState<MenuState>();
  const [pendingDelete, setPendingDelete] = useState<AssistantTask>();
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const anchors = useRef(new Map<string, View>());
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
    clearError();
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
            accessibilityLabel={`更多任务操作：${value.title}`}
            accessibilityHint="执行、归档或删除任务"
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
          accessibilityHint={expanded ? `收起${label}` : `展开${label}`}
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
        title={currentTask?.title ?? "任务"}
        action={
          selected ? (
            <TextButton label="返回" onPress={() => openTask()}>
              <Text style={styles.backText}>返回</Text>
            </TextButton>
          ) : undefined
        }
      />
      {!!error && !pendingDelete && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {loading && (
        <ActivityIndicator
          accessibilityLabel="正在加载"
          color={colors.muted}
        />
      )}

      {!selected && !loading && (
        <>
          {renderSection("active", "进行中", activeTasks)}
          {renderSection("archived", "已归档", archivedTasks)}
          {!activeTasks.length && !archivedTasks.length && (
            <Text style={styles.empty}>
              还没有任务。在聊天里告诉 Piko 你想让它做什么。
            </Text>
          )}
        </>
      )}

      {currentTask && (
        <>
          <ScreenCard>
            <AssistantMessage content={currentTask.prompt} />
            <Text style={styles.meta}>{scheduleLabel(currentTask)}</Text>
          </ScreenCard>

          {!!records.length && <Text style={styles.section}>执行记录</Text>}
          {!!records.length && (
            <View style={styles.timeline}>
              {records.map((run, index) => {
                const expanded = open === run.id;
                const expandable = !!run.preview;
                const content = (
                  <>
                    <View style={styles.entryHeader}>
                      <Text style={styles.meta}>{dayTime(run.startedAt)}</Text>
                      <View style={styles.entryMeta}>
                        {run.status !== "completed" && (
                          <Text
                            style={[
                              styles.meta,
                              run.status === "failed" && styles.error,
                            ]}
                          >
                            {statusNames[run.status]}
                          </Text>
                        )}
                      </View>
                    </View>
                    {expanded ? (
                      answers[run.id] === undefined ? (
                        <Text style={styles.meta}>正在加载…</Text>
                      ) : answers[run.id] ? (
                        <AssistantMessage content={answers[run.id]} />
                      ) : (
                        <Text style={styles.meta}>没有回答。</Text>
                      )
                    ) : run.preview ? (
                      <Text numberOfLines={2} style={styles.preview}>
                        {run.preview}
                      </Text>
                    ) : run.status === "completed" ? (
                      <Text style={styles.meta}>没有回答。</Text>
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
                      {expandable ? (
                        <TactilePressable
                          accessibilityHint={
                            expanded ? "收起运行结果" : "展开运行结果"
                          }
                          accessibilityRole="button"
                          accessibilityState={{ expanded }}
                          onPress={() => toggle(run)}
                          scaleTo={1}
                          style={styles.entryHit}
                          faceStyle={styles.entry}
                          variant="plain"
                        >
                          {content}
                        </TactilePressable>
                      ) : (
                        <View style={styles.entry}>{content}</View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          {!records.length && (
            <Text style={styles.empty}>还没有执行记录。</Text>
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
            title={`删除「${pendingDelete.title}」？`}
            message="将永久删除任务定义、全部执行记录和专属工作区，无法恢复。"
            onCancel={() => setPendingDelete(undefined)}
            onConfirm={() => void remove()}
            confirmLabel="删除"
            cancelLabel="取消"
            busyLabel="删除中…"
            busy={deleting || busy}
            error={error}
            testID="task-delete-dialog"
          />
        ) : menu ? (
          <AnchoredMenuContent
            left={menu.left}
            top={menu.top}
            width={176}
            closeLabel="关闭任务菜单"
            onClose={() => setMenu(undefined)}
            testID="task-item-menu"
            actions={[
              ...(menu.task.status === "active" ? [{
                id: "run",
                label: "执行",
                accessibilityLabel: `立即执行任务：${menu.task.title}`,
                hint: "立即运行一次，不更改未来调度",
                icon: <Play size={18} strokeWidth={1.8} color={colors.text} />,
                disabled: busy || menu.task.latest?.status === "running",
                onPress: () => { setMenu(undefined); void runTask(menu.task); },
              }] : []),
              {
                id: menu.task.status === "archived" ? "restore" : "archive",
                label: menu.task.status === "archived" ? "恢复" : "归档",
                accessibilityLabel: menu.task.status === "archived" ? `恢复任务：${menu.task.title}` : `归档任务：${menu.task.title}`,
                hint: menu.task.status === "archived" ? "重新启用未来调度，不立即执行" : "停止未来调度，保留任务和执行记录",
                icon: menu.task.status === "archived"
                  ? <ArchiveRestore size={18} strokeWidth={1.8} color={colors.text} />
                  : <Archive size={18} strokeWidth={1.8} color={colors.text} />,
                disabled: busy || (menu.task.status === "active" && menu.task.latest?.status === "running"),
                onPress: () => { setMenu(undefined); void toggleArchive(menu.task); },
              },
              {
                id: "delete",
                label: "删除",
                accessibilityLabel: `删除任务：${menu.task.title}`,
                hint: menu.task.latest?.status === "running" ? "请先停止当前执行" : "永久删除任务及其执行记录和专属工作区",
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

const styles = StyleSheet.create({
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
