# Piko 应用配置

状态：已实现统一加载、env 映射和校验；HTTP、工作区、Telegram 与开发启动脚本已迁移。应用配置仅在启动时加载，修改后重启 API。模型配置保留独立文件，修改后同样重启 API。

## 文件与加载入口

后端默认使用 `~/.piko`，也可通过进程环境变量 `PIKO_HOME` 指定绝对路径。它用于找到配置目录，不从 `piko.json` 或该目录中的 `.env` 读取，以免配置定位形成循环。

```text
PIKO_HOME/config/
  piko.json       # HTTP、工作区、通道
  .env            # 可选，本地环境变量与密钥
  settings.json   # 模型预设与 durable 运行参数
  models.json     # 模型定义与供应商配置
  auth.json       # 模型凭据
```

`server/config.ts` 的 `loadPikoConfig` 是应用配置入口，返回类型明确的 `PikoConfig`。先读取原始 JSON，再将 env 映射、转换成配置字段，与默认值按优先级合并，最后统一校验和解析凭据引用。env 映射不另设端口范围、路径或身份校验规则；文件与 env 的最终值共用同一套规则和字段级错误。调用处只接收解析好的配置，不自行读取 `PIKO_*`。通用 JSON、`.env` 和 `env:NAME` 引用处理在 `server/config/files.ts`，模型加载器复用这些函数，不依赖应用配置内容。

读取配置不写文件、不修改 `process.env`。首次初始化只创建缺失的 `piko.json`，默认监听 `127.0.0.1:8787`、Telegram 关闭；已有配置和 `.env` 不覆盖，不把环境变量、密钥或本机路径写入默认配置。内部会话上限、空闲时间等实现参数仍留在代码中。

## 配置示例

编辑 `PIKO_HOME/config/piko.json`：

```json
{
  "http": {
    "host": "127.0.0.1",
    "port": 8787,
    "corsOrigins": ["http://localhost:8081"]
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "userId": "123456789",
      "botToken": "填写 BotFather 提供的 token"
    }
  }
}
```

可选的 `workspace.path` 指定工作区绝对路径，省略时为 `PIKO_HOME/workspace`。state 固定在 `PIKO_HOME/state`，不能落进助手工作区。

日常可以将 Telegram 身份和 token 全部填在 `piko.json`，无需 `.env`。如果需要环境变量覆盖，也可在同一目录的 `.env` 保存 Bot token；普通应用参数和模型引用变量也可放在这里：

```dotenv
PIKO_TELEGRAM_BOT_TOKEN="填写 BotFather 提供的 token"
```

`botToken` 支持字面值或 `env:NAME`（例如 `env:PIKO_TELEGRAM_BOT_TOKEN`），引用在合并本地与进程环境后解析。Telegram 默认关闭，只有显式设 `enabled: true` 或 `PIKO_TELEGRAM_ENABLED=true` 才启用；仅有 token 不启用通道。关闭时无需提供或解析凭据。

## 覆盖规则

应用字段优先级：**代码默认值 < piko.json < config/.env < 进程环境变量**。映射是显式的，不把任意环境变量转换成应用字段。

只校验合并后的最终字段，因此有效的高优先级值可以覆盖低优先级中的无效字段，例如 `PIKO_PORT=8787` 可以覆盖文件里的无效端口；env 的转换失败保留为无效值，交给统一校验处理。未设置的 env 不生成覆盖，数组整体替换，未知字段保留到校验阶段报错。JSON 语法错误和非对象根节点仍直接拒绝。

| 字段 | 环境变量 | 默认值 / 校验 |
| --- | --- | --- |
| 根目录定位 | `PIKO_HOME` | `~/.piko`；仅进程环境，要求绝对路径 |
| `workspace.path` | `PIKO_WORKSPACE` | `PIKO_HOME/workspace`；绝对路径 |
| `http.host` | `PIKO_HOST` | `127.0.0.1`；非空且不含空白 |
| `http.port` | `PIKO_PORT` | `8787`；整数 1–65535 |
| `http.corsOrigins` | `PIKO_CORS_ORIGINS` | 空列表；env 用逗号分隔，只接受 HTTP(S) Origin |
| `channels.telegram.enabled` | `PIKO_TELEGRAM_ENABLED` | `false`；env 为 true/false，不区分大小写 |
| `channels.telegram.userId` | `PIKO_TELEGRAM_USER_ID` | 启用时必须是正整数数字 ID，以字符串保存 |
| `channels.telegram.botToken` | `PIKO_TELEGRAM_BOT_TOKEN` | 启用时必须有值；支持 `env:NAME` |

数组覆盖整个列表，不自动合并。`PIKO_CORS_ORIGINS` 设为空字符串可以清空允许列表；布尔值 `false` 是明确覆盖，不按字符串是否非空判断。空端口、空工作区、空主机或启用通道的空凭据均视为错误。

`.env` 支持注释、可选 `export`、单/双引号，不执行 Shell、不展开命令或变量；Windows 路径建议用单引号。进程中未定义的变量不会抹掉本地值。该文件不注入 Expo 或全局进程环境。

`bun run dev`、`dev:web`、`dev:android` 使用同一个配置入口检查 API 地址与端口，并在解析后的 CORS 列表上追加本机 Expo Origin，再传给 API 子进程；保留文件和环境中的其他 Origin。客户端 `EXPO_PUBLIC_PIKO_API_URL` 仍由 Expo 的环境配置提供，修改 API 地址或端口时须相应设置客户端地址。

## 错误、生效与边界

JSON 语法、核心字段类型、未知核心字段、HTTP 和路径配置错误阻止启动。Telegram 字段、布尔值、身份或凭据错误仅停用 Telegram，并记录字段级警告，RN 仍可运行；网络启动与运行错误保持原有通道隔离。错误不输出凭据值或完整配置。

应用配置、模型文件和共享 `.env` 修改后均重启后端生效。目前不提供 reload API；不新增配置写入 API、管理页面、热更新或密钥库。

已有环境变量继续按表映射。原先仅凭 token 启动 TG 的方式改为显式启用，需补充 `PIKO_TELEGRAM_ENABLED=true` 或修改 `piko.json`。这次改动不修改数据库 schema、模型凭据格式或原生会话日志。

自动化覆盖默认值与读取副作用、文件/env 优先级、两种输入的校验错误一致、高优先级修正无效字段、空覆盖/未知字段、路径边界、严格参数解析、凭据引用、通道错误隔离、不覆盖用户文件和共享 `.env` 的模型请求。

## 正式 Web 部署

正式 `bun run start` 沿用同一 HTTP、工作区和 Telegram 配置，固定托管 apps/mobile/dist/web；Web 构建默认同源 /api，同源请求无需额外 CORS 配置，跨源仍需白名单。HTTPS 代理终止时按实际公网 Origin 填 http.corsOrigins；后端不从代理头推断可信来源。开发 Web 与原生端默认地址不变，EXPO_PUBLIC_PIKO_API_URL 是构建时的客户端覆盖，不属于运行时 piko.json。详细步骤见 [Linux 正式入口](linux-deployment.md)。
