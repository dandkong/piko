import { useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import type { SettingsConfigurationSnapshot, SettingsOverview } from "../../../../../shared/settings";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { colors, radii } from "../../theme";
import type { SettingsEditorDraft } from "./editor-state";

function sameModel(a: ModelSelection | null, b: ModelSelection | null) {
  return a?.provider === b?.provider && a?.model === b?.model;
}
function Label({ children }: { children: ReactNode }) { return <Text style={styles.label}>{children}</Text>; }
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.card}>{children}</View>
    {note ? <Text style={styles.note}>{note}</Text> : null}
  </View>;
}
function SelectModel({ title, selection, models, onSelect }: {
  title: string; selection: ModelSelection | null;
  models: SettingsOverview["availableModels"];
  onSelect: (model: { provider: string; id: string; thinkingLevels: ThinkingLevel[] }) => void;
}) {
  return <View style={styles.group}>
    <Label>{title}</Label>
    {models.length ? models.map(model => {
      const selected = selection?.provider === model.provider && selection.model === model.id;
      return <TactilePressable key={`${model.provider}/${model.id}`} accessibilityRole="button"
        accessibilityLabel={`${title} ${model.name}${selected ? "，已选" : ""}`} onPress={() => onSelect(model)}
        variant="plain" scaleTo={1} faceStyle={[styles.modelRow, selected && styles.selected]}>
        <View style={styles.modelText}>
          <Text style={styles.modelName}>{model.name}</Text>
          <Text style={styles.note}>{model.provider} / {model.id}</Text>
        </View>
        <Text style={[styles.selection, selected && styles.selectedText]}>{selected ? "已选择" : "选择"}</Text>
      </TactilePressable>;
    }) : <Text style={styles.note}>还没有已配置凭据的可选模型。</Text>}
  </View>;
}

export function SettingsModelsEditor({ overview, snapshot, draft, loading, saving, error, status,
  onDraftChange, onRefresh, onSave }: {
    overview: SettingsOverview;
    snapshot?: SettingsConfigurationSnapshot;
    draft?: SettingsEditorDraft;
    loading: boolean;
    saving: boolean;
    error: string;
    status: string;
    onDraftChange: (draft: SettingsEditorDraft) => void;
    onRefresh: () => void;
    onSave: (draft: SettingsEditorDraft) => void;
  }) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [newCredentialProvider, setNewCredentialProvider] = useState("");
  const allProviders = useMemo(() => {
    const ids = new Set([...(snapshot?.credentials.map(item => item.providerId) ?? []), ...Object.keys(draft?.keyInputs ?? {})].filter(Boolean));
    try {
      const parsed = JSON.parse(draft?.modelDirectory ?? "") as { providers?: Record<string, unknown> };
      for (const id of Object.keys(parsed.providers ?? {})) ids.add(id);
    } catch { /* keep the known provider list while invalid JSON is being edited */ }
    return [...ids].sort();
  }, [draft?.modelDirectory, snapshot?.credentials]);

  if (loading && !snapshot) return <View style={styles.content}><Text style={styles.note}>正在读取可编辑配置…</Text></View>;
  if (!snapshot || !draft) return <View style={styles.content}>
    <Text accessibilityRole="alert" style={styles.error}>{error || "无法读取配置。"}</Text>
    <TextButton label="重新读取配置" disabled={loading} onPress={onRefresh}><Text style={styles.actionText}>重试</Text></TextButton>
  </View>;

  const dirty = !sameModel(draft.mainModel, snapshot.mainModel) ||
    (draft.mainModel?.thinking ?? "off") !== (snapshot.mainModel?.thinking ?? "off") ||
    JSON.stringify(draft.backgroundModel) !== JSON.stringify(snapshot.backgroundModel) ||
    draft.modelDirectory !== snapshot.modelDirectory ||
    Object.values(draft.keyInputs).some(value => !!value.trim()) || draft.deleteProviders.length > 0;
  const restart = draft.modelDirectory !== snapshot.modelDirectory ||
    Object.values(draft.keyInputs).some(value => !!value.trim()) || draft.deleteProviders.length > 0;
  const update = (patch: Partial<SettingsEditorDraft>) => onDraftChange({ ...draft, ...patch });
  const mainModelInfo = draft.mainModel && overview.availableModels.find(model => model.provider === draft.mainModel!.provider && model.id === draft.mainModel!.model);
  const backgroundSelection = draft.backgroundModel.mode === "model" ? draft.backgroundModel.selection : null;
  const backgroundModelInfo = backgroundSelection && overview.availableModels.find(model => model.provider === backgroundSelection.provider && model.id === backgroundSelection.model);
  const chooseMain = (model: { provider: string; id: string; thinkingLevels: ThinkingLevel[] }) => {
    const old = draft.mainModel;
    const thinking = sameModel(old, { provider: model.provider, model: model.id }) && old?.thinking && model.thinkingLevels.includes(old.thinking)
      ? old.thinking : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0] ?? "off";
    update({ mainModel: { provider: model.provider, model: model.id, thinking } });
  };
  const chooseBackground = (model: { provider: string; id: string; thinkingLevels: ThinkingLevel[] }) => {
    const current = draft.backgroundModel.mode === "model" ? draft.backgroundModel.selection : draft.mainModel;
    const thinking = sameModel(current, { provider: model.provider, model: model.id }) && current?.thinking && model.thinkingLevels.includes(current.thinking)
      ? current.thinking : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0] ?? "off";
    update({ backgroundModel: { mode: "model", selection: { provider: model.provider, model: model.id, thinking } } });
  };
  const invalidCredential = Object.entries(draft.keyInputs).some(([id, key]) => !!key.trim() && !/^[a-z0-9][a-z0-9-]*$/.test(id));
  const invalidBackground = draft.backgroundModel.mode === "model" && !draft.backgroundModel.selection.provider;
  const valid = !invalidCredential && !invalidBackground && (() => { try { JSON.parse(draft.modelDirectory); return true; } catch { return false; } })();

  return <View style={styles.content} testID="settings-detail-models">
    <Section title="主模型" note="全局主模型统一用于主聊天和所有旁聊。正在进行的一轮完成后，下一轮会对齐新选择。">
      <SelectModel title="可用模型" selection={draft.mainModel} models={overview.availableModels} onSelect={chooseMain} />
      {draft.mainModel && overview.currentModel && !sameModel(overview.currentModel, draft.mainModel) ? <Text style={styles.note}>当前主会话实际模型仍为 {overview.currentModel.provider}/{overview.currentModel.model}；保存后空闲会话立即对齐，忙碌会话下一轮生效。</Text> : null}
      {draft.mainModel ? <View style={styles.group}>
        <Label>思考强度 · {draft.mainModel.provider}/{draft.mainModel.model}</Label>
        <View style={styles.levels}>{(mainModelInfo?.thinkingLevels ?? ["off"]).map(level => <TactilePressable key={level} accessibilityRole="button"
          accessibilityLabel={`主模型思考强度 ${level}`} onPress={() => update({ mainModel: { ...draft.mainModel!, thinking: level } })}
          variant="plain" scaleTo={1} faceStyle={[styles.level, draft.mainModel?.thinking === level && styles.levelSelected]}>
          <Text style={[styles.levelText, draft.mainModel?.thinking === level && styles.selectedText]}>{level}</Text>
        </TactilePressable>)}</View>
      </View> : <Text style={styles.note}>尚未选择主模型；选择并保存前，聊天不能开始新的模型执行。</Text>}
    </Section>

    <Section title="后台模型" note="跟随主模型适用于之后新建的委派、任务执行和记忆整理；已启动的后台工作保持原模型。">
      <View style={styles.levels}>
        {(["follow-main", "model"] as const).map(mode => <TactilePressable key={mode} accessibilityRole="button"
          accessibilityLabel={mode === "follow-main" ? "后台模型跟随主模型" : "指定后台模型"}
          onPress={() => update({ backgroundModel: mode === "follow-main" ? { mode } : { mode, selection: draft.mainModel ?? { provider: "", model: "", thinking: "off" } } })}
          variant="plain" scaleTo={1} faceStyle={[styles.mode, draft.backgroundModel.mode === mode && styles.levelSelected]}>
          <Text style={[styles.levelText, draft.backgroundModel.mode === mode && styles.selectedText]}>{mode === "follow-main" ? "跟随主模型" : "指定模型"}</Text>
        </TactilePressable>)}
      </View>
      {draft.backgroundModel.mode === "model" ? <>
        <SelectModel title="后台模型" selection={draft.backgroundModel.selection} models={overview.availableModels} onSelect={chooseBackground} />
        <View style={styles.group}>
          <Label>后台思考强度</Label>
          <View style={styles.levels}>{(backgroundModelInfo?.thinkingLevels ?? ["off"]).map(level => <TactilePressable key={level} accessibilityRole="button"
            accessibilityLabel={`后台模型思考强度 ${level}`} onPress={() => {
              const current = draft.backgroundModel;
              if (current.mode === "model") update({ backgroundModel: { mode: "model", selection: { ...current.selection, thinking: level } } });
            }}
            variant="plain" scaleTo={1} faceStyle={[styles.level, draft.backgroundModel.mode === "model" && draft.backgroundModel.selection.thinking === level && styles.levelSelected]}>
            <Text style={[styles.levelText, draft.backgroundModel.mode === "model" && draft.backgroundModel.selection.thinking === level && styles.selectedText]}>{level}</Text>
          </TactilePressable>)}</View>
        </View>
      </> : null}
    </Section>

    <Section title="供应商凭据" note="只显示是否配置。Key 只在本次提交中传输并写入 auth.json；输入留空表示保留。OAuth 凭据当前不通过此表单编辑。">
      {allProviders.map(providerId => {
        const state = snapshot.credentials.find(item => item.providerId === providerId);
        const isOAuth = state?.type === "oauth";
        const deleting = draft.deleteProviders.includes(providerId);
        return <View key={providerId} style={styles.credential}>
          <View style={styles.credentialHeading}><Text style={styles.modelName}>{providerId}</Text>
            <Text style={styles.note}>{isOAuth ? "OAuth 已配置" : state?.configured ? "API Key 已配置" : "未配置"}</Text>
          </View>
          {!isOAuth ? <>
            <TextInput accessibilityLabel={`${providerId} API Key`} value={draft.keyInputs[providerId] ?? ""}
              onChangeText={value => {
                const keyInputs = { ...draft.keyInputs, [providerId]: value };
                if (value) update({ keyInputs, deleteProviders: draft.deleteProviders.filter(id => id !== providerId) });
                else update({ keyInputs });
              }} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!saving}
              placeholder={state?.configured ? "输入新 Key 以替换；留空保留" : "输入 API Key"} style={styles.input} />
            {state?.configured ? <TextButton label={`${deleting ? "取消删除" : "删除"}${providerId} 凭据`}
              onPress={() => {
                const deleteProviders = deleting ? draft.deleteProviders.filter(id => id !== providerId) : [...draft.deleteProviders, providerId];
                update({ deleteProviders, keyInputs: { ...draft.keyInputs, [providerId]: "" } });
              }} variant="plain" faceStyle={styles.inlineAction}>
              <Text style={styles.deleteText}>{deleting ? "取消删除" : "明确删除 Key"}</Text>
            </TextButton> : null}
            {deleting ? <Text style={styles.error}>保存后将从 auth.json 和 models.json 移除该供应商 Key。</Text> : null}
          </> : <Text style={styles.note}>OAuth 由独立授权流程管理，不会被 API Key 表单覆盖。</Text>}
        </View>;
      })}
      <View style={styles.group}>
        <Label>为新供应商添加 API Key</Label>
        <TextInput accessibilityLabel="新凭据供应商 ID" value={newCredentialProvider} onChangeText={value => {
          const previous = newCredentialProvider;
          setNewCredentialProvider(value);
          if (previous && draft.keyInputs[previous]) {
            const keyInputs = { ...draft.keyInputs };
            const key = keyInputs[previous]!;
            delete keyInputs[previous];
            if (value) keyInputs[value] = key;
            update({ keyInputs });
          }
        }}
          autoCapitalize="none" autoCorrect={false} editable={!saving} placeholder="例如 custom-provider" style={styles.input} />
        <TextInput accessibilityLabel="新供应商 API Key" value={draft.keyInputs[newCredentialProvider] ?? ""}
          onChangeText={value => update({ keyInputs: { ...draft.keyInputs, [newCredentialProvider]: value } })}
          secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!saving && !!newCredentialProvider} placeholder={newCredentialProvider ? "API Key" : "先填写供应商 ID"} style={styles.input} />
      </View>
    </Section>

    <Section title="供应商与模型目录" note="高级目录编辑（models.json 的非敏感字段）。API Key 不会显示或包含在此 JSON 中；修改目录需要重启服务。">
      <TextInput accessibilityLabel="非敏感模型目录 JSON" testID="settings-model-directory" value={draft.modelDirectory}
        onChangeText={value => update({ modelDirectory: value })} editable={!saving} multiline autoCapitalize="none" autoCorrect={false}
        spellCheck={false} textAlignVertical="top" style={styles.jsonInput} />
      <TextButton label={dirty ? "放弃草稿并重新读取模型配置" : "重新读取模型配置"} disabled={loading || saving} onPress={onRefresh}>
        <Text style={styles.actionText}>{loading ? "读取中…" : dirty ? "放弃草稿并重新读取" : "重新读取配置"}</Text>
      </TextButton>
    </Section>

    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
    {invalidCredential ? <Text style={styles.error}>凭据供应商 ID 只能使用小写字母、数字和连字符。</Text> : null}
    {!valid ? <Text style={styles.error}>请检查模型目录 JSON 与后台模型选择。</Text> : null}
    {confirmRestart ? <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>这次保存需要重启 Piko</Text>
      <Text style={styles.note}>当前正在运行的工作可能被中断，Durable 不会自动重放不确定执行。继续保存并重启？</Text>
      <View style={styles.actions}>
        <TextButton label="取消重启确认" disabled={saving} onPress={() => setConfirmRestart(false)}><Text style={styles.actionText}>取消</Text></TextButton>
        <TextButton label="确认保存并重启" disabled={saving} onPress={() => { setConfirmRestart(false); onSave(draft); }} variant="primary">
          <Text style={styles.actionText}>{saving ? "保存中…" : "保存并重启"}</Text>
        </TextButton>
      </View>
    </View> : <TextButton label="保存并应用模型配置" disabled={!dirty || !valid || saving || loading}
      onPress={() => restart ? setConfirmRestart(true) : onSave(draft)} variant="primary" faceStyle={styles.saveButton}>
      <Text style={styles.saveText}>{saving ? "保存中…" : "保存并应用"}</Text>
    </TextButton>}
    {restart ? <Text style={styles.note}>模型目录或凭据有修改，确认后会重启服务。</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 4, paddingBottom: 28, gap: 18 },
  section: { marginHorizontal: 20, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "500", color: colors.muted },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, padding: 16, gap: 16 },
  group: { gap: 8 },
  label: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  modelRow: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 10, borderRadius: radii.control, borderWidth: 1, borderColor: colors.line },
  selected: { borderColor: colors.blueDark, backgroundColor: colors.card },
  modelText: { flex: 1, gap: 2 },
  modelName: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  selection: { color: colors.muted, fontSize: 12 },
  selectedText: { color: colors.blueDark, fontWeight: "600" },
  levels: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  level: { minHeight: 34, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radii.chip, justifyContent: "center" },
  levelSelected: { borderColor: colors.blueDark, backgroundColor: `${colors.blueDark}12` },
  mode: { minHeight: 40, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, justifyContent: "center" },
  levelText: { color: colors.text, fontSize: 12 },
  credential: { gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderColor: colors.line },
  credentialHeading: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, paddingHorizontal: 12, color: colors.text, fontSize: 14, backgroundColor: colors.canvas },
  jsonInput: { minHeight: 240, maxHeight: 480, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, padding: 12, color: colors.text, fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", backgroundColor: colors.canvas },
  inlineAction: { alignSelf: "flex-start", minHeight: 34, paddingHorizontal: 0 },
  deleteText: { color: colors.danger, fontSize: 12 },
  error: { marginHorizontal: 20, color: colors.danger, fontSize: 13, lineHeight: 20 },
  status: { marginHorizontal: 20, color: colors.blueDark, fontSize: 13, lineHeight: 20 },
  confirm: { marginHorizontal: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.card },
  confirmTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  saveButton: { marginHorizontal: 20, minHeight: 48, borderRadius: radii.control },
  saveText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  actionText: { color: colors.text, fontSize: 13, fontWeight: "500" },
});
