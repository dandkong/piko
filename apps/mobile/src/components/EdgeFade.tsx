import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme } from "../theme";

export const HEADER_FADE_TAIL = 12;
export const FOOTER_FADE_OVERHANG = 32;

function canvasWithOpacity(canvas: string, opacity: number) {
  const match = canvas.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) throw new Error("Edge fades require a six-digit hex canvas color.");
  const [, red, green, blue] = match;
  return `rgba(${Number.parseInt(red!, 16)}, ${Number.parseInt(green!, 16)}, ${Number.parseInt(blue!, 16)}, ${opacity})`;
}

/** Native gradient overlay at both edges; decoration never captures list gestures. */
export function EdgeFade({ edge, height }: { edge: "top" | "bottom"; height: number }) {
  const { colors } = useTheme();
  const top = edge === "top";
  const gradientColors = top
    ? [canvasWithOpacity(colors.canvas, 1), canvasWithOpacity(colors.canvas, 0.96), canvasWithOpacity(colors.canvas, 0.45), canvasWithOpacity(colors.canvas, 0)] as const
    : [canvasWithOpacity(colors.canvas, 0), canvasWithOpacity(colors.canvas, 0.45), canvasWithOpacity(colors.canvas, 0.96), canvasWithOpacity(colors.canvas, 1)] as const;
  const locations = top ? [0, 0.35, 0.7, 1] as const : [0, 0.3, 0.65, 1] as const;

  return (
    <View
      testID={`chat-${edge}-fade`}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.fade, { height }, top ? styles.top : styles.bottom]}
    >
      <LinearGradient
        colors={gradientColors}
        locations={locations}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 1,
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
