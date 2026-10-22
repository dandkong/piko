import { memo, useCallback, useRef, useState } from "react";
import { Keyboard, View, useWindowDimensions } from "react-native";
import { AppShell, type AppTab } from "./AppShell";
import { ChatComposer } from "../chat/ChatComposer";
import { ChatProvider, type ChatStore } from "../chat/ChatProvider";
import { ChatTab, MESSAGE_GAP } from "../chat/ChatTab";
import { useSideChats } from "../chat/side-chats";
import { ArtifactsScreen } from "../artifacts/ArtifactsScreen";
import { PostsScreen } from "../posts/PostsScreen";
import { TasksScreen } from "../tasks/TasksScreen";
import { NavigationDrawer } from "./NavigationDrawer";
import { SettingsSheet } from "../settings/SettingsSheet";
import {
  DEFAULT_SIDE_CHAT_TITLE,
  type UpdateSideChat,
} from "../../../../../shared/side-chats";

/** One app shell; keyed chat owners retain drafts, pending input identity and scroll. */
export function MainScreen() {
  const [tab, setTab] = useState<AppTab>("Chat");
  const [selectedId, setSelectedId] = useState<string>();
  const [visited, setVisited] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeights, setFooterHeights] = useState<Record<string, number>>(
    {},
  );
  const [activeChat, setActiveChat] = useState<{
    id?: string;
    chat: ChatStore;
  }>();
  const { width } = useWindowDimensions();
  const sides = useSideChats(menuOpen);
  const activeId = tab === "Chat" ? selectedId : undefined;
  const footerHeight = footerHeights[activeId ?? "main"] ?? 0;
  const chat = activeChat?.id === activeId ? activeChat?.chat : undefined;
  const archived =
    sides.items.find((item) => item.id === activeId)?.archivedAt != null;
  const onActiveChat = useCallback(
    (id: string | undefined, value: ChatStore) => {
      setActiveChat({ id, chat: value });
    },
    [],
  );
  const selectTab = (value: AppTab) => {
    Keyboard.dismiss();
    setTab(value);
    setMenuOpen(false);
    if (value === "Chat") setSelectedId(undefined);
  };
  const selectChat = (id: string) => {
    Keyboard.dismiss();
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setSelectedId(id);
    setTab("Chat");
    setMenuOpen(false);
  };
  const updateChat = async (id: string, change: UpdateSideChat) => {
    if (!(await sides.update(id, change))) return false;
    if (change.archived) {
      setSelectedId((current) => (current === id ? undefined : current));
      setVisited((current) => current.filter((value) => value !== id));
    }
    return true;
  };
  return (
    <AppShell
      wide={width >= 900}
      activeTab={tab}
      onTabChange={selectTab}
      menuOpen={menuOpen}
      onOpenMenu={() => {
        Keyboard.dismiss();
        setMenuOpen(true);
      }}
      onCloseMenu={() => setMenuOpen(false)}
      drawer={
        <NavigationDrawer
          open={menuOpen}
          activeTab={tab}
          activeSideChatId={tab === "Chat" ? selectedId : undefined}
          onSelectTab={selectTab}
          onClose={() => setMenuOpen(false)}
          sideChats={sides.items}
          sideChatBusy={sides.busy}
          sideChatError={sides.error}
          onRefreshSideChats={() => void sides.refresh()}
          onSelectSideChat={selectChat}
          onCreateSideChat={async () => {
            const value = await sides.create(DEFAULT_SIDE_CHAT_TITLE);
            if (value) selectChat(value.id);
          }}
          onUpdateSideChat={updateChat}
          onOpenSettings={() => setSettingsOpen(true)}
          covered={settingsOpen}
        />
      }
      sheet={
        <SettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      }
      status={archived ? "已归档 · 只读" : (chat?.status ?? "")}
      headerHeight={headerHeight}
      footerHeight={footerHeight}
      onHeaderHeightChange={(value) => {
        if (value > 0) setHeaderHeight(value);
      }}
      onFooterHeightChange={(value) => {
        if (tab !== "Chat" || value <= 0) return;
        const key = activeId ?? "main";
        setFooterHeights((current) =>
          current[key] === value ? current : { ...current, [key]: value },
        );
      }}
      composer={
        tab === "Chat" && !archived && chat ? (
          <ChatComposer
            key={activeId ?? "main"}
            draft={chat.draft}
            onChange={chat.setDraft}
            loading={chat.loading}
            busy={chat.busy}
            ready={chat.ready && !chat.submitting}
            onSend={(text) => void chat.send(text)}
            onStop={chat.stop}
            attachments={chat.attachments}
            attaching={chat.attaching}
            onAttach={() => void chat.attach()}
            onRemoveAttachment={chat.removeAttachment}
          />
        ) : null
      }
    >
      <TabPanel
        tab={tab}
        topInset={headerHeight + MESSAGE_GAP}
        bottomInset={footerHeight + MESSAGE_GAP}
      />
      {[undefined, ...visited].map((id) => (
        <ChatConversation
          key={id ?? "main"}
          conversationId={id}
          active={id === activeId}
          visible={tab === "Chat" && id === selectedId}
          onActiveChat={onActiveChat}
          headerHeight={headerHeight}
          footerHeight={footerHeight}
        />
      ))}
    </AppShell>
  );
}

// Memoization keeps the owner-to-shell layout notification from causing a render loop.
// Only a chat's own state or layout/selection changes update its provider.
const ChatConversation = memo(function ChatConversation({
  conversationId,
  active,
  visible,
  onActiveChat,
  ...layout
}: {
  conversationId?: string;
  active: boolean;
  visible: boolean;
  onActiveChat: (id: string | undefined, chat: ChatStore) => void;
} & Omit<Parameters<typeof ChatTab>[0], "hidden">) {
  // Hidden lists must not adopt another chat's composer insets.
  const retainedLayout = useRef(layout);
  if (visible) retainedLayout.current = layout;
  return (
    <View
      style={{ flex: 1, display: visible ? "flex" : "none" }}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <ChatProvider
        conversationId={conversationId}
        active={active}
        onActiveChat={onActiveChat}
      >
        <ChatTab hidden={!visible} {...retainedLayout.current} />
      </ChatProvider>
    </View>
  );
});

function TabPanel({
  tab,
  topInset,
  bottomInset,
}: {
  tab: AppTab;
  topInset: number;
  bottomInset: number;
}) {
  switch (tab) {
    case "Chat":
      return null;
    case "Posts":
      return <PostsScreen topInset={topInset} bottomInset={bottomInset} />;
    case "Artifacts":
      return <ArtifactsScreen topInset={topInset} bottomInset={bottomInset} />;
    case "Tasks":
      return <TasksScreen topInset={topInset} bottomInset={bottomInset} />;
  }
}
