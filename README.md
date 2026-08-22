[English](README.en.md) | 中文

# dsh-kit

面向 DeepSeek Harness (dsh) 的**页面能力套件插件**：给 DSH 的浏览器界面加装可选能力，
每个能力独立、互不依赖；全部不用时 DSH 退化为原版。

## 当前能力

### 终端（terminal）

VSCode 风格的页内终端：

- 侧边栏底部的终端开关 `>_` 或快捷键 **Ctrl+`** 打开/关闭底部终端面板
- 终端自动打开在**当前会话的工作区目录**（会话 cwd，无会话时退回最近工作区路径）
- Windows 优先 pwsh（PowerShell 7+），退回 powershell.exe；面板内可一键重启
- 面板关闭 / 页面刷新即结束对应 shell 进程（不留孤儿进程）

### 文件树（file tree）

侧边栏底部的文件树开关（设置齿轮旁）：

- 面板复用侧边栏浏览区，以**当前会话的工作区目录**为根浏览文件
- 目录懒加载逐级展开；**点击文件 → 右侧停靠面板预览文件内容（默认直接开满宽度，
  对话左移让位，左侧边缘可拖动调宽/调窄，类似 GitHub 的文件视图）**；
  头部带"复制路径"按钮
- 数据走插件宿主的只读端点 `/dsh-kit/tree`（目录列表）与 `/dsh-kit/read`（文件内容，
  512 KB 限长 + 二进制探测；均同源校验；webserver 仅 loopback 可达）

### 技能管理（skill pool）

设置面板新增"技能管理"页，把分散的技能收进一个可操作的界面：

- 分组列出：**工作区**（`<项目>/.agents/skills`、`.dsh/skills`）、**用户级**
  （`$DSH_HOME/skills`、`~/.agents/skills`）、**技能池**（`$DSH_HOME/skill-pool`，
  不挂扫描根、DSH 不扫描，纯流通货架）；插件自带/运行时来源的技能以只读方式
  列在"其他来源"，归属（provider/source）照实标注
- 四个操作：**复制到 / 移动到**（任意根之间转移，同名冲突先确认再覆盖）、
  **删除**（移入池内 `.trash/` 回收区，不直删）、**禁用/启用**（改 SKILL.md
  frontmatter 的 `disable-model-invocation` + `user-invocable` 双键——注册表
  原生机制，chokidar 热生效免重启；插件自带的技能无文件可改，操作置灰）
- 点开任意技能可直接查看正文；数据走宿主端点 `/dsh-kit/skills`（枚举）与
  `/dsh-kit/skills/op`（操作），全部经白名单路径校验 + 同源校验

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

本包声明了 `dsh.bundle.patch`，因此会被激活为 profile 的 bundle 层(而不是仅仅装成
一个不生效的普通依赖)。安装后重启 `dsh web`,侧边栏底部出现终端与文件树开关。

### 本地开发安装

```bash
# 本地开发安装:把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## 工作原理

- `src/index.js`:宿主半边——挂四个端点:`/dsh-kit/terminal` WS 端点
  (`registerUpgrade`,升级前校验 Origin 同源;每条连接 = 一个 node-pty 会话,
  JSON 文本帧协议,见文件头注释)、`/dsh-kit/vendor/*` 静态资源(xterm 官方
  预编译 UMD)、`/dsh-kit/tree?path=…` 只读单层目录列表(官方 browse RPC 只列
  目录不列文件,文件树走这里)、`/dsh-kit/read?path=…` 只读单文件文本内容
  (512 KB 限长 + 二进制探测)。
- `src/skill-pool.js`:技能管理宿主半边——`GET /dsh-kit/skills` 枚举白名单根
  (池/用户级/项目级)下的技能并附注册表归属增强,`POST /dsh-kit/skills/op`
  执行复制/移动/删除(入池回收区)/禁用(frontmatter 双键);源必须是根直接子项、
  全路径 realpath 后做包含校验。
- `client/bundle.js`:浏览器半边(手写 ModuleLoader 格式 client bundle,无构建)——
  在 `sidebar.footer.action` 槽位注册终端/文件树两个开关:终端底部停靠面板
  (首次打开按需加载 vendor xterm);文件树临时接管 `sidebar.workspaces` 单槽,
  点击文件后自绘右侧停靠面板预览内容——挂 `body.dshk-pane-open` 类 + `--dshk-pane-w`
  变量,用 CSS 让中列(对话)右移让位(不依赖原生 details 列/ctx.layout,
  因其 openDetails 固定 360 且 setDetails 对动态插件不可达);另在
  `settings.section` 槽位注册"技能管理"整页。
- `cordis.patch.yml`:把 `dsh-kit` 插件行 insert 进 bundle 层。
- 宿主侧 `node-pty`/`ws` 不声明依赖:运行时从 profile fallback node_modules 解析。

## 环境要求

- Node.js ≥ 22(dsh 自身要求)
- 纯 ESM、零依赖声明、零构建

## 许可证

MIT
