import { memo, useMemo, useState } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import Markdown, {
  AstRenderer,
  renderRules as defaultRules,
  styles as defaultStyles,
  type ASTNode,
  type MarkdownStyles,
  type RenderRules,
} from "react-native-markdown-renderer";
import { colors } from "../../theme";
import { assistantMarkdown, isAssistantLink, prepareAssistantMarkdown } from "./markdown";

const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
const body = { color: colors.text, fontSize: 16, lineHeight: 24 };
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
  blockquote: { borderLeftWidth: 3, borderLeftColor: "#B7C9D4", paddingHorizontal: 12, marginBottom: 8 },
  codeInline: { color: colors.text, backgroundColor: "#E2E4E7", fontFamily: monospace, fontSize: 14, lineHeight: 24 },
  hr: { backgroundColor: "#D8DDE1", height: 1, marginVertical: 12 },
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
  code: { marginBottom: 8, backgroundColor: "#E2E4E7", borderRadius: 10, overflow: "hidden", maxWidth: "100%" },
  language: { color: colors.muted, fontSize: 12, paddingHorizontal: 12, paddingTop: 8 },
  codeContent: { padding: 12 },
  codeText: { color: colors.text, fontFamily: monospace, fontSize: 14, lineHeight: 21 },
  horizontal: { maxWidth: "100%", flexGrow: 0 },
  table: { marginBottom: 8, borderWidth: 1, borderColor: "#CDD5DC", borderRadius: 8, overflow: "hidden", alignSelf: "flex-start" },
  row: { flexDirection: "row" },
  cell: { width: 160, flexShrink: 0, padding: 10, borderRightWidth: 1, borderBottomWidth: 1, borderColor: "#CDD5DC" },
  headerCell: { backgroundColor: "#E2E8ED" },
  headerText: { ...body, fontWeight: "600" },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  imageAlt: { ...body, color: colors.muted },
  error: { fontSize: 13, color: colors.danger, marginTop: 8 },
});

export const AssistantMessage = memo(function AssistantMessage({ content, streaming = false }: {
  content: string;
  streaming?: boolean;
}) {
  const [linkError, setLinkError] = useState(false);
  const source = useMemo(() => prepareAssistantMarkdown(content, streaming), [content, streaming]);
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
    const cell: RenderRules[string] = (node, children) => (
      <View key={node.key} style={[ui.cell, node.type === "th" && ui.headerCell]}>
        <Text selectable style={[body, node.type === "th" && ui.headerText, {
          textAlign: node.attributes.style?.includes("right") ? "right" : node.attributes.style?.includes("center") ? "center" : "left",
        }]}>{children}</Text>
      </View>
    );
    const link: RenderRules[string] = (node, children) => isAssistantLink(node.attributes.href) ? (
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
      table: (node, children) => (
        <ScrollView key={node.key} horizontal style={ui.horizontal}>
          <View style={ui.table}>{children}</View>
        </ScrollView>
      ),
      tr: (node, children) => <View key={node.key} style={ui.row}>{children}</View>,
      th: cell,
      td: cell,
      link,
      blocklink: link,
      // Images remain descriptive text until attachment/media handling is available.
      image: (node) => <Text key={node.key} style={ui.imageAlt}>[{node.attributes.alt || node.content || "Image"}]</Text>,
    };
  }, []);
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
    <View style={ui.container}>
      <View style={ui.content}>
        <Markdown markdownit={assistantMarkdown} renderer={renderMarkdown}>{source}</Markdown>
      </View>
      {linkError && <Text accessibilityRole="alert" style={ui.error}>无法打开这个链接。</Text>}
    </View>
  );
});
