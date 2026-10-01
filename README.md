# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一个本地优先的个人助理原型，前端使用 Expo + React Native，运行于 Web、iOS 和 Android。首页和底部导航参考 OpenMuse：居中的水豚头像、近白背景、浅蓝聊天气泡，以及 Chat / Activity / Ideas / Goals / Apps 五项胶囊 Tab。UI 和素材授权见 [第三方说明](THIRD_PARTY_NOTICES.md)。

Pi SDK 是唯一的 Agent / 模型运行时，Bun 提供 HTTP API 和 SSE 流式传输。Pi 的会话、模型设置和凭据留在服务端；聊天中已启用 read、write、edit、bash 四个 Pi 内建工具。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [产品约定](docs/PRODUCT.md) | 主会话、工作区、side chat 的待定交互与功能边界 |
| [架构约定](docs/ARCHITECTURE.md) | 当前实现、Pi / Piko 职责、工作区资源与核心模型 |
| [路线图](ROADMAP.md) | 当前进度、开发顺序和阶段验收 |
| [工作区与主会话模型](docs/features/workspace-and-main-chat.md) | 已实现范围、存储、迁移、恢复和验收；复杂功能方案放在 docs/features/ |
| [编码指导](AGENTS.md) | 后续仓库开发的必要约定 |

启动与验证以本文为准。文档区分已实现、已确定但未实现和待设计；目前是具备长期工作区和持久主会话的文本聊天原型。

## 当前架构

```text
Expo / React Native (Web、iOS、Android)
                  │
           Piko HTTP API + SSE
                  │
         Pi SDK / ModelRuntime
```

RN 客户端位于 `apps/mobile`；跨端契约位于 `shared/`，SSE 编解码位于 `shared/sse.ts`。服务端按 HTTP 路由、会话服务、领域存储和 Pi 适配器拆分。目前使用 Piko 的轻量事件格式，后续功能见 [ROADMAP.md](ROADMAP.md)。

目录职责、依赖方向与后续实施顺序见 [架构说明](docs/ARCHITECTURE.md)。

## 环境要求

- Bun 1.4 或更新版本。
- Pi CLI 已完成 provider 和 model 设置，至少有一个可用模型。SDK 从 Pi 默认 profile（通常为 `~/.pi/agent`）读取配置。
- 与 Expo SDK 57 兼容的 Expo Go，或者相应的开发客户端。
- Android Emulator 或 iOS Simulator。iOS Simulator 需要 macOS；Windows 上可使用 Android Emulator。

Windows 上 Pi profile 通常在 `%USERPROFILE%\.pi\agent`。如需安装和设置 Pi：

```powershell
bun add --global --ignore-scripts @earendil-works/pi-coding-agent
pi
```

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

`dev`、`dev:web` 和 `dev:android` 都会启动 API（8787）和 Expo（8081），自动为 API 配置本地 Web 的 CORS，并保留 `PIKO_CORS_ORIGINS` 中的其他 Origin。API 就绪后才启动 Expo。按 `Ctrl+C` 关闭两个服务；任何一个服务退出时，另一个也会关闭。启动前检查端口，已占用时提示关闭之前的服务，不会终止其他进程。

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

- `PIKO_HOST`、`PIKO_PORT` 控制 API 监听地址与端口，默认 `127.0.0.1:8787`；`PIKO_CORS_ORIGINS` 配置允许的 Web Origin。
- `EXPO_PUBLIC_PIKO_API_URL` 指定客户端 API 地址。Expo 配置变化后重新启动 Metro。
- `JAVA_HOME` 指向 JDK 根目录，`ANDROID_HOME` 指向 Android SDK 根目录；设置后重新打开终端。必要时在本机生成工程中使用已忽略的 `local.properties` 指定 SDK 路径。
- 8081 是 Expo 开发服务。请求 Android / iOS 资源时可能返回 manifest JSON，这是正常的；Web 使用 `bun run dev:web` 打开。
- 更新 JS 依赖后可用 `bun run dev:web --clear` 清理 Metro 缓存；新增或更新原生依赖后需要重建原生开发版。

### 助手工作区与主会话

首次启动 API 创建 `~/.piko/workspace`，并初始化用户指导和 `.agents/skills`、memory、projects、artifacts。已有文件不会覆盖。所有客户端通过 `/api/main` 使用同一个主会话，刷新或重启服务后保留历史。

可在启动前指定绝对路径：

```powershell
$env:PIKO_HOME = "D:\Piko"
# 可选：将工作区单独放在其他位置
$env:PIKO_WORKSPACE = "D:\AssistantWorkspace"
bun run dev
```

`PIKO_HOME/state/runs` 保存聊天 JSONL，`state/pi-sessions` 保存 Pi 原生上下文 JSONL，`state/piko.sqlite` 只记录身份、状态、顺序和文件/上下文检查点索引。state 必须在工作区之外；同一状态目录只启动一个后端。

用户可手动编辑工作区 AGENTS.md、SOUL.md、USER.md、MEMORY.md，每轮发送前重新加载有限长度的内容。助手可使用 read、write、edit、bash，读取技能正文、保存文件、创建技能并运行脚本；新技能在下一轮刷新索引。Bash 使用本机 Shell，搜索和目录列表通过 Bash 命令完成。

工具使用后端进程的本机权限，相对路径默认从助手工作区解析；当前没有工作区沙箱或单独的操作审批界面。工具调用与结果保留在 Pi 原生 JSONL；聊天界面目前显示文本回复，专门的工具进度与产物查看后续接入。自动记忆提取与检索尚未实现。

备份时先停止 API，再一起复制工作区和整个 state 目录；恢复保留原工作区绝对路径。异常修复和迁移限制见 [功能说明](docs/features/workspace-and-main-chat.md)。

实体设备通过 `EXPO_PUBLIC_PIKO_API_URL` 设置可访问的 API 地址。API 默认只监听 `127.0.0.1` 且没有登录验证；实体设备接入应先提供受保护的访问通道和身份验证，不要直接将 API 暴露到不可信网络。

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

- 工作区和唯一主会话已持久化，Pi 上下文使用原生 JSONL 与压缩机制；side chat 仅预留类型和关系。
- 当前支持聊天、流式回复、独立停止、错误重试，以及断线、页面刷新和回到前台后的回复恢复。连接断开只停止订阅，服务端继续执行；停止按钮通过 Run 取消接口终止回复。
- JSONL 保存完整消息与 Run 事件，续订窗口为最近 2,048 条；同 `runId` 的重复提交在重启后仍不会重复执行。遗留运行标记为中断并保留已保存输出，用户主动重试产生新 Run，不自动重跑。
- 顶部菜单、通知、附件，以及 Activity / Ideas / Goals / Apps Tab 是禁用的布局占位。
- Goal、后台任务、Feed、Memory、Browser、文件、登录、多用户和连接器按路线图逐步加入。
