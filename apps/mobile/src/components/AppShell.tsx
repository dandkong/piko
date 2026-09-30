import {
  Bell,
  Lightbulb,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../theme";

export function AppShell({ children, wide, status }: { children: ReactNode; wide: boolean; status: string }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
      <View style={styles.shell}>
        <AgentHeader wide={wide} status={status} />
        <View style={[styles.content, { paddingHorizontal: wide ? 42 : 17 }]}>{children}</View>
        <BottomTabs wide={wide} />
      </View>
    </SafeAreaView>
  );
}

const navigation = [
  { label: "Chat", icon: MessageCircle },
  { label: "Activity", icon: PanelsTopLeft },
  { label: "Ideas", icon: Lightbulb },
  { label: "Goals", icon: SquareCheck },
  { label: "Apps", icon: Shapes },
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

function AgentHeader({ wide, status }: { wide: boolean; status: string }) {
  return (
    <View style={[styles.header, { height: wide ? 146 : 122, paddingTop: wide ? 14 : 2 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Menu — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { left: 0 }]}
      >
        <Menu size={20} strokeWidth={1.8} color={colors.text} />
      </Pressable>
      <View style={styles.identity}>
        <Mascot size={wide ? 58 : 49} />
        <Text style={styles.name}>Piko</Text>
        <Text numberOfLines={1} style={styles.status}>{status}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Notifications — coming soon"
        accessibilityState={{ disabled: true }}
        disabled
        style={[styles.headerButton, { right: 0 }]}
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
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    marginHorizontal: 20,
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
    marginBottom: 6,
  },
  headerButton: {
    position: "absolute",
    top: 16,
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
