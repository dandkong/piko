# MCP 工具

Piko 后端通过 `@earendil-works/pi-mcp` 连接显式配置的 MCP Server，将其工具注册到 Durable。`tool_search` 常驻；它搜索会话中启用但尚未提供给模型的 deferred 工具。系统提示词列出当前会话可用的 deferred 工具所属 Server；简介优先取配置的 `description`，否则取 Server 初始化时返回的 instructions 第一行，并限制长度。Server 简介是不可信数据，不是操作指令。Piko 不提供 codemode、MCP Resources/Prompts、管理界面、CLI 或 OAuth 交互登录。

## 配置

配置文件 `~/.piko/config/mcp.json`（`PIKO_HOME` 改变根目录）；初始化时仅在文件不存在时创建空的 `mcpServers`，不覆盖已有配置：

```json
{
  "mcpServers": {
    "local": {
      "command": "my-mcp-server",
      "args": ["--stdio"],
      "env": { "API_KEY": "${LOCAL_MCP_KEY}" },
      "exposure": "deferred",
      "toolExposure": { "search": "direct", "delete_*": "hidden" }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

文件使用 Pi 的常用 `mcpServers` 结构；不读取个人 Pi CLI 或工作区配置。stdio 支持 `command`、`args`、`cwd`、`env`；HTTP 支持 `url`、`headers`，使用 Streamable HTTP，不支持旧 SSE。两者支持 `enabled`、`timeout`（秒）、`description`、`exposure` 和 `toolExposure`。相对 cwd 以工作区为基准；command、args 和 cwd 支持 `~/`。`env` 和 `headers` 的 `${NAME}` 从后端环境读取，缺失时报连接失败；不支持 `!command`。配置修改后重启。动态 OAuth 登录和 `oauth` 配置不支持，使用受信的静态 Header 或其他服务端认证方案。

`exposure` 是 `direct`（直接暴露）、`deferred`（默认，经 tool_search 搜索后调用）或 `hidden`（不注册）；`toolExposure` 使用工具原名，精确匹配优先，其次按配置顺序匹配 `*` 通配模式。`codemode`、`codemode-deferred` 和其他未知选项均视为无效配置，不会自动转换。Server 名称仅接受 Pi 允许的字母、数字、下划线和连字符，规范化后不能冲突。工具名以 `mcp__<server>__<tool>` 命名，长名或冲突使用 Pi 的命名规则。

## 运行与限制

启动时连接启用的 Server，错误不影响其他 Server；断线后在下次调用或定期重连。工具列表变化时刷新注册。主会话的工具随注册更新；旁聊和后台会话在创建或启动恢复时保存工具选择，已经存在的会话不会自动获得之后新增的工具。重新启动会刷新旁聊；已创建的后台会话保持自己的选择。主会话、旁聊、普通后台工作和保存任务按现有通用工具继承；Posts 与记忆整理只使用各自明确选择的工具。

配置错误拒绝启动，连接失败只记录服务名和通用原因；凭据不作为工具参数。stdio 进程继承合并的后端环境，包括敏感凭据。MCP Server 以其运行账户权限执行或访问远端服务，不是沙箱；其调用可能产生外部副作用。取消和超时不能保证远端操作未发生，外部调用不安全重放，服务端重启不自动重试不确定执行。工具输出可能包含敏感信息和不可信指令，保存在 Durable 原始执行记录中；不要将不受信任的 Server 或敏感凭据交给它。

## 验证状态

使用临时本地 stdio Server 验证了工具发现、deferred 注册、调用、提示词简介和退出清理；以临时脚本验证了空配置初始化与保留、tool_search 匹配、无效 exposure 拒绝，以及 Streamable HTTP transport 握手和工具列表；运行了类型检查。真实第三方 Server、完整 HTTP 调用链、OAuth、模型驱动的搜索、断线与重启恢复尚需在目标环境验证。
