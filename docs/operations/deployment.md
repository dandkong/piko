# Linux Web/API 运行

Web、API/SSE 与可选 Telegram 由同一 Bun 进程提供；运行账号需要读源码和导出文件，并能写入独立的 PIKO_HOME 与工作区。需要 Bun 1.4+ 和 Node.js。

## 构建与运行

在源码根目录执行：

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run build:web
PIKO_HOME=/home/your-user/.piko bun run start
```

访问 `http://127.0.0.1:8787`。生产启动不自动构建 Web；缺少导出文件会拒绝启动。`bun run start:api` 仅运行 API 与可选 Telegram。模型、通道和工具配置见[应用配置](configuration.md)。

## Web 与 API 地址

生产 Web 默认同源访问 API；开发 Web 和原生客户端可在构建前使用 `EXPO_PUBLIC_PIKO_API_URL` 指定后端。构建后修改服务端环境不会改写客户端地址。Web 支持添加到主屏幕，但没有离线 Service Worker。

## 网络访问与安全边界

后端默认只监听本机。Piko 没有内置登录、Origin 白名单或多用户隔离；文件和命令按后端账户权限执行，工作区不是沙箱。远程访问须使用受信网络或认证代理保护网页、所有 API 和 SSE，并阻止绕过代理直连。代理应关闭 SSE 缓冲并允许长连接。

可选 Telegram 使用 long polling，需要后端出站网络；同一 Bot 只能有一个 poller。配置和限制见[Telegram 通道](../features/telegram-channel.md)。

## 备份与验证

停止服务后备份整个 PIKO_HOME 和单独指定的工作区，SQLite 目录连同 WAL 成套保存；详见[存储说明](storage.md)。代理认证、真实 Telegram 网络和设备浏览器行为需在部署环境验证。
