# dsh-kit 提交详情文件级 diff（图谱变动列表点文件 = 看该提交的改动）

> 状态：**已实施，待用户 GUI 实测（2026-09-05）**。承接提交图谱结构化重写
> （`git-graph-structured.md`）遗留的缺口：详情文件清单是"该提交相对父提交的
> 改动"（diff-tree 语义），点进去的 diff 却走工作区 vs HEAD——清单与内容
> 基线不一致，历史提交点开多是"（无未暂存差异）"空视图，属于误导而非缺失。

## 定稿决策

- **基线选"与上一版（父提交）对比"**，由入口语义决定：清单本身定义为该提交
  相对其父的改动，diff 只有同基线才自洽（GitHub/VS Code/ZCode 提交视图同款）。
  "相对最新"是另一条入口的事——SCM 更改列表（工作区 vs HEAD）保持不变，
  两条入口各答各的问题。
- **顶部注明基线**：diff 视图头部加"与上一版（父提交 abcd123）对比"/根提交
  "与空树对比（全部为新增）"，消除"在看哪个时间点"的歧义。
- **A 类文件不再退原文视图**：旧方案把提交新增文件按未跟踪语义进原文（当时
  无提交级 diff 的兜底）；现在能给出全 + 行的父基线 patch，统一走 diff 视图。

## 交付内容

### 端点（src/index.ts `/dsh-kit/git/diff` 新增 commit 参数）

- `commit` 合法性：≤200 字符、无控制字符，`rev-parse --verify <c>^{commit}`
  校验，伪造/不存在回 400（与 git/show 同款把关）。
- diff 本体：`git diff-tree --root -p --no-commit-id <full> -- <rel>`——第一父
  为基线，`--root` 让根提交自动对空树（不硬编码空树 SHA，兼容 sha256 仓库），
  merge 默认无 patch（详情本就不给合并提交文件清单）。
- 父哈希仅用于顶部说明：`rev-list --parents -n 1` 取第一父短哈希；根提交
  `base:""`。
- 返回 `{available:true, commitMode:true, base, diff}`；无 commit 参数时走原
  工作区路径，行为不变。

### 预览面板（client bundle.js）

- `openPreviewTab` 增加第 6 参 `commit`：预览条目携带钉定；**重开同路径随入口
  刷新**（从 SCM 更改列表重开即清除钉定，LRU/激活逻辑不变）。
- `GitGraphPanel` 详情文件点击传 `onOpenFile(abs, false, false, sel)`（sel=提交
  全哈希）；GitChangesPanel 的 onOpenFile 处理器扩第 4 参，SCM 更改列表调用
  不传 commit，行为不变。
- `FileContentPane`：commit 模式 diff 拉取带 `&commit=`；**不轮询**（钉定 diff
  不可变）；**完整复用全文件着色视图**（用户反馈第一轮定稿：原始 patch 的
  diff --git/index/@@ 元数据是噪音）——hunk 叠加的新像不是盘上内容而是端点随
  diff 带回的**该提交时刻文件内容**（`git show <commit>:<path>`，≤1MB 才带回），
  盘上内容绝不参与钉定视图；新像缺失三分支：该提交已删除的文件（blobMissing）
  与工作区删除文件同款纯红块，过大/二进制回落原始 patch。
- 预览头部标题改显**绝对路径**（用户反馈第二轮：文件名已由页签 chip 承担，
  标题行重复显示文件名信息量为零），且不挂 title 悬停（第三轮：文本已是全
  路径，悬停提示重复；页签 chip 的悬停路径保留——那里只显文件名）。

## 实施记录（2026-09-05）

- render-check +6 用例：openPreviewTab 携带/清除 commit；钉定模式基线说明
  （父短哈希/根提交空树双语）；钉定复用全文件着色（新像=提交时刻内容）；
  删除文件纯红块无元数据；无新像回落原始 patch；常规视图防回归；标题行绝对
  路径。旧 GraphGlyph 组件与用例删除。
- 全量验证：typecheck/build EXIT 0；单测 6 套 PASS；e2e 25/25；render-check
  ALL OK；dev 重启 smoke ALL PASS；端点实测三态齐验：commit=c105cb8 →
  `commitMode:true, base:"ccc22c5"` + content 332KB（走全文件着色）；
  TS 迁移提交删掉的 src/index.js → `blobMissing:true`（走纯红块）；伪造哈希 400。
- 用户实测反馈三轮修正：①原始 patch 元数据噪音 → 复用全文件着色（端点补
  `git show` 新像）；②标题行与页签重复文件名 → 标题改绝对路径；③标题悬停
  tooltip 与直显文本重复 → 去掉，悬停路径只留页签 chip。
- 已知边界：⇄ 切原文视图读的仍是**当前磁盘内容**（diff 视图的新像已是提交
  时刻内容；原文侧要同样钉定需把 read 链路也 commit 化，另行评估）。
