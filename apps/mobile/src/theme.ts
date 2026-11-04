import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";

export type AppearancePreference = "system" | "dark" | "light";
export type ThemeMode = "dark" | "light";

export type ThemeColors = {
  canvas: string;
  card: string;
  agentCard: string;
  embeddedCard: string;
  panel: string;
  text: string;
  muted: string;
  weak: string;
  line: string;
  lineStrong: string;
  blue: string;
  userBubble: string;
  blueDark: string;
  danger: string;
  dangerSurface: string;
  codeSurface: string;
  mascot: string;
  drawerEdge: string;
  desk: string;
  scrim: string;
};

export type ThemeStateColors = {
  selected: string;
  selectedHover: string;
  selectedPressed: string;
  hover: string;
  pressed: string;
  soft: string;
  softHover: string;
  softPressed: string;
  primaryHover: string;
  primaryPressed: string;
  primaryDisabled: string;
  disabledOpacity: number;
  focus: string;
};

export const lightColors: ThemeColors = {
  canvas: "#FCFCFC",
  card: "#FFFFFF",
  agentCard: "#F0F0F0",
  embeddedCard: "#F4F4F5",
  panel: "#FFFFFF",
  text: "#171717",
  muted: "#737373",
  weak: "#949494",
  line: "#E5E5E5",
  lineStrong: "#CCCCCC",
  blue: "#D6E5F7",
  userBubble: "#D6E8FC",
  blueDark: "#267FC2",
  danger: "#C94F4F",
  dangerSurface: "#FCEBEC",
  codeSurface: "#F4F4F5",
  mascot: "#ECF5FA",
  drawerEdge: "#E5E5E5",
  desk: "#F4F4F5",
  scrim: "rgba(23, 23, 23, 0.16)",
};

export const darkColors: ThemeColors = {
  canvas: "#0C0C0C",
  card: "#161616",
  agentCard: "#161616",
  embeddedCard: "#1F1F1F",
  panel: "#202020",
  text: "#F5F5F5",
  muted: "#A3A3A3",
  weak: "#858585",
  line: "#292929",
  lineStrong: "#414141",
  blue: "#174E78",
  userBubble: "#174E78",
  blueDark: "#72BFFF",
  danger: "#F19A92",
  dangerSurface: "#382020",
  codeSurface: "#101010",
  mascot: "#202020",
  drawerEdge: "#292929",
  desk: "#000000",
  scrim: "rgba(0, 0, 0, 0.58)",
};

/** Shared control scale. Keep interaction sizes here instead of one-off styles. */
export const controlSizes = { sm: 36, md: 44 } as const;

export const radii = { control: 12, card: 18, panel: 30, pill: 999 } as const;
export const drawerLayout = { maxWidth: 300, widthRatio: 0.76 } as const;

export const motion = {
  pressIn: 90,
  pressOut: 160,
  drawerIn: 260,
  drawerOut: 200,
  tabSlide: 260,
} as const;

/** Neutral interaction states stay gray in both palettes; blue is reserved for primary actions. */
export const lightStateColors: ThemeStateColors = {
  selected: "#EEEFF0",
  selectedHover: "#E5E7E9",
  selectedPressed: "#DCDDDF",
  hover: "#F4F4F5",
  pressed: "#EEEFF0",
  soft: "#F4F4F5",
  softHover: "#EEEFF0",
  softPressed: "#E5E7E9",
  primaryHover: "#C9DDF4",
  primaryPressed: "#BDD2EA",
  primaryDisabled: "#E0E8F0",
  disabledOpacity: 0.4,
  focus: "#267FC2",
};

export const darkStateColors: ThemeStateColors = {
  selected: "#303030",
  selectedHover: "#383838",
  selectedPressed: "#414141",
  hover: "#242424",
  pressed: "#303030",
  soft: "#1F1F1F",
  softHover: "#242424",
  softPressed: "#303030",
  primaryHover: "#205B87",
  primaryPressed: "#124269",
  primaryDisabled: "#2B4050",
  disabledOpacity: 0.4,
  focus: "#72BFFF",
};

export type ThemeContextValue = {
  appearance: AppearancePreference;
  setAppearance: (appearance: AppearancePreference) => void;
  mode: ThemeMode;
  colors: ThemeColors;
  stateColors: ThemeStateColors;
};

const APPEARANCE_STORAGE_KEY = "piko.appearance";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function isAppearancePreference(value: string | null): value is AppearancePreference {
  return value === "system" || value === "dark" || value === "light";
}

function colorWithOpacity(color: string, opacity: number) {
  const match = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) return color;
  const [, red, green, blue] = match;
  return `rgba(${Number.parseInt(red!, 16)}, ${Number.parseInt(green!, 16)}, ${Number.parseInt(blue!, 16)}, ${opacity})`;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemColorScheme = useColorScheme();
  const preferenceEdited = useRef(false);
  const [appearance, setAppearanceState] = useState<AppearancePreference>("system");

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(APPEARANCE_STORAGE_KEY)
      .then((saved) => {
        if (active && !preferenceEdited.current && isAppearancePreference(saved)) setAppearanceState(saved);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const setAppearance = useCallback((next: AppearancePreference) => {
    preferenceEdited.current = true;
    setAppearanceState(next);
    void AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") Appearance.setColorScheme(appearance === "system" ? "unspecified" : appearance);
  }, [appearance]);

  const mode: ThemeMode = appearance === "system"
    ? systemColorScheme === "dark" ? "dark" : "light"
    : appearance;
  const colors = mode === "dark" ? darkColors : lightColors;
  const stateColors = mode === "dark" ? darkStateColors : lightStateColors;
  const value = useMemo<ThemeContextValue>(
    () => ({ appearance, setAppearance, mode, colors, stateColors }),
    [appearance, setAppearance, mode, colors, stateColors],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    document.documentElement.style.setProperty("--piko-page-background", colors.canvas);
    document.documentElement.style.setProperty("--piko-scrollbar-thumb", colorWithOpacity(colors.muted, 0.42));
    document.documentElement.style.setProperty("--piko-scrollbar-thumb-hover", colorWithOpacity(colors.muted, 0.68));
    let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!themeColor) {
      themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      document.head.appendChild(themeColor);
    }
    themeColor.content = colors.canvas;
  }, [mode, colors]);

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

export function useThemeStyles<T>(createStyles: (colors: ThemeColors, stateColors: ThemeStateColors) => T): T {
  const { colors, stateColors } = useTheme();
  return useMemo(() => createStyles(colors, stateColors), [colors, stateColors, createStyles]);
}
