import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FlatList, NativeScrollEvent } from "react-native";
import type { Message } from "../../../../../shared/chat";
import { BOTTOM_EPSILON, type ChatScroll, type ChatScrollOptions } from "./chat-scroll-types";

/** Native counterpart; only a user drag, never content growth, cancels following. */
export function useChatScroll(options: ChatScrollOptions): ChatScroll {
  const listRef = useRef<FlatList<Message>>(null);
  const latest = useRef(options);
  latest.current = options;
  const following = useRef(true);
  const dragging = useRef(false);
  const metrics = useRef({ contentHeight: 0, viewportHeight: 0, offset: 0 });
  const prepend = useRef<{ height: number; offset: number } | undefined>(undefined);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scrollToLatest = useCallback((animated: boolean) => {
    following.current = true;
    prepend.current = undefined;
    const { contentHeight, viewportHeight } = metrics.current;
    if (!dragging.current && viewportHeight && contentHeight)
      listRef.current?.scrollToOffset({
        offset: Math.max(0, contentHeight - viewportHeight),
        animated: animated && !latest.current.reduceMotion,
      });
  }, []);
  const record = (event: NativeScrollEvent) => {
    metrics.current = {
      contentHeight: event.contentSize.height,
      viewportHeight: event.layoutMeasurement.height,
      offset: event.contentOffset.y,
    };
    return event.contentSize.height - event.layoutMeasurement.height - event.contentOffset.y <= BOTTOM_EPSILON;
  };
  const wasStreaming = useRef(options.assistantStreaming);
  useLayoutEffect(() => {
    if (options.submitting) scrollToLatest(false);
  }, [options.submitting, scrollToLatest]);
  useLayoutEffect(() => {
    if (wasStreaming.current && !options.assistantStreaming && following.current)
      scrollToLatest(false);
    wasStreaming.current = options.assistantStreaming;
  }, [options.assistantStreaming, scrollToLatest]);

  return {
    listRef,
    awayFromLatest: !options.loading && awayFromLatest,
    scrollToLatest,
    beforePrepend: () => {
      if (!following.current)
        prepend.current = { height: metrics.current.contentHeight, offset: metrics.current.offset };
    },
    listProps: {
      onScrollBeginDrag: () => {
        dragging.current = true;
        following.current = false;
        prepend.current = undefined;
      },
      onScrollEndDrag: ({ nativeEvent }) => {
        dragging.current = false;
        following.current = record(nativeEvent);
        setAwayFromLatest(!following.current);
      },
      onScroll: ({ nativeEvent }) => {
        if (!nativeEvent.layoutMeasurement.height) return;
        const bottom = record(nativeEvent);
        if (bottom && !dragging.current) following.current = true;
        setAwayFromLatest(!bottom);
        if (!following.current && !options.loading && nativeEvent.contentOffset.y <= 120)
          options.onNearStart();
      },
      onLayout: ({ nativeEvent: { layout } }) => {
        if (!layout.height) return;
        metrics.current.viewportHeight = layout.height;
        if (following.current) scrollToLatest(false);
      },
      onContentSizeChange: (_, height) => {
        if (!height) return;
        metrics.current.contentHeight = height;
        const anchor = prepend.current;
        prepend.current = undefined;
        if (anchor && !dragging.current) {
          const offset = Math.max(0, anchor.offset + height - anchor.height);
          listRef.current?.scrollToOffset({ offset, animated: false });
        } else if (following.current)
          scrollToLatest(
            latest.current.assistantStreaming &&
              !latest.current.submitting &&
              !latest.current.reduceMotion,
          );
      },
    },
  };
}
