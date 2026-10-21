import { Settings, SquarePen, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { navigation, type AppTab } from "../../navigation";
import { colors } from "../../theme";

const PANEL_MAX_WIDTH = 340;
const PANEL_INSET = 10;
const OPEN_DURATION = 260;
const CLOSE_DURATION = 200;

/** Floating navigation panel: tabs mirror the bottom bar and side chats stay independent. */
export function NavigationDrawer({ open, activeTab, onSelectTab, onClose, onOpenSettings, onNewSideChat }: {
  open: boolean;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onNewSideChat?: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const panelWidth = Math.min(PANEL_MAX_WIDTH, width * 0.84);
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    progress.value = withTiming(open ? 1 : 0, {
      duration: open ? OPEN_DURATION : CLOSE_DURATION,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    }, finished => {
      if (finished && !open) runOnJS(setMounted)(false);
    });
  }, [mounted, open, progress]);

  useEffect(() => {
    if (!open) return;
    if (Platform.OS === "android") {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        onClose();
        return true;
      });
      return () => subscription.remove();
    }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") onClose();
      };
      window.addEventListener("keydown", closeOnEscape);
      return () => window.removeEventListener("keydown", closeOnEscape);
    }
  }, [open, onClose]);

  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1]),
    transform: [
      { translateX: interpolate(progress.value, [0, 1], [-panelWidth - PANEL_INSET, 0]) },
      { scale: interpolate(progress.value, [0, 1], [0.985, 1]) },
    ],
  }));

  if (!mounted) return null;

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close navigation"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID="navigation-drawer-backdrop"
      />
      <Animated.View
        accessibilityViewIsModal
        style={[styles.panel, {
          width: panelWidth,
          top: insets.top + PANEL_INSET,
          bottom: insets.bottom + PANEL_INSET,
        }, panelStyle]}
        testID="navigation-drawer"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Piko</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close navigation"
            hitSlop={8}
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <X size={18} strokeWidth={1.8} color={colors.muted} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
        >
          <Text style={styles.sectionLabel}>选项卡</Text>
          <View style={styles.tabList}>
            {navigation.map(({ label, icon: Icon, hint }) => {
              const active = label === activeTab;
              return (
                <Pressable
                  key={label}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityHint={hint}
                  accessibilityState={{ selected: active }}
                  aria-selected={active}
                  onPress={() => onSelectTab(label)}
                  style={({ pressed }) => [styles.tabRow, active && styles.tabRowActive, pressed && styles.pressed]}
                  testID={`drawer-tab-${label}`}
                >
                  <Icon size={22} strokeWidth={1.8} color={colors.text} />
                  <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>旁聊</Text>
          <View style={styles.empty} testID="drawer-side-chats-empty">
            <Text style={styles.emptyTitle}>还没有旁聊</Text>
            <Text style={styles.emptyHint}>旁聊会独立于主聊天，稍后开放。</Text>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint={onOpenSettings ? "Open settings" : "Coming soon"}
            accessibilityState={{ disabled: !onOpenSettings }}
            disabled={!onOpenSettings}
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.footerButton, pressed && styles.pressed]}
          >
            <Settings size={20} strokeWidth={1.8} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New side chat"
            accessibilityHint={onNewSideChat ? "Create a side chat" : "Coming soon"}
            accessibilityState={{ disabled: !onNewSideChat }}
            disabled={!onNewSideChat}
            onPress={onNewSideChat}
            style={({ pressed }) => [styles.footerButton, styles.footerPrimary, pressed && styles.pressed]}
          >
            <SquarePen size={20} strokeWidth={1.8} color={colors.text} />
          </Pressable>
        </View>
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
    zIndex: 20,
  },
  panel: {
    position: "absolute",
    left: PANEL_INSET,
    borderRadius: 30,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    shadowColor: "#132631",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 28,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -1,
    color: colors.text,
  },
  close: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.line,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 16,
  },
  sectionLabel: {
    paddingHorizontal: 10,
    marginBottom: 8,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.2,
    color: colors.muted,
  },
  tabList: {
    gap: 2,
  },
  tabRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  tabRowActive: {
    backgroundColor: "#F0F1F2",
  },
  tabLabel: {
    fontSize: 17,
    fontWeight: "500",
    letterSpacing: -0.2,
    color: colors.text,
  },
  tabLabelActive: {
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.7,
  },
  divider: {
    height: 1,
    marginHorizontal: 10,
    marginVertical: 16,
    backgroundColor: colors.line,
  },
  empty: {
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 4,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.text,
  },
  emptyHint: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  footerButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 23,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.line,
  },
  footerPrimary: {
    backgroundColor: colors.card,
  },
});
