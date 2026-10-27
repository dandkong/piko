export const colors = {
  canvas: "#FCFCFC", card: "#FFFFFF", text: "#11191C", muted: "#697176",
  line: "#EEEEF0", lineStrong: "#CDD5DC",
  blue: "#C8E7FF", blueDark: "#1473C8",
  danger: "#AA4A45", dangerSurface: "#FBEFED",
  codeSurface: "#E2E4E7", mascot: "#ECF5FA",
  drawerEdge: "#E3E6E8", desk: "#F2F3F4", scrim: "rgba(17, 25, 28, 0.16)",
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

/** Neutral states stay gray; pale blue is reserved for committing actions. */
export const stateColors = {
  selected: "#F0F1F2",
  selectedHover: "#E9EBEC",
  selectedPressed: "#E4E7E8",
  hover: "#F8F9FA",
  pressed: "#ECEEEF",
  soft: "#F3F5F6",
  softHover: "#EDF0F2",
  softPressed: "#E6EAEC",
  primaryHover: "#BCE0FC",
  primaryPressed: "#AED7F7",
  disabledOpacity: 0.4,
  focus: "#858E92",
} as const;
