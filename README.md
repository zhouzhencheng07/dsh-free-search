[English](README.en.md) | 中文

# dsh-kit

面向 DeepSeek Harness (dsh) 的**页面能力套件插件**：给 DSH 的浏览器界面加装可选能力，
每个能力独立、互不依赖；全部不用时 DSH 退化为原版。

## 当前能力：终端（terminal）

VSCode 风格的页内终端：

- 右下角悬浮按钮 `>_` 或快捷键 **Ctrl+`** 打开/关闭底部终端面板
- 终端自动打开在**当前会话的工作区目录**（会话 cwd，无会话时退回最近工作区路径）
- Windows 优先 pwsh（PowerShell 7+），退回 powershell.exe；面板内可一键重启
- 面板关闭 / 页面刷新即结束对应 shell 进程（不留孤儿进程）

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

本包声明了 `dsh.bundle.patch`，因此会被激活为 profile 的 bundle 层(而不是仅仅装成
一个不生效的普通依赖)。安装后重启 `dsh web`,页面右下角出现终端入口。

### 本地开发安装

```bash
# 本地开发安装:把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## 工作原理

- `src/index.js`:宿主半边——经 `ctx.webServer.registerUpgrade` 挂 `/dsh-kit/terminal`
  WS 端点(升级前校验 Origin 同源;每条连接 = 一个 node-pty 会话,JSON 文本帧协议,
  见文件头注释),并把 `client/vendor/` 下 xterm 官方预编译 UMD 伺服为 `/dsh-kit/vendor/*`。
- `client/bundle.js`:浏览器半边(手写 ModuleLoader 格式 client bundle,无构建)——
  在 `shell.overlay` 槽位注册悬浮入口,首次打开面板时按需加载 vendor xterm。
- `cordis.patch.yml`:把 `dsh-kit` 插件行 insert 进 bundle 层。
- 宿主侧 `node-pty`/`ws` 不声明依赖:运行时从 profile fallback node_modules 解析。

## 环境要求

- Node.js ≥ 22(dsh 自身要求)
- 纯 ESM、零依赖声明、零构建

## 许可证

MIT
