# 交互与视觉规范

本文维护跨页面、跨平台的一致性；功能专属布局、键盘、滚动和业务行为见对应[功能文档](../README.md#功能说明)。新增或修改界面先复用现有组件与令牌，不未经请求改变既有交互。

## 设计原则

- **轻、稳、克制**：不使用水波纹、弹跳或强对比闪烁；同类操作的尺寸、颜色、状态和反馈保持一致。
- **层级清晰**：Primary 用于提交、创建等主要操作，同一区域通常只保留一个；Secondary 用于普通动作；列表行、标签和附件等使用轻量表面。
- **语义一致**：选中和普通交互使用中性灰；蓝色用于主操作和用户消息，链接与焦点使用主题语义色。不用颜色作为唯一状态标识。
- **适配主题**：支持跟随设备、浅色与深色；颜色、圆角、尺寸和动效以 `apps/mobile/src/theme.ts` 为准，不在页面另建近似令牌。

## 共用尺寸与状态

| 项目 | 规范 |
| --- | --- |
| 有效触控区域 | 至少 44×44；可用 `hitSlop` 扩大 |
| 图标按钮 | md 44×44；sm 36×36 并扩大命中区 |
| 行按钮 / 文本按钮 / chip | 最小高 48 / 高 36 / 约高 32 |
| 文本输入 | 高至少 48 |
| 控件、卡片、面板、胶囊圆角 | 分别使用 `radii.control`、`radii.card`、`radii.panel`、`radii.pill` |
| 图标 | lucide，默认描边 1.8；导航约 22、动作 20–22、辅助 18 |

控件应处理默认、悬停、按压、键盘焦点、选中和禁用等适用状态。禁用保留原有变体、统一 60% 透明度并禁止触发；焦点状态可见。列表复合行只绘制一层整行状态背景，行内独立操作保留自己的命中区和可访问性语义。

按钮和 chip 使用轻微按压缩放；整行不缩放。动效使用 Reanimated 和主题令牌，遵循系统“减少动效”设置；不使用普通按钮的循环呼吸或回弹。

## 共用组件

| 场景 | 优先使用 |
| --- | --- |
| 按钮、行、复合行 | `TactilePressable`、`IconButton`、`TextButton`、`TactileListRow` |
| 非聊天页面、卡片 | `Screen`、`ScreenCard` |
| 单行文本输入、锚定菜单、确认 | `TextInputDialog`、`AnchoredMenuContent`、`ConfirmationDialogContent` |
| 浮层、Markdown/文本预览 | `FloatingPanel`、`ContentPreviewPanel`、`MarkdownContent` |
| 长内容滚动、反馈 | `AppScrollView`、`FeedbackToast`、`ErrorNotice` |

组件均位于 `apps/mobile/src/components/`。同一行有多个操作时由 `TactileListRow` 承载统一状态背景，子控件避免重复绘制背景；不要另建按钮样式。文本弹窗、菜单、确认和预览使用共享组件，不叠加不必要的原生 Modal。

## 反馈与可访问性

- 短暂操作反馈使用 `FeedbackToast`；需要持续处理或重试的错误留在所属页面、输入或确认框。同一失败只设一个主要反馈位置，加载失败不显示成空状态。恢复动作必须符合操作语义，详见[错误反馈与恢复](../features/error-feedback.md)。
- 按钮提供 `accessibilityLabel`，适用状态通过 `accessibilityState` 暴露；禁用控件保留在可访问性树中。键盘焦点顺序与视觉顺序一致，Enter / Space 可触发相应操作。
- Web 支持 hover 和键盘焦点；原生不使用 Android 水波纹。各平台共用尺寸与状态体系，不为单个平台另造按钮样式。
- 修改交互后验证受影响平台；原生设备、键盘、无障碍和动效未实际验证时明确说明。聊天专属交互参见[主会话](../features/main-chat.md)。
