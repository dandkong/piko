import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { MainScreen } from "./src/features/shell/MainScreen";
import { ThemeProvider, useTheme } from "./src/theme";

export default function App() {
  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  );
}

function ThemedApp() {
  const { mode } = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <MainScreen />
    </SafeAreaProvider>
  );
}
