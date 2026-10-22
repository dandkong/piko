import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import type {
  TaskExecution,
  AssistantTask,
  AssistantTaskCommand,
  AssistantTaskDetail,
} from "../../../../../shared/tasks";
import { loadExecution, loadTask, loadTasks, sendCommand } from "./api";

type Command = AssistantTaskCommand extends infer T
  ? T extends AssistantTaskCommand
    ? Omit<T, "requestId">
    : never
  : never;

/** Task-page query and command state; request identities survive uncertain retries. */
export function useTasks() {
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<AssistantTaskDetail>();
  const [open, setOpen] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [openSections, setOpenSections] = useState({
    active: true,
    archived: false,
  });
  const mounted = useRef(true);
  const sending = useRef(false);
  const pending = useRef<
    { signature: string; command: AssistantTaskCommand } | undefined
  >(undefined);
  const selection = useRef(selected);
  selection.current = selected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const [list, current] = await Promise.all([
          loadTasks(controller.signal),
          selected ? loadTask(selected, controller.signal) : undefined,
        ]);
        if (!active) return;
        setTasks(list.tasks);
        setDetail(current);
        setError("");
      } catch {
        if (active) setError("暂时加载不了任务。");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected, refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) => {
      if (value === "active") setRefresh((count) => count + 1);
    });
    return () => listener.remove();
  }, []);

  const openTask = (id?: string) => {
    setSelected(id);
    setDetail(undefined);
    setOpen(undefined);
    setError("");
    setLoading(Boolean(id));
  };
  const showAnswer = useCallback(
    async (execution: TaskExecution) => {
      const selectedTask = selection.current;
      if (!selectedTask || answers[execution.id] !== undefined) return;
      try {
        const result = await loadExecution(selectedTask, execution.id);
        if (selection.current === selectedTask)
          setAnswers((previous) => ({
            ...previous,
            [execution.id]: result.answer,
          }));
      } catch {
        if (selection.current === selectedTask)
          setError("暂时加载不了这次运行结果。");
      }
    },
    [answers],
  );
  const toggle = (execution: TaskExecution) => {
    const next = open === execution.id ? undefined : execution.id;
    setOpen(next);
    if (next) void showAnswer(execution);
  };

  const send = async (body: Command) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        command: { ...body, requestId: randomUUID() } as AssistantTaskCommand,
      };
    try {
      await sendCommand(pending.current.command);
      if (!mounted.current) return;
      pending.current = undefined;
      setRefresh((count) => count + 1);
    } catch {
      if (mounted.current) setError("操作没有成功，请稍后再试。");
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggleArchive = (entry: AssistantTask) => {
    void send({
      action: "status",
      id: entry.id,
      status: entry.status === "archived" ? "active" : "archived",
    });
  };
  const toggleSection = (section: "active" | "archived") => {
    setOpenSections((value) => ({ ...value, [section]: !value[section] }));
  };

  return {
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
  };
}
