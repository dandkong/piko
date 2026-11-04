import { StyleSheet } from "react-native";
import { radii, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";

function createStyles(colors: ThemeColors, stateColors: ThemeStateColors) {
  return StyleSheet.create({
  main: {
    flex: 1,
    minHeight: 0,
  },
  conversation: {
    flex: 1,
  },
  conversationViewport: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  messageList: {
    flexGrow: 1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    paddingVertical: 34,
  },
  loadOlderButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: radii.control,
  },
  muted: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  timeDivider: {
    alignSelf: "center",
    color: colors.weak,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
    marginBottom: 8,
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: radii.card,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colors.blue,
    borderBottomRightRadius: radii.control,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    maxWidth: "95%",
    backgroundColor: colors.agentCard,
    borderBottomLeftRadius: radii.control,
  },
  latestButtonOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    zIndex: 1,
    alignItems: "center",
  },
  latestButtonShadow: {
    borderRadius: radii.pill,
    shadowColor: colors.text,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  composer: {
    backgroundColor: colors.panel,
    borderRadius: radii.panel,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 8,
    shadowColor: colors.text,
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  composerAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: 220,
    backgroundColor: stateColors.soft,
    borderRadius: radii.control,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  composerRow: {
    flexDirection: "row",
    gap: 7,
    alignItems: "flex-end",
  },
  composerAttachments: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 6,
  },
  composerAttachmentName: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 12,
  },
  attachmentRemoveHit: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentRemove: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
  },
  attachmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: 220,
    minHeight: 32,
    borderRadius: radii.control,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  attachmentName: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 12,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    color: colors.text,
    fontSize: 17,
    lineHeight: 24,
    paddingHorizontal: 2,
    paddingTop: 10,
    paddingBottom: 10,
  },
  });
}

export function useChatStyles() {
  return useThemeStyles(createStyles);
}
