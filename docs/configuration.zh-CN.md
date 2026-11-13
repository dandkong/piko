# 配置

[English](configuration.md) | 中文

首次启动时 Piko 会补齐 `~/.piko/config/` 中缺失的文件。启动前设置绝对路径 `PIKO_HOME` 可使用其他数据目录。不要提交凭据，也不要将凭据放进客户端。

- `piko.json`：应用行为和模型角色选择。
- `models.json`：模型目录、自定义供应商及可选模型 API Key。
- `auth.json`：模型凭据，优先于 `models.json` 中的模型 Key。
- `.env`：可选的后端部署参数、工具和通道凭据；设置为私有权限（`chmod 600`）。

例如，在 `auth.json` 中为内置模型配置凭据：

```json
{
  "deepseek": { "type": "api_key", "key": "YOUR_API_KEY" }
}
```

在 App 设置或 Telegram `/models` 中选择已配置模型。Piko 不从环境变量读取模型凭据。自定义供应商、工具 Key 和 Telegram 配置见[详细配置说明](operations/configuration.md)及[模型运行时说明](operations/agent-runtime.md)。

工具凭据及部署参数在后端启动时读取，修改后停止前台进程并重新启动。App 模型选择在下一次安全接纳边界生效。

**安全：**API 没有身份认证。助手可用后端账户权限执行命令和访问文件，不要将服务直接暴露给不可信网络。
