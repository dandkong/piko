import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, useWindowDimensions } from "react-native";
import { AppShell, type AppTab } from "./AppShell";
import { ChatComposer } from "../chat/ChatComposer";
import { ChatProvider, type ChatStore } from "../chat/ChatProvider";
import { ChatTab, MESSAGE_GAP } from "../chat/ChatTab";
import { useSideChats } from "../chat/side-chats";
import { ArtifactsScreen } from "../artifacts/ArtifactsScreen";
import { ArtifactPreviewPanel } from "../artifacts/ArtifactPreviewPanel";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { PostsScreen } from "../posts/PostsScreen";
import { PostPreviewPanel } from "../posts/PostPreviewPanel";
import type { PostSummary } from "../../../../../shared/posts";
import { TasksScreen } from "../tasks/TasksScreen";
import { TaskExecutionPreviewPanel, type TaskExecutionPreviewTarget } from "../tasks/TaskExecutionPreviewPanel";
import { NavigationDrawer } from "./NavigationDrawer";
import { SettingsSheet } from "../settings/SettingsSheet";
import type { FeedbackTone, FeedbackToastMessage } from "../../components/FeedbackToast";

/** One app shell; keyed chat owners retain data and drafts, not hidden lists. */
export function MainScreen() {
  const [tab, setTab] = useState<AppTab>("Chat");
  const [selectedId, setSelectedId] = useState<string>();
  const [visited, setVisited] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactEntry>();
  const [postPreview, setPostPreview] = useState<PostSummary>();
  const [postsRevision, setPostsRevision] = useState(0);
  const onPostDeleted = useCallback((id: string) => {
    setPostPreview(current => current?.id === id ? undefined : current);
    setPostsRevision(current => current + 1);
  }, []);
  const [executionPreview, setExecutionPreview] = useState<TaskExecutionPreviewTarget>();
  const [toastMessage, setToastMessage] = useState<FeedbackToastMessage>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [headerHeight, setHeaderHeight] = useState(0);
  // The footer is shared by all conversations; an unchanged layout need not emit onLayout on a switch.
  const [footerHeight, setFooterHeight] = useState(0);
  const [activeChat, setActiveChat] = useState<{
    id?: string;
    chat: ChatStore;
  }>();
  const { width } = useWindowDimensions();
  const sides = useSideChats(menuOpen);
  const activeId = tab === "Chat" ? selectedId : undefined;
  const chat = activeChat?.id === activeId ? activeChat?.chat : undefined;
  const onActiveChat = useCallback(
    (id: string | undefined, value: ChatStore) => {
      setActiveChat({ id, chat: value });
    },
    [],
  );
  const showToast = useCallback((message: string, tone: FeedbackTone = "error") => {
    clearTimeout(toastTimer.current);
    setToastMessage({ message, tone });
    toastTimer.current = setTimeout(() => setToastMessage(undefined), 2800);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const selectTab = (value: AppTab) => {
    Keyboard.dismiss();
    setArtifactPreview(undefined);
    setPostPreview(undefined);
    setExecutionPreview(undefined);
    setTab(value);
    setMenuOpen(false);
    if (value === "Chat") setSelectedId(undefined);
  };
  const selectChat = (id: string) => {
    Keyboard.dismiss();
    setArtifactPreview(undefined);
    setPostPreview(undefined);
    setExecutionPreview(undefined);
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setSelectedId(id);
    setTab("Chat");
    setMenuOpen(false);
  };
  const generateSideChatTitle = useCallback(async (id: string) => {
    try {
      await sides.generateTitle(id);
      return true;
    } catch {
      showToast("标题生成失败，请重试。");
      return false;
    }
  }, [sides.generateTitle, showToast]);
  const onSideChatRunEnd = useCallback((id: string, requestIds: readonly string[]) => {
    void sides.generateTitle(id, requestIds).catch(() => {});
  }, [sides.generateTitle]);
  const removeChat = async (id: string) => {
    if (!(await sides.remove(id))) return false;
    setSelectedId(current => current === id ? undefined : current);
    setVisited(current => current.filter(value => value !== id));
    return true;
  };
  useEffect(() => {
    const id = activeChat?.id;
    if (!id || !activeChat.chat.deleted) return;
    setSelectedId(current => current === id ? undefined : current);
    setVisited(current => current.filter(value => value !== id));
    void sides.refresh();
  }, [activeChat?.id, activeChat?.chat.deleted, sides.refresh]);
  return (
    <AppShell
      wide={width >= 900}
      activeTab={tab}
      onTabChange={selectTab}
      menuOpen={menuOpen}
      toastMessage={toastMessage}
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
            const value = await sides.create();
            if (value) selectChat(value.id);
          }}
          onGenerateSideChatTitle={generateSideChatTitle}
          onDeleteSideChat={removeChat}
          onOpenSettings={() => setSettingsOpen(true)}
          covered={settingsOpen}
        />
      }
      sheet={
        <>
          <SettingsSheet
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onToast={showToast}
          />
          <PostPreviewPanel post={postPreview} onClose={() => setPostPreview(undefined)} onDeleted={onPostDeleted} />
          <TaskExecutionPreviewPanel target={executionPreview} onClose={() => setExecutionPreview(undefined)} />
          <ArtifactPreviewPanel
            file={artifactPreview}
            onClose={() => setArtifactPreview(undefined)}
          />
        </>
      }
      status={chat?.status ?? ""}
      headerHeight={headerHeight}
      footerHeight={footerHeight}
      onHeaderHeightChange={(value) => {
        if (value > 0) setHeaderHeight(value);
      }}
      onFooterHeightChange={(value) => {
        if (tab !== "Chat" || value <= 0) return;
        setFooterHeight(value);
      }}
      composer={
        tab === "Chat" && chat ? (
          <ChatComposer
            key={activeId ?? "main"}
            draft={chat.draft}
            onChange={chat.setDraft}
            loading={chat.loading}
            busy={chat.busy}
            submitting={chat.submitting}
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
        onArtifactPreview={setArtifactPreview}
        onPostPreview={setPostPreview}
        postsRevision={postsRevision}
        onPostDeleted={onPostDeleted}
        onExecutionPreview={setExecutionPreview}
        onToast={showToast}
      />
      {[undefined, ...visited].map((id) => (
        <ChatConversation
          key={id ?? "main"}
          conversationId={id}
          onToast={showToast}
          active={id === activeId}
          visible={tab === "Chat" && id === selectedId}
          onActiveChat={onActiveChat}
          onSideChatRunEnd={onSideChatRunEnd}
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
  onToast,
  onSideChatRunEnd,
  ...layout
}: {
  conversationId?: string;
  active: boolean;
  visible: boolean;
  onActiveChat: (id: string | undefined, chat: ChatStore) => void;
  onToast: (message: string) => void;
  onSideChatRunEnd: (id: string, requestIds: readonly string[]) => void;
} & Parameters<typeof ChatTab>[0]) {
  return (
    <ChatProvider
      conversationId={conversationId}
      active={active}
      onActiveChat={onActiveChat}
      onToast={onToast}
      onSideChatRunEnd={onSideChatRunEnd}
    >
      {visible ? <ChatTab {...layout} /> : null}
    </ChatProvider>
  );
});

function TabPanel({
  tab,
  topInset,
  bottomInset,
  onArtifactPreview,
  onPostPreview,
  postsRevision,
  onPostDeleted,
  onExecutionPreview,
  onToast,
}: {
  tab: AppTab;
  topInset: number;
  bottomInset: number;
  onArtifactPreview: (file: ArtifactEntry) => void;
  onPostPreview: (post: PostSummary) => void;
  postsRevision: number;
  onPostDeleted: (id: string) => void;
  onExecutionPreview: (target: TaskExecutionPreviewTarget) => void;
  onToast: (message: string, tone?: FeedbackTone) => void;
}) {
  switch (tab) {
    case "Chat":
      return null;
    case "Posts":
      return <PostsScreen topInset={topInset} bottomInset={bottomInset} onPreview={onPostPreview} onToast={onToast}
        revision={postsRevision} onDeleted={onPostDeleted} />;
    case "Artifacts":
      return <ArtifactsScreen topInset={topInset} bottomInset={bottomInset} onPreview={onArtifactPreview} />;
    case "Tasks":
      return <TasksScreen topInset={topInset} bottomInset={bottomInset} onPreviewExecution={onExecutionPreview} />;
  }
}
