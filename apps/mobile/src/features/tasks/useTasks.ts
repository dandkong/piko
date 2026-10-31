import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createUuidV4 } from "../../utils/uuid";
import type {
  AssistantTask,
  AssistantTaskCommand,
  AssistantTaskDetail,
} from "../../../../../shared/tasks";
import { loadTask, loadTasks, sendCommand } from "./api";
import { errorMessage } from "../../api/errors";

type Command = AssistantTaskCommand extends infer T
  ? T extends AssistantTaskCommand
    ? Omit<T, "requestId">
    : never
  : never;

/** Task-page query and command state; request identities survive uncertain retries. */
export function useTasks(onToast: (message: string) => void) {
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<AssistantTaskDetail>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
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
    setLoading(true);
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
      } catch (cause) {
        if (active) setError(errorMessage(cause, "暂时加载不了任务。已有内容仍保留，请重新加载。"));
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
    setError("");
    setLoading(Boolean(id));
  };
  const send = async (body: Command) => {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    if (body.action === "delete") setDeleteError("");
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        command: { ...body, requestId: createUuidV4() } as AssistantTaskCommand,
      };
    try {
      await sendCommand(pending.current.command);
      if (!mounted.current) return true;
      pending.current = undefined;
      setRefresh((count) => count + 1);
      return true;
    } catch (failure) {
      if (mounted.current) {
        const message = errorMessage(failure, "暂未确认操作结果，请重试原操作。");
        if (body.action === "delete") setDeleteError(message);
        else onToast(message);
      }
      return false;
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggleArchive = (entry: AssistantTask) =>
    send({
      action: "status",
      id: entry.id,
      status: entry.status === "archived" ? "active" : "archived",
    });
  const runTask = (entry: AssistantTask) =>
    send({ action: "run", id: entry.id });
  const deleteTask = async (entry: AssistantTask) => {
    const succeeded = await send({ action: "delete", id: entry.id });
    if (succeeded && selection.current === entry.id) openTask();
    return succeeded;
  };
  const toggleSection = (section: "active" | "archived") => {
    setOpenSections((value) => ({ ...value, [section]: !value[section] }));
  };

  return {
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
    clearDeleteError: () => setDeleteError(""),
    reload: () => setRefresh(count => count + 1),
    toggleSection,
  };
}
