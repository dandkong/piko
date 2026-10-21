import { useState } from "react";
import { Keyboard, View, useWindowDimensions } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { AppShell, type AppTab } from "../../components/AppShell";
import { ChatComposer } from "../chat/ChatComposer";
import { ChatProvider, useChatStore } from "../chat/ChatProvider";
import { ChatTab, MESSAGE_GAP } from "../chat/ChatTab";
import { useSideChats } from "../chat/side-chats";
import { ArtifactsScreen } from "../artifacts/ArtifactsScreen";
import { PostsScreen } from "../posts/PostsScreen";
import { TasksScreen } from "../tasks/TasksScreen";
import { NavigationDrawer } from "./NavigationDrawer";

/** Visited chat owners stay keyed and mounted: switching cannot retarget a pending send or lose a draft. */
export function MainScreen() {
  const [tab, setTab] = useState<AppTab>("Chat");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [visited, setVisited] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const sides = useSideChats(menuOpen);
  const selectTab = (value: AppTab) => {
    Keyboard.dismiss(); setTab(value); setMenuOpen(false);
    if (value === "Chat") setSelectedId(undefined);
  };
  const selectChat = (id: string) => {
    Keyboard.dismiss(); setVisited(current => current.includes(id) ? current : [...current, id]);
    setSelectedId(id); setTab("Chat"); setMenuOpen(false);
  };
  const common = { tab, menuOpen, sides, selectedId, selectTab, selectChat, setMenuOpen };
  return <View style={{ flex: 1 }}>
    {[undefined, ...visited].map(id => {
      const visible = tab === "Chat" ? id === selectedId : id === undefined;
      return <View key={id ?? "main"} style={{ flex: 1, display: visible ? "flex" : "none" }} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? "auto" : "no-hide-descendants"}>
        <ChatProvider conversationId={id} active={visible}>
          <Shell {...common} conversationId={id} visible={visible} />
        </ChatProvider>
      </View>;
    })}
  </View>;
}

type ShellProps = {
  tab: AppTab; menuOpen: boolean; sides: ReturnType<typeof useSideChats>; selectedId?: string;
  conversationId?: string; visible: boolean;
  selectTab: (tab: AppTab) => void; selectChat: (id: string) => void;
  setMenuOpen: (value: boolean) => void;
};
function Shell({ tab, menuOpen, sides, selectedId, conversationId, visible, selectTab, selectChat, setMenuOpen }: ShellProps) {
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const [keyboardLiftAmount, setKeyboardLiftAmount] = useState(0);
  const keyboardLift = useSharedValue(0);
  const { width } = useWindowDimensions();
  const { ready, draft, setDraft, loading, busy, submitting, status, send, stop, attachments, attaching, attach, removeAttachment } = useChatStore();
  const current = sides.items.find(item => item.id === conversationId);
  const archived = current?.archivedAt != null;
  return <AppShell
    wide={width >= 900} activeTab={tab} onTabChange={selectTab}
    title={conversationId ? current?.title ?? "旁聊" : "Piko"}
    menuOpen={visible && menuOpen} onOpenMenu={() => { Keyboard.dismiss(); setMenuOpen(true); }}
    drawer={visible ? <NavigationDrawer
      open={menuOpen} activeTab={tab} activeSideChatId={tab === "Chat" ? selectedId : undefined}
      onSelectTab={selectTab} onClose={() => setMenuOpen(false)} sideChats={sides.items}
      sideChatBusy={sides.busy} sideChatError={sides.error} onRefreshSideChats={() => void sides.refresh()}
      onSelectSideChat={selectChat}
      onCreateSideChat={async title => { const value = await sides.create(title); if (value) selectChat(value.id); return !!value; }}
      onUpdateSideChat={async (id, change) => !!await sides.update(id, change)}
    /> : undefined}
    status={archived ? "已归档 · 只读" : status}
    headerHeight={headerHeight} footerHeight={footerHeight}
    // Hidden retained views report zero layout; do not erase their measured chat insets.
    onHeaderHeightChange={value => { if (visible && value > 0) setHeaderHeight(value); }}
    onFooterHeightChange={value => { if (visible && tab === "Chat" && value > 0) setFooterHeight(value); }}
    keyboardLift={keyboardLift} onKeyboardLiftChange={setKeyboardLiftAmount}
    composer={tab === "Chat" && !archived ? <ChatComposer
      draft={draft} onChange={setDraft} loading={loading} busy={busy}
      ready={ready && !submitting} onSend={text => void send(text)} onStop={stop}
      attachments={attachments} attaching={attaching} onAttach={() => void attach()} onRemoveAttachment={removeAttachment}
    /> : null}
  >
    {visible && <TabPanel tab={tab} topInset={headerHeight + MESSAGE_GAP} bottomInset={footerHeight + MESSAGE_GAP} />}
    <ChatTab hidden={!visible || tab !== "Chat"} headerHeight={headerHeight} footerHeight={footerHeight}
      keyboardLift={keyboardLift} keyboardLiftAmount={keyboardLiftAmount} />
  </AppShell>;
}
function TabPanel({ tab, topInset, bottomInset }: { tab: AppTab; topInset: number; bottomInset: number }) {
  switch (tab) {
    case "Chat": return null;
    case "Posts": return <PostsScreen topInset={topInset} bottomInset={bottomInset} />;
    case "Artifacts": return <ArtifactsScreen topInset={topInset} bottomInset={bottomInset} />;
    case "Tasks": return <TasksScreen topInset={topInset} bottomInset={bottomInset} />;
  }
}
