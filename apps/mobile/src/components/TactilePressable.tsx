import { useEffect, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  type AccessibilityState,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors, motion, stateColors } from "../theme";

export type PressableVariant = "card" | "soft" | "plain" | "primary";

type FocusEvent = Parameters<NonNullable<PressableProps["onFocus"]>>[0];

type Props = {
  children?: ReactNode;
  variant?: PressableVariant;
  scaleTo?: number;
  disabled?: boolean;
  selected?: boolean;
  /** Opt out of hover/press/selected backgrounds when a sibling owns the fill. */
  stateFill?: boolean;
  onPress?: () => void;
  accessibilityRole?: PressableProps["accessibilityRole"];
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  testID?: string;
  hitSlop?: PressableProps["hitSlop"];
  style?: StyleProp<ViewStyle>;
  faceStyle?: StyleProp<ViewStyle>;
};

/** Shared press, hover, focus, selected, and disabled behavior for every control. */
export function TactilePressable({
  children,
  variant = "plain",
  scaleTo = 0.96,
  disabled = false,
  selected,
  stateFill = true,
  onPress,
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  testID,
  hitSlop,
  style,
  faceStyle,
}: Props) {
  const isDisabled = disabled || !onPress;
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);

  useEffect(() => {
    if (!isDisabled) return;
    setPressed(false);
    setHovered(false);
    scale.value = 1;
  }, [isDisabled, scale]);

  const animateScale = (value: number, duration: number) => {
    if (scaleTo === 1) return;
    scale.value = withTiming(value, {
      duration: reduceMotion ? 0 : duration,
      easing: Easing.out(Easing.cubic),
    });
  };

  const handleFocus = (event: FocusEvent) => {
    if (Platform.OS !== "web" || isDisabled) return;
    const target = event.currentTarget as unknown as { matches?: (selector: string) => boolean } | null;
    setFocusVisible(target?.matches ? target.matches(":focus-visible") : true);
  };

  const variantStyle =
    variant === "card" ? styles.card
      : variant === "soft" ? styles.soft
        : variant === "primary" ? styles.primary
          : styles.plain;
  const interactiveState = pressed
    ? selected ? styles.selectedPressed
      : variant === "primary" ? styles.primaryPressed
        : variant === "soft" ? styles.softPressed
          : styles.pressed
    : hovered
      ? selected ? styles.selectedHover
        : variant === "primary" ? styles.primaryHover
          : variant === "soft" ? styles.softHover
            : styles.hover
      : selected ? styles.selected : null;
  const stateStyle = isDisabled
    ? styles.disabled
    : stateFill ? interactiveState : null;
  const focusStyle = focusVisible ? styles.focus : null;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: isDisabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={isDisabled}
      hitSlop={hitSlop}
      onBlur={() => setFocusVisible(false)}
      onFocus={handleFocus}
      onHoverIn={() => { if (!isDisabled) setHovered(true); }}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      onPressIn={() => {
        setPressed(true);
        animateScale(scaleTo, motion.pressIn);
      }}
      onPressOut={() => {
        setPressed(false);
        animateScale(1, motion.pressOut);
      }}
      style={style}
      testID={testID}
    >
      <Animated.View style={[styles.face, variantStyle, stateStyle, focusStyle, animatedStyle, faceStyle]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  face: {
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  soft: {
    backgroundColor: stateColors.soft,
  },
  plain: {
    backgroundColor: "transparent",
  },
  primary: {
    backgroundColor: colors.blue,
  },
  hover: {
    backgroundColor: stateColors.hover,
  },
  pressed: {
    backgroundColor: stateColors.pressed,
  },
  softHover: {
    backgroundColor: stateColors.softHover,
  },
  softPressed: {
    backgroundColor: stateColors.softPressed,
  },
  primaryHover: {
    backgroundColor: stateColors.primaryHover,
  },
  primaryPressed: {
    backgroundColor: stateColors.primaryPressed,
  },
  selected: {
    backgroundColor: stateColors.selected,
  },
  selectedHover: {
    backgroundColor: "#E9EBEC",
  },
  selectedPressed: {
    backgroundColor: "#E4E7E8",
  },
  disabled: {
    opacity: stateColors.disabledOpacity,
  },
  focus: {
    outlineColor: stateColors.focus,
    outlineOffset: 2,
    outlineStyle: "solid",
    outlineWidth: 2,
  } as unknown as ViewStyle,
});
