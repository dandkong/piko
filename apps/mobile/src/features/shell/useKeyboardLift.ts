import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { withTiming, type SharedValue } from "react-native-reanimated";

export const KEYBOARD_COMPOSER_GAP = 10;

/** Native keyboard geometry is app-owned, not duplicated by retained conversations. */
export function useKeyboardLift(
  tabsHeight: number,
  lift: SharedValue<number>,
  onChange: (height: number) => void,
) {
  const [height, setHeight] = useState(0);
  const duration = useRef(250);
  const amount =
    height > 0 ? Math.max(0, height - tabsHeight) + KEYBOARD_COMPOSER_GAP : 0;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      (event) => {
        duration.current = event.duration > 0 ? event.duration : 250;
        setHeight(event.endCoordinates.height);
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event) => {
        duration.current = event.duration > 0 ? event.duration : 250;
        setHeight(0);
      },
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    lift.value = withTiming(amount, { duration: duration.current });
    onChange(amount);
  }, [lift, amount, onChange]);
}
