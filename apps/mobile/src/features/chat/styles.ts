import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export const styles = StyleSheet.create({
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
    paddingBottom: 20,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    paddingVertical: 34,
  },
  muted: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 22,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colors.blue,
    borderBottomRightRadius: 7,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    maxWidth: "95%",
    backgroundColor: "#EEEEF0",
    borderBottomLeftRadius: 7,
  },
  messageText: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
  },
  typing: {
    paddingHorizontal: 19,
    paddingVertical: 18,
  },
  errorNotice: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#FBEFED",
    marginVertical: 10,
    gap: 12,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 21,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 7,
  },
  latestButtonOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    zIndex: 1,
    alignItems: "center",
  },
  latestButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    shadowColor: "#18384B",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  composer: {
    backgroundColor: colors.card,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "#EEF0F2",
    padding: 8,
    shadowColor: "#18384B",
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  composerFocused: {
    borderColor: "#C7E4F9",
    shadowOpacity: 0.1,
  },
  composerRow: {
    flexDirection: "row",
    gap: 7,
    alignItems: "flex-end",
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
  composerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
  },
  sendReady: {
    backgroundColor: colors.blue,
  },
  sendIdle: {
    backgroundColor: "#F3F5F6",
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
});
