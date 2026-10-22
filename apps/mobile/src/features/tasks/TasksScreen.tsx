import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
} from "lucide-react-native";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { TaskExecution, AssistantTask } from "../../../../../shared/tasks";
import { colors } from "../../theme";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
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
    toggleSection,
  } = useTasks();
  const currentTask = detail?.task;
  const activeTasks = tasks.filter((value) => value.status === "active");
  const archivedTasks = tasks.filter((value) => value.status === "archived");
  const records = detail?.executions.filter(isFinished) ?? [];
  const renderTask = (value: AssistantTask) => {
    const archived = value.status === "archived";
    return (
      <ScreenCard key={value.id} style={styles.row}>
        <TactilePressable
          accessibilityLabel={archived ? "恢复任务" : "归档任务"}
          accessibilityHint={
            archived
              ? "恢复任务和未来调度，不立即执行"
              : "停止未来调度，保留任务和执行记录"
          }
          accessibilityRole="button"
          disabled={busy || value.latest?.status === "running"}
          hitSlop={11}
          onPress={() => toggleArchive(value)}
          scaleTo={0.9}
          style={styles.archiveHit}
          faceStyle={styles.archiveControl}
          variant="plain"
        >
          {archived ? (
            <ArchiveRestore size={18} strokeWidth={1.8} color={colors.muted} />
          ) : (
            <Archive size={18} strokeWidth={1.8} color={colors.muted} />
          )}
        </TactilePressable>
        <TactilePressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => openTask(value.id)}
          scaleTo={1}
          style={styles.cardBodyHit}
          faceStyle={styles.cardBody}
          variant="plain"
        >
          <Text style={styles.name}>{value.title}</Text>
          <Text style={styles.meta}>{scheduleLabel(value)}</Text>
        </TactilePressable>
      </ScreenCard>
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
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {loading && (
        <ActivityIndicator
          accessibilityLabel="正在加载"
          color={colors.blueDark}
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
            <Text style={styles.body}>{currentTask.prompt}</Text>
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
                        {expandable && (
                          <ChevronDown
                            size={15}
                            color={colors.muted}
                            style={expanded ? styles.chevronOpen : undefined}
                          />
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  backText: { fontSize: 14, color: colors.text },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  entryHit: { width: "100%" },
  entry: {
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 10,
    padding: 4,
    borderRadius: 12,
  },
  timeline: { marginTop: 2 },
  timelineRow: { flexDirection: "row", gap: 12 },
  rail: { width: 10, alignItems: "center" },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 10,
    backgroundColor: "#C4C9CC",
  },
  railLine: { flex: 1, width: 1, marginTop: 4, backgroundColor: colors.line },
  timelineBody: { flex: 1, paddingBottom: 18 },
  timelineBodyLast: { paddingBottom: 0 },
  entryMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  cardBodyHit: { flex: 1 },
  cardBody: {
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 8,
    padding: 4,
    margin: -4,
    borderRadius: 12,
  },
  archiveHit: { width: 22, height: 22, marginTop: 2 },
  archiveControl: {
    width: 22,
    height: 22,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionGroup: { gap: 12 },
  sectionTasks: { gap: 12 },
  sectionHit: { width: "100%" },
  sectionHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  section: { fontSize: 13, fontWeight: "500", color: colors.muted },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
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
