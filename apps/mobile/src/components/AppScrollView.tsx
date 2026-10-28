import { useState } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";

type Props = Omit<ScrollViewProps, "showsVerticalScrollIndicator" | "indicatorStyle" | "persistentScrollbar"> & {
  showScrollbar?: boolean;
};

/** Shared vertical scrollbar behavior for long content and scrollable menus. */
export function AppScrollView({ showScrollbar = false, ...props }: Props) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const hasOverflow = contentHeight > viewportHeight + 1;

  const handleLayout: NonNullable<ScrollViewProps["onLayout"]> = event => {
    setViewportHeight(event.nativeEvent.layout.height);
    props.onLayout?.(event);
  };
  const handleContentSizeChange: NonNullable<ScrollViewProps["onContentSizeChange"]> = (width, height) => {
    setContentHeight(height);
    props.onContentSizeChange?.(width, height);
  };

  return <ScrollView
    {...props}
    onLayout={handleLayout}
    onContentSizeChange={handleContentSizeChange}
    showsVerticalScrollIndicator={showScrollbar && hasOverflow}
    indicatorStyle="default"
    persistentScrollbar={showScrollbar && hasOverflow}
  />;
}
