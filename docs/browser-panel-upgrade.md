# dsh-kit 浏览器面板升级：页签条 / 前进后退刷新 / 提速 / 自动打开 / 右侧标签页容器

> 状态：**已实施，待用户 GUI 实测（2026-09-05）**。前史见 `browser.md`（浏览器
> 功能本体）与 `browser-feasibility.md`（对标拆解）；本文只记录本轮升级。

## 用户定稿决策（2026-09-05）

- **触发面取保守②**：agent 导航/开新页签才自动切到浏览器标签（ZCode 实际是
  任一浏览器工具就切，见 [ADE Tools](https://zcode.z.ai/en/docs/ADE-tools)；
  我们收窄为导航面，snapshot/截图/eval 不打扰）。
- **人为退出抑制**：人手动切走浏览器标签（或关标签）后，agent 再导航也不拽回；
  手动点回浏览器标签/入口按钮解除——"自动打开不烦人"的关键。
- **行为恒开（二次定稿，取消配置开关）**：初版曾加 `browserAutoOpen` /
  `browserFollowAgent` 两开关进设置卡，用户实测后定稿取消——自动切面板与画面
  跟随 agent 是恒定行为（浏览器就该与 agent 同步），唯一保留的人为控制是
  "手动切走浏览器标签后本轮不再拽回，点回解除"。
- **右侧标签页容器本轮一起做**：互斥布局下"自动打开"会不停抢走文件预览，
  ZCode 式标签共存（预览/任务/浏览器）是自动打开不骚扰的前提。

## 实施记录（2026-09-05）

### 宿主 `src/browser.ts`——观察页/agent 活动页双指针

- `_activeId`（agent 默认目标页，语义不变）与 `_viewId`（面板观察页：帧流、
  人机共驾输入、面板 URL 栏的作用对象）分离。人看 A 页、agent 干 B 页互不干扰。
- **保守跟随规则（恒定，无开关）**：只有"状态改变"类 agent 操作（navigate /
  act / 新页纳管）才把观察页拽过去；snapshot/screenshot/eval 等观察类操作
  不拽画面。
- 人操作面：`activatePage`（只切观察页）、`humanOpen`（作用于观察页，不动
  agent 活动页）、`humanNewTab`、`history(op)`（back/forward/reload，作用于
  观察页；无历史可退/超时不视为故障）。
- `state()` 增 `launching` / `viewId` / `pages[].viewed`；页面消失（关/崩）后
  两指针各自回退（观察页优先跟随活动页）；启动开始/失败即广播 state（面板
  显示"启动中"）。

### 提速（实测"每次加载慢"的两个根因）

1. **首帧兜底**：CDP screencast 只在页面重绘时推帧，静态页 attach 后可能长期
   无首帧——`_attachStream` 后立即 `Page.captureScreenshot` 抓一帧推给面板，
   之后帧流自然接管。
2. **首连 watch 缺陷修复（真回归）**：旧代码 watch 效果首跑时 WebSocket 握手
   未完成（readyState 0）被跳过，而 `onopen` 里 `setConnLost(false)` 是同值
   bailout 不触发重渲染——**首次连接后 watch 从未发出**，帧流要等一次断线重连
   才通。修复：`onopen` 直接补发 + sendWatch 改读 ref（事件回调先于重渲染，
   visibilitychange 里先同步 ref 再发）。

### 面板 `client/bundle.js`——BrowserPanel 重写

- **页签条**：观察页高亮、● 点标 agent 正在操作的页、× 关页签、＋ 新页签；
  URL 栏跟随观察页地址；◀▶⟳ 三导航按钮（未运行禁用）。
- **自动打开（恒开）**：面板常驻挂载在标签容器里，WS 恒连 = 事件源；收到
  `navigated` 且浏览器标签未激活 → 切到浏览器标签；`autoOpenSuppressed`
  模块级标志由人手动切走置位、点回解除（关标签即卸载面板、WS 断，重开天然
  解除）。
- watch 门控改为「浏览器标签激活 + 页面可见」——切到别的标签即停流，切回
  靠首帧兜底立刻有画面。

### 右侧标签页容器（`RightDock`）

- 标签存在性（`openFile`/`jobsOpen`/`browserOpen`）与激活位（`dockTab`）分离；
  打开某功能 = 确保标签存在并激活，**互斥清场废除**（chat 预览/树/SCM 的
  `jobsOpen:false, browserOpen:false` 连环清场全部改为 `dockTab` 激活）。
- 非激活标签 `display:none` 保持挂载——切到浏览器看 agent、切回文件预览滚动
  位置还在。激活位自愈：dockTab 指向不存在的标签时落回第一个存在的标签。
- 三个面板拆壳（body 让位类/宽度/拖拽手柄/标题栏 ✕ 归容器统一持有）；宽度
  单值。首版按标签各定界限（切标签 clamp 进新界限），用户实测切后台任务面板
  被夹窄（jobs 上限 560 < 预览 720）——2026-09-05 二次定稿改为**三标签同一
  界限**（480–960，下限取浏览器画布需求），切标签绝不改宽；初始默认沿用
  720 与可用宽取小，不被放宽后的上限顶大。
- Esc = 关当前激活标签（原固定顺序改为跟随激活位）；配置门控清场走
  `closeDockTab`（清存在性同时顺延激活位）。

### WS 协议新增（`src/index.ts`）

客户端 → 宿主：`activate {tabId}` / `closeTab {tabId}` / `nav {op}` /
`newTab`；state 广播携带 `launching`/`viewId`/`viewed`。宿主 → 客户端事件面
不变（navigated 即自动打开的事件源，无需新事件类型）。

### 设置卡

本轮曾加 `browserAutoOpen` / `browserFollowAgent` 两项，按用户二次定稿**取消**
（行为恒开，无开关）——设置卡恢复原样，仅 `browserEnabled` 一项。

### 键盘输入修复（用户实测发现：键入进不了远端输入框）

三个叠加的断点，逐一定位修复：

1. **焦点断链（根因，原版即如此）**：画布 `pointerdown` preventDefault 后
   canvas 拿不到焦点，keydown 无处发生——键盘路径其实从未通过。修法：点击时
   把焦点显式挪到钉在按下点的**透明输入**（`opacity:0` 2px，`imeRef`），
   keydown 处理器同时挂画布与透明输入（后者不是画布子元素，事件冒泡不到）。
2. **IME 结构性缺口**：合成键（中文输入法）的 keydown 是 `Process`/
   `keyCode 229`，合成 keydown 永远打不出中文。透明输入正是一石二鸟——它是
   editable 宿主，组合事件能起来：组合中 value 只累积不发送（`compositionend`
   前的 input 事件一律跳过），`compositionend` 把提交文本整段发宿主
   `kind:'text'` → `keyboard.insertText`（只派发文本输入，无 key 事件）。
   英文/快捷键仍走 keydown→`keyboard.press`（preventDefault 保证透明输入
   value 恒空，无双重插入）；组合取消（Esc）时 `e.data` 为空不发送。
3. **e2e 假通过修正**：`evaluate` 返回值本就是 JSON 字符串，测试表达式里再包
   一层 `JSON.stringify` 双重序列化 → rect 字段 undefined → 坐标 NaN → 点到
   (0,0)，而旧断言 `/人机共驾/` 恰好被文本框里 act 预填的旧字 vacuous 满足——
   坐标点击路径从未被真实验证。修正为单次解析 + 「点击后才可能出现的字样」
   断言（提交后状态行）+ 焦点断言（`activeElement` 应为输入框）。

## 验证（2026-09-05）

- `pnpm typecheck` EXIT 0；`pnpm build` EXIT 0（dist 18 文件重建入库）
- 单测：browser-tools 12/12；git / text-decode / raw-file / upload 全 PASS
- e2e：**17/17**（新增 6 项：坐标点击真验证（修假通过）、state 带 viewId/viewed、
  agent 开新页签双指针、activatePage 隔离、history back/forward/reload、
  follow 关闭不跟随、键盘键入 + text 块插入）
- render-check：**ALL OK**（新增 RightDock 浏览器标签激活态 2 项）
- smoke-test.ps1：**ALL PASS**（dev 环境重启加载新 dist 后）
- **待用户实测**：GUI 标签共存切换、页签条/导航按钮、agent 导航自动切标签与
  抑制行为、切走预览再切回滚动位置保留、**面板内键入**（英文
  逐键 + 中文输入法组合）

## 实施偏差与已知边界

1. **渲染桩盲区**：桩环境嵌套组件体不执行（`jsx(BrowserPanel,…)` 只建元素），
   RightDock 直调断言只能到"dock 页签条 + 面板挂载元素"，面板内部仍靠
   BrowserPanel 直调用例覆盖（探针定位后修正断言，非代码问题）。
2. **人新建页签会把新页提为 agent 活动页**（adopt 既有语义，保留）：agent
   运行中用户点 ＋ 会让 agent 的默认目标落到空白页——概率低且 agent 下一步
   snapshot 可自愈，未为它引入 adopt 发起方标记。
3. **回退分支的 navigated 去重未做**：history 操作与 framenavigated 可能对同
   一次导航广播两次同 URL 事件，客户端按 URL 覆盖合并，无害。
4. ZCode 的 DevTools 集成、元素审查、有头模式不在本轮范围。
