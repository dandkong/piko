# 设置与模型

状态：App 设置提供设备本地的外观偏好，并管理主模型与后台模型选择及各自的思考强度。供应商、模型目录、凭据、工具、通道和所有环境变量均由部署配置管理，不在 App 中编辑。

## 页面

- 设置页首先显示“外观”卡片，提供“跟随设备 / 深色 / 浅色”下拉选择；选择立即应用并保存在当前设备，不写入服务端设置。
- 随后直接显示“主模型”和“后台模型”两个区块；每个区块用左右并排的两个下拉框，分别选择模型和该模型支持的思考强度。未选择模型时，思考强度下拉框禁用。
- 不为模型选择增加二级菜单。通用 `SettingsDetailPage` 模板保留供未来复用，但当前模型设置不使用它。
- 模型目录由部署配置提供。若部署没有可用模型，页面只显示部署侧配置提示，不提供供应商或凭据表单。
- 模型策略选择后立即反映在页面，并按修订号串行写入 `piko.json`、热应用，不需要重启服务；成功不提示。失败先恢复上次确认的选择，面板打开时原位说明并提供重新读取，已关闭时才用 Toast。响应丢失不证明服务端没保存，重新读取成功后才能核对结果。

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

## 错误与短反馈

- App 输入框在有内容时允许尝试发送；若没有可用主模型，后端在 Durable 接纳前返回配置错误，App 恢复草稿并显示短暂 Toast。
- Telegram 收到普通消息时先检查主模型状态；没有选择时回复 `/models` 指引，不保存消息或下载附件。部署模型不可用时提示检查部署配置。
- 设置读取错误与保存错误留在设置内；读取可直接重试，保留上次读取的可用内容。通用请求/反馈边界见[错误反馈与恢复](error-feedback.md)。

## 实现位置

- `server/settings/` 与 `server/runtime/settings.ts`：模型角色配置读写和可用模型摘要。
- `server/runtime/model-config.ts`、`server/runtime/pi.ts`：主/后台模型策略加载、热应用和动态继承。
- `apps/mobile/src/features/settings/AppearanceSection.tsx` 与 `apps/mobile/src/theme.ts`：设备本地外观选项、主题色板和系统外观响应。
- `apps/mobile/src/features/settings/`：一级模型与思考强度下拉控件。
- `apps/mobile/src/features/shell/AppShell.tsx`、`features/chat/useChat.ts`：主模型缺失 Toast。
- `server/channels/telegram/channel.ts`：Telegram 原生缺模型提示。
- `SettingsDetailPage.tsx` 是保留的通用布局模板；当前设置页不调用。

## 验证边界

`1fa6103` 后类型检查及 Web/iOS/Android Expo 导出通过。临时隔离检查验证了设置只写 `piko.json`、不改 models/auth 部署文件、动态后台继承/思考覆盖和旧设置写入字段拒绝；Telegram fake-transport 检查确认缺主模型时发送 `/models` 指引且不接纳消息或下载附件。生产 Web 浏览器检查了一级模型下拉、两组思考强度控件、无凭据输入框、390px 面板，以及模拟 409 时 Toast 显示且草稿保留。服务健康、`GET /api/settings` 字段和旧 `/api/settings/config` 的 404 已核对。未使用真实供应商调用、真实 Telegram Bot 或原生真机验收。

外观偏好存储在本地 `AsyncStorage`，不调用模型设置 API；“跟随设备”通过系统颜色方案监听变化。主题切换的本轮 TypeScript 检查及 Web/iOS/Android Expo 导出通过；尚未在真实浏览器或 iOS/Android 设备上目视验收。
