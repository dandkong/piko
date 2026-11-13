import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ModelSettingsSnapshot } from "../../../../../shared/settings";
import { loadSettings } from "./api";
import { errorMessage } from "../../api/errors";
import { useTranslation } from "../../i18n";

/** Fetch only while open, cancel superseded reads, and retain the last snapshot on refresh failure. */
export function useSettings(open: boolean, writesPending: { current: boolean }) {
  const { t } = useTranslation();
  const [data, setData] = useState<ModelSettingsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const enabled = useRef(open);
  enabled.current = open;
  const pending = useRef<AbortController | undefined>(undefined);
  const readGeneration = useRef(0);
  const invalidateReads = useCallback(() => {
    readGeneration.current++;
    pending.current?.abort();
  }, []);
  const refresh = useCallback(async () => {
    if (!enabled.current || writesPending.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    const generation = readGeneration.current;
    pending.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
    setLoading(true);
    setError("");
    try {
      const value = await loadSettings(controller.signal);
      if (enabled.current && !writesPending.current && readGeneration.current === generation &&
        pending.current === controller && !controller.signal.aborted) { setData(value); return true; }
      return false;
    } catch (cause) {
      if (enabled.current && readGeneration.current === generation && pending.current === controller &&
        (!controller.signal.aborted || timedOut))
        setError(timedOut ? t("settings.timeout") : errorMessage(cause, t("settings.loadFailed"), t));
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) {
        pending.current = undefined;
        if (enabled.current) setLoading(false);
      }
    }
  }, [writesPending, t]);
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
  return { data, setData, loading, error, setError, refresh, invalidateReads };
}
