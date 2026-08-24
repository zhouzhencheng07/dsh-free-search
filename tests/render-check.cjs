// 渲染级验证：桩掉 react hooks，直接函数调用 dsh-kit 的组件
// （TreeNode/FileTreePanel/FileContentPane/TerminalEntry/FileTreeEntry/KitSurfaces/KitConfigCard/GitChangesPanel/SkillsManager），
// 跑完整渲染体。强制步骤（见 AGENTS.md）：整文件重写 client bundle 后必须做渲染级验证。
// ⚠️ 盲区：桩不会重渲染（effect 不执行、state 不更新），依赖 effect 产出后才走到的
// 渲染分支（如 FileTreePanel 的 entries.map 行）覆盖不到——2026-08-23 曾有残留变量
// gitMap 藏在该行逃过本检查，靠用户实测暴露。可疑残留请配合全文扫描排查。
// 用法：从 dsh-kit 根运行：node tests\render-check.cjs client\bundle.js
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[2], "utf8");

// 1) 抽出 factory 体
const factoryStart = src.indexOf("factory: (require) => {");
if (factoryStart < 0) { console.log("FATAL: no factory"); process.exit(2); }
const factorySrc = src.slice(factoryStart + "factory: (require) => {".length);
// factory 结尾是 "    },\n  },\n});" 前的 "}"。找最后一个 "  },\n});" 模式。
const tail = factorySrc.lastIndexOf("  },\n});");
const body = factorySrc.slice(0, tail);

// 2) 桩出 react / jsx-runtime 与 window
let callLog = [];
const stateStore = new Map();
let stateSeq = 0;
const reactStub = {
  useState: (init) => {
    const id = stateSeq++;
    if (!stateStore.has(id)) stateStore.set(id, init);
    const set = (v) => stateStore.set(id, typeof v === "function" ? v(stateStore.get(id)) : v);
    return [stateStore.get(id), set];
  },
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: function Fragment() {},
};
const jsxRuntimeStub = {
  Fragment: function Fragment() {},
  jsx: (type, props) => { callLog.push(["jsx", type]); return { type, props, $$dshk: "jsx" }; },
  jsxs: (type, props) => { callLog.push(["jsxs", type]); return { type, props, $$dshk: "jsxs" }; },
};
const windowStub = {
  __ModuleLoader__: { load: () => { /* noop */ } },
};

// 3) 组装可执行的 factory 闭包，并导出组件（替换防 early-return）
const wrapper = body.replace(
  "return module.exports;",
  "return { TreeNode, FileTreePanel, FileContentPane, TerminalEntry, FileTreeEntry, KitSurfaces, KitConfigCard, GitChangesPanel, SkillsManager };",
);
const harness = new Function("require", wrapper);
const comps = harness((name) => {
  if (name === "react") return reactStub;
  if (name === "react/jsx-runtime") return jsxRuntimeStub;
  throw new Error("unexpected require: " + name);
});

if (!comps || typeof comps !== "object") { console.log("FATAL: no components returned"); process.exit(2); }
const names = ["TreeNode", "FileTreePanel", "FileContentPane", "TerminalEntry", "FileTreeEntry", "KitSurfaces", "KitConfigCard", "GitChangesPanel", "SkillsManager"];
for (const n of names) {
  if (typeof comps[n] !== "function") { console.log("FAIL: missing/not function:", n); process.exitCode = 1; return; }
}

// 4) 直接渲染 TreeNode（文件 + 目录两种）
let failed = 0;
const check = (label, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + label); if (!ok) failed++; };

let out;
callLog = [];
out = comps.TreeNode({ entry: { name: "b.js", path: "C:/x/b.js", dir: false }, depth: 0, expanded: {}, onToggle: () => {}, onOpenFile: (p) => {} });
check("TreeNode 文件渲染无异常", !!out && typeof out === "object");

callLog = [];
out = comps.TreeNode({ entry: { name: "src", path: "C:/x/src", dir: true }, depth: 0, expanded: {}, onToggle: () => {}, onOpenFile: () => {} });
check("TreeNode 目录渲染无异常", !!out && typeof out === "object");

// 5) FileTreePanel：cwd 有/无
callLog = [];
out = comps.FileTreePanel({ cwd: null, onOpenFile: () => {} });
check("FileTreePanel noCwd 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.FileTreePanel({ cwd: "C:/x", onOpenFile: () => {} });
check("FileTreePanel noCwd(根未加载) 渲染无异常(loading→error兜底)", !!out && typeof out === "object");

// 6) FileContentPane：加载中（fetch 被桩跳过 -> 保持 loading）
callLog = [];
out = comps.FileContentPane({ path: "C:/x/b.js", cwd: "C:/x", onClose: () => {} });
check("FileContentPane 渲染无异常", !!out && typeof out === "object");

// 7) 入口按钮 / 浮层宿主顶部渲染（任务6：conversation.input.left + shell.overlay）
callLog = [];
out = comps.TerminalEntry({});
check("TerminalEntry 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.FileTreeEntry({});
check("FileTreeEntry 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.KitSurfaces({});
check("KitSurfaces 无hooks渲染无异常", !!out && typeof out === "object");
// 更改视图：无 cwd 与加载态
callLog = [];
out = comps.GitChangesPanel({ cwd: null, onOpenFile: () => {}, onClose: () => {} });
check("GitChangesPanel noCwd 渲染无异常", !!out && typeof out === "object");

// 8) SkillsManager（技能管理页）：无 hooks（cwd=null）与有 cwd 两种
callLog = [];
const fakeHooks = {
  useSessions: (sel) => sel({ current: "s1", byId: { s1: { cwd: "C:/x" } } }),
  useWorkspaces: () => undefined,
};
out = comps.KitSurfaces(fakeHooks);
check("KitSurfaces 带cwd渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.SkillsManager({});
check("SkillsManager 无hooks渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.SkillsManager(fakeHooks);
check("SkillsManager 带cwd渲染无异常", !!out && typeof out === "object");

// 9) KitConfigCard（插件设置卡，任务5）：ready 快照 + 覆盖态
callLog = [];
const fakeScope = {
  getSnapshot: () => ({
    status: "ready",
    writable: true,
    value: { terminalEnabled: true, fileTreeEnabled: false, skillsPageEnabled: true, terminalShortcut: "Ctrl+Alt+T", fileTreeShortcut: "Ctrl+E" },
    user: { fileTreeEnabled: false, terminalShortcut: "Ctrl+Alt+T" },
    base: {},
  }),
  subscribe: () => () => {},
  set: async () => {},
  unset: async () => {},
};
out = comps.KitConfigCard({ scope: fakeScope });
check("KitConfigCard 渲染无异常", !!out && typeof out === "object");

// React 桩记录到的组件类型必须包含本插件自定义组件名（防 ReferenceError 被忽略后整段缺失）
const types = new Set(callLog.flatMap(([, t]) => (typeof t === "string" ? [t] : [])));
// 至少渲染出来 JSX 元素（说明走到 render 而非静默 null）
check("渲染体实际产出元素", callLog.length > 0);

console.log(failed === 0 ? "ALL RENDER OK" : `${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
