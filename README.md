# Piko

**给日常留一点空间。由 Pi 驱动。**

Piko 是一个本地优先的个人助理原型：使用 OpenMuse 风格的聊天界面，Pi SDK 是唯一的 Agent / 模型运行时，Bun 提供 Web API 和流式传输。项目不依赖 OpenMuse 后端、CopilotKit Intelligence 或其它 Agent 框架。

当前版本仅支持普通聊天，Pi 的文件和命令工具关闭；没有数据库、连接器或后台任务。聊天布局和水豚头像借鉴 OpenMuse；头像授权信息见 [第三方素材说明](THIRD_PARTY_NOTICES.md)。产品和代码保持独立。

## 当前架构

```text
React Web / PWA
       │ fetch + 应用内 SSE
       ▼
Bun API（本地 HTTP 和 Pi SDK session）
       │
       ▼
Pi ModelRuntime（读取 Pi profile 与模型配置）
```

目前的 SSE 是 Piko 自己的轻量事件格式，不是 AG-UI。路线图记录了后续领域模型、Run 状态、Activity / Artifacts 等阶段；见 [ROADMAP.md](ROADMAP.md)。

## 环境要求

- Bun 1.4 或更新版本。
- Pi CLI 已完成模型/provider 设置。Pi SDK 从 Pi 默认 profile（通常为 `~/.pi/agent`）读取配置；Piko 不复制或暴露凭据。
- 至少有一个 Pi 可用模型。

Windows 上本机 Pi profile 通常在 `%USERPROFILE%\.pi\agent`。可用 `pi` 启动 Pi CLI 完成模型配置；若尚未安装，可执行：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

## 本地运行

先在第一个终端启动 Pi 服务端：

```powershell
cd D:\Project\workspace\piko
bun install
bun run dev:api
```

再在第二个终端启动 Web 前端：

```powershell
cd D:\Project\workspace\piko
bun run dev:web
```

打开 [http://localhost:5173](http://localhost:5173)。Vite 会把 `/api` 请求代理到 `http://127.0.0.1:8787`。

## 手机浏览器与 PWA

开发验证时，可让 Vite 监听局域网地址：

```powershell
bunx vite --host 0.0.0.0
```

然后在同一 Wi-Fi 下用手机打开 `http://<电脑局域网地址>:5173`。PWA 安装和 service worker 需要 HTTPS 或 localhost 安全源；在另一台手机上安装时，应通过 HTTPS tunnel 或 HTTPS 主机访问。iPhone/iPad 在 Safari 中使用“分享 → 添加到主屏幕”。

PWA 离线缓存只覆盖应用外壳；聊天仍要求 Pi/Bun 服务端在线。

## 当前边界

- Pi session 和会话上下文只保存在 Bun 进程内；服务重启后会清空，没有持久化历史。
- Pi coding tools 全部关闭；当前仅做文本对话。
- 顶部菜单、通知、未开放的底部导航和附件按钮目前是布局占位；实际只有 Chat 可用。
- 没有 Goal、定时任务、Feed、Memory、Browser、子 Agent、文件、登录和多用户能力；按 [路线图](ROADMAP.md) 分阶段增加。
- 默认只监听 `127.0.0.1`，适合本机开发；当前 API 无登录验证，不要将其暴露到不可信网络。
- **AG-UI、Tools、Database 和 Connectors 尚未接入。**路线图是后续方向，不代表当前支持。

## 检查

```powershell
bun run typecheck
bun run build
```
