[English](README.en.md) | 中文

# dsh-kit

面向 DeepSeek Harness (dsh) 的**页面能力套件插件**：给 DSH 的浏览器界面加装可选能力，
每个能力独立、互不依赖；全部关闭时 DSH 保持原版。

## 功能

- **终端**（工具行开关 / **Ctrl+/**）：底部多标签终端坞，绑定开启时所在会话的工作区，
  隐藏时后台 shell 继续运行；Windows 优先 pwsh
- **文件树**（工具行开关）：以会话工作区为根浏览文件，支持新建/重命名/删除
  （回收站）/复制路径；点文件右侧停靠预览/编辑（mtime CAS 防覆盖）/ diff 着色，
  md 代码块一键复制
- **源代码管理**（工具行开关，默认 **Ctrl+Alt+.**）：页内 git 工作台——暂存/取消暂存/
  放弃/提交、diff 视图、分支切换与新建删除、一键 push、提交图谱；非 git 目录可一键初始化
- **后台任务**（工具行开关）：右侧停靠面板列出会话运行中的后台任务，可查看输出、
  结束任务（等同官方 `job_output`/`job_kill`）
- **技能管理**（设置面板新页）：工作区/用户级/技能池三组展示，支持复制、移动、删除、
  禁用/启用；被同名技能覆盖者打虚线徽标
- **手机访问**（设置面板新页）：手机扫码连上本机 dsh web——令牌鉴权网关（默认端口
  3090，可改），默认每次启动关闭；局域网与远程双通道，HTTP/WS 全量透传
- **网页搜索**（自 dsh-free-search 并入）：免 key 引擎链（Tavily → Bing → Sogou，
  按优先级故障转移）替换付费的 `deepseek-official`，可经设置卡开关
- **设置卡**：dsh-kit 配置卡——各功能独立开关、快捷键自定义（终端/文件树/源代码管理/
  侧边栏）、搜索结果条数等

## 安装与更新

安装最新 release（推荐）：

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit#semver:*"
```

或跟踪 main 分支最新提交：

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

更新到最新版：

```bash
dsh plugin --profile web update dsh-kit
```

本包声明了 `dsh.bundle.patch`，会被激活为 profile 的 bundle 层。安装/更新后重启
`dsh web`：工具行出现文件树/源代码管理/后台任务/终端四个开关，AI 的 `web_search`
同时切到免费多源搜索。

## 工作原理

- `src/index.js`：宿主半边——挂 `conversation` `/dsh-kit/terminal` WS 端点
  （node-pty）、`/tree`、`/read`（512 KB 限长 + 文本解码）、`/write`（cwd 子树 +
  mtime CAS）、`/fs/op`、`/jobs/kill|output` 与手机访问网关端点
- `client/bundle.js`：浏览器半边（手写 ModuleLoader bundle，无构建）——
  `conversation.input.left` 注册四个开关；文件树与源代码管理共用侧边栏槽，预览面板
  与终端坞自绘（CSS 让位）；设置页与设置卡注册进 settings 槽位
- `src/web-search.js` + `src/engine-chain.js` + `src/engines/*`：向 web seam 注册
  `free-search` provider，受设置卡 `searchEnabled` 门控
- `cordis.patch.yml`：把 dsh-kit 插件行 insert 进 bundle 层，web 行 `searchProvider`
  改为 `free-search`
- 宿主侧 `node-pty`/`ws` 不声明依赖：运行时从 profile fallback node_modules 解析

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖声明、零构建

## 许可证

MIT