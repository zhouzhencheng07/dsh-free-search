# dsh-kit vault 模块设计：知识库 + 日程（wangshu 并入，dsh-memory 退役）

> 状态：**设计定稿（2026-09-05，方案讨论收敛），未实施**。前史：望舒 wangshu
> （`D:\Project\wangshu`，Tauri 2 + SQLite + TipTap 的桌面知识库，未深度使用）
> 决定不再独立发展，拆成「知识库 + 日程」并入 dsh-kit，作为 harness 工作台的
> 持久层。模块工作名 **vault**（暂定）。样式参照 `..\docs\seam-upgrade-design.md`。

## 核心判断（讨论定稿）

- harness 的未来形态是**人和 AI 协作的工作台**：聊天是流动面，vault 是长期资产。
  笔记系统的三条公理：①文件是唯一真源（人机读写同一份，无第二存储）；②格式即约定
  （约定少而硬，AI 零工具成本写入）；③插件只做视图与通道，不做数据持有者。
- **md 更适合 AI 存储**的实证：wangshu 为 AI 接入专门做了 MCP 层；迁到 vault 后这层
  能力整个消失——harness agent 的文件工具就是接口。
- **人写为主、AI 辅助**（用户定稿，区别于网上「AI 主导写作」路线）：笔记的价值在写
  的过程（内化）；AI 的角色是园丁（连链接、合并、体检），不是代笔。
- **dsh-memory 退役**：日记流水层（45 天窗 + 晋升门槛）实测价值密度低，不要了；
  检索引擎（关键词加权/覆盖率/IDF/ASCII 边界 + 可选向量 RRF）值得救，并入新模块。
- 与 obsidian+agent 的差异在护城河：agent 与笔记同进程同面板（文件即接口、无 MCP、
  页签与聊天同屏），日程由 harness 会话驱动（「明天提醒我」就是写一行 daily）。

## 事实约束（2026-09-05 核实于 dev 环境 dsh 0.1.2-rc.1）

- **文件工具作用域**（dsh-tool-fs / dsh-sandbox）：以 session cwd 锚定但**接受绝对
  路径**，不是工作区牢笼；越界写走 sandbox 升级（`ESCALATION_TARGETS` =
  workspace-write → danger-full-access，需批准）→ vault 放工作区外 agent 仍可读写。
- **指令注入**（dsh-agent-instructions）：支持分 scope 的 AGENTS.md（含用户级），
  文件变更自动重载 → vault 路径与格式约定可写进用户级指令喂给所有会话。
- **dsh-memory 现状**：已是纯 md 两层记忆库（日记层 `YYYY-MM-DD/<workspace>.md` +
  长期层 `topics/<topic>.md`），检索含单字段位置加权关键词、覆盖率分数线、IDF、
  ASCII 词边界、可选 Ollama 向量 RRF 融合（k=60），向量缓存持久化（sha1 键控）。
- **wangshu 数据模型**（`src-tauri/src/db.rs` / `models.rs`）：SQLite——spaces；
  pages 树（parent/position、slug_id、TipTap ProseMirror JSON 正文存
  `<data_dir>/pages/<id>.json`、软删）；tags / resource_tags；attachments（文件引用）；
  page_links（双链）；page_versions（版本）；schedule_events（start/end、all_day、
  **recurrence_rule JSON** `{"type":"weekly","interval":1,"days":[1,3,5],"end":…}`、
  due_date、completed_at、父子、source_page_id/source_block_id 挂页块）；
  time_entries 已废弃无数据。

## 1. Vault 布局与数据约定

```
<root>/                      ← 设置卡配置的唯一目录（不放 DSH_HOME；同步盘可行）
  AGENTS.md                  ← 格式规范，人机共读（agent 侧由用户级指令指向这里）
  wiki/                      ← 策展层：理解资产，人主导维护，AI 打下手
    projects/<slug>/…        ← 项目 wiki 区（每项目一区）
    topics/…                 ← 通用主题（环境/工具/协作偏好，承接 dsh-memory topics）
  library/                   ← 参考层：学习资料原文/摘要/讲义/clippings，只读为主
  daily/                     ← 日程 + 捕获层：YYYY-MM-DD.md（当天事件、速记、流水）
  attachments/               ← 二进制（图片/PDF/书源；gitignore，同步盘管）
```

- **frontmatter 最小集**：`date`（daily）、`due` / `tags` / `status` / `source`
  （指向 library 材料）、`repeat`、`archived`。行内任务 `- [ ] … (due: 2026-09-06)`。
- **重复日程**：`repeat: weekly@1,3,5;until=2026-12-31`——语义直接沿用 wangshu 的
  recurrence_rule JSON 形状，v1 渲染层支持该子集，不从零发明。
- **链接按 slug/文件名解析**（模块派生视图负责归一），页面移动/归档不破链——
  归档机制能常态化的前提；不采用裸相对路径（挪页即断）。
- **单一真源 + 派生视图**：日历 / 今日 agenda / 反链 / 链接图全部由扫描派生
  （mtime 增量缓存）；解析容错——不认识的行原样保留显示，绝不丢弃 AI 写的内容。

## 2. 分区与检索作用域

体量先定调：万页 md ≈ 100–200MB 纯文本，盘/同步/git 全无压力；**膨胀真正打的是
检索池信噪比、注入大小、人的可导航性**，治法是分区而不是少记。

- **三区语义**：wiki（活跃策展，默认池）/ library（参考，写完不动）/ daily
  （日期天然滚动）。用户的学习资料（含手写学习笔记的**上游原料**）进 library；
  **手写理解笔记进 wiki**（分类标准是「维护中的理解资产 vs 查阅型参考材料」，
  不是谁写的——手写笔记是 wiki 最有价值的内容）。
- **默认检索池** = 当前项目区 + `topics/` + 最近 N 天 daily；**library 默认不在池内**，
  显式检索才进。dsh-memory 的「日期窗口」平移为「分区窗口」：出池不删盘。
- **会话启动注入**：今日 agenda + 当前项目 wiki 地图（标题清单+导读，几 KB），
  免疫膨胀；替代 dsh-memory 的记忆注入。
- 大块头学习资料（整本书/长 PDF）：原文进 attachments，vault 只放摘要页 +
  章节地图 + 要点，不全文进 md。

## 3. wiki 生命周期与园艺

- **防碎约定**（写进 vault AGENTS.md，AI 可执行）：一题一页、写前先查重、重叠合并、
  单页超限（16KB）拆分或抽象——后两条移植 dsh-memory 已有文案。防的是重复与碎片：
  3000 页互链良好可导航，800 页碎成渣不可导航。
- **导航靠链接图，不靠目录树**：每项目区/大主题一张 MOC 地图页（标题清单+导读），
  页面互链 + 反链；目录树保持浅。链接图（入链数/孤页/残页）是扫描索引顺手算出的
  同一份数据，导航、检索、园艺三功能共用。
- **archived 出池不出库**：页标 `archived` 退出默认检索池和地图，显式搜索仍命中。
  归档候选由**陈旧 + 零入链**两个信号提名（时间不是好标准——两年前的环境教训仍
  有效），agent 园艺时出候选清单、**人确认**。
- **园艺体检**（面板入口，v1 手动触发不自动巡园）：agent 跑链接图出报告——残页
  （一句话页）、重复候选、孤儿页、陈旧候选、超大页——人逐条决策。
- **协作约定**：AI 不主动改人手写的页面（被要求才动：整理/扩写/补链接）；AI 产出页
  遵守同样的一题一页；AI 与人写页不设目录隔离，区分靠页内来源标注。

## 4. AI 接入与记忆角色

- **用户级 AGENTS.md** 写死 vault 路径 + 格式约定（自动重载）；agent 写入经文件工具
  （首次越界 sandbox 批准一次；若后续暴露 writableRoots 类配置则白名单化做到零摩擦）。
- **记忆 = 知识 wiki + daily 捕获**，不再有独立记忆系统：daily 是进料口（低摩擦捕获，
  兼日程主轴），wiki 是资产，晋升流 **daily → wiki**（复用即固化，原则同 dsh-memory，
  但从 agent 私有变成人可见可改）。
- **检索引擎并入**：dsh-memory 的 search.js/embed.js（含向量缓存模式）移植进本模块，
  语料从记忆库换成全 vault，默认池按 §2 分区。
- 记忆库与知识库不合并存储的旧方案（一个根两个区挂 dsh-memory）已被本方案取代：
  dsh-memory 退役后 vault 独立承担，无双检索路径、无 agent 写入困惑。

## 5. 对话 ↔ 笔记切换（UX）

- **主通道经由 agent**：最高频的「切换」是人说一句话 agent 落盘（「记一下 X」→ 写
  daily），零 UI 成本；页面切换是辅助。
- **左栏新页签**（与终端/文件树/SCM 同栈）：笔记浏览 + 日历 + 快记；聊天主体不动，
  同屏并存是 workbench 语义，不做抢占式全屏页。
- **会话 → 笔记**：agent 输出里的 vault 路径/引用可点击，跳到笔记页并定位。
- **笔记 → 会话**：选中文字「发给 agent」（注入当前会话输入框并带引用）。
- **不重复造编辑器**：vault md 直接复用现有文件预览/编辑器打开，笔记页只负责浏览、
  日历和快速记录。日程提醒主动推送 v1 不做（宿主无定时触发面板的机制）。

## 6. 存储、版本与同步

- 目录由设置卡配置（现成先例：settings 卡 + settingsScope.bind）；不放 DSH_HOME
  （配置目录不混数据）。
- `git init`：vault 仓库只追 md，`attachments/` 进 .gitignore（二进制会让 git 历史
  膨胀得远比文本凶，同步盘已在管）；page_versions 的能力由 git 替代（agent 改坏可回滚）。
- 放同步盘（OneDrive 等）完全可行——纯文本无锁，顺带多端：手机端可用 Obsidian 打开
  同一 vault（frontmatter + md 链接即 Obsidian 事实标准，兼容成本≈0）。

## 7. 迁移

### wangshu → vault（一次性脚本）

| wangshu | vault 对应物 |
|---|---|
| spaces | 顶层子目录 |
| pages 树（parent/position） | md 文件树（目录嵌套承载层级），title→文件名/H1 |
| 正文 TipTap JSON | md——一次性转换器，只覆盖数据里实际出现的节点类型，未识别节点降级抽纯文本（用量小可接受） |
| tags / page_links | frontmatter `tags:` / md 链接（反链派生） |
| page_versions | 丢弃——vault `git init` 替代 |
| schedule_events | 事件/任务行进 daily；`repeat:` 沿用其 JSON 语义；source_page_id → 行内 md 链接 |
| time_entries | 已废弃无数据，无视 |
| MCP 层 | 消失（harness 文件工具即接口） |

### dsh-memory 交接退役

- `topics/*.md` → `wiki/topics/`（本来就是 md，直搬）；旧日记层默认不迁（多数已过
  45 天窗），个别仍有效的手动捞进 daily/wiki。
- search.js / embed.js（含向量缓存机制）并入本模块（M2）。
- dsh 卸载 dsh-memory 插件，仓库归档不删。

## 8. 分阶段实施顺序

1. **M1 地基**：vault 布局 + 设置卡（目录配置）+ 用户级 AGENTS.md 注入 + git init。
2. **M2 索引与检索**：扫描索引（frontmatter/行内约定/链接图，mtime 增量）+ 今日
   agenda + dsh-memory 引擎并入（默认池按分区）。
3. **M3 面板**：左栏笔记页签（浏览 + 日历 + 快记）。
4. **M4 互通**：会话→笔记定位、笔记→会话发送。
5. **M5 园艺**：体检入口 + archived 流。
6. **M6 迁移**：wangshu 转换器、dsh-memory 交接退役（可在 M3 后任意时点执行）。

## 明确不做

数据库/第二真源、完整 RRULE 日历服务（只做 repeat 子集）、多人协作、自动提醒推送、
AI 主导写作、自动巡园、v1 聚合工作区本地笔记（项目文档仍可放工作区，本模块只管 vault）。
