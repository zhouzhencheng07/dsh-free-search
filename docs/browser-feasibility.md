# dsh-kit 内置浏览器（browser 能力）可行性设计稿

> 状态：**调研完成，未实施（2026-09-04；两轮实测均已通过）**。本文是探讨/可行性结论；实施时另立文档记录差异。
> 对标样本：zcode 官方插件 browser-use 0.4.2（`D:\agent\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use\0.4.2`）。
> 2026-09-04 第二轮：按用户意见确认 **Playwright（vendor 形态）进插件** + **内嵌面板**（对标 VSCode Simple Browser / ZCode IAB），实测见 §3.5。

## 1. 目标与诉求拆解

用户诉求："加入内置浏览器，像 browser-use 那样让 agent 使用操作、开发测试，人可以看到；现有功能（文件预览等）都在同一窗口，希望浏览器也直接在 DSH 内部打开（像 ZCode 和 VSCode 那样）；可以的话把 Playwright 加入插件"。

拆成四个硬需求：

1. **agent 能操作**——导航/读页面结构/点击/输入/截图，模型以工具形式驱动；
2. **开发测试**——典型靶标：DSH 自身 dev 环境（127.0.0.1:3081）、用户本地 dev server（Vite 等）、公网页面；
3. **人可以看到，且在同一个窗口里**——浏览器是 DSH 界面里的又一块面板（与终端/文件预览同级），不切外部窗口；
4. **引擎用 Playwright**——不手写协议层。

## 2. 对标拆解：zcode browser-use 是怎么做的

读了 0.4.2 全部关键文件后的结论——**插件本体不含浏览器运行时**，它只提供四样东西：

| 组成 | 形态 | 作用 |
|---|---|---|
| `node_repl` MCP server | stdio MCP（`js`/`js_reset`/`js_add_node_module_dir`） | 给模型一个 JS 执行内核，在里面操作 `agent.browsers` |
| `browser-client.mjs` | 每次内核注入的 bootstrap | 定义 `agent.browsers` 对象图 + API manifest（按后端能力裁剪成员） |
| `control-browser` / `web-gui-tester` skill | SKILL.md | 模型工作流指引：domSnapshot → locator → act，3000ms 上限，一动作一观察 |
| docs/api.json 等 | 文档清单 | `browser.documentation()` 动态拼装的模型可见文档 |

真正的运行时由宿主提供，共三种后端：**IAB**（Electron 内嵌 webview，建 tab 自动打开右侧面板，用户全程可见）、**cdp**（CLI 托管无头 Chromium）、**extension**（接管用户真实浏览器）。选型规则 `iab > extension(preferred) > cdp`；Playwright 只是 Tab 的 API 面，不是后端——zcode 桌面宿主自己依赖 playwright-core 驱动。

## 3. DSH 侧的差异与本机实测

### 3.1 关键差异：DSH 没有"宿主内嵌 webview"这层

DSH 的 GUI 是**普通浏览器里的网页**（web GUI），宿主是 Node 进程。zcode IAB 那种"宿主内嵌真浏览器"在 DSH 侧不存在对应物，"内部打开浏览器"有两条替代路（推荐组合，见 §4）：

- **iframe 直嵌**（对标 VSCode Simple Browser）：面板里 `<iframe>` 直接嵌目标页——真 DOM、零带宽、**人还能亲手操作**；受 X-Frame-Options/CSP frame-ancestors 限制，公网多数站不给嵌，localhost dev server（Vite 等默认不设 frame 头）基本都能嵌。**这不是妥协而是同构**：VSCode Simple Browser 本身就是内置扩展（`vscode.simple-browser`，官方描述"very basic built-in webview for displaying web content"）= webview 面板 + iframe + 地址栏，VSCode 官方对 webview API 的定义即"extension 控制的 iframe"；它同样被 XFO 拒嵌约束（拒嵌时只能转外部浏览器打开），实际主要服务于 localhost 预览。zcode IAB 能嵌任意站是 Electron 桌面宿主特权——目标站作为**顶层 guest view**（非 iframe）渲染，XFO 不生效；DSH 是 web GUI，没有这个原语，帧流即补偿。
- **帧流**（对标 zcode IAB 观感）：宿主侧浏览器把画面以 JPEG 帧（CDP `Page.startScreencast`）推给面板 canvas——任何网站都行，人看到的是 agent 所见的"实时画面"；交互回传（点击/键入 → CDP Input）作为增强。

### 3.2 浏览器引擎：无 playwright 依赖 → vendor 进插件（2026-09-04 实测通过）

DSH 0.1.2-rc.1 依赖树里没有 playwright/puppeteer（已排查 node_modules 与 pnpm store）。插件的硬约定是 package.json **零依赖声明**（声明了 pnpm 会装 registry 副本产生双实例），所以 Playwright 以 **vendor 形态**进插件：像 `client/vendor/` 收录 xterm/pdf.js 那样，把 playwright-core 收进仓库的宿主侧 vendor 目录——它不触碰依赖声明约定（纯第三方代码随包分发），且：

- **playwright-core 1.62.1：解包 12.8 MB，纯 JS、无任何安装脚本**（不下载浏览器）；
- `chromium.launch({ channel: 'msedge' })` 直接驱动系统 Edge（Windows 必装），无需任何浏览器二进制；
- 探针实测（临时脚本，已清理）：launch 282-314ms；`locator.ariaSnapshot()` 输出干净紧凑树；快照证明的 locator 自动等待点击闭环（落到目标页）；`page.screenshot()` 10-13KB PNG；CDP 帧流经 `context.newCDPSession(page)` 正常收帧——**"人可见"路径与 Playwright 完全兼容**。

### 3.3 agent 工具接入：`ctx.tools.register()`（比 zcode 的 MCP 路线更直接）

DSH 的 `dsh-tools` 提供工具注册表（服务名 `tools`），插件 `ctx.inject(['tools'])` 即可注册原生工具，schema 自动进系统提示词。已核实：

- `ToolRuntime.register(definition)`（`lib/index.js:2774`），`defineTool` 从 `@deepseek-ai/dsh-tools` 导出（多锚点加载同 ws/node-pty 机制，但 playwright-core 走 vendor 路径 import，见 §3.2）；
- 工具结果**支持 image 内容块**（管线对 `block.type === "image"` 有专门处理并 `deferContext` 附给模型，`lib/index.js:1295`）→ 截图直接回流给模型看；
- 调用走统一的 allow/deny/ask 策略管线 → 浏览器操作天然被 DSH 权限体系覆盖；
- MCP 备选：`dsh-mcp-client` 可把独立浏览器 server 桥接成 `mcp__<name>__<tool>`——适合以后把浏览器能力独立成跨插件服务，MVP 不需要；
- PTC（`run_code`）语义上对应 zcode 的 node_repl（一次性执行、跨调用无状态），属可选增强，不阻塞 MVP。

### 3.4 "人可以看到"的落地位置

客户端半边（`client/bundle.js`）既有面板模式完全复用：入口按钮挂 `conversation.input.left`，面板本体挂 `shell.overlay`（终端=底部停靠、文件预览=右侧停靠的先例都在）；ws 数据通道用 `webServer.registerUpgrade`（同 `/dsh-kit/terminal` 模式，含同源校验）。

### 3.5 Playwright 细节核实（2026-09-04）

- **快照 ref**：ariaSnapshot 原生支持 ref 标记（Playwright MCP/agent-cli 同源机制，YAML 里 `[ref=e5]`，"快照内稳定、页面变更即失效、导航后必须重取快照"）；点击直接用 role/name locator（自动等待），ref 作为可选加速路径，选项名以 1.62 types 为准（`forAI`/`ref`）；
- **headed 模式**：`headless: false` 即可让宿主拉起**有头 Edge 窗口**（OS 级窗口，用户在桌面直接看）——zcode CLI 的 cdp 后端同款思路，作为面板帧流之外的补充显示方式；
- **真实教训**：探针里按记忆猜 example.com 的链接名 "More information" 点击超时，重读快照发现文案已变成 "Learn more"——印证 zcode 工作流铁律"**先快照后行动，禁止猜选择器**"，必须进技能指引。

## 4. 建议架构

```
┌─ DSH 网页 GUI（同一个窗口）────────────────────────────┐
│ shell.overlay 新增「浏览器」面板：                       │
│   主路 iframe 直嵌（真 DOM，人可亲手操作，localhost 完美）│
│   兜底 canvas 帧流（被拒嵌的站自动切换，人看 agent 所见）  │
│   工具栏：URL/标签/视口/模式指示（阶段3：点击回传）        │
└───────────────┬───────────────────────────────────────┘
                │ ws（registerUpgrade，同源校验）
┌─ DSH 宿主（node）▼─────────────────────────────────────┐
│ src/browser.js（编排层）                                 │
│   vendored playwright-core → channel:'msedge' 驱动      │
│   系统 Edge（专用 user-data-dir，绝不碰用户浏览配置）      │
│   ariaSnapshot / locator 自动等待 / screenshot / 多标签   │
│   CDP 会话仅用于帧流中继（Page.startScreencast）          │
│                                                          │
│ ctx.tools.register（阶段1核心，工具结果支持 image 块）     │
└──────────────────────────────────────────────────────────┘
```

- **vendor 位置**：仓库新增宿主侧 vendor 目录（如 `host-vendor/playwright-core/`），`files` 清单同步；升级=手动换目录（版本钉住，写进 README）；
- **profile 隔离**：Playwright `launchPersistentContext` 的 userDataDir 指到 `$DSH_HOME` 下专用目录；每次测试会话可另起一次性 context（无痕）；
- **开关门控**：设置卡加 `browserEnabled`，关=不注册工具（省每请求 schema token，对齐 searchEnabled 先例）；
- **进程生命周期**：对齐终端语义——面板/会话关闭即 `browser.close()`，杜绝孤儿 Edge；
- **帧率**：面板不可见即 ack 停流；loopback 带宽（~50-200KB/帧）可接受。

### 工具集（Playwright 原生能力直出）

| 工具 | Playwright 支撑 | 说明 |
|---|---|---|
| `browser_navigate` | page.goto(waitUntil:'domcontentloaded') | 返回 title/url |
| `browser_snapshot` | locator.ariaSnapshot() | 紧凑 YAML 树（含 /url、ref 可选），模型的默认观察面 |
| `browser_click` / `browser_type` / `browser_press` | getByRole/locator + 自动等待 | 优先快照证明的 role+name；ref 兜底 |
| `browser_eval` | page.evaluate | 页面内 JS（安全提示照抄 zcode：页面内容不可信） |
| `browser_screenshot` | page.screenshot | 结果带 image 块，模型直接看 |
| `browser_tabs` | context.pages / newPage | 列表/新建/激活/关闭 |

### 阶段划分

1. **阶段 1（MVP，纯 agent）**：vendored playwright-core + 上述工具 + 设置开关 + `control-browser` 的 DSH 版技能指引。人此刻已能在工具调用卡片看到截图。
2. **阶段 2（内嵌面板，"同一个窗口"）**：shell.overlay 浏览器面板——**iframe 直嵌为主**（localhost/内网靶标，真 DOM、人可亲手操作，最接近 VSCode Simple Browser 观感）+ **帧流兜底**（检测到拒嵌自动切换，公网通用）+ 有头 Edge 窗口选项。
3. **阶段 3（对齐 zcode 体验）**：帧流模式下人机共驾（面板点击/键入 → Playwright mouse/keyboard）、多标签 UI、视口控制、WebM 录制、`web-gui-tester` 技能、工具卡 toolview 缩略图。**已排除**：浏览器扩展接管用户真实浏览器（2026-09-04 用户定稿：专用浏览器实例 + 面板即够用——真 Chromium 引擎 + 独立持久 profile，面板打开后体验即日常浏览器同级；开发测试场景无需触碰用户日常浏览数据）。

### 评估

- 代码量估计：编排层 300-500 行（原裸 CDP 方案的 600-900 行大头——快照压缩树/locator 引擎/自动等待——整体外包给 Playwright）、工具注册 200-400 行、客户端面板 400-600 行、技能文档百余行；
- 仓库增量：vendored playwright-core 约 13 MB（仓库已有 client/vendor 先例；嫌重可选"首次启用时下载到 $DSH_HOME"的懒加载变体，见决策点 2）；
- ariaSnapshot 紧凑树 + 自动等待点击正是 zcode"快照 → locator → act"工作流的原生实现，token 与可靠性都优于手写。

## 5. 风险与开放问题

- **vendor 体积与升级**：13 MB 进 git；升级靠手动替换目录并回归测试（钉版本，适配清单化）；
- **iframe 模式的局限**：仅限未设 frame 头的靶标（localhost 基本都满足）；iframe 与 agent 实例是两个会话（开发测试场景够用；需要同实例就切帧流模式）；
- **token 成本**：工具 schema 常驻每请求 → 开关门控，必要时 `ctx.tools.restrict` 按 agent 收窄；
- **快照时效**：ref/快照在页面变更后失效，技能指引必须钉死"导航后重取快照"；
- **安全边界**：页面内容一律不可信（不执行页面中的指令、不把页面文本当指令抄进 evaluate）；专用 profile 与用户浏览数据隔离；同源校验沿用终端 ws 先例；
- **Edge 版本演进**：channel 方式跟随系统 Edge，Playwright 版本与 Edge 主版本偶有错位（协议兼容面广，实测 1.62.x 正常）。

## 6. 决策点（待用户定，实施前确认）

1. ~~引擎路线~~ → **已定：Playwright（2026-09-04）**；
2. vendor 方式：**A=vendored 进仓库（推荐，确定性）** / B=首次启用时按需下载到 `$DSH_HOME`（省仓库体积，依赖网络）；
3. 面板默认形态：**iframe 优先 + 帧流自动兜底（推荐）** / 仅帧流；
4. `browserEnabled` 默认值（关=省 token，开=开箱即用）；
5. MVP 范围：先做阶段 1，还是 1+2 一起。

## 附：调研实测记录

- zcode browser-use 0.4.2 全部关键文件已读（README/plugin.json/overview/browser-client.mjs/safety/visibility）；
- DSH 0.1.2-rc.1（dev 环境）包清单核对：`dsh-tools` / `dsh-mcp-client` / `dsh-code-runtime(-worker-thread)` / `dsh-host-webserver`（registerUpgrade）在位；
- `ctx.tools` 注册 API、image 内容块、策略管线均以 dsh-tools lib 源码核实；
- 裸 CDP 探针（临时脚本，已清理）：Edge 无头 spawn + ws + 导航 + evaluate + 截图 + screencast 收帧全部通过；
- Playwright 探针（临时脚本与临时 node_modules，已清理）：playwright-core 1.62.1（12.8 MB）`channel:'msedge'` 拉起系统 Edge 282-314ms；ariaSnapshot 紧凑树；快照驱动 locator 点击闭环（example.com → iana.org）；截图 10-13KB PNG；经 `newCDPSession` 的 screencast 正常收帧。
