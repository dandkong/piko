# Piko

中文 | [English](README.md)

**给日常留一点空间。由 Pi 驱动。**

Piko 是一款本地优先的个人助理：用 Expo / React Native 提供 Web、iOS 和 Android 客户端，在你自己的后端机器上运行助手、保存会话与工作区。Agent 运行时使用 pi-durable，模型接入使用 pi-ai。

> [!WARNING]
> Piko 仍处于早期开发阶段，不适合直接作为公开互联网服务使用。当前 API 没有登录认证；文件与命令工具以服务端进程权限运行，也没有工作区沙箱。默认仅监听本机地址。除非在受信网络中使用，或先通过认证代理保护网页、API 和 SSE，否则不要将服务暴露到公网。

## 当前能力

- 持久主会话、独立旁聊、流式回复与重连恢复。
- 通过对话委派后台工作；保存任务并手动或按计划执行。
- 工作区文件、记忆和技能；内置网页搜索与正文提取。
- 可选 Telegram 私聊，与 App 共用主会话。
- Posts 手动生成、卡片列表、内置正文预览和确认后关联删除；Artifacts 文件浏览、下载和确认删除。
- 临时后台执行保留 7 天、每 24 小时检查回收；有业务归属的记录随所属对象删除。
- Web 可本地开发或通过 Bun 单进程运行；iOS 和 Android 客户端由 Expo 提供。通用部署方案尚未确定。

**尚未完成：** Posts 自动调度和通知、任务产物聚合、移动端附件选择界面、登录与多用户、权限/沙箱、推送通知和浏览器自动化均未接入。细节见[路线图](ROADMAP.md)。

## 快速开始

需要 Bun 1.4+ 和 Node.js（Expo CLI 使用）。目前以源码运行和开发为主，不提供正式安装包或 Docker 部署支持；Android 和 iOS 未进行全面设备验证，自动化测试覆盖也有限。从仓库根目录安装依赖并启动 Web 开发环境：

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run dev:web
```

开发服务会同时启动 API（默认 `127.0.0.1:8787`）与 Expo（默认 `localhost:8081`）。首次启动会在 `~/.piko` 初始化配置和工作区。配置至少一个模型后即可发送消息；配置方式见[应用配置](docs/operations/configuration.md)和[模型运行时说明](docs/operations/agent-runtime.md)。

Android 模拟器可在启动模拟器后运行 `bun run dev:android`。macOS 上运行 `bun run dev`，再在 Expo 终端按 `i` 启动 iOS Simulator；Windows 可使用 Android Emulator。更多运行与构建说明见[客户端 README](apps/mobile/README.md)。

## 检查与构建

```bash
bun run typecheck
bun run build:web
```

`bun run build` 导出 iOS 和 Android 的 JavaScript bundle，不会生成可直接安装或签名的原生安装包。Linux Web/API 单进程运行见[运行说明](docs/operations/deployment.md)。

## 数据与安全

默认情况下，配置、会话数据库和附件保存在后端的 `~/.piko`；助手工作区默认为 `~/.piko/workspace`。可以通过 `PIKO_HOME` 和 `PIKO_WORKSPACE` 指定路径。模型、工具和 Telegram 的配置与凭据均保留在后端，不放入客户端构建包。具体边界见[配置说明](docs/operations/configuration.md)。

不要把 Piko API 直接暴露给不可信网络。工作区只是默认工作目录，不是安全沙箱；助手的 `bash`、文件工具和联网能力可能产生真实副作用。备份、删除和恢复边界见[存储说明](docs/operations/storage.md)。

## 文档

按主题浏览[文档索引](docs/README.md)。产品范围、架构、交互规范和后续计划分别见[产品说明](docs/PRODUCT.md)、[架构说明](docs/ARCHITECTURE.md)、[交互规范](docs/INTERACTION.md)和[路线图](ROADMAP.md)。

## 许可证

Piko 使用 [MIT 许可证](LICENSE)。界面与素材中源自 OpenMuse 的部分按其 MIT 许可标注，见[第三方说明](THIRD_PARTY_NOTICES.md)。
