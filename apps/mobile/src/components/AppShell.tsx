import {
  Menu,
  Settings,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
} from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, useAnimatedStyle, useSharedValue, type SharedValue, withTiming } from "react-native-reanimated";
import { colors } from "../theme";
import { EdgeFade, FOOTER_FADE_OVERHANG, HEADER_FADE_TAIL } from "./EdgeFade";

const KEYBOARD_COMPOSER_GAP = 10;
export type AppTab = "Chat" | "Posts" | "Artifacts" | "Tasks";

export function AppShell({ children, composer, wide, status, headerHeight, footerHeight, onHeaderHeightChange, onFooterHeightChange, keyboardLift, onKeyboardLiftChange, activeTab = "Chat", onTabChange }: {
  children: ReactNode;
  composer: ReactNode;
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
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [tabsHeight, setTabsHeight] = useState(0);
  const keyboardDuration = useRef(250);
  const horizontalPadding = wide ? 42 : 17;
  const keyboardLiftAmount = keyboardHeight > 0
    ? Math.max(0, keyboardHeight - tabsHeight) + KEYBOARD_COMPOSER_GAP
    : 0;
  const composerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));

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
          <View style={[styles.content, { paddingHorizontal: horizontalPadding }]}>{children}</View>
          <EdgeFade edge="top" height={headerHeight + HEADER_FADE_TAIL} />
          <EdgeFade edge="bottom" height={footerHeight + FOOTER_FADE_OVERHANG} />
          <AgentHeader
            wide={wide}
            topInset={insets.top}
            status={status}
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
        </View>
      </View>
    </SafeAreaView>
  );
}

const navigation = [
  { label: "Chat", icon: MessageCircle },
  { label: "Posts", icon: PanelsTopLeft },
  { label: "Artifacts", icon: Shapes },
  { label: "Tasks", icon: SquareCheck },
] as const;

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

function AgentHeader({ wide, topInset, status, onHeightChange }: {
  wide: boolean;
  topInset: number;
  status: string;
  onHeightChange: (height: number) => void;
}) {
  return (
    <View
      testID="chat-header-overlay"
      pointerEvents="box-none"
      onLayout={({ nativeEvent: { layout } }) => onHeightChange(layout.height)}
      style={[styles.header, { top: topInset }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Menu — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { left: 20, top: 16 }]}
      >
        <Menu size={20} strokeWidth={1.8} color={colors.text} />
      </Pressable>
      <View pointerEvents="none" style={styles.identity}>
        <Mascot size={wide ? 58 : 49} />
        <View testID="chat-identity-capsule" style={styles.identityCapsule}>
          <Text style={styles.name}>Piko</Text>
          {status ? <Text testID="chat-activity-status" numberOfLines={1} accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { right: 20, top: 16 }]}
      >
        <Settings size={20} strokeWidth={1.8} color={colors.text} />
      </Pressable>
    </View>
  );
}

const hints: Record<(typeof navigation)[number]["label"], string> = {
  Chat: "Main conversation",
  Posts: "Assistant posts",
  Artifacts: "Files and results",
  Tasks: "Recurring work",
};

function BottomTabs({ wide, onHeightChange, activeTab, onTabChange }: { wide: boolean; onHeightChange: (height: number) => void; activeTab: AppTab; onTabChange?: (tab: AppTab) => void }) {
  const index = Math.max(0, navigation.findIndex(item => item.label === activeTab));
  const [trackWidth, setTrackWidth] = useState(0);
  const position = useSharedValue(index);
  useEffect(() => {
    position.value = withTiming(index, { duration: 260, easing: Easing.out(Easing.cubic) });
  }, [index, position]);
  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value * (trackWidth / navigation.length) }],
  }));
  return (
    <View onLayout={({ nativeEvent: { layout } }) => onHeightChange(layout.height)} style={[styles.tabBarWrap, { paddingBottom: wide ? 22 : 7 }]}>
      <View style={styles.tabBar}
        onLayout={({ nativeEvent: { layout } }) => setTrackWidth(Math.max(0, layout.width - 10))}>
        <Animated.View pointerEvents="none"
          style={[styles.activePill, { width: trackWidth / navigation.length }, pillStyle]} />
        {navigation.map(({ label, icon: Icon }) => {
          const active = label === activeTab;
          const enabled = !!onTabChange;
          return (
            <Pressable
              key={label}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityHint={enabled ? hints[label] : "Coming soon"}
              accessibilityState={{ selected: active, disabled: !enabled }}
              aria-selected={active}
              disabled={!enabled}
              onPress={() => onTabChange?.(label)}
              style={styles.tab}
            >
              <Icon size={23} strokeWidth={1.8} color={colors.text} />
            </Pressable>
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
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
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
  activePill: {
    position: "absolute",
    top: 5,
    left: 5,
    height: 47,
    borderRadius: 28,
    backgroundColor: "#F0F1F2",
  },
});
