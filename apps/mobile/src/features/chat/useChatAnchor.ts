import { useCallback, useRef } from "react";

/** Distance from the bottom that still counts as "following the newest message". */
const BOTTOM_THRESHOLD = 100;
const MESSAGE_SELECTOR = '[data-testid^="chat-message-"]';

type SavedAnchor = { id: string; top: number };
export type ChatAnchorOptions = {
  scrollTo: (offset: number, animated: boolean) => void;
  onAwayChange: (away: boolean) => void;
  /** Position of a message in the rendered list, used when the saved anchor is not mounted. */
  indexOf: (testId: string) => number;
  /** Seek to an index so a virtualized anchor can mount again before pixel correction. */
  seek: (index: number) => void;
};

/**
 * One invariant for the conversation viewport: either the newest message is pinned to the bottom
 * ("follow"), or the reading position is preserved against a message id ("detached").
 *
 * Web corrections run inside ResizeObserver/MutationObserver, which fire after layout and before
 * paint, so a reload, a composer inset change or a page of older history never paints at a stale
 * offset. When the anchor itself was unmounted by the list window, we seek by index first and let
 * the next observation apply the exact pixel delta.
 */
export function useChatAnchor(options: ChatAnchorOptions) {
  const following = useRef(true);
  const saved = useRef<SavedAnchor | undefined>(undefined);
  const scroller = useRef<HTMLElement | undefined>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  const seeking = useRef(-1);
  const latest = useRef(options); latest.current = options;

  const nodes = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)];
  const capture = (element: HTMLElement) => {
    const top = element.getBoundingClientRect().top;
    const node = nodes(element).find(item => item.getBoundingClientRect().bottom > top);
    if (node) saved.current = { id: node.dataset.testid!, top: node.getBoundingClientRect().top };
  };
  const apply = (animated = false) => {
    const element = scroller.current;
    if (!element || !element.clientHeight) return;
    if (following.current) {
      latest.current.scrollTo(Math.max(0, element.scrollHeight - element.clientHeight), animated);
      capture(element);
      return;
    }
    const anchor = saved.current;
    if (!anchor) return;
    const node = nodes(element).find(item => item.dataset.testid === anchor.id);
    if (!node) {
      const index = latest.current.indexOf(anchor.id);
      if (index >= 0 && index !== seeking.current) { seeking.current = index; latest.current.seek(index); }
      return;
    }
    seeking.current = -1;
    const delta = node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) element.scrollTop += delta;
    capture(element);
  };
  /** Native lists report geometry through callbacks instead of observers. */
  const sync = (contentHeight: number, viewportHeight: number) => {
    if (!viewportHeight) return;
    if (following.current) latest.current.scrollTo(Math.max(0, contentHeight - viewportHeight), false);
  };
  const observe = (offset: number, contentHeight: number, viewportHeight: number) => {
    const next = contentHeight - offset - viewportHeight < BOTTOM_THRESHOLD;
    if (next === following.current) return;
    following.current = next; latest.current.onAwayChange(!next);
  };
  const watch = useCallback((element: HTMLElement) => {
    if (scroller.current === element) return;
    release.current?.();
    scroller.current = element;
    const observer = new ResizeObserver(() => apply());
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    // Inset and text changes can reflow without resizing the observed boxes.
    const mutations = new MutationObserver(() => apply());
    mutations.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
    const onScroll = () => {
      const next = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD;
      if (next !== following.current) { following.current = next; latest.current.onAwayChange(!next); }
      // A pending seek moves the list on purpose; keep the saved anchor until it is restored.
      if (!next && seeking.current < 0) capture(element);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    release.current = () => {
      observer.disconnect(); mutations.disconnect(); element.removeEventListener("scroll", onScroll);
      if (scroller.current === element) scroller.current = undefined;
    };
    apply();
  }, []);
  const follow = useCallback((animated: boolean) => {
    following.current = true; latest.current.onAwayChange(false); apply(animated);
  }, []);
  /** Stop following before a change that must not move the reader (loading older history). */
  const detach = useCallback(() => { following.current = false; latest.current.onAwayChange(true); }, []);
  return { watch, sync, observe, detach, follow };
}
