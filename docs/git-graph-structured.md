# dsh-kit 提交图谱结构化重写（parent 哈希算 lane + SVG 绘制）

> 状态：**已实施，待用户 GUI 实测（2026-09-05）**。方案 B：对齐 ZCode
> GitGraphDialog 的机制（app.asar 源码级对标），替换旧 ASCII 前缀渲染。

## 旧呈现的问题（为什么重写）

数据面原是 `git log --all --graph` 的 ASCII 前缀 + 前端按**字符列号**循环
着色，三个具体缺陷：

1. **串色**：lane 颜色绑定字符列，分支分叉/合并后同一分支的列号移动，同一条
   分支线中途变色；
2. **拐角碎裂**：`/` `\` 转弯逐字符上色、合并线是 `-\` 拼的，视觉断裂，`*`
   是文本点不是圆点；
3. **信息面与规模**：行内只有装饰 chip+短哈希+说明（作者/时间藏 tooltip），
   200 条封顶无 load more；`--all` 把 stash 提交画进图谱（噪声线）。

## ZCode 参照（地面真相）

拆 ZCode 桌面端 app.asar 核实：host 发结构化提交记录
（`git log HEAD --branches --tags --remotes --date-order --topo-order
--skip --max-count+1 --format=%H\0%P\0%an\0%at\0%s\0%D`），**渲染端从父哈希
自算 lane 分配后 SVG 绘制**（圆点+曲线，4 色循环），列布局「图谱|说明|作者|
日期」，load more 分页、点击进详情。本重写同构，细节差异见下。

## 交付内容

### 数据面（src/git.ts + src/index.ts）

- `git log HEAD --branches --tags --remotes --topo-order --skip=<n>
  --max-count=<n+1> --pretty=format:%H%x1f%P%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e`
  ——`%P` 父哈希是图谱几何的唯一依据；`--topo-order` 保证子先于父（lane 分配
  依赖该顺序）；`max-count=n+1` 探测 `hasMore`；refs 面不含 stash。
- `parseLogRecords`：按 `%x1e` 分记录、`%x1f` 分字段（剥 git 补的 `\n`），
  解析失败一律安全默认。旧 `parseLogGraph`（ASCII 行解析）删除。
- 端点契约：`{available, root, records:[{H,h,p,an,at,s,d}], hasMore}`，
  `n` 默认 120 上限 500，新增 `skip` 翻页参数。

### 前端（client bundle.js）

- **`computeCommitGraph(records)`**（纯函数，render-check 直调）：槽位数组持有
  「期待到达的哈希+颜色」；每行先并拢所有指向本提交的槽位（合并线收进主槽位
  色），无来源取首个空槽/追加；**首父继承本行槽位**（线穿过节点延续，父已被
  别的槽位等待也照建——到时多线并拢进父节点，正是分叉画法），次父取空槽/追加
  （新色，同父去重）；尾部空槽回收。输出每行：节点 lane/颜色、进边（被消费的
  线）、出边（父边）、直通竖线，及全局 laneCount。lane 颜色随槽位生命周期，
  同一条分支线全程一色。
- **`CommitGraphSvg`**：单行 SVG——直通竖线 + 三次曲线边（竖直切出/切入）+
  实心圆节点（r=4，行高 22，槽宽 14）。
- **行布局**：图谱 SVG → 引用装饰 chip → 短哈希 → 说明 → 作者 → 相对时间
  （刚刚/N 分钟前/N 小时前/N 天前，30 天外退化为日期，tooltip 全时间）；
  容器 <520px 时经 CSS container query 隐藏作者/时间列。
- **load more**：`skip=已取条数` 续传追加（lane 几何对追加稳定——新记录只
  消费/延续已有槽位，不改前面行的画法）；hasMore 为 false 不渲染按钮。
- 详情子视图（点行进 `/dsh-kit/git/show`：作者/时间/说明/文件清单→预览）保留，
  比 ZCode 的详情更强（有文件清单且可点开预览）。

## 实施记录（2026-09-05）

- 测试：test-git 解析用例重写（多记录/父哈希拆分/空父/缺字段安全默认/CRLF）；
  render-check 新增 lane 几何纯函数 5 组用例（线性链/兄弟分叉/合并双父/窗口
  悬挂/空输入）+ 面板预置态渲染 + CommitGraphSvg 直调（嵌套组件体是桩盲区，
  SVG 产出必须直调覆盖）。旧 GraphGlyph 组件与用例删除。
- 真实环境：dev 重启后 `/dsh-kit/git/log` 实测返回结构化 records（含 p）。
- 已知边界：窗口截断处（父不在已加载范围）的槽位画到本行底悬挂，load more
  续传后自然延续，与 ZCode 行为一致。
