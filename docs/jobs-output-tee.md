# dsh-kit 后台任务输出常显 + 双游标 tee（面板与模型互不抢量）

> 状态：**已实施（2026-09-05）**。用户两轮定稿：①「输出」按钮去掉，每个任务
> 输出常显、各自秒级轮询；②面板读取不得抢占模型侧 `job_output` 的增量。

## 背景与问题

- 官方 `job.readOutput` 是**单游标增量**：游标在生产者闭包里（dsh-jobs-local
  的 registry 本身不记账），每次调用返回"自上次调用以来"的新块。面板与模型
  侧 `job_output` 工具（`ctx.jobs.read` → `job.readOutput()`）走的是同一条
  游标——谁读谁拿走。输出常显（每秒轮询全部任务）会把模型侧读空。

## 设计：job-tee（src/job-tee.ts）

- 把底层 `readOutput` 降级为"取新块"：任何人读取时先把新块排水进该任务的
  **公共 buffer**，再按**各自游标**切片。
- **模型游标**：包装后的 `readOutput` 服务（registry.read 照常调用）——语义
  与原版等价（自模型上次读取以来的增量），且不再被面板抢量；面板不轮询时
  与原版逐位一致。
- **面板游标**：`panelReadJobOutput` 服务；首读从 0 开始（面板要看任务全部
  输出），之后每秒拿增量。
- **安装时机**：注入 jobs 服务时包装 `registry.start`（任务创建即装，模型
  游标从零无重复前缀）+ 面板端点首次读取兜底补装（晚装时模型此前已读走的
  前缀会在下次读取重复出现，属极端边角）。registry 形状不符（宿主升级换
  实现）时静默不装，回退官方 `read`。
- 权限把关不变：端点先 `jobsRegistry.get(jobId, caller)`（与 read 同款的
  存在性/assertAccess 校验，无副作用快照），再排水切片。

## 交付内容

- `src/job-tee.ts`：installJobTee / panelReadJobOutput / teeRegistryJobs
  （WeakMap 按 job 对象记账，job 回收即随 GC）。
- `src/index.ts`：注入 jobs 时 `teeRegistryJobs`；`/dsh-kit/jobs/output` 换
  tee 读取（`get` 把关 + `panelReadJobOutput`），响应形状不变。
- `client/bundle.js`：JobsPanel 去掉「输出」按钮与 expandedId，输出块每行
  常显；轮询 effect 从"单个展开任务"改为"全部 live 任务各一秒一拉"（页面
  隐藏时暂停，回前台续上）；终态行随 session/jobs 推送消失即停拉。
- 已知边界：任务进入终态与下一次面板轮询之间生产者最后冲刷的输出，面板
  可能看不到（终态行随即从面板消失，展示上无感）；模型侧经包装 readOutput
  照常拿到。

## 第二轮定稿（2026-09-05）：终态任务保留在列

- 任务结束不再从面板消失——session/jobs 推送本就含终态任务（registry 的
  store 在任务结束后不删除，之前是面板自己过滤掉的）。运行中排前、终态排后
  并淡化（`data-done` 行降透明度）；已结束的显示总时长（finishedAt-startedAt）。
- 行动作随状态切换：运行中/停止中 =「结束」（kill）；终态 =「关闭」= 仅从
  显示移除（dismissed 集合，内存级——刷新浏览器/重启宿主后不保留，终态任务
  本来就只活在宿主进程内存里，用户定稿）。
- 轮询适配：拉到终态（成功响应里 status 为 completed/killed/failed）即标记
  停拉该任务——终态没有新量，且无 readOutput 的终态任务每次都返回全量
  `outcome.output`，重复拉会重复追加。
- i18n 注意：面板头部 ✕ 已占用 `jobsClose`（"关闭任务面板"），行级关闭用
  `jobsRowClose`，同名键在对象字面量里会静默覆盖。
- render-check useState 桩补惰性初始化器支持（与 React 同语义：函数参 =
  惰性求值）；+3 用例（终态行保留/动作切换/输出块仍在）。

## 验证（2026-09-05）

- tests/test-job-tee.mjs 19 项：仅模型读语义不变；面板读不抢模型/模型读不丢
  面板已读；安装幂等；无 readOutput 任务官方语义回落；start 包装即装；形状
  不符静默。
- typecheck / build EXIT 0；test-git、browser-tools 13 项、e2e 25/25、
  render-check ALL OK；dev 重启 smoke ALL PASS。
