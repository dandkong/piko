import { StyleSheet, Text } from "react-native";
import { Screen, ScreenHeader } from "../../components/Screen";
import { colors } from "../../theme";

/**
 * Placeholder for assistant-authored posts: sourced write-ups Piko publishes on its own.
 * The empty state stays honest until publishing exists; the page only reserves the shape.
 */
export function PostsScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  return <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title="帖子" />
    <Text style={styles.empty}>Piko 还没有发布过帖子。等它能主动找资料、写点东西时，有来源的内容会出现在这里。</Text>
  </Screen>;
}

const styles = StyleSheet.create({
  empty: { fontSize: 14, color: colors.muted, lineHeight: 22 },
});
