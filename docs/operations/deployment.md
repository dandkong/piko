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

启动前在 `PIKO_HOME/config/.env` 设置随机 `PIKO_ACCESS_KEY`，并将文件权限设为 0600；未配置密钥时拒绝启动。访问 `http://127.0.0.1:8787` 并输入密钥。生产启动不自动构建 Web；缺少导出文件会拒绝启动。`bun run start:api` 仅运行 API 与可选 Telegram。其他配置见[应用配置](configuration.md)。

## Web 与 API 地址

生产 Web 默认同源访问 API，反向代理应保留原始 `Host`，无需配置公网域名。开发 Web 可在构建前使用 `EXPO_PUBLIC_PIKO_API_URL` 指定后端，并在后端配置允许的开发 Origin。原生客户端在登录页设置服务器地址。Web 支持添加到主屏幕，但没有离线 Service Worker。

## 网络访问与安全边界

后端默认监听所有 IPv4 接口；可通过 `PIKO_HOST=127.0.0.1` 限制为本机。Web 和原生客户端使用同一个访问密钥登录；修改密钥并重启会使原有登录失效。Telegram 沿用独立的用户 ID 校验。会话有效期为 30 天；退出仅清除当前设备凭据，撤销已泄露的会话需更换密钥。Piko 不提供多用户隔离；文件和命令按后端账户权限执行，工作区不是沙箱。HTTP 不加密密钥、会话和内容，远程访问应使用 HTTPS 或受信网络。反向代理应关闭 SSE 缓冲并允许长连接。

可选 Telegram 使用 long polling，需要后端出站网络；同一 Bot 只能有一个 poller。配置和限制见[Telegram 通道](../features/telegram-channel.md)。

## 备份与验证

停止服务后备份整个 PIKO_HOME 和单独指定的工作区，SQLite 目录连同 WAL 成套保存；详见[存储说明](storage.md)。真实 Telegram 网络及设备浏览器行为需在部署环境验证。
