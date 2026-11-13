# 从源码运行 Piko

[English](deployment.md) | 中文

Piko 仍处于早期开发阶段。本指南只介绍从源码手动运行，不提供生产部署或原生 App 发布方案。

## 环境要求

- Bun 1.4 或更新版本，以及供 Expo CLI 使用的 Node.js。
- 供助手文件和命令工具使用的 Shell。
- 一个模型供应商及凭据，见[配置](configuration.zh-CN.md)。

## Web 开发模式

在仓库根目录运行：

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run dev:web
```

Expo Web 默认地址是 `http://localhost:8081`，API 默认监听 `127.0.0.1:8787`。首次启动会在 `~/.piko` 补齐缺失的配置和工作区文件。发送消息前需要配置并选择模型。

## 源码构建后的 Web

```bash
bun run build:web
bun run start
```

访问 `http://127.0.0.1:8787`；在前台进程按 Ctrl+C 停止。后端只托管现有 Web 构建，修改前端后需要重新构建。不要让多个后端使用同一个状态目录。

## 安全

后端没有内建认证或 Origin 防护；Shell 和文件工具拥有后端运行账户的权限，工作区不是沙箱。保持默认本机监听；远程访问时须通过认证代理保护整个站点、API 和 SSE，并防止不可信客户端绕过代理。见[配置](configuration.zh-CN.md)与[存储和备份](storage.zh-CN.md)。

Android、iOS 构建和设备行为尚未全面验证；目前不提供 Docker 部署或可安装发布包。
