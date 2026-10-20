import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ItemExecution, WorkItem, WorkItemCommand, WorkItemDetail } from "../../../../../shared/work-items";
import { colors } from "../../theme";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { AssistantMessage } from "../chat/AssistantMessage";
import { loadExecution, loadItem, loadItems, sendCommand } from "./api";

type Command = WorkItemCommand extends infer T ? T extends WorkItemCommand ? Omit<T, "requestId"> : never : never;
const dayTime = (value: number) => new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const statusNames = { running: "正在做", completed: "已完成", failed: "失败", stopped: "已停止", interrupted: "被重启打断" };
const scheduleLabel = (item: WorkItem) => item.scheduleText ?? (!item.schedule ? "手动" : item.schedule.type === "once" ? dayTime(item.schedule.at) : "定期");

/** The assistant's standing commitments: what it will do, when, and how the last run went. */
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
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "暂时读不到任务。"); }
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
    } catch (failure) { if (selection.current === item) setError(failure instanceof Error ? failure.message : "暂时读不到这次结果。"); }
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
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "操作没有成功。"); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const archive = (item: WorkItem) => {
    if (item.status === "archived") return;
    void send({ action: "status", id: item.id, revision: item.revision, status: "archived" });
  };

  const item = detail?.item;
  const visibleItems = items.filter(value => value.status !== "archived");

  return <Screen testID="tasks-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title={item?.title ?? "任务"} action={selected
      ? <Pressable accessibilityRole="button" onPress={() => openItem()} style={styles.back}><Text style={styles.backText}>返回</Text></Pressable>
      : undefined} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {loading && <ActivityIndicator accessibilityLabel="正在加载" color={colors.blueDark} />}

    {!selected && !loading && !visibleItems.length && <Text style={styles.empty}>目前没有未归档的事项。在聊天里告诉 Piko 你想让它定期做什么，比如“每天早上帮我整理一下昨天的工作”。</Text>}
    {!selected && visibleItems.map(value => <ScreenCard key={value.id} style={styles.row}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: false, disabled: busy || value.latest?.status === "running" }}
        accessibilityLabel="归档" disabled={busy || value.latest?.status === "running"}
        onPress={() => archive(value)} style={styles.check} />
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => openItem(value.id)} style={styles.cardBody}>
        <Text style={styles.name}>{value.title}</Text>
        <Text style={styles.meta}>{scheduleLabel(value)}</Text>
        {value.latest && <Text numberOfLines={2} style={[styles.preview, value.latest.status === "failed" && styles.error]}>
          {value.latest.status === "completed" ? value.latest.preview ?? "上次已完成" : statusNames[value.latest.status]}
        </Text>}
      </Pressable>
    </ScreenCard>)}

    {item && <>
      <ScreenCard>
        <Text style={styles.body}>{item.prompt}</Text>
        <Text style={styles.meta}>{scheduleLabel(item)}{item.nextDueAt !== null ? ` · 下次 ${dayTime(item.nextDueAt)}` : ""}</Text>
      </ScreenCard>

      {detail.executions.map(run => <ScreenCard key={run.id}>
        <Pressable accessibilityRole="button" onPress={() => toggle(run)} style={styles.entry}>
          <View style={styles.entryHeader}>
            <Text style={styles.meta}>{dayTime(run.startedAt)}</Text>
            {run.status !== "completed" && <Text style={[styles.meta, run.status === "failed" && styles.error]}>{statusNames[run.status]}</Text>}
          </View>
          {open === run.id
            ? <>{answers[run.id] === undefined ? <Text style={styles.meta}>正在读取…</Text> : answers[run.id] ? <AssistantMessage content={answers[run.id]} /> : <Text style={styles.meta}>这次没有留下回答。</Text>}
              {!!run.error && <Text style={styles.error}>{run.error}</Text>}</>
            : <Text numberOfLines={2} style={styles.preview}>{run.preview ?? (run.status === "running" ? "正在做…" : statusNames[run.status])}</Text>}
        </Pressable>
      </ScreenCard>)}
      {!detail.executions.length && <Text style={styles.empty}>还没做过。任务存在不代表已经执行过。</Text>}
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  back: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#F3F4F5" },
  backText: { fontSize: 13, color: colors.text },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  entry: { gap: 10 },
  cardBody: { flex: 1, gap: 8 },
  check: { width: 22, height: 22, marginTop: 2, borderRadius: 7, borderWidth: 1.5, borderColor: "#C4C9CC", alignItems: "center", justifyContent: "center" },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  preview: { fontSize: 14, color: colors.text, lineHeight: 21 },
  entryHeader: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  empty: { fontSize: 14, color: colors.muted, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
});
