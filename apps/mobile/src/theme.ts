import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";

export type AppearancePreference = "system" | "dark" | "light";
export type ThemeMode = "dark" | "light";

export type ThemeColors = {
  canvas: string;
  card: string;
  text: string;
  muted: string;
  line: string;
  lineStrong: string;
  blue: string;
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
  disabledOpacity: number;
  focus: string;
};

export const lightColors: ThemeColors = {
  canvas: "#FCFCFC",
  card: "#FFFFFF",
  text: "#11191C",
  muted: "#697176",
  line: "#EEEEF0",
  lineStrong: "#CDD5DC",
  blue: "#D6EEFF",
  blueDark: "#1473C8",
  danger: "#AA4A45",
  dangerSurface: "#FBEFED",
  codeSurface: "#E2E4E7",
  mascot: "#ECF5FA",
  drawerEdge: "#E3E6E8",
  desk: "#F2F3F4",
  scrim: "rgba(17, 25, 28, 0.16)",
};

export const darkColors: ThemeColors = {
  canvas: "#111619",
  card: "#1B2226",
  text: "#E8EEF0",
  muted: "#A0AAAF",
  line: "#293237",
  lineStrong: "#46535A",
  blue: "#19394D",
  blueDark: "#83C8F5",
  danger: "#F19A92",
  dangerSurface: "#3A2525",
  codeSurface: "#252E33",
  mascot: "#24343D",
  drawerEdge: "#39454B",
  desk: "#0B0F11",
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
  selected: "#F0F1F2",
  selectedHover: "#E9EBEC",
  selectedPressed: "#E4E7E8",
  hover: "#F8F9FA",
  pressed: "#ECEEEF",
  soft: "#F3F5F6",
  softHover: "#EDF0F2",
  softPressed: "#E6EAEC",
  primaryHover: "#C8E7FF",
  primaryPressed: "#BCE0FC",
  disabledOpacity: 0.4,
  focus: "#858E92",
};

export const darkStateColors: ThemeStateColors = {
  selected: "#303A40",
  selectedHover: "#39454B",
  selectedPressed: "#455158",
  hover: "#252E33",
  pressed: "#323C42",
  soft: "#232C31",
  softHover: "#2B353B",
  softPressed: "#354148",
  primaryHover: "#224C64",
  primaryPressed: "#1D4358",
  disabledOpacity: 0.4,
  focus: "#A6B5BC",
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
