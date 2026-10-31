import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  ConversationResponse,
  ConversationActivity,
  SubmissionReceipt,
  StreamEvent,
} from "../../../../../shared/chat";
import { checkHealth, observe } from "./api";

type MessageEvent = Extract<StreamEvent, { type: "message" }>;

/** Active-only observation; reconnecting never resubmits input. */
export function useConversationObservation(
  conversationId: string | undefined,
  enabled: boolean,
  onSnapshot: (snapshot: ConversationResponse) => void,
  onMessage: (event: MessageEvent) => void,
  onActivity: (activity: ConversationActivity) => void,
  onRunEnd: (submissions: readonly SubmissionReceipt[]) => void,
  onError: (error: string) => void,
  onDeleted: () => void,
) {
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    setForeground(AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, [enabled]);
  useEffect(() => {
    if (!foreground || !enabled) return;
    const controller = new AbortController();
    let active = true;
    let checkedHealth = false;
    const health = async () => {
      try {
        const value = await checkHealth();
        if (!active) return;
        setModelReady(value.modelReady);
        setConnected(true);
        checkedHealth = true;
      } catch {
        if (active) {
          checkedHealth = false;
          setConnected(false);
          onError("暂时无法连接服务，请重新加载。");
        }
      }
    };
    void (async () => {
      await health();
      if (!active) return;
      await observe(
        {
          signal: controller.signal,
          onReconnecting: (value) => {
            if (!active) return;
            setReconnecting(value);
            if (value) {
              checkedHealth = false;
              setConnected(false);
              onActivity({ kind: "idle" });
            } else if (!checkedHealth) {
              checkedHealth = true;
              void health();
            }
          },
          onEvent: (event) => {
            if (!active) return;
            version.current++;
            switch (event.type) {
              case "deleted":
                active = false;
                setConnected(false);
                setReconnecting(false);
                onDeleted();
                controller.abort();
                break;
              case "snapshot": onSnapshot(event.conversation); break;
              case "message": onMessage(event); break;
              case "run-end": onRunEnd(event.submissions); break;
              case "activity": onActivity(event.activity); break;
              case "error": onError(event.message); break;
              default: { const exhaustive: never = event; return exhaustive; }
            }
          },
        },
        conversationId,
      );
    })();
    return () => {
      active = false;
      controller.abort();
      onActivity({ kind: "idle" });
    };
  }, [conversationId, enabled, foreground, onSnapshot, onMessage, onActivity, onRunEnd, onError, onDeleted]);
  return { connected, reconnecting, modelReady, version };
}
