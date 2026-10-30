import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { RefreshCw, Sparkles } from "lucide-react-native";
import type { PostSummary } from "../../../../../shared/posts";
import { IconButton } from "../../components/IconButton";
import { Screen, ScreenHeader } from "../../components/Screen";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { colors, radii } from "../../theme";
import type { FeedbackTone } from "../../components/FeedbackToast";
import { generatePost, loadPosts } from "./api";

const dayTime = (value: number) => new Date(value).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

/** Private posts use the same card surface and reader as the rest of the app. */
export function PostsScreen({ topInset, bottomInset, onPreview, onToast }: {
  topInset: number; bottomInset: number; onPreview: (post: PostSummary) => void;
  onToast: (message: string, tone?: FeedbackTone) => void;
}) {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [before, setBefore] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const generationRequest = useRef<AbortController | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const moreBefore = useRef<string | undefined>(undefined);
  const refresh = useCallback(async (more = false) => {
    if (more && request.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    try {
      const result = await loadPosts(more ? moreBefore.current : undefined, controller.signal);
      if (controller.signal.aborted) return;
      setPosts(current => more ? [...current, ...result.posts.filter(post => !current.some(item => item.id === post.id))] : result.posts);
      setBefore(result.nextBefore); moreBefore.current = result.nextBefore;
    } catch {
      if (!controller.signal.aborted) setError("无法读取帖子，请检查连接后重试。");
    } finally {
      if (!controller.signal.aborted) { setLoading(false); request.current = undefined; }
    }
  }, []);
  const startGeneration = useCallback(async () => {
    if (generationRequest.current) return;
    const controller = new AbortController();
    generationRequest.current = controller;
    setGenerating(true);
    try {
      const result = await generatePost(controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "completed") {
        await refresh();
        onToast("帖子已生成。", "info");
      } else if (result.status === "skipped") {
        onToast(result.reason || "本次没有生成新帖子。", "info");
      } else if (result.status === "failed" || result.status === "stopped") {
        onToast(result.reason || "帖子生成未完成。", "error");
      } else {
        onToast("已开始生成帖子，完成后可刷新查看。", "info");
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "启动帖子生成失败，请重试。";
        onToast(message, message.includes("已有帖子正在生成") ? "warning" : "error");
      }
    } finally {
      if (generationRequest.current === controller) {
        generationRequest.current = undefined;
        setGenerating(false);
      }
    }
  }, [onToast, refresh]);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => {
      request.current?.abort();
      generationRequest.current?.abort();
      generationRequest.current = undefined;
      subscription.remove();
    };
  }, [refresh]);

  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title="帖子" action={<View style={styles.headerActions}>
      <IconButton label="生成帖子" hint="根据当前上下文生成一篇帖子" onPress={() => void startGeneration()}
        disabled={generating} accessibilityState={{ busy: generating }} testID="generate-post-button" variant="primary">
        {generating ? <ActivityIndicator size="small" color={colors.text} />
          : <Sparkles size={19} strokeWidth={1.8} color={colors.text} />}
      </IconButton>
      <IconButton label="刷新帖子列表" onPress={() => void refresh()} testID="refresh-posts-button">
        <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
      </IconButton>
    </View>} />
    {error ? <View style={styles.notice}>
      <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <TextButton label="重试读取帖子" onPress={() => void refresh()}><Text style={styles.button}>重试</Text></TextButton>
    </View> : null}
    {!loading && !error && !posts.length ? <Text style={styles.empty}>还没有帖子。</Text> : null}
    {posts.map(post => <TactilePressable key={post.id} variant="card" scaleTo={1}
      accessibilityRole="button" accessibilityLabel={`阅读帖子：${post.title}`}
      accessibilityHint="使用内置预览器阅读正文" onPress={() => onPreview(post)}
      faceStyle={styles.card} testID="post-card">
      <Text style={styles.date}>{dayTime(post.createdAt)}</Text>
      <Text numberOfLines={2} style={styles.title}>{post.title}</Text>
      <Text numberOfLines={3} style={styles.excerpt}>{post.excerpt}</Text>
      <View style={styles.reasonBlock}>
        <Text style={styles.reasonLabel}>生成理由</Text>
        <Text numberOfLines={3} style={styles.reason}>{post.reason}</Text>
      </View>
    </TactilePressable>)}
    {loading ? <ActivityIndicator accessibilityLabel="正在读取帖子" color={colors.muted} /> : null}
    {before && !loading ? <TextButton label="加载更多帖子" onPress={() => void refresh(true)}>
      <Text style={styles.button}>加载更多</Text>
    </TextButton> : null}
  </Screen>;
}
const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  card: { alignItems: "stretch", padding: 16, gap: 10, borderRadius: radii.card },
  date: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  title: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: "600" },
  excerpt: { color: colors.text, fontSize: 14, lineHeight: 21 },
  reasonBlock: { gap: 3 },
  reasonLabel: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: "500" },
  reason: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  notice: { alignItems: "flex-start", gap: 8 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  button: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
