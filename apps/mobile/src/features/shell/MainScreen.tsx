import { useState } from "react";
import { Keyboard, useWindowDimensions } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { AppShell, type AppTab } from "../../components/AppShell";
import { ChatComposer } from "../chat/ChatComposer";
import { ChatProvider, useChatStore } from "../chat/ChatProvider";
import { ChatTab, MESSAGE_GAP } from "../chat/ChatTab";
import { PostsScreen } from "../posts/PostsScreen";
import { TasksScreen } from "../tasks/TasksScreen";

/** Owns the tab bar, the shared chat subscription, and the composer placement for each tab. */
export function MainScreen() {
  return <ChatProvider><Shell /></ChatProvider>;
}

function Shell() {
  const [tab, setTab] = useState<AppTab>("Chat");
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const [keyboardLiftAmount, setKeyboardLiftAmount] = useState(0);
  const keyboardLift = useSharedValue(0);
  const { width } = useWindowDimensions();
  const { ready, draft, setDraft, loading, busy, submitting, status, send, stop } = useChatStore();

  return (
    <AppShell
      wide={width >= 900}
      activeTab={tab}
      onTabChange={value => { Keyboard.dismiss(); setTab(value); }}
      status={status}
      headerHeight={headerHeight}
      footerHeight={footerHeight}
      onHeaderHeightChange={setHeaderHeight}
      onFooterHeightChange={setFooterHeight}
      keyboardLift={keyboardLift}
      onKeyboardLiftChange={setKeyboardLiftAmount}
      composer={tab === "Chat" ? (
        <ChatComposer
          draft={draft} onChange={setDraft} loading={loading} busy={busy}
          ready={ready && !submitting} onSend={(text) => void send(text)} onStop={stop}
        />
      ) : null}
    >
      <TabPanel tab={tab} topInset={headerHeight + MESSAGE_GAP} bottomInset={footerHeight + MESSAGE_GAP} />
      {/* Chat stays mounted so its draft and scroll position survive tab switches. */}
      <ChatTab
        hidden={tab !== "Chat"}
        headerHeight={headerHeight}
        footerHeight={footerHeight}
        keyboardLift={keyboardLift}
        keyboardLiftAmount={keyboardLiftAmount}
      />
    </AppShell>
  );
}

/** Each enabled tab owns its screen; Chat is mounted separately to keep its state. */
function TabPanel({ tab, topInset, bottomInset }: { tab: AppTab; topInset: number; bottomInset: number }) {
  switch (tab) {
    case "Chat": return null;
    case "Posts": return <PostsScreen topInset={topInset} bottomInset={bottomInset} />;
    case "Tasks": return <TasksScreen topInset={topInset} bottomInset={bottomInset} />;
  }
}
