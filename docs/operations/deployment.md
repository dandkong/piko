# Linux 部署

状态：已提供 Web 构建、单进程启动与 systemd 模板。Web、API/SSE 和可选 Telegram 共用一个 Bun 进程及主会话，不运行 Expo 开发服务，不在启动时重新构建网页。

## 构建与运行

Linux 需要 Bun 1.4 或更新版本、可运行当前 Expo CLI 的 Node.js，以及工具执行使用的本机 Shell。运行账号须能读取源码、依赖和导出文件，写入 PIKO_HOME 和助手工作区。源码与用户状态使用独立目录。

在源码根目录执行：

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run build:web
PIKO_HOME=/home/your-user/.piko bun run start
```

访问 http://127.0.0.1:8787。缺少 apps/mobile/dist/web/index.html 时启动会报错，先完成构建。`bun run start:api` 仅启动 API 与可选 TG；开发仍使用 dev / dev:web / dev:api。

首次运行补齐配置与模板，默认 TG 关闭。停止进程，编辑统一行为 piko.json（含 agent 预设）、模型目录 models.json、模型凭据 auth.json（或 models.json 的 provider apiKey），以及只含部署参数/通道和工具凭据的私有 .env 后再启动。示例 piko.json：

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "userId": "填写自己的数字用户 ID"
    }
  }
}
```

部署参数与凭据只放 PIKO_HOME/config/.env 或进程环境，例如：

```dotenv
PIKO_HOST=127.0.0.1
PIKO_PORT=8787
PIKO_TELEGRAM_BOT_TOKEN="填写轮换后、未暴露的 token"
EXA_API_KEY="可选：Exa Search Key"
TAVILY_API_KEY="可选：Tavily Search Key"
DEEPSEEK_SEARCH_API_KEY="可选：DeepSeek Search Key"
BRAVE_SEARCH_API_KEY="可选：Brave Search Key"
```

.env 权限设为 0600，不随仓库/镜像发布。同一字段没有 JSON/env 双入口，旧环境行为开关必须移除。配置见[应用配置](configuration.md)与[Agent 运行时](agent-runtime.md)。TG 使用 long polling，同一 Bot 只运行一个实例；后端需要出站连接 Telegram。明确启用 TG 后缺少凭据或用户 ID 无效会拒绝启动，主动关闭 TG 才跳过其校验；已启用通道的致命轮询/启动错误会清理并退出整个后端，由 Restart=on-failure 自动拉起，网页/API 会短暂断开。网络抖动由 grammY 自动重试。命令与限制见[通道说明](../features/telegram-channel.md)。

## Web 与 API 地址

正式 Web 默认使用同源 /api，同一构建可从 localhost、局域网或域名访问，无需写入服务器地址。开发 Web 仍默认使用 127.0.0.1:8787，Android/iOS 默认地址不变。EXPO_PUBLIC_PIKO_API_URL 可在构建前覆盖；构建后的服务环境不会改写网页地址，同源部署不要沿用开发时的该变量。

生产导出包含 PWA manifest、水豚应用图标及 iOS 主屏幕元数据。iPhone Safari 打开 HTTPS 地址后选择“分享 → 添加到主屏幕”，启动时以 standalone 独立窗口显示。当前未注册 Service Worker，不支持离线访问，也避免缓存旧客户端或 API/SSE 响应。

静态服务只读取导出目录，拒绝隐藏文件、非法路径和越界链接。HTML 与无指纹文件要求重新验证，带内容指纹的资源可长期缓存。未知 API 与缺失脚本/图片返回 404，浏览器页面导航才使用 SPA fallback。Piko 不过滤 Origin，跨源浏览器请求会获得 CORS 响应头；部署访问控制由反向代理或网络边界负责。

## systemd

模板见 [deploy/piko.service](../../deploy/piko.service)，假设已有 piko 用户/组、源码 /opt/piko 和 Bun /home/piko/.bun/bin/bun。按实际机器修改 User、Group、WorkingDirectory、ExecStart，Bun 使用绝对路径。

服务的 PIKO_HOME=/var/lib/piko；StateDirectory 由 systemd 创建和保留，归服务账号所有，权限 0700。若先手动初始化，须以同一服务账号运行；管理员可先创建目录：

```bash
sudo install -d -m 700 -o piko -g piko /var/lib/piko
```

以服务账号完成依赖、构建和配置，安装已调整的 unit：

```bash
sudo cp deploy/piko.service /etc/systemd/system/piko.service
sudo systemctl daemon-reload
sudo systemctl enable --now piko
sudo systemctl status piko
sudo journalctl -u piko -f
```

修改配置或部署新服务端代码后用 `sudo systemctl restart piko`。异常退出自动重启；正常停止发送 SIGTERM，后端取消工作、关闭存储并释放锁。重启不自动重放不确定执行或补发 TG 回复。

更新前先等当前任务结束，停止服务再安装和构建，避免构建删除正在访问的资源：

```bash
sudo systemctl stop piko
git pull --ff-only
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run build:web
sudo systemctl start piko
```

源码由运行账号管理，更新不删除状态和工作区。备份停止服务后成套保存原生 SQLite 存储目录及工作区，不能遗漏 WAL；备份与恢复见[SQLite 存储](storage.md)。Windows 盘符路径不能直接用于 Linux；已有会话 cwd 与配置不同时拒绝启动，首次 Linux 部署使用新的 PIKO_HOME。

## 访问与反向代理

默认监听 loopback，可通过 SSH 转发访问；局域网访问在后端环境/.env 设置 PIKO_HOST=0.0.0.0（不在 JSON）。当前没有 Piko 登录验证，对外入口使用受保护的网络或带认证的反向代理，认证须覆盖网页与全部 API/SSE。

代理转发整个站点到 Bun 的同一端口，保留 Host，不缓存 API，关闭 SSE 缓冲，读取超时长于 15 秒心跳。Web 通过同源 `/api` 访问，不需要配置 CORS Origin。当前 Piko 不做 Origin 白名单或身份认证；反向代理应统一校验网页、API 和 SSE，并限制后端端口不要绕过代理直连。Web 无需设置 `EXPO_PUBLIC_PIKO_API_URL`。

## 部署验证边界

仓库提供 Web 构建、单进程启动和 systemd 模板。具体 Linux 发行版、代理认证、systemd 开机启动、真实 Telegram 网络与设备浏览器行为，需在目标部署环境验证。

参考：[Expo Web 导出](https://docs.expo.dev/workflow/web/)、[Bun 文件响应](https://bun.sh/docs/guides/http/stream-file)、[systemd StateDirectory](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)。
