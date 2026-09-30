import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChatScreen } from "./src/features/chat/ChatScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ChatScreen />
    </SafeAreaProvider>
  );
}
