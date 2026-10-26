# 文档索引

按读者和用途整理 Piko 文档。项目整体状态以[路线图](../ROADMAP.md)为准；功能文档会进一步说明范围、运行行为和验证限制。

## 项目概览

- [项目 README](../README.md)：项目介绍、快速开始和安全提示
- [路线图](../ROADMAP.md)：当前状态、限制和后续方向
- [产品说明](PRODUCT.md)：产品范围、主要交互和体验约定
- [架构说明](ARCHITECTURE.md)：客户端、服务端、运行时与持久化边界
- [交互规范](INTERACTION.md)：组件、状态、尺寸、颜色和动效

## 功能说明

| 文档 | 内容 |
| --- | --- |
| [工作区与主会话](features/workspace-and-main-chat.md) | 持久历史、资源加载、记忆整理和恢复 |
| [旁聊](features/side-chats.md) | 独立聊天、管理与删除边界 |
| [后台工作](features/background-subagents.md) | 委派、结果回传和恢复 |
| [任务与执行记录](features/tasks.md) | 手动/定时任务、执行记录、归档与恢复 |
| [Telegram 通道](features/telegram-channel.md) | 主会话共享、命令、附件与投递限制 |
| [网页工具](features/web-tools.md) | 网页搜索、正文提取和凭据配置 |
| [附件](features/attachments.md) | 服务端附件存储、Telegram 图片和当前限制 |

## 配置与运维

| 文档 | 内容 |
| --- | --- |
| [应用配置](operations/configuration.md) | 配置文件职责、环境变量和凭据边界 |
| [Agent 运行时](operations/agent-runtime.md) | 模型、技能、思考强度和 Durable 行为 |
| [Linux Web/API 运行](operations/deployment.md) | Web 构建、单进程启动与访问安全边界（不含部署模板） |
| [SQLite 存储](operations/storage.md) | 原生存储、备份与恢复 |

## 仓库约定

- [仓库编码约定](../AGENTS.md)：架构边界、文档维护和验证要求
- [第三方说明](../THIRD_PARTY_NOTICES.md)：OpenMuse UI 与素材的许可声明
