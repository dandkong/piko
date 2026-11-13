import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { RefreshCw, Sparkles } from "lucide-react-native";
import type { PostSummary } from "../../../../../shared/posts";
import { IconButton } from "../../components/IconButton";
import { Screen, ScreenHeader } from "../../components/Screen";
import { TactilePressable } from "../../components/TactilePressable";
import { TactileListRow } from "../../components/TactileListRow";
import { PostActions } from "./PostActions";
import { TextButton } from "../../components/TextButton";
import { radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";
import type { FeedbackTone } from "../../components/FeedbackToast";
import { generatePost, loadPosts, loadPostGeneration } from "./api";
import { ErrorNotice } from "../../components/ErrorNotice";
import { ApiError, errorMessage } from "../../api/errors";
import { createUuidV4 } from "../../utils/uuid";
import { useTranslation } from "../../i18n";

const dayTime = (value: number, locale: string) => new Date(value).toLocaleString(locale, {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

/** Private posts use the same card surface and reader as the rest of the app. */
export function PostsScreen({ topInset, bottomInset, onPreview, onToast, revision, onDeleted }: {
  topInset: number; bottomInset: number; onPreview: (post: PostSummary) => void;
  revision: number; onDeleted: (id: string) => void;
  onToast: (message: string, tone?: FeedbackTone) => void;
}) {
  const { colors } = useTheme();
  const { t, language } = useTranslation();
  const translateRef = useRef(t);
  translateRef.current = t;
  const styles = useThemeStyles(createStyles);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [before, setBefore] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [generationNotice, setGenerationNotice] = useState<{ message: string; tone: "error" | "info" }>();
  const activeGeneration = useRef<string | undefined>(undefined);
  const pendingGenerationRequest = useRef<string | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const generationRequest = useRef<AbortController | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const moreBefore = useRef<string | undefined>(undefined);
  const refresh = useCallback(async (more = false) => {
    if (more && request.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    if (more) setMoreError(""); else { setError(""); setMoreError(""); }
    try {
      if (!more && activeGeneration.current) {
        try {
          const generation = await loadPostGeneration(activeGeneration.current, controller.signal);
          if (controller.signal.aborted) return;
          if (generation.status !== "running" && generation.status !== "stopping") {
            activeGeneration.current = undefined;
            setGenerationNotice(generation.status === "failed"
              ? { tone: "error", message: generation.reason || translateRef.current("posts.failed") }
              : undefined);
          }
        } catch (cause) {
          if (!controller.signal.aborted) setGenerationNotice({ tone: "error", message: errorMessage(cause, translateRef.current("posts.checkFailed"), translateRef.current) });
        }
      }
      const result = await loadPosts(more ? moreBefore.current : undefined, controller.signal);
      if (controller.signal.aborted) return;
      setPosts(current => more ? [...current, ...result.posts.filter(post => !current.some(item => item.id === post.id))] : result.posts);
      setBefore(result.nextBefore); moreBefore.current = result.nextBefore;
    } catch (cause) {
      if (!controller.signal.aborted) (more ? setMoreError : setError)(errorMessage(cause,
        translateRef.current(more ? "posts.moreFailed" : "posts.loadFailed"), translateRef.current));
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
      pendingGenerationRequest.current ??= createUuidV4();
      const result = await generatePost(controller.signal, pendingGenerationRequest.current);
      pendingGenerationRequest.current = undefined;
      if (controller.signal.aborted) return;
      activeGeneration.current = result.status === "running" || result.status === "stopping" ? result.id : undefined;
      setGenerationNotice(undefined);
      if (result.status === "completed") {
        await refresh();
        onToast(t("posts.generated"), "info");
      } else if (result.status === "skipped") {
        onToast(result.reason || t("posts.skipped"), "info");
      } else if (result.status === "failed" || result.status === "stopped") {
        setGenerationNotice({ message: result.reason || t("posts.incomplete"), tone: "error" });
      } else {
        onToast(t("posts.started"), "info");
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status < 500) pendingGenerationRequest.current = undefined;
        const message = errorMessage(cause, t("posts.unconfirmed"), t);
        if (cause instanceof ApiError && cause.code === "post_generation_busy") onToast(message, "warning");
        else setGenerationNotice({ message, tone: "error" });
      }
    } finally {
      if (generationRequest.current === controller) {
        generationRequest.current = undefined;
        setGenerating(false);
      }
    }
  }, [onToast, refresh, t]);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => {
      request.current?.abort();
      generationRequest.current?.abort();
      generationRequest.current = undefined;
      subscription.remove();
    };
  }, [refresh, revision]);

  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title={t("posts.title")} action={<View style={styles.headerActions}>
      <IconButton label={t("posts.generate")} hint={t("posts.generateHint")} onPress={() => void startGeneration()}
        disabled={generating} accessibilityState={{ busy: generating }} testID="generate-post-button" variant="primary">
        {generating ? <ActivityIndicator size="small" color={colors.text} />
          : <Sparkles size={19} strokeWidth={1.8} color={colors.text} />}
      </IconButton>
      <IconButton label={t("posts.refresh")} onPress={() => void refresh()} testID="refresh-posts-button">
        <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
      </IconButton>
    </View>} />
    {generationNotice ? <ErrorNotice message={generationNotice.message} tone={generationNotice.tone}
      actionLabel={t(pendingGenerationRequest.current ? "posts.retryRequest" : activeGeneration.current ? "posts.check" : "posts.regenerate")}
      onAction={() => void (pendingGenerationRequest.current || !activeGeneration.current ? startGeneration() : refresh())} busy={loading || generating}
      onDismiss={() => setGenerationNotice(undefined)} testID="post-generation-notice" /> : null}
    {error ? <ErrorNotice message={error} actionLabel={t("posts.reload")} onAction={() => void refresh()} busy={loading}
      testID="posts-load-error" /> : null}
    {!loading && !error && !posts.length ? <Text style={styles.empty}>{t("posts.empty")}</Text> : null}
    {posts.map(post => <TactileListRow key={post.id} surfaceVariant="card" style={styles.cardRow}>
      <TactilePressable variant="plain" stateFill={false} scaleTo={1} style={styles.cardHit}
      accessibilityRole="button" accessibilityLabel={t("posts.read", { title: post.title })}
      accessibilityHint={t("posts.readHint")} onPress={() => onPreview(post)}
      faceStyle={styles.card} testID="post-card">
      <Text style={styles.date}>{dayTime(post.createdAt, language)}</Text>
      <Text numberOfLines={2} style={styles.title}>{post.title}</Text>
      <Text numberOfLines={3} style={styles.excerpt}>{post.excerpt}</Text>
      <View style={styles.reasonBlock}>
        <Text style={styles.reasonLabel}>{t("posts.reason")}</Text>
        <Text numberOfLines={3} style={styles.reason}>{post.reason}</Text>
      </View>
      </TactilePressable>
      <View style={styles.menuSlot}><PostActions post={post} onDeleted={onDeleted} inRow /></View>
    </TactileListRow>)}
    {loading ? <ActivityIndicator accessibilityLabel={t("posts.loading")} color={colors.muted} /> : null}
    {moreError ? <ErrorNotice message={moreError} actionLabel={t("posts.retryMore")} onAction={() => void refresh(true)} busy={loading}
      testID="posts-more-error" /> : null}
    {before && !loading && !moreError ? <TextButton label={t("posts.loadMore")} onPress={() => void refresh(true)}>
      <Text style={styles.button}>{t("posts.loadMoreShort")}</Text>
    </TextButton> : null}
  </Screen>;
}
function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardRow: { flexDirection: "row", alignItems: "stretch" },
  cardHit: { flex: 1, minWidth: 0 },
  menuSlot: { position: "absolute", top: 6, right: 6 },
  card: { alignItems: "stretch", padding: 16, gap: 10, borderRadius: radii.card },
  date: { color: colors.weak, fontSize: 12, lineHeight: 18, minHeight: 28, paddingRight: 44 },
  title: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: "600" },
  excerpt: { color: colors.text, fontSize: 14, lineHeight: 21 },
  reasonBlock: { gap: 3 },
  reasonLabel: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: "500" },
  reason: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  button: { color: colors.text, fontSize: 14, fontWeight: "500" },
  });
}
