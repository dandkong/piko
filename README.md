# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一个本地优先的个人助理原型，前端使用 Expo + React Native，运行于 Web、iOS 和 Android。首页和底部导航参考 OpenMuse：居中的水豚头像、近白背景、浅蓝聊天气泡，以及胶囊导航。当前一级模块为 Chat / Tasks / Posts / Artifacts，四个页签均已启用（Posts 为空状态，Artifacts 仅占位）。UI 和素材授权见 [第三方说明](THIRD_PARTY_NOTICES.md)。

Agent 运行时使用 pi-durable 1.3.0，模型适配使用 pi-ai 1.3.0，Bun 提供 HTTP API 和 SSE 流式传输。会话、模型设置和凭据留在服务端；聊天中已启用 read、write、edit、bash 四个原生工具、内置 web_search/web_extract，并支持后台工作委派和可定时运行的任务。一个任务保存一套指令、可选时间规则和固定目录；后台执行结束后由主 Agent 整理回复。搜索凭据由部署者在后端环境配置，日常使用无需选择服务商。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品约定](docs/PRODUCT.md) | 主会话、工作区、旁聊与功能边界 |
| [交互与视觉规范](docs/INTERACTION.md) | 按钮层级、状态、尺寸、动效和统一组件 |
| [架构约定](docs/ARCHITECTURE.md) | 当前实现、Pi / Piko 职责、工作区资源与核心模型 |
| [路线图](ROADMAP.md) | 当前进度、开发顺序和阶段验收 |
| [工作区与主会话模型](docs/features/workspace-and-main-chat.md) | 已实现范围、原生历史投影、存储、恢复和验收；复杂功能方案放在 docs/features/ |
| [Durable 配置与运行时](docs/features/durable-runtime.md) | 模型、凭据、预设、思考强度、技能与运行时控制 API |
| [内置搜索与网页提取](docs/features/web-tools.md) | 搜索/提取契约、后端环境凭据、能力来源、取消与请求限制 |
| [旁聊](docs/features/side-chats.md) | 独立聊天、共享资源、抽屉管理与不可恢复删除 |
| [后台子 Agent](docs/features/background-subagents.md) | 共享资源、持久化子会话、私有回传与停止/恢复范围 |
| [任务与执行记录](docs/features/tasks.md) | 保存可手动/定时运行的任务、任务记忆、归档与恢复 |
| [RN 与 Telegram 双通道](docs/features/telegram-channel.md) | 共享主会话、TG 私聊配置与命令、去重、回复投递与 RN 同步 |
| [Linux 正式入口](docs/features/linux-deployment.md) | Web + API/SSE + TG 单进程、构建和 systemd 部署 |
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
- 在后端环境或私有 config/.env 设置供应商 API Key，在 config/piko.json 的 agent 下选择模型预设；自定义供应商的非敏感目录与参数写入 config/models.json。
- 与 Expo SDK 57 兼容的 Expo Go，或者相应的开发客户端。
- Android Emulator 或 iOS Simulator。iOS Simulator 需要 macOS；Windows 上可使用 Android Emulator。

不需要安装或登录 Pi CLI，也不读取 `~/.pi/agent`。首次启动自动补齐空配置文件，模型配置示例见 [Durable 配置](docs/features/durable-runtime.md)。当前源码使用固定 `state/durable/session.sqlite` 原生 SQLite；已有 JSONL 须先显式离线迁移，不能直接启动生成空会话。迁移步骤和线上切换边界见 [SQLite 存储](docs/features/sqlite-storage.md)。更旧的 Piko 自建 SQLite / `durable-sessions` 不由该脚本导入，模型配置和工作区文件继续保留。

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

`dev`、`dev:web` 和 `dev:android` 都会启动 API（默认 8787）和 Expo（8081），使用统一应用配置。API 就绪后才启动 Expo。Piko 不过滤请求 Origin；浏览器跨源访问由 CORS 响应头支持，部署访问控制由反向代理或网络边界负责。按 `Ctrl+C` 关闭两个服务；任何一个服务退出时，另一个也会关闭。启动前检查端口，已占用时提示关闭之前的服务，不会终止其他进程。

同时测试 Web 和 Android 时，运行 `bun run dev:web` 后在该终端按 `a`，共用一个 Expo 进程。

需要分别查看服务日志时，仍可在两个终端独立启动：

```powershell
# 终端 1：API
bun run dev:api

# 终端 2：仅 Expo（按 w / a 选择平台）
bun run dev:mobile
```

默认 API 地址是 Android Emulator 的 `http://10.0.2.2:8787`，开发 Web 和 iOS Simulator 的 `http://127.0.0.1:8787`。Android Emulator 使用 Expo Go 时，保持 Expo 和 API 同时运行。独立启动 API 时，开发 Web 的跨源请求由 Piko 的 CORS 响应头支持，无需配置 Origin 白名单。

### Android 本机构建

先启动 Emulator，在一个终端运行 `bun run dev:api`，再在另一个终端从仓库根目录运行：

```powershell
bun run android
```

除了 Bun，还需要 Node.js、JDK 17（配置 `JAVA_HOME`）、Android SDK Platform 36、Build Tools 36.0.0 和 NDK 27.1.12297006，并配置 `ANDROID_HOME`，将 SDK 的 platform-tools 和 emulator 加入 PATH。

该命令首次运行自动生成 Android 工程，随后编译、安装并启动应用和 Metro；不会启动 API。已有 Metro 时使用 `bun run android --no-bundler`。Expo Go 运行不需要本地 Gradle/JDK/NDK 构建链，模拟器本身仍需 Android SDK / Emulator 和系统镜像。

`apps/mobile/android/`、`apps/mobile/ios/` 是 Expo 生成的本地工程，已忽略；原生配置保存在 `app.json` 或配置插件中。本机 SDK 路径、构建缓存、安装包和调试密钥不提交。iOS 本机构建需要 macOS / Xcode。

### 配置与排错

- 配置按字段独立分工：JSON 管应用/Agent 行为及非敏感工具设置，环境变量/.env 管部署参数及敏感凭据；同一字段不支持两边配置，放错位置报错。piko.json 统一管理 agent 预设、通道与工具行为，models.json 管模型目录；不再生成/读取 settings.json，自动压缩与重试直接使用 Durable 默认策略；修改后重启 API。见 [应用配置](docs/features/application-config.md)。
- `PIKO_HOST`、`PIKO_PORT` 配置 API 监听地址与端口（仅环境入口），默认 `127.0.0.1:8787`。Piko 不执行 Origin 白名单或访问认证；对外部署须由反向代理或网络边界控制访问。自定义 API 地址或端口时同时设置客户端地址。
- 后端 `BRAVE_SEARCH_API_KEY` 为内置 web_search 提供凭据；启用开关仅在 piko.json 的 tools.web_search.enabled，可由进程环境或私有 `PIKO_HOME/config/.env` 提供；修改后重启 API。凭据不进入工具参数、前端或发布包，缺失不阻止启动和网页提取。接口与边界见 [内置网络工具](docs/features/web-tools.md)。
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

`PIKO_HOME/config` 保存统一行为 piko.json、模型目录 models.json，以及私有部署/凭据 .env；不再读取 auth.json。Piko 不加载用户代码插件；用户 skill 放在助手工作区 `.agents/skills`。`state/durable/session.sqlite` 的 Durable 原生记录是会话内容的唯一来源，包含 conversation、entries、task、submission 和文档；不另建 Piko 消息或 Run 表。使用 WAL/FULL 和 secure_delete；备份须停机并成套保存整个存储目录，不能遗漏 WAL。输入去重、执行状态与待应用输入均由 Durable 保存。state 必须在工作区之外；同一状态目录只启动一个后端。

工作区的主文件包括 AGENTS.md（如何表达和做事）、MEMORY.md（稳定长期事实与结论）以及 `memory/YYYY-MM-DD.md`（每日讨论、决定、进展与未完线索）。前两者按有限长度在模型请求前加载；每日记忆按需 read/search。一个后台记忆整理 在主会话闲置 30 分钟后读取增量，由专用子 Agent 使用 read/write/edit 直接维护每日和长期记忆；仅由后台闲置调度触发，不提供专用手动触发工具。技能来自应用内建与工作区 `.agents/skills`，同名时工作区技能优先。助手可使用 read、write、edit、bash，读取技能正文、保存文件、创建技能并运行脚本；新技能在下一次请求刷新索引。Bash 使用本机 Shell，搜索和目录列表通过 Bash 命令完成。

工具使用后端进程的本机权限，相对路径默认从助手工作区解析；当前没有工作区沙箱或单独的操作审批界面。工具调用与结果保留在 Durable 原生 SQLite entries；聊天界面目前显示文本回复，专门的工具进度与产物查看后续接入。每日与长期记忆的后台整理已接入；专门的记忆浏览/检索 UI 尚未实现。

备份时先停止 API，再一起复制整个 `PIKO_HOME` 和单独指定的工作区；恢复保留原工作区绝对路径。已有会话的工作区路径与配置不一致时拒绝启动。更旧的 Piko 自建 `piko.sqlite` 不作当前事实源；当前原生 JSONL 已按显式迁移流程导入 SQLite，旧存储的保留或清除需明确授权，不自动回退。操作细节见 [功能说明](docs/features/workspace-and-main-chat.md)。

实体设备通过 `EXPO_PUBLIC_PIKO_API_URL` 设置可访问的 API 地址。API 默认只监听 `127.0.0.1` 且没有登录验证；实体设备接入应先提供受保护的访问通道和身份验证，不要直接将 API 暴露到不可信网络。

### Telegram 私聊

可选启动通道，使用同一个后端和主会话。仅在 piko.json 配置启用与允许访问的用户：

```json
{"channels":{"telegram":{"enabled":true,"userId":"自己的数字用户 ID"}}}
```

Token 只放后端环境或私有 .env：

```powershell
$env:PIKO_TELEGRAM_BOT_TOKEN = "<轮换后、未暴露的 Bot Token>"
bun run dev:api
```

默认只运行 RN，设置 token 不会自动启用 TG；启用时必须配置 token 与有效数字用户 ID，明确启用后配置错误会拒绝启动，不自动停用 TG。TG 开关与用户 ID 只从 piko.json 读取，同名环境变量会被忽略，JSON 不接受 botToken。只接受指定用户的普通私聊；通过 long polling 出站连接 Telegram，不需要公开 API 端口。采用 grammY 内置轮询，启动自动删除 webhook，但不主动丢弃待处理更新。网络故障由 SDK 持续重试；致命轮询/启动错误清理后退出，由服务管理器自动重启。

支持文本交流、流式 Rich Markdown 回复、`/start`、`/help`、`/status`、`/stop`、`/recent`、`/skills`；`/models` 与 `/thinking` 使用按钮选择，`/compact` 压缩上下文并区分实际应用、跳过、取消和失败。管理操作只在主会话空闲时执行，当前模型和思考强度由 RN/TG 共享；`/status` 同时显示这些选择、模型上下文上限与技能数量。TG 发起的消息和回复会出现在 RN；纯 RN 执行默认不推送 TG，可用 `/recent` 查询。两端运行中均可补充输入，使用原生 steer all 在下一个接纳边界一起加入当前工作；停止取消当前 conversation 执行及未应用输入。用户输入与助手回复各自展示，TG 按助手消息更新，补充输入不重发旧回复。RN 前台持续观察会话 SSE，输入提交与消息流分开。

同一任务内的多条助手文字回复在 TG 按原生消息分别发送，每条内部保持流式编辑；与 RN 历史分条对应，暂不展示工具。

通道错误不关闭 RN。身份、模型和工作区配置在后端，token 不提交到仓库；附件、群聊、语音和后台推送尚未接入。发送失败或后端重启可能漏发 TG 回复，原生历史可在 RN 或 `/recent` 查询。详见 [通道说明](docs/features/telegram-channel.md)。

## Linux 正式运行

在源码根目录安装两端依赖后：

```bash
bun run build:web
PIKO_HOME=/home/your-user/.piko bun run start
```

同一端口提供网页、API/SSE 和已启用的 Telegram，默认 http://127.0.0.1:8787。正式 Web 默认同源访问 API，无需写入服务器地址；start 不启动 Expo、不启用 watch、不自动构建。仅 API/TG 可用 `bun run start:api`。

[Linux 部署说明](docs/features/linux-deployment.md) 包含配置、路径、访问及 systemd；模板在 [deploy/piko.service](deploy/piko.service)，先按实际账号与路径调整。当前 API 没有登录验证，对外入口须通过受保护的网络或认证代理。

## 检查与导出

```powershell
bun run typecheck
bun run build:android
bun run build:ios
bun run build:web
```

`typecheck` 同时检查服务端和 RN；`build` 依次导出 iOS、Android bundle。导出的是 JavaScript / Hermes bundle，生成可安装、签名的原生包仍需 Android / Xcode 工具链或 EAS Build。客户端说明见 [apps/mobile/README.md](apps/mobile/README.md)。

## 当前边界

- 工作区、主会话和旁聊已持久化；同一 Harness 中旁聊使用独立 ownerless conversation，支持一键默认名新建、切换、三点菜单重命名/不可恢复删除及独立停止；顶部名字固定 Piko，删除会清理旁聊及所属后台运行数据，不删除附件、工作区文件或历史备份。共享记忆/技能/通用工具，不继承主聊天记录、不自动回传、不提取旁聊记忆、不开放任务管理；支持结果只回原旁聊的后台委派。见 [旁聊](docs/features/side-chats.md)。
- 后台子 Agent 共用模型、基本工具、全局指导和技能；禁止嵌套。普通委派共用工作区、不单独展示，任务执行则有固定目录、独立记忆和 Tasks 执行记录。一次委派一个持久化子会话，结果私下交回主 Agent，由它决定回复或保持安静；普通停止不取消独立子工作。
- 当前支持聊天、流式回复、独立停止、错误重试，以及断线、页面刷新和回到前台后的回复恢复。连接断开只停止订阅，服务端继续执行；停止按钮通过会话停止接口终止当前工作，也可取消手动压缩。
- Durable SQLite 保存原生消息、工具与结果、压缩和自定义消息；模型压缩不删除 UI 历史。SSE 每次连接先加载最新快照，再接收实时更新，不维护事件游标或重放缓存。同 `requestId` 的重复提交由 Durable 去重，重启后仍不会重复执行；启动撤销不确定工作并显示中断提示，不自动重跑；已完成子任务的纯回传阶段可以恢复。
- 重启保留 Pi 已保存的消息，尚未保存的流式文字可能丢失。原生 inbox 中尚未应用的输入会在启动时撤回，用户需要主动重新发送；不从另一套日志重建正文。
- JSON 模型配置、思考强度、模型预设和手动压缩已接入；TG 通过内部运行时提供模型/思考按钮与压缩命令，不另设 HTTP 管理接口，配置修改后重启生效，RN 配置管理界面尚未实现。Durable Extension 仅用于 Piko 内建运行时能力，不加载用户插件代码。
- Telegram 与 App 的附件（图片、文档、音视频）共用 `PIKO_HOME/state/attachments`，服务端只负责接收和给出路径，模型自行决定用 `read` 还是 bash 检查；图片由 Photon 处理并返回图片块。非视觉模型会收到占位说明。RN 选图尚未接入。见 [附件与图片读取](docs/features/attachments.md)。
- Tasks 首版支持手动、一次性、每天/自定义 Cron；任务在 Chat 内创建，页面按进行中/已归档分组展示时间标签与已结束的执行记录，通过图标归档/恢复；归档停止未来调度，不等于本次执行完成。去重、同任务串行和重启中断已接入；首版没有独立语义阻塞、自动重试整个任务、执行预算或失败熔断；详情见任务与执行记录说明。
- 顶部菜单现在打开层叠式导航抽屉，主界面仅向右平移，左侧为全高底层菜单而非悬浮卡片，四个页签与底部导航共用配置；设置入口移至抽屉左下角（禁用占位），右下角一键默认名新建旁聊并直接进入；列表右侧三点菜单提供重命名与删除；删除需确认，不提供归档或恢复入口。通知尚未接入。服务端附件接口与 Telegram 图片已可用。Posts 与 Artifacts 页签已启用，但分别只有空状态/标题占位，不展示模拟帖子。
- Feed 的完整能力、Browser、全局文件/产物管理、登录、多用户和连接器按路线图逐步加入；记忆的专门浏览与版本管理 UI 尚待设计。
