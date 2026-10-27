import { X } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { IconButton } from "./IconButton";
import { colors, motion, radii } from "../theme";

/** Shared elevated overlay for pages that cover the app and close only by an explicit button. */
export function FloatingPanel({
  open,
  title,
  onClose,
  closeLabel,
  children,
  headerActions,
  testID,
  showScrollbar = false,
  scrollTestID,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel: string;
  children?: ReactNode;
  headerActions?: ReactNode;
  testID?: string;
  /** Show the platform scrollbar for long panel content. */
  showScrollbar?: boolean;
  scrollTestID?: string;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);
  const topGap = Math.max(48, insets.top + 12);

  useEffect(() => {
    if (open) setMounted(true);
    progress.value = withTiming(
      open ? 1 : 0,
      {
        duration: reduceMotion ? 0 : open ? motion.drawerIn : motion.drawerOut,
        easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      },
      finished => {
        if (finished && !open) runOnJS(setMounted)(false);
      },
    );
  }, [open, progress, reduceMotion]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: height * (1 - progress.value) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!mounted) return null;

  return (
    <View
      pointerEvents="auto"
      accessibilityViewIsModal={open}
      style={styles.overlay}
      testID={testID}
    >
      <Animated.View
        pointerEvents="auto"
        style={[styles.scrim, scrimStyle]}
      />
      <Animated.View
        style={[
          styles.panel,
          { top: topGap, paddingBottom: insets.bottom },
          panelStyle,
        ]}
      >
        <View style={styles.header}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          <View style={styles.headerActions}>
            {headerActions}
            <IconButton label={closeLabel} onPress={onClose}>
              <X size={20} strokeWidth={1.8} color={colors.text} />
            </IconButton>
          </View>
        </View>
        <ScrollView
          testID={scrollTestID}
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={showScrollbar}
          indicatorStyle="default"
          persistentScrollbar={showScrollbar}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
  },
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.scrim,
  },
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.canvas,
    borderTopLeftRadius: radii.panel,
    borderTopRightRadius: radii.panel,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: {
    flex: 1,
    fontSize: 22,
    fontWeight: "600",
    color: colors.text,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  body: {
    flexGrow: 1,
    paddingBottom: 24,
  },
});
