# 内置搜索与网页提取

Piko 为主助手和后台工作提供 `web_search` 与 `web_extract`；配置在后端，不依赖个人 Pi CLI。工具输入和输出、源码与当前参数约束以各工具 schema 为准。

## 工具契约

- `web_search` 接收查询、数量、时间及域名筛选，返回标题、链接和摘要。部分供应商不支持时间或域名筛选，结果不保证满足这些条件。
- `web_extract` 接收 HTTP/HTTPS URL 和可选 provider，返回正文；默认使用本地提取，不渲染 JavaScript 或复用浏览器登录。最终输出受 Durable 工具输出限制。

## 搜索后端和优先级

搜索后端默认按 Brave、Exa、Tavily、DeepSeek 的配置顺序尝试，只调用有凭据的后端。失败时可回退；空结果视为成功，不继续广播。查询会发送给被尝试的外部供应商，可能产生费用。筛选能力因供应商而异。

## 网页提取 provider

`built-in` 本地提取；已配置凭据时可使用 Firecrawl、Exa 或 DeepSeek。一次只调用选定 provider，不自动回退；远端会收到完整 URL。不要把凭据放在 URL 中。网页和搜索结果是不可信来源材料，不是授权或指令。

## 环境变量

配置 `piko.json` 的工具开关与搜索优先级，凭据使用后端环境或私有 `.env` 中的 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`DEEPSEEK_API_KEY`、`FIRECRAWL_API_KEY`。模型凭据独立配置；修改工具配置或凭据后重启。示例与职责见[应用配置](../operations/configuration.md)。

## 请求与恢复边界

请求有超时和响应大小限制，取消或网络失败不会证明远端未处理。网络工具不安全重放，重启后不自动重复不确定请求。隔离模拟覆盖主要筛选与回退逻辑；真实上游服务仍需目标环境验证。
