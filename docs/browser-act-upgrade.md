# dsh-kit 浏览器 act 升级（ref 回填 / hover / scroll / upload / dialog 可见性）+ viewport 工具

> 状态：**已实施，待用户 GUI 实测（2026-09-05）**。承接「ZCode 工具对标复核」
> （2026-09-05 笔记）与 browser-use 插件 0.4.2 源码级对标结论：核心循环无代差，
> 补的是动作面缺口。

## 背景（对标结论，方案依据）

- **act 不接受快照 ref 是最大结构偏差**：快照产出 `[ref=eN]`，act 却只能
  role/text/selector，模型要自己"翻译"，歧义时多一轮收窄；且 `getByRole/
  getByText` 不穿透 iframe，快照里看得到的 iframe 深处元素 act 够不着。
  vendored playwright-core 原生带 `aria-ref` 选择器引擎（含跨帧语法），补上
  即低成本高收益。
- **hover/scroll 缺失**：悬停菜单/tooltip 完全做不了（click 会触发副作用）；
  长页面只有 press PageDown（动焦点）和 eval scrollBy（非真实滚轮事件）。
- **JS dialog 静默吞没**：playwright 无监听器时 auto-dismiss，agent 点了按钮
  页面其实弹了 confirm 被自动关掉，看到的只是"快照没变"，误判点击无效。
- **上传/视口**：vendor 原生 `setInputFiles` 未暴露（ZCode IAB 明确不支持，
  这是反超点）；视口写死 1280×800 无法验证响应式布局。

## 交付内容

### act 定位升级：ref 四选一之首

- `normalizeLocatorArgs` 增加 `ref` 形态且**优先级最高**（逐元素精确指针）；
  宽容收三种写法：`e12` / `ref=e12` / `[ref=e12]`，核心形态必须是 `eN`，否则
  报错提示正确形态。
- 服务层映射 `page.locator('aria-ref=eN')`；`count()===0` 时给出专属错误语义：
  "ref 在每次快照后可能重排（页面已变化），重取 browser_snapshot 用新 ref"——
  与 Codex/ZCode 的 ref 失效语义一致。
- 跨 iframe 元素由 aria-ref 引擎原生解析（`internal:control=enter-frame`）。

### act 动作面：hover / scroll / upload

- `hover`：locator.hover——悬停菜单/tooltip 先 hover 再取快照即可点。
- `scroll`：双语义——**有定位目标** = `scrollIntoViewIfNeeded`（滚到元素可见）；
  **无定位目标** = `page.mouse.wheel(dx, dy)`（真实滚轮事件，懒加载/无限滚动
  可靠触发），dx/dy 缺一可、都缺报错；增量 clamp ±5000（与面板人机路径一致）。
- `upload`：`setInputFiles`，value=本地绝对路径（多文件换行分隔），先验文件
  存在再交给 playwright。
- press 与 scroll 允许无定位目标（发页面级事件），其余动作仍强制要求定位。

### JS dialog 可见性（自动关闭语义不变）

- `_adopt` 给每页挂 `page.on('dialog')`：记录 `{type, message(截 120), at}`
  环形缓冲（cap 5/页）后**立即 dismiss**。关键点：挂了监听器后 playwright 不再
  自动关，必须显式 dismiss（否则页面冻结等输入、后续动作全部超时）；dismiss=
  取消，与旧默认行为一致，差别只在弹出事实被记录。
- act/navigate 在动作窗口内 drain 弹出记录，以 `warning` 带回：
  `页面弹出 confirm「确认删除？」，已自动关闭（confirm 默认按取消处理）`——
  消除"点了没反应"这类神秘失效；与 matched>1 的收窄 warning 叠加共存。

### browser_viewport（第 6 个工具）

- 320–3840 × 320–2160，越界报错不静默 clamp；作用于指定页（默认 agent 活动页）。
- 只影响目标页签：新页签仍以 launch 默认 1280×800 打开。面板帧流坐标按帧原始
  尺寸换算，视口变化天然跟随，无需面板改动。

## 实施记录（2026-09-05）

- `src/browser.ts`：PwLocator 最小依赖面补 hover/setInputFiles/
  scrollIntoViewIfNeeded；PwPage 补 dialog 监听与 viewportSize/
  setViewportSize；`_dialogs` 环形缓冲 + `_drainDialogs` + `dialogWarning`
  投影；act 重构（t0 对话框窗口起点在派发前取）；新增 `setViewport`。
- `src/browser-tools.ts`：act 参数加 ref/dx/dy、enum 9 种动作、定位说明改为
  "四选一，ref 推荐"；注册 `browser_viewport`（共 6 工具）。
- 测试：单测 13 项（ref 三写法/优先级、hover/scroll/upload 配套、6 工具注册、
  viewport 投影）；e2e 25/25（ref 点击一次到位、hover 副作用、滚轮下滚回滚、
  定位滚动、无增量报错、upload 进 input、confirm 自动关闭+warning 带回、
  viewport 生效+越界拒绝）。
- 教训：`page.mouse.wheel` **不等待滚动落定**（Chromium 逐帧应用），e2e 断言
  前需留落定时间，否则 scrollY 读到旧值（首轮实测踩中）。
