// 渲染级验证：桩掉 react hooks，直接函数调用 dsh-kit 的组件
// （TreeNode/FileTreePanel/FileContentPane/TerminalEntry/FileTreeEntry/KitSurfaces/
// KitConfigCard/GitChangesPanel/SkillsManager/TerminalDock/TerminalPane），跑完整渲染体。
// TerminalDock/TerminalPane 通过 setKitUi 预置会话后渲染（防"有状态后才走到的分支"逃逸）。
// ⚠️ 盲区：桩不会重渲染（effect 不执行、state 不更新），依赖 effect 产出后才走到的
// 渲染分支（如 FileTreePanel 的 entries.map 行）覆盖不到——2026-08-23 曾有残留变量
// gitMap 藏在该行逃过本检查，靠用户实测暴露。可疑残留请配合全文扫描排查。
// 用法：从 dsh-kit 根运行：node tests\render-check.cjs client\bundle.js
const fs = require("node:fs");
// 归一化行尾：git autocrlf 检出后文件可能是 CRLF，切片标记按 LF 匹配才稳定
const src = fs.readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n");

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
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: function Fragment() {},
};
const jsxRuntimeStub = {
  Fragment: function Fragment() {},
  jsx: (type, props) => { callLog.push(["jsx", type, props]); return { type, props, $$dshk: "jsx" }; },
  jsxs: (type, props) => { callLog.push(["jsxs", type, props]); return { type, props, $$dshk: "jsxs" }; },
};
const windowStub = {
  __ModuleLoader__: { load: () => { /* noop */ } },
};
// Node 无浏览器全局，浏览器面板组件的渲染体直接读 document/location/window——
// 渲染检查补最小桩（真实运行在浏览器里天然存在）
if (!global.document) {
  global.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {}, body: { classList: { add() {}, remove() {} } } };
}
if (!global.window) {
  global.window = { innerWidth: 1600, requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
}
if (!global.location) {
  global.location = { protocol: "http:", host: "127.0.0.1:3081" };
}

// 3) 组装可执行的 factory 闭包，并导出组件（替换防 early-return）；
//    setKitUi/makeTerm 用于预置终端坞等依赖状态的渲染分支
const wrapper = body.replace(
  "return module.exports;",
  "return { TreeNode, FileTreePanel, FileContentPane, TerminalEntry, FileTreeEntry, ScmEntry, JobsEntry, JobsPanel, PhoneSection, KitSurfaces, KitConfigCard, GitChangesPanel, GitGraphPanel, GitBranchMenu, GitActionsMenu, SkillsManager, TerminalDock, TerminalPane, TreeRowMenu, GraphGlyph, BrowserEntry, BrowserPanel, RightDock, DockStub, openPreviewTab, closePreviewTab, dockBounds, setKitUi, makeTerm };",
);
const harness = new Function("require", wrapper);
const comps = harness((name) => {
  if (name === "react") return reactStub;
  if (name === "react/jsx-runtime") return jsxRuntimeStub;
  throw new Error("unexpected require: " + name);
});

if (!comps || typeof comps !== "object") { console.log("FATAL: no components returned"); process.exit(2); }
const names = ["TreeNode", "FileTreePanel", "FileContentPane", "TerminalEntry", "FileTreeEntry", "ScmEntry", "JobsEntry", "JobsPanel", "PhoneSection", "KitSurfaces", "KitConfigCard", "GitChangesPanel", "GitGraphPanel", "GitBranchMenu", "GitActionsMenu", "SkillsManager", "TerminalDock", "TerminalPane", "GraphGlyph", "BrowserEntry", "BrowserPanel", "RightDock", "DockStub", "dockBounds"];
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

// 4b) TreeNode 带 actions：行悬停常驻 @、复制绝对路径与 ⋯（常用+菜单组合）；
//     复制相对路径收敛进 ⋯ 菜单（TreeRowMenu 渲染），回调携带 relative 标志
let copiedRel = null;
let mentioned = null;
callLog = [];
out = comps.TreeNode({
  entry: { name: "b.js", path: "D:/w/b.js", dir: false },
  depth: 0,
  expanded: {},
  onToggle: () => {},
  onOpenFile: () => {},
  actions: { onCopyPath: (_entry, rel) => { copiedRel = rel; }, onMention: (entry) => { mentioned = entry; } },
});
const findBtnByTitle = (...titles) => {
  const hit = callLog.find(([, , p]) => p && typeof p === "object" && titles.includes(p.title));
  return hit ? hit[2] : null;
};
const absBtn = findBtnByTitle("复制绝对路径", "Copy absolute path");
const atBtn = findBtnByTitle("@ 到对话", "Insert @ mention");
check("TreeNode 常驻按钮渲染(@+复制绝对)", !!absBtn && !!atBtn);
const fakeEvent = { stopPropagation() {} };
absBtn.onClick(fakeEvent);
check("复制绝对路径回调 relative=false", copiedRel === false);
atBtn.onClick(fakeEvent);
check("@ 到对话回调携带条目", mentioned && mentioned.path === "D:/w/b.js");
// 4c) TreeRowMenu：文件行菜单项含复制相对路径/重命名/删除；目录行另有新建两项
callLog = [];
out = comps.TreeRowMenu({ entry: { name: "b.js", path: "D:/w/b.js", dir: false }, rect: { top: 0, bottom: 20, left: 0, right: 100 }, actions: { onCopyPath: (_e, rel) => { copiedRel = rel; }, onRename: () => {}, onDelete: () => {} }, onClose: () => {} });
const menuLabels = callLog.filter(([, , p]) => p && typeof p === "object" && typeof p.children === "string").map(([, , p]) => p.children);
const hasAny = (cands) => cands.some((c) => menuLabels.includes(c));
check("TreeRowMenu 文件行菜单(复制相对/重命名/删除)", hasAny(["复制相对路径", "Copy relative path"]) && hasAny(["重命名", "Rename"]) && hasAny(["删除", "Delete"]));
callLog = [];
out = comps.TreeRowMenu({ entry: { name: "src", path: "D:/w/src", dir: true }, rect: { top: 0, bottom: 20, left: 0, right: 100 }, actions: { onCreate: () => {}, onCopyPath: () => {}, onRename: () => {}, onDelete: () => {} }, onClose: () => {} });
const dirLabels = callLog.filter(([, , p]) => p && typeof p === "object" && typeof p.children === "string").map(([, , p]) => p.children);
const dirHasAny = (cands) => cands.some((c) => dirLabels.includes(c));
check("TreeRowMenu 目录行菜单(新建文件/夹+复制相对/重命名/删除)", dirHasAny(["新建文件", "New File"]) && dirHasAny(["新建文件夹", "New Folder"]) && dirHasAny(["复制相对路径", "Copy relative path"]) && dirHasAny(["删除", "Delete"]));

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

// 6.1) FileContentPane PDF ready 分支：pdf.js 宿主容器 + ↗ 兜底（canvas 由
//      effect 挂载，桩覆盖不到——重置序号预置 useState#0 让渲染体走到新分支）
stateSeq = 0;
stateStore.clear();
stateStore.set(0, {
  phase: "ready",
  body: { path: "C:/x/doc.pdf", size: 10, mtimeMs: 1, truncated: false, binary: true, content: null },
});
callLog = [];
out = comps.FileContentPane({ path: "C:/x/doc.pdf", cwd: "C:/x", onClose: () => {} });
const pdfHost = callLog.find((c) => c[0] === "jsx" && c[2] && c[2].className === "dshk-pdf-scroll");
check("FileContentPane PDF ready 渲染无异常", !!out && typeof out === "object");
check("PDF 渲染出 pdf.js 宿主容器", !!pdfHost);

// 6.2) xlsx ready 分支：表格宿主容器产出（SheetJS 解析在沙箱 effect 里，桩不覆盖）
stateSeq = 0;
stateStore.clear();
stateStore.set(0, {
  phase: "ready",
  body: { path: "C:/x/t.xlsx", size: 10, mtimeMs: 1, truncated: false, binary: true, content: null },
});
callLog = [];
out = comps.FileContentPane({ path: "C:/x/t.xlsx", cwd: "C:/x", onClose: () => {} });
const sheetHost = callLog.find(
  (c) =>
    (c[0] === "jsx" || c[0] === "jsxs") &&
    c[2] &&
    typeof c[2].className === "string" &&
    c[2].className.includes("dshk-sheetwrap"),
);
check("FileContentPane xlsx ready 渲染无异常", !!out && typeof out === "object");
check("xlsx 渲染出表格宿主容器", !!sheetHost);

// 6.3) docx ready 分支：文档宿主容器产出（mammoth 转换在沙箱 effect 里，桩不覆盖）
stateSeq = 0;
stateStore.clear();
stateStore.set(0, {
  phase: "ready",
  body: { path: "C:/x/t.docx", size: 10, mtimeMs: 1, truncated: false, binary: true, content: null },
});
callLog = [];
out = comps.FileContentPane({ path: "C:/x/t.docx", cwd: "C:/x", onClose: () => {} });
const docHost = callLog.find(
  (c) =>
    (c[0] === "jsx" || c[0] === "jsxs") &&
    c[2] &&
    typeof c[2].className === "string" &&
    c[2].className.includes("dshk-docwrap"),
);
check("FileContentPane docx ready 渲染无异常", !!out && typeof out === "object");
check("docx 渲染出文档宿主容器", !!docHost);

// 7) 入口按钮 / 浮层宿主顶部渲染（conversation.input.left + shell.overlay 槽位）
callLog = [];
out = comps.TerminalEntry({});
check("TerminalEntry 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.FileTreeEntry({});
check("FileTreeEntry 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.ScmEntry({});
check("ScmEntry 渲染无异常", !!out && typeof out === "object");
// 7.1) 后台任务面板：无 hooks（jobsBySession 未达 → 空列表）与有任务两种
callLog = [];
out = comps.JobsEntry({});
check("JobsEntry 无hooks渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.JobsPanel({});
check("JobsPanel 无hooks渲染无异常(空列表)", !!out && typeof out === "object");
const jobsHooks = {
  useSessions: (sel) =>
    sel({
      current: "s1",
      byId: { s1: { cwd: "C:/x" } },
      jobsBySession: {
        s1: [
          { id: "pwsh-1", kind: "pwsh", label: "npm run dev", status: "running", startedAt: Date.now() - 30000 },
          { id: "pwsh-2", kind: "pwsh", label: "frpc 隧道", status: "stopping", startedAt: Date.now() - 120000 },
        ],
      },
    }),
  useWorkspaces: () => undefined,
};
out = comps.JobsEntry(jobsHooks);
check("JobsEntry 带运行中任务渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.JobsPanel(jobsHooks);
check("JobsPanel 带运行中任务渲染无异常", !!out && typeof out === "object");
comps.setKitUi({ jobsOpen: true });
out = comps.KitSurfaces({ ...jobsHooks });
check("KitSurfaces 带jobsOpen渲染无异常", !!out && typeof out === "object");
comps.setKitUi({ jobsOpen: false });

// 6.5) PhoneSection：数据未达（fetch/effect 被桩跳过 → 纯 loading 分支）
callLog = [];
out = comps.PhoneSection({});
check("PhoneSection loading 渲染无异常", !!out && typeof out === "object");

// 7.2) 内置浏览器：入口 + 面板（未运行态：canvas + 输入处理器就位）
callLog = [];
out = comps.BrowserEntry({});
check("BrowserEntry 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.BrowserPanel({});
const canvasHost = callLog.find((c) => (c[0] === "jsx") && c[2] && typeof c[2].className === "string" && c[2].className.includes("dshk-brw-canvas"));
const hasInputHandlers = canvasHost && canvasHost[2].onPointerDown && canvasHost[2].onKeyDown && canvasHost[2].onWheel;
check("BrowserPanel 未运行态渲染无异常", !!out && typeof out === "object");
check("BrowserPanel 渲染出带共驾输入处理器的 canvas", !!canvasHost && !!hasInputHandlers);
comps.setKitUi({ browserOpen: false });

// 7.2.1) 右侧标签页容器：浏览器标签激活态。注意桩环境嵌套组件体不执行
// （jsx(BrowserPanel) 只建元素），面板内部由上面直接调用 BrowserPanel 的用例覆盖；
// 这里验证 dock 页签条高亮与面板挂载元素
comps.setKitUi({ browserOpen: true, dockTab: "browser" });
callLog = [];
out = comps.RightDock({ props: {}, cwd: "C:/x" });
const dockOnTab = callLog.find((c) => (c[0] === "jsxs") && c[2] && c[2].className === "dshk-tab dshk-tab-on");
const bpElem = callLog.find((c) => c[1] === comps.BrowserPanel && c[2] && c[2].active === true);
check("RightDock 浏览器标签渲染无异常", !!out && typeof out === "object");
check("RightDock 渲染出激活浏览器标签与面板挂载元素", !!dockOnTab && !!bpElem);
comps.setKitUi({ browserOpen: false, dockTab: null });
// 右坞宽度：三标签界限必须同一（宽度共享单值，界限分档会让切标签改宽——
// 曾 jobs 上限 560 窄于预览 720，用户实测切后台任务面板变窄）
const dbP = comps.dockBounds("preview");
const dbJ = comps.dockBounds("jobs");
const dbB = comps.dockBounds("browser");
check("右坞三标签宽度界限同一（切标签不改宽）", dbP.min === dbJ.min && dbP.max === dbJ.max && dbP.min === dbB.min && dbP.max === dbB.max);

// 7.2.2) 多文件预览：二级文件小标签条（>1 个文件才显示）+ 坞头全部关闭/收起按钮
comps.setKitUi({
  previews: [
    { path: "C:/x/a.js", from: "tree", untracked: false, usedAt: 1 },
    { path: "C:/x/b.md", from: "scm", untracked: true, usedAt: 2 },
  ],
  activePreview: "C:/x/b.md",
  dockTab: "preview",
});
callLog = [];
out = comps.RightDock({ props: {}, cwd: "C:/x" });
const pvTabrow = callLog.find((c) => (c[0] === "jsx") && c[2] && c[2].className === "dshk-pv-tabrow");
const pvChips = callLog.filter((c) => (c[0] === "jsxs") && c[2] && typeof c[2].className === "string" && c[2].className.startsWith("dshk-tab") && typeof c[2].title === "string" && c[2].title.startsWith("C:/x/"));
// 桩环境 <html lang> 缺失 → t() 走英文兜底（语言跟随设计的正确行为），断言双语匹配
const closeAllBtn = callLog.find((c) => (c[0] === "jsx") && c[2] && ["全部关闭", "Close all"].includes(c[2]["aria-label"]));
const minimizeBtn = callLog.find((c) => (c[0] === "jsx") && c[2] && ["最小化面板", "Minimize panel"].includes(c[2]["aria-label"]));
check("RightDock 多文件预览渲染无异常", !!out && typeof out === "object");
check("RightDock 渲染出二级文件标签条（2 个文件 chip）", !!pvTabrow && pvChips.length === 2);
check("RightDock 坞头渲染全部关闭与最小化按钮", !!closeAllBtn && !!minimizeBtn);
comps.setKitUi({ previews: [], activePreview: null, dockTab: null });

// 7.2.4) 最小化：KitSurfaces 收起态渲染 DockStub 竖条（RightDock 不再出现）；
// DockStub 直调产出可点击的展开按钮
comps.setKitUi({ browserOpen: true, dockTab: "browser", dockCollapsed: true });
callLog = [];
out = comps.KitSurfaces({});
const stubElem = callLog.find((c) => c[1] === comps.DockStub);
const dockElem = callLog.find((c) => c[1] === comps.RightDock);
check("KitSurfaces 最小化态渲染无异常", !!out && typeof out === "object");
check("最小化态挂 DockStub 竖条且不挂 RightDock", !!stubElem && !dockElem);
callLog = [];
out = comps.DockStub({});
const stubBtn = callLog.find((c) => (c[0] === "jsx") && c[2] && ["展开面板", "Expand panel"].includes(c[2]["aria-label"]));
check("DockStub 直调渲染展开按钮", !!out && typeof out === "object" && !!stubBtn);
comps.setKitUi({ browserOpen: false, dockTab: null, dockCollapsed: false });

// 7.2.3) 预览标签 LRU 纯逻辑：默认上限 8，超限开新文件逐出 usedAt 最小者；
// 重开已存在文件置顶激活不逐出自身；关闭激活文件激活位顺延邻居
const lruBase = [];
for (let i = 1; i <= 8; i++) lruBase.push({ path: `C:/x/f${i}.js`, from: "tree", untracked: false, usedAt: i });
const opened = comps.openPreviewTab({ previews: lruBase, activePreview: "C:/x/f8.js" }, "C:/x/f9.js", "tree", false);
check("openPreviewTab 超限 LRU 逐出最久未用", opened.previews.length === 8 && !opened.previews.some((p) => p.path === "C:/x/f1.js") && opened.previews.some((p) => p.path === "C:/x/f9.js") && opened.activePreview === "C:/x/f9.js");
const reopened = comps.openPreviewTab({ previews: opened.previews, activePreview: "C:/x/f9.js" }, "C:/x/f2.js", "scm", false);
const reopenedItem = reopened.previews.find((p) => p.path === "C:/x/f2.js");
check("openPreviewTab 重开已存在文件置顶激活不逐出自身", reopened.previews.length === 8 && reopened.activePreview === "C:/x/f2.js" && !!reopenedItem && reopenedItem.untracked === false && reopenedItem.from === "scm");
const closed = comps.closePreviewTab({ previews: opened.previews, activePreview: "C:/x/f9.js" }, "C:/x/f9.js");
check("closePreviewTab 关激活文件激活位顺延邻居", closed.previews.length === 7 && closed.activePreview === "C:/x/f8.js");
const closedLast = comps.closePreviewTab({ previews: [{ path: "C:/x/only.js", from: "tree", untracked: false, usedAt: 1 }], activePreview: "C:/x/only.js" }, "C:/x/only.js");
check("closePreviewTab 关最后一个文件预览大标签随之消失", closedLast.previews.length === 0 && closedLast.activePreview === null);

// 7.5) 终端坞（多标签）：预置两个会话（含同 cwd 多开）后渲染——标签 map 曾因
// 变量遮蔽翻译函数 t 而崩溃，此用例专防"有状态后才走到的渲染分支"
comps.setKitUi({ terminals: [comps.makeTerm("C:/x"), comps.makeTerm("C:/x")], activeTermId: null, termDockOpen: true });
callLog = [];
out = comps.TerminalDock({ open: true, cwd: "C:/x", onSpawn: () => {}, onHide: () => {}, onActivate: () => {}, onKill: () => {} });
check("TerminalDock 带标签渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.TerminalPane({ term: { id: "t1", cwd: "C:/x" }, visible: true });
check("TerminalPane 渲染无异常", !!out && typeof out === "object");
comps.setKitUi({ terminals: [], activeTermId: null, termDockOpen: false });
callLog = [];
out = comps.KitSurfaces({});
check("KitSurfaces 无hooks渲染无异常", !!out && typeof out === "object");
// 更改视图：无 cwd 与加载态
callLog = [];
out = comps.GitChangesPanel({ cwd: null, onOpenFile: () => {}, onClose: () => {} });
check("GitChangesPanel noCwd 渲染无异常", !!out && typeof out === "object");
// 图谱视图：无 cwd（不触发拉取/轮询）
callLog = [];
out = comps.GitGraphPanel({ cwd: null, onOpenFile: () => {} });
check("GitGraphPanel noCwd 渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.GraphGlyph({ g: "|\\  " });
check("GraphGlyph 连线前缀渲染无异常(竖线+斜线)", !!out && typeof out === "object");
callLog = [];
out = comps.GraphGlyph({ g: "* | " });
check("GraphGlyph 圆点前缀渲染无异常(实心点+竖线)", !!out && typeof out === "object");
// 分支浮层：空态 + 列表态（无 hooks 依赖，直接渲染）
callLog = [];
out = comps.GitBranchMenu({ rect: { left: 20, top: 40 }, branches: null, busy: false, name: "", onName: () => {}, onCreate: () => {}, onSwitch: () => {}, onDelete: () => {}, onClose: () => {} });
check("GitBranchMenu 空态渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.GitBranchMenu({ rect: { left: 20, top: 40 }, branches: { branches: [
  { name: "main", isHead: true, upstream: null, track: "", trackParsed: null },
  { name: "dev", isHead: false, upstream: "origin/dev", track: "[ahead 1]", trackParsed: { ahead: 1, behind: 0, gone: false } },
] }, busy: false, name: "x", created: "dev", onName: () => {}, onCreate: () => {}, onSwitch: () => {}, onDelete: () => {}, onClose: () => {} });
check("GitBranchMenu 列表渲染无异常", !!out && typeof out === "object");
callLog = [];
out = comps.GitActionsMenu({ rect: { left: 20, top: 40 }, items: [{ key: "push", label: "推送", disabled: false, run: () => {} }], onClose: () => {} });
check("GitActionsMenu 渲染无异常", !!out && typeof out === "object");

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

// 9) KitConfigCard（插件设置卡）：ready 快照 + 覆盖态
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
