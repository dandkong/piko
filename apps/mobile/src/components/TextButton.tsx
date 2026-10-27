import type { ReactNode } from "react";
import { StyleSheet, type AccessibilityState, type StyleProp, type ViewStyle } from "react-native";
import { radii } from "../theme";
import { TactilePressable, type PressableVariant } from "./TactilePressable";

type Props = {
  children: ReactNode;
  label: string;
  onPress?: () => void;
  variant?: PressableVariant;
  disabled?: boolean;
  accessibilityState?: AccessibilityState;
  hint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  faceStyle?: StyleProp<ViewStyle>;
};

/** Compact text action used by retry, back, and other inline controls. */
export function TextButton({
  children,
  label,
  onPress,
  variant = "soft",
  disabled = false,
  accessibilityState,
  hint,
  testID,
  style,
  faceStyle,
}: Props) {
  return (
    <TactilePressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      scaleTo={0.97}
      style={style}
      faceStyle={[styles.face, faceStyle]}
      testID={testID}
      variant={variant}
    >
      {children}
    </TactilePressable>
  );
}

const styles = StyleSheet.create({
  face: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.control,
  },
});
