import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ItemExecution, WorkItem, WorkItemCommand, WorkItemDetail } from "../../../../../shared/work-items";
import { colors } from "../../theme";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { AssistantMessage } from "../chat/AssistantMessage";
import { loadExecution, loadItem, loadItems, sendCommand } from "./api";

type Command = WorkItemCommand extends infer T ? T extends WorkItemCommand ? Omit<T, "requestId"> : never : never;
type FinishedExecution = ItemExecution & { status: Exclude<ItemExecution["status"], "running"> };
const isFinished = (run: ItemExecution): run is FinishedExecution => run.status !== "running";
const dayTime = (value: number | string) => new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const statusNames: Record<FinishedExecution["status"], string> = { completed: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断" };
const scheduleLabel = (item: WorkItem) => item.scheduleText ?? (!item.schedule ? "手动" : item.schedule.type === "once" ? dayTime(item.schedule.at) : "定期");

/** The assistant's standing commitments: the task list stays lean, and detail shows finished records. */
export function TasksScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<WorkItemDetail>();
  const [open, setOpen] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [openSections, setOpenSections] = useState({ active: true, completed: false });
  const mounted = useRef(true);
  const sending = useRef(false);
  const pending = useRef<{ signature: string; command: WorkItemCommand } | undefined>(undefined);
  const selection = useRef(selected);
  selection.current = selected;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void (async () => {
      try {
        const [list, current] = await Promise.all([loadItems(controller.signal), selected ? loadItem(selected, controller.signal) : undefined]);
        if (!active) return;
        setItems(list.items);
        setDetail(current);
        setError("");
      } catch { if (active) setError("暂时加载不了任务。"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [selected, refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", value => { if (value === "active") setRefresh(count => count + 1); });
    return () => listener.remove();
  }, []);

  const openItem = (id?: string) => { setSelected(id); setDetail(undefined); setOpen(undefined); setError(""); setLoading(Boolean(id)); };
  const showAnswer = useCallback(async (execution: ItemExecution) => {
    const item = selection.current;
    if (!item || answers[execution.id] !== undefined) return;
    try {
      const result = await loadExecution(item, execution.id);
      if (selection.current === item) setAnswers(previous => ({ ...previous, [execution.id]: result.answer }));
    } catch { if (selection.current === item) setError("暂时加载不了这次记录。"); }
  }, [answers]);
  const toggle = (execution: ItemExecution) => {
    const next = open === execution.id ? undefined : execution.id;
    setOpen(next);
    if (next) void showAnswer(execution);
  };

  const send = async (body: Command) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, command: { ...body, requestId: randomUUID() } as WorkItemCommand };
    try {
      await sendCommand(pending.current.command);
      if (!mounted.current) return;
      pending.current = undefined;
      setRefresh(count => count + 1);
    } catch { if (mounted.current) setError("操作没有成功，请稍后再试。"); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const toggleDone = (entry: WorkItem) => {
    void send({ action: "status", id: entry.id, status: entry.status === "archived" ? "active" : "archived" });
  };
  const toggleSection = (section: "active" | "completed") => {
    setOpenSections(value => ({ ...value, [section]: !value[section] }));
  };

  const item = detail?.item;
  const activeItems = items.filter(value => value.status === "active");
  const completedItems = items.filter(value => value.status === "archived");
  const records = detail?.executions.filter(isFinished) ?? [];
  const renderItem = (value: WorkItem) => {
    const completed = value.status === "archived";
    return <ScreenCard key={value.id} style={styles.row}>
      <TactilePressable
        accessibilityLabel={completed ? "标记为未完成" : "标记为已完成"}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: completed }}
        disabled={busy || value.latest?.status === "running"}
        hitSlop={11}
        onPress={() => toggleDone(value)}
        scaleTo={0.9}
        selected={completed}
        style={styles.checkHit}
        faceStyle={[styles.check, completed && styles.checkSelected]}
        variant="plain"
      >
        {completed && <Check size={14} strokeWidth={2.5} color={colors.text} />}
      </TactilePressable>
      <TactilePressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => openItem(value.id)}
        scaleTo={1}
        style={styles.cardBodyHit}
        faceStyle={styles.cardBody}
        variant="plain"
      >
        <Text style={styles.name}>{value.title}</Text>
        <Text style={styles.meta}>{scheduleLabel(value)}</Text>
      </TactilePressable>
    </ScreenCard>;
  };
  const renderSection = (key: "active" | "completed", label: string, values: WorkItem[]) => {
    const expanded = openSections[key];
    return <View key={key} style={styles.sectionGroup}>
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
        {expanded ? <ChevronDown size={16} color={colors.muted} /> : <ChevronUp size={16} color={colors.muted} />}
      </TactilePressable>
      {expanded && !!values.length && <View style={styles.sectionItems}>{values.map(renderItem)}</View>}
    </View>;
  };

  return <Screen testID="tasks-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title={item?.title ?? "任务"} action={selected
      ? <TextButton label="返回" onPress={() => openItem()}><Text style={styles.backText}>返回</Text></TextButton>
      : undefined} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {loading && <ActivityIndicator accessibilityLabel="正在加载" color={colors.blueDark} />}

    {!selected && !loading && <>
      {renderSection("active", "进行中", activeItems)}
      {renderSection("completed", "已完成", completedItems)}
      {!activeItems.length && !completedItems.length && <Text style={styles.empty}>还没有任务。在聊天里告诉 Piko 你想让它做什么。</Text>}
    </>}

    {item && <>
      <ScreenCard>
        <Text style={styles.body}>{item.prompt}</Text>
        <Text style={styles.meta}>{scheduleLabel(item)}</Text>
      </ScreenCard>

      {!!records.length && <View style={styles.timeline}>
        {records.map((run, index) => {
          const expanded = open === run.id;
          const expandable = !!run.preview;
          const content = <>
            <View style={styles.entryHeader}>
              <Text style={styles.meta}>{dayTime(run.startedAt)}</Text>
              <View style={styles.entryMeta}>
                {run.status !== "completed" && <Text style={[styles.meta, run.status === "failed" && styles.error]}>{statusNames[run.status]}</Text>}
                {expandable && <ChevronDown size={15} color={colors.muted} style={expanded ? styles.chevronOpen : undefined} />}
              </View>
            </View>
            {expanded
              ? answers[run.id] === undefined ? <Text style={styles.meta}>正在加载…</Text>
                : answers[run.id] ? <AssistantMessage content={answers[run.id]} />
                  : <Text style={styles.meta}>没有回答。</Text>
              : run.preview ? <Text numberOfLines={2} style={styles.preview}>{run.preview}</Text>
                : run.status === "completed" ? <Text style={styles.meta}>没有回答。</Text> : null}
          </>;
          return <View key={run.id} style={styles.timelineRow}>
            <View style={styles.rail}>
              <View style={styles.dot} />
              {index < records.length - 1 && <View style={styles.railLine} />}
            </View>
            <View style={[styles.timelineBody, index === records.length - 1 && styles.timelineBodyLast]}>
              {expandable
                ? <TactilePressable
                  accessibilityHint={expanded ? "收起记录" : "展开记录"}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => toggle(run)}
                  scaleTo={1}
                  style={styles.entryHit}
                  faceStyle={styles.entry}
                  variant="plain"
                >{content}</TactilePressable>
                : <View style={styles.entry}>{content}</View>}
            </View>
          </View>;
        })}
      </View>}
      {!records.length && <Text style={styles.empty}>还没有记录。</Text>}
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  backText: { fontSize: 14, color: colors.text },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  entryHit: { width: "100%" },
  entry: { alignItems: "stretch", justifyContent: "flex-start", gap: 10, padding: 4, borderRadius: 12 },
  timeline: { marginTop: 2 },
  timelineRow: { flexDirection: "row", gap: 12 },
  rail: { width: 10, alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 10, backgroundColor: "#C4C9CC" },
  railLine: { flex: 1, width: 1, marginTop: 4, backgroundColor: colors.line },
  timelineBody: { flex: 1, paddingBottom: 18 },
  timelineBodyLast: { paddingBottom: 0 },
  entryMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  cardBodyHit: { flex: 1 },
  cardBody: { alignItems: "stretch", justifyContent: "flex-start", gap: 8, padding: 4, margin: -4, borderRadius: 12 },
  checkHit: { width: 22, height: 22, marginTop: 2 },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: "#C4C9CC", alignItems: "center", justifyContent: "center" },
  checkSelected: { borderColor: colors.muted },
  sectionGroup: { gap: 12 },
  sectionItems: { gap: 12 },
  sectionHit: { width: "100%" },
  sectionHeader: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, borderRadius: 12 },
  section: { fontSize: 13, fontWeight: "500", color: colors.muted },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  preview: { fontSize: 14, color: colors.text, lineHeight: 21 },
  entryHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  empty: { fontSize: 14, color: colors.muted, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
});
