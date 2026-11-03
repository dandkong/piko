import { Menu } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { navigation, type AppTab } from "../../navigation";
import { motion, radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";
import {
  EdgeFade,
  FOOTER_FADE_OVERHANG,
  HEADER_FADE_TAIL,
} from "../../components/EdgeFade";
import { IconButton } from "../../components/IconButton";
import { FeedbackToast, type FeedbackToastMessage } from "../../components/FeedbackToast";
import { TactilePressable } from "../../components/TactilePressable";
import { useDrawerTransition } from "./useDrawerTransition";
export type { AppTab };

export function AppShell({
  children,
  composer,
  drawer,
  sheet,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  wide,
  status,
  toastMessage,
  headerHeight,
  footerHeight,
  onHeaderHeightChange,
  onFooterHeightChange,
  activeTab = "Chat",
  onTabChange,
}: {
  children: ReactNode;
  composer: ReactNode;
  drawer?: ReactNode;
  sheet?: ReactNode;
  menuOpen?: boolean;
  onOpenMenu?: () => void;
  onCloseMenu?: () => void;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  wide: boolean;
  status: string;
  toastMessage?: FeedbackToastMessage;
  headerHeight: number;
  footerHeight: number;
  onHeaderHeightChange: (height: number) => void;
  onFooterHeightChange: (height: number) => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // Align every page with the top-left menu button; no width-dependent inset.
  const horizontalPadding = 20;
  const transition = useDrawerTransition(!!menuOpen, width);
  return (
    <SafeAreaView
      style={[styles.safeArea, wide && styles.safeAreaWide]}
      edges={[]}
    >
      <View style={styles.keyboardArea}>
        <View style={styles.shell}>
          {transition.mounted && drawer}
          <Animated.View
            style={[styles.pushedSurface, transition.surfaceStyle]}
          >
            <View
              style={styles.pushedContent}
              accessibilityElementsHidden={!!menuOpen}
              importantForAccessibility={
                menuOpen ? "no-hide-descendants" : "auto"
              }
            >
              <View
                style={[
                  styles.content,
                  { paddingHorizontal: horizontalPadding },
                ]}
              >
                {children}
              </View>
              <EdgeFade edge="top" height={headerHeight + HEADER_FADE_TAIL} />
              <EdgeFade
                edge="bottom"
                height={footerHeight + FOOTER_FADE_OVERHANG}
              />
              <AgentHeader
                topInset={insets.top}
                status={status}
                menuOpen={!!menuOpen}
                onOpenMenu={onOpenMenu}
                onHeightChange={(height) =>
                  onHeaderHeightChange(height + insets.top)
                }
              />
              <View
                testID="chat-footer-overlay"
                pointerEvents="box-none"
                onLayout={({ nativeEvent: { layout } }) =>
                  onFooterHeightChange(layout.height)
                }
                style={styles.footer}
              >
                <View style={{ paddingHorizontal: horizontalPadding }}>
                  {composer}
                </View>
                <BottomTabs
                  activeTab={activeTab}
                  onTabChange={onTabChange}
                />
              </View>
            </View>
            {!!menuOpen && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭导航"
                onPress={onCloseMenu}
                style={styles.closePushedSurface}
                testID="navigation-drawer-close-surface"
              />
            )}
          </Animated.View>
          {sheet}
          {toastMessage ? <FeedbackToast feedback={toastMessage} top={insets.top + 78} /> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function Mascot({ size }: { size: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.15,
          left: size * 0.12,
          width: size * 0.76,
          height: size * 0.76,
          borderRadius: size,
          backgroundColor: colors.mascot,
        }}
      />
      <Image
        source={require("../../../assets/capybara.png")}
        resizeMode="contain"
        style={{ width: size, height: size }}
        accessible={false}
      />
    </View>
  );
}

function AgentHeader({
  topInset,
  status,
  menuOpen,
  onOpenMenu,
  onHeightChange,
}: {
  topInset: number;
  status: string;
  menuOpen: boolean;
  onOpenMenu?: () => void;
  onHeightChange: (height: number) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View
      testID="chat-header-overlay"
      pointerEvents="box-none"
      onLayout={({ nativeEvent: { layout } }) => onHeightChange(layout.height)}
      style={[styles.header, { top: topInset }]}
    >
      <IconButton
        accessibilityState={{ expanded: menuOpen }}
        label="打开导航"
        onPress={onOpenMenu}
        style={styles.headerButton}
      >
        <Menu size={20} strokeWidth={1.8} color={colors.text} />
      </IconButton>
      <View pointerEvents="none" style={styles.identity}>
        <Mascot size={50} />
        <View testID="chat-identity-capsule" style={styles.identityCapsule}>
          <Text style={styles.name}>Piko</Text>
          {status ? (
            <Text
              testID="chat-activity-status"
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              style={styles.status}
            >
              {status}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function BottomTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: AppTab;
  onTabChange?: (tab: AppTab) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const index = Math.max(
    0,
    navigation.findIndex((item) => item.label === activeTab),
  );
  const [trackWidth, setTrackWidth] = useState(0);
  const position = useSharedValue(index);
  useEffect(() => {
    position.value = withTiming(index, {
      duration: reduceMotion ? 0 : motion.tabSlide,
      easing: Easing.out(Easing.cubic),
    });
  }, [index, position, reduceMotion]);
  const tabWidth = trackWidth / navigation.length;
  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value * tabWidth }],
  }));
  return (
    <View style={[styles.tabBarWrap, { paddingBottom: 22 }]}>
      <View
        style={styles.tabBar}
        onLayout={({ nativeEvent: { layout } }) =>
          setTrackWidth(Math.max(0, layout.width - 10))
        }
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.activePill,
            { width: trackWidth / navigation.length },
            pillStyle,
          ]}
        />
        {navigation.map(({ label, title, icon: Icon, hint }) => {
          const active = label === activeTab;
          const enabled = !!onTabChange;
          return (
            <TactilePressable
              key={label}
              accessibilityRole="tab"
              accessibilityLabel={title}
              accessibilityHint={enabled ? hint : "即将开放"}
              accessibilityState={{ selected: active }}
              disabled={!enabled}
              onPress={() => onTabChange?.(label)}
              scaleTo={0.92}
              selected={active}
              stateFill={false}
              style={styles.tab}
              faceStyle={styles.tabFace}
              variant="plain"
            >
              <Icon size={23} strokeWidth={1.8} color={colors.text} />
            </TactilePressable>
          );
        })}
      </View>
    </View>
  );
}

function useStyles() {
  return useThemeStyles(createStyles);
}

function createStyles(colors: ThemeColors, stateColors: ThemeStateColors) {
  return StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  /** Wide screens keep the phone column, with the desk visible at the sides. */
  safeAreaWide: {
    backgroundColor: colors.desk,
  },
  shell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    overflow: "hidden",
  },
  pushedSurface: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
    backgroundColor: colors.canvas,
  },
  pushedContent: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.canvas,
  },
  closePushedSurface: {
    ...StyleSheet.absoluteFill,
  },
  keyboardArea: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    paddingHorizontal: 20,
  },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
  },
  identity: {
    alignItems: "center",
    alignSelf: "center",
    width: "70%",
    gap: 4,
  },
  identityCapsule: {
    alignItems: "center",
    maxWidth: "100%",
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  name: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
    letterSpacing: -0.4,
  },
  status: {
    fontSize: 11,
    color: colors.muted,
  },
  headerButton: {
    position: "absolute",
    left: 20,
    top: 16,
  },
  tabBarWrap: {
    paddingHorizontal: 22,
    paddingTop: 10,
    alignItems: "center",
  },
  tabBar: {
    flexDirection: "row",
    width: "100%",
    maxWidth: 370,
    padding: 5,
    backgroundColor: colors.card,
    borderRadius: radii.pill,
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 3,
    borderWidth: 1,
    borderColor: colors.line,
  },
  activePill: {
    position: "absolute",
    top: 5,
    left: 5,
    height: 47,
    borderRadius: radii.pill,
    backgroundColor: stateColors.selected,
  },
  tab: {
    flex: 1,
    height: 47,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  tabFace: {
    width: "100%",
    height: "100%",
    borderRadius: radii.pill,
  },
  });
}
