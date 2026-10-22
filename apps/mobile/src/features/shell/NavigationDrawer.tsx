import { Settings, SquarePen, X } from "lucide-react-native";
import { useEffect } from "react";
import {
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { navigation, type AppTab } from "../../navigation";
import { colors, drawerLayout, radii } from "../../theme";
import { IconButton } from "../../components/IconButton";
import { TactilePressable } from "../../components/TactilePressable";
import { SideChatList, type SideChatActions } from "./SideChatList";

/** Underlay navigation layer: the app surface moves aside to reveal tabs and side chats. */
export function NavigationDrawer({
  open,
  activeTab,
  onSelectTab,
  onClose,
  onOpenSettings,
  ...sideChatActions
}: SideChatActions & {
  open: boolean;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const panelWidth = Math.min(
    drawerLayout.maxWidth,
    width * drawerLayout.widthRatio,
  );
  useEffect(() => {
    if (!open) return;
    if (Platform.OS === "android") {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          onClose();
          return true;
        },
      );
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

  return (
    <View
      pointerEvents={open ? "auto" : "none"}
      style={styles.underlay}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      <View
        accessibilityViewIsModal={open}
        style={[
          styles.panel,
          {
            width: panelWidth,
            top: insets.top + drawerLayout.inset,
            bottom: insets.bottom + drawerLayout.inset,
          },
        ]}
        testID="navigation-drawer"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Piko</Text>
          <IconButton label="Close navigation" onPress={onClose} size="sm">
            <X size={18} strokeWidth={1.8} color={colors.muted} />
          </IconButton>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
        >
          <Text style={styles.sectionLabel}>选项卡</Text>
          <View style={styles.tabList}>
            {navigation.map(({ label, icon: Icon, hint }) => {
              const active =
                label === activeTab &&
                !(label === "Chat" && sideChatActions.activeSideChatId);
              return (
                <TactilePressable
                  key={label}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityHint={hint}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelectTab(label)}
                  scaleTo={1}
                  selected={active}
                  style={styles.tabRowHit}
                  faceStyle={styles.tabRow}
                  testID={`drawer-tab-${label}`}
                  variant="plain"
                >
                  <Icon size={22} strokeWidth={1.8} color={colors.text} />
                  <Text
                    style={[styles.tabLabel, active && styles.tabLabelActive]}
                  >
                    {label}
                  </Text>
                </TactilePressable>
              );
            })}
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>旁聊</Text>
          <SideChatList {...sideChatActions} />
        </ScrollView>

        <View style={styles.footer}>
          <IconButton
            hint={onOpenSettings ? "Open settings" : "Coming soon"}
            label="Settings"
            onPress={onOpenSettings}
          >
            <Settings size={20} strokeWidth={1.8} color={colors.text} />
          </IconButton>
          <IconButton
            hint="Create an independent side chat"
            label="New side chat"
            onPress={
              sideChatActions.onCreateSideChat && !sideChatActions.sideChatBusy
                ? () => void sideChatActions.onCreateSideChat?.()
                : undefined
            }
            variant="primary"
          >
            <SquarePen size={20} strokeWidth={1.8} color={colors.text} />
          </IconButton>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  underlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 0,
  },
  panel: {
    position: "absolute",
    left: drawerLayout.inset,
    borderRadius: radii.panel,
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
  tabRowHit: {
    width: "100%",
  },
  tabRow: {
    width: "100%",
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 14,
    paddingHorizontal: 14,
    borderRadius: radii.card,
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
});
