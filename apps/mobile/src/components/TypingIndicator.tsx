import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../theme";

const pulse = { duration: 240, easing: Easing.inOut(Easing.quad) };
const delays = [0, 140, 280];

function TypingDot({ delay }: { delay: number }) {
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withDelay(delay, withRepeat(withSequence(
      withTiming(1, pulse),
      withTiming(0, pulse),
      withDelay(500, withTiming(0, { duration: 0 })),
    ), -1, false));
    return () => cancelAnimation(progress);
  }, [delay, progress, reducedMotion]);

  // Keep the pulse visual-only: transforms can change Web scroll overflow bounds
  // while the typing indicator sits at the end of a chat list.
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + progress.value * 0.5,
  }));

  return <Animated.View testID="typing-dot" style={[styles.dot, animatedStyle]} />;
}

/** Mount only while waiting for text; unmounting cancels all three loops. */
export function TypingIndicator() {
  return (
    <View testID="typing-indicator" style={styles.row}>
      {delays.map((delay) => <TypingDot key={delay} delay={delay} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted },
});
