[English](README.en.md) | 中文

# dsh-kit

面向 DeepSeek Harness (dsh) 的**页面能力套件插件**：给 DSH 的浏览器界面加装可选能力，
每个能力独立、互不依赖；全部不用时 DSH 退化为原版。

## 当前能力

### 终端（terminal）

输入框工具行的终端开关或快捷键 **Ctrl+/** 显示/隐藏底部**终端坞（多标签）**：

- **多终端标签**：坞头部 ＋ 新建终端，绑定按下那一刻的当前会话工作区（之后切换
  会话不影响已开的终端）；同工作区多开自动加序号区分
- 入口按钮与快捷键只**开关坞的显示**——隐藏时后台 shell 继续运行、输出继续缓冲；
  每个标签 ✕ 结束对应会话，入口图标角标显示存活终端数；页面刷新结束全部
  （不留孤儿进程）
- Windows 优先 pwsh（PowerShell 7+），退回 powershell.exe

### 文件树（file tree）

输入框工具行的文件树开关：

- 面板复用侧边栏浏览区，以**当前会话的工作区目录**为根浏览文件，目录懒加载逐级展开
- **文件管理**：头栏 ＋📄/＋📁 在当前目录新建文件/文件夹；行悬停操作——目录行
  新建文件/文件夹、任意行复制路径（双矩形图标=**绝对路径**、带省略点图标=
  **相对路径**，相对以当前工作区为根）、✎ 行内重命名（自动选中主名保留扩展名，
  Enter 提交、Esc 取消）与 🗑 删除（删除移入**回收站**，二次确认防误触）
- 点击文件 → 右侧停靠面板预览/编辑内容：对话列自动让位，左缘拖动调宽/调窄；
  ✎ 进编辑态（草稿保存，mtime CAS 冲突时询问重载，截断预览不可编辑），✕ 关闭返回；
  ⇄ 可切到 diff 着色视图
- 数据走插件宿主端点 `/dsh-kit/tree`（目录列表）、`/dsh-kit/read`（文件内容，
  512 KB 限长 + 文本解码）、`/dsh-kit/write`（编辑保存：cwd 子树校验 +
  mtime CAS 防并发覆盖）与 `/dsh-kit/fs/op`（新建/重命名/删除：目标必须位于
  cwd 子树内，名称白名单校验；均同源校验；webserver 仅 loopback 可达）
- **文本解码**（`/dsh-kit/read`，与 txt 同一条路径）：BOM 优先——UTF-8 /
  UTF-16 LE / UTF-16 BE 按对应编码解码；无 BOM 且首 4KB 无 NUL 按 UTF-8 读。
  含 NUL 的文件按扩展名判定——**ini / cfg / conf / cnf / properties / reg** 等
  配置类扩展名会尝试 UTF-16LE/BE 双向评分恢复（Windows 记事本"Unicode"存法
  的实测问题）；log / json / toml / yml 等几十种文本扩展名同理；`.gitignore`
  这类点文件按完整基名匹配。判定不出文本的才按二进制

### 源代码管理（source control）

输入框工具行的源代码管理开关（默认 **Ctrl+Alt+.**——避开中文输入法占用的
Ctrl+. 中英标点切换），页内 git 工作台：

- 与文件树共用侧边栏浏览位（二选一打开）；改动列表在可见期间**静默自动刷新**
  ——AI 的改动无闪动实时出现
- 分组显示**暂存的更改 / 更改**（未跟踪文件标 `U`），组头可折叠；每行含名称、
  目录提示、`+N −N` 行数统计与状态徽标
- 行悬停操作：**暂存 ＋ / 取消暂存 － / 放弃 ↩**（放弃为破坏性操作，二次确认）；
  顶部提交框提交已暂存内容，暂存区为空时提供「提交全部」（先 `add -A` 再
  commit），Enter 直提
- 点击文件进右侧停靠面板看 **diff 视图**（默认）：完整文件着色渲染（删除红 /
  新增绿，非原始补丁），超大文件回退原始 diff；头部 **⇄** 可随时切到原文视图
  ——两个入口共用同一预览面板（入口只决定默认视图），✎ 编辑两侧都可用
- 非 git 目录一键**初始化仓库**（幂等）；中文等非 ASCII 文件名完整支持
  （`core.quotePath=false`）
- 数据走宿主端点 `/dsh-kit/git/status`、`/dsh-kit/git/diff`、`/dsh-kit/git/init`
  与 `/dsh-kit/git/op`（stage/unstage/discard/stageAll/commit；直接 spawn git CLI
  不引库，全部同源校验）

### 后台任务（background jobs）

输入框工具行的后台任务开关（位于源代码管理与终端之间），图标带运行中任务数角标：

- 点开**居中模态**列出当前会话运行中的后台任务（只列进行中，任务源是官方
  `session/jobs` 推送自动更新；官方任务下拉只读展示，本面板补上操作）
- 每行：任务种类徽标 + 命令 + 状态 · 已运行时长；**「输出」**展开实时增量
  （与模型 `job_output` 共享读取游标）、**「结束」**终止任务（等同
  `job_kill`，权限按会话隔离，跨会话自动拒绝）
- ✕ 按钮 / 点击遮罩 / Esc 均可关闭；任务结束即从列表消失（只列进行中）
- 操作走宿主端点 `/dsh-kit/jobs/kill`（POST）与 `/dsh-kit/jobs/output`（GET
  增量读），列表本身来自官方 `session/jobs` 推送、无额外轮询

### 技能管理（skill pool）

设置面板新增"技能管理"页，把分散的技能收进一个可操作的界面：

- **三组显示**：**工作区**（`<项目>/.agents/skills` 与 `.dsh/skills` 两根聚合）、
  **用户级**（`$DSH_HOME/skills`、`~/.agents/skills`）、**技能池**
  （`$DSH_HOME/skill-pool`，不挂扫描根、DSH 不扫描，纯流通货架）；
  插件自带/运行时来源的技能以只读方式列在"其他来源"，归属（provider/source）
  照实标注
- 每个技能一行：名称 + 优先级徽标（如 `(200)`；组头以
  `.dsh/skills(100) | .agents/skills(200)` 形式标明各根及其扫描优先级，
  数值越小越优先）+ 描述（截断悬停看全文）+ 全部操作；
- 操作：**复制 / 移动**（点击后行下展开目标位置选择条，点选即执行；同名冲突先
  确认再覆盖）、**删除**（直接删除，两步确认防误触）、**禁用/启用**（改 SKILL.md
  frontmatter 的 `disable-model-invocation` + `user-invocable` 双键——注册表原生
  机制，chokidar 热生效免重启；池内技能不提供禁用——池本就不被扫描；插件自带
  的技能无文件可改，操作置灰）
- **优先级可视化**：DSH 同名技能按扫描根 rank 取胜（`.dsh`(100) > `.agents`(200)
  > `$DSH_HOME`(400) > `~/.agents`(500)），被覆盖者打"被覆盖"虚线徽标并悬浮说明
- 点开任意技能可直接查看详情内容；数据走宿主端点 `/dsh-kit/skills`（枚举）与
  `/dsh-kit/skills/op`（操作），全部经白名单路径校验 + 同源校验
- 设置导航里"技能"使用自绘分层图标（官方 navIcon 按 id 硬编码映射、未知 id 一律
  齿轮，这里按标签文字做纯外观替换，失败静默回退）

### 手机访问（phone access）

设置面板新增「手机访问」页，用手机浏览器扫码即可连上电脑上的 dsh web：

- **链接令牌鉴权**：插件自带网关（默认端口 3090）监听 0.0.0.0，`?k=<令牌>` →
  HttpOnly Cookie → 302 到 GUI；无/错令牌一律 404，Cookie 过期即失效
- **一次一证**：每次「关闭 → 开启」网关自动轮换令牌生成新链接，旧链接与已存设备
  即时失效；按状态文件恢复启动、保持开启时再点均不轮换
- 局域网与远程双通道：本地每个 IPv4 一条 `http://<ip>:3090/?k=…`，配置远程域名后
  附 `https://<域名>/?k=…`（配 frp + caddy 模板，见 `scripts/vps/`），扫码即开
- **HTTP/WS 全量透传**：Host 重写回环上游、剥 Origin、网关 Cookie 不外泄；终端
  WebSocket 隧道双向可达（远程用手机也能连终端）
- 安全边界：令牌等于本机完整权限（仅限本人）；远程隧道 TLS 加密；关闭网关链接即
  不可达、再开换新证
- 网关令牌/启停持久化在 `data/dsh-kit-phone-gateway.json`，不侵入 settings

### 网页搜索（web search）

自 [dsh-free-search](https://github.com/zhouzhencheng07/dsh-free-search)
v0.2.0 并入的宿主侧能力（该仓库停留在 v0.2.0，不再单独演进）：

- 向 DSH 的 web seam 注册 **free-search** 免费搜索源，替换 base 层钉死的
  `deepseek-official`（后者每次搜索消耗一次付费 DeepSeek 模型调用）
- 免 key 引擎链按优先级自动故障转移：**Tavily**（免 key，设了 `TAVILY_API_KEY`
  则走带 key 配额）→ **Sogou**（通用兜底），另有 **GitHub / arXiv /
  StackExchange / Hacker News** 四个领域引擎在查询强信号时优先参与——全部免配置
- AI 的 `web_search` 工具照常产出原生引用卡片（`sources[]` 原样渲染）
- 设置卡「启用网页搜索」开关：开=免费引擎链，关=走官方默认渠道
  （`deepseek-official`）；变更重启后生效。后续 profile patch 也可把
  `searchProvider` 钉回任意源

### 设置卡（settings）

官方设置页「插件配置」里的 dsh-kit 卡片（命名空间 `dsh-kit`）：

- 功能开关：终端 / 文件树 / 源代码管理 / **后台任务** / 技能页 / 网页搜索 /
  **侧边栏快捷键组** / **手机访问页**，各自独立——关闭即隐藏对应入口按钮并失效
  快捷键，已打开的视图立即归位；「技能页」/「手机访问页」关闭后设置导航不再显示
  对应页面（能力本身不受影响）
- 快捷键自定义：终端 **Ctrl+/**、文件树 **Ctrl+,**、源代码管理 **Ctrl+Alt+.**
  （原 Ctrl+. 会被中文输入法的中英标点切换截获，故改默认）、侧边栏 **Ctrl+B**——
  点「修改」进入录制态，下一个组合键即为新键（Esc 取消）
- 开关启用才展开其子配置项（所见即所得）；键被用户层覆盖时标「已覆盖」，可一键
  恢复默认
- 草稿模型照官方 CardForm 规范：编辑只暂存草稿、保存才写入，写后回读校验落盘；
  只读部署给出提示
- 「网页搜索」由宿主半边消费（其余开关均在浏览器端门控）：关闭时 `web_search`
  走官方默认渠道；此开关变更重启后生效

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

本包声明了 `dsh.bundle.patch`，因此会被激活为 profile 的 bundle 层(而不是仅仅装成
一个不生效的普通依赖)。安装后重启 `dsh web`,输入框工具行出现文件树 / 源代码管理 /
后台任务 / 终端四个开关,AI 的 `web_search` 同时切到免费多源搜索。

### 本地开发安装

```bash
# 本地开发安装:把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## 工作原理

- `src/index.js`:宿主半边——挂端点:`/dsh-kit/terminal` WS 端点
  (`registerUpgrade`,升级前校验 Origin 同源;每条连接 = 一个 node-pty 会话,
  JSON 文本帧协议,见文件头注释)、`/dsh-kit/vendor/*` 静态资源(xterm 官方
  预编译 UMD)、`/dsh-kit/tree?path=…` 只读单层目录列表(官方 browse RPC 只列
  目录不列文件,文件树走这里)、`/dsh-kit/read?path=…` 只读单文件文本内容
  (512 KB 限长 + text-decode.js 文本解码:BOM 优先、无 BOM 含 NUL 时文本类
  扩展名按 UTF-16LE/BE 恢复)、`/dsh-kit/write` 编辑保存(cwd 子树校验 +
  mtime CAS)与 `/dsh-kit/fs/op` 文件管理(新建/重命名/删除;目标限 cwd 子树,
  删除在 Windows 上移入回收站)、`/dsh-kit/jobs/kill`(POST 结束后台任务)与
  `/dsh-kit/jobs/output`(GET 增量读输出)——caller 对齐官方 job_kill/job_output
  权限语义,另有手机访问的 info/link/gateway 端点(实现见 phone-gateway.js)。
- `src/skill-pool.js`:技能管理宿主半边——`GET /dsh-kit/skills` 枚举白名单根
  (池/用户级/项目级)下的技能并附注册表归属增强,`POST /dsh-kit/skills/op`
  执行复制/移动/删除(入池回收区)/禁用(frontmatter 双键);源必须是根直接子项、
  全路径 realpath 后做包含校验。
- `src/phone-gateway.js`:手机访问网关——独立端口(默认 3090,0.0.0.0)的
  HTTP/WS 反代,`?k=` 令牌 → HttpOnly Cookie → 302 回环上游;未授权 404、
  Host 重写回环、剥 Origin、网关 Cookie 不外泄;`rotate()`(关→开自动轮换)
  与状态文件(`data/dsh-kit-phone-gateway.json`)持久化启停与令牌。
- `client/bundle.js`:浏览器半边(手写 ModuleLoader 格式 client bundle,无构建)——
  在 `conversation.input.left` 槽位注册文件树 / 源代码管理 / 后台任务 / 终端
  四个开关;文件树与源代码管理共用 `sidebar.workspaces` 单槽,点击文件后自绘右侧
  停靠面板预览/编辑/diff——挂 `body.dshk-pane-open` 类 + `--dshk-pane-w` 变量,
  用 CSS 让中列(对话)让位(不依赖原生 details 列/ctx.layout,因其 openDetails
  固定 360 且 setDetails 对动态插件不可达);后台任务面板(运行中任务列表 +
  输出/结束操作)与终端坞在 `shell.overlay` 渲染;另在 `settings.section` 槽位注册
  "技能管理"/"手机访问"两个整页、在 `settings.plugin.item` 注册插件设置卡。
- `src/web-search.js` + `src/engine-chain.js` + `src/engines/*`:网页搜索宿主
  半边(自 dsh-free-search v0.2.0 原样并入)——向 web seam 注册 `free-search`
  provider,受设置卡 `searchEnabled` 门控(启动期定夺:开=引擎链,关=同 id
  转发官方渠道);引擎链按优先级自动故障转移,领域引擎(GitHub/arXiv/
  StackExchange/HN)查询强信号时才参与。
- `cordis.patch.yml`:把 `dsh-kit` 插件行 insert 进 bundle 层,并把 web 行的
  `searchProvider` 由 base 层钉死的 `deepseek-official` 改为 `free-search`
  (后续 profile patch 可再钉回任意源)。
- 宿主侧 `node-pty`/`ws` 不声明依赖:运行时从 profile fallback node_modules 解析。

## 环境要求

- Node.js ≥ 22(dsh 自身要求)
- 纯 ESM、零依赖声明、零构建

## 许可证

MIT
