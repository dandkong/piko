import { Linking } from "react-native";

/** Shared download action; platform-specific saving can be added here. */
export function downloadFile(url: string): Promise<void> {
  return Linking.openURL(url);
}
