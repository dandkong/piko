import { memo, useEffect, useMemo, useState } from "react";
import { Image, Linking, Platform, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import Markdown, {
  AstRenderer,
  renderRules as defaultRules,
  styles as defaultStyles,
  type ASTNode,
  type MarkdownStyles,
  type RenderRules,
} from "react-native-markdown-renderer";
import { colors, radii, stateColors } from "../theme";
import { contentMarkdown, isContentLink, isMarkdownImageUrl, prepareMarkdown } from "./markdown";

const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
const MIN_TABLE_CELL_WIDTH = 160;
const MAX_MARKDOWN_IMAGE_HEIGHT = 640;
const DEFAULT_IMAGE_ASPECT_RATIO = 3 / 2;
const body = { color: colors.text, fontSize: 16, lineHeight: 24 };

function firstTableRow(node: ASTNode): ASTNode | undefined {
  if (node.type === "tr") return node;
  for (const child of node.children) {
    const row = firstTableRow(child);
    if (row) return row;
  }
  return undefined;
}

function tableColumnCount(node: ASTNode): number {
  return firstTableRow(node)?.children.filter(child => child.type === "th" || child.type === "td").length || 1;
}
const markdownStyles: MarkdownStyles = {
  root: { flexShrink: 1, minWidth: 0 },
  text: body,
  strong: { fontWeight: "600" },
  paragraph: { marginBottom: 8 },
  headingContainer: { marginTop: 6, marginBottom: 8 },
  heading1Container: { borderBottomWidth: 0, paddingBottom: 0 },
  heading2Container: { borderBottomWidth: 0, paddingBottom: 0 },
  heading: { color: colors.text, fontWeight: "600" },
  heading1: { fontSize: 22, lineHeight: 29 },
  heading2: { fontSize: 20, lineHeight: 27 },
  heading3: { fontSize: 18, lineHeight: 25 },
  heading4: { fontSize: 16, lineHeight: 24 },
  heading5: { fontSize: 16, lineHeight: 24 },
  heading6: { fontSize: 16, lineHeight: 24 },
  list: { marginBottom: 8 },
  listItem: { minWidth: 0 },
  listUnorderedItemIcon: { ...body, marginLeft: 2, marginRight: 8 },
  listOrderedItemIcon: { ...body, marginLeft: 2, marginRight: 8 },
  blockquote: { borderLeftWidth: 3, borderLeftColor: colors.lineStrong, paddingHorizontal: 12, marginBottom: 8 },
  codeInline: { color: colors.text, backgroundColor: colors.codeSurface, fontFamily: monospace, fontSize: 14, lineHeight: 24 },
  hr: { backgroundColor: colors.lineStrong, height: 1, marginVertical: 12 },
};

const resolvedMarkdownStyles: MarkdownStyles = {
  ...defaultStyles,
  ...Object.fromEntries(Object.entries(markdownStyles).map(([name, style]) => [
    name,
    StyleSheet.flatten([(defaultStyles as MarkdownStyles)[name], style]),
  ])),
};

// The renderer's generated IDs (including its root key) change on every parse.
// Structural keys retain existing blocks and horizontal code/table scroll state
// while text grows; a genuine syntax/type change still replaces that node.
function stableMarkdownKeys(nodes: ASTNode[], parent = "md") {
  nodes.forEach((node, index) => {
    node.key = `${parent}/${index}:${node.type}`;
    stableMarkdownKeys(node.children, node.key);
  });
}

const ui = StyleSheet.create({
  container: { minWidth: 0, flexShrink: 1, maxWidth: "100%" },
  // Paragraphs retain spacing between blocks without adding space below a reply.
  content: { marginBottom: -8 },
  code: { marginBottom: 8, backgroundColor: colors.codeSurface, borderRadius: radii.control, overflow: "hidden", maxWidth: "100%" },
  language: { color: colors.muted, fontSize: 12, paddingHorizontal: 12, paddingTop: 8 },
  codeContent: { padding: 12 },
  codeText: { color: colors.text, fontFamily: monospace, fontSize: 14, lineHeight: 21 },
  horizontal: { maxWidth: "100%", flexGrow: 0 },
  table: { marginBottom: 8, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.control, overflow: "hidden" },
  row: { flexDirection: "row" },
  cell: { width: 160, flexShrink: 0, padding: 10, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.lineStrong },
  headerCell: { backgroundColor: stateColors.selected },
  headerText: { ...body, fontWeight: "600" },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  imageAlt: { ...body, color: colors.muted },
  image: { alignSelf: "center", marginVertical: 4 },
  error: { fontSize: 13, color: colors.danger, marginTop: 8 },
});

function MarkdownImage({ source, alt, availableWidth }: { source?: string; alt: string; availableWidth: number }) {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_IMAGE_ASPECT_RATIO);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!source) return;
    let active = true;
    // Use the cross-platform API: Web's delayed load event may no longer have
    // a target, and its nativeEvent does not contain React Native's source size.
    Image.getSize(source, (width, height) => {
      if (active && width > 0 && height > 0) setAspectRatio(width / height);
    }, () => {}); // The displayed Image owns the error/alt-text fallback.
    return () => { active = false; };
  }, [source]);
  if (!source || failed || availableWidth <= 0) {
    return <Text style={ui.imageAlt}>{`[${alt || "Image"}]`}</Text>;
  }

  const width = Math.min(availableWidth, MAX_MARKDOWN_IMAGE_HEIGHT * aspectRatio);
  const height = width / aspectRatio;
  return <Image
    testID="markdown-image"
    source={{ uri: source }}
    accessible={!!alt}
    accessibilityLabel={alt || undefined}
    resizeMode="contain"
    style={[ui.image, { width, height, maxWidth: availableWidth }]}
    onError={() => setFailed(true)}
  />;
}

export const MarkdownContent = memo(function MarkdownContent({ content, streaming = false }: {
  content: string;
  streaming?: boolean;
}) {
  const [linkError, setLinkError] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const source = useMemo(() => prepareMarkdown(content, streaming), [content, streaming]);
  const rules = useMemo<RenderRules>(() => {
    const code: RenderRules[string] = (node) => (
      <View key={node.key} style={ui.code}>
        {!!node.sourceInfo.trim() && <Text style={ui.language}>{node.sourceInfo.trim().split(/\s+/)[0]}</Text>}
        <ScrollView horizontal style={ui.horizontal} contentContainerStyle={ui.codeContent}>
          <Text selectable style={[ui.codeText, Platform.OS === "web" && { whiteSpace: "pre" } as TextStyle]}>
            {node.content.replace(/\n$/, "")}
          </Text>
        </ScrollView>
      </View>
    );
    const cell: RenderRules[string] = (node, children, parents) => {
      const table = parents.find(parent => parent.type === "table");
      const columns = table ? tableColumnCount(table) : 1;
      const width = Math.max(MIN_TABLE_CELL_WIDTH, containerWidth / columns);
      return (
        <View key={node.key} style={[ui.cell, { width }, node.type === "th" && ui.headerCell]}>
          <Text selectable style={[body, node.type === "th" && ui.headerText, {
            textAlign: node.attributes.style?.includes("right") ? "right" : node.attributes.style?.includes("center") ? "center" : "left",
          }]}>{children}</Text>
        </View>
      );
    };
    const link: RenderRules[string] = (node, children) => isContentLink(node.attributes.href) ? (
      <Text key={node.key} accessibilityRole="link" style={ui.link} onPress={() => {
        setLinkError(false);
        void Linking.openURL(node.attributes.href).catch(() => setLinkError(true));
      }}>{children}</Text>
    ) : <Text key={node.key}>{children}</Text>;
    return {
      textgroup: (node, children, _parents, styles) => (
        <Text key={node.key} selectable style={styles.text as TextStyle}>{children}</Text>
      ),
      list_item: (node, children, parents, styles) => {
        // Use the nearest list: an ordered sublist may have a bullet-list ancestor.
        const list = parents.find((parent) => parent.type === "ordered_list" || parent.type === "bullet_list");
        const ordered = list?.type === "ordered_list";
        const start = Number(list?.attributes.start ?? 1);
        return (
          <View key={node.key} style={styles.listUnorderedItem as ViewStyle}>
            <Text selectable style={styles.listUnorderedItemIcon as TextStyle}>
              {ordered ? `${start + node.index}${node.markup}` : "·"}
            </Text>
            <View style={styles.listItem as ViewStyle}>{children}</View>
          </View>
        );
      },
      code_block: code,
      fence: code,
      table: (node, children) => {
        const columns = tableColumnCount(node);
        const cellWidth = Math.max(MIN_TABLE_CELL_WIDTH, containerWidth / columns);
        return (
          <ScrollView key={node.key} horizontal style={[ui.horizontal, { width: containerWidth || "100%" }]}>
            <View testID="markdown-table" style={[ui.table, { width: cellWidth * columns }]}>{children}</View>
          </ScrollView>
        );
      },
      tr: (node, children) => <View key={node.key} style={ui.row}>{children}</View>,
      th: cell,
      td: cell,
      link,
      blocklink: link,
      image: (node) => {
        const source = isMarkdownImageUrl(node.attributes.src) ? node.attributes.src : undefined;
        return <MarkdownImage
          key={`${node.key}:${source ?? "blocked"}`}
          source={source}
          alt={node.attributes.alt || node.content || "Image"}
          availableWidth={containerWidth}
        />;
      },
    };
  }, [containerWidth]);
  const renderMarkdown = useMemo(() => {
    const renderer = new AstRenderer({ ...defaultRules, ...rules }, resolvedMarkdownStyles);
    return (nodes: ASTNode[]) => {
      stableMarkdownKeys(nodes);
      return (
        <View style={resolvedMarkdownStyles.root as ViewStyle}>
          {nodes.map(node => renderer.renderNode(node, []))}
        </View>
      );
    };
  }, [rules]);
  return (
    <View style={ui.container} onLayout={({ nativeEvent: { layout } }) => {
      setContainerWidth(current => Math.abs(current - layout.width) < 1 ? current : layout.width);
    }}>
      <View style={ui.content}>
        <Markdown markdownit={contentMarkdown} renderer={renderMarkdown}>{source}</Markdown>
      </View>
      {linkError && <Text accessibilityRole="alert" style={ui.error}>无法打开这个链接。</Text>}
    </View>
  );
});
