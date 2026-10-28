# 设置与模型

状态：App 设置只管理主模型与后台模型选择及各自的思考强度。供应商、模型目录、凭据、工具、通道和所有环境变量均由部署配置管理，不在 App 中编辑。

## 页面

- 设置页一级内容直接显示“主模型”和“后台模型”两个区块；各自用下拉列表选模型，下面用横向分段控件选该模型支持的思考强度。
- 不为模型选择增加二级菜单。通用 `SettingsDetailPage` 模板保留供未来复用，但当前模型设置不使用它。
- 模型目录由部署配置提供。若部署没有可用模型，页面只显示部署侧配置提示，不提供供应商或凭据表单。
- 模型策略变更立即写入 `piko.json` 并热应用，不需要重启服务。

## 模型语义

- `agent.profiles.main` 是唯一全局主模型，统一用于主聊天和所有旁聊；App 与 Telegram `/models`、`/thinking` 共用该配置。
- 未配置主模型时不自动选择目录中的第一个模型。App 用户尝试发送时显示 Toast；Telegram 返回原生消息提示通过 `/models` 选择。该输入在 Durable 接纳前被拒绝，App 草稿保留。
- `agent.profiles.background` 是后台模型覆盖。未指定时动态跟随主模型，而不是初始化时复制一次；用户显式选择其他后台模型后才独立。
- 后台思考强度缺省跟随主模型。用户可以在仍跟随主模型时单独设置后台思考强度；如果该强度不被后来选择的主模型支持，会重置为跟随主模型的思考强度。显式后台模型使用自己的思考强度。
- 主模型更换不修改正在执行的一轮或已启动的后台工作；主聊与旁聊在空闲或下一轮安全边界对齐新主模型，新建后台工作采用当时有效的后台策略。

## 配置与 API 边界

- `GET /api/settings` 只返回当前主/后台模型策略、当前执行模型、可用模型摘要和配置修订号。
- `PUT /api/settings` 只允许写 `agent.profiles.main`、后台模型覆盖和后台思考强度；目录、凭据和其他字段无法通过此接口写入。旧 `/api/settings/config` 路由已移除。
- `models.json`、`auth.json` 和 `config/.env` 仍由部署维护。配置快照不返回 API Key、环境变量或原始模型目录。
- 设置 API 当前没有内置鉴权，但权限已收敛为更改模型选择；不应把它暴露给不可信网络，以免未授权方切换模型或增加模型调用成本。

## Toast 行为

- App 输入框在有内容时允许尝试发送；若没有可用主模型，后端在 Durable 接纳前返回配置错误，App 恢复草稿并显示短暂 Toast。
- Telegram 收到普通消息时先检查主模型状态；没有选择时回复 `/models` 指引，不保存消息或下载附件。部署模型不可用时提示检查部署配置。

## 实现位置

- `server/settings/` 与 `server/runtime/settings.ts`：模型角色配置读写和可用模型摘要。
- `server/runtime/model-config.ts`、`server/runtime/pi.ts`：主/后台模型策略加载、热应用和动态继承。
- `apps/mobile/src/features/settings/`：一级模型选择下拉与思考强度分段控件。
- `apps/mobile/src/features/shell/AppShell.tsx`、`features/chat/useChat.ts`：主模型缺失 Toast。
- `server/channels/telegram/channel.ts`：Telegram 原生缺模型提示。
- `SettingsDetailPage.tsx` 是保留的通用布局模板；当前设置页不调用。

## 验证边界

`1f0a76e` 上游基线类型检查、Web/iOS/Android 导出和服务健康检查此前已通过。本轮模型设置收敛、动态后台继承及 Toast 修改的验证结果在完成后补记。真实供应商调用、Telegram Bot 端到端和原生真机交互仍需单独验证。
