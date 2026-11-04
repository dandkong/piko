import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";
import type { Message } from "../../../../../shared/chat";
import { BOTTOM_EPSILON, type ChatScroll, type ChatScrollOptions } from "./chat-scroll-types";

/** Web owns scroll geometry directly, not RN Web's deferred onLayout measurements. */
export function useChatScroll(options: ChatScrollOptions): ChatScroll {
  const listRef = useRef<FlatList<Message>>(null);
  const latest = useRef(options);
  latest.current = options;
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const control = useRef<{
    latest: (animated: boolean) => void;
    sync: () => void;
    beforePrepend: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    const node = listRef.current?.getNativeScrollRef() as unknown as HTMLElement;
    const content = node?.firstElementChild;
    if (!node || !content) return;
    let following = true;
    let leftBottom = false;
    let touching = false;
    let touchY = 0;
    let anchor: { element: HTMLElement; top: number } | undefined;
    // Browser anchoring and application following must not both adjust the offset.
    const previousAnchor = node.style.overflowAnchor;
    node.style.overflowAnchor = "none";

    const atBottom = () => node.scrollHeight - node.clientHeight - node.scrollTop <= BOTTOM_EPSILON;
    const bottomOffset = () => Math.max(0, node.scrollHeight - node.clientHeight);
    const moveToBottom = (animated: boolean) => {
      const offset = bottomOffset();
      if (listRef.current) listRef.current.scrollToOffset({ offset, animated });
      else node.scroll({ top: offset, behavior: animated ? "smooth" : "instant" });
    };
    const publish = () => setAwayFromLatest(
      !latest.current.loading && !following && !atBottom(),
    );
    const sync = () => {
      if (!node.clientHeight) return;
      if (following) {
        moveToBottom(false);
      } else if (anchor?.element.isConnected) {
        // Preserve the visible message when an older history page is prepended.
        node.scroll({ top: node.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top, behavior: "instant" });
      }
      publish();
    };
    const pause = () => {
      following = false;
      leftBottom = !atBottom();
      anchor = undefined;
    };
    const resume = (animated: boolean) => {
      following = true;
      leftBottom = false;
      anchor = undefined;
      if (animated) {
        moveToBottom(true);
        publish();
      } else {
        sync();
      }
    };
    const onScroll = () => {
      if (!atBottom()) leftBottom = true;
      // A stale bottom event just after upward input is not a return-to-bottom.
      if (atBottom() && (following || leftBottom) && !touching) {
        following = true;
        anchor = undefined;
      }
      // Scroll events only report position. Resize/layout owns correction, so an
      // input event delivered after compositor scrolling cannot be snapped back.
      publish();
      if (!following && !latest.current.loading && node.scrollTop <= 120)
        latest.current.onNearStart();
    };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (event.deltaY < 0 || !atBottom()) pause();
    };
    const onTouchStart = (event: TouchEvent) => {
      touching = true;
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (Math.abs(y - touchY) > 1) pause();
      touchY = y;
    };
    const onTouchEnd = () => {
      touching = false;
      if (atBottom()) following = true;
      sync();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || target?.closest("input, textarea, [contenteditable=true]")) return;
      if (target !== document.body && target !== document.documentElement && !node.contains(target)) return;
      if (event.key === " " && target?.closest("button, a, [role=button], [role=link]")) return;
      const page = node.clientHeight * 0.875;
      const steps: Partial<Record<string, number>> = {
        ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page,
        Home: -node.scrollHeight, End: node.scrollHeight,
        " ": event.shiftKey ? -page : page,
      };
      const step = steps[event.key];
      if (step === undefined) return;
      event.preventDefault();
      pause();
      // Handle navigation in this scrollport without involving the document scroll.
      node.scroll({ top: node.scrollTop + step, behavior: "instant" });
    };
    // ResizeObserver runs before paint; one exact read/write handles row growth,
    // typing footer, composer insets, and viewport changes without delayed retries.
    const observer = new ResizeObserver(sync);
    // Insets are padding: content-box observation misses padding-only changes
    // (e.g. the header gains its busy line, or the multiline composer shrinks).
    observer.observe(node, { box: "border-box" });
    observer.observe(content, { box: "border-box" });
    node.addEventListener("scroll", onScroll, { passive: true });
    // Receive intent before the compositor scrolls, including during a resize.
    // These handlers do not preventDefault; browser wheel/touch scrolling stays native.
    node.addEventListener("wheel", onWheel, { passive: false, capture: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    node.addEventListener("touchend", onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    control.current = {
      latest: resume,
      sync,
      beforePrepend: () => {
        if (following) return;
        const top = node.getBoundingClientRect().top;
        const element = Array.from(node.querySelectorAll<HTMLElement>("[data-testid^=chat-message-]"))
          .find(element => element.getBoundingClientRect().bottom > top);
        if (element) anchor = { element, top: element.getBoundingClientRect().top };
      },
    };
    sync();
    return () => {
      control.current = null;
      observer.disconnect();
      node.style.overflowAnchor = previousAnchor;
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel, true);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove, true);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (options.submitting) control.current?.latest(false);
  }, [options.submitting]);
  useLayoutEffect(() => { control.current?.sync(); }, [options.loading]);

  return {
    listRef,
    awayFromLatest,
    scrollToLatest: useCallback((animated: boolean) => control.current?.latest(animated), []),
    beforePrepend: useCallback(() => control.current?.beforePrepend(), []),
    // Use DOM resize/scroll events above instead of two asynchronous measuring paths.
    listProps: {},
  };
}
