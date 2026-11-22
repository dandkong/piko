# Agent 运行时

Piko 通过 pi-durable 管理会话与执行，通过 pi-ai 接入模型；不依赖个人 Pi CLI 配置。版本以工作区依赖与锁文件为准。模型配置示例见[配置指南](../guides/configuration.zh-CN.md)，字段和凭据边界见[应用配置](configuration.md)。

## 首次配置

在 `PIKO_HOME/config/` 配置 `piko.json` 中的 `agent.profiles.main` 和模型凭据。未选择可用主模型时仍可启动和查看设置，但不能发送消息。`background` 未单独配置时动态跟随主模型；可在 App 设置或 Telegram 修改角色和思考强度。模型和支持的思考强度以实际供应商目录为准。

## 自定义供应商与参数

`models.json` 可配置自定义供应商的 API 类型、地址、模型能力与请求参数；支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。模型凭据放在 `auth.json` 或 `models.json` 的供应商 `apiKey`，不从环境变量回退；前者优先。`headersEnv` 只保存环境变量名，不保存 header 值。示例见[自定义模型供应商](../guides/configuration.zh-CN.md#自定义模型供应商)。

Piko 不单独配置 Durable retry 或 compaction；使用所锁定版本的默认策略。模型目录、凭据和工具配置由部署者管理，不通过 App 设置接口编辑。

## 工具输出边界

工具输出遵循所锁定 Durable 版本的默认上限：50 KiB 或 2,000 行，先达到者生效；默认保留开头，`bash` 保留末尾。网页工具和供应商可能有其他限制。

## 会话控制

主会话和旁聊共用全局主模型；后台工作在创建时选择后台策略。输入、停止和维护通过会话控制器协调。普通执行在重启后不自动重放；已完成后台结果的报告阶段可以恢复。实时观察和原始历史见[会话事件](../features/conversation-events.md)。

## 更新的生效时机

| 修改 | 生效方式 |
| --- | --- |
| 主/后台模型选择 | 热应用；前台会话在安全边界对齐，已有后台工作保持原选择 |
| 工作区指导和技能索引 | 每次模型请求前刷新；技能正文按需读取 |
| 模型目录、凭据、通道、MCP 和工具配置 | 按部署流程重启后端 |
| 内建模板 | 仅初始化缺失文件，不覆盖用户内容 |

## 技能与指导

技能来自工作区 `.agents/skills/<name>/SKILL.md` 和应用内建技能，同名时工作区优先；正文按需读取。工作区的 `AGENTS.md` 和 `MEMORY.md` 分别保存助手指导和长期记忆。Piko 不自动加载祖先指导、个人 Pi CLI 资源或工作区代码扩展。详见[资源与工具](../features/workspace.md#资源与工具)。

## 边界

文件、Shell 和 MCP 工具使用实际进程或服务权限，工作区不是沙箱。模型设置 API 使用单用户访问密钥，不提供多用户隔离。重启与备份见[存储说明](storage.md)；后台会话范围见[后台工作](../features/background-subagents.md)。
