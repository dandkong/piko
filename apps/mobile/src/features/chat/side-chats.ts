import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  SideChat,
  GenerateSideChatTitle,
} from "../../../../../shared/side-chats";
import { apiFetch, readJson } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { createUuidV4 } from "../../utils/uuid";

async function request<T>(path: string, value?: unknown, method = value === undefined ? "GET" : "POST", timeoutMs = 10000): Promise<T> {
    const response = await apiFetch(path, {
        method,
        timeoutMs,
        ...(value !== undefined && {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
      });
    if (response.status === 204) return undefined as T;
    return readJson<T>(response);
}
export function useSideChats(open: boolean) {
  const [items, setItems] = useState<SideChat[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const locked = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const creation = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const value = await request<SideChat[]>("/api/side-chats");
      if (mounted.current && current === version.current) {
        setItems(value);
        setError("");
      }
    } catch (cause) {
      if (mounted.current && current === version.current)
        setError(errorMessage(cause, "无法加载旁聊。"));
    } finally {
      if (mounted.current && current === version.current) setLoading(false);
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
    setLoading(false);
    version.current++;
    try {
      const value = await operation();
      version.current++;
      if (mounted.current) {
        setLoading(false);
        if ("deletedId" in value) setItems(current => current.filter(item => item.id !== value.deletedId));
        else {
          const chat = value as SideChat;
          setItems(current => [chat, ...current.filter(item => item.id !== chat.id)].sort((a, b) => b.createdAt - a.createdAt));
        }
      }
      return value;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const generateTitle = useCallback(async (id: string, requestIds?: readonly string[]) => {
    const input: GenerateSideChatTitle = requestIds?.length ? { requestIds: [...requestIds] } : {};
    const result = await request<SideChat>(
      `/api/side-chats/${encodeURIComponent(id)}/title/generate`,
      input,
      "POST",
      60000,
    );
    if (mounted.current) {
      // Invalidate older list reads so a stale refresh cannot revert the generated title.
      version.current++;
      setLoading(false);
      setItems(current => current.map(item => item.id === result.id ? result : item));
    }
    return result;
  }, []);
  return {
    items,
    busy,
    loading,
    error,
    refresh,
    create: () =>
      mutate(async () => {
        const requestId = creation.current ?? createUuidV4();
        creation.current = requestId;
        const result = await request<SideChat>("/api/side-chats", { requestId });
        creation.current = undefined;
        return result;
      }),
    remove: (id: string) => mutate(async () => {
      await request<void>(`/api/side-chats/${encodeURIComponent(id)}`, undefined, "DELETE", 120000);
      return { deletedId: id };
    }),
    generateTitle,
  };
}
