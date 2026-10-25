import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  SideChat,
  UpdateSideChat,
} from "../../../../../shared/side-chats";
import { apiFetch, readJson } from "../../api/client";
import { createUuidV4 } from "../../utils/uuid";

async function request<T>(path: string, value?: unknown, method = value === undefined ? "GET" : "POST"): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await apiFetch(path, {
        method,
        signal: controller.signal,
        ...(value !== undefined && {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
      });
    if (response.status === 204) return undefined as T;
    return await readJson<T>(response);
  } finally {
    clearTimeout(timer);
  }
}
export function useSideChats(open: boolean) {
  const [items, setItems] = useState<SideChat[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const creation = useRef<{ title: string; requestId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      const value = await request<SideChat[]>("/api/side-chats");
      if (mounted.current && current === version.current) {
        setItems(value);
        setError("");
      }
    } catch (cause) {
      if (mounted.current && current === version.current)
        setError(
          cause instanceof Error ? cause.message : "无法加载旁聊。",
        );
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => listener.remove();
  }, [open, refresh]);
  const mutate = async <T extends SideChat | { deletedId: string }>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    version.current++;
    try {
      const value = await operation();
      version.current++;
      if (mounted.current) {
        if ("deletedId" in value) setItems(current => current.filter(item => item.id !== value.deletedId));
        else {
          const chat = value as SideChat;
          setItems(current => [chat, ...current.filter(item => item.id !== chat.id)].sort((a, b) => b.createdAt - a.createdAt));
        }
      }
      return value;
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "无法保存旁聊。",
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    items,
    busy,
    error,
    refresh,
    create: (title: string) =>
      mutate(async () => {
        const command =
          creation.current?.title === title
            ? creation.current
            : { title, requestId: createUuidV4() };
        creation.current = command;
        const result = await request<SideChat>("/api/side-chats", command);
        creation.current = undefined;
        return result;
      }),
    remove: (id: string) => mutate(async () => {
      await request<void>(`/api/side-chats/${encodeURIComponent(id)}`, undefined, "DELETE");
      return { deletedId: id };
    }),
    update: (id: string, change: UpdateSideChat) =>
      mutate(() =>
        request<SideChat>(`/api/side-chats/${encodeURIComponent(id)}`, change),
      ),
  };
}
