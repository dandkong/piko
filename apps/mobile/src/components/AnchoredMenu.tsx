import type { ReactNode } from "react";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../theme";
import { TactilePressable } from "./TactilePressable";

export type AnchoredMenuAction = {
  id: string;
  label: string;
  accessibilityLabel: string;
  icon?: ReactNode;
  /** Supplying a boolean for every action makes this a single-choice menu. */
  selected?: boolean;
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
  label,
  onClose,
  actions,
  testID,
}: {
  left: number;
  top: number;
  width?: number;
  closeLabel: string;
  label?: string;
  onClose: () => void;
  actions: AnchoredMenuAction[];
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemeStyles(createStyles);
  const singleChoice = actions.length > 0 && actions.every(action => action.selected !== undefined);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />
      <View accessibilityRole={singleChoice ? "radiogroup" : "menu"} accessibilityLabel={label} testID={testID} style={[styles.menu, singleChoice && styles.choiceMenu, { left, top, width }]}>
        {actions.map(action => (
          <TactilePressable
            key={action.id}
            accessibilityRole={singleChoice ? "radio" : "menuitem"}
            accessibilityState={singleChoice ? { checked: action.selected } : undefined}
            selected={action.selected}
            accessibilityLabel={action.accessibilityLabel}
            accessibilityHint={action.hint}
            disabled={action.disabled}
            variant="plain"
            scaleTo={1}
            faceStyle={[styles.item, singleChoice && styles.choiceItem]}
            testID={testID ? `${testID}-item-${action.id}` : undefined}
            onPress={action.onPress}
          >
            {singleChoice
              ? <View style={styles.checkSlot}>{action.selected && <Check size={18} strokeWidth={1.8} color={colors.text} />}</View>
              : action.icon}
            <Text style={[styles.label, action.destructive && styles.destructive]}>{action.label}</Text>
          </TactilePressable>
        ))}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
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
  choiceMenu: { padding: 0, overflow: "hidden" },
  choiceItem: { borderRadius: 0 },
  checkSlot: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  label: { color: colors.text, fontSize: 15 },
  destructive: { color: colors.danger, fontWeight: "500" },
  });
}
