import type { ReactNode } from "react";
import { StyleSheet, type AccessibilityState, type StyleProp, type ViewStyle } from "react-native";
import { controlSizes } from "../theme";
import { TactilePressable, type PressableVariant } from "./TactilePressable";

type Props = {
  children: ReactNode;
  label: string;
  onPress?: () => void;
  variant?: PressableVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  hint?: string;
  accessibilityState?: AccessibilityState;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/** Circular icon control. The icon itself is passed as children so size and fill stay explicit. */
export function IconButton({
  children,
  label,
  onPress,
  variant = "card",
  size = "md",
  disabled = false,
  hint,
  accessibilityState,
  testID,
  style,
}: Props) {
  const faceSize = controlSizes[size];
  const unavailable = disabled || !onPress;
  return (
    <TactilePressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={size === "sm" ? 8 : undefined}
      onPress={onPress}
      scaleTo={variant === "primary" ? 0.95 : 0.94}
      style={[{ width: faceSize, height: faceSize }, style]}
      faceStyle={[styles.face, { width: faceSize, height: faceSize, borderRadius: faceSize / 2 }]}
      testID={testID}
      variant={unavailable && variant === "primary" ? "soft" : variant}
    >
      {children}
    </TactilePressable>
  );
}

const styles = StyleSheet.create({
  face: {
    alignItems: "center",
    justifyContent: "center",
  },
});
