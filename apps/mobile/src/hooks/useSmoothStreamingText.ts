import { useEffect, useRef, useState } from "react";

// Aim for a deliberate typing rhythm while allowing accumulated text to catch up.
const SMOOTH_FRAME_MS = 32;
const SMOOTH_BASE_RATE = 52;
const SMOOTH_BACKLOG_RATE = 7;
const SMOOTH_MAX_RATE = 220;
const SMOOTH_MAX_BACKLOG = 96;
const SMOOTH_INITIAL_LIMIT = 24;
const SMOOTH_MAX_ELAPSED_MS = 100;

type GraphemeSegmenter = {
  segment(value: string): Iterable<{ segment: string }>;
};
type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;
const GraphemeSegmenter = (
  Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }
).Segmenter;
const graphemeSegmenter = GraphemeSegmenter
  ? new GraphemeSegmenter(undefined, { granularity: "grapheme" })
  : undefined;

function splitGraphemes(value: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), part => part.segment)
    : Array.from(value);
}

/** Smooth only the live presentation; `content` remains the authoritative full text. */
export function useSmoothStreamingText(
  content: string,
  streaming: boolean,
  reduceMotion = false,
): string {
  const shouldSmooth = streaming && !reduceMotion;
  const initialVisible = shouldSmooth && content.length <= SMOOTH_INITIAL_LIMIT
    ? ""
    : content;
  const [visibleText, setVisibleText] = useState(initialVisible);
  const sourceRef = useRef<string | null>(null);
  const visibleRef = useRef(initialVisible);
  const pendingRef = useRef<string[]>([]);
  const frameRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const fractionalRef = useRef(0);
  const frameCallbackRef = useRef<(time: number) => void>(() => {});

  const cancelFrame = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lastFrameRef.current = null;
    fractionalRef.current = 0;
  };
  const scheduleFrame = () => {
    if (frameRef.current === null)
      frameRef.current = requestAnimationFrame(time => frameCallbackRef.current(time));
  };
  const syncToSource = (value: string) => {
    sourceRef.current = value;
    pendingRef.current = [];
    visibleRef.current = value;
    setVisibleText(value);
    cancelFrame();
  };

  frameCallbackRef.current = time => {
    frameRef.current = null;
    const pending = pendingRef.current;
    if (!pending.length) {
      lastFrameRef.current = null;
      fractionalRef.current = 0;
      return;
    }
    if (lastFrameRef.current === null)
      lastFrameRef.current = time - SMOOTH_FRAME_MS;
    const elapsed = time - lastFrameRef.current;
    if (elapsed < SMOOTH_FRAME_MS) {
      scheduleFrame();
      return;
    }
    lastFrameRef.current = time;
    const rate = Math.min(
      SMOOTH_MAX_RATE,
      SMOOTH_BASE_RATE + Math.max(0, pending.length - 4) * SMOOTH_BACKLOG_RATE,
    );
    fractionalRef.current +=
      Math.min(elapsed, SMOOTH_MAX_ELAPSED_MS) * rate / 1000;
    const count = Math.min(
      pending.length,
      Math.max(1, Math.floor(fractionalRef.current)),
    );
    fractionalRef.current -= count;
    visibleRef.current += pending.splice(0, count).join("");
    setVisibleText(visibleRef.current);
    if (pending.length) scheduleFrame();
    else {
      lastFrameRef.current = null;
      fractionalRef.current = 0;
    }
  };

  useEffect(() => {
    if (!shouldSmooth) {
      syncToSource(content);
      return;
    }
    const previous = sourceRef.current;
    if (previous === null) {
      sourceRef.current = content;
      if (!visibleRef.current && content) {
        pendingRef.current = splitGraphemes(content);
        scheduleFrame();
      }
      return;
    }
    if (content === previous) {
      if (pendingRef.current.length) scheduleFrame();
      return;
    }
    if (!content.startsWith(previous)) {
      syncToSource(content);
      return;
    }
    const additions = splitGraphemes(content.slice(previous.length));
    sourceRef.current = content;
    if (pendingRef.current.length + additions.length > SMOOTH_MAX_BACKLOG) {
      syncToSource(content);
      return;
    }
    pendingRef.current.push(...additions);
    if (pendingRef.current.length) scheduleFrame();
  }, [content, shouldSmooth]);

  useEffect(() => () => cancelFrame(), []);
  return shouldSmooth ? visibleText : content;
}
