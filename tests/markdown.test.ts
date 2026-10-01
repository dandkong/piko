import { describe, expect, test } from "bun:test";
import { assistantMarkdown, isAssistantLink, prepareAssistantMarkdown } from "../apps/mobile/src/features/chat/markdown";

const render = (source: string, streaming = false) => assistantMarkdown.render(prepareAssistantMarkdown(source, streaming));

describe("assistant Markdown", () => {
  test("renders formatting, nested lists, quotes and GFM tables", () => {
    const html = render("## 标题\n\n**加粗**和*强调*及~~删除~~\n\n- 外层\n  - 内层\n\n> 引用\n\n| 左 | 右 |\n| --- | ---: |\n| 内容 | 2 |");
    for (const tag of ["<h2>", "<strong>", "<em>", "<s>", "<blockquote>", "<table>"]) expect(html).toContain(tag);
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('style="text-align:right"');
  });

  test("completes streaming emphasis and Windows inline paths only for display", () => {
    const source = "我是 **Piko";
    expect(render(source, true)).toContain("<strong>Piko</strong>");
    expect(prepareAssistantMarkdown(source, false)).toBe(source);
    expect(render(source)).toContain("**Piko");
    expect(render("`C:\\Users\\14831\\.piko\\workspace", true)).toContain("<code>C:\\Users\\14831\\.piko\\workspace</code>");
  });

  test("unfinished links stay text until their full URL arrives", () => {
    expect(render("[官网](https://exa", true)).toBe("<p>官网</p>\n");
    expect(render("[官网](https://example.com)", true)).toContain('href="https://example.com"');
  });

  test("unfinished fences preserve literal code and line breaks", () => {
    const source = "```ts\nconst s = '**literal**';\nconsole.log(s);";
    const html = render(source, true);
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("**literal**");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("\nconsole.log(s);");
  });

  test("literal HTML remains text and raw URLs are linkified", () => {
    expect(render('<b>literal</b>\n<script>alert(1)</script>')).toContain("&lt;script&gt;");
    expect(render("https://example.com")).toContain('href="https://example.com"');
    expect(render("[bad](javascript:alert(1))")).not.toContain("href=");
  });

  test("only complete HTTP(S) links are actionable", () => {
    for (const url of ["https://example.com", "http://localhost:8081"]) expect(isAssistantLink(url)).toBe(true);
    for (const url of ["", "/relative", "javascript:alert(1)", "file:///C:/test", "data:text/html,test", "streamdown:incomplete-link"]) expect(isAssistantLink(url)).toBe(false);
  });
});
