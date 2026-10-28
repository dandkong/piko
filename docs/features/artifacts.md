# 产物浏览

状态：Artifacts 页浏览工作区 `artifacts/`，提供 Markdown/文本预览、文件下载和带确认的文件/文件夹删除；不包含任务执行目录。

## 浏览与交互

- 根目录是当前 Piko 工作区下的 `artifacts/`，部署工作区路径以 `PIKO_WORKSPACE` 为准。
- 文件夹和文件按名称排序，文件夹优先；目录导航显示可点击面包屑，支持任意嵌套深度。
- 隐藏名称（以 `.` 开头）、符号链接和非普通文件不展示。
- 文件行点击进入预览面板；右侧三点菜单提供下载和删除。文件夹菜单只提供删除，不打包下载文件夹。
- 删除必须通过统一确认弹窗。删除文件会永久移除该文件；删除文件夹会递归移除该文件夹的全部内容。确认期间不允许点遮罩、Escape 或系统返回关闭，需明确按“取消”或确认。
- 预览面板使用与设置页共用的上浮 `FloatingPanel`，可点关闭按钮或遮罩关闭，不提供下载操作。长文预览显示滚动指示器：Web 使用细窄的弱化灰色滚动条，原生端使用系统指示器；其他浮层默认隐藏滚动条。下载统一从列表菜单发起。
- 操作只作用于 `artifacts/`，不提供创建、重命名或移动；任务执行目录 `workspace/tasks/<id>/` 不自动并入。

## 内置预览

- `.md`、`.markdown` 使用 Markdown 渲染。
- 常见文本和代码扩展名按白名单作为普通文本显示，包括 `.txt`、`.text`、`.log`、`.json`、`.jsonl`、`.ndjson`、`.csv`、`.tsv`、`.yaml`、`.yml`、`.toml`、`.xml`、`.ini`、`.conf`、`.properties`，以及常见 JS/TS、Python、Shell、CSS/HTML、SQL、Go、Rust、Java、C/C++、C#、PHP、Ruby、Swift、Kotlin、Vue、Svelte 和 SVG 源文件扩展名。
- 除 Markdown 外，不按文件内容做格式校验，不解析 JSON，不格式化、缩进或语法高亮；只按扩展名决定是否作为文本预览。文本按 UTF-8 解码，无法识别的字节以替换字符显示。HTML/SVG 也只作为文本显示，不执行。
- 单文件内置文本预览上限 1 MiB。更大文件显示下载提示，不静默截断。

## HTTP

- `GET /api/artifacts?path=<相对路径>`：列出 `workspace/artifacts/` 根目录或指定子目录。
- `GET /api/artifacts/content?path=<相对路径>`：读取允许预览的文本文件。
- `GET /api/artifacts/download?path=<相对路径>`：返回带 `Content-Disposition: attachment` 的文件响应。
- `DELETE /api/artifacts?path=<相对路径>`：删除指定文件或目录；不能删除 Artifacts 根目录。

文件路径始终相对 `artifacts/` 根目录；服务拒绝绝对路径、`.` / `..`、隐藏路径与符号链接，并验证解析后的真实路径仍位于根目录内。HTTP 接口仍依赖受信网络或部署代理的访问控制，Piko 本身没有内置登录认证。

## 不在首版范围

- 任务执行输出的聚合、创建、重命名、移动。
- PDF、Office、压缩文件等内置查看器；不支持的格式只能下载，后续由用户自行处理。
- 外部“用其他应用打开”操作。
- 移动端真机的文件下载行为尚未验收。
