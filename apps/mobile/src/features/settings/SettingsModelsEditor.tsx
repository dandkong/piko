import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { Check, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react-native";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import { SETTINGS_CREDENTIAL_PROVIDERS, type SettingsConfigurationSnapshot, type SettingsOverview } from "../../../../../shared/settings";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { colors, radii, stateColors } from "../../theme";
import type { SettingsEditorDraft } from "./editor-state";

type InputFocusEvent = Parameters<NonNullable<TextInputProps["onFocus"]>>[0];

const webTextInputStyle = { outlineStyle: "none" } as unknown as TextStyle;

export type SettingsPage = "home" | "main-model" | "background-model" | "credentials";

function sameModel(a: ModelSelection | null, b: ModelSelection | null) {
  return a?.provider === b?.provider && a?.model === b?.model;
}

function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.card}>{children}</View>
  </View>;
}

function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.menuCard}>{children}</View>
  </View>;
}

function MenuRow({ title, value, onPress }: { title: string; value: string; onPress: () => void }) {
  return <TactilePressable accessibilityRole="button" accessibilityLabel={`${title}，${value}`} onPress={onPress}
    variant="plain" scaleTo={1} faceStyle={styles.menuRow}>
    <View style={styles.menuText}>
      <Text style={styles.menuTitle}>{title}</Text>
      <Text numberOfLines={1} style={styles.menuValue}>{value}</Text>
    </View>
    <ChevronRight size={18} strokeWidth={1.8} color={colors.muted} />
  </TactilePressable>;
}

function modelSummary(selection: ModelSelection | null, models: SettingsOverview["availableModels"]) {
  if (!selection) return "尚未选择";
  const model = models.find(item => item.provider === selection.provider && item.id === selection.model);
  return model ? `${model.name} · ${model.provider}` : `${selection.provider} / ${selection.model}`;
}

const thinkingLevelOptions: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

function ModelSelectionPage({ kind, overview, selection, onSelect, onThinkingChange, saving }: {
  kind: "main-model" | "background-model";
  overview: SettingsOverview;
  selection: ModelSelection | null;
  onSelect: (model: SettingsOverview["availableModels"][number]) => void;
  onThinkingChange: (thinking: ThinkingLevel) => void;
  saving: boolean;
}) {
  const providers = useMemo(() => [...new Set(overview.availableModels.map(model => model.provider))].sort(), [overview.availableModels]);
  const [providerFilter, setProviderFilter] = useState("全部");
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const models = providerFilter === "全部" ? overview.availableModels
    : overview.availableModels.filter(model => model.provider === providerFilter);
  const selected = overview.availableModels.find(model => model.provider === selection?.provider && model.id === selection.model);
  const selectedThinking = selected
    ? selected.thinkingLevels.includes(selection?.thinking ?? "off") ? selection?.thinking ?? "off"
      : selected.thinkingLevels.includes("off") ? "off" : selected.thinkingLevels[0]
    : undefined;
  const title = kind === "main-model" ? "主模型" : "后台模型";

  return <View style={styles.modelPage}>
    {providers.length > 1 ? <View style={styles.group}>
      <Label>供应商</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.providerFilters}>
        {["全部", ...providers].map(provider => <TactilePressable key={provider} accessibilityRole="button" hitSlop={{ top: 5, bottom: 5 }}
          accessibilityLabel={`筛选供应商 ${provider}`} selected={providerFilter === provider}
          onPress={() => setProviderFilter(provider)} variant="plain" scaleTo={1} faceStyle={styles.providerChip}>
          <Text style={styles.providerText}>{provider}</Text>
        </TactilePressable>)}
      </ScrollView>
    </View> : null}

    <View style={styles.group}>
      <Label>模型</Label>
      {models.length ? <View style={styles.modelList}>
        {models.map((model, index) => {
          const active = selection?.provider === model.provider && selection.model === model.id;
          return <View key={`${model.provider}/${model.id}`}>
            <TactilePressable accessibilityRole="button"
              accessibilityLabel={`${title} ${model.name}${active ? "，已选" : ""}`} selected={active} disabled={saving} onPress={() => {
                setThinkingExpanded(false);
                onSelect(model);
              }}
              variant="plain" scaleTo={1} faceStyle={styles.modelRow}>
              <View style={styles.modelText}>
                <Text style={styles.modelName}>{model.name}</Text>
                <Text numberOfLines={1} style={styles.note}>{model.provider} / {model.id}</Text>
              </View>
              {active ? <Check size={19} strokeWidth={2} color={colors.text} /> : <View style={styles.emptyCheck} />}
            </TactilePressable>
            {index < models.length - 1 ? <View style={styles.modelSeparator} /> : null}
          </View>;
        })}
      </View> : <Text style={styles.note}>暂无可用模型。</Text>}
    </View>

    <View style={styles.group}>
      <Label>思考强度</Label>
      {!selected ? <Text style={styles.note}>请先选择模型。</Text>
        : !selectedThinking ? <Text style={styles.note}>该模型没有提供思考强度选项。</Text>
          : <>
            {selected.thinkingLevels.length > 1
              ? <TactilePressable accessibilityRole="button" accessibilityLabel={`${title}思考强度，当前${thinkingLevelOptions[selectedThinking]}`}
                accessibilityHint={thinkingExpanded ? "收起思考强度选项" : "展开思考强度选项"}
                accessibilityState={{ expanded: thinkingExpanded }} disabled={saving}
                onPress={() => setThinkingExpanded(value => !value)} variant="card" scaleTo={1} faceStyle={styles.thinkingSelect}>
                <Text style={styles.thinkingOptionTitle}>{thinkingLevelOptions[selectedThinking]}</Text>
                <ChevronDown size={18} strokeWidth={1.8} color={colors.muted}
                  style={{ transform: [{ rotate: thinkingExpanded ? "180deg" : "0deg" }] }} />
              </TactilePressable>
              : <View style={styles.thinkingSelect}>
                <Text style={styles.thinkingOptionTitle}>{thinkingLevelOptions[selectedThinking]}</Text>
              </View>}
            {thinkingExpanded && selected.thinkingLevels.length > 1 ? <View style={styles.thinkingOptions}>
              {selected.thinkingLevels.map((level, index, levels) => {
                const active = selectedThinking === level;
                return <View key={level}>
                  <TactilePressable accessibilityRole="radio" accessibilityLabel={`${title}思考强度：${thinkingLevelOptions[level]}`}
                    accessibilityState={{ selected: active }} disabled={saving}
                    onPress={() => { onThinkingChange(level); setThinkingExpanded(false); }}
                    variant="plain" selected={active} scaleTo={1} faceStyle={styles.thinkingOption}>
                    <Text style={[styles.thinkingOptionTitle, active && styles.thinkingOptionTitleSelected]}>{thinkingLevelOptions[level]}</Text>
                    {active ? <Check size={18} strokeWidth={2} color={colors.text} /> : <View style={styles.emptyCheck} />}
                  </TactilePressable>
                  {index < levels.length - 1 ? <View style={styles.modelSeparator} /> : null}
                </View>;
              })}
            </View> : null}
          </>}
    </View>
  </View>;
}

export function SettingsModelsEditor({ page, overview, snapshot, draft, loading, saving, error, status,
  onModelChange, onCredentialChange, onNavigate, onRetry }: {
    page: SettingsPage;
    overview: SettingsOverview;
    snapshot?: SettingsConfigurationSnapshot;
    draft?: SettingsEditorDraft;
    loading: boolean;
    saving: boolean;
    error: string;
    status: string;
    onModelChange: (draft: SettingsEditorDraft) => void;
    onCredentialChange: (draft: SettingsEditorDraft) => void;
    onNavigate: (page: SettingsPage) => void;
    onRetry: () => void;
  }) {
  const [expandedProviders, setExpandedProviders] = useState<string[]>([]);
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [focusedProvider, setFocusedProvider] = useState<string>();
  const [focusVisibleProvider, setFocusVisibleProvider] = useState<string>();
  useLayoutEffect(() => {
    if (saving || page !== "credentials") setVisibleKeys({});
  }, [page, saving]);

  if (loading && !snapshot) return <View style={styles.content}><Text style={styles.note}>正在读取可编辑配置…</Text></View>;
  if (!snapshot || !draft) return <View style={styles.content}>
    <Text accessibilityRole="alert" style={styles.error}>{error || "无法读取配置。"}</Text>
    <TextButton label="重试读取模型配置" disabled={loading} onPress={onRetry}><Text style={styles.actionText}>重试</Text></TextButton>
  </View>;

  const updateModel = (patch: Partial<SettingsEditorDraft>) => onModelChange({ ...draft, ...patch });
  const updateCredentials = (patch: Partial<SettingsEditorDraft>) => onCredentialChange({ ...draft, ...patch });
  const chooseMain = (model: SettingsOverview["availableModels"][number]) => {
    const old = draft.mainModel;
    const thinking = sameModel(old, { provider: model.provider, model: model.id }) && old?.thinking && model.thinkingLevels.includes(old.thinking)
      ? old.thinking : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0] ?? "off";
    const selection = { provider: model.provider, model: model.id, thinking };
    updateModel({ mainModel: selection, ...(draft.backgroundModel ? {} : { backgroundModel: selection }) });
  };
  const chooseBackground = (model: SettingsOverview["availableModels"][number]) => {
    const current = draft.backgroundModel ?? draft.mainModel;
    const thinking = sameModel(current, { provider: model.provider, model: model.id }) && current?.thinking && model.thinkingLevels.includes(current.thinking)
      ? current.thinking : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0] ?? "off";
    updateModel({ backgroundModel: { provider: model.provider, model: model.id, thinking } });
  };

  const configuredCount = SETTINGS_CREDENTIAL_PROVIDERS.filter(provider =>
    snapshot.credentials.find(credential => credential.providerId === provider.id)?.configured).length;

  if (page === "home") return <View style={styles.content} testID="settings-home">
    <MenuSection title="模型">
      <MenuRow title="主模型" value={modelSummary(draft.mainModel, overview.availableModels)} onPress={() => onNavigate("main-model")} />
      <View style={styles.separator} />
      <MenuRow title="后台模型" value={modelSummary(draft.backgroundModel, overview.availableModels)} onPress={() => onNavigate("background-model")} />
      <View style={styles.separator} />
      <MenuRow title="供应商凭据" value={`${configuredCount} 个已配置`} onPress={() => onNavigate("credentials")} />
    </MenuSection>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
  </View>;

  return <View style={styles.content} testID={`settings-${page}`}>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
    {(page === "main-model" || page === "background-model") ? <ModelSelectionPage
      key={page}
      kind={page}
      overview={overview}
      selection={page === "main-model" ? draft.mainModel : draft.backgroundModel}
      saving={saving}
      onSelect={page === "main-model" ? chooseMain : chooseBackground}
      onThinkingChange={thinking => {
        if (page === "main-model" && draft.mainModel) updateModel({ mainModel: { ...draft.mainModel, thinking } });
        if (page === "background-model" && draft.backgroundModel) updateModel({ backgroundModel: { ...draft.backgroundModel, thinking } });
      }}
    /> : null}

    {page === "credentials" ? <Section title="供应商凭据">
      {SETTINGS_CREDENTIAL_PROVIDERS.map((provider, index) => {
        const providerId = provider.id;
        const state = snapshot.credentials.find(item => item.providerId === providerId);
        const isOAuth = state?.type === "oauth";
        const expanded = expandedProviders.includes(providerId);
        const originalKey = state?.apiKey ?? "";
        const currentKey = draft.keyInputs[providerId] ?? originalKey;
        const keyVisible = !!visibleKeys[providerId] && !saving;
        const hasDraftKey = !!currentKey.trim();
        const status = isOAuth ? "OAuth 已配置"
          : originalKey && !hasDraftKey ? "待删除"
            : !hasDraftKey ? "未配置" : currentKey.trim() === originalKey.trim() ? "已配置" : "待保存";
        const statusStyle = status === "待保存" ? styles.statusPending
          : status === "待删除" ? styles.statusDanger : styles.note;
        return <View key={providerId} style={[styles.credential, index === SETTINGS_CREDENTIAL_PROVIDERS.length - 1 && styles.lastCredential]}>
          <TactilePressable accessibilityRole="button" accessibilityLabel={`${provider.label}，${status}`}
            accessibilityState={{ expanded }} onPress={() => {
              setExpandedProviders(current => expanded ? current.filter(id => id !== providerId) : [...current, providerId]);
              if (expanded) setVisibleKeys(current => ({ ...current, [providerId]: false }));
            }}
            variant="plain" scaleTo={1} faceStyle={styles.providerHeader}>
            <View style={styles.credentialHeading}>
              <Text style={styles.modelName}>{provider.label}</Text>
              <Text style={statusStyle}>{status}</Text>
            </View>
            <ChevronDown size={18} strokeWidth={1.8} color={colors.muted}
              style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }} />
          </TactilePressable>
          {expanded ? <View style={styles.providerBody}>
            {isOAuth ? <Text style={styles.note}>OAuth 凭据</Text> : <>
              <Label>API Key</Label>
              <View style={[styles.passwordField, focusedProvider === providerId && styles.passwordFieldFocused,
                focusVisibleProvider === providerId && styles.passwordFieldFocusVisible]}>
                <TextInput accessibilityLabel={`${provider.label} API Key`} value={currentKey} maxLength={8192}
                  selectTextOnFocus
                  onFocus={(event: InputFocusEvent) => {
                    setFocusedProvider(providerId);
                    const target = event.currentTarget as unknown as { matches?: (selector: string) => boolean } | null;
                    const focusVisible = target?.matches ? target.matches(":focus-visible") : true;
                    setFocusVisibleProvider(Platform.OS === "web" && focusVisible ? providerId : undefined);
                  }}
                  onBlur={() => {
                    setFocusedProvider(current => current === providerId ? undefined : current);
                    setFocusVisibleProvider(current => current === providerId ? undefined : current);
                  }}
                  onChangeText={value => {
                    const keyInputs = { ...draft.keyInputs, [providerId]: value };
                    updateCredentials({ keyInputs });
                    if (!value) setVisibleKeys(current => ({ ...current, [providerId]: false }));
                  }} secureTextEntry={!keyVisible} autoCapitalize="none" autoCorrect={false} editable={!saving}
                  placeholder="API Key" placeholderTextColor={colors.muted} returnKeyType="done"
                  style={[styles.passwordInput, Platform.OS === "web" && webTextInputStyle]} />
                <TactilePressable accessibilityRole="button"
                  accessibilityLabel={`${keyVisible ? "隐藏" : "预览"}${provider.label} API Key`}
                  accessibilityState={{ selected: keyVisible }}
                  disabled={saving || !hasDraftKey}
                  onPress={() => setVisibleKeys(current => ({ ...current, [providerId]: !current[providerId] }))}
                  variant="plain" scaleTo={1} faceStyle={styles.revealButton}>
                  {keyVisible
                    ? <EyeOff size={18} strokeWidth={1.8} color={colors.muted} />
                    : <Eye size={18} strokeWidth={1.8} color={colors.muted} />}
                </TactilePressable>
              </View>
            </>}
          </View> : null}
        </View>;
      })}
    </Section> : null}
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 4, paddingBottom: 20, gap: 18 },
  section: { marginHorizontal: 20, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "500", color: colors.muted },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, padding: 16, gap: 16 },
  menuCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden" },
  menuRow: { minHeight: 66, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 15, paddingVertical: 10 },
  menuText: { flex: 1, minWidth: 0, gap: 3 },
  menuTitle: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  menuValue: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: 14 },
  group: { gap: 8 },
  label: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  modelPage: { marginHorizontal: 20, gap: 18 },
  providerFilters: { gap: 7, paddingVertical: 1 },
  providerChip: { minHeight: 34, minWidth: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, justifyContent: "center" },
  providerText: { color: colors.text, fontSize: 12 },
  modelList: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden" },
  modelRow: { minHeight: 62, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 17 },
  modelSeparator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: 14 },
  emptyCheck: { width: 19, height: 19 },
  modelText: { flex: 1, minWidth: 0, gap: 2 },
  modelName: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  thinkingSelect: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.control },
  thinkingOptionTitle: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  thinkingOptionTitleSelected: { fontWeight: "600" },
  thinkingOptions: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden" },
  thinkingOption: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 12, paddingVertical: 6 },
  credential: { paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  lastCredential: { paddingBottom: 0, borderBottomWidth: 0 },
  providerHeader: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 4, borderRadius: radii.control },
  credentialHeading: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  providerBody: { gap: 8, paddingHorizontal: 4, paddingBottom: 8 },
  passwordField: { minHeight: 48, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, backgroundColor: colors.canvas },
  passwordFieldFocused: { borderColor: stateColors.focus },
  passwordFieldFocusVisible: { boxShadow: `0 0 0 1px ${stateColors.focus}` } as unknown as ViewStyle,
  passwordInput: { flex: 1, minWidth: 0, minHeight: 46, paddingHorizontal: 12, color: colors.text, fontSize: 14 },
  revealButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.control },
  error: { marginHorizontal: 20, color: colors.danger, fontSize: 13, lineHeight: 20 },
  statusPending: { color: colors.blueDark, fontSize: 12, lineHeight: 19 },
  statusDanger: { color: colors.danger, fontSize: 12, lineHeight: 19 },
  status: { marginHorizontal: 20, color: colors.blueDark, fontSize: 13, lineHeight: 20 },
  actionText: { color: colors.text, fontSize: 13, fontWeight: "500" },
});
