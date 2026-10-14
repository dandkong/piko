import {
  Bell,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";
import { EdgeFade, EDGE_FADE_HEIGHT } from "./EdgeFade";

export function AppShell({ children, composer, wide, status, onHeaderHeightChange, onFooterHeightChange }: {
  children: ReactNode;
  composer: ReactNode;
  wide: boolean;
  status: string;
  onHeaderHeightChange: (height: number) => void;
  onFooterHeightChange: (height: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const horizontalPadding = wide ? 42 : 17;
  return (
    <SafeAreaView style={styles.safeArea} edges={["left", "right"]}>
      <KeyboardAvoidingView style={styles.keyboardArea} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.shell}>
          <View style={[styles.content, { paddingHorizontal: horizontalPadding }]}>{children}</View>
          <AgentHeader wide={wide} topInset={insets.top} status={status} onHeightChange={onHeaderHeightChange} />
          <View
            testID="chat-footer-overlay"
            pointerEvents="box-none"
            onLayout={({ nativeEvent: { layout } }) => onFooterHeightChange(layout.height)}
            style={[styles.footer, { paddingBottom: insets.bottom }]}
          >
            <EdgeFade edge="bottom" />
            <View style={{ paddingHorizontal: horizontalPadding }}>{composer}</View>
            <BottomTabs wide={wide} />
          </View>
        </View>
      </KeyboardAvoidingView>
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
      style={[styles.header, { paddingTop: topInset + (wide ? 14 : 2) }]}
    >
      <EdgeFade edge="top" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Menu — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { left: 20, top: topInset + 16 }]}
      >
        <Menu size={20} strokeWidth={1.8} color={colors.text} />
      </Pressable>
      <View pointerEvents="none" style={styles.identity}>
        <Mascot size={wide ? 58 : 49} />
        <Text style={styles.name}>Piko</Text>
        <Text numberOfLines={1} style={styles.status}>{status}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Notifications — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { right: 20, top: topInset + 16 }]}
      >
        <Bell size={20} strokeWidth={1.8} color={colors.text} />
      </Pressable>
    </View>
  );
}

function BottomTabs({ wide }: { wide: boolean }) {
  return (
    <View style={[styles.tabBarWrap, { paddingBottom: wide ? 22 : 7 }]}>
      <View style={styles.tabBar}>
        {navigation.map(({ label, icon: Icon }) => {
          const active = label === "Chat";
          return (
            <Pressable
              key={label}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityHint={active ? "Current conversation" : "Coming soon"}
              accessibilityState={{ selected: active, disabled: !active }}
              aria-selected={active}
              disabled={!active}
              style={[styles.tab, active && styles.activeTab]}
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
    paddingBottom: 10 + EDGE_FADE_HEIGHT,
  },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    paddingTop: EDGE_FADE_HEIGHT,
  },
  identity: {
    alignItems: "center",
    alignSelf: "center",
    maxWidth: "70%",
    gap: 1,
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
  activeTab: {
    backgroundColor: "#F0F1F2",
  },
});
