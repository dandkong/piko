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
        setDetail(current?.item.status === "archived" ? undefined : current);
        if (current?.item.status === "archived") setSelected(undefined);
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
  const archive = (item: WorkItem) => {
    if (item.status === "archived") return;
    void send({ action: "status", id: item.id, status: "archived" });
  };

  const item = detail?.item;
  const visibleItems = items.filter(value => value.status !== "archived");
  const records = detail?.executions.filter(isFinished) ?? [];

  return <Screen testID="tasks-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title={item?.title ?? "任务"} action={selected
      ? <TextButton label="返回" onPress={() => openItem()}><Text style={styles.backText}>返回</Text></TextButton>
      : undefined} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {loading && <ActivityIndicator accessibilityLabel="正在加载" color={colors.blueDark} />}

    {!selected && !loading && !visibleItems.length && <Text style={styles.empty}>还没有任务。在聊天里告诉 Piko 你想让它做什么。</Text>}
    {!selected && visibleItems.map(value => <ScreenCard key={value.id} style={styles.row}>
      <TactilePressable
        accessibilityLabel="归档"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
        disabled={busy || value.latest?.status === "running"}
        hitSlop={11}
        onPress={() => archive(value)}
        scaleTo={0.9}
        style={styles.checkHit}
        faceStyle={styles.check}
        variant="plain"
      />
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
    </ScreenCard>)}

    {item && <>
      <ScreenCard>
        <Text style={styles.body}>{item.prompt}</Text>
        <Text style={styles.meta}>{scheduleLabel(item)}</Text>
      </ScreenCard>

      {records.map(run => <ScreenCard key={run.id}>
        <TactilePressable
          accessibilityRole="button"
          onPress={() => toggle(run)}
          scaleTo={1}
          style={styles.entryHit}
          faceStyle={styles.entry}
          variant="plain"
        >
          <View style={styles.entryHeader}>
            <Text style={styles.meta}>{dayTime(run.startedAt)}</Text>
            {run.status !== "completed" && <Text style={[styles.meta, run.status === "failed" && styles.error]}>{statusNames[run.status]}</Text>}
          </View>
          {open === run.id
            ? answers[run.id] === undefined ? <Text style={styles.meta}>正在加载…</Text>
              : answers[run.id] ? <AssistantMessage content={answers[run.id]} />
                : <Text style={styles.meta}>没有回答。</Text>
            : <Text numberOfLines={2} style={styles.preview}>{run.preview ?? (run.status === "completed" ? "没有回答。" : statusNames[run.status])}</Text>}
        </TactilePressable>
      </ScreenCard>)}
      {!records.length && <Text style={styles.empty}>还没有记录。</Text>}
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  backText: { fontSize: 14, color: colors.text },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  entryHit: { width: "100%" },
  entry: { alignItems: "stretch", justifyContent: "flex-start", gap: 10, padding: 4, margin: -4, borderRadius: 12 },
  cardBodyHit: { flex: 1 },
  cardBody: { alignItems: "stretch", justifyContent: "flex-start", gap: 8, padding: 4, margin: -4, borderRadius: 12 },
  checkHit: { width: 22, height: 22, marginTop: 2 },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: "#C4C9CC", alignItems: "center", justifyContent: "center" },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  preview: { fontSize: 14, color: colors.text, lineHeight: 21 },
  entryHeader: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  empty: { fontSize: 14, color: colors.muted, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
});
