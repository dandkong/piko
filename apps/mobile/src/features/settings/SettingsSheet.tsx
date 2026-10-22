import { ChevronRight, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  Pressable,
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
import { IconButton } from "../../components/IconButton";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import { colors, motion, radii } from "../../theme";

/** Sheet stops this far below the top, leaving the page visible behind it. */
export const SETTINGS_TOP_GAP = 48;

const entries = ["模型", "通道", "工作区", "关于"];

/** Near-full-height sheet: flush to the sides and bottom, only the top edge floats. */
export function SettingsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);
  const topGap = Math.max(SETTINGS_TOP_GAP, insets.top + 12);

  useEffect(() => {
    if (open) setMounted(true);
    progress.value = withTiming(
      open ? 1 : 0,
      {
        duration: reduceMotion ? 0 : open ? motion.drawerIn : motion.drawerOut,
        easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      },
      (finished) => {
        if (finished && !open) runOnJS(setMounted)(false);
      },
    );
  }, [open, progress, reduceMotion]);

  useDismissOnBack(open, onClose);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: height * (1 - progress.value) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!mounted) return null;

  return (
    <View
      pointerEvents={open ? "auto" : "none"}
      accessibilityViewIsModal={open}
      style={styles.overlay}
      testID="settings-sheet"
    >
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭设置"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="settings-scrim"
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { top: topGap, paddingBottom: insets.bottom },
          sheetStyle,
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>设置</Text>
          <IconButton
            label="关闭设置"
            onPress={onClose}
          >
            <X size={20} strokeWidth={1.8} color={colors.text} />
          </IconButton>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((label, index) => (
            <View
              key={label}
              style={[styles.row, index > 0 && styles.rowDivider]}
            >
              <Text style={styles.rowLabel}>{label}</Text>
              <ChevronRight size={18} strokeWidth={1.8} color={colors.muted} />
            </View>
          ))}
          <Text style={styles.note}>
            设置项尚未接入，先确认弹层的形态与动效。
          </Text>
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
  sheet: {
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
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.text,
  },
  body: {
    paddingBottom: 24,
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: "500",
    color: colors.text,
  },
  note: {
    marginTop: 16,
    paddingHorizontal: 20,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
});
