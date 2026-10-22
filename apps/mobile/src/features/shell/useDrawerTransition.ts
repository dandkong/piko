import { useCallback, useEffect, useRef, useState } from "react";
import {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { drawerLayout, motion, radii } from "../../theme";

/** One owner for surface animation and underlay lifetime, including interrupted transitions. */
export function useDrawerTransition(open: boolean, width: number) {
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(open);
  const transition = useRef(0);
  const finishClose = useCallback((id: number) => {
    if (id === transition.current) setMounted(false);
  }, []);
  const push =
    Math.min(drawerLayout.maxWidth, width * drawerLayout.widthRatio) +
    drawerLayout.inset;
  useEffect(() => {
    const id = ++transition.current;
    if (open) setMounted(true);
    progress.value = withTiming(
      open ? 1 : 0,
      {
        duration: open ? motion.drawerIn : motion.drawerOut,
        easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      },
      (finished) => {
        if (finished && !open) runOnJS(finishClose)(id);
      },
    );
    return () => {
      transition.current++;
    };
  }, [open, progress, finishClose]);
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(progress.value, [0, 1], [0, push]) },
      {
        scale: interpolate(progress.value, [0, 1], [1, drawerLayout.pushScale]),
      },
    ],
    borderRadius: interpolate(progress.value, [0, 1], [0, radii.panel]),
    shadowOpacity: interpolate(progress.value, [0, 1], [0, 0.14]),
    shadowRadius: interpolate(progress.value, [0, 1], [0, 18]),
    elevation: interpolate(progress.value, [0, 1], [0, 12]),
  }));
  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.value, [0, 1], [0, radii.panel]),
  }));
  return { mounted: mounted || open, surfaceStyle, clipStyle };
}
