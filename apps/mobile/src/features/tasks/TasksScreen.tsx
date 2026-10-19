import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ItemExecutionDetail, ItemFile, WorkItem, WorkItemCommand, WorkItemDetail, WorkItemDraft } from "../../../../../shared/work-items";
import { colors } from "../../theme";
import { AssistantMessage } from "../chat/AssistantMessage";
import { loadExecution, loadItem, loadItems, loadOutput, sendCommand } from "./api";

type Command = WorkItemCommand extends infer T ? T extends WorkItemCommand ? Omit<T, "requestId"> : never : never;
const date = (value: number) => new Date(value).toLocaleString();
const statusNames = { running: "执行中", completed: "已完成回答", failed: "失败", stopped: "已停止", interrupted: "重启中断" };
function scheduleText(item: WorkItem) {
  if (!item.schedule) return "手动执行";
  if (item.schedule.type === "once") return `一次性 · ${date(item.schedule.at)}`;
  return `${item.schedule.expression} · ${item.schedule.timezone}`;
}
function Button({ title, onPress, disabled = false, subtle = false }: { title: string; onPress: () => void; disabled?: boolean; subtle?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, subtle && styles.subtle, disabled && { opacity: 0.45 }]}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}
function ItemEditor({ item, busy, onSave, onCancel }: { item?: WorkItem; busy: boolean; onSave: (value: WorkItemDraft) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(item?.title ?? ""); const [prompt, setPrompt] = useState(item?.prompt ?? "");
  const rule = item?.schedule;
  const [mode, setMode] = useState<"manual" | "once" | "daily" | "cron">(!rule ? "manual" : rule.type);
  const [at, setAt] = useState(rule?.type === "once" ? new Date(rule.at).toISOString() : "");
  const [cron, setCron] = useState(rule?.type === "cron" ? rule.expression : "0 9 * * *");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(rule?.type === "cron" ? rule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [error, setError] = useState("");
  const save = () => {
    setError("");
    if (!title.trim() || !prompt.trim()) { setError("请填写标题和 Prompt。"); return; }
    if (mode === "once" && (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(at) || !Number.isFinite(Date.parse(at)))) { setError("请填写带时区的 ISO 时间，例如 2026-10-20T09:00:00+08:00。"); return; }
    if (mode === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { setError("每日时间请使用 HH:mm。"); return; }
    const [hour, minute] = time.split(":").map(Number);
    onSave({ title: title.trim(), prompt: prompt.trim(), schedule: mode === "manual" ? null : mode === "once" ? { type: "once", at: Date.parse(at) }
      : { type: "cron", expression: mode === "daily" ? `${minute} ${hour} * * *` : cron, timezone } });
  };
  return <View style={styles.card}>
    <Text style={styles.heading}>{item ? "编辑事项" : "新建事项"}</Text>
    <Text style={styles.label}>标题</Text><TextInput accessibilityLabel="事项标题" value={title} onChangeText={setTitle} editable={!busy} maxLength={160} style={styles.input} />
    <Text style={styles.label}>Prompt</Text><TextInput accessibilityLabel="事项 Prompt" value={prompt} onChangeText={setPrompt} editable={!busy} multiline maxLength={12000} style={[styles.input, styles.prompt]} />
    <Text style={styles.label}>时间规则</Text>
    <View style={styles.row}>{([['manual', '手动'], ['once', '一次性'], ['daily', '每天'], ['cron', 'Cron']] as const).map(([value, label]) =>
      <Button key={value} title={`${mode === value ? "✓ " : ""}${label}`} subtle={mode !== value} disabled={busy} onPress={() => setMode(value)} />)}</View>
    {mode === "once" && <><Text style={styles.note}>ISO 时间，必须包含 Z 或时区偏移；已过期的一次性时间会补执行。</Text><TextInput accessibilityLabel="一次性执行时间" value={at} onChangeText={setAt} editable={!busy} placeholder="2026-10-20T09:00:00+08:00" style={styles.input} autoCapitalize="none" /></>}
    {mode === "daily" && <TextInput accessibilityLabel="每日执行时间" value={time} onChangeText={setTime} editable={!busy} placeholder="09:00" style={styles.input} />}
    {mode === "cron" && <TextInput accessibilityLabel="Cron 表达式" value={cron} onChangeText={setCron} editable={!busy} placeholder="0 9 * * *" style={styles.input} autoCapitalize="none" />}
    {(mode === "cron" || mode === "daily") && <><Text style={styles.label}>时区</Text><TextInput accessibilityLabel="执行时区" value={timezone} onChangeText={setTimezone} editable={!busy} placeholder="Asia/Shanghai" style={styles.input} autoCapitalize="none" /></>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.row}><Button title="保存" onPress={save} disabled={busy} /><Button title="取消" onPress={onCancel} disabled={busy} subtle /></View>
  </View>;
}

/** Only the visible Tasks page polls; returning to foreground refreshes without resubmitting work. */
export function TasksScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  const [items, setItems] = useState<WorkItem[]>([]); const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<WorkItemDetail>(); const [execution, setExecution] = useState<ItemExecutionDetail>();
  const [runId, setRunId] = useState<string>(); const [output, setOutput] = useState<ItemFile>(); const [memory, setMemory] = useState(false);
  const [editor, setEditor] = useState<{ item?: WorkItem }>(); const [older, setOlder] = useState<WorkItemDetail>();
  const [loadingOlder, setLoadingOlder] = useState(false); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [readError, setReadError] = useState("");
  const [foreground, setForeground] = useState(AppState.currentState === "active"); const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true); const sending = useRef(false);
  const selection = useRef({ item: selected, run: runId }); selection.current = { item: selected, run: runId };
  const outputRequest = useRef(0);
  const pending = useRef<{ signature: string; command: WorkItemCommand } | undefined>(undefined);
  useEffect(() => { mounted.current = true; const listener = AppState.addEventListener("change", value => setForeground(value === "active"));
    return () => { mounted.current = false; listener.remove(); }; }, []);
  useEffect(() => {
    if (!foreground) return;
    let active = true; let timer: ReturnType<typeof setTimeout>; const controller = new AbortController();
    const poll = async () => {
      try {
        const [list, next, result] = await Promise.all([loadItems(controller.signal), selected ? loadItem(selected, controller.signal) : undefined,
          selected && runId ? loadExecution(selected, runId, controller.signal) : undefined]);
        if (!active) return;
        setItems(list.items); setDetail(next); setExecution(result); setReadError("");
      } catch (error) { if (active) setReadError(error instanceof Error ? error.message : "无法加载事项。"); }
      finally { if (active) { setLoading(false); timer = setTimeout(poll, 3000); } }
    };
    void poll(); return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [foreground, selected, runId, refresh]);
  const open = (id?: string) => { setSelected(id); setDetail(undefined); setOlder(undefined); setExecution(undefined); setRunId(undefined); setOutput(undefined); setMemory(false); setEditor(undefined); setReadError(""); setLoading(true); };
  const send = async (body: Command) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, command: { ...body, requestId: randomUUID() } as WorkItemCommand };
    try {
      const receipt = await sendCommand(pending.current.command);
      if (!mounted.current) return;
      pending.current = undefined;
      if (body.action === "create") open(receipt.id);
      if (body.action === "create" || body.action === "update") setEditor(undefined);
      setRefresh(value => value + 1);
    } catch (error) { if (mounted.current) setError(`${error instanceof Error ? error.message : "请求失败。"} 可重试同一操作；不会重复接纳。`); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const item = detail?.item;
  const allExecutions = [...(detail?.executions ?? []), ...(older?.executions ?? [])].filter((run, index, values) => values.findIndex(value => value.id === run.id) === index);
  const before = older ? older.nextBefore : detail?.nextBefore;
  return <ScrollView testID="tasks-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: topInset, paddingBottom: bottomInset }]}>
    <View style={styles.row}><Text style={styles.title}>事项</Text><View style={{ flex: 1 }} />
      {selected ? <Button title="返回列表" subtle disabled={busy} onPress={() => open()} /> : <Button title="新建" disabled={busy} onPress={() => { setEditor({}); setError(""); }} />}
    </View>
    {!!(error || readError) && <View style={styles.card}><Text accessibilityRole="alert" style={styles.error}>{error || readError}</Text><Button title="刷新" subtle onPress={() => setRefresh(value => value + 1)} /></View>}
    {loading && <ActivityIndicator accessibilityLabel="加载事项" color={colors.blueDark} />}
    {editor && <ItemEditor key={editor.item?.id ?? "new"} item={editor.item} busy={busy} onCancel={() => setEditor(undefined)} onSave={value => void send(editor.item
      ? { action: "update", id: editor.item.id, revision: editor.item.revision, item: value } : { action: "create", item: value })} />}
    {!selected && !loading && !items.length && !editor && <Text style={styles.note}>还没有事项。保存一个 Prompt，可以手动执行，也可以设置时间；完成后由主 Agent 整理回复。</Text>}
    {!selected && items.map(value => <Pressable key={value.id} accessibilityRole="button" disabled={busy} onPress={() => open(value.id)} style={styles.card}>
      <Text style={styles.heading}>{value.title}</Text><Text style={styles.note}>{scheduleText(value)}</Text>
      <Text style={styles.note}>{value.status === "active" ? "启用" : value.status === "paused" ? "已暂停" : "已归档"}{value.status === "active" && value.nextDueAt !== null ? ` · 下次 ${date(value.nextDueAt)}` : ""}</Text>
      {value.latest && <Text style={[styles.note, value.latest.status === "failed" && styles.error]}>最近执行：{statusNames[value.latest.status]}{value.latest.error ? ` · ${value.latest.error}` : ""}</Text>}
    </Pressable>)}
    {item && <>
      <View style={styles.card}>
        <Text style={styles.heading}>{item.title}</Text><Text selectable style={styles.body}>{item.prompt}</Text><Text style={styles.note}>{scheduleText(item)}</Text>
        <Text style={styles.note}>{item.status === "active" ? item.nextDueAt === null ? "无待执行定时，可手动运行" : `下次 ${date(item.nextDueAt)}` : item.status === "paused" ? "已暂停自动触发" : "已归档"}</Text>
        <View style={styles.row}>
          <Button title="立即执行" disabled={busy || item.status === "archived" || item.latest?.status === "running"} onPress={() => void send({ action: "run", id: item.id })} />
          <Button title="编辑" subtle disabled={busy} onPress={() => setEditor({ item })} />
          <Button title={item.status === "active" ? "暂停" : "恢复"} subtle disabled={busy} onPress={() => void send({ action: "status", id: item.id, revision: item.revision, status: item.status === "active" ? "paused" : "active" })} />
          {item.status !== "archived" && <Button title="归档" subtle disabled={busy || item.latest?.status === "running"} onPress={() => void send({ action: "status", id: item.id, revision: item.revision, status: "archived" })} />}
        </View>
        <Button title={memory ? "收起事项记忆" : "查看事项记忆"} subtle onPress={() => setMemory(value => !value)} />
        {memory && <AssistantMessage content={detail.memory} />}
      </View>
      <Text style={styles.heading}>执行记录</Text>
      {!allExecutions.length && <Text style={styles.note}>尚未执行。定时规则存在不代表已经执行。</Text>}
      {allExecutions.map(run => <View key={run.id} style={styles.card}>
        <Text style={styles.body}>{date(run.startedAt)} · {statusNames[run.status]}</Text>
        <Text style={styles.note}>{run.scheduledAt === null ? "手动启动" : `计划时间 ${date(run.scheduledAt)}`} · Prompt v{run.revision}</Text>
        {!!run.error && <Text style={styles.error}>{run.error}</Text>}
        <View style={styles.row}><Button title={runId === run.id ? "收起结果" : "查看结果"} subtle onPress={() => { setRunId(runId === run.id ? undefined : run.id); setOutput(undefined); setExecution(undefined); }} />
          {run.status === "running" && <Button title="停止本次" disabled={busy} subtle onPress={() => void send({ action: "stop", id: item.id, executionId: run.id })} />}</View>
        {runId === run.id && execution && <>
          {!!execution.answer && <AssistantMessage content={execution.answer} />}
          {!execution.answer && <Text style={styles.note}>尚无已保存的最终回答。</Text>}
          {execution.files.map(path => <Button key={path} title={path} subtle onPress={() => {
            const selectedItem = item.id; const selectedRun = runId; const version = ++outputRequest.current;
            const current = () => mounted.current && selection.current.item === selectedItem && selection.current.run === selectedRun && outputRequest.current === version;
            void loadOutput(selectedItem, selectedRun, path).then(value => { if (current()) setOutput(value); }).catch(error => { if (current()) setError(error instanceof Error ? error.message : "无法预览文件。"); });
          }} />)}
          {output && <View style={styles.output}><Text style={styles.label}>{output.path}</Text>{/\.(md|markdown)$/i.test(output.path) ? <AssistantMessage content={output.content} /> : <Text selectable style={styles.code}>{output.content}</Text>}</View>}
        </>}
      </View>)}
      {before && <Button title={loadingOlder ? "加载中…" : "更早的执行"} subtle disabled={loadingOlder} onPress={() => {
        const selectedItem = item.id;
        const current = () => mounted.current && selection.current.item === selectedItem;
        setLoadingOlder(true); void loadItem(selectedItem, undefined, before).then(page => { if (current()) setOlder(previous => ({ ...page, executions: [...(previous?.executions ?? []), ...page.executions] })); })
          .catch(error => { if (current()) setError(error instanceof Error ? error.message : "无法加载历史。"); }).finally(() => { if (current()) setLoadingOlder(false); });
      }} />}
    </>}
  </ScrollView>;
}
const styles = StyleSheet.create({
  page: { gap: 14 }, row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  title: { fontSize: 24, fontWeight: "600", color: colors.text }, heading: { fontSize: 17, fontWeight: "600", color: colors.text },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 16, gap: 12 },
  label: { fontSize: 13, color: colors.muted }, note: { fontSize: 13, color: colors.muted, lineHeight: 20 }, body: { fontSize: 15, lineHeight: 23, color: colors.text },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, fontSize: 15, color: colors.text, backgroundColor: colors.canvas },
  prompt: { minHeight: 140, textAlignVertical: "top" }, button: { backgroundColor: colors.blue, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  subtle: { backgroundColor: "#F3F4F5" }, buttonText: { fontSize: 13, color: colors.text }, error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
  output: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12, gap: 10 }, code: { fontFamily: "monospace", color: colors.text, fontSize: 13 },
});
