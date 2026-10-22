import { StyleSheet, Text } from "react-native";
import { Screen, ScreenHeader } from "../../components/Screen";
import { colors } from "../../theme";

/** No sample posts: publishing and the data source are not implemented yet. */
export function PostsScreen({
  topInset,
  bottomInset,
}: {
  topInset: number;
  bottomInset: number;
}) {
  return (
    <Screen testID="posts-screen" topInset={topInset} bottomInset={bottomInset}>
      <ScreenHeader title="帖子" />
      <Text style={styles.empty}>还没有帖子。</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.muted, fontSize: 14, lineHeight: 22 },
});
