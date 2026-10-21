import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { SIDE_CHAT_TITLE_LIMIT, type SideChat, type UpdateSideChat } from "../../../../../shared/side-chats";
import { TextButton } from "../../components/TextButton";
import { TactilePressable } from "../../components/TactilePressable";
import { colors, radii } from "../../theme";

export type SideChatActions = {
  sideChats?: SideChat[]; activeSideChatId?: string; sideChatBusy?: boolean; sideChatError?: string;
  onRefreshSideChats?: () => void; onSelectSideChat?: (id: string) => void;
  onCreateSideChat?: (title: string) => Promise<boolean>;
  onUpdateSideChat?: (id: string, change: UpdateSideChat) => Promise<boolean>;
};
export function SideChatList({ sideChats = [], activeSideChatId, sideChatBusy, sideChatError,
  onRefreshSideChats, onSelectSideChat, onCreateSideChat, onUpdateSideChat, creating, onCreated }: SideChatActions & { creating: boolean; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [renamed, setRenamed] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const visible = sideChats.filter(chat => showArchived || chat.archivedAt === null);
  const create = async () => { if (title.trim() && await onCreateSideChat?.(title.trim())) { setTitle(""); onCreated(); } };
  return <View style={styles.list}>
    {creating && <View style={styles.editor}>
      <TextInput accessibilityLabel="旁聊名称" testID="side-chat-title" placeholder="旁聊名称" value={title} onChangeText={setTitle}
        maxLength={SIDE_CHAT_TITLE_LIMIT} editable={!sideChatBusy} style={styles.input} onSubmitEditing={() => void create()} />
      <View style={styles.actions}>
        <TextButton label="取消新建旁聊" disabled={sideChatBusy} onPress={onCreated}><Text style={styles.muted}>取消</Text></TextButton>
        <TextButton label="创建旁聊" testID="side-chat-create" variant="primary" disabled={sideChatBusy || !title.trim()} onPress={() => void create()}><Text style={styles.text}>创建</Text></TextButton>
      </View>
    </View>}
    {sideChatError ? <View>
      <Text accessibilityLiveRegion="polite" style={styles.error}>{sideChatError}</Text>
      <TextButton label="重新加载旁聊" disabled={sideChatBusy} onPress={onRefreshSideChats}><Text style={styles.muted}>重试</Text></TextButton>
    </View> : null}
    {!visible.length && !creating && <Text style={[styles.muted, { padding: 12 }]}>还没有旁聊</Text>}
    {visible.map(chat => <View key={chat.id}>
      <TactilePressable accessibilityRole="button" accessibilityLabel={`打开旁聊：${chat.title}`} accessibilityState={{ selected: activeSideChatId === chat.id }}
        onPress={() => onSelectSideChat?.(chat.id)} variant="plain" selected={activeSideChatId === chat.id} scaleTo={1}
        faceStyle={styles.row} testID={`side-chat-${chat.id}`}>
        <Text numberOfLines={1} style={[styles.text, { flex: 1 }]}>{chat.title}</Text>
        {chat.archivedAt !== null && <Text style={styles.muted}>已归档</Text>}
      </TactilePressable>
      {editing === chat.id ? <View style={styles.editor}>
        <TextInput accessibilityLabel="新的旁聊名称" value={renamed} onChangeText={setRenamed} maxLength={SIDE_CHAT_TITLE_LIMIT}
          editable={!sideChatBusy} style={styles.input} />
        <View style={styles.actions}>
          <TextButton label="取消改名" disabled={sideChatBusy} onPress={() => setEditing(undefined)}><Text style={styles.muted}>取消</Text></TextButton>
          <TextButton label="保存旁聊名称" disabled={sideChatBusy || !renamed.trim()} onPress={() => void (async () => {
            if (await onUpdateSideChat?.(chat.id, { title: renamed.trim() })) setEditing(undefined);
          })()}><Text style={styles.text}>保存</Text></TextButton>
        </View>
      </View> : <View style={styles.actions}>
        <TextButton label={`改名：${chat.title}`} variant="plain" disabled={sideChatBusy} onPress={() => { setEditing(chat.id); setRenamed(chat.title); }}><Text style={styles.muted}>改名</Text></TextButton>
        <TextButton label={`${chat.archivedAt === null ? "归档" : "恢复"}：${chat.title}`} variant="plain" disabled={sideChatBusy} onPress={() => void onUpdateSideChat?.(chat.id, { archived: chat.archivedAt === null })}>
          <Text style={styles.muted}>{chat.archivedAt === null ? "归档" : "恢复"}</Text>
        </TextButton>
      </View>}
    </View>)}
    {sideChats.some(chat => chat.archivedAt !== null) && <TextButton label={showArchived ? "隐藏已归档旁聊" : "显示已归档旁聊"} variant="plain" onPress={() => setShowArchived(value => !value)}>
      <Text style={styles.muted}>{showArchived ? "隐藏已归档" : "显示已归档"}</Text>
    </TextButton>}
  </View>;
}
const styles = StyleSheet.create({
  list: { gap: 6 }, row: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, gap: 8, flexDirection: "row", alignItems: "center", borderRadius: radii.control },
  text: { color: colors.text, fontSize: 15 }, muted: { color: colors.muted, fontSize: 13 }, error: { color: colors.danger, fontSize: 13, padding: 12 },
  editor: { padding: 8, gap: 8 }, input: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, paddingHorizontal: 12, color: colors.text, fontSize: 15 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 4 },
});
