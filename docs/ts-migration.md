# dsh-kit 宿主半边迁移 TypeScript（TS 源码 + dist 双轨）

> 状态：**实施完成（2026-09-05），全部验证通过**——typecheck / 6 套单测 / browser e2e / render-check / build / smoke（真实 dev 环境跑 dist 插件）/ 技能池端到端。

## 为什么迁

- 接缝契约（工具 schema、WS 消息形状、宿主对象面、git CLI 输出解析）此前靠注释维护；strict TS 把形状偏移变成编辑器红线与检查门错误。
- 两个先例支撑选型：free-auth 已在本生态验证「TS 源码 + dist 双轨」全流程（本机 Node 24.19 实测）；better-sidebar 提供公开生态级参考（tsdown/npm/市场/CI 全套，配方存档），按 dsh-kit 体量裁掉不用。

## 两条 Node 硬规则（形态选型的机制根源）

1. **node_modules 下的 .ts 拒绝类型剥离**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，安全限制、无开关）：
   - junction/link 直装：模块真实路径 = 工作区（不在 node_modules 下）→ Node 24 类型剥离放行，.ts 直跑零编译；
   - git/npm 安装：真实拷贝落进 profile node_modules → .ts 被拒，必须发构建后的 JS。
   这就是「dev 类型擦除可行、github 安装要编译一次」的同一条规则的两面——编译挂在"安装/发布"事件上，永远不挂"每次编辑"。
2. ESM bare import 按模块真实路径 parent-walk（symlink/junction 会被 realpath）→ git 安装的插件依赖需自包含；dsh-kit 宿主侧无静态 `@deepseek-ai/*` 导入（dsh-tools 动态两锚点、playwright vendored），不受影响。

## 形态（free-auth 同款）

- **TS 源码（src/*.ts，相对导入显式 `.ts` 后缀）+ tsc 产物 dist/ 入库；`main`/exports → `dist/index.js`**——git 安装免构建。
- 类型检查门：`pnpm typecheck`（tsc --noEmit：strict + noUncheckedIndexedAccess + verbatimModuleSyntax + allowImportingTsExtensions）。
- `rewriteRelativeImportExtensions`（TS ≥5.7）：源码写 `.ts` 后缀导入，tsc 出 dist 自动改写回 `.js`。
- 零 dependencies 声明不变；devDependencies 仅 typescript/@types/node，运行时不解析工作区 node_modules（src/dist 无 bare import 包）。
- client/bundle.js（手写 ModuleLoader 格式）、cordis.patch.yml、host-vendor 不参与迁移。
- 迁移期中间态：`main` 暂指 src（混合 .ts/.js 在 junction 下由 Node 24 擦除直跑），全部转完再 flip 到 dist。

## 实施记录

- 宿主半边 18 个模块全部转换：browser（vendored playwright 无类型随 require 载入 → 文件头维护"最小依赖面接口"，`__dshTabId` 用交叉类型保留幂等锚语义）、browser-tools（defineTool/ToolExec 契约类型 + dsh-tools 环境声明 src/dsh-tools.d.ts）、engine-chain（引擎契约注释转 `SearchEngine` 接口）、web-search、engines×6、git（解析器返回类型接口化：GitBranchStatus/LogGraphLine/GitBranchInfo/GitDecoration）、text-decode、raw-file、upload、phone-gateway（PhoneGatewayOptions/Handle 接口 + upgrade 隧道 socket 收窄 net.Socket）、skill-pool（SkillEntry + 端点 webCtx 最小面）、index（收口）。
- 宿主对象（cordis ctx/webServer/ws/pty/exec）一律**最小本地接口**：只声明代码实际触达的成员，运行时行为零变化；边界值（JSON.parse、dsh-tools 返回）标 any。
- noUncheckedIndexedAccess 适配：正则组 `m[1] ?? ''`、循环内下标 `arr[i]!`、Buffer 下标写入两侧 `!`、`match.index!`。
- 错误消息统一 `error instanceof Error ? error.message : error`（catch 参数是 unknown）。
- 死代码清理：skill-pool 私有函数 moveTo（从未被调用）删除。
- tests/*.mjs 导入面全部切 .ts（node 24 擦除直跑）。

## 验证

- `pnpm typecheck` EXIT 0（全部 18 模块）。
- 单测：git / text-decode / raw-file / upload / phone-gateway / browser-tools（12 项）全 PASS；browser e2e 11/11。
- render-check ALL OK（client 未动）。
- `pnpm build` EXIT 0：dist 18 文件，`rewriteRelativeImportExtensions` 的 .ts→.js 导入改写抽验正确（dist/index.js 与 dist/engine-chain.js）。
- **重启 dev 环境实测**：`main`→dist 的插件真实启动，smoke ALL PASS（首页/boot 名册/client.js/vendor/read/skills/terminal 426/终端 WS 回显）。
- 技能池端到端 ALL PASS（对运行中 dev 环境）。

## 实施偏差记录

1. **registry.list 解绑 this（smoke 抓住的真回归）**：skill-pool.ts 里为过类型检查把 `registry.list` 提取成裸函数再调用，`this` 断链导致 dsh-skill 内部炸 `Cannot read properties of undefined (reading 'snapshot')`，且以宿主 fatal load failure 杀死整个 dsh 进程（首次重启冒烟时发现）。教训：**类型上完全合法的解绑调用，tsc 抓不到——宿主对象的方法必须保持接收者绑定调用**；已改回 `registry.list(...)` 并加注释防回归。
2. **test-skill-pool.mjs 非幂等（既有问题，非本次引入）**：测试结束时只删池里的 flat-kit，hello-kit 留在池内——下一次运行的首个"复制到池"必撞 409。干净池下单次运行全 PASS；跑它之前先清 `$DSH_HOME/skill-pool/hello-kit`。

## dev 循环变化

改 src → `pnpm build` → 重启测试环境（较纯 JS 期多一步约 1s 的 tsc；不 build 直接重启会静默跑旧 dist）；client 半边照旧刷新即生效。
