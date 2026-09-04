# dsh-kit 内置浏览器实施记录

> 状态：**已实施，待用户 GUI/agent 实测（2026-09-04）**。设计调研见同目录
> `browser-feasibility.md`（对标拆解、两轮实测、决策点均已定稿）；本文只记录
> 实施结果与设计差异。

## 实施记录（2026-09-04）

用户定稿四决策：**vendored playwright-core 进仓库 / iframe 优先+帧流兜底 /
browserEnabled 默认开 / 阶段 1+2 一起做**；extension 后端（接管用户日常浏览器）
正式排除。

### 交付物

- `host-vendor/playwright-core/`：1.62.1 整包 vendor（12.8MB，纯 JS，无安装脚本，
  `channel:'msedge'` 直用系统 Edge，无浏览器下载）；`package.json` files 清单已含
  `host-vendor`，package.json 依赖声明仍为零（硬约定不破）
- `src/browser.js`：`BrowserService`——vendored playwright 加载（缺包降级告警）、
  Edge 定位（channel msedge → chrome → executablePath 探测链）、懒启动
  `launchPersistentContext`（专用 profile `$DSH_HOME/dsh-kit/browser-profile`，登录态
  跨会话保留）、页面纳管（tabId/标题缓存/导航与崩溃事件）、帧流中继（CDP
  `Page.startScreencast` jpeg q60，1600px 限宽，帧 ack）、孤儿清理（pidfile +
  tasklist 核验 + taskkill）、引用计数 + 空闲 10 分钟自动关、dispose 兜底
- `src/browser-tools.js`：向 `ctx.tools` 注册 **5 个工具**（`@deepseek-ai/dsh-tools`
  ESM 两锚点加载：裸 import → dsh bin 锚点 resolve+import）：
  `browser_navigate`（返回内嵌快照）/ `browser_snapshot`（恢复观察原语）/
  `browser_act`（click/type/press/check/uncheck/select 统一动作，定位三选一
  role+name/text/selector，返回内嵌新快照）/ `browser_eval` / `browser_screenshot`
  （落盘 `$DSH_HOME/dsh-kit/screenshots/` + 照 mcp-client 模式入附件库：模型图片
  能力证明 `resolveModelInfo().inputModalities` → `attachments.saveImages` →
  `{type:'image', attachment:ref}`，非多模态优雅退化文本）。快照 =
  `ariaSnapshot({ mode:'ai' })`（紧凑树 + `[ref=eN]`）；全部串行（不设
  isConcurrencySafe）；`browserEnabled` 关时 execute 守卫兜底
- `src/index.js`：`browserEnabled` 设置项（默认开，重启生效）；工具注册门控
  `ctx.inject(['settings','tools'])` 双键注入；构建 try/catch 降级（不炸插件树）；
  `/dsh-kit/browser` WS 端点（registerUpgrade + sameOrigin，watch 引用计数驱动
  帧流启停，state/event/frame 广播）+ 426 HTTP 探测
- `client/bundle.js`：入口按钮（order 14，受 browserEnabled 门控）+ 右停靠面板
  （复用 `.dshk-pane`，与文件预览/任务面板互斥）：URL 栏（回车导航，宿主懒启动）、
  双模式——直嵌（回环/私网 host 判定 iframe，sandbox 白名单，人可亲手操作；
  空白可一键切实时画面）与实时画面（canvas 绘 CDP 帧流，rAF 去抖，页面不可见即
  停流）；navigated 事件同步 URL 栏与 iframe.src（人实时看到 agent 在做什么）；
  Esc 关闭；设置卡开关行（中英双语标签）
- 测试：`tests/test-browser-tools.mjs`（12 项纯逻辑单测，mock defineTool）/
  `tests/test-browser-e2e.mjs`（9 项服务层端到端，无 Edge 自动 skip，DSH_HOME
  重定向临时目录）/ `tests/render-check.cjs` 扩展（isEmbeddableHost/BrowserEntry/
  BrowserPanel 未运行态与直嵌态用例 + document/window/location 全局桩 + useCallback 桩）

### 验证结果（2026-09-04，dev 环境 0.1.2-rc.1）

- 单测 12/12、e2e 9/9、render-check 46/46 全过；smoke-test.ps1 ALL PASS
- WS 全链路探针：连接 → watch → 懒启动（~0.3s）→ 848ms 首帧（7.7KB jpeg）✓
- dev 环境重启无告警，`/dsh-kit/browser` 426、boot 名册含 dsh-kit
- **待用户实测**：GUI 面板开合/直嵌与帧流双模式；agent 会话实测 5 工具循环
  （建议：navigate 3081 自身 → snapshot → 点击设置 → screenshot；再测公网站点帧流）

### 与设计稿差异

1. **工具数 4 → 5**：计划 4 个（navigate/act/eval/screenshot），实施补了极简
   `browser_snapshot`——"动作即观察"成功路径 4 个够用，但动作失败后需要独立恢复
   观察原语（快照被 act 返回内嵌后没有失败态重取入口）；schema 成本 ~60 token。
2. **后退/刷新按钮未做**：面板只有 URL 栏（回车导航）；直嵌模式 iframe 跨域历史
   不可控，帧流模式需要额外协议消息——均推阶段 3。
3. **真实 defineTool 的 schema 编译器要求 object schema 显式 `additionalProperties`**：
   首启曾因 `{type:'object'}` 炸插件树（单测 mock defineTool 不走真编译器——教训：
   工具注册必须过真 defineTool 验证一次），已改为 `{type:'object', additionalProperties:true}`
   并把构建包 try/catch 降级。
4. 后台运行中的浏览器实例在空闲 10 分钟后自动关闭（登录态保留在 profile，重开无损）。
5. **2026-09-04 二次实测反馈改版（同日并入）**：去掉直嵌（iframe 平行副本价值薄——
   人想操作不如用原生浏览器，且与 agent 实例状态分叉易误导），面板收敛为**纯帧流 +
   人机共驾**：画布鼠标（移动/按下/抬起/滚轮/双击计数）与键盘（组合键串）经坐标
   换算回传 WS `{t:'input'}`，宿主 `humanInput()` 顺序队列派发到活动页（与 agent
   工具同一 page；未运行时拒绝、不误拉起）。配套：配置卡描述去掉具体形态话术；
   代码注释风格约定——只写设计想法，不写参考了什么软件（已全仓清理软件参照注释）；
   画布坐标→页面坐标按帧原始尺寸换算（帧尺寸=视口尺寸），输入 ~30/s 节流。
6. **2026-09-04 用户实测反馈**：帧流模式打开 DSH 自身（127.0.0.1:3081）显示认证页——根因：
   隔离 profile 无凭据，而 DSH web 用「URL token 换持久 cookie」鉴权（直嵌 iframe 同源共享
   用户 GUI 的 cookie 故天然已登录；帧流是独立实例）。实测确认：带 token 打开一次 →
   cookie 存 profile → **跨浏览器重启有效**（优雅关闭落盘；硬杀进程会丢）。已为 dev profile
   登录一次。工作流：agent 遇认证页向用户要带 token 的 URL（正确行为）或用户在面板地址栏
   粘贴一次。顺带新增 WS `{t:'close'}` 优雅关闭消息（cookie 落盘；将来面板可加「重启浏览器」
   按钮）。注意 `dsh web` 每次重启换 URL token，但已登录 profile 的凭据跨重启仍有效。

## 已知边界（阶段 3 候选）

- 人机共驾（面板点击回传 CDP/Playwright 输入）、页签完整 UI、视口控制、WebM 录制、
  PTC（run_code）组合、插件自带技能机制（control-browser SKILL.md 目前以工具描述 +
  navigate 返回指引承载）
- 直嵌模式的 iframe 与 agent 实例是两个会话（开发测试场景够用；需要同实例就看帧流）
