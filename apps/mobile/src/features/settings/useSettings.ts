import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ModelSettingsSnapshot } from "../../../../../shared/settings";
import { loadSettings } from "./api";

/** Fetch only while open, cancel superseded reads, and retain the last snapshot on refresh failure. */
export function useSettings(open: boolean) {
  const [data, setData] = useState<ModelSettingsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const enabled = useRef(open);
  enabled.current = open;
  const pending = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!enabled.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
    setLoading(true);
    setError("");
    try {
      const value = await loadSettings(controller.signal);
      if (enabled.current && pending.current === controller && !controller.signal.aborted) setData(value);
    } catch (cause) {
      if (enabled.current && pending.current === controller && (!controller.signal.aborted || timedOut))
        setError(timedOut ? "读取设置超时，请重试。" : cause instanceof Error ? cause.message : "无法读取设置，请检查连接后重试。");
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) {
        pending.current = undefined;
        if (enabled.current) setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void refresh();
    });
    return () => {
      subscription.remove();
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [open, refresh]);
  return { data, setData, loading, error, setError, refresh };
}
