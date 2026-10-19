import { StyleSheet, Text } from "react-native";
import { Screen, ScreenCard, ScreenHeader } from "../../components/Screen";
import { colors } from "../../theme";
import { AssistantMessage } from "../chat/AssistantMessage";

type Post = { id: string; title: string; publishedAt: number; body: string };

/** Sample content only: it exists to check the posts layout before publishing is implemented. */
const POSTS: Post[] = [
  {
    id: "p1",
    title: "DeepSeek 新版把搜索 API 一起放了出来",
    publishedAt: Date.parse("2026-10-19T08:32:15+08:00"),
    body: "## 这次更新变了什么\n\n- 模型侧：上下文长度和工具调用稳定性提升，官方给了检索类任务的基准。\n- 接口侧：搜索 API 与模型同批开放，定价按调用量计算。\n\n## 我的判断\n\n对做个人助理的场景，这意味着不必再自己拼一层搜索代理；但对来源可控性要求高的场景，仍然值得保留自己的抓取和校验。\n\n## 还没确认的\n\n国内可访问性与限流策略没有在文档里写清楚。",
  },
  {
    id: "p2",
    title: "Claude Code 生态这周的三个变化",
    publishedAt: Date.parse("2026-10-18T21:05:41+08:00"),
    body: "## 变化\n\n1. 子代理可以按任务类型选择模型，成本下降。\n2. 权限确认从全局开关变成按工具类别。\n3. 技能支持从工作区加载，不再要求全局安装。\n\n## 影响\n\n长任务的产品化门槛又低了一点，剩下的难点在结果可信度和中断恢复。",
  },
  {
    id: "p3",
    title: "开源模型开始卷“工具调用”而不是参数",
    publishedAt: Date.parse("2026-10-17T09:14:02+08:00"),
    body: "这周的发布里，工具调用的成功率和多轮稳定性成了主要卖点。对做 Agent 的人来说，这比 MMLU 更有参考价值。\n\n需要注意的是，各家评测用的工具集不一样，横向比较仍然不可靠。",
  },
  {
    id: "p4",
    title: "浏览器自动化在 Agent 里的新用法",
    publishedAt: Date.parse("2026-10-16T18:47:33+08:00"),
    body: "## 观察\n\n纯视觉点击在长流程里失败率高，主要原因是等待和状态判断。\n\n更稳的做法是保留一个可复用的脚本层：模型负责生成和修正脚本，执行交给浏览器。\n\n## 代价\n\n脚本会过期，需要失败检测和重写机制。",
  },
  {
    id: "p5",
    title: "本地优先的助理产品又多了两个",
    publishedAt: Date.parse("2026-10-15T07:20:58+08:00"),
    body: "两个新产品都强调本地存储和自带模型。区别在于一个只做问答，另一个允许后台任务和主动提醒。\n\n主动能力的门槛不在模型，而在出错之后怎么收场。",
  },
  {
    id: "p6",
    title: "长上下文真的被用起来了吗",
    publishedAt: Date.parse("2026-10-14T22:11:09+08:00"),
    body: "从公开的使用统计看，长上下文的实际使用集中在代码库阅读和文档比对。\n\n这解释了为什么“压缩摘要”仍然重要：模型能读得多，不代表应该每次都读那么多。",
  },
  {
    id: "p7",
    title: "语音输入在移动端的体验分水岭",
    publishedAt: Date.parse("2026-10-13T12:03:27+08:00"),
    body: "测试了几个输入法，识别准确率差别不大，但插入文本的时机差别明显。\n\n对聊天类产品，语音更适合短句补充，不适合长段起草。",
  },
  {
    id: "p8",
    title: "把定时任务做成“承诺”而不是“配置”",
    publishedAt: Date.parse("2026-10-12T08:59:50+08:00"),
    body: "定时功能的产品难点不是调度，而是让用户知道它到底会不会做、做过什么。\n\n把状态写成一句话，比给一排开关更接近用户的心智。",
  },
  {
    id: "p9",
    title: "模型评测里最容易被忽略的一项：拒答",
    publishedAt: Date.parse("2026-10-11T20:26:14+08:00"),
    body: "评测通常只看答对多少，很少看“该答而不答”。\n\n对个人助理来说，过度拒答比答错更让人放弃使用。",
  },
  {
    id: "p10",
    title: "为什么很多 Agent 产品最后只剩下聊天框",
    publishedAt: Date.parse("2026-10-10T10:41:36+08:00"),
    body: "看了一圈产品，能长期留住用户的多半只有一个对话入口。\n\n其它页面要么变成“看一眼就走”的只读视图，要么逐渐荒废。这不代表不该做，而是它们必须足够轻。",
  },
];

/** Posts are read top to bottom: no detail page, the full body stays in the list. */
export function PostsScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title="帖子" />
    {POSTS.map(post => <ScreenCard key={post.id}>
      <Text style={styles.name}>{post.title}</Text>
      <Text style={styles.meta}>{stamp(post.publishedAt)}</Text>
      <AssistantMessage content={post.body} />
    </ScreenCard>)}
  </Screen>;
}

const stamp = (value: number) => new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const styles = StyleSheet.create({
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted, lineHeight: 20 },
});
