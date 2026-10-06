# Durable 配置与插件

状态：服务端已接入 pi-durable / pi-ai 1.0.4，使用 Piko 原有 HTTP/SSE 和 UI。无需 Pi CLI，不读取 `~/.pi/agent`。模型/插件管理界面尚未实现，可编辑 JSON 并调用控制 API。

## 首次配置

启动前指定新的测试数据目录（已存在旧版状态时尤其如此）：

```powershell
$env:PIKO_HOME = Join-Path $env:USERPROFILE ".piko-durable-test"
bun run dev
```

首次启动补齐 config、extensions、skills、state 和 workspace，只创建缺失文件。未配置模型时仍能打开 API、查看主会话和配置元数据，发送消息会提示配置模型。旧状态不会自动迁移或删除。

`config/auth.json` 存凭据，以 provider ID 为键。DeepSeek 示例：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "填写你的 DeepSeek API Key"
  }
}
```

`config/settings.json` 存模型预设和运行参数：

```json
{
  "version": 1,
  "defaultProfile": "quick",
  "profiles": {
    "quick": {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "off"
    },
    "careful": {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "high"
    }
  },
  "compaction": { "enabled": true },
  "retry": { "enabled": true, "maxRetries": 2 }
}
```

上述 ID 来自锁定的 pi-ai 1.0.4 内建目录。DeepSeek 无需额外定义供应商，`config/models.json` 保持 `{"providers":{}}` 即可。实际可用模型以 GET /api/runtime 返回为准：目录中存在模型也须有可用凭据。

第一次创建原生会话使用 defaultProfile；未设置时选第一个可用模型。已有会话的选择保存在原生日志，重启和重载会保留。修改 defaultProfile 后若需切换当前会话，再调用 selection API。最初没有模型的会话在重载后可以启用新配置。

通用思考值为 off/minimal/low/medium/high/xhigh/max；只接受所选模型实际支持的值，能力列表见 thinkingLevels。例如本版本 deepseek-flash 支持 off/low/high/max。Piko 不把所有思考值强行映射到每个供应商。

## 自定义供应商与参数

models.json 支持内建供应商覆盖和自定义模型。API Key 可以放 auth.json，模型元数据和请求默认值放 models.json：

```json
{
  "providers": {
    "my-provider": {
      "api": "openai-completions",
      "baseUrl": "https://your-endpoint.example/v1",
      "request": { "temperature": 0.2, "maxTokens": 4096 },
      "compat": {
        "supportsStore": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "your-model-id",
          "name": "My model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "samplingParams": { "top_p": 0.9 }
        }
      ]
    }
  }
}
```

再在 auth.json 增加 my-provider 凭据，在 settings.profiles 选择该 provider/model。地址、token 上限、reasoning 和 compat 要符合实际服务。

- 自定义 API 支持 openai-completions、openai-responses、anthropic-messages。其他 pi-ai 内建供应商继续使用其原生适配器；不声称 JSON 能注册任意 API 实现。
- 模型 maxTokens 是能力上限，request.maxTokens 是本次请求的默认输出预算；request.temperature 是采样默认值。模型级 request 可覆盖供应商级。
- 支持 name、api、baseUrl、reasoning、input、cost、contextWindow、maxTokens、thinkingLevelMap、samplingParams、headers、compat 和 request；modelOverrides 按 ID 覆盖内建模型。
- 供应商可设置 apiKey（字面值或 `env:VARIABLE`）、headers、keyless。keyless 用于无鉴权本机服务；不能同时设置 apiKey。
- 可选 `config/.env` 仅供模型配置解析，进程环境优先，不修改进程全局环境；API/Expo 的启动变量仍由终端或根目录启动环境设置。
- auth.json 支持 pi-ai 原生 api_key / oauth credential，现有 OAuth 凭据的刷新由 pi-ai 与原子文件存储完成；Piko 尚无交互登录/授权页面。
- JSON 使用严格校验，未知字段报错，不静默忽略。解析错误仅报告文件/字段，不把凭据值放进错误响应。

settings 另支持 compaction（enabled/reserveTokens/keepRecentTokens/backgroundTokens）、retry（enabled/maxRetries/baseDelayMs/maxAgentDelayMs）、stream（transport/timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention）。stream 是模型供应商连接选项，客户端聊天仍使用 Piko SSE。未设置的值使用 durable 默认行为。

## 控制 API

以下操作针对主会话，API 默认端口 8787：

```powershell
# 只返回配置元数据与能力，不返回 API Key
Invoke-RestMethod http://127.0.0.1:8787/api/runtime

# 编辑 JSON 或插件后，在会话空闲时重载
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/reload -Method Post

# 选择预设
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/selection -Method Post `
  -ContentType "application/json" -Body '{"profile":"careful"}'

# 也可直接选 provider/model，或仅修改思考强度
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/selection -Method Post `
  -ContentType "application/json" -Body '{"thinking":"high"}'

# 手动压缩会使用当前模型生成摘要，保留完整聊天历史
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/compact -Method Post

# 停止当前回复或手动压缩
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/cancel -Method Post
```

selection 也接受 `{"provider":"deepseek","model":"deepseek-flash","thinking":"off"}`。重载/选择不能与生成并发，繁忙返回 409；配置错误保留旧运行时。重载会刷新 models/auth/settings 和插件，包括插件本地辅助文件。指导和技能在每次模型请求自动刷新。

## 技能与指导

工作区 `.agents/skills/<name>/SKILL.md` 使用 YAML frontmatter：

```markdown
---
name: project-notes
description: Record decisions and next actions for an ongoing project.
---

Read the project's existing notes, then append the new decision and next action.
```

同名优先级：工作区 .agents/skills > PIKO_HOME/skills > 应用内建。不递归读取祖先指导、不加载个人 Pi CLI 资源。`disable-model-invocation: true` 的技能不注入模型索引；普通技能只注入名称/描述/文件路径，正文由 read 按需加载。聊天输入不会展开 CLI `/skill:` 命令。

保留 Piko 原有 core.md、AGENTS.md、SOUL.md、USER.md、MEMORY.md 指导方式。工作区指导与技能可由用户或助手修改，初始化不会覆盖。

## 原生插件

加载入口为 `PIKO_HOME/extensions/<name>.ts`（也支持 js/mjs）或 `<name>/index.ts`。default export 必须是 durable `defineExtension` 返回的对象；不接收旧 coding-agent 的 `(pi) => {...}` 扩展函数。

例如保存为 extensions/project-state.ts：

```typescript
import { Type } from "typebox";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

const Notes = defineDoc<{ items: string[] }>({
  kind: "piko.project-notes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ items: [] }),
});

export default defineExtension({
  name: "project-state",
  tools: [defineTool({
    name: "record_project_note",
    description: "Save a project decision or next action in durable state.",
    parameters: Type.Object({ text: Type.String() }),
    execute: async ({ text }, api, context) => {
      const count = await api.commit(async tx => {
        const notes = await tx.doc(Notes, api.conversationId);
        notes.items.push(text);
        return notes.items.length;
      }, context);
      return { content: [{ type: "text", text: `Saved note ${count}.` }] };
    },
  })],
});
```

重载后模型可使用这个工具，状态由会话 doc 日志持久化，重启后读取同一个 doc 会拿到已有值。文档落盘由 durable 管理，不需要自己创建第二份状态 JSON。工具定义不意味着 Piko 已有项目笔记产品界面。

插件可定义 tools、sections、hooks、wraps、tasks；插件代码按本机权限执行，第三方依赖在插件目录安装。Bun 编译保留源文件 import.meta 路径，宿主 Pi/Chord/TypeBox 共用实例；重载本地传递依赖，缓存放 state/tmp。重复/保留扩展名或非法入口会拒绝重载，旧配置继续可用。

后台 task 定义可在插件使用；Piko 主聊天重启默认撤销遗留工作，不自动续跑。需要长期后台任务时须另行设计产品调度、恢复、投递和权限语义。旧 CLI 菜单、UI、命令和生命周期接口没有兼容层。

## 边界

read/write/edit/bash 使用本机权限，工作区是默认目录而非沙箱。原生 read 1.0.4 仍拒绝图片，未另写替代工具；模型 imageInput 仅表示模型能力。附件、配置管理、工具轨迹、任务和插件管理 UI 尚未接入。

验证使用 faux provider 和本机 HTTP 模型服务，无真实付费请求。类型检查覆盖 API 与移动端，自动化覆盖 JSON 请求参数、配置回退、插件/doc/辅助文件重载、历史压缩与重启去重；真机后台与真实长对话仍需使用验证。
