import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  ConversationResponse,
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
        setConnected(value.modelReady);
        checkedHealth = true;
      } catch {
        if (active) {
          checkedHealth = false;
          setConnected(false);
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
            } else if (!checkedHealth) {
              checkedHealth = true;
              void health();
            }
          },
          onEvent: (event) => {
            if (!active) return;
            version.current++;
            if (event.type === "deleted") {
              active = false;
              setConnected(false);
              setReconnecting(false);
              onDeleted();
              controller.abort();
            } else if (event.type === "snapshot") onSnapshot(event.conversation);
            else if (event.type === "message") onMessage(event);
            else if (event.type === "error") onError(event.message);
          },
        },
        conversationId,
      );
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [conversationId, enabled, foreground, onSnapshot, onMessage, onError, onDeleted]);
  return { connected, reconnecting, modelReady, version };
}
