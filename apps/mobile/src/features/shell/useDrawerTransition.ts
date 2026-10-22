import { useCallback, useEffect, useRef, useState } from "react";
import {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { drawerLayout, motion } from "../../theme";

/** One owner for surface animation and underlay lifetime, including interrupted transitions. */
export function useDrawerTransition(open: boolean, width: number) {
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(open);
  const transition = useRef(0);
  const finishClose = useCallback((id: number) => {
    if (id === transition.current) setMounted(false);
  }, []);
  const push = Math.min(drawerLayout.maxWidth, width * drawerLayout.widthRatio);
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
  // Keep the live conversation transition to translation; avoid animating effects on its large surface.
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [0, push]) }],
  }));
  return { mounted: mounted || open, surfaceStyle };
}
