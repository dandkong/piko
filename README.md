# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一款本地优先的个人助理：用 Expo / React Native 提供 Web、iOS 和 Android 客户端，在你自己的后端机器上运行助手、保存会话与工作区。Agent 运行时使用 pi-durable，模型接入使用 pi-ai。

> [!WARNING]
> Piko 仍处于早期开发阶段，不适合直接作为公开互联网服务使用。当前 API 没有登录认证；文件与命令工具以服务端进程权限运行，也没有工作区沙箱。默认仅监听本机地址。除非在受信网络中使用，或先通过认证代理保护网页、API 和 SSE，否则不要将服务暴露到公网。

## 当前能力

- 持久主会话、独立旁聊、流式回复与重连恢复。
- 通过对话委派后台工作；保存任务并手动或按计划执行。
- 工作区文件、记忆和技能；内置网页搜索与正文提取。
- 可选 Telegram 私聊，与 App 共用主会话。
- Web 可本地开发或部署；iOS 和 Android 客户端由 Expo 提供。

**尚未完成：** Posts 目前只有空状态，Artifacts 只有标题占位；移动端附件选择界面、登录与多用户、权限/沙箱、推送通知和浏览器自动化均未接入。细节见[路线图](ROADMAP.md)。

## 快速开始

需要 Bun 1.4+ 和 Node.js（Expo CLI 使用）。从仓库根目录安装依赖并启动 Web 开发环境：

```bash
bun install
bun install --cwd apps/mobile
bun run dev:web
```

开发服务会同时启动 API（默认 `127.0.0.1:8787`）与 Expo（默认 `localhost:8081`）。首次启动会在 `~/.piko` 初始化配置和工作区。配置至少一个模型后即可发送消息；配置方式见[应用配置](docs/operations/configuration.md)和[模型运行时说明](docs/operations/agent-runtime.md)。

Android 模拟器可在启动模拟器后运行 `bun run dev:android`。macOS 上运行 `bun run dev`，再在 Expo 终端按 `i` 启动 iOS Simulator；Windows 可使用 Android Emulator。更多运行与构建说明见[客户端 README](apps/mobile/README.md)。

## 检查与构建

```bash
bun run typecheck
bun run build:web
```

`bun run build` 导出 iOS 和 Android 的 JavaScript bundle，不会生成可直接安装或签名的原生安装包。Linux Web 部署见[部署说明](docs/operations/deployment.md)。

## 数据与安全

默认情况下，配置、会话数据库和附件保存在后端的 `~/.piko`；助手工作区默认为 `~/.piko/workspace`。可以通过 `PIKO_HOME` 和 `PIKO_WORKSPACE` 指定路径。模型、工具和 Telegram 的配置与凭据均保留在后端，不放入客户端构建包。具体边界见[配置说明](docs/operations/configuration.md)。

不要把 Piko API 直接暴露给不可信网络。工作区只是默认工作目录，不是安全沙箱；助手的 `bash`、文件工具和联网能力可能产生真实副作用。备份、删除和恢复边界见[存储说明](docs/operations/storage.md)。

## 文档

按主题浏览[文档索引](docs/README.md)。产品范围、架构、交互规范和后续计划分别见[产品说明](docs/PRODUCT.md)、[架构说明](docs/ARCHITECTURE.md)、[交互规范](docs/INTERACTION.md)和[路线图](ROADMAP.md)。

## 许可证

目前仓库尚未为 Piko 项目本身添加开源许可证；请不要仅凭代码公开就假定获得复制、修改或再发布的许可。界面与素材中源自 OpenMuse 的部分按其 MIT 许可标注，见[第三方说明](THIRD_PARTY_NOTICES.md)。
