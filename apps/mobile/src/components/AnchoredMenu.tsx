import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../theme";
import { TactilePressable } from "./TactilePressable";

export type AnchoredMenuAction = {
  id: string;
  label: string;
  accessibilityLabel: string;
  icon: ReactNode;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  hint?: string;
};

/** Menu content shared by row overflow menus while the caller owns the Modal lifecycle. */
export function AnchoredMenuContent({
  left,
  top,
  width = 176,
  closeLabel,
  onClose,
  actions,
  testID,
}: {
  left: number;
  top: number;
  width?: number;
  closeLabel: string;
  onClose: () => void;
  actions: AnchoredMenuAction[];
  testID?: string;
}) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />
      <View accessibilityRole="menu" testID={testID} style={[styles.menu, { left, top, width }]}>
        {actions.map(action => (
          <TactilePressable
            key={action.id}
            accessibilityRole="menuitem"
            accessibilityLabel={action.accessibilityLabel}
            accessibilityHint={action.hint}
            disabled={action.disabled}
            variant="plain"
            scaleTo={1}
            faceStyle={styles.item}
            testID={testID ? `${testID}-item-${action.id}` : undefined}
            onPress={action.onPress}
          >
            {action.icon}
            <Text style={[styles.label, action.destructive && styles.destructive]}>{action.label}</Text>
          </TactilePressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: "absolute",
    padding: 6,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.card,
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 8,
  },
  item: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 12,
    gap: 10,
    borderRadius: radii.control,
  },
  label: { color: colors.text, fontSize: 15 },
  destructive: { color: colors.danger, fontWeight: "500" },
});
