# Piko React Native 客户端

`apps/mobile` 是 Piko 的唯一前端，使用 Expo SDK 57 和 React Native，支持 Web / iOS / Android。Pi SDK、模型配置和凭据由根目录的 Bun 服务端管理。

## 安装和启动

从仓库根目录执行：

```powershell
bun install
bun install --cwd apps/mobile
```

从仓库根目录，一条命令启动 API 和 Expo：

```powershell
bun run dev
```

```powershell
# Web
bun run dev:web

# 或 Android Emulator
bun run dev:android
```

这些命令自动配置本地 Web 的 CORS，等待 API 就绪后启动 Expo；按 `Ctrl+C` 关闭两个服务，一个服务退出时另一个也会关闭。Web 在 `http://localhost:8081` 打开。Android 需先启动 Emulator，并安装兼容 SDK 57 的 Expo Go 或开发客户端。同时测试两端时，运行 `bun run dev:web` 后按 `a`，复用同一个 Expo 进程；不要同时启动两个使用 8081 的进程。运行 `bun run dev` 后可按 `w` 打开 Web、按 `a` 使用 Android Emulator；在 macOS 上按 `i` 使用 iOS Simulator。

需要分开启动时，在终端 1 设置 `$env:PIKO_CORS_ORIGINS = "http://localhost:8081,http://127.0.0.1:8081"` 并运行 `bun run dev:api`，在终端 2 运行 `bun run dev:mobile`（仅 Expo）。

Android Emulator 默认访问 `http://10.0.2.2:8787`，Web / iOS Simulator 默认访问 `http://127.0.0.1:8787`。使用其他 Web 地址或端口时，通过 `PIKO_CORS_ORIGINS` 加入其准确的 Origin 并重启 API。实体设备需通过 `EXPO_PUBLIC_PIKO_API_URL` 指向有身份验证和访问限制的服务端地址。API 当前只监听本机且无登录验证，不要直接暴露到不可信网络。

依赖由 Bun 管理，客户端锁文件为 `apps/mobile/bun.lock`。`uuid` override 用于 Expo 的嵌套 `xcode` 构建依赖。

## 首页和 Tab

首页参考 OpenMuse 的 RN 组件，包括居中的水豚头像、近白背景、快捷提示、浅蓝/浅灰消息气泡、胶囊输入框和五项底部导航。Chat 具有灰色选中背景，其余 Tab 在对应功能实现前保持禁用。菜单、通知和附件也是禁用占位。

`App.tsx` 只负责应用初始化；`src/components/AppShell.tsx` 管理头像、顶部和底部导航；`src/theme.ts` 定义颜色。聊天页面、输入框、状态 Hook 和 API 位于 `src/features/chat/`。通用 HTTP 客户端位于 `src/api/client.ts`，消息契约和 SSE parser 分别位于根目录 `shared/chat.ts` 与 `shared/sse.ts`。

后续页面按功能放进 `src/features/`，领域状态由服务端管理；模块边界与下一步实施顺序见 [架构说明](../../docs/ARCHITECTURE.md)。

## 检查和导出

从仓库根目录执行：

```powershell
bun run typecheck:mobile
bun run build:android
bun run build:ios
bun run build:web
```

`build:web` 导出 HTML、JavaScript 和静态资源；iOS / Android 导出的是 JavaScript / Hermes bundle。生成签名的原生安装包仍需 Android / Xcode 工具链或 EAS Build。
