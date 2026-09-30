# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一个本地优先的个人助理原型，前端使用 Expo + React Native，运行于 iOS 和 Android。首页和底部导航参考 OpenMuse：居中的水豚头像、近白背景、浅蓝聊天气泡，以及 Chat / Activity / Ideas / Goals / Apps 五项胶囊 Tab。UI 和素材授权见 [第三方说明](THIRD_PARTY_NOTICES.md)。

Pi SDK 是唯一的 Agent / 模型运行时，Bun 提供 HTTP API 和 SSE 流式传输。Pi 的会话、模型设置和凭据留在服务端；当前只支持文本聊天，Pi 的文件和命令工具关闭。

## 当前架构

```text
Expo / React Native (iOS、Android)
                  │
           Piko HTTP API + SSE
                  │
         Pi SDK / ModelRuntime
```

RN 客户端位于 `apps/mobile`；消息契约位于 `shared/chat.ts`，SSE 编解码位于 `shared/sse.ts`。服务端按 HTTP 路由、会话服务和 Pi 适配器拆分。目前使用 Piko 的轻量事件格式，AG-UI、领域模型和后续功能见 [ROADMAP.md](ROADMAP.md)。

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

第一个终端启动 API：

```powershell
bun run dev:api
```

第二个终端启动 Expo：

```powershell
bun run dev
```

按 `a` 打开 Android Emulator；在 macOS 上可按 `i` 打开 iOS Simulator。`bun run dev:mobile` 是同一启动命令的别名。

默认 API 地址是 Android Emulator 的 `http://10.0.2.2:8787` 和 iOS Simulator 的 `http://127.0.0.1:8787`。Android Emulator 使用 Expo Go 时，保持 Expo 和 API 同时运行。

实体设备通过 `EXPO_PUBLIC_PIKO_API_URL` 设置可访问的 API 地址。API 默认只监听 `127.0.0.1` 且没有登录验证；实体设备接入应先提供受保护的访问通道和身份验证，不要直接将 API 暴露到不可信网络。

## 检查与导出

```powershell
bun run typecheck
bun test
bun run build:android
bun run build:ios
```

`typecheck` 同时检查服务端和 RN；`build` 依次导出 iOS、Android bundle。导出的是 JavaScript / Hermes bundle，生成可安装、签名的原生包仍需 Android / Xcode 工具链或 EAS Build。客户端说明见 [apps/mobile/README.md](apps/mobile/README.md)。

## 当前边界

- Pi session 和上下文保存在 Bun 进程内，重启后会清空；暂无持久化历史。
- 当前支持聊天、流式回复、停止和错误重试。
- 顶部菜单、通知、附件，以及 Activity / Ideas / Goals / Apps Tab 是禁用的布局占位。
- Goal、后台任务、Feed、Memory、Browser、文件、登录、多用户和连接器按路线图逐步加入。
