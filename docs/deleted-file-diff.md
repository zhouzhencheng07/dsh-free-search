# dsh-kit 源代码管理：已删除文件（D）点击打开"仅 diff"预览

> 状态：**已实施，待用户 GUI 实测（2026-09-05）**。修复"已删除文件点击仍开
> 文本预览 → 读取失败/diff 加载失败（文件不存在）"的无意义报错。

## 用户定稿决策（2026-09-05）

已删除（xy 含 D）的文件**点击打开纯 diff 预览**（看被删了哪些行，提交前
review 删除内容有用），不做"不可点击"的保守方案。

## 实施记录（2026-09-05）

- **宿主**：新增 `validatePathShape`（仅校验路径形态、不查存在性）供 diff
  端点使用——删除文件的 diff 是合法产物（`git diff HEAD` 原生支持），此前
  `validateFile` 的 realpath 存在性检查把它挡死在"文件不存在"。越界由端点
  既有的 git-root rel 二次把关兜住；read 端点仍走存在性校验（报 400 语义正确）。
- **客户端**：
  - GitChangesPanel 行点击携带 `deleted` 标记（`xy[0]==="D" || xy[1]==="D"`，
    未跟踪的 `??` 不算）→ `openPreviewTab(..., deleted)` 存进预览标签条目；
  - FileContentPane `deleted` 态：不发 read 请求（直接进 deleted 态，文本
    面全部隐藏——✎/⇄ 不出现），强制 diff 视图 + 顶部一行说明
    （"文件已删除——此预览仅展示删除 diff；可在源代码管理里 ↩ 恢复文件"，
    中英双语）；已删除文件的二进制也拉 diff（删除 diff 是一行
    "Binary files differ"，可显示）；
  - deleted 翻转跟随：同一文件先预览后被删（或 ↩ 恢复后重开）时实例不重挂
    （key=path），由专用 effect 跟上——进 deleted 强制 diff 并置态，解除则
    重读文本；
  - **删除内容纯红展示（用户实测后定稿）**：不看 raw diff（`diff --git`/
    `index`/`---`/`@@` 等元数据是噪音）——从 diff 文本里只抽删除行、剥掉前缀
    `-`，整块按"已删除"红色展示（渲染语义与未跟踪文件的整绿新增对齐），
    即"被删文件全文 + 红色"。

## 实施偏差（用户实测抓到的崩溃）

- **`phase:"deleted"` 掉进 body 计算块的 else**：块内只分 loading/error/else
  三态，deleted 态 `state.body` 为 undefined → `b.binary` 崩（slot entry
  crashed）。修复：body 块显式兜 deleted/无 body 分支（占位说明，正文渲染走
  deleted 独立分支）。render-check 用例补上"预置 state phase deleted"的真实
  时序——effect 产出的态是桩盲区，必须用 stateStore 预置验证（与 PDF ready
  分支同法）。

## 验证（2026-09-05）

- typecheck / build EXIT 0；render-check ALL OK（+3 项：deleted 渲染无 ⇄、
  删除说明出现、openPreviewTab 标记透传）；test-git / browser e2e 17/17 回归
- **真实链路验证**：临时 git 仓库建文件提交后删除 →
  `GET /dsh-kit/git/diff` 返回 `{"available":true,"xy":" D","diff":"…"（完整
  删除 diff）}` HTTP 200
- 重启 dev 环境 smoke ALL PASS
- **待用户实测**：源代码管理删一个文件 → 点 D 行 → 预览显示删除说明 + 删除
  diff；↩ 恢复后再点 → 回到正常文本预览
