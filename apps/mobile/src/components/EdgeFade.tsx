import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../theme";

export const EDGE_FADE_HEIGHT = 32;

/** The same canvas-colored fade at both edges; decoration never captures list gestures. */
export function EdgeFade({ edge }: { edge: "top" | "bottom" }) {
  const id = `chat-edge-${edge}`;
  return (
    <View
      testID={`chat-${edge}-fade`}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0%" x2="0%" y1={edge === "top" ? "0%" : "100%"} y2={edge === "top" ? "100%" : "0%"}>
            <Stop offset="0%" stopColor={colors.canvas} stopOpacity={1} />
            <Stop offset="35%" stopColor={colors.canvas} stopOpacity={0.96} />
            <Stop offset="70%" stopColor={colors.canvas} stopOpacity={0.45} />
            <Stop offset="100%" stopColor={colors.canvas} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
