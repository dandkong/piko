import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { colors } from "../../theme";
import { AssistantMessage } from "../chat/AssistantMessage";

type Post = { id: string; title: string; publishedAt: string; summary: string; body: string; sources: string[] };

/** Sample content only: it exists to check the posts layout before publishing is implemented. */
const POSTS: Post[] = [
  {
    id: "p1",
    title: "DeepSeek 新版把搜索 API 一起放了出来",
    publishedAt: "10月19日",
    summary: "新模型在长上下文检索上更稳，官方这次同时开放了搜索接口，第三方检索层可能会被替代。",
    body: "## 这次更新变了什么\n\n- 模型侧：上下文长度和工具调用稳定性提升，官方给了检索类任务的基准。\n- 接口侧：搜索 API 与模型同批开放，定价按调用量计算。\n\n## 我的判断\n\n对做个人助理的场景，这意味着不必再自己拼一层搜索代理；但对来源可控性要求高的场景，仍然值得保留自己的抓取和校验。\n\n## 还没确认的\n\n国内可访问性与限流策略没有在文档里写清楚。",
    sources: ["官方发布说明", "API 定价页"],
  },
  {
    id: "p2",
    title: "Claude Code 生态这周的三个变化",
    publishedAt: "10月18日",
    summary: "子代理编排、权限提示和本地技能加载都有调整，整体更偏向“可控的长任务”。",
    body: "## 变化\n\n1. 子代理可以按任务类型选择模型，成本下降。\n2. 权限确认从全局开关变成按工具类别。\n3. 技能支持从工作区加载，不再要求全局安装。\n\n## 影响\n\n长任务的产品化门槛又低了一点，剩下的难点在结果可信度和中断恢复。",
    sources: ["变更日志"],
  },
  {
    id: "p3",
    title: "开源模型开始卷“工具调用”而不是参数",
    publishedAt: "10月17日",
    summary: "三个新模型都把函数调用成功率当作主指标，单纯的跑分竞赛在降温。",
    body: "这周的发布里，工具调用的成功率和多轮稳定性成了主要卖点。对做 Agent 的人来说，这比 MMLU 更有参考价值。\n\n需要注意的是，各家评测用的工具集不一样，横向比较仍然不可靠。",
    sources: ["模型卡", "评测说明"],
  },
  {
    id: "p4",
    title: "浏览器自动化在 Agent 里的新用法",
    publishedAt: "10月16日",
    summary: "从“让模型点页面”转向“让模型写脚本、脚本跑页面”，稳定性差别很大。",
    body: "## 观察\n\n纯视觉点击在长流程里失败率高，主要原因是等待和状态判断。\n\n更稳的做法是保留一个可复用的脚本层：模型负责生成和修正脚本，执行交给浏览器。\n\n## 代价\n\n脚本会过期，需要失败检测和重写机制。",
    sources: ["工程博客"],
  },
  {
    id: "p5",
    title: "本地优先的助理产品又多了两个",
    publishedAt: "10月15日",
    summary: "都把数据放在本机、模型可选，差异在“是否允许主动行动”。",
    body: "两个新产品都强调本地存储和自带模型。区别在于一个只做问答，另一个允许后台任务和主动提醒。\n\n主动能力的门槛不在模型，而在出错之后怎么收场。",
    sources: ["产品页"],
  },
  {
    id: "p6",
    title: "长上下文真的被用起来了吗",
    publishedAt: "10月14日",
    summary: "几份使用数据表明，大多数请求仍然在 8K 以内，长上下文更多是兜底而不是常态。",
    body: "从公开的使用统计看，长上下文的实际使用集中在代码库阅读和文档比对。\n\n这解释了为什么“压缩摘要”仍然重要：模型能读得多，不代表应该每次都读那么多。",
    sources: ["使用报告"],
  },
  {
    id: "p7",
    title: "语音输入在移动端的体验分水岭",
    publishedAt: "10月13日",
    summary: "端上识别和云端识别的差距在缩小，真正影响体验的是“说完到上屏”的那几百毫秒。",
    body: "测试了几个输入法，识别准确率差别不大，但插入文本的时机差别明显。\n\n对聊天类产品，语音更适合短句补充，不适合长段起草。",
    sources: ["对比测试"],
  },
  {
    id: "p8",
    title: "把定时任务做成“承诺”而不是“配置”",
    publishedAt: "10月12日",
    summary: "用户能理解的不是 Cron，而是“每天早上给我一份日报”这句话。",
    body: "定时功能的产品难点不是调度，而是让用户知道它到底会不会做、做过什么。\n\n把状态写成一句话，比给一排开关更接近用户的心智。",
    sources: ["设计笔记"],
  },
  {
    id: "p9",
    title: "模型评测里最容易被忽略的一项：拒答",
    publishedAt: "10月11日",
    summary: "同一个模型在不同提示下拒答率差别很大，这直接影响助理类产品的可用性。",
    body: "评测通常只看答对多少，很少看“该答而不答”。\n\n对个人助理来说，过度拒答比答错更让人放弃使用。",
    sources: ["评测汇总"],
  },
  {
    id: "p10",
    title: "为什么很多 Agent 产品最后只剩下聊天框",
    publishedAt: "10月10日",
    summary: "面板、仪表盘、任务列表都做过，最后留下的是能直接说话的那个入口。",
    body: "看了一圈产品，能长期留住用户的多半只有一个对话入口。\n\n其它页面要么变成“看一眼就走”的只读视图，要么逐渐荒废。这不代表不该做，而是它们必须足够轻。",
    sources: ["产品观察"],
  },
];

export function PostsScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  const [selected, setSelected] = useState<Post>();
  const post = selected;

  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title={post?.title ?? "帖子"} action={post
      ? <Pressable accessibilityRole="button" onPress={() => setSelected(undefined)} style={styles.back}><Text style={styles.backText}>返回</Text></Pressable>
      : undefined} />

    {!post && <Text style={styles.note}>示例内容，用来检查排版；主动发布尚未接入。</Text>}
    {!post && POSTS.map(value => <Pressable key={value.id} accessibilityRole="button" onPress={() => setSelected(value)}>
      <ScreenCard>
        <Text style={styles.name}>{value.title}</Text>
        <Text style={styles.meta}>{value.publishedAt} · {value.sources.length} 个来源</Text>
        <Text numberOfLines={2} style={styles.summary}>{value.summary}</Text>
      </ScreenCard>
    </Pressable>)}

    {post && <ScreenCard>
      <Text style={styles.meta}>{post.publishedAt}</Text>
      <AssistantMessage content={post.body} />
      <Text style={styles.sources}>{post.sources.join(" · ")}</Text>
    </ScreenCard>}
  </Screen>;
}

const styles = StyleSheet.create({
  back: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#F3F4F5" },
  backText: { fontSize: 13, color: colors.text },
  note: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  summary: { fontSize: 14, color: colors.text, lineHeight: 21 },
  sources: { fontSize: 13, color: colors.muted, lineHeight: 20, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10 },
});
