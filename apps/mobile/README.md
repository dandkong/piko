# Piko React Native 客户端

`apps/mobile` 是唯一前端，使用 Expo SDK 57 / React Native，覆盖 Web、iOS、Android。模型、凭据与实际工作由根目录 Bun 后端管理。

安装、启动、Android 原生构建、API 地址、配置与验证命令统一见 [根目录 README](../../README.md)。依赖版本以 package.json / bun.lock 为准，客户端维护自己的锁文件；`uuid` override 用于 Expo 的嵌套 xcode 构建依赖。

## 客户端开发约定

- `App.tsx` 负责初始化；`src/components/AppShell.tsx` 管理通用布局；`src/theme.ts` 管理视觉基础。
- 按钮、行、chip 和图标控件的状态、尺寸与动效统一遵循 [交互与视觉规范](../../docs/INTERACTION.md)；优先复用 `TactilePressable`、`IconButton`、`TextButton`，不要为单个控件另写按压样式。
- 页面按功能放进 `src/features/`，临时交互状态留在 Hook，持久业务状态归服务端。Chat 的页面、输入框、API 与 SSE transport 位于 `src/features/chat/`。
- 动效使用 Reanimated 和匹配 Expo SDK 的 Worklets，Babel preset 自动配置插件。`TypingIndicator.tsx` 提供等待动效，启用减少动效时保持静止，卸载后停止循环。
- 左上菜单打开悬浮导航抽屉，四个页签与底部导航共用 `src/navigation.ts` 的配置；抽屉下方旁聊列表右侧三点菜单提供重命名/归档，右下一键使用默认名“新旁聊”创建并进入。顶部名字固定 Piko；主/旁聊分别保留草稿与历史，Chat 导航返回主会话；归档后隐藏，不提供已归档列表或恢复入口。设置和通知尚未接入；不展示不可用的功能页面。详见 [旁聊](../../docs/features/side-chats.md)。
- Android / iOS 生成工程已忽略，原生设置通过 app.json 和配置插件保存。新增原生依赖或原生配置后重建应用，不能只依赖热更新。
- 键盘弹出时仅输入框与“回到底部”按钮跟随上移，聊天视口和其他控件保持原位。Android 使用 `adjustNothing` 让键盘覆盖底部区域，并由应用移动输入框；此原生设置在 `apps/mobile/plugins/with-android-adjust-nothing.js` 中配置，Android 需使用自定义开发构建，Expo Go 不会应用该插件。iOS 使用键盘事件驱动动画，可在 Expo Go 中验证。
- 历史默认最近 50 条，向上滚到顶部附近加载更早记录；失败可点击列表顶端重试。分页合并与断线窗口恢复在 shared/history.ts，原生列表保位使用 maintainVisibleContentPosition，Web 使用可见消息 DOM 锚点补齐 RN Web 未实现的保位行为。
- 输入、滚动和布局的已确认行为见 [产品约定](../../docs/PRODUCT.md)。原生键盘与后台切换需设备验证。
- OpenMuse UI 与素材授权见 [第三方说明](../../THIRD_PARTY_NOTICES.md)。

客户端通过 `/api/chat` 读取后端唯一主会话，持续 `/api/chat/events` 观察两通道变化，POST 只提交输入。工作区和原生 JSONL 都在后端，不使用 SQLite 或客户端聊天 ID。职责见 [架构约定](../../docs/ARCHITECTURE.md)，恢复行为见 [工作区与主会话模型](../../docs/features/workspace-and-main-chat.md)。

正式 Web 使用 `bun run build:web` 导出，由根目录 `bun run start` 托管，默认同源 /api；开发 Web 和原生客户端保持原默认地址。显式 EXPO_PUBLIC_PIKO_API_URL 在构建时生效。部署见 [Linux 正式入口](../../docs/features/linux-deployment.md)。

生产 Web 带有 PWA manifest、水豚图标和 iOS 主屏幕元数据。iPhone 用 Safari 打开 HTTPS 地址，通过“分享 → 添加到主屏幕”安装后以独立窗口启动。当前不注册 Service Worker，因此需要联网，不提供离线缓存；聊天 API 与 SSE 也不会被 Service Worker 缓存。
