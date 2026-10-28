import { useMemo, useRef, useState } from "react";
import {
  Modal, Pressable, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { Check, ChevronDown } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import type { ModelSettingsSnapshot } from "../../../../../shared/settings";
import { AppScrollView } from "../../components/AppScrollView";
import { TactilePressable } from "../../components/TactilePressable";
import { colors, controlSizes, radii, stateColors } from "../../theme";

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高",
};

type ModelInfo = ModelSettingsSnapshot["availableModels"][number];
type Role = "main" | "background";

function sameModel(a: ModelSelection | null, b: ModelSelection | null) {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

function selectedInfo(selection: ModelSelection | null, models: ModelSettingsSnapshot["availableModels"]) {
  if (!selection) return undefined;
  return models.find(model => model.provider === selection.provider && model.id === selection.model);
}

function modelLabel(selection: ModelSelection | null, models: ModelSettingsSnapshot["availableModels"]) {
  if (!selection) return "尚未选择";
  const model = selectedInfo(selection, models);
  return model ? `${model.name} · ${model.provider}` : `${selection.provider} / ${selection.model}`;
}

function defaultThinking(model: ModelInfo, preferred?: ThinkingLevel) {
  return preferred && model.thinkingLevels.includes(preferred)
    ? preferred
    : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0] ?? "off";
}

function ModelDropdown({ role, selection, mainModel, models, disabled, onSelect }: {
  role: Role;
  selection: ModelSelection | null;
  mainModel: ModelSelection | null;
  models: ModelSettingsSnapshot["availableModels"];
  disabled: boolean;
  onSelect: (selection: ModelSelection | null) => void;
}) {
  const anchor = useRef<View>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState<{ left: number; top: number; width: number; height: number }>();
  const followsMain = role === "background" && selection === null;
  const title = role === "main" ? "主模型" : "后台模型";
  const value = followsMain
    ? mainModel ? `跟随主模型 · ${modelLabel(mainModel, models)}` : "跟随主模型（主模型尚未选择）"
    : modelLabel(selection, models);
  const menuOptions = useMemo(() => [
    ...(role === "background" ? [{ id: "follow-main", label: "跟随主模型", selection: null as ModelSelection | null }] : []),
    ...models.map(model => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.name} · ${model.provider}`,
      selection: { provider: model.provider, model: model.id } as ModelSelection,
    })),
  ], [models, role]);

  const openMenu = () => {
    anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
      const menuWidth = Math.min(Math.max(anchorWidth, 260), width - 32);
      const menuHeight = Math.min(360, menuOptions.length * 50, height - insets.top - insets.bottom - 32);
      const left = Math.max(16, Math.min(x, width - menuWidth - 16));
      const below = y + anchorHeight + 6;
      const top = below + menuHeight <= height - insets.bottom - 8
        ? below : Math.max(insets.top + 8, y - menuHeight - 6);
      setMenu({ left, top, width: menuWidth, height: menuHeight });
    });
  };

  return <>
    <View ref={anchor} collapsable={false}>
      <TactilePressable testID={`${role}-model-dropdown`} accessibilityRole="button"
        accessibilityLabel={`${title}：${value}`} accessibilityState={{ expanded: !!menu }}
        disabled={disabled} onPress={openMenu} variant="card" scaleTo={1} faceStyle={styles.dropdown}>
        <Text numberOfLines={1} style={styles.dropdownValue}>{value}</Text>
        <ChevronDown size={18} strokeWidth={1.8} color={colors.muted} />
      </TactilePressable>
    </View>
    <Modal transparent visible={!!menu} animationType="fade" onRequestClose={() => setMenu(undefined)}>
      {menu ? <View style={StyleSheet.absoluteFill}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭模型列表"
          onPress={() => setMenu(undefined)} style={StyleSheet.absoluteFill} />
        <View testID={`${role}-model-options`} style={[styles.dropdownMenu, menu]}>
          <AppScrollView keyboardShouldPersistTaps="handled" showScrollbar>
            {menuOptions.map(option => {
              const active = option.selection === null
                ? followsMain
                : sameModel(selection, option.selection);
              return <View key={option.id}>
                <TactilePressable accessibilityRole="button" accessibilityLabel={`${title}：${option.label}${active ? "，已选" : ""}`}
                  selected={active} onPress={() => { setMenu(undefined); onSelect(option.selection); }}
                  variant="plain" scaleTo={1} faceStyle={styles.dropdownOption}>
                  <Text numberOfLines={1} style={[styles.dropdownOptionText, active && styles.dropdownOptionSelected]}>{option.label}</Text>
                  {active ? <Check size={18} strokeWidth={2} color={colors.text} /> : null}
                </TactilePressable>
              </View>;
            })}
          </AppScrollView>
        </View>
      </View> : null}
    </Modal>
  </>;
}

function ThinkingTabs({ role, model, selected, onSelect }: {
  role: Role;
  model?: ModelInfo;
  selected?: ThinkingLevel;
  onSelect: (level: ThinkingLevel) => void;
}) {
  if (!model) return <Text style={styles.note}>选择主模型后可设置思考强度。</Text>;
  const levels = model.thinkingLevels;
  if (!levels.length) return <Text style={styles.note}>该模型没有思考强度选项。</Text>;
  return <View accessibilityRole="radiogroup" accessibilityLabel={`${role === "main" ? "主模型" : "后台模型"}思考强度`}
    testID={`${role}-thinking-tabs`} style={styles.thinkingTabs}>
    {levels.map(level => {
      const active = (selected ?? "off") === level;
      return <TactilePressable key={level} testID={`${role}-thinking-${level}`} accessibilityRole="radio"
        accessibilityLabel={thinkingLabels[level]} accessibilityState={{ selected: active }} selected={active}
        onPress={() => onSelect(level)} variant="plain" scaleTo={1}
        style={styles.thinkingTabPressable} faceStyle={styles.thinkingTab}>
        <Text style={[styles.thinkingText, active && styles.thinkingTextSelected]}>{thinkingLabels[level]}</Text>
      </TactilePressable>;
    })}
  </View>;
}

export function SettingsModelsEditor({ snapshot, onChange }: {
  snapshot: ModelSettingsSnapshot;
  onChange: (mainModel: ModelSelection | null, backgroundModel: ModelSelection | null, backgroundThinking: ThinkingLevel | null) => void;
}) {
  const mainInfo = selectedInfo(snapshot.mainModel, snapshot.availableModels);
  const explicitBackground = snapshot.backgroundModel;
  const effectiveBackground = explicitBackground ?? snapshot.mainModel;
  const backgroundInfo = selectedInfo(effectiveBackground, snapshot.availableModels);
  const mainThinking = mainInfo ? defaultThinking(mainInfo, snapshot.mainModel?.thinking) : undefined;
  const backgroundThinking = backgroundInfo
    ? defaultThinking(backgroundInfo, explicitBackground?.thinking ?? snapshot.backgroundThinking ?? snapshot.mainModel?.thinking)
    : undefined;

  const selectModel = (role: Role, model: ModelInfo | null) => {
    if (role === "main") {
      if (!model) return;
      const mainModel = { provider: model.provider, model: model.id, thinking: defaultThinking(model, mainThinking) };
      const nextBackgroundThinking = !snapshot.backgroundModel && snapshot.backgroundThinking &&
        !model.thinkingLevels.includes(snapshot.backgroundThinking) ? null : snapshot.backgroundThinking;
      onChange(mainModel, snapshot.backgroundModel, nextBackgroundThinking);
      return;
    }
    if (!model) {
      onChange(snapshot.mainModel, null, null);
      return;
    }
    const thinking = defaultThinking(model, backgroundThinking);
    onChange(snapshot.mainModel, { provider: model.provider, model: model.id, thinking }, null);
  };

  const selectThinking = (role: Role, thinking: ThinkingLevel) => {
    if (role === "main" && snapshot.mainModel)
      onChange({ ...snapshot.mainModel, thinking }, snapshot.backgroundModel, snapshot.backgroundThinking);
    else if (role === "background") {
      if (snapshot.backgroundModel)
        onChange(snapshot.mainModel, { ...snapshot.backgroundModel, thinking }, null);
      else onChange(snapshot.mainModel, null, thinking);
    }
  };

  return <View style={styles.content} testID="settings-home">
    <ModelSection title="主模型" role="main" selection={snapshot.mainModel} mainModel={snapshot.mainModel}
      models={snapshot.availableModels} model={mainInfo} thinking={mainThinking}
      onModel={model => selectModel("main", model)} onThinking={thinking => selectThinking("main", thinking)} />
    <ModelSection title="后台模型" role="background" selection={explicitBackground} mainModel={snapshot.mainModel}
      models={snapshot.availableModels} model={backgroundInfo} thinking={backgroundThinking}
      onModel={model => selectModel("background", model)} onThinking={thinking => selectThinking("background", thinking)} />
    {!snapshot.availableModels.length ? <Text style={styles.notice}>
      部署中尚未配置可用模型。请在部署配置中添加模型和凭据，然后重启 Piko。
    </Text> : null}
  </View>;
}

function ModelSection({ title, role, selection, mainModel, models, model, thinking, onModel, onThinking }: {
  title: string;
  role: Role;
  selection: ModelSelection | null;
  mainModel: ModelSelection | null;
  models: ModelSettingsSnapshot["availableModels"];
  model?: ModelInfo;
  thinking?: ThinkingLevel;
  onModel: (model: ModelInfo | null) => void;
  onThinking: (thinking: ThinkingLevel) => void;
}) {
  return <View style={styles.section} testID={`${role}-model-section`}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.card}>
      <ModelDropdown role={role} selection={selection} mainModel={mainModel} models={models} disabled={role === "main" && models.length === 0}
        onSelect={value => onModel(value ? models.find(model => model.provider === value.provider && model.id === value.model) ?? null : null)} />
      <ThinkingTabs role={role} model={model} selected={thinking} onSelect={onThinking} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 4, paddingBottom: 20, gap: 20 },
  section: { marginHorizontal: 20, gap: 8 },
  sectionTitle: { color: colors.muted, fontSize: 13, lineHeight: 19, fontWeight: "500" },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, padding: 14, gap: 14 },
  dropdown: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 12, borderRadius: radii.control },
  dropdownValue: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, lineHeight: 20 },
  dropdownMenu: { position: "absolute", overflow: "hidden", borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.card, shadowColor: colors.text, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.14, shadowRadius: 14, elevation: 8 },
  dropdownOption: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 14, borderRadius: 0 },
  dropdownOptionText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  dropdownOptionSelected: { fontWeight: "600" },
  thinkingTabs: { width: "100%", flexDirection: "row", alignItems: "stretch", gap: 1, padding: 3, backgroundColor: "transparent", borderWidth: 1, borderColor: colors.line, borderRadius: radii.pill },
  thinkingTabPressable: { flex: 1, minWidth: 0 },
  thinkingTab: { flex: 1, minWidth: 0, minHeight: controlSizes.md, paddingHorizontal: 1, borderRadius: radii.pill },
  thinkingText: { color: colors.muted, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  thinkingTextSelected: { color: colors.text, fontWeight: "600" },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  notice: { marginHorizontal: 20, color: colors.muted, fontSize: 12, lineHeight: 19 },
});
