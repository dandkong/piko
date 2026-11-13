import { useRef, useState, type ComponentRef } from "react";
import { ChevronDown } from "lucide-react-native";
import { Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnchoredMenuContent, type AnchoredMenuAction } from "../../components/AnchoredMenu";
import { TactilePressable } from "../../components/TactilePressable";
import { useTranslation } from "../../i18n";
import { radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";

/** Device-local appearance preference; model/runtime settings remain server-managed. */
export function AppearanceSection() {
  const { appearance, setAppearance, colors } = useTheme();
  const { t } = useTranslation();
  const appearanceLabels = { system: t("settings.appearanceSystem"), dark: t("settings.appearanceDark"), light: t("settings.appearanceLight") };
  const styles = useThemeStyles(createStyles);
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState<{ left: number; top: number; width: number }>();
  const options: AnchoredMenuAction[] = (Object.keys(appearanceLabels) as Array<keyof typeof appearanceLabels>).map((value) => ({
    id: value,
    label: appearanceLabels[value],
    accessibilityLabel: t("settings.appearanceOption", { value: appearanceLabels[value] }),
    selected: appearance === value,
    onPress: () => {
      setMenu(undefined);
      setAppearance(value);
    },
  }));

  const openMenu = () => {
    anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
      const menuWidth = Math.min(Math.max(anchorWidth, 216), width - 32);
      const menuHeight = options.length * 50;
      const left = Math.max(16, Math.min(x, width - menuWidth - 16));
      const below = y + anchorHeight + 6;
      const top = below + menuHeight <= height - insets.bottom - 8
        ? below
        : Math.max(insets.top + 8, y - menuHeight - 6);
      setMenu({ left, top, width: menuWidth });
    });
  };

  return <>
    <View style={styles.section} testID="appearance-section">
      <Text style={styles.sectionTitle}>{t("settings.appearance")}</Text>
      <View ref={anchor} collapsable={false}>
        <TactilePressable
          testID="appearance-dropdown"
          accessibilityRole="button"
          accessibilityLabel={t("settings.appearanceCurrent", { value: appearanceLabels[appearance] })}
          accessibilityState={{ expanded: !!menu }}
          variant="card"
          scaleTo={1}
          onPress={openMenu}
          faceStyle={styles.dropdown}
        >
          <Text style={styles.dropdownValue}>{appearanceLabels[appearance]}</Text>
          <ChevronDown size={18} strokeWidth={1.8} color={colors.muted} />
        </TactilePressable>
      </View>
    </View>
    <Modal transparent visible={!!menu} animationType="fade" onRequestClose={() => setMenu(undefined)}>
      {menu ? <AnchoredMenuContent
        left={menu.left}
        top={menu.top}
        width={menu.width}
        closeLabel={t("settings.appearanceClose")}
        label={t("settings.appearanceChoose")}
        onClose={() => setMenu(undefined)}
        actions={options}
        testID="appearance-options"
      /> : null}
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
