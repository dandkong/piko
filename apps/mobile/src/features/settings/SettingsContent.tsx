import type { ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { SettingsOverview } from "../../../../../shared/settings";
import { TactilePressable } from "../../components/TactilePressable";
import { colors, radii, stateColors } from "../../theme";

export type SettingsPage = "overview" | "models" | "tools" | "channels" | "workspace" | "about";
export const settingsTitles: Record<SettingsPage, string> = {
  overview: "设置", models: "模型", tools: "工具与技能", channels: "通道", workspace: "工作区", about: "关于与运行",
};
const providerNames: Record<string, string> = { brave: "Brave", exa: "Exa", tavily: "Tavily", deepseek: "DeepSeek", firecrawl: "Firecrawl", "built-in": "内置提取" };

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.card}>{children}</View>
    {note ? <Text style={styles.note}>{note}</Text> : null}
  </View>;
}
function Info({ label, value }: { label: string; value: string }) {
  return <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue}>{value}</Text>
  </View>;
}
function NavigationRow({ page, value, onNavigate }: { page: Exclude<SettingsPage, "overview">; value: string; onNavigate: (page: SettingsPage) => void }) {
  return <TactilePressable
    accessibilityRole="button"
    accessibilityLabel={`查看${settingsTitles[page]}`}
    onPress={() => onNavigate(page)}
    variant="plain"
    scaleTo={1}
    faceStyle={styles.navigationRow}
    testID={`settings-open-${page}`}
  >
    <Text style={styles.navigationLabel}>{settingsTitles[page]}</Text>
    <Text numberOfLines={1} style={styles.navigationValue}>{value}</Text>
    <ChevronRight size={18} strokeWidth={1.8} color={colors.muted} />
  </TactilePressable>;
}

export function SettingsContent({ page, data, onNavigate, modelsEditor }: {
  page: SettingsPage;
  data: SettingsOverview;
  onNavigate: (page: SettingsPage) => void;
  modelsEditor?: ReactNode;
}) {
  if (page === "overview") return <View style={styles.content} testID="settings-overview">
    <View style={styles.summary}>
      <View style={styles.summaryHeading}>
        <Text style={styles.summaryTitle}>配置概览</Text>
        <Text style={styles.readOnly}>管理测试版</Text>
      </View>
      <Text numberOfLines={2} style={styles.summaryModel}>{data.mainModel?.model ?? "尚未选择主模型"}</Text>
      <Text style={styles.note}>一个主模型统一用于主聊天和所有旁聊。凭据只显示配置状态。</Text>
    </View>
    <View style={styles.group}>
      <Text style={styles.groupTitle}>模型与能力</Text>
      <NavigationRow page="models" value={`${data.availableModels.length} 个可选模型`} onNavigate={onNavigate} />
      <NavigationRow page="tools" value={`${data.skills.length} 项技能`} onNavigate={onNavigate} />
    </View>
    <View style={styles.group}>
      <Text style={styles.groupTitle}>连接</Text>
      <NavigationRow page="channels" value={data.telegram.enabled ? "Telegram 已启用" : "Telegram 未启用"} onNavigate={onNavigate} />
    </View>
    <View style={styles.group}>
      <Text style={styles.groupTitle}>数据与运行</Text>
      <NavigationRow page="workspace" value="目录与记忆" onNavigate={onNavigate} />
      <NavigationRow page="about" value={`Piko ${data.app.version}`} onNavigate={onNavigate} />
    </View>
    <Text style={styles.footer}>配置管理为功能验证阶段，尚未接入鉴权；请仅在受信任的网络环境中使用。</Text>
  </View>;

  if (page === "models") return modelsEditor ?? <View style={styles.content} testID="settings-detail-models">
    <Text style={styles.empty}>正在读取模型配置…</Text>
  </View>;

  if (page === "tools") return <View style={styles.content} testID="settings-detail-tools">
    <Section title="网页搜索" note="按配置顺序尝试已配置凭据的后端；凭据存在不等于远端验证成功。当前只读。">
      <Info label="启用状态" value={data.tools.search.enabled ? "已启用" : "已关闭"} />
      {data.tools.search.providers.map((provider, index) => <Info key={provider.id}
        label={`${index + 1}. ${providerNames[provider.id] ?? provider.id}`} value={provider.configured ? "凭据已配置" : "凭据未配置"} />)}
    </Section>
    <Section title="网页提取" note="可用提取方式由启动时的后端凭据决定；内置提取无需第三方密钥。">
      <Info label="启用状态" value={data.tools.extract.enabled ? "已启用" : "已关闭"} />
      <Info label="提取方式" value={data.tools.extract.providers.map(id => providerNames[id] ?? id).join("、")} />
    </Section>
    <Section title={`技能 · ${data.skills.length}`} note="技能只自动提供名称、描述和路径索引；正文由 Agent 按需读取。此处不提供启停或编辑。">
      {data.skills.length ? data.skills.map(skill => <View key={skill.name} style={styles.modelInfo}>
        <Info label={skill.name} value={skill.modelInvocable ? "提供模型索引" : "不注入模型"} />
        <Text style={styles.note}>{skill.description}</Text>
      </View>) : <Text style={styles.empty}>还没有发现可用技能。</Text>}
    </Section>
  </View>;

  if (page === "channels") return <View style={styles.content} testID="settings-detail-channels">
    <Section title="Telegram" note="这里显示配置，不是在线状态；未向 Telegram 发起测试请求。启用或修改凭据目前仍需在服务端配置并重启。">
      <Info label="通道" value={data.telegram.enabled ? "已启用" : "未启用"} />
      <Info label="Bot 凭据" value={data.telegram.credentialConfigured ? "已配置" : "未配置"} />
      <Info label="会话关系" value="与 App 共用主会话" />
      <Info label="访问范围" value="服务端指定用户的私聊" />
    </Section>
    <Text style={styles.footer}>不显示 Bot Token。允许用户、密钥编辑、连接测试和通道管理尚未接入设置页。</Text>
  </View>;

  if (page === "workspace") return <View style={styles.content} testID="settings-detail-workspace">
    <Section title="文件目录" note="这些目录位于后端机器，不是当前浏览器或手机的本地路径。工作区目录不能作为普通设置直接切换。">
      <Text style={styles.infoLabel}>当前工作区</Text>
      <Text selectable style={styles.path}>{data.workspace.path}</Text>
      <Text style={styles.infoLabel}>产物目录</Text>
      <Text selectable style={styles.path}>{data.workspace.artifactsPath}</Text>
    </Section>
    <Section title="记忆整理" note="只处理主会话；先维护每日记录，再评估长期记忆。没有在此提供手动触发或遗忘操作。">
      <Info label="主会话闲置" value={`${data.memory.idleMinutes} 分钟`} />
      <Info label="最低新增用户消息" value={`${data.memory.minimumUserMessages} 条可读消息`} />
      <Info label="长期记忆" value="MEMORY.md" />
      <Info label="每日记忆" value="memory/YYYY-MM-DD.md" />
    </Section>
    <Section title="数据边界">
      <Text style={styles.note}>会话和执行由 Durable 原生 SQLite 保存。任务执行目录独立于产物目录；工作区 cwd 和提示词不是文件权限沙箱。</Text>
    </Section>
  </View>;

  return <View style={styles.content} testID="settings-detail-about">
    <Section title="应用与后端">
      <Info label="应用" value={data.app.name} />
      <Info label="版本" value={data.app.version} />
      <Info label="运行时" value={data.app.runtime} />
      <Info label="模型目录" value={data.modelReady ? "存在可选模型" : "尚无可选模型"} />
    </Section>
    <Section title="配置来源" note="本页显示当前加载的配置，不读取或展示原始配置文件。文件修改不代表运行时已经生效。">
      <Info label="应用行为" value="piko.json" />
      <Info label="模型目录" value="models.json" />
      <Info label="模型凭据" value="auth.json / models.json" />
      <Info label="通道与工具凭据" value="后端环境 / 私有 .env" />
    </Section>
    <Text style={styles.footer}>当前为只读概览。配置保存、受控应用和服务重启需要统一的管理与访问控制，尚未在这里开放。</Text>
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 4, gap: 20 },
  summary: { marginHorizontal: 20, padding: 16, gap: 8, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.card },
  summaryHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  summaryTitle: { fontSize: 14, fontWeight: "500", color: colors.muted },
  summaryModel: { fontSize: 17, lineHeight: 24, fontWeight: "500", color: colors.text },
  readOnly: { fontSize: 12, color: colors.muted, backgroundColor: stateColors.selected, paddingHorizontal: 9, paddingVertical: 4, borderRadius: radii.chip },
  group: { gap: 2 },
  groupTitle: { paddingHorizontal: 20, marginBottom: 4, fontSize: 12, fontWeight: "500", color: colors.muted },
  navigationRow: { minHeight: 56, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", gap: 8 },
  navigationLabel: { flex: 1, fontSize: 16, fontWeight: "500", color: colors.text },
  navigationValue: { maxWidth: "44%", fontSize: 13, color: colors.muted },
  section: { marginHorizontal: 20, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "500", color: colors.muted },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, padding: 16, gap: 14 },
  infoRow: { minHeight: 24, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
  infoLabel: { flexShrink: 1, color: colors.muted, fontSize: 14, lineHeight: 21 },
  infoValue: { flexShrink: 1, maxWidth: "65%", color: colors.text, fontSize: 14, lineHeight: 21, textAlign: "right" },
  modelInfo: { gap: 5 },
  modelName: { color: colors.text, fontSize: 16, lineHeight: 23, fontWeight: "500" },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  path: { color: colors.text, fontSize: 14, lineHeight: 22, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  footer: { marginHorizontal: 20, color: colors.muted, fontSize: 12, lineHeight: 19 },
});
