# Piko 编码指导

## 项目与文档

Piko 是本地优先的个人助理。前端为 Expo / React Native，后端为 Bun，pi-durable 是唯一 Agent 运行时，模型适配使用 pi-ai。

当前处于开发期，架构可随需求随时调整，无需考虑旧版本兼容、历史数据迁移或为此保留过渡实现。

- 启动、环境与检查命令见 [README](README.md)。
- 产品体验与范围见 [产品约定](docs/PRODUCT.md)。
- 所有可交互控件的状态、尺寸、颜色、动效与组件用法见 [交互与视觉规范](docs/INTERACTION.md)，新增和修改 UI 必须遵循。
- 依赖方向、工作区与领域模型见 [架构约定](docs/ARCHITECTURE.md)。
- 当前进度与开发顺序见 [路线图](ROADMAP.md)。
- 具体功能方案放在 `docs/features/`；已实现基线见 [工作区与主会话模型](docs/features/workspace-and-main-chat.md)。
- RN 与 Telegram 双通道已接入，共用主会话；支持范围与配置见 [通道说明](docs/features/telegram-channel.md)，复杂能力单独讨论。

文档明确区分已实现、已确定但未实现、待设计。修改行为时同步对应文档；不要将方案写成现有能力。本文件指导仓库开发，不是运行中 Piko 助手的工作区 `AGENTS.md`。

## 已确定的方向

- 客户端交互采用统一的“轻触”规范：导航选中用浅灰、提交/创建用浅蓝，同一区域最多一个主操作；按钮共享尺寸、状态矩阵和动效，不使用水波纹或弹跳。具体规则与组件见 [交互与视觉规范](docs/INTERACTION.md)，后续设计不得另起一套按钮样式。
- 主会话是默认且持续的交流入口；不先建设传统多会话切换界面。一级模块只保留 Chat（主聊天）、Tasks（任务）、Posts（主动帖子）、Artifacts（产物），不建设 Ideas。聊天列表铺满可用屏幕，头部、输入框与导航悬浮；上下使用同一浅色渐隐样式但独立控制覆盖范围；头部覆盖实测内容并向下延伸 12px，底部覆盖输入框/导航并在输入框上方延伸 32px。渐隐只负责视觉，列表首尾根据头像胶囊底边和输入框顶边实测，并与消息间距统一为 13px；头像不加底板，名字与状态保留上下结构并包在自适应胶囊内，正常空闲隐藏状态。
- 后台子 Agent 已接入同一 Harness 的 owned conversation：共用配置、全局工作区资源和基本工具，移除嵌套委派与任务管理；一次任务新建一个持久化子会话，不 fork 主聊天历史，额外背景写入委派任务；可信内部 follow-up 回传，不增加展示；普通停止保留后台工作，重启中断不确定执行，仅恢复已完成结果的回传。见 [后台子 Agent](docs/features/background-subagents.md)。
- 持久化任务已接入：一个任务对应一个 Prompt、可选 once/Cron 和固定 items/<id> 目录；每次创建新子会话，加载任务记忆、保存独立输出，结果同普通子 Agent 私下回传主 Agent。Tasks 按进行中/已归档分组展示任务与执行记录，页面可归档/恢复；创建、编辑、执行和停止在对话里完成。归档停止未来触发，单次执行成功才称完成，不设第三种任务状态。定义/游标用原生 doc，执行状态仍从原生 task/submission 投影，不建立 Run 表。见 [任务与执行记录](docs/features/tasks.md)。
- 旁聊已接入同一 Harness 的 ownerless conversation，支持一键默认名新建/列表/切换、三点菜单重命名/归档、独立历史和停止；顶部头像名字固定 Piko，归档后隐藏，不提供已归档或恢复入口；共享工作区记忆/技能/通用工具，不继承主会话上下文、不自动回传、不提取旁聊记忆、不提供任务管理工具；可派发 subagent，列表/停止/回报仅限发起旁聊，不回主会话。Harness 生命周期与每个聊天控制器分离；Telegram 仍只使用 root。见 [旁聊](docs/features/side-chats.md)。
- 助手拥有长期工作区，独立于源码仓库，位于后端机器；会话关联工作区。
- 用户技能采用工作区 `.agents/skills/<name>/SKILL.md`，内建技能同样只扫描单层目录，不递归、不跟随链接目录/技能文件；保留元数据校验与工作区同名覆盖。指导和技能索引通过 durable 资源 section 加载，上下文压缩由 durable 处理。`PIKO_HOME/skills` 不创建也不读取。
- 内建指导和技能随应用发布；用户指导、记忆和技能属于工作区。初始化不覆盖已有用户文件，升级不覆盖用户定制。
- 工作区保存三类长期内容：AGENTS.md 管助手身份、表达和做事约定，MEMORY.md 管用户资料、环境事实与长期结论，`memory/YYYY-MM-DD.md` 记录每日记忆（讨论、决定、进展与未完线索，不自动注入，按需 read/search）。主会话闲置后由后台记忆整理 增量维护两类记忆；应用内建 core 管运行规则与工具结果真实性。加载时标注角色和来源，角色不是权限隔离；细则见 [资源与工具](docs/features/workspace-and-main-chat.md#资源与工具)。
- Durable 原生 JSONL 是会话内容的唯一来源；UI 从所选 conversation 的完整原始 entries 投影，不能用压缩后的模型上下文代替展示历史。Piko 管理配置、通道与传输；执行状态、提交去重和 inbox 由 Durable 管理，不建立 Run 或身份表。

## 名称约定

- 产品称“任务”“后台工作”“执行记录/运行结果”，不以“事项”或“子 Agent”要求用户理解实现；代码保留 `subagent` 技术名。
- 业务类型为 `AssistantTask` / `AssistantTaskDraft`、`TaskSchedule` / `TaskExecution`，与 Durable 原生 `TaskId` / `TaskRecord` 区分；工具为 `task_*` 与 `subagent_*`，HTTP 为 `/api/tasks`，不保留旧入口别名。
- `runtime/subagents/runtime.ts` 承载两类工作共用执行，`subagents/queries.ts` 读取原生事实和校验归属；`subagents/tools.ts` / `tasks/tools.ts` 只提供工具入口，`tasks/service.ts` 管任务服务，`tasks/queries.ts` 按需读取摘要/单项回答。固定持久化 doc 身份、绑定字段与 `items/<id>` 目录不随业务符号改名，不新增兼容层或执行状态副本。

## 代码边界

- `apps/mobile/src/features/` 按功能组织 UI；页面 → Hook/API → HTTP/SSE。应用只有一个 features/shell/AppShell，抽屉动画完成控制挂载，不另用超时器猜测；访问过的聊天保留各自 ChatProvider/useChat、草稿/输入身份和滚动，不为每个聊天复制导航或键盘监听。
- 服务端路由 → 业务服务 → 运行时接口 → Pi 适配器。输入、停止、维护、完整归档和内部报告统一由 ConversationControl 接纳线协调；不得绕过父会话控制器直接回报。ConversationStore 只负责输出合并和观察，关闭观察不停止执行；runtime 唯一拥有控制器和 Harness 生命周期。通道回报提示独立于会话控制器，不重复维护锁或执行状态。Durable/pi-ai 类型、事件与配置细节集中在 `server/runtime/`；`shared/runtime.ts` 只保留普通跨端类型。
- `shared/` 保存跨端契约，不依赖 React Native、Bun 或 Pi SDK。
- RN 请求身份使用 UUID，原生实体 ID 由 Durable 分配并按不透明字符串跨端传输，Unix 毫秒数用于时间；首次使用时才建立新领域模块，不提前搭空目录或通用框架。
- 当前助手启用 Pi 的 read、write、edit、bash 四个内建工具及内置 web_search/web_extract；文件/命令工具以后端进程的本机权限运行，默认工作目录为助手工作区。网络业务逻辑在 server/tools，SDK 注册在 server/runtime/web-tools.ts；搜索凭据由后端环境配置，不进入模型参数或客户端，见 [内置网络工具](docs/features/web-tools.md)。后续业务专用工具和访问边界按需求接入；文件范围和权限限制需由运行时实现，不能仅靠提示词或设置 cwd。
- 显式指定 Piko 资源范围，避免自动继承个人 Pi CLI 的全局技能、扩展或祖先目录指导。
- 应用/Agent 行为统一使用 PIKO_HOME/config/piko.json，模型目录、适配参数与供应商凭据使用 models.json 和 auth.json（均为 Pi 格式）；不生成或读取 settings.json，不留双入口。重试与自动压缩直接使用 Durable 默认策略，不在产品配置暴露覆盖。模型供应商凭据只认这两个 JSON：auth.json 优先，其次 models.json 的 provider apiKey，不回退环境变量；通道与工具凭据只从后端环境/私有 config/.env 读取。Durable Extension 只由 Piko 源码注册，不加载用户代码插件；配置修改后重启后端生效。配置与运行时说明见 [Durable 配置](docs/features/durable-runtime.md)。
- Piko 配置通过 server/config.ts 统一加载并严格按字段分工：piko.json 的 agent 管模型预设和可选 stream，channels/tools 管通道与工具行为，models.json 管模型目录与供应商 apiKey，auth.json 管模型凭据；env 管 HTTP/工作区部署参数、通道与工具凭据。不提供 env 覆盖 JSON 的双入口，放错位置或使用已移除的行为变量应报错。只有环境体系内部 config/.env < 进程环境；PIKO_HOME 仅从进程环境定位。模型与工具复用配置层，使用处不各自读取 PIKO_*。变更后重启，见 [应用配置](docs/features/application-config.md)。
- 保留提交去重、停止、流快照、断线恢复语义；断开观察者不等于取消任务，重启后不自动重放不确定执行。HTTP 不开放闲置 runtime 管理或独立 submission 查询入口；模型选择、压缩与原生回执仍供 TG/内部接纳使用。TG 流式富文本是关键体验，不因减代码改为纯文本流或仅终态富文本。
- 工作区指导、技能索引、Pi 上下文持久化和 read、write、edit、bash 四个内建工具已启用；支持读取技能正文、创建技能文件和运行脚本，个人 CLI 的全局扩展仍不自动加载。
- 不建立第二套消息正文或永久流事件存储。Piko 不使用 SQLite；一个 PIKO_HOME 固定 state/durable 与一个 Harness/root，必要的停止去重与中断提示复用原生 doc；流式文字与输出合并保存在内存中；SSE 每次连接通过最新快照恢复，不维护事件游标或重放缓存，重启后不承诺恢复尚未由 Pi 保存的片段。

## 修改与验证

- 保留用户现有改动；未经请求不改变键盘、滚动、布局等已确认交互。
- 使用 Bun，维护根目录和客户端各自的依赖与锁文件；依赖版本以 package.json / 锁文件为准。
- Android / iOS 工程由 Expo 生成且已忽略，原生配置通过 `app.json` 或配置插件保存；不提交构建产物、本机路径、凭据和用户工作区内容。
- 动效使用 Reanimated；现有 OpenMuse 素材与 UI 授权保留在 `THIRD_PARTY_NOTICES.md`。按钮和行交互优先复用 `TactilePressable`、`IconButton`、`TextButton`，重命名等单行文本输入复用 `TextInputDialog`（已有 Modal 可用 `TextInputDialogContent`），按 [交互与视觉规范](docs/INTERACTION.md) 处理悬停、按压、焦点、选中和禁用状态。
- 代码改动按影响运行 `bun run typecheck`；涉及打包再做对应平台导出。仓库不保留测试套件，关键状态、持久化、路径边界和恢复行为以真实运行或临时脚本人工验证，并在文档中说明验证状态。
- 文档改动检查链接、命令和实现状态即可；原生键盘、网络和后台行为需要设备验证，未验证的范围明确说明。
- 四个页签均已启用：Chat 与 Tasks 可用，Posts 展示空状态（无发布数据源），Artifacts 仅标题占位；不在正式页面放模拟帖子。
