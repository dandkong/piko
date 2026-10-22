import { Menu } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Keyboard, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, type SharedValue, withTiming } from "react-native-reanimated";
import { navigation, type AppTab } from "../navigation";
import { colors, drawerLayout, motion, radii } from "../theme";
import { EdgeFade, FOOTER_FADE_OVERHANG, HEADER_FADE_TAIL } from "./EdgeFade";
import { IconButton } from "./IconButton";
import { TactilePressable } from "./TactilePressable";

const KEYBOARD_COMPOSER_GAP = 10;
export type { AppTab };

export function AppShell({ children, composer, drawer, menuOpen, onOpenMenu, onCloseMenu, wide, status, headerHeight, footerHeight, onHeaderHeightChange, onFooterHeightChange, keyboardLift, onKeyboardLiftChange, activeTab = "Chat", onTabChange }: {
  children: ReactNode;
  composer: ReactNode;
  drawer?: ReactNode;
  menuOpen?: boolean;
  onOpenMenu?: () => void;
  onCloseMenu?: () => void;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  wide: boolean;
  status: string;
  headerHeight: number;
  footerHeight: number;
  onHeaderHeightChange: (height: number) => void;
  onFooterHeightChange: (height: number) => void;
  keyboardLift: SharedValue<number>;
  onKeyboardLiftChange: (lift: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [tabsHeight, setTabsHeight] = useState(0);
  const keyboardDuration = useRef(250);
  const horizontalPadding = wide ? 42 : 17;
  const drawerProgress = useSharedValue(0);
  const drawerPush = Math.min(drawerLayout.maxWidth, width * drawerLayout.widthRatio) + drawerLayout.inset;
  const keyboardLiftAmount = keyboardHeight > 0
    ? Math.max(0, keyboardHeight - tabsHeight) + KEYBOARD_COMPOSER_GAP
    : 0;
  const composerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));
  const pushedSurfaceStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(drawerProgress.value, [0, 1], [0, drawerPush]) },
      { scale: interpolate(drawerProgress.value, [0, 1], [1, drawerLayout.pushScale]) },
    ],
    borderRadius: interpolate(drawerProgress.value, [0, 1], [0, radii.panel]),
    shadowOpacity: interpolate(drawerProgress.value, [0, 1], [0, 0.14]),
    shadowRadius: interpolate(drawerProgress.value, [0, 1], [0, 18]),
    elevation: interpolate(drawerProgress.value, [0, 1], [0, 12]),
  }));
  const clippedSurfaceStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(drawerProgress.value, [0, 1], [0, radii.panel]),
  }));

  useEffect(() => {
    drawerProgress.value = withTiming(menuOpen ? 1 : 0, {
      duration: menuOpen ? motion.drawerIn : motion.drawerOut,
      easing: menuOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    });
  }, [drawerProgress, menuOpen]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, event => {
      keyboardDuration.current = event.duration > 0 ? event.duration : 250;
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvent, event => {
      keyboardDuration.current = event.duration > 0 ? event.duration : 250;
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    keyboardLift.value = withTiming(keyboardLiftAmount, { duration: keyboardDuration.current });
    onKeyboardLiftChange(keyboardLiftAmount);
  }, [keyboardLift, keyboardLiftAmount, onKeyboardLiftChange]);
  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <View style={styles.keyboardArea}>
        <View style={styles.shell}>
          {drawer}
          <Animated.View style={[styles.pushedSurface, pushedSurfaceStyle]}>
            <Animated.View
              style={[styles.pushedContent, clippedSurfaceStyle]}
              accessibilityElementsHidden={!!menuOpen}
              importantForAccessibility={menuOpen ? "no-hide-descendants" : "auto"}
            >
              <View style={[styles.content, { paddingHorizontal: horizontalPadding }]}>{children}</View>
              <EdgeFade edge="top" height={headerHeight + HEADER_FADE_TAIL} />
              <EdgeFade edge="bottom" height={footerHeight + FOOTER_FADE_OVERHANG} />
              <AgentHeader
                wide={wide}
                topInset={insets.top}
                status={status}
                menuOpen={!!menuOpen}
                onOpenMenu={onOpenMenu}
                onHeightChange={height => onHeaderHeightChange(height + insets.top)}
              />
              <View
                testID="chat-footer-overlay"
                pointerEvents="box-none"
                onLayout={({ nativeEvent: { layout } }) => onFooterHeightChange(layout.height)}
                style={styles.footer}
              >
                <Animated.View style={composerAnimatedStyle}>
                  <View style={{ paddingHorizontal: horizontalPadding }}>{composer}</View>
                </Animated.View>
                <BottomTabs wide={wide} onHeightChange={setTabsHeight} activeTab={activeTab} onTabChange={onTabChange} />
              </View>
            </Animated.View>
            {!!menuOpen && <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close navigation"
              onPress={onCloseMenu}
              style={styles.closePushedSurface}
              testID="navigation-drawer-close-surface"
            />}
          </Animated.View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function Mascot({ size }: { size: number }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={{
        position: "absolute", top: size * 0.15, left: size * 0.12,
        width: size * 0.76, height: size * 0.76, borderRadius: size, backgroundColor: "#ECF5FA",
      }} />
      <Image
        source={require("../../assets/capybara.png")}
        resizeMode="contain"
        style={{ width: size, height: size }}
        accessible={false}
      />
    </View>
  );
}

function AgentHeader({ wide, topInset, status, menuOpen, onOpenMenu, onHeightChange }: {
  wide: boolean;
  topInset: number;
  status: string;
  menuOpen: boolean;
  onOpenMenu?: () => void;
  onHeightChange: (height: number) => void;
}) {
  return (
    <View
      testID="chat-header-overlay"
      pointerEvents="box-none"
      onLayout={({ nativeEvent: { layout } }) => onHeightChange(layout.height)}
      style={[styles.header, { top: topInset }]}
    >
      <IconButton
        accessibilityState={{ expanded: menuOpen }}
        label="Open navigation"
        onPress={onOpenMenu}
        style={styles.headerButton}
      >
        <Menu size={20} strokeWidth={1.8} color={colors.text} />
      </IconButton>
      <View pointerEvents="none" style={styles.identity}>
        <Mascot size={wide ? 58 : 49} />
        <View testID="chat-identity-capsule" style={styles.identityCapsule}>
          <Text style={styles.name}>Piko</Text>
          {status ? <Text testID="chat-activity-status" numberOfLines={1} accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
        </View>
      </View>
    </View>
  );
}

function BottomTabs({ wide, onHeightChange, activeTab, onTabChange }: { wide: boolean; onHeightChange: (height: number) => void; activeTab: AppTab; onTabChange?: (tab: AppTab) => void }) {
  return (
    <View onLayout={({ nativeEvent: { layout } }) => onHeightChange(layout.height)} style={[styles.tabBarWrap, { paddingBottom: wide ? 22 : 7 }]}>
      <View style={styles.tabBar}>
        {navigation.map(({ label, icon: Icon, hint }) => {
          const active = label === activeTab;
          const enabled = !!onTabChange;
          return (
            <TactilePressable
              key={label}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityHint={enabled ? hint : "Coming soon"}
              accessibilityState={{ selected: active }}
              disabled={!enabled}
              onPress={() => onTabChange?.(label)}
              scaleTo={0.92}
              selected={active}
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.canvas,
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
    overflow: "hidden",
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
    borderRadius: 999,
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
    paddingTop: KEYBOARD_COMPOSER_GAP,
    alignItems: "center",
  },
  tabBar: {
    flexDirection: "row",
    width: "100%",
    maxWidth: 370,
    padding: 5,
    backgroundColor: colors.card,
    borderRadius: 40,
    shadowColor: "#132631",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 3,
    borderWidth: 1,
    borderColor: "#F8F8F8",
  },
  tab: {
    flex: 1,
    height: 47,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
  },
  tabFace: {
    width: "100%",
    height: "100%",
    borderRadius: 28,
  },
});
