import { Screen, ScreenHeader } from "../../components/Screen";

/** Reserved tab: only the title for now; artifacts arrive with their own feature. */
export function ArtifactsScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  return <Screen testID="artifacts-screen" topInset={topInset} bottomInset={bottomInset}>
    <ScreenHeader title="产物" />
  </Screen>;
}
