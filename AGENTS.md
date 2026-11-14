# Piko 编码指导

## 项目与文档

Piko 是本地优先的个人助理。前端为 Expo / React Native，后端为 Bun，pi-durable 是唯一 Agent 运行时，模型适配使用 pi-ai。

当前处于开发期，架构可随需求随时调整，无需考虑旧版本兼容、历史数据迁移或为此保留过渡实现。

- 启动、环境与检查命令见 [README](README.md)。
- 产品体验与范围见 [产品约定](docs/design/PRODUCT.md)。
- 所有可交互控件的状态、尺寸、颜色、动效与组件用法见 [交互与视觉规范](docs/design/INTERACTION.md)，新增和修改 UI 必须遵循。
- 依赖方向、工作区与领域模型见 [架构约定](docs/design/ARCHITECTURE.md)。
- 当前状态与未来方向见 [路线图](ROADMAP.md)。
- 面向用户的双语指南放在 `docs/guides/`，产品和设计约定放在 `docs/design/`，功能说明放在 `docs/features/`，内部配置与运维参考放在 `docs/operations/`。文档索引见 [docs/README.md](docs/README.md)，已实现基线见 [工作区与主会话模型](docs/features/workspace-and-main-chat.md)。

文档只描述当前能力、已确定方向和明确限制，不记录实现过程；修改行为时同步对应文档，不要将方案写成现有能力。本文件指导仓库开发，不是运行中 Piko 助手的工作区 `AGENTS.md`。

## 持续有效的约定

- 一级模块为 Chat、Tasks、Posts、Artifacts；主会话是默认入口。旁聊、后台工作与持久化任务的交互和所有权边界分别见[产品说明](docs/design/PRODUCT.md)及对应功能文档。
- 客户端遵循统一轻触规范，复用既有交互组件；不另建按钮样式或未经请求改动已确认的键盘、滚动和布局行为。细则见[交互与视觉规范](docs/design/INTERACTION.md)。
- 助手工作区位于后端并独立于源码。内建资源随应用发布，用户指导、记忆和技能保存在工作区；初始化不得覆盖用户内容。资源加载边界见[工作区与主会话](docs/features/workspace-and-main-chat.md)。
- Durable 原生 SQLite、Harness 和原始 entries 是会话与执行的事实来源。UI 从原始 entries 投影历史；不得建立第二套消息正文、Run 状态或持久流事件。

## 名称约定

- 面向用户称“任务”“后台工作”“执行记录/运行结果”；代码保留 `subagent` 技术名。任务类型为 `AssistantTask` / `AssistantTaskDraft`、`TaskSchedule` / `TaskExecution`，与 Durable 原生 `TaskId` / `TaskRecord` 区分；工具使用 `task_*` / `subagent_*`，任务 HTTP 使用 `/api/tasks`。
- Durable 文档 kind、`taskId` 绑定字段和 `tasks/<id>` 是持久化身份；改动前确认对数据语义的影响，统一命名时迁移现有数据，不添加兼容层或状态副本。

## 代码边界

- 客户端按“页面 → Hook/API → HTTP/SSE”分层，界面按 `apps/mobile/src/features/` 组织；共享跨端类型放在 `shared/`，不得依赖 React Native、Bun 或 Pi SDK。
- 服务端按“路由/通道 → 业务服务 → 运行时接口 → Pi 适配器”分层。SDK 类型、事件和配置细节留在 `server/runtime/`；工具业务逻辑与 SDK 注册分离。
- 会话输入、停止、维护、删除和内部报告统一经过 `ConversationControl` 接纳线；不得绕过控制器提交内部报告。`ConversationStore` 只负责输出合并和观察，关闭观察不停止执行；runtime 唯一拥有控制器与 Harness 生命周期。
- RN 请求身份使用 UUID；Durable 分配的实体 ID 跨端按不透明字符串传递；时间使用 Unix 毫秒。新增领域实现按实际需求落点，不提前搭通用框架。
- 文件和命令工具使用服务端进程权限；工作区 cwd 不是沙箱。资源范围必须显式指定，不自动继承个人 Pi CLI、祖先指导或用户代码扩展；提示词不能代替运行时权限控制。
- `piko.json` 管 Agent/应用行为，`models.json` 与 `auth.json` 管模型配置和凭据；部署、通道与工具凭据来自后端环境或私有 `.env`。不设置重复配置入口；Durable Extension 只注册 Piko 源码能力。配置细节见[应用配置](docs/operations/configuration.md)。
- 保留 Durable 提交去重、停止、最新快照恢复与重启不重放不确定执行的语义。SSE 不保存永久事件日志；断开观察者不等于取消执行。

## 修改与验证

- 保留用户现有改动；未经请求不改变键盘、滚动、布局等已确认交互。
- 使用 Bun，维护根目录和客户端各自的依赖与锁文件；依赖版本以 package.json / 锁文件为准。
- 持久化和隐私删除改动遵循[SQLite 存储](docs/operations/storage.md)中的数据范围；不删除附件、工作区文件或备份，不回滚外部副作用，也不宣称全介质擦除。
- Android / iOS 工程由 Expo 生成且已忽略，原生配置通过 `app.json` 或配置插件保存；不提交构建产物、本机路径、凭据和用户工作区内容。
- 动效使用 Reanimated；交互组件和第三方素材按[交互规范](docs/design/INTERACTION.md)及[第三方说明](THIRD_PARTY_NOTICES.md)维护。
- 代码改动按影响运行 `bun run typecheck`；涉及打包再做对应平台导出。仓库不保留测试套件，关键状态、持久化、路径边界和恢复行为以真实运行或临时脚本人工验证，并在文档中说明验证状态。
- 文档改动检查链接、命令和实现状态即可；原生键盘、网络和后台行为需要设备验证，未验证的范围明确说明。
