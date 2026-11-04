import type { RefObject } from "react";
import type { FlatList, FlatListProps } from "react-native";
import type { Message } from "../../../../../shared/chat";

export type ChatScrollOptions = {
  loading: boolean;
  submitting: boolean;
  assistantStreaming: boolean;
  reduceMotion: boolean;
  onNearStart: () => void;
};

export type ChatScroll = {
  listRef: RefObject<FlatList<Message> | null>;
  awayFromLatest: boolean;
  scrollToLatest: (animated: boolean) => void;
  beforePrepend: () => void;
  listProps: Pick<FlatListProps<Message>,
    "onScroll" | "onScrollBeginDrag" | "onScrollEndDrag" |
    "onLayout" | "onContentSizeChange"
  >;
};

// CSS pixels / native layout points; allow fractional layout and rounding only.
export const BOTTOM_EPSILON = 2;
