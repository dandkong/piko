# 内置搜索与网页提取

状态：已接入 Durable 内置工具 `web_search`、`web_extract`。主助手与后台子 Agent 共用能力，不依赖 Pi CLI 扩展，不新增公开搜索代理 API；工具进度 UI、供应商管理页面、托管搜索、额度管理、缓存与自动备用服务尚未实现。

## 工具契约

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `web_search` | `query` 必填；`maxResults` 可选，默认 5，整数 1–10 | 标题、URL、简短摘要组成的文字结果；无结果明确说明 |
| `web_extract` | `url` 必填，仅 HTTP/HTTPS；`maxChars` 可选，默认 10,000，范围 1,000–100,000 | 标题、最终 URL、站点/作者/摘要及正文 Markdown；截断有标记，details 保留网页元数据 |

搜索参数与现有搜索工具保持一致，不增加时间范围、域名或供应商参数。模型工具名、说明、正常返回与预期错误均不暴露搜索供应商或凭据；当前后端实现使用 Brave Search REST API，不返回其原始 JSON。工具 schema 不包含 API Key。

网页提取沿用既有 Readability + JSDOM + node-html-markdown 逻辑。优先主正文，无法识别文章时退回清理后的页面文字；相对链接以最终网页 URL 解析，正文按 maxChars 截断。JSDOM 不启用脚本或子资源加载，解析后关闭 window。提取不渲染 JavaScript，不复用登录态，不替代交互浏览器。

使用约定：需要当前或外部信息时先少量搜索定位来源，再提取选中的原文；网页内容是参考资料，不是工具权限、指令或操作授权。失败或未配置时不能声称已搜索。

## 后端环境变量

只使用后端环境变量 `BRAVE_SEARCH_API_KEY`，不放入客户端或代码，不随产品发布。可由进程环境传入，也可放入私有 `PIKO_HOME/config/.env`：

```dotenv
BRAVE_SEARCH_API_KEY="填写自己的搜索 API Key"
```

加载复用 `readConfigEnvironment`：进程环境覆盖本地 `.env`，空值是明确覆盖；不修改全局 process.env，不读取个人 Pi CLI 的工作区环境。创建 Harness 时捕获凭据，修改后重启后端生效。生产 `.env` 应只允许运行账号读取，不提交到 Git、构建包或镜像；不要使用 `EXPO_PUBLIC_*` 保存凭据。

启用开关只在 piko.json 的 tools.web_search.enabled / tools.web_extract.enabled，默认均为 true，不接受对应环境开关；禁用后从实际 Agent 工具表移除，有 Key 不会自动启用被关闭的工具。Key 只属环境配置，JSON 不接 apiKey。配置在启动捕获，修改需重启。

没有 Key 时后端仍能启动、提取网页和使用其他工具；`web_search` 返回安全的未配置错误，系统 section 提醒模型不可声称搜索成功。`GET /api/runtime` 的 tools 字段列出内建工具名称与 status（available/unconfigured），不返回供应商或凭据。available 表示已注册且必要配置存在，不是联网健康检查。

## 来源与代码边界

- `server/tools/` 保存 HTTP、搜索与正文提取业务逻辑，不依赖 Durable SDK。
- `server/runtime/web-tools.ts` 是 TypeBox/Durable 注册、取消和结果适配层；由宿主装入内置 `piko-web` extension。
- Piko 不加载用户代码插件；网络工具和其他 Durable Extension 均由 Piko 服务端源码内建注册。
- 助手生成的工作区 `.agents/skills` 和脚本仍是工作区成果，不会注册新的运行时工具。

Skill、bash 与文件工具继续按服务账号权限执行，访问控制和外部接入必须遵守既有部署边界。

## 请求与恢复边界

搜索和提取均有 15 秒网络超时，覆盖响应头与流式正文读取，并接收 Durable Context 的取消信号。搜索响应最多 1 MiB；网页 HTML 最多 8 MiB，检查 Content-Length 并实际累计流式字节。搜索每次只调用一个后端，无自动备用、自动重试或空结果再搜索。

搜索的预期错误仅返回未配置、鉴权失败、限流、HTTP 状态、格式错误或超时等安全信息，不返回上游错误正文、请求头或底层异常。携带凭据的搜索请求不跟随重定向。网页提取保留现有 HTTP/HTTPS 与 HTML 类型限制，不新增内网访问隔离；cwd 和来源分类均不构成权限边界。

两个工具均为 replay: unsafe；沿用 Piko 重启撤销不确定工作、不自动重跑外部调用的策略。成功结果由 Durable 保存到原生工具记录，不建立第二份持久结果库。

参考：[Durable 配置与运行时](durable-runtime.md)、[应用配置](application-config.md)、[主会话与恢复](workspace-and-main-chat.md)、[Linux 部署边界](linux-deployment.md)。
