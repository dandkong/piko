import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import type { PostSummary } from "../../../../../shared/posts";
import { IconButton } from "../../components/IconButton";
import { Screen, ScreenHeader } from "../../components/Screen";
import { TactilePressable } from "../../components/TactilePressable";
import { TextButton } from "../../components/TextButton";
import { colors, radii } from "../../theme";
import { loadPosts } from "./api";

const dayTime = (value: number) => new Date(value).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

/** Private posts use the same card surface and reader as the rest of the app. */
export function PostsScreen({ topInset, bottomInset, onPreview }: {
  topInset: number; bottomInset: number; onPreview: (post: PostSummary) => void;
}) {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [before, setBefore] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
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
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => { request.current?.abort(); subscription.remove(); };
  }, [refresh]);

  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title="帖子" action={<IconButton label="刷新帖子列表" onPress={() => void refresh()}>
      <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
    </IconButton>} />
    {error ? <View style={styles.notice}>
      <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <TextButton label="重试读取帖子" onPress={() => void refresh()}><Text style={styles.button}>重试</Text></TextButton>
    </View> : null}
    {!loading && !error && !posts.length ? <Text style={styles.empty}>还没有帖子。</Text> : null}
    {posts.map(post => <TactilePressable key={post.id} variant="card" scaleTo={1}
      accessibilityRole="button" accessibilityLabel={`阅读帖子：${post.excerpt.slice(0, 48)}`}
      accessibilityHint="使用内置预览器阅读正文" onPress={() => onPreview(post)}
      faceStyle={styles.card} testID="post-card">
      <Text style={styles.date}>{dayTime(post.createdAt)}</Text>
      <Text numberOfLines={4} style={styles.excerpt}>{post.excerpt}</Text>
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
  card: { alignItems: "stretch", padding: 16, gap: 10, borderRadius: radii.card },
  date: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  excerpt: { color: colors.text, fontSize: 16, lineHeight: 24 },
  reasonBlock: { gap: 3 },
  reasonLabel: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: "500" },
  reason: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  notice: { alignItems: "flex-start", gap: 8 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  button: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
