import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { MainScreen } from "./src/features/shell/MainScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <MainScreen />
    </SafeAreaProvider>
  );
}
