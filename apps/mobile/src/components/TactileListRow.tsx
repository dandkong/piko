import { createContext, useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radii, stateColors } from "../theme";

export const TactileListRowContext = createContext<((pressed: boolean) => void) | null>(null);

type Props = {
  children: ReactNode;
  surfaceVariant?: "card" | "compact";
  selected?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** One shared hover/press surface for a list row with multiple independent actions. */
export function TactileListRow({ children, surfaceVariant = "card", selected = false, disabled = false, style }: Props) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (!disabled) return;
    setHovered(false);
    setPressed(false);
  }, [disabled]);

  const stateStyle = disabled ? null
    : pressed ? selected ? styles.selectedPressed
      : styles.pressed
      : hovered ? selected ? styles.selectedHover
        : styles.hover
        : selected ? styles.selected : null;

  return (
    <TactileListRowContext.Provider value={setPressed}>
      <View
        onPointerEnter={() => { if (!disabled) setHovered(true); }}
        onPointerLeave={() => setHovered(false)}
        style={[styles.row, style]}
      >
        <View pointerEvents="none" style={[styles.surface, surfaceVariant === "card" ? styles.cardSurface : styles.compactSurface, stateStyle]} />
        {children}
      </View>
    </TactileListRowContext.Provider>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    position: "relative",
  },
  surface: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  cardSurface: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
  },
  compactSurface: {
    backgroundColor: "transparent",
    borderRadius: radii.control,
  },
  hover: {
    backgroundColor: stateColors.hover,
  },
  pressed: {
    backgroundColor: stateColors.pressed,
  },
  selected: {
    backgroundColor: stateColors.selected,
  },
  selectedHover: {
    backgroundColor: stateColors.selectedHover,
  },
  selectedPressed: {
    backgroundColor: stateColors.selectedPressed,
  },
});
