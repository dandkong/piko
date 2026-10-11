# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一个本地优先的个人助理原型，前端使用 Expo + React Native，运行于 Web、iOS 和 Android。首页和底部导航参考 OpenMuse：居中的水豚头像、近白背景、浅蓝聊天气泡，以及 Chat / Activity / Ideas / Goals / Apps 五项胶囊 Tab。UI 和素材授权见 [第三方说明](THIRD_PARTY_NOTICES.md)。

Agent 运行时使用 pi-durable 1.1.0，模型适配使用 pi-ai 1.1.0，Bun 提供 HTTP API 和 SSE 流式传输。会话、模型设置和凭据留在服务端；聊天中已启用 read、write、edit、bash 四个原生工具。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品约定](docs/PRODUCT.md) | 主会话、工作区、side chat 的待定交互与功能边界 |
| [架构约定](docs/ARCHITECTURE.md) | 当前实现、Pi / Piko 职责、工作区资源与核心模型 |
| [路线图](ROADMAP.md) | 当前进度、开发顺序和阶段验收 |
| [工作区与主会话模型](docs/features/workspace-and-main-chat.md) | 已实现范围、原生历史投影、存储、恢复和验收；复杂功能方案放在 docs/features/ |
| [Durable 配置与插件](docs/features/durable-runtime.md) | 模型、凭据、预设、思考强度、技能、插件与运行时控制 API |
| [RN 与 Telegram 双通道](docs/features/telegram-channel.md) | 共享主会话、TG 私聊配置与命令、去重、回复投递与 RN 同步 |
| [编码指导](AGENTS.md) | 后续仓库开发的必要约定 |

启动与验证以本文为准。文档区分已实现、已确定但未实现和待设计；目前是具备长期工作区和持久主会话的文本聊天原型。

## 当前架构

```text
Expo / React Native ── HTTP + SSE ──┐
                                  ├── Piko 会话服务 ── pi-durable ── pi-ai
Telegram 私聊 ── Bot API 适配器 ────┘
```

RN 客户端位于 `apps/mobile`；跨端契约位于 `shared/`，SSE 编解码位于 `shared/sse.ts`。服务端按 HTTP 路由、会话服务、工作区初始化和 Pi 适配器拆分。Pi 适配器通过 durable `watchEvents` 监听原生消息并转换为 Piko 的轻量事件格式，历史仍读取完整原生 entries，后续功能见 [ROADMAP.md](ROADMAP.md)。

目录职责、依赖方向与后续实施顺序见 [架构说明](docs/ARCHITECTURE.md)。

## 环境要求

- Bun 1.4 或更新版本。
- 在 Piko 的 `config/auth.json` 填写供应商凭据，在 `config/settings.json` 选择模型预设；自定义供应商写入 `config/models.json`。
- 与 Expo SDK 57 兼容的 Expo Go，或者相应的开发客户端。
- Android Emulator 或 iOS Simulator。iOS Simulator 需要 macOS；Windows 上可使用 Android Emulator。

不需要安装或登录 Pi CLI，也不读取 `~/.pi/agent`。首次启动自动补齐空配置文件，模型配置示例见 [Durable 配置](docs/features/durable-runtime.md)。当前使用固定 `state/durable`；旧 SQLite / `durable-sessions` 不迁移，新布局会初始化新主会话，模型配置和工作区文件继续保留。

## 本地运行

在仓库根目录安装服务端和 RN 依赖：

```powershell
bun install
bun install --cwd apps/mobile
```

从仓库根目录，一条命令同时启动 API 和 Expo：

```powershell
bun run dev
```

在终端按 `w` 打开 Web、按 `a` 打开 Android Emulator；在 macOS 上按 `i` 打开 iOS Simulator。也可以直接按平台启动：

```powershell
# Web：打开 http://localhost:8081
bun run dev:web

# 或 Android：先启动 Android Emulator
bun run dev:android
```

`dev`、`dev:web` 和 `dev:android` 都会启动 API（默认 8787）和 Expo（8081），使用统一应用配置，自动为 API 配置本地 Web 的 CORS，并保留文件或 env 中的其他 Origin。API 就绪后才启动 Expo。按 `Ctrl+C` 关闭两个服务；任何一个服务退出时，另一个也会关闭。启动前检查端口，已占用时提示关闭之前的服务，不会终止其他进程。

同时测试 Web 和 Android 时，运行 `bun run dev:web` 后在该终端按 `a`，共用一个 Expo 进程。

需要分别查看服务日志时，仍可在两个终端独立启动：

```powershell
# 终端 1：API
$env:PIKO_CORS_ORIGINS = "http://localhost:8081,http://127.0.0.1:8081"
bun run dev:api

# 终端 2：仅 Expo（按 w / a 选择平台）
bun run dev:mobile
```

默认 API 地址是 Android Emulator 的 `http://10.0.2.2:8787`，Web 和 iOS Simulator 的 `http://127.0.0.1:8787`。Android Emulator 使用 Expo Go 时，保持 Expo 和 API 同时运行。独立启动 API 时需要手动配置 Web 的 `PIKO_CORS_ORIGINS`；使用其他 Web 地址或端口时，加入其准确的 Origin 并重启 API。

### Android 本机构建

先启动 Emulator，在一个终端运行 `bun run dev:api`，再在另一个终端从仓库根目录运行：

```powershell
bun run android
```

除了 Bun，还需要 Node.js、JDK 17（配置 `JAVA_HOME`）、Android SDK Platform 36、Build Tools 36.0.0 和 NDK 27.1.12297006，并配置 `ANDROID_HOME`，将 SDK 的 platform-tools 和 emulator 加入 PATH。

该命令首次运行自动生成 Android 工程，随后编译、安装并启动应用和 Metro；不会启动 API。已有 Metro 时使用 `bun run android --no-bundler`。Expo Go 运行不需要本地 Gradle/JDK/NDK 构建链，模拟器本身仍需 Android SDK / Emulator 和系统镜像。

`apps/mobile/android/`、`apps/mobile/ios/` 是 Expo 生成的本地工程，已忽略；原生配置保存在 `app.json` 或配置插件中。本机 SDK 路径、构建缓存、安装包和调试密钥不提交。iOS 本机构建需要 macOS / Xcode。

### 配置与排错

- Piko 应用配置集中在 `PIKO_HOME/config/piko.json`，首次启动补齐默认文件。HTTP、工作区和通道配置统一加载；优先级为默认值 < 配置文件 < `config/.env` < 进程环境变量，修改后重启 API。字段、env 映射和示例见 [应用配置](docs/features/application-config.md)。
- `PIKO_HOST`、`PIKO_PORT` 覆盖 API 监听地址与端口，默认 `127.0.0.1:8787`；`PIKO_CORS_ORIGINS` 覆盖允许的 Web Origin。自定义 API 地址或端口时同时设置客户端地址。
- `EXPO_PUBLIC_PIKO_API_URL` 指定客户端 API 地址。Expo 配置变化后重新启动 Metro。
- `JAVA_HOME` 指向 JDK 根目录，`ANDROID_HOME` 指向 Android SDK 根目录；设置后重新打开终端。必要时在本机生成工程中使用已忽略的 `local.properties` 指定 SDK 路径。
- 8081 是 Expo 开发服务。请求 Android / iOS 资源时可能返回 manifest JSON，这是正常的；Web 使用 `bun run dev:web` 打开。
- 更新 JS 依赖后可用 `bun run dev:web --clear` 清理 Metro 缓存；新增或更新原生依赖后需要重建原生开发版。

### 助手工作区与主会话

首次启动 API 创建 `~/.piko/workspace`，并初始化用户指导和 `.agents/skills`、memory、projects、artifacts。已有文件不会覆盖。所有客户端通过 `/api/chat` 使用同一个主会话，刷新或重启服务后保留历史。

可在启动前指定绝对路径：

```powershell
$env:PIKO_HOME = "D:\Piko"
# 可选：将工作区单独放在其他位置
$env:PIKO_WORKSPACE = "D:\AssistantWorkspace"
bun run dev
```

`PIKO_HOME/config` 保存应用 `piko.json`、可选 `.env` 和独立的模型 `settings.json`、`models.json`、`auth.json`；`extensions` 保存原生 durable 插件，`skills` 保存用户公共技能。`state/durable/` 的原生 JSONL 是会话内容的唯一来源，其中 `main.jsonl` 是会话及提交日志，`doc-*.jsonl` 保存运行时或插件文档。备份时须保留整个会话目录。输入去重、执行状态与待应用输入均由 Durable 保存，Piko 不再使用 SQLite。state 必须在工作区之外；同一状态目录只启动一个后端。

工作区只保留两个指导与记忆文件：AGENTS.md 定义助手如何表达和做事，MEMORY.md 保存长期事实与结论；用户可手动编辑，每次模型请求前重新加载有限长度的内容。技能来自应用内建、`PIKO_HOME/skills` 和工作区 `.agents/skills`，同名工作区技能优先。助手可使用 read、write、edit、bash，读取技能正文、保存文件、创建技能并运行脚本；新技能在下一次请求刷新索引。Bash 使用本机 Shell，搜索和目录列表通过 Bash 命令完成。

工具使用后端进程的本机权限，相对路径默认从助手工作区解析；当前没有工作区沙箱或单独的操作审批界面。工具调用与结果保留在 Pi 原生 JSONL；聊天界面目前显示文本回复，专门的工具进度与产物查看后续接入。自动记忆提取与检索尚未实现。

备份时先停止 API，再一起复制整个 `PIKO_HOME` 和单独指定的工作区；恢复保留原工作区绝对路径。已有会话的工作区路径与配置不一致时拒绝启动。旧 `piko.sqlite` 及 WAL/SHM 可在停止后端后删除，旧原生目录保留但不再读取；当前新主会话不迁移旧聊天。操作细节见 [功能说明](docs/features/workspace-and-main-chat.md)。

实体设备通过 `EXPO_PUBLIC_PIKO_API_URL` 设置可访问的 API 地址。API 默认只监听 `127.0.0.1` 且没有登录验证；实体设备接入应先提供受保护的访问通道和身份验证，不要直接将 API 暴露到不可信网络。

### Telegram 私聊

可选启动通道，使用同一个后端和主会话。可在 `piko.json` 启用 Telegram 并配置身份/token，也可用 env 显式启用：

```powershell
$env:PIKO_TELEGRAM_ENABLED = "true"
$env:PIKO_TELEGRAM_BOT_TOKEN = "<BotFather 提供的 token>"
$env:PIKO_TELEGRAM_USER_ID = "<自己的数字用户 ID>"
bun run dev:api
```

默认只运行 RN，设置 token 不会自动启用 TG；启用时必须配置 token 与有效数字用户 ID，配置错误仅停用 TG。`PIKO_HOME/config/.env` 可保存这些参数。只接受指定用户的普通私聊；通过 long polling 出站连接 Telegram，不需要公开 API 端口。已配置 webhook 的 Bot 需先自行移除 webhook，Piko 不会自动删除它。

支持文本交流、流式 Rich Markdown 回复、`/start`、`/help`、`/status`、`/stop`、`/recent`、`/skills`、`/plugins`；`/models` 与 `/thinking` 使用按钮选择，`/compact` 压缩上下文并区分实际应用、跳过、取消和失败。管理操作只在主会话空闲时执行，当前模型和思考强度由 RN/TG 共享；`/status` 同时显示这些选择、模型上下文上限与技能/插件数量。TG 发起的消息和回复会出现在 RN；纯 RN 执行默认不推送 TG，可用 `/recent` 查询。两端运行中均可补充输入，使用原生 steer all 在下一个接纳边界一起加入当前工作；停止取消当前 conversation 执行及未应用输入。用户输入与助手回复各自展示，TG 按助手消息更新，补充输入不重发旧回复。RN 前台持续观察会话 SSE，输入提交与消息流分开。

同一任务内的多条助手文字回复在 TG 按原生消息分别发送，每条内部保持流式编辑；与 RN 历史分条对应，暂不展示工具。

通道错误不关闭 RN。身份、模型和工作区配置在后端，token 不提交到仓库；附件、群聊、语音和后台推送尚未接入。发送失败或后端重启可能漏发 TG 回复，原生历史可在 RN 或 `/recent` 查询。详见 [通道说明](docs/features/telegram-channel.md)。

## 检查与导出

```powershell
bun run typecheck
bun test
bun run build:android
bun run build:ios
bun run build:web
```

`typecheck` 同时检查服务端和 RN；`build` 依次导出 iOS、Android bundle。导出的是 JavaScript / Hermes bundle，生成可安装、签名的原生包仍需 Android / Xcode 工具链或 EAS Build。客户端说明见 [apps/mobile/README.md](apps/mobile/README.md)。

## 当前边界

- 工作区和唯一主会话已持久化，Pi 上下文使用原生 JSONL 与压缩机制；side chat 将复用同一 Harness 的 conversation，交互尚未实现。
- 当前支持聊天、流式回复、独立停止、错误重试，以及断线、页面刷新和回到前台后的回复恢复。连接断开只停止订阅，服务端继续执行；停止按钮通过会话停止接口终止当前工作，也可取消手动压缩。
- Pi JSONL 保存原生消息、工具与结果、压缩和自定义消息；模型压缩不删除 UI 历史。SSE 最近 128 条事件只保存在内存，过期或重启后加载快照。同 `requestId` 的重复提交由 Durable 去重，重启后仍不会重复执行；启动撤销遗留工作并显示中断提示，不自动重跑。
- 重启保留 Pi 已保存的消息，尚未保存的流式文字可能丢失。原生 inbox 中尚未应用的输入会在启动时撤回，用户需要主动重新发送；不从另一套日志重建正文。
- JSON 模型配置、思考强度、模型预设、durable 插件和手动压缩已接入；服务端提供模型/思考选择及压缩 API，TG 已提供模型/思考按钮与压缩命令，配置及插件代码修改后重启生效，RN 配置管理界面尚未实现。Durable 插件使用 `defineExtension`，不直接兼容 coding-agent CLI 扩展。
- durable 1.1.0 的原生 `read` 暂不支持图片；附件 UI 也尚未启用。模型声明支持图片不代表当前 Piko 的文件读取已能传入图片。
- 顶部菜单、通知、附件，以及 Activity / Ideas / Goals / Apps Tab 是禁用的布局占位。
- Goal、后台任务、Feed、Memory、Browser、文件、登录、多用户和连接器按路线图逐步加入。
