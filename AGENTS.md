# Piko 编码指导

## 项目与文档

Piko 是本地优先的个人助理。前端为 Expo / React Native，后端为 Bun，pi-durable 是唯一 Agent 运行时，模型适配使用 pi-ai。

当前处于开发期，架构可随需求随时调整，无需考虑旧版本兼容、历史数据迁移或为此保留过渡实现。

- 启动、环境与检查命令见 [README](README.md)。
- 产品体验与范围见 [产品约定](docs/PRODUCT.md)。
- 依赖方向、工作区与领域模型见 [架构约定](docs/ARCHITECTURE.md)。
- 当前进度与开发顺序见 [路线图](ROADMAP.md)。
- 具体功能方案放在 `docs/features/`；已实现基线见 [工作区与主会话模型](docs/features/workspace-and-main-chat.md)。
- RN 与 Telegram 双通道已接入，共用主会话；支持范围与配置见 [通道说明](docs/features/telegram-channel.md)，复杂能力单独讨论。

文档明确区分已实现、已确定但未实现、待设计。修改行为时同步对应文档；不要将方案写成现有能力。本文件指导仓库开发，不是运行中 Piko 助手的工作区 `AGENTS.md`。

## 已确定的方向

- 主会话是默认且持续的交流入口；不先建设传统多会话切换界面。
- 后台子 Agent 已接入同一 Harness 的 owned conversation：共用配置、工作区资源和工具，仅移除嵌套委派；一次任务新建一个持久化子会话，不 fork 主聊天历史，额外背景写入委派任务；可信内部 follow-up 回传，不增加展示；普通停止保留后台工作，重启中断不确定执行，仅恢复已完成结果的回传。见 [后台子 Agent](docs/features/background-subagents.md)。
- side chat 后续复用同一 Harness 的原生 conversation 与关系，交互、上下文共享和结论回传仍待设计。
- 助手拥有长期工作区，独立于源码仓库，位于后端机器；会话关联工作区。
- 用户技能采用 `.agents/skills/<name>/SKILL.md`，也可放在 `PIKO_HOME/skills`；指导和技能索引通过 durable 资源 section 加载，上下文压缩由 durable 处理。
- 内建指导和技能随应用发布；用户指导、记忆和技能属于工作区。初始化不覆盖已有用户文件，升级不覆盖用户定制。
- 工作区只保留 AGENTS.md 与 MEMORY.md：AGENTS 管助手身份、表达和做事约定，MEMORY 管用户资料、环境事实与长期结论；应用内建 core 管运行规则与工具结果真实性。加载时标注角色和来源，角色不是权限隔离；细则见 [资源与工具](docs/features/workspace-and-main-chat.md#资源与工具)。
- Durable 原生 JSONL 是会话内容的唯一来源；UI 从所选 conversation 的完整原始 entries 投影，不能用压缩后的模型上下文代替展示历史。Piko 管理配置、通道与传输；执行状态、提交去重和 inbox 由 Durable 管理，不建立 Run 或身份表。

## 代码边界

- `apps/mobile/src/features/` 按功能组织 UI；页面 → Hook/API → HTTP/SSE。
- 服务端路由 → 业务服务 → 运行时接口 → Pi 适配器。Durable/pi-ai 类型、事件与配置细节集中在 `server/runtime/`；`shared/runtime.ts` 只保留普通跨端类型。
- `shared/` 保存跨端契约，不依赖 React Native、Bun 或 Pi SDK。
- RN 请求身份使用 UUID，原生实体 ID 由 Durable 分配并按不透明字符串跨端传输，Unix 毫秒数用于时间；首次使用时才建立新领域模块，不提前搭空目录或通用框架。
- 当前助手启用 Pi 的 read、write、edit、bash 四个内建工具，以后端进程的本机权限运行，默认工作目录为助手工作区。后续业务专用工具和访问边界按需求接入；文件范围和权限限制需由运行时实现，不能仅靠提示词或设置 cwd。
- 显式指定 Piko 资源范围，避免自动继承个人 Pi CLI 的全局技能、扩展或祖先目录指导。
- 模型和凭据使用 `PIKO_HOME/config/{settings,models,auth}.json`，不读取个人 Pi CLI profile。插件从 `PIKO_HOME/extensions` 加载 durable Extension，配置及插件代码修改后重启后端生效；运行中不切换配置。配置及插件用法见 [Durable 配置](docs/features/durable-runtime.md)。
- Piko 应用配置通过 `server/config.ts` 统一加载 HTTP、工作区与通道；env 只做字段映射与类型转换，默认值 < `config/piko.json` < `config/.env` < 进程环境，合并后共用一套校验，使用处不自行读取 `PIKO_*`。`PIKO_HOME` 仅从进程环境定位目录；模型保持独立文件并复用通用 env 读取，应用配置修改后重启。见 [应用配置](docs/features/application-config.md)。
- 保留提交去重、停止、流快照、断线恢复语义；断开观察者不等于取消任务，重启后不自动重放不确定执行。
- 工作区指导、技能索引、Pi 上下文持久化和 read、write、edit、bash 四个内建工具已启用；支持读取技能正文、创建技能文件和运行脚本，个人 CLI 的全局扩展仍不自动加载。
- 不建立第二套消息正文或永久流事件存储。Piko 不使用 SQLite；一个 PIKO_HOME 固定 state/durable 与一个 Harness/root，必要的停止去重与中断提示复用原生 doc；流式文字与 SSE 重放缓存在内存中，重启后不承诺恢复尚未由 Pi 保存的片段。

## 修改与验证

- 保留用户现有改动；未经请求不改变键盘、滚动、布局等已确认交互。
- 使用 Bun，维护根目录和客户端各自的依赖与锁文件；依赖版本以 package.json / 锁文件为准。
- Android / iOS 工程由 Expo 生成且已忽略，原生配置通过 `app.json` 或配置插件保存；不提交构建产物、本机路径、凭据和用户工作区内容。
- 动效使用 Reanimated；现有 OpenMuse 素材与 UI 授权保留在 `THIRD_PARTY_NOTICES.md`。
- 代码改动按影响运行 `bun run typecheck`、`bun run test`；涉及打包再做对应平台导出。关键状态、持久化、路径边界和恢复行为需要有意义的自动化验证。
- 文档改动检查链接、命令和实现状态即可；原生键盘、网络和后台行为需要设备验证，未验证的范围明确说明。
- 非 Chat 导航和其他占位入口在功能可用前保持禁用。
