import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { MainScreen } from "./src/features/shell/MainScreen";
import { ThemeProvider, useTheme } from "./src/theme";
import { LanguageProvider } from "./src/i18n";
import { AudioPlaybackProvider } from "./src/features/chat/AudioPlayback";
import { AuthGate } from "./src/api/AuthGate";

export default function App() {
  return (
    <LanguageProvider>
      <ThemeProvider>
        <ThemedApp />
      </ThemeProvider>
    </LanguageProvider>
  );
}

function ThemedApp() {
  const { mode } = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <AuthGate><AudioPlaybackProvider><MainScreen /></AudioPlaybackProvider></AuthGate>
    </SafeAreaProvider>
  );
}
