/** React Native Web does not implement maintainVisibleContentPosition.
 * Keep a visible bubble as an anchor instead of relying on variable-height estimates.
 */
export type WebHistoryAnchor = { id: string; top: number };
export function captureHistoryAnchor(scroller: HTMLElement, headerHeight: number): WebHistoryAnchor | undefined {
  const top = scroller.getBoundingClientRect().top + headerHeight;
  const node = Array.from(scroller.querySelectorAll<HTMLElement>('[data-testid^="chat-message-"]'))
    .find(element => element.getBoundingClientRect().bottom > top);
  if (!node) return;
  return { id: node.dataset.testid!, top: node.getBoundingClientRect().top };
}

/** Retry while FlatList mounts/measures the prepended variable-height cells. */
export function restoreHistoryAnchor(scroller: HTMLElement, anchor: WebHistoryAnchor, seek: () => void, finished: () => void): () => void {
  let frame = 0; let attempts = 0; let stable = 0; let cancelled = false;
  const restore = () => {
    if (cancelled) return;
    const node = Array.from(scroller.querySelectorAll<HTMLElement>('[data-testid^="chat-message-"]'))
      .find(element => element.dataset.testid === anchor.id);
    if (node) {
      const delta = node.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 1) { scroller.scrollTop += delta; stable = 0; }
      else stable++;
    } else {
      // Prepending invalidates VirtualizedList's index estimates. Seek the anchor's
      // new index to mount it before applying pixel-exact positioning.
      seek();
      stable = 0;
    }
    if (++attempts < 60 && stable < 6) frame = requestAnimationFrame(restore);
    else finished();
  };
  frame = requestAnimationFrame(restore);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}
