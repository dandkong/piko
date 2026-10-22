import { useEffect, useRef } from "react";
import { BackHandler, Platform } from "react-native";

type Options = {
  /** Capture Escape before inputs and layers underneath; used by dialogs and menus. */
  capture?: boolean;
};

/**
 * One dismissal path for stacked overlays: Android back and Web Escape.
 * Overlays subscribe instead of branching on Platform themselves.
 */
export function useDismissOnBack(
  active: boolean,
  onDismiss: () => void,
  { capture = false }: Options = {},
) {
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!active) return;
    if (Platform.OS === "android") {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          dismiss.current();
          return true;
        },
      );
      return () => subscription.remove();
    }
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (capture) {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss.current();
    };
    window.addEventListener("keydown", onKeyDown, capture);
    return () => window.removeEventListener("keydown", onKeyDown, capture);
  }, [active, capture]);
}
