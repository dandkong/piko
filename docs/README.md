# 文档索引

[English](README.en.md) | 中文

按用途组织：`guides/` 是中英配对的用户指南，`design/` 是跨功能产品与设计约定，`features/` 是功能说明，`operations/` 是详细配置与运维参考；后三者保留中文。项目状态见[路线图](../ROADMAP.md)。

## 用户指南

- 路线图：[English](../ROADMAP.en.md) / [中文](../ROADMAP.md)
- 源码运行：[English](guides/deployment.md) / [中文](guides/deployment.zh-CN.md)
- 基础配置：[English](guides/configuration.md) / [中文](guides/configuration.zh-CN.md)
- 数据和备份：[English](guides/storage.md) / [中文](guides/storage.zh-CN.md)

配置指南面向首次使用；[配置参考](operations/configuration.md)覆盖更完整的字段与边界。以下设计、功能和内部运行说明不与用户指南逐项镜像。

## 项目概览

- 项目 README：[English](../README.md) / [中文](../README.zh-CN.md)，包含项目介绍、快速开始和安全提示
- [路线图](../ROADMAP.md)：当前状态、限制和后续方向
- [产品说明](design/PRODUCT.md)：产品范围、主要交互和体验约定
- [架构说明](design/ARCHITECTURE.md)：客户端、服务端、运行时与持久化边界
- [交互规范](design/INTERACTION.md)：组件、状态、尺寸、颜色和动效

## 功能说明

| 文档 | 内容 |
| --- | --- |
| [工作区与主会话](features/workspace-and-main-chat.md) | 持久历史、资源加载、记忆整理和恢复 |
| [会话事件与实时活动](features/conversation-events.md) | 运行时事实、SSE 契约、头像状态和 Telegram 有序呈现 |
| [旁聊](features/side-chats.md) | 独立聊天、管理与删除边界 |
| [后台工作](features/background-subagents.md) | 委派、结果回传和恢复 |
| [Agent 构建与后台执行](features/agent-composition.md) | Agent 配置、资源策略、原生 fork 和公共执行边界 |
| [任务与执行记录](features/tasks.md) | 手动/定时任务、执行记录、归档与恢复 |
| [Telegram 通道](features/telegram-channel.md) | 主会话共享、命令、附件与投递限制 |
| [网页工具](features/web-tools.md) | 网页搜索、正文提取和凭据配置 |
| [附件](features/attachments.md) | 共享附件存储、Web 上传、Telegram 接入和当前限制 |
| [个性化帖子](features/posts.md) | 用户上下文、每日自动或手动生成、历史检索与卡片预览 |
| [产物浏览](features/artifacts.md) | 工作区文件夹、文本预览、下载与路径边界 |
| [设置与模型](features/settings.md) | 设备本地语言与外观、主/后台模型选择与思考强度 |
| [错误反馈与恢复](features/error-feedback.md) | 局部加载、操作失败、确认错误、超时与安全重试 |

## 配置与运维

| 文档 | 内容 |
| --- | --- |
| [应用配置](operations/configuration.md) | 配置文件职责、环境变量和凭据边界 |
| [Agent 运行时](operations/agent-runtime.md) | 模型、技能、思考强度和 Durable 行为 |
| [Linux Web/API 运行](operations/deployment.md) | Web 构建、单进程启动与访问安全边界（不含部署模板） |
| [SQLite 存储](operations/storage.md) | 原生存储、备份与恢复 |
| [运行日志](operations/logging.md) | 服务端关键运行事件、日志位置与隐私边界 |

## 仓库约定

- [仓库编码约定](../AGENTS.md)：架构边界、文档维护和验证要求
