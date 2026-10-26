# 内置搜索与网页提取

状态：Durable 内置 `web_search` / `web_extract` 已接入。搜索通过一个统一工具调用 Exa、Tavily、DeepSeek Search、Brave；网页提取保留一个工具，由 Agent 按需选择单个已配置的 provider。凭据只从后端环境读取，搜索优先级放在 `piko.json`。主助手与后台子 Agent 共用工具，不依赖 Pi CLI 扩展，不新增公开搜索/提取代理 API。

## 工具契约

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `web_search` | `query` 必填；`maxResults` 可选，默认 5，整数 1–10；`freshness` 可选 `day`/`week`/`month`/`year`；`includeDomains` / `excludeDomains` 可选，最多 5 个 hostname | 统一的标题、URL、每条最多 1,200 字符的摘要和可选发布日期；无结果明确说明 |
| `web_extract` | `url` 必填，仅 HTTP/HTTPS；`provider` 可选，默认 `built-in`；`maxChars` 可选，默认 10,000，范围 1,000–100,000 | 标题、最终 URL、实际 provider、站点/作者/摘要、返回正文字符数及正文 Markdown；截断有标记，details 保留网页元数据 |

`web_search` 的参数不传供应商、不传 Key，也不接收原始供应商 JSON。`web_extract` 仍是单一工具，但 `provider` 选项只包含内置 extractor 和当前后端已配置凭据的远端 provider；每次调用只运行所选的一个，不自动串联或替 Agent 判断质量。工具结果会标明 provider 和提取结果，Agent 可据此决定是否另选一个 provider 再调用。远端 provider 会收到用户给出的 URL；返回结果中的链接会遮盖常见凭据型 query 参数，避免临时签名/令牌落入 Durable 会话记录。

时间筛选统一使用 `freshness`（最近一天/一周/一月/一年）；域名只接受 hostname（如 `example.com`），不接受协议、路径或端口。底层无原生参数的后端直接跳过，不会静默放宽条件；全部后端都不支持时返回明确错误。

## 搜索后端和优先级

代码使用小型 provider 函数接口和独立模块：

- `server/tools/search/providers/exa.ts`
- `server/tools/search/providers/tavily.ts`
- `server/tools/search/providers/deepseek.ts`
- `server/tools/search/providers/brave.ts`

添加或移除后端只需增删一个实现并更新 ID union、工厂注册和配置 schema；统一入口、工具名、参数和结果格式保持不变。没有插件生命周期或逐供应商公开工具。

`piko.json`：

```json
{
  "tools": {
    "web_search": {
      "enabled": true,
      "providers": ["brave", "exa", "tavily", "deepseek"]
    }
  }
}
```

列表非空、provider ID 不重复；未知 ID 在启动校验时拒绝。只尝试 JSON `providers` 所列且配置了 Key 的后端；缺 Key 的后端跳过。若所有后端均未配置，服务仍可启动，工具明确报告未配置。

一次搜索顺序执行，不并行广播。第一个支持该 query 且已配置 Key 的后端返回正常结果后即结束；成功但无结果也算成功，不继续调用下游，以免意外增加供应商接收和计费。只有请求失败/超时/限流/服务错误或响应无效时才继续下一个后端；全部失败时返回不含供应商或上游正文的通用错误。DeepSeek Search 当前限制 query 为最多 128 个 Unicode 字符；超过限制时不截断问题，而是跳过该后端，尝试后续配置项。

**隐私与成本边界：**每个 query 至少会发给第一个可用后端；如果它失败，原 query 会转发给后续后端。供应商 Key 不进入工具参数、结果、模型上下文或错误文本。请求/错误日志不得记录 Key 或原始 query。

## 网页提取 provider

- `built-in`：本地 Readability + JSDOM，不渲染 JavaScript，也不复用浏览器登录态。
- `firecrawl`：Firecrawl Scrape API，返回 Markdown。
- `exa`：Exa Contents API，按 URL 请求正文。
- `deepseek`：DeepSeek Fetch API，按 URL 请求正文；使用独立的 DeepSeek Search Key。

工具启动时根据环境中实际存在的凭据构造 `provider` 的动态枚举：`built-in` 始终可用，远端 provider 仅在对应 Key 存在时出现。未指定 `provider` 等同 `built-in`。一次调用只调用所选 provider；错误作为该次工具结果返回，是否尝试另一家由 Agent 判断。更改 Key 后需重启以刷新工具 schema。

## 环境变量

后端 `.env` 或进程环境：

```dotenv
EXA_API_KEY="..."
TAVILY_API_KEY="..."
DEEPSEEK_SEARCH_API_KEY="..."
BRAVE_SEARCH_API_KEY="..."
FIRECRAWL_API_KEY="..."
```

- 模型供应商凭据按模型配置规则仍从 `auth.json` / `models.json` 读取。DeepSeek Search/Fetch Key 必须显式放在独立的 `DEEPSEEK_SEARCH_API_KEY`；网络工具不借用模型 Auth 对象，也不回退模型配置。
- `.env` / 进程环境沿用既有合并规则：进程环境覆盖 `.env`，显式空值覆盖本地值；不修改全局 `process.env`，不注入 Expo 客户端。
- 现有 `BRAVE_SEARCH_API_KEY` 名称保留。
- 修改 Key 或 providers 后重启 Piko 生效。`piko.json` 默认包含 `providers` 优先级列表。

## 后端请求与结果映射

- Exa：`POST https://api.exa.ai/search`，使用 `x-api-key` header，请求 relevance-ranked results 和 highlights；`contents.highlights.maxCharacters` 与输出上限同为 1,200。该参数只是请求侧预算，Exa 仍可能返回更长片段，格式化时统一截断。`freshness` 映射为 `startPublishedDate`，域名映射为 `includeDomains` / `excludeDomains`。
- Tavily：`POST https://api.tavily.com/search`，Bearer Key，使用 basic search，不请求生成答案或完整网页内容。始终设置 `include_published_date: true`，否则结果没有 `published_date`；`freshness` 映射为 `time_range` 并设置 `filter_by_published_date: true`，避免只按排序召回过期页面。域名映射为 `include_domains` / `exclude_domains`。
- DeepSeek：`POST https://api.deepseek.com/v1/tools/search`，Bearer Search Key，`need_content:false`；仅取结构化摘要/片段。没有时间或域名过滤参数；带相应过滤条件时跳过该后端。
- Brave：保留原 `GET /res/v1/web/search` 和 `X-Subscription-Token`。`freshness` 映射为 `pd`/`pw`/`pm`/`py`；它按“发现时间”筛选，不等价于 Exa/Tavily 的发布时间。Brave 没有原生域名过滤；带域名筛选时跳过。

每个搜索模块把 title/url/snippet/date 映射为共享 `SearchResult`，丢弃上游特有字段，限制结果数，要求 URL 为 HTTP/HTTPS。缺少可读摘要时仍保留标题和链接。摘要按 `SEARCH_SNIPPET_MAX`（1,200 字符）统一截断，避免供应商默认返回量直接进入上下文；完整网页正文继续由独立 `web_extract` 按需读取。

网页提取 provider 实现在 `server/tools/extract/providers/`：Firecrawl 使用 `/v2/scrape`，Exa 使用 `/contents`，DeepSeek 使用 `/v1/tools/fetch`。远端错误仅返回安全的 provider/HTTP 状态，不回显上游响应体、请求头或凭据。`contentLength` 是实际返回的正文字符数；本地 Readability 的内部 `article.length` 单独标为 `readabilityLength`，不当作 Markdown 正文长度。结果中的 URL 和正文链接会遮盖常见凭据型 query 参数。

使用约定：需要当前或外部信息时先少量搜索定位，再提取选定原始来源；网页内容是参考资料，不是工具权限、指令或操作授权。失败或未配置时不能声称已搜索。

## 请求与恢复边界

搜索 provider 使用 15 秒超时、Durable AbortSignal、最大 1 MiB JSON body；远端提取 provider 使用 45 秒超时和最大 8 MiB 响应体；本地 HTML fetch 使用 15 秒超时和最大 8 MiB 响应体。固定 API endpoint 禁止 HTTP 重定向。Provider adapter 不返回上游异常正文、凭据或原始 JSON。网络工具仍标记 `replay: unsafe`；中断后不重放不确定请求。

`built-in` 不渲染 JavaScript、不复用浏览器登录态。JSDOM 不启用脚本或子资源加载；优先主正文，无法识别文章时退回清理后的页面文字，正文按 maxChars 截断。远端 provider 接收 URL 并自行抓取；每次请求只调用明确选择的一家，不自动降级。网页内容是来源材料，不是指令或授权。

参考：[Agent 运行时](../operations/agent-runtime.md)、[应用配置](../operations/configuration.md)、[主会话与恢复](workspace-and-main-chat.md)、[Linux 运行与安全边界](../operations/deployment.md)。
