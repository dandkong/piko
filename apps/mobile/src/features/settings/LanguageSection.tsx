import { useRef, useState, type ComponentRef } from "react";
import { ChevronDown } from "lucide-react-native";
import { Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnchoredMenuContent, type AnchoredMenuAction } from "../../components/AnchoredMenu";
import { TactilePressable } from "../../components/TactilePressable";
import { useLanguage, useTranslation, type LanguagePreference } from "../../i18n";
import { radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";

export function LanguageSection() {
  const { preference, setPreference } = useLanguage();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemeStyles(createStyles);
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState<{ left: number; top: number; width: number }>();
  const labels: Record<LanguagePreference, string> = {
    system: t("language.system"), "zh-CN": t("language.chinese"), en: t("language.english"),
  };
  const options: AnchoredMenuAction[] = (["system", "zh-CN", "en"] as const).map(value => ({
    id: value, label: labels[value], accessibilityLabel: labels[value], selected: preference === value,
    onPress: () => { setMenu(undefined); setPreference(value); },
  }));
  const openMenu = () => anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
    const menuWidth = Math.min(Math.max(anchorWidth, 216), width - 32);
    const left = Math.max(16, Math.min(x, width - menuWidth - 16));
    const below = y + anchorHeight + 6;
    const top = below + options.length * 50 <= height - insets.bottom - 8
      ? below : Math.max(insets.top + 8, y - options.length * 50 - 6);
    setMenu({ left, top, width: menuWidth });
  });
  return <>
    <View style={styles.section} testID="language-section">
      <Text style={styles.sectionTitle}>{t("language.title")}</Text>
      <View ref={anchor} collapsable={false}>
        <TactilePressable testID="language-dropdown" accessibilityRole="button"
          accessibilityLabel={t("language.current", { value: labels[preference] })}
          accessibilityState={{ expanded: !!menu }} variant="card" scaleTo={1} onPress={openMenu} faceStyle={styles.dropdown}>
          <Text style={styles.dropdownValue}>{labels[preference]}</Text>
          <ChevronDown size={18} strokeWidth={1.8} color={colors.muted} />
        </TactilePressable>
      </View>
    </View>
    <Modal transparent visible={!!menu} animationType="fade" onRequestClose={() => setMenu(undefined)}>
      {menu ? <AnchoredMenuContent {...menu} closeLabel={t("language.close")} label={t("language.choose")}
        onClose={() => setMenu(undefined)} actions={options} testID="language-options" /> : null}
    </Modal>
  </>;
}

function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
    section: { marginHorizontal: 20, gap: 8, paddingTop: 4 },
    sectionTitle: { color: colors.muted, fontSize: 13, lineHeight: 19, fontWeight: "500" },
    dropdown: { width: "100%", minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, borderRadius: radii.card },
    dropdownValue: { color: colors.text, fontSize: 15, lineHeight: 21, fontWeight: "500" },
  });
}
