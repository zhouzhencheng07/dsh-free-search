// dsh-kit 浏览器半边 —— 手写 client bundle，与官方 lib/client.js 产物同形，
// 无构建步骤：改完本文件刷新浏览器即生效（本地目录 junction 直装）。
//
// 结构（入口在对话输入框工具行 + 面板挂全帧浮层 + 文件树动态接管浏览区）：
//   入口：conversation.input.left 列表槽（composer 工具行左端，官方"小型常驻
//     控件"座位）注册终端/文件树两个小图标钮；侧边栏底部不再有入口。开合状态
//     放模块级 store（kitUi + useSyncExternalStore），跨槽位共享。
//   面板：统一挂在 shell.overlay（全帧浮层、默认点击穿透、条目自带 pointer-events）
//     ——不放进 composer，规避其祖先 stacking context 劫持 position:fixed。
//   终端：底部停靠面板（Ctrl+` 亦可切换），数据走宿主半边 /dsh-kit/terminal WS。
//   文件树：打开时临时注册进单槽 sidebar.workspaces——把侧边栏浏览区整体换成
//     文件树，关闭时 dispose 注销、原生工作区列表自动回归。根目录 = 当前会话工作
//     目录，数据走宿主半边 /dsh-kit/tree。点击文件 → 右侧停靠面板预览内容（默认
//     开满宽度、对话左移让位、左缘可拖宽），数据走宿主半边 /dsh-kit/read。
//     面板让位用 body.dshk-pane-open + --dshk-pane-w，自绘不依赖原生 details 列。
// xterm 不打进 bundle，由宿主半边伺服 /dsh-kit/vendor/* 静态资源（官方预编译
// UMD），首次打开终端面板时按需加载。
//
// 外观跟随：面板 chrome 全部用 --dsw-alias-* 令牌（随 DSH 明暗主题自动切换）；
// xterm 需要具体色值，从 body 的 data-ds-dark-theme 属性判断明暗，
// 再读令牌的 computed 值做背景/前景，ANSI 用 VSCode 明/暗两套标准调色板，
// 并用 MutationObserver 监听属性变化热更新。
//
// 让位布局：打开终端时给 body 挂 dshk-open 类 + 根节点设 --dshk-dock-h，
// 样式规则把中列（对话）padding-bottom 顶开终端高度——对话窗口不被遮挡；
// 面板宽度也跟随对话列。类名匹配用语义后缀 _centerCol
// （全站仅 dsh-client-ui-layout 使用，已核实唯一）。
window.__ModuleLoader__.load({
  id: "dsh-kit",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");

    /** 终端面板高度（与让位 padding 共用一个变量） */
    const DOCK_H = "min(34vh, 330px)";

    /** apply 时捕获的 ctx；KitSurfaces 用它动态 register/dispose sidebar.workspaces 单槽 */
    let slotsCtx = null;

    // ─────────── 跨槽开合状态 ───────────
    // 入口按钮（conversation.input.left）与面板宿主（shell.overlay）是两个独立
    // 槽位组件，状态必须跨槽共享：模块级不可变快照 + useSyncExternalStore 订阅
    // （getSnapshot 返回模块绑定值，恒定引用直到 set 替换）。
    let kitUi = { terminalOpen: false, treeOpen: false, openFile: null, termCwd: null };
    const kitUiListeners = new Set();
    function setKitUi(patch) {
      kitUi = { ...kitUi, ...patch };
      for (const listener of kitUiListeners) listener();
    }
    function subscribeKitUi(listener) {
      kitUiListeners.add(listener);
      return () => kitUiListeners.delete(listener);
    }
    const useKitUi = () => react.useSyncExternalStore(subscribeKitUi, () => kitUi);

    // ─────────── 插件配置（任务5）───────────
    // 数据通道：官方 settings scope（宿主 installSettingsSection 注册的
    // dsh-kit 命名空间）。快照未就绪时一律回退内置默认——功能全开、默认键位。
    const CFG_DEFAULTS = {
      terminalEnabled: true,
      fileTreeEnabled: true,
      skillsPageEnabled: true,
      terminalShortcut: "Ctrl+`",
      fileTreeShortcut: "Ctrl+E",
    };
    /** 组合键规范化主键：单字符统一大写、空格记作 Space */
    function normComboKey(key) {
      return key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
    }
    /** 解析 "Ctrl+Alt+T" 形式为匹配结构；无主键或重复修饰键返回 null */
    function parseCombo(text) {
      const parts = String(text ?? "").trim().split("+").map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) return null;
      const out = { ctrl: false, alt: false, shift: false, meta: false, key: null };
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === "ctrl" && !out.ctrl) out.ctrl = true;
        else if (lower === "alt" && !out.alt) out.alt = true;
        else if (lower === "shift" && !out.shift) out.shift = true;
        else if (lower === "meta" && !out.meta) out.meta = true;
        else if (out.key === null) out.key = normComboKey(part);
        else return null;
      }
      return out.key === null ? null : out;
    }
    /** keydown 是否命中组合键 */
    function comboMatches(e, combo) {
      return (
        !!e.ctrlKey === combo.ctrl &&
        !!e.altKey === combo.alt &&
        !!e.shiftKey === combo.shift &&
        !!e.metaKey === combo.meta &&
        normComboKey(e.key) === combo.key
      );
    }
    /** keydown 转规范串（纯修饰键返回 null，调用方继续等待）；修饰键固定顺序 */
    function comboFromEvent(e) {
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Meta");
      parts.push(normComboKey(e.key));
      return parts.join("+");
    }
    /** 从官方 scope 快照提取生效配置（字段缺失/非法逐项回退默认） */
    function cfgFromSnapshot(snap) {
      if (!snap || snap.status !== "ready" || !snap.value || typeof snap.value !== "object") return { ...CFG_DEFAULTS };
      const v = snap.value;
      return {
        terminalEnabled: v.terminalEnabled !== false,
        fileTreeEnabled: v.fileTreeEnabled !== false,
        skillsPageEnabled: v.skillsPageEnabled !== false,
        terminalShortcut:
          typeof v.terminalShortcut === "string" && parseCombo(v.terminalShortcut)
            ? v.terminalShortcut
            : CFG_DEFAULTS.terminalShortcut,
        fileTreeShortcut:
          typeof v.fileTreeShortcut === "string" && parseCombo(v.fileTreeShortcut)
            ? v.fileTreeShortcut
            : CFG_DEFAULTS.fileTreeShortcut,
      };
    }
    // 模块级通道（apply 注入 / KitSurfaces 订阅 / 设置卡捕获互斥）
    let cfgScope = null;
    let shortcutCapture = null; // 正在录制快捷键的字段名；非 null 时面板快捷键监听让路
    const subscribeCfg = (listener) => (cfgScope ? cfgScope.subscribe(listener) : () => {});
    const getCfgSnapshot = () => (cfgScope ? cfgScope.getSnapshot() : null);

    // ─────────── 文案 ───────────
    const zh = {
      label: "终端",
      noCwd: "没有可用的会话工作区：先打开或创建一个会话",
      connecting: "连接中…",
      exited: "已退出",
      code: "代码",
      restart: "重新启动终端",
      close: "关闭终端面板",
      toggle: "切换终端（Ctrl+`）",
      vendorFail: "终端组件加载失败",
      treeLabel: "文件树",
      treeToggle: "切换文件树（Ctrl+E）",
      treeClose: "关闭文件树",
      treeRefresh: "刷新",
      treeLoading: "加载中…",
      treeEmpty: "（空目录）",
      treeFail: "加载失败",
      treeTruncated: "条目过多，列表已截断",
      chgTitle: "更改",
      chgEmpty: "（没有更改）",
      chgNotGit: "不是 git 仓库",
      openChg: "打开更改视图",
      chgClose: "关闭更改视图",
      contentClose: "关闭预览",
      edit: "编辑",
      editSave: "保存",
      editCancel: "取消",
      editSaved: "已保存",
      editFail: "保存失败",
      editConflict: "文件在打开后被外部修改，重新加载最新版本？",
      contentDiff: "查看 diff",
      contentText: "返回原文",
      diffFail: "diff 加载失败",
      diffEmpty: "（无未暂存差异）",
      diffUntracked: "未跟踪文件，暂无 diff",
      gitM: "已修改",
      gitA: "新文件",
      gitD: "已删除",
      gitR: "重命名",
      gitU: "未跟踪",
      gitTip: "git 变更",
      contentLoading: "加载中…",
      contentBinary: "二进制文件，无法预览",
      contentTruncated: "文件较大，仅显示前 512 KB",
      contentFail: "读取失败",
      contentEmpty: "（空文件）",
      skillsLabel: "技能",
      skRefresh: "刷新",
      skLoading: "加载中…",
      skFail: "加载失败",
      skEmpty: "（此组暂无技能）",
      skNotCreated: "未创建",
      skRankTip: "所在位置的扫描优先级（数值越小越优先）",
      skWorkspace: "工作区",
      skUserLevel: "用户级",
      skPool: "技能池",
      skOther: "其他来源（插件自带/运行时，只读）",
      skNoCwdHint: "当前没有会话工作区：只显示用户级与技能池",
      skDisabled: "已禁用",
      skShadowed: "被覆盖",
      skShadowTip: "同名技能在更高优先级位置生效（优先级：.dsh > .agents > $DSH_HOME/skills > ~/.agents/skills）",
      skByPlugin: "随插件",
      skHide: "收起",
      skView: "详情",
      skCopy: "复制",
      skMove: "移动",
      skPickTarget: "选择目标位置",
      skDisable: "禁用",
      skEnable: "启用",
      skDelete: "删除",
      skConfirmDelete: "确认删除？",
      skCancel: "取消",
      skOverwrite: "目标已存在同名技能，覆盖？",
      skOpFail: "操作失败",
      skDone: "完成",
      skDeleted: "已删除",
      cfgTitle: "套件（dsh-kit）",
      cfgDesc: "终端 / 文件树 / 技能页的功能开关与快捷键。",
      cfgTerminalEnabled: "启用终端",
      cfgTerminalEnabledHint: "关闭后隐藏输入框旁的终端按钮，快捷键一并失效。",
      cfgFileTreeEnabled: "启用文件树",
      cfgFileTreeEnabledHint: "关闭后隐藏输入框旁的文件树按钮，快捷键一并失效。",
      cfgSkillsPageEnabled: "启用技能页",
      cfgSkillsPageEnabledHint: "关闭后设置里不再显示「技能」页；技能本身不受影响。",
      cfgTerminalShortcut: "终端快捷键",
      cfgTerminalShortcutHint: "切换终端面板的组合键；需一个主键加至少一个修饰键（Ctrl/Alt/Shift/Meta）。",
      cfgFileTreeShortcut: "文件树快捷键",
      cfgFileTreeShortcutHint: "切换文件树的组合键；需一个主键加至少一个修饰键（Ctrl/Alt/Shift/Meta）。",
      cfgCapturing: "按下组合键…（Esc 取消）",
      cfgCapture: "修改",
      overridden: "已覆盖",
      resetDefault: "恢复默认",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      readOnly: "本部署的设置为只读。",
      loadingCfg: "正在读取配置…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      invalidCombo: "组合键需包含一个主键和至少一个修饰键。",
    };
    const en = {
      label: "Terminal",
      noCwd: "No session workspace available: open or create a session first",
      connecting: "Connecting…",
      exited: "Exited",
      code: "code",
      restart: "Restart terminal",
      close: "Close terminal panel",
      toggle: "Toggle terminal (Ctrl+`)",
      vendorFail: "Failed to load terminal components",
      treeLabel: "Files",
      treeToggle: "Toggle file tree (Ctrl+E)",
      treeClose: "Close file tree",
      treeRefresh: "Refresh",
      treeLoading: "Loading…",
      treeEmpty: "(empty)",
      treeFail: "Failed to load",
      treeTruncated: "Too many entries, list truncated",
      chgTitle: "Changes",
      chgEmpty: "(no changes)",
      chgNotGit: "Not a git repository",
      openChg: "Show changes view",
      chgClose: "Close changes view",
      contentClose: "Close preview",
      contentDiff: "View diff",
      contentText: "Back to text",
      diffFail: "Failed to load diff",
      diffEmpty: "(no unstaged changes)",
      diffUntracked: "Untracked file, no diff yet",
      gitM: "Modified",
      gitA: "Added",
      gitD: "Deleted",
      gitR: "Renamed",
      gitU: "Untracked",
      gitTip: "git change",
      edit: "Edit",
      editSave: "Save",
      editCancel: "Cancel",
      editSaved: "Saved",
      editFail: "Save failed",
      editConflict: "File changed on disk since it was loaded. Reload the latest version?",
      contentLoading: "Loading…",
      contentBinary: "Binary file, preview unavailable",
      contentTruncated: "File is large, only first 512 KB shown",
      contentFail: "Failed to read",
      contentEmpty: "(empty file)",
      skillsLabel: "Skills",
      skRefresh: "Refresh",
      skLoading: "Loading…",
      skFail: "Failed to load",
      skEmpty: "(no skills here)",
      skNotCreated: "not created",
      skRankTip: "Scan priority of this location (lower wins)",
      skWorkspace: "Workspace",
      skUserLevel: "User level",
      skPool: "Skill pool",
      skOther: "Other sources (plugin/runtime, read-only)",
      skNoCwdHint: "No session workspace: showing user-level and pool only",
      skDisabled: "Disabled",
      skShadowed: "Shadowed",
      skShadowTip: "A same-name skill at a higher-priority location takes effect (priority: .dsh > .agents > $DSH_HOME/skills > ~/.agents/skills)",
      skByPlugin: "Plugin-bundled",
      skHide: "Hide",
      skView: "Details",
      skCopy: "Copy",
      skMove: "Move",
      skPickTarget: "Pick destination",
      skDisable: "Disable",
      skEnable: "Enable",
      skDelete: "Delete",
      skConfirmDelete: "Confirm delete?",
      skCancel: "Cancel",
      skOverwrite: "A skill with the same name exists at the target. Overwrite?",
      skOpFail: "Operation failed",
      skDone: "Done",
      skDeleted: "Deleted",
      cfgTitle: "Kit (dsh-kit)",
      cfgDesc: "Feature switches and shortcuts for terminal / files / skills.",
      cfgTerminalEnabled: "Enable terminal",
      cfgTerminalEnabledHint: "Hides the terminal button next to the composer and disables its shortcut.",
      cfgFileTreeEnabled: "Enable file tree",
      cfgFileTreeEnabledHint: "Hides the file-tree button next to the composer and disables its shortcut.",
      cfgSkillsPageEnabled: "Enable skills page",
      cfgSkillsPageEnabledHint: "Removes the Skills entry from Settings (skills themselves are unaffected).",
      cfgTerminalShortcut: "Terminal shortcut",
      cfgTerminalShortcutHint: "Combo that toggles the terminal panel; needs a modifier (Ctrl/Alt/Shift/Meta) + a key.",
      cfgFileTreeShortcut: "File tree shortcut",
      cfgFileTreeShortcutHint: "Combo that toggles the file tree; needs a modifier (Ctrl/Alt/Shift/Meta) + a key.",
      cfgCapturing: "Press a combo… (Esc to cancel)",
      cfgCapture: "Change",
      overridden: "Overridden",
      resetDefault: "Reset to default",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      readOnly: "This deployment stores settings read-only.",
      loadingCfg: "Reading configuration…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      invalidCombo: "A combo needs one key plus at least one modifier.",
    };
    const lang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? zh : en;
    const t = (key) => lang[key] ?? key;

    // ─────────── 外观跟随 ───────────
    /** DSH 主题 presenter 以 body[data-ds-dark-theme] 有无表达明暗 */
    function isDark() {
      return typeof document !== "undefined" && document.body.hasAttribute("data-ds-dark-theme");
    }
    /** 读令牌 computed 值（xterm 需要具体色值），取不到时退回兜底色 */
    function tokenColor(name, fallback) {
      try {
        const v = getComputedStyle(document.body).getPropertyValue(name).trim();
        return v !== "" ? v : fallback;
      } catch {
        return fallback;
      }
    }
    const ANSI_DARK = {
      black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
      blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
      brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
      brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#ffffff",
    };
    const ANSI_LIGHT = {
      black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
      blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
      brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b2ba00",
      brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
    };
    /** 组装 xterm 调色板：背景/前景跟随应用令牌，ANSI 按明暗取标准套 */
    function xtermTheme() {
      const dark = isDark();
      const fg = tokenColor("--dsw-alias-label-primary", dark ? "#cccccc" : "#333333");
      return {
        background: tokenColor("--dsw-alias-bg-base", dark ? "#181818" : "#ffffff"),
        foreground: fg,
        cursor: fg,
        cursorAccent: tokenColor("--dsw-alias-bg-base", dark ? "#181818" : "#ffffff"),
        selectionBackground: dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)",
        ...(dark ? ANSI_DARK : ANSI_LIGHT),
      };
    }

    // ─────────── 样式 ───────────
    const UI_CSS = `
.dshk-dock{position:fixed;left:0;width:100%;bottom:0;height:var(--dshk-dock-h,${DOCK_H});display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l1);box-shadow:0 -6px 20px rgba(0,0,0,.14);z-index:800;pointer-events:auto}
.dshk-head{flex:none;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshk-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshk-sub{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
.dshk-status{color:var(--dsw-alias-label-tertiary)}
.dshk-spring{flex:1}
.dshk-btn{appearance:none;background:transparent;border:0;color:var(--dsw-alias-label-secondary);width:26px;height:26px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;padding:0}
.dshk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-body{flex:1 1 auto;min-height:0;padding:4px 8px 8px;position:relative}
.dshk-term{height:100%}
.dshk-term .xterm{height:100%}
.dshk-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
/* 让位布局：终端打开时把对话列顶起，内容不被遮挡（终端宽度即对话列宽） */
body.dshk-open [class*="_centerCol"]{padding-bottom:var(--dshk-dock-h,${DOCK_H})}
[class*="_centerCol"]{transition:padding-bottom .18s ease,margin-right .18s var(--ds-ease-in-out)}
@media (prefers-reduced-motion:reduce){[class*="_centerCol"]{transition:none}}
/* 文件树：作为 sidebar.workspaces 单槽 occupant 填满侧边栏浏览区（非浮层）。
   行/箭头对齐原生工作区树（Radius 8、padding 0 8、gap 6、hover 用 interactive-bg-hover） */
.dshk-tree{width:100%;height:100%;display:flex;flex-direction:column;pointer-events:auto}
.dshk-tree-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 4px 12px;font-size:13px}
.dshk-row{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;user-select:none}
.dshk-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-chev{width:16px;flex:none;display:inline-flex;justify-content:center;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
.dshk-arrow{transition:transform .15s var(--ds-ease-in-out);display:block}
.dshk-arrow-open{transform:rotate(90deg)}
.dshk-name{overflow:hidden;text-overflow:ellipsis}
.dshk-dir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.dshk-file .dshk-name{color:var(--dsw-alias-label-secondary)}
.dshk-note{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshk-enbtn[aria-pressed="true"]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
/* 文件预览面板：fixed 停靠右侧（自绘，不依赖原生 details 列，宽度自控 --dshk-pane-w） */
.dshk-pane{position:fixed;top:0;right:0;bottom:0;width:var(--dshk-pane-w,560px);display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-6px 0 20px rgba(0,0,0,.10);z-index:790;pointer-events:auto;transition:width .18s var(--ds-ease-in-out)}
.dshk-pane[data-dragging]{transition:none}
.dshk-pane-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 10px 12px}
.dshk-pane-pre{margin:0;padding:4px 0;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;tab-size:4;-webkit-overflow-scrolling:touch;user-select:text}
/* 拖拽手柄：面板左缘 6px 竖条，拖动更新 --dshk-pane-w */
.dshk-pane-handle{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:791;touch-action:none}
.dshk-pane-handle:hover::after{content:"";position:absolute;left:2px;top:0;bottom:0;width:2px;background:var(--dsw-alias-interactive-bg-hover);border-radius:2px}
/* 让位布局：面板打开时中列（对话）右侧让出 --dshk-pane-w，对话随之左移 */
body.dshk-pane-open [class*="_centerCol"]{margin-right:var(--dshk-pane-w,560px)}
@media (prefers-reduced-motion:reduce){body.dshk-pane-open [class*="_centerCol"]{transition:none}}
/* 技能管理页（settings.section）：三分组卡片；技能行单行布局，操作不换行、描述先收缩 */
.dshk-sk{font-size:13px;color:var(--dsw-alias-label-primary);user-select:text}
.dshk-sk-head{display:flex;align-items:center;gap:8px;margin:2px 0 10px}
.dshk-sk-title{font-weight:600;font-size:14px}
.dshk-sk-status{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshk-sk-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:12px;overflow:hidden}
.dshk-sk-group-head{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:12px}
.dshk-sk-group-dir{font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;text-align:right}
/* 单行：名称/徽标 flex:none，描述 flex:1 收缩截断，操作区不换行 */
.dshk-sk-row{display:flex;align-items:center;gap:8px;padding:7px 12px;min-width:0}
.dshk-sk-row ~ .dshk-sk-row{border-top:1px solid var(--dsw-alias-border-l1)}
.dshk-sk-name{font-weight:600;white-space:nowrap;flex:none}
.dshk-sk-name[data-disabled]{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.dshk-sk-badge{flex:none;font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-family:ui-monospace,Consolas,monospace}
.dshk-sk-badge-off{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.dshk-sk-desc{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.dshk-sk-actions{flex:none;display:flex;align-items:center;gap:5px}
.dshk-sk-btn{appearance:none;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:4px 9px;white-space:nowrap}
.dshk-sk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-sk-btn[data-danger="1"]{color:var(--dsw-alias-label-primary);font-weight:600;border-color:var(--dsw-alias-label-secondary)}
.dshk-sk-btn[disabled]{opacity:.5;cursor:default}
/* 展开式目标选择条：点复制/移动后出现在该行下方（同一时间只展开一行） */
.dshk-sk-target{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-top:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-l2)}
.dshk-sk-target-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshk-sk-detail{padding:2px 12px 10px}
.dshk-sk-pre{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
/* 插件设置卡（settings.plugin.item）：对齐官方 CardForm 观感 */
.dshk-cfg-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;margin:0}
.dshk-cfg-card[data-open]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshk-cfg-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}
.dshk-cfg-headtext{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dshk-cfg-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dshk-cfg-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshk-cfg-pill{flex:none;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshk-cfg-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s var(--ds-ease-in-out);display:block}
.dshk-cfg-chev[data-open]{transform:rotate(180deg)}
.dshk-cfg-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshk-cfg-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshk-cfg-field ~ .dshk-cfg-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dshk-cfg-fhead{display:flex;align-items:center;gap:8px}
.dshk-cfg-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshk-cfg-badges{display:inline-flex;align-items:center;gap:8px;flex:none;height:19px}
.dshk-cfg-badge{display:inline-flex;align-items:center;height:19px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dshk-cfg-reset{font:inherit;background:none;border:0;padding:0;height:18px;display:inline-flex;align-items:center;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dshk-cfg-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshk-cfg-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dshk-cfg-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshk-cfg-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.dshk-cfg-status{padding:6px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dshk-cfg-combo{appearance:none;font:inherit;font-family:ui-monospace,Consolas,monospace;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;line-height:1.5}
.dshk-cfg-combo:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-cfg-combo:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-cfg-combo[data-capturing]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}
.dshk-cfg-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}
.dshk-cfg-err{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.dshk-cfg-btn{appearance:none;font:inherit;cursor:pointer;font-size:13px;line-height:1.5;border-radius:8px;padding:5px 14px}
.dshk-cfg-btn-discard{background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshk-cfg-btn-save{border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff}
.dshk-cfg-btn[disabled]{opacity:.5;cursor:default}
/* 轻提示（双击复制路径等的单例浮层） */
.dshk-toast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%) translateY(8px);z-index:950;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 16px rgba(0,0,0,.12);opacity:0;pointer-events:none;transition:opacity .15s var(--ds-ease-in-out),transform .15s var(--ds-ease-in-out)}
.dshk-toast[data-show]{opacity:1;transform:translateX(-50%) translateY(0)}
/* git 徽标（任务4）与 diff 着色 */
.dshk-gitbadge{flex:none;margin-left:auto;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;border:1px solid currentColor}
.dshk-gitbadge[data-k="U"]{color:#73c991}
.dshk-gitbadge[data-k="A"]{color:#73c991}
.dshk-gitbadge[data-k="M"]{color:#e2c08d}
.dshk-gitbadge[data-k="R"]{color:#4daafc}
.dshk-gitbadge[data-k="D"]{color:#e7757f}
/* ±N 行数统计（更改清单行内） */
.dshk-nums{flex:none;display:inline-flex;gap:4px;font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:14px}
.dshk-nadd{color:#73c991}
.dshk-ndel{color:#e7757f}
/* 「更改」清单（VSCode 源代码管理式） */
.dshk-changes{margin:2px 4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.dshk-chg-head{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:11px}
.dshk-diff{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;padding:4px 0;white-space:pre;overflow-x:auto;user-select:text;color:var(--dsw-alias-label-secondary)}
.dshk-diff-add{color:#0dbc79;background:rgba(13,188,121,.08)}
.dshk-diff-del{color:#cd3131;background:rgba(205,49,49,.08)}
.dshk-diff-hunk{color:#4daafc}
.dshk-diff-meta{color:var(--dsw-alias-label-tertiary)}
/* 编辑模式（任务3） */
.dshk-edithost{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:4px 10px 12px}
.dshk-editbar{display:flex;align-items:center;gap:6px}
.dshk-editarea{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;padding:8px 10px;white-space:pre;overflow:auto}
.dshk-editarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-btn-save{appearance:none;border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff;border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 10px;cursor:pointer}
.dshk-btn-save[disabled]{opacity:.6;cursor:default}
.dshk-btn-cancel{appearance:none;background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 10px;cursor:pointer}
.dshk-btn-cancel:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
`;

    /** 注入 xterm.css（link）与本插件样式（style），幂等 */
    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="dsh-kit/ui"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-kit";
        tag.dataset.pluginCss = "dsh-kit/ui";
        tag.textContent = UI_CSS;
        document.head.appendChild(tag);
      }
      if (document.querySelector('link[data-plugin-css="dsh-kit/xterm"]') === null) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.dataset.plugin = "dsh-kit";
        link.dataset.pluginCss = "dsh-kit/xterm";
        link.href = "/dsh-kit/vendor/xterm.css";
        document.head.appendChild(link);
      }
    }

    // ─────────── vendor 按需加载 ───────────
    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("load failed: " + src));
        document.head.appendChild(s);
      });
    }
    let vendorPromise = null;
    /** 官方预编译 UMD：xterm.js → window.Terminal；addon-fit.js → window.FitAddon.FitAddon */
    function ensureVendor() {
      if (vendorPromise === null) {
        vendorPromise =
          typeof window.Terminal === "function" && window.FitAddon && typeof window.FitAddon.FitAddon === "function"
            ? Promise.resolve()
            : loadScript("/dsh-kit/vendor/xterm.js").then(() => loadScript("/dsh-kit/vendor/addon-fit.js"));
      }
      return vendorPromise;
    }

    // ─────────── 轻提示 ───────────
    let toastTimer = 0;
    let toastEl = null;
    /** 轻提示：单例浮层，1.6s 自动淡出 */
    function flashToast(message) {
      if (typeof document === "undefined") return;
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "dshk-toast";
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = message;
      toastEl.setAttribute("data-show", "");
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        if (toastEl) toastEl.removeAttribute("data-show");
      }, 1600);
    }

    // ─────────── 当前会话工作区 ───────────
    // 选择器必须返回稳定引用（uSES getSnapshot 约束），派生放在选择器外。
    function useCurrentCwd(props) {
      const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      const useWorkspaces = props && typeof props.useWorkspaces === "function" ? props.useWorkspaces : null;
      const current = useSessions ? useSessions((s) => s.current) : undefined;
      const summary = useSessions ? useSessions((s) => (current ? s.byId[current] : undefined)) : undefined;
      const recentId = useWorkspaces ? useWorkspaces((s) => s.recentWorkspaceId) : undefined;
      const items = useWorkspaces ? useWorkspaces((s) => s.items) : undefined;
      if (summary && typeof summary.cwd === "string" && summary.cwd.trim() !== "") return summary.cwd;
      if (items && recentId) {
        const ws = items.find((w) => w.workspaceId === recentId);
        if (ws && typeof ws.path === "string" && ws.path.trim() !== "") return ws.path;
      }
      return null;
    }

    // ─────────── 终端面板 ───────────
    function TerminalPanel({ cwd, onClose }) {
      const bodyRef = react.useRef(null);
      const [nonce, setNonce] = react.useState(0);
      const [state, setState] = react.useState({ phase: "connecting", detail: "" });
      // 宽度跟随对话列：测量 _centerCol 的视口位置（侧栏开合/拖宽/窗口缩放都会触发）
      const [pos, setPos] = react.useState(null);

      react.useLayoutEffect(() => {
        const el = document.querySelector('[class*="_centerCol"]');
        if (!el) return undefined;
        const update = () => {
          const r = el.getBoundingClientRect();
          if (r.width > 0) setPos({ left: Math.max(0, r.left), width: r.width });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      react.useEffect(() => {
        if (!cwd) {
          setState({ phase: "error", detail: t("noCwd") });
          return undefined;
        }
        let disposed = false;
        setState({ phase: "connecting", detail: "" });

        let term = null;
        let host = null;
        let ws = null;
        let fitAddon = null;
        let resizeTimer = 0;
        let themeObserver = null;

        const sendResize = () => {
          if (disposed || !term || !fitAddon) return;
          try {
            fitAddon.fit();
          } catch {
            return;
          }
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
          }
        };
        const scheduleResize = () => {
          if (resizeTimer || disposed) return;
          resizeTimer = window.setTimeout(() => {
            resizeTimer = 0;
            sendResize();
          }, 60);
        };
        const ro = new ResizeObserver(scheduleResize);

        ensureVendor()
          .then(() => {
            if (disposed) return;
            term = new window.Terminal({
              fontSize: 13,
              lineHeight: 1.25,
              fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", "Courier New", monospace',
              cursorBlink: true,
              scrollback: 5000,
              theme: xtermTheme(),
            });
            // DSH 明暗切换时热更新调色板（presenter 改 body 属性）
            themeObserver = new MutationObserver(() => {
              if (!disposed && term) {
                try {
                  term.options.theme = xtermTheme();
                } catch {
                  // 忽略
                }
              }
            });
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
            fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            host = document.createElement("div");
            host.className = "dshk-term";
            bodyRef.current.appendChild(host);
            term.open(host);
            try {
              fitAddon.fit();
            } catch {
              // ResizeObserver 会再触发
            }
            term.onData((d) => {
              if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
            });
            ro.observe(bodyRef.current);

            ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/dsh-kit/terminal`);
            ws.onopen = () => {
              ws.send(JSON.stringify({ t: "init", cwd, cols: term.cols, rows: term.rows }));
            };
            ws.onmessage = (ev) => {
              let m;
              try {
                m = JSON.parse(ev.data);
              } catch {
                return;
              }
              if (!m || typeof m !== "object") return;
              if (m.t === "o" && typeof m.d === "string") {
                term.write(m.d);
              } else if (m.t === "started") {
                setState({ phase: "ready", detail: m.shell ?? "" });
                term.focus();
              } else if (m.t === "exit") {
                setState({ phase: "exited", detail: String(m.exitCode ?? "") });
                term.write(`\r\n\x1b[90m[${t("exited")} · ${t("code")} ${m.exitCode}]\x1b[0m\r\n`);
              } else if (m.t === "error") {
                setState({ phase: "error", detail: String(m.message ?? "") });
                term.write(`\r\n\x1b[31m${m.message ?? ""}\x1b[0m\r\n`);
              }
            };
            ws.onclose = () => {
              if (!disposed) {
                setState((s) => (s.phase === "ready" || s.phase === "connecting" ? { phase: "exited", detail: "" } : s));
              }
            };
          })
          .catch((error) => {
            if (!disposed) setState({ phase: "error", detail: `${t("vendorFail")}: ${error?.message ?? error}` });
          });

        return () => {
          disposed = true;
          if (resizeTimer) window.clearTimeout(resizeTimer);
          ro.disconnect();
          if (themeObserver) themeObserver.disconnect();
          if (ws) {
            ws.onclose = null;
            try {
              ws.close();
            } catch {
              // 已关闭
            }
          }
          if (term) {
            try {
              term.dispose();
            } catch {
              // 已释放
            }
          }
          if (host) host.remove();
        };
      }, [cwd, nonce]);

      const statusText =
        state.phase === "connecting"
          ? t("connecting")
          : state.phase === "exited"
            ? `${t("exited")}${state.detail !== "" ? ` · ${t("code")} ${state.detail}` : ""}`
            : "";

      return jsxRuntime.jsxs("div", {
        className: "dshk-dock",
        style: pos ? { left: pos.left, width: pos.width } : undefined,
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-title", children: t("label") }),
              cwd
                ? jsxRuntime.jsx("span", {
                    className: "dshk-sub",
                    title: cwd,
                    children: `${state.detail && state.phase === "ready" ? `${state.detail} · ` : ""}${cwd}`,
                  })
                : null,
              statusText !== "" ? jsxRuntime.jsx("span", { className: "dshk-status", children: statusText }) : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("restart"),
                onClick: () => setNonce((n) => n + 1),
                children: "⟳",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("close"),
                onClick: onClose,
                children: "✕",
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-body",
            ref: bodyRef,
            children: !cwd ? jsxRuntime.jsx("div", { className: "dshk-msg", children: t("noCwd") }) : null,
          }),
        ],
      });
    }

    // ─────────── 文件树 ───────────
    // 数据走宿主半边只读端点 /dsh-kit/tree（官方 browse RPC 只列目录不列文件）。
    function fetchTree(path, signal) {
      return fetch(`/dsh-kit/tree?path=${encodeURIComponent(path)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !Array.isArray(body.entries)) {
          throw new Error((body && body.error) || `HTTP ${res.status}`);
        }
        return body;
      });
    }

    /** git 状态（任务4）：available:false = 非 git 目录，前端隐藏徽标 */
    function fetchGitStatus(cwd, signal) {
      return fetch(`/dsh-kit/git/status?cwd=${encodeURIComponent(cwd)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
    }

    /** 文件行尾的 git 状态小徽标（M/A/D/R/U） */
    function GitBadge({ xy }) {
      const s = String(xy).trim();
      const label = s === "?" ? "U" : s || "M";
      const tipMap = { M: "gitM", A: "gitA", D: "gitD", R: "gitR", U: "gitU" };
      return jsxRuntime.jsx("span", {
        className: "dshk-gitbadge",
        "data-k": label,
        title: `${t(tipMap[label] ?? "gitTip")}（${String(xy)}）`,
        children: label,
      });
    }

    /** git 状态轮询周期（①+③ 刷新机制）：可见时低频拉取，回窗口/聚焦立即补一次 */
    const GIT_POLL_MS = 4000;

    function FolderIcon() {
      return jsxRuntime.jsx(
        "svg",
        {
          width: 15,
          height: 15,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          children: jsxRuntime.jsx("path", {
            d: "M1.5 3.5c0-.55.45-1 1-1h3.2l1.6 1.8h6.2c.55 0 1 .45 1 1v7.2c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-9z",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.2,
            strokeLinejoin: "round",
          }),
        },
      );
    }

    /** 分支图标（进入更改视图的入口钮）：git branch 风格两节点一弧线 */
    function BranchIcon() {
      return jsxRuntime.jsxs(
        "svg",
        {
          width: 15,
          height: 15,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          children: [
            jsxRuntime.jsx("circle", { cx: 4, cy: 3.5, r: 1.7 }),
            jsxRuntime.jsx("circle", { cx: 4, cy: 12.5, r: 1.7 }),
            jsxRuntime.jsx("circle", { cx: 11.5, cy: 6, r: 1.7 }),
            jsxRuntime.jsx("path", { d: "M4 5.2v5.6" }),
            jsxRuntime.jsx("path", { d: "M11.4 7.7c-.3 2.1-2.6 2.5-5.6 3" }),
          ],
        },
      );
    }

    /** 终端图标：与 FolderIcon 同为描边风格（16 网格），保证两个 footer 按钮观感一致 */
    function TerminalIcon() {
      return jsxRuntime.jsxs(
        "svg",
        {
          width: 15,
          height: 15,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: [
            jsxRuntime.jsx("path", { d: "M2 4.5h12v8H2z" }),
            jsxRuntime.jsx("path", { d: "M4.4 7.2l1.8 1.3-1.8 1.3" }),
            jsxRuntime.jsx("path", { d: "M8.5 9.3h2.6" }),
          ],
        },
      );
    }

    /** 展开箭头：对齐原生工作区树的 IconTriangleRightFill14（右向实心三角，展开时 rotate 90° 朝下） */
    function ChevronIcon({ open }) {
      return jsxRuntime.jsx(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          "aria-hidden": true,
          className: `dshk-arrow${open ? " dshk-arrow-open" : ""}`,
          children: jsxRuntime.jsx("path", { d: "M4 3l5 4-5 4z", fill: "currentColor" }),
        },
      );
    }

    /** 单层目录状态：{status:'loading'|'ready'|'error', entries?, truncated?, error?} */
    function TreeNode({ entry, depth, expanded, onToggle, onOpenFile, gitMap }) {
      const info = entry.dir ? expanded[entry.path] : undefined;
      const rows = [jsxRuntime.jsxs("div", {
        className: `dshk-row${entry.dir ? "" : " dshk-file"}`,
        style: { paddingLeft: 8 + depth * 14 },
        title: entry.path,
        onClick: () => (entry.dir ? onToggle(entry) : onOpenFile(entry.path)),
        children: [
          jsxRuntime.jsx("span", { className: "dshk-chev", children: entry.dir ? jsxRuntime.jsx(ChevronIcon, { open: !!info }) : null }),
          jsxRuntime.jsx("span", { className: "dshk-name", children: entry.name }),
          !entry.dir && gitMap && gitMap.has(entry.path)
            ? jsxRuntime.jsx(GitBadge, { xy: gitMap.get(entry.path) })
            : null,
        ],
      }, entry.path)];
      if (entry.dir && info) {
        if (info.status === "loading") {
          rows.push(jsxRuntime.jsx("div", { className: "dshk-note", style: { paddingLeft: 8 + (depth + 1) * 14 }, children: t("treeLoading") }, `${entry.path}::loading`));
        } else if (info.status === "error") {
          rows.push(jsxRuntime.jsx("div", { className: "dshk-note", style: { paddingLeft: 8 + (depth + 1) * 14 }, title: info.error ?? "", children: `${t("treeFail")}${info.error ? `：${info.error}` : ""}` }, `${entry.path}::error`));
        } else if (info.entries.length === 0) {
          rows.push(jsxRuntime.jsx("div", { className: "dshk-note", style: { paddingLeft: 8 + (depth + 1) * 14 }, children: t("treeEmpty") }, `${entry.path}::empty`));
        } else {
          for (const child of info.entries) {
            rows.push(jsxRuntime.jsx(TreeNode, { entry: child, depth: depth + 1, expanded, onToggle, onOpenFile, gitMap }, child.path));
          }
          if (info.truncated) {
            rows.push(jsxRuntime.jsx("div", { className: "dshk-note", style: { paddingLeft: 8 + (depth + 1) * 14 }, children: t("treeTruncated") }, `${entry.path}::truncated`));
          }
        }
      }
      return jsxRuntime.jsxs(jsxRuntime.Fragment, { children: rows });
    }

    function FileTreePanel({ cwd, onOpenFile }) {
      // expanded: 路径 → 目录单层状态；根目录就是 cwd
      const [expanded, setExpanded] = react.useState({});
      // 供 nonce 刷新 effect 读取最新展开集合（保留展开状态用）
      const expandedRef = react.useRef({});
      expandedRef.current = expanded;
      const [nonce, setNonce] = react.useState(0);
      // git 状态：绝对路径 → xy；null = 未加载，空 Map = 非 git/无变更
      const [gitMap, setGitMap] = react.useState(null);
      const [gitRoot, setGitRoot] = react.useState(null);
      const abortsRef = react.useRef(new Set());
      // 拉取 git 状态落到 gitMap/gitRoot；每次渲染重赋以捕获最新 cwd
      const gitFetchRef = react.useRef(null);
      gitFetchRef.current = () => {
        if (!cwd) return;
        const c = new AbortController();
        abortsRef.current.add(c);
        fetchGitStatus(cwd, c.signal)
          .then((gitBody) => {
            abortsRef.current.delete(c);
            if (c.signal.aborted) return;
            if (!gitBody.available) {
              setGitMap(new Map());
              setGitRoot(null);
              return;
            }
            const m = new Map();
            for (const e of gitBody.entries ?? []) m.set(e.abs, e.xy);
            setGitMap(m);
            setGitRoot(gitBody.root ?? null);
          })
          .catch(() => {
            abortsRef.current.delete(c);
            if (!c.signal.aborted) setGitMap(new Map());
          });
      };

      const loadDir = (dirPath) => {
        const controller = new AbortController();
        abortsRef.current.add(controller);
        setExpanded((m) => ({ ...m, [dirPath]: { status: "loading" } }));
        fetchTree(dirPath, controller.signal)
          .then((body) => {
            setExpanded((m) => ({
              ...m,
              [dirPath]: { status: "ready", entries: body.entries, truncated: body.truncated === true },
            }));
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
            setExpanded((m) => ({ ...m, [dirPath]: { status: "error", error: String(error?.message ?? error) } }));
          })
          .finally(() => {
            abortsRef.current.delete(controller);
          });
      };

      // cwd 切换：整树重置（展开状态不保留——那是另一棵树）
      react.useEffect(() => {
        abortsRef.current.forEach((c) => c.abort());
        abortsRef.current.clear();
        setGitMap(null);
        setGitRoot(null);
        if (!cwd) {
          setExpanded({});
          return undefined;
        }
        setExpanded({ [cwd]: { status: "loading" } });
        loadDir(cwd);
        // 打开/⟳ 时立即拉一次 git 状态（此后由轮询 effect 接管）
        if (gitFetchRef.current) gitFetchRef.current();
        return () => {
          abortsRef.current.forEach((c) => c.abort());
          abortsRef.current.clear();
        };
      }, [cwd]);

      // ⟳ 手动刷新：保留展开状态，只重拉根与所有已展开层的内容（树是懒加载的，
      // 展开过的目录才需要刷新；未展开的下层等用户点开时自然拉最新）
      react.useEffect(() => {
        if (!nonce || !cwd) return undefined;
        if (gitFetchRef.current) gitFetchRef.current();
        const keys = Object.keys(expandedRef.current);
        const next = {};
        for (const k of keys) next[k] = { status: "loading" };
        setExpanded(next);
        for (const k of keys) loadDir(k);
        return undefined;
      }, [nonce]);

      // 刷新机制（①+③，用户定 2026-08-23）：面板可见时每 GIT_POLL_MS 拉一次
      // git 状态；标签页转回可见 / 窗口聚焦时立即补一次。隐藏时完全静默。
      react.useEffect(() => {
        if (!cwd) return undefined;
        const tick = () => {
          if (document.visibilityState !== "hidden" && gitFetchRef.current) gitFetchRef.current();
        };
        const timer = window.setInterval(tick, GIT_POLL_MS);
        document.addEventListener("visibilitychange", tick);
        window.addEventListener("focus", tick);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", tick);
          window.removeEventListener("focus", tick);
        };
      }, [cwd]);

      const toggleDir = (entry) => {
        setExpanded((m) => {
          if (m[entry.path]) {
            const next = { ...m };
            delete next[entry.path];
            return next;
          }
          return { ...m, [entry.path]: { status: "loading" } };
        });
        if (!expanded[entry.path]) loadDir(entry.path);
      };

      const rootInfo = cwd ? expanded[cwd] : undefined;

      return jsxRuntime.jsxs("div", {
        className: "dshk-tree",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx(FolderIcon, {}),
              // 显示当前目录路径（不显示"文件树"文字），过长时省略号，hover 悬浮看全
              jsxRuntime.jsx("span", { className: "dshk-dir", title: cwd ?? "", children: cwd ?? t("treeLabel") }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("openChg"),
                onClick: () => setKitUi({ gitOpen: true }),
                children: jsxRuntime.jsx(BranchIcon, {}),
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeRefresh"),
                onClick: () => setNonce((n) => n + 1),
                children: "⟳",
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-tree-body",
            children:
              !cwd
              ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("noCwd") })
              : !rootInfo || rootInfo.status === "loading"
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") })
                : rootInfo.status === "error"
                  ? jsxRuntime.jsx("div", { className: "dshk-note", title: rootInfo.error ?? "", children: `${t("treeFail")}${rootInfo.error ? `：${rootInfo.error}` : ""}` })
                  : rootInfo.entries.length === 0
                    ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeEmpty") })
                    : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          rootInfo.entries.map((entry) =>
                            jsxRuntime.jsx(TreeNode, { entry, depth: 0, expanded, onToggle: toggleDir, onOpenFile, gitMap }, entry.path),
                          ),
                          rootInfo.truncated
                            ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeTruncated") })
                            : null,
                        ],
                      }),
          }),
        ],
      });
    }

    // ─────────── 更改视图（sidebar.workspaces 的 git 模式，VSCode 源代码管理式）───────────
    // 文件树头部分支按钮进入；占用与文件树相同的单槽（互斥），✕ 关闭回到文件树。
    // 数据=完整 status entries（含 stats ±N），轮询节奏同 ①+③。
    function GitChangesPanel({ cwd, onOpenFile, onClose }) {
      const [data, setData] = react.useState(null); // null=加载中；{available, root?, entries?}
      const fetchRef = react.useRef(null);
      fetchRef.current = () => {
        if (!cwd) return;
        const c = new AbortController();
        fetchGitStatus(cwd, c.signal)
          .then((b) => {
            if (!c.signal.aborted) setData(b);
          })
          .catch(() => {});
      };
      react.useEffect(() => {
        if (fetchRef.current) fetchRef.current();
        const tick = () => {
          if (document.visibilityState !== "hidden" && fetchRef.current) fetchRef.current();
        };
        const timer = window.setInterval(tick, GIT_POLL_MS);
        document.addEventListener("visibilitychange", tick);
        window.addEventListener("focus", tick);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", tick);
          window.removeEventListener("focus", tick);
        };
      }, [cwd]);

      const available = data !== null && data.available === true;
      const entries = available && Array.isArray(data.entries) ? data.entries : [];
      const root = available ? data.root ?? null : null;

      return jsxRuntime.jsxs("div", {
        className: "dshk-tree",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx(BranchIcon, {}),
              jsxRuntime.jsx("span", { className: "dshk-dir", title: root ?? "", children: t("chgTitle") }),
              available && entries.length > 0
                ? jsxRuntime.jsx("span", { className: "dshk-status", children: String(entries.length) })
                : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeRefresh"),
                onClick: () => { if (fetchRef.current) fetchRef.current(); },
                children: "⟳",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("chgClose"),
                onClick: onClose,
                children: "✕",
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-tree-body",
            children:
              !cwd
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("noCwd") })
                : data === null
                  ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") })
                  : !available
                    ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("chgNotGit") })
                    : entries.length === 0
                      ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("chgEmpty") })
                      : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                          children: entries.map((item) => {
                            const rel =
                              root && item.abs.startsWith(root)
                                ? item.abs.slice(root.length).replace(/^[\\/]/, "")
                                : item.path;
                            const segs = rel.split(/[\\/]/);
                            const name = segs[segs.length - 1];
                            const dir = segs.slice(0, -1).join("/");
                            return jsxRuntime.jsxs(
                              "div",
                              {
                                className: "dshk-row dshk-chg-row",
                                title: item.abs,
                                onClick: () => onOpenFile(item.abs),
                                children: [
                                  jsxRuntime.jsx("span", { className: "dshk-name", children: name }),
                                  dir !== "" ? jsxRuntime.jsx("span", { className: "dshk-dir", title: rel, children: dir }) : null,
                                  item.stats
                                    ? jsxRuntime.jsxs("span", { className: "dshk-nums", children: [
                                        jsxRuntime.jsx("span", { className: "dshk-nadd", children: `+${item.stats.a}` }),
                                        jsxRuntime.jsx("span", { className: "dshk-ndel", children: `−${item.stats.d}` }),
                                      ] })
                                    : null,
                                  jsxRuntime.jsx(GitBadge, { xy: item.xy }),
                                ],
                              },
                              item.abs,
                            );
                          }),
                        }),
          }),
        ],
      });
    }

    // ─────────── 文件内容预览（右侧停靠面板，自绘）───────────
    // 点击文件树中的文件 → 打开右侧 fixed 停靠面板展示内容（不依赖原生 details
    // 槽/ctx.layout：openDetails 默认宽只有 360 且无法从动态插件调 setDetails）。
    // 让位布局：挂 body.dshk-pane-open 类 + 根节点设 --dshk-pane-w，
    // 样式规则把中列（对话）margin-right 顶开面板宽度——对话左移，内容不被遮挡。
    // 默认宽度即最大（左移到底），左缘拖拽手柄可收窄/放宽。
    function FileContentPane({ path, cwd, onClose }) {
      const [state, setState] = react.useState({ phase: "loading" });
      const [dragging, setDragging] = react.useState(false);
      // 任务4：git 视图状态——xy=null 表示无变更或非仓库；diff 数据懒加载
      const [xy, setXy] = react.useState(null);
      const [mode, setMode] = react.useState("text");
      const [diff, setDiff] = react.useState({ phase: "loading" });
      const [diffNonce, setDiffNonce] = react.useState(0);
      // 任务3：编辑态（draft 受控 textarea；reloadNonce 供 409 冲突后重读）
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [reloadNonce, setReloadNonce] = react.useState(0);
      // 拖过的宽度（px）；0 = 未拖过，用 CSS fallback 默认宽度
      const widthRef = react.useRef(0);
      const dragRef = react.useRef(null);

      // git 状态获取（轮询版）：路径/打开时立即一次，可见期间每 GIT_POLL_MS 跟随，
      // 转回可见/聚焦立即补；处于 diff 视图时顺带重拉 diff，AI 边改边看也能跟上
      const xyFetchRef = react.useRef(null);
      xyFetchRef.current = () => {
        if (!cwd) return;
        const c = new AbortController();
        fetchGitStatus(cwd, c.signal)
          .then((b) => {
            if (c.signal.aborted || !b.available) return;
            const hit = (b.entries ?? []).find((e) => e.abs === path);
            setXy(hit ? hit.xy : null);
          })
          .catch(() => {});
      };
      react.useEffect(() => {
        setMode("text");
        setXy(null);
        setDiff({ phase: "loading" });
        if (!cwd) return undefined;
        if (xyFetchRef.current) xyFetchRef.current();
        const tick = () => {
          if (document.visibilityState === "hidden") return;
          if (xyFetchRef.current) xyFetchRef.current();
          if (mode === "diff") setDiffNonce((n) => n + 1);
        };
        const timer = window.setInterval(tick, GIT_POLL_MS);
        document.addEventListener("visibilitychange", tick);
        window.addEventListener("focus", tick);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", tick);
          window.removeEventListener("focus", tick);
        };
      }, [path, cwd]);

      // diff 懒加载：切到 diff 视图才请求
      react.useEffect(() => {
        if (mode !== "diff") return undefined;
        const c = new AbortController();
        setDiff({ phase: "loading" });
        fetch(`/dsh-kit/git/diff?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd ?? path)}`, { signal: c.signal })
          .then(async (res) => {
            const b = await res.json().catch(() => null);
            if (!res.ok || !b || b.available !== true) throw new Error(b?.error ?? `HTTP ${res.status}`);
            return b;
          })
          .then((b) => {
            if (!c.signal.aborted)
              setDiff({ phase: "ready", untracked: b.untracked === true, clean: b.clean === true, text: typeof b.diff === "string" ? b.diff : null });
          })
          .catch((error) => {
            if (!c.signal.aborted) setDiff({ phase: "error", error: String(error?.message ?? error) });
          });
        return () => c.abort();
      }, [mode, path, cwd, diffNonce]);

      // 挂让位类 + 初始宽度直接拉满（左移到底）；卸载复原。
      // useLayoutEffect：变量在绘制前就位，避免打开瞬间先画 fallback 宽度再过渡。
      react.useLayoutEffect(() => {
        document.body.classList.add("dshk-pane-open");
        // 默认即最大宽度：给对话列至少留 880px（含侧边栏），上限 720
        const maxW = Math.min(720, Math.max(520, window.innerWidth - 880));
        widthRef.current = maxW;
        document.documentElement.style.setProperty("--dshk-pane-w", `${maxW}px`);
        return () => {
          document.body.classList.remove("dshk-pane-open");
          document.documentElement.style.removeProperty("--dshk-pane-w");
        };
      }, []);

      // 拖拽：window 级 pointermove/up，更新 --dshk-pane-w（对话让位同步）
      react.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          const dx = d.startX - e.clientX; // 往左拖 → 面板变宽
          const maxW = Math.min(720, Math.max(520, window.innerWidth - 880));
          const w = Math.min(maxW, Math.max(320, d.startW + dx));
          widthRef.current = w;
          document.documentElement.style.setProperty("--dshk-pane-w", `${w}px`);
        };
        const onUp = () => {
          dragRef.current = null;
          setDragging(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        };
      }, [dragging]);

      const onHandleDown = (e) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startW: widthRef.current > 0 ? widthRef.current : 560 };
        setDragging(true);
      };

      react.useEffect(() => {
        const controller = new AbortController();
        setState({ phase: "loading" });
        fetch(`/dsh-kit/read?path=${encodeURIComponent(path)}`, { signal: controller.signal })
          .then(async (res) => {
            const body = await res.json().catch(() => null);
            if (!res.ok || !body || typeof body.content === "undefined") {
              throw new Error((body && body.error) || `HTTP ${res.status}`);
            }
            return body;
          })
          .then((body) => {
            if (controller.signal.aborted) return;
            setState({ phase: "ready", body });
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
            setState({ phase: "error", error: String(error?.message ?? error) });
          });
        return () => controller.abort();
      }, [path, reloadNonce]);

      const base = path.split(/[\\/]/).pop() || path;
      const displayPath = cwd && path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]/, "") : path;

      /** diff 视图：按行首 +/-/@@ 着色（自绘，不引库） */
      const renderDiffView = () => {
        if (diff.phase === "loading") return jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") });
        if (diff.phase === "error")
          return jsxRuntime.jsx("div", { className: "dshk-note", title: diff.error, children: `${t("diffFail")}：${diff.error}` });
        if (diff.untracked) return jsxRuntime.jsx("div", { className: "dshk-note", children: t("diffUntracked") });
        if (diff.clean || diff.text === null) return jsxRuntime.jsx("div", { className: "dshk-note", children: t("diffEmpty") });
        const lines = diff.text.split("\n");
        return jsxRuntime.jsx("div", {
          className: "dshk-diff",
          children: lines.map((line, i) => {
            const cls = line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : line.startsWith("@@")
                  ? "hunk"
                  : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
                    ? "meta"
                    : "ctx";
            return jsxRuntime.jsx("div", { className: `dshk-diff-${cls}`, children: line === "" ? " " : line }, i);
          }),
        });
      };

      /** 编辑态 UI：工具条（保存/取消/未保存提示）+ 受控 textarea */
      const renderEditor = () =>
        jsxRuntime.jsxs("div", {
          className: "dshk-edithost",
          children: [
            jsxRuntime.jsxs("div", {
              className: "dshk-editbar",
              children: [
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "dshk-btn-save",
                  disabled: saving,
                  onClick: saveEdit,
                  children: t(saving ? "saving" : "editSave"),
                }),
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "dshk-btn-cancel",
                  disabled: saving,
                  onClick: () => setEditing(false),
                  children: t("editCancel"),
                }),
                state.body && draft !== state.body.content
                  ? jsxRuntime.jsx("span", { className: "dshk-status", children: t("unsaved") })
                  : null,
              ],
            }),
            jsxRuntime.jsx("textarea", {
              className: "dshk-editarea",
              value: draft,
              spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
            }),
          ],
        });

      const startEdit = () => {
        // 截断预览的文件不允许编辑（保存会丢掉 512KB 之后的内容）
        if (!state.body || state.body.binary || state.body.content === null || state.body.truncated) return;
        setDraft(state.body.content);
        setEditing(true);
      };

      /** 保存：POST /dsh-kit/write（cwd 子树校验 + mtime CAS）；409 → 询问重载 */
      const saveEdit = () => {
        if (saving || !state.body) return;
        setSaving(true);
        fetch("/dsh-kit/write", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, cwd, content: draft, baseMtime: state.body.mtimeMs }),
        })
          .then(async (res) => {
            const b = await res.json().catch(() => ({}));
            if (res.status === 409) {
              if (window.confirm(t("editConflict"))) {
                setEditing(false);
                setReloadNonce((n) => n + 1);
              }
              return;
            }
            if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
            setState((s) => ({ ...s, body: { ...s.body, content: draft, mtimeMs: typeof b.mtimeMs === "number" ? b.mtimeMs : s.body.mtimeMs } }));
            setEditing(false);
            flashToast(t("editSaved"));
            if (xyFetchRef.current) xyFetchRef.current(); // 保存后立即刷新 git 状态（⇄ 出现）
          })
          .catch((error) => {
            flashToast(`${t("editFail")}：${error?.message ?? error}`);
          })
          .finally(() => setSaving(false));
      };

      let body;
      if (state.phase === "loading") {
        body = jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") });
      } else if (state.phase === "error") {
        body = jsxRuntime.jsx("div", { className: "dshk-note", title: state.error, children: `${t("contentFail")}：${state.error}` });
      } else {
        const b = state.body;
        if (b.binary) {
          body = jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentBinary") });
        } else if (b.content === null || b.content === "") {
          body = jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentEmpty") });
        } else {
          body = jsxRuntime.jsxs("div", {
            className: "dshk-pane-body",
            children: [
              b.truncated ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentTruncated") }) : null,
              jsxRuntime.jsx("pre", { className: "dshk-pane-pre", children: b.content }),
            ],
          });
        }
      }

      return jsxRuntime.jsxs("div", {
        className: "dshk-pane",
        "data-dragging": dragging || undefined,
        children: [
          jsxRuntime.jsx("div", {
            className: "dshk-pane-handle",
            onPointerDown: onHandleDown,
          }),
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-title", children: base }),
              jsxRuntime.jsx("span", { className: "dshk-dir", title: path, children: displayPath }),
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              state.phase === "ready" && state.body && !state.body.binary && !state.body.truncated && !editing
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("edit"),
                    onClick: startEdit,
                    children: "✎",
                  })
                : null,
              xy
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t(mode === "text" ? "contentDiff" : "contentText"),
                    onClick: () => setMode(mode === "text" ? "diff" : "text"),
                    children: "⇄",
                  })
                : null,
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("contentClose"),
                onClick: onClose,
                children: "✕",
              }),
            ],
          }),
          editing
            ? renderEditor()
            : mode === "diff" && xy
              ? renderDiffView()
              : body,
        ],
      });
    }

    // ─────────── 入口按钮（conversation.input.left）───────────
    // 只负责开合与按压态；面板本体在 KitSurfaces（shell.overlay）渲染。
    function TerminalEntry(props) {
      const ui = useKitUi();
      const cwd = useCurrentCwd(props);
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": ui.terminalOpen,
        title: t("toggle"),
        onClick: () => {
          // 打开那一刻固定当时的会话工作区；面板存续期间不受会话/工作区切换影响，
          // 关闭（✕）即结束该 shell。
          if (ui.terminalOpen) setKitUi({ terminalOpen: false });
          else setKitUi({ terminalOpen: true, termCwd: cwd });
        },
        children: jsxRuntime.jsx(TerminalIcon, {}),
      });
    }

    function FileTreeEntry() {
      const ui = useKitUi();
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": ui.treeOpen,
        title: t("treeToggle"),
        onClick: () => {
          // 开树时退出更改视图（两者互斥共享侧边栏浏览区）；开关都清预览
          setKitUi({ treeOpen: !ui.treeOpen, gitOpen: false, openFile: null });
        },
        children: jsxRuntime.jsx(FolderIcon, {}),
      });
    }

    // ─────────── 面板宿主（shell.overlay 全帧浮层）───────────
    // 终端停靠面板与文件预览面板在这里渲染（fixed 定位不受 composer 祖先
    // stacking context 影响）；文件树的 sidebar.workspaces 动态注册、让位 body 类、
    // 快捷键监听全部挂在这个常驻根组件里。
    function KitSurfaces(props) {
      const cwd = useCurrentCwd(props);
      const ui = useKitUi();
      const snap = react.useSyncExternalStore(subscribeCfg, getCfgSnapshot);
      const cfg = cfgFromSnapshot(snap);

      // 座位门控：按配置动态注册/注销输入框入口与技能页（设置卡本体不受门控，
      // 否则关掉就再也打不开）。快照未就绪按默认全开处理，首个 ready 快照到达后
      // 本效果自动重跑纠正。
      react.useEffect(() => {
        if (!slotsCtx) return undefined;
        const handles = [];
        const want = [
          ["terminal", cfg.terminalEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-terminal", order: 10 }, TerminalEntry)],
          ["filetree", cfg.fileTreeEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-filetree", order: 11 }, FileTreeEntry)],
          ["skills", cfg.skillsPageEnabled, () =>
            slotsCtx.slots.register(
              { name: "settings.section", id: "kit-skills", order: 40, label: () => t("skillsLabel") },
              SkillsManager,
            )],
        ];
        for (const [key, enabled, make] of want) {
          if (!enabled) continue;
          try {
            handles.push(make());
          } catch (error) {
            console.error(`[dsh-kit] 注册座位失败：${key}`, error);
          }
        }
        return () => {
          for (const dispose of handles) {
            try {
              dispose();
            } catch {
              // 忽略注销异常
            }
          }
        };
      }, [cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.skillsPageEnabled]);

      // 侧边栏浏览区占用：文件树与「更改」视图互斥共享 sidebar.workspaces 单槽
      // （gitOpen 时切换到更改页，✕ 关闭回到仍处打开状态的文件树）。
      // 动态注册若在运行时抛错，捕获并回滚开合状态，避免入口被错误边界退役。
      react.useEffect(() => {
        if (!slotsCtx || (!ui.treeOpen && !ui.gitOpen)) return undefined;
        let dispose;
        try {
          // 单槽遮蔽原生需要更低 priority（数字越小越先渲染，原生在 priority 0）
          dispose = slotsCtx.slots.register({ name: "sidebar.workspaces", priority: -1000 }, (owner) =>
            ui.gitOpen
              ? jsxRuntime.jsx(GitChangesPanel, { cwd, onOpenFile: (p) => setKitUi({ openFile: p }), onClose: () => setKitUi({ gitOpen: false }), ...owner })
              : jsxRuntime.jsx(FileTreePanel, { cwd, onOpenFile: (p) => setKitUi({ openFile: p }), ...owner }),
          );
        } catch (error) {
          console.error("[dsh-kit] 注册 sidebar.workspaces 面板失败：", error);
          setKitUi({ treeOpen: false, gitOpen: false, openFile: null });
          return undefined;
        }
        return () => {
          try {
            dispose();
          } catch {
            // 忽略注销异常
          }
        };
      }, [ui.treeOpen, ui.gitOpen, cwd]);

      // 关掉文件树时同步清掉文件预览（重开树不带残留预览）
      react.useEffect(() => {
        if (!ui.treeOpen && ui.openFile !== null) setKitUi({ openFile: null });
      }, [ui.treeOpen, ui.openFile]);

      // 终端让位布局：打开时挂 body 类 + 设高度变量，样式规则顶起对话/详情列
      //（配置关闭时面板不渲染，让位类也一并撤掉）
      react.useEffect(() => {
        if (!ui.terminalOpen || !cfg.terminalEnabled) return undefined;
        document.documentElement.style.setProperty("--dshk-dock-h", DOCK_H);
        document.body.classList.add("dshk-open");
        return () => {
          document.body.classList.remove("dshk-open");
          document.documentElement.style.removeProperty("--dshk-dock-h");
        };
      }, [ui.terminalOpen, cfg.terminalEnabled]);

      // 快捷键统一在此监听：组合键来自配置（默认 Ctrl+` / Ctrl+E，capture 拦截
      // 避免页面其它快捷键抢先），对应功能关闭时不响应；设置卡录制新键时让路。
      // Esc 分两层先关预览再关树（不拦截，避免挡掉其它 Esc 行为）。
      react.useEffect(() => {
        const termCombo = parseCombo(cfg.terminalShortcut);
        const treeCombo = parseCombo(cfg.fileTreeShortcut);
        const onKey = (e) => {
          if (shortcutCapture !== null) return;
          if (termCombo && cfg.terminalEnabled && comboMatches(e, termCombo)) {
            e.preventDefault();
            e.stopPropagation();
            // 与入口按钮同语义：打开那一刻固定当前工作区
            setKitUi(kitUi.terminalOpen ? { terminalOpen: false } : { terminalOpen: true, termCwd: cwd });
            return;
          }
          if (treeCombo && cfg.fileTreeEnabled && comboMatches(e, treeCombo)) {
            e.preventDefault();
            e.stopPropagation();
            // 与文件树入口同语义：开树即退出更改视图（互斥单槽）
            setKitUi({ treeOpen: !kitUi.treeOpen, gitOpen: false, openFile: null });
            return;
          }
          if (e.key === "Escape") {
            if (kitUi.openFile) setKitUi({ openFile: null });
            else if (kitUi.gitOpen) setKitUi({ gitOpen: false });
            else if (kitUi.treeOpen) setKitUi({ treeOpen: false });
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // cwd 必须在依赖里：否则闭包缓存首帧（会话未水化时为 null）的工作区，
        // 之后按快捷键开终端永远绑到 null
      }, [cwd, cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.terminalShortcut, cfg.fileTreeShortcut]);

      // 自愈：打开时尚无工作区（如刚启动就按快捷键，绑到了 null），等当前 cwd
      // 就绪后补绑一次；已有绑定的面板不受工作区切换影响
      react.useEffect(() => {
        if (ui.terminalOpen && !ui.termCwd && cwd) setKitUi({ termCwd: cwd });
      }, [ui.terminalOpen, ui.termCwd, cwd]);

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          ui.terminalOpen && cfg.terminalEnabled
            ? jsxRuntime.jsx(TerminalPanel, { cwd: ui.termCwd, onClose: () => setKitUi({ terminalOpen: false }) })
            : null,
          ui.treeOpen && cfg.fileTreeEnabled && ui.openFile
            ? jsxRuntime.jsx(FileContentPane, { path: ui.openFile, cwd, onClose: () => setKitUi({ openFile: null }) })
            : null,
        ],
      });
    }

    // ─────────── 技能管理页（settings.section）───────────
    // 数据走宿主半边 GET /dsh-kit/skills（白名单根枚举+注册表归属增强）与
    // POST /dsh-kit/skills/op（copy/move/delete/disable）。分组显示：
    // 工作区(.agents|.dsh/skills) → 用户级($DSH_HOME|~/.agents) → 技能池；
    // 插件自带/运行时来源只读展示。删除=移入池内 .trash，禁用=改 frontmatter 双键。
    function fetchSkillsPage(cwd, signal) {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      return fetch(`/dsh-kit/skills${query}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !Array.isArray(body.groups)) {
          throw new Error((body && body.error) || `HTTP ${res.status}`);
        }
        return body;
      });
    }

    function postSkillOp(payload) {
      return fetch("/dsh-kit/skills/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const error = new Error(body.error || `HTTP ${res.status}`);
          error.status = res.status;
          throw error;
        }
        return body;
      });
    }

    /** 物理根短标签（行内徽标与目标选择条共用） */
    const SK_ROOT_SHORT = {
      "project-dsh": ".dsh/skills",
      "project-agents": ".agents/skills",
      "user-dsh": "$DSH_HOME/skills",
      "user-agents": "~/.agents/skills",
    };

    function skRootShort(id) {
      return SK_ROOT_SHORT[id] ?? id;
    }

    function skGroupTitle(groupId) {
      if (groupId === "pool") return t("skPool");
      return groupId === "user" ? t("skUserLevel") : t("skWorkspace");
    }

    // ── 设置导航图标：官方 navIcon(id) 硬编码映射（models/agent-presets/plugins），
    // 未知 id 一律回退齿轮。没有注册缝，这里按标签文字找到"技能"行，把行内第一个
    // svg 换成自绘分层图标——纯外观增强：任何一步失败都静默保持齿轮。
    const SKILL_ICON_HTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 1.8 14.2 5 8 8.2 1.8 5z"/>' +
      '<path d="M1.8 8.1 8 11.2l6.2-3.1"/>' +
      '<path d="M1.8 11.3 8 14.4l6.2-3.1"/>' +
      "</svg>";

    let iconSwapPending = false;
    function swapSkillNavIcon() {
      try {
        const label = t("skillsLabel");
        const rows = document.querySelectorAll('[role="dialog"][aria-modal="true"] nav button');
        for (const row of rows) {
          const span = row.querySelector("span");
          if (!span || span.textContent !== label) continue;
          const current = row.querySelector("svg");
          if (!current || current.getAttribute("data-dshk-skill") === "1") return;
          const holder = document.createElement("span");
          holder.innerHTML = SKILL_ICON_HTML;
          const icon = holder.firstElementChild;
          if (!icon) return;
          icon.setAttribute("data-dshk-skill", "1");
          current.replaceWith(icon);
          return;
        }
      } catch {
        // 外观增强失败即保持默认齿轮
      }
    }
    function scheduleSkillIconSwap() {
      if (iconSwapPending) return;
      iconSwapPending = true;
      window.setTimeout(() => {
        iconSwapPending = false;
        swapSkillNavIcon();
        window.setTimeout(swapSkillNavIcon, 250); // React 重渲染后的二次补换
      }, 60);
    }

    function SkillContent({ file }) {
      const [state, setState] = react.useState({ phase: "loading", text: "" });
      react.useEffect(() => {
        const controller = new AbortController();
        setState({ phase: "loading", text: "" });
        fetch(`/dsh-kit/read?path=${encodeURIComponent(file)}`, { signal: controller.signal })
          .then(async (res) => {
            const body = await res.json().catch(() => null);
            if (!res.ok || !body) throw new Error((body && body.error) || `HTTP ${res.status}`);
            return body;
          })
          .then((body) =>
            setState({
              phase: "ready",
              text: body.binary ? t("contentBinary") : body.content ?? "",
            }),
          )
          .catch((error) => {
            if (!controller.signal.aborted) setState({ phase: "error", text: String(error?.message ?? error) });
          });
        return () => controller.abort();
      }, [file]);
      if (state.phase === "loading") return jsxRuntime.jsx("div", { className: "dshk-sk-status", style: { padding: "6px 0 0" }, children: t("skLoading") });
      if (state.phase === "error")
        return jsxRuntime.jsx("div", { className: "dshk-sk-status", style: { padding: "6px 0 0" }, children: `${t("contentFail")}：${state.text}` });
      if (state.text.trim() === "") return jsxRuntime.jsx("div", { className: "dshk-sk-status", style: { padding: "6px 0 0" }, children: t("contentEmpty") });
      return jsxRuntime.jsx("pre", { className: "dshk-sk-pre", children: state.text });
    }

    /** 展开式目标选择条：点选物理根即执行（不存在的根由宿主按需创建） */
    function TargetPicker({ roots, mode, onPick }) {
      return jsxRuntime.jsxs("div", {
        className: "dshk-sk-target",
        children: [
          jsxRuntime.jsxs("span", { className: "dshk-sk-target-label", children: [mode === "copy" ? t("skCopy") : t("skMove"), " · ", t("skPickTarget")] }),
          roots.map((root) =>
            jsxRuntime.jsx(
              "button",
              { type: "button", className: "dshk-sk-btn", title: root.dir, onClick: () => onPick(root.id), children: root.id === "pool" ? t("skPool") : skRootShort(root.id) },
              root.id,
            ),
          ),
        ],
      });
    }

    /**
     * 单个技能行（单行布局）：名称+徽标+描述截断+复制/移动/禁用/删除/详情。
     * 池内技能没有禁用按钮（池不被扫描，禁用无意义）；复制/移动展开目标选择条
     * （picker 状态提升到页面级，同一时间只允许一行展开）。
     */
    function SkillRow({ skill, groupId, allRoots, cwd, busy, runOp, picker, setPicker }) {
      const [open, setOpen] = react.useState(false);
      const [confirming, setConfirming] = react.useState(false);
      const pickerOpen = picker !== null && picker.key === skill.path && (picker.mode === "copy" || picker.mode === "move");
      const targets = allRoots.filter((root) => root.id !== skill.root);

      const startPicker = (mode) => setPicker(pickerOpen ? null : { key: skill.path, mode });
      const onDisable = () => runOp({ op: "disable", src: skill.path, cwd, disabled: !skill.disabled });
      const onDelete = () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        runOp({ op: "delete", src: skill.path, cwd });
      };
      const pickDest = (rootId) => {
        setPicker(null);
        runOp({ op: picker.mode, src: skill.path, dest: rootId, cwd });
      };

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-sk-row",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-sk-name", "data-disabled": skill.disabled || undefined, children: skill.name }),
              groupId !== "pool" && typeof skill.rank === "number"
                ? jsxRuntime.jsx("span", { className: "dshk-sk-badge", title: `${skRootShort(skill.root)} · ${t("skRankTip")}`, children: `(${skill.rank})` })
                : null,
              skill.disabled ? jsxRuntime.jsx("span", { className: "dshk-sk-badge dshk-sk-badge-off", children: t("skDisabled") }) : null,
              skill.shadowed ? jsxRuntime.jsx("span", { className: "dshk-sk-badge dshk-sk-badge-off", title: t("skShadowTip"), children: t("skShadowed") }) : null,
              typeof skill.description === "string" && skill.description !== ""
                ? jsxRuntime.jsx("span", { className: "dshk-sk-desc", title: skill.description, children: skill.description })
                : null,
              jsxRuntime.jsxs("div", {
                className: "dshk-sk-actions",
                children: [
                  jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: () => startPicker("copy"), children: t("skCopy") }),
                  jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: () => startPicker("move"), children: t("skMove") }),
                  groupId !== "pool"
                    ? jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: onDisable, children: skill.disabled ? t("skEnable") : t("skDisable") })
                    : null,
                  confirming
                    ? jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", "data-danger": "1", disabled: busy, onClick: onDelete, children: t("skConfirmDelete") })
                    : jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: onDelete, children: t("skDelete") }),
                  confirming
                    ? jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: () => setConfirming(false), children: t("skCancel") })
                    : null,
                  jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, onClick: () => setOpen((v) => !v), children: open ? t("skHide") : t("skView") }),
                ],
              }),
            ],
          }),
          pickerOpen ? jsxRuntime.jsx(TargetPicker, { roots: targets, mode: picker.mode, onPick: pickDest }) : null,
          open ? jsxRuntime.jsx("div", { className: "dshk-sk-detail", children: jsxRuntime.jsx(SkillContent, { file: skill.file }) }) : null,
        ],
      });
    }

    /** 只读展示注册表里非白名单根的技能（插件自带/运行时/custom 目录等） */
    function ProviderRow({ item }) {
      return jsxRuntime.jsxs("div", {
        className: "dshk-sk-row",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-sk-line1",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-sk-name", children: item.name }),
              item.provider !== "" ? jsxRuntime.jsx("span", { className: "dshk-sk-badge", children: item.provider }) : null,
              item.source !== "" ? jsxRuntime.jsx("span", { className: "dshk-sk-badge", children: item.source }) : null,
              jsxRuntime.jsx("span", { className: "dshk-sk-badge dshk-sk-badge-off", children: t("skByPlugin") }),
            ],
          }),
          typeof item.description === "string" && item.description !== ""
            ? jsxRuntime.jsx("div", { className: "dshk-sk-desc", title: item.description, children: item.description })
            : null,
        ],
      });
    }

    const SK_GROUP_RANK = { workspace: 0, user: 1, pool: 2 };

    function SkillsManager(props) {
      const cwd = useCurrentCwd(props);
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState("");
      const [message, setMessage] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [nonce, setNonce] = react.useState(0);
      // 展开中的复制/移动目标选择条（{key,mode}）；单值保证同一时间只展开一行
      const [picker, setPicker] = react.useState(null);

      react.useEffect(() => {
        const controller = new AbortController();
        fetchSkillsPage(cwd ?? "", controller.signal)
          .then((body) => {
            setData(body);
            setError("");
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(String(err?.message ?? err));
          });
        return () => controller.abort();
      }, [cwd, nonce]);

      const runOp = async (payload) => {
        if (busy) return;
        setBusy(true);
        setMessage("");
        try {
          try {
            await postSkillOp(payload);
          } catch (err) {
            if (err && err.status === 409 && window.confirm(t("skOverwrite"))) {
              await postSkillOp({ ...payload, overwrite: true });
            } else {
              setMessage(`${t("skOpFail")}：${err?.message ?? err}`);
              return;
            }
          }
          setMessage(payload.op === "delete" ? t("skDeleted") : t("skDone"));
          setPicker(null);
          setNonce((n) => n + 1);
        } finally {
          setBusy(false);
        }
      };

      const groups = data
        ? [...data.groups].sort((a, b) => (SK_GROUP_RANK[a.id] ?? 99) - (SK_GROUP_RANK[b.id] ?? 99))
        : [];
      const allRoots = data ? groups.flatMap((group) => group.roots) : [];

      return jsxRuntime.jsxs("div", {
        className: "dshk-sk",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-sk-head",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-sk-title", children: t("skillsLabel") }),
              message !== "" ? jsxRuntime.jsx("span", { className: "dshk-sk-status", children: message }) : null,
              error !== "" ? jsxRuntime.jsx("span", { className: "dshk-sk-status", title: error, children: `${t("skFail")}：${error}` }) : null,
              jsxRuntime.jsx("span", { style: { flex: 1 } }),
              jsxRuntime.jsx("button", { type: "button", className: "dshk-sk-btn", disabled: busy, title: t("skRefresh"), onClick: () => setNonce((n) => n + 1), children: "⟳" }),
            ],
          }),
          !cwd ? jsxRuntime.jsx("div", { className: "dshk-sk-status", style: { marginBottom: 8 }, children: t("skNoCwdHint") }) : null,
          groups.map((group) =>
            jsxRuntime.jsxs(
              "div",
              {
                className: "dshk-sk-group",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "dshk-sk-group-head",
                    children: [
                      jsxRuntime.jsx("span", { children: skGroupTitle(group.id) }),
                      jsxRuntime.jsx("span", { children: `· ${group.skills.length}` }),
                      jsxRuntime.jsx("span", {
                        className: "dshk-sk-group-dir",
                        title: group.roots.map((root) => root.dir).join("\n"),
                        children: group.roots
                          .map((root) =>
                            root.id === "pool"
                              ? `${root.dir}${root.exists ? "" : `（${t("skNotCreated")}）`}`
                              : `${skRootShort(root.id)}(${root.rank})${root.exists ? "" : `（${t("skNotCreated")}）`}`,
                          )
                          .join(" | "),
                      }),
                    ],
                  }),
                  group.skills.length === 0
                    ? jsxRuntime.jsx("div", { className: "dshk-sk-row dshk-sk-status", children: t("skEmpty") })
                    : group.skills.map((skill) =>
                        jsxRuntime.jsx(
                          SkillRow,
                          { skill, groupId: group.id, allRoots, cwd, busy, runOp, picker, setPicker },
                          skill.path,
                        ),
                      ),
                ],
              },
              group.id,
            ),
          ),
          data && Array.isArray(data.providers) && data.providers.length > 0
            ? jsxRuntime.jsxs("div", {
                className: "dshk-sk-group",
                children: [
                  jsxRuntime.jsx("div", { className: "dshk-sk-group-head", children: jsxRuntime.jsx("span", { children: t("skOther") }) }),
                  data.providers.map((item, index) => jsxRuntime.jsx(ProviderRow, { item }, `${item.name}::${index}`)),
                ],
              })
            : null,
        ],
      });
    }

    // ─────────── 插件设置卡（settings.plugin.item，任务5）───────────
    // 交互规范照官方 CardForm（同 dsh-memory 卡片）：编辑只暂存草稿、保存才写；
    // "已覆盖" = raw user 层含该键；恢复默认暂存 base 值（保存时 unset 回落默认）。
    // 写入后回读 user 层验证落盘（Host 是唯一权威，scope.set 失败静默回滚重读）。
    // 快捷键字段是捕获控件：点「修改」进录制态，下一个含非修饰主键的 keydown 即为
    // 新组合键；录制期模块级 shortcutCapture 置位，KitSurfaces 面板快捷键让路。
    const CFG_FIELDS = [
      { key: "terminalEnabled", kind: "bool" },
      { key: "fileTreeEnabled", kind: "bool" },
      { key: "skillsPageEnabled", kind: "bool" },
      { key: "terminalShortcut", kind: "combo" },
      { key: "fileTreeShortcut", kind: "combo" },
    ];
    const cfgSpec = Object.fromEntries(CFG_FIELDS.map((f) => [f.key, f]));
    const cfgLabelKey = (field, suffix) =>
      `cfg${field[0].toUpperCase()}${field.slice(1)}${suffix}`;

    /** 字段显示文本：bool → "true"/"false"；combo → 组合键串（空回落内置默认） */
    function cfgFormat(field, value) {
      if (cfgSpec[field].kind === "bool") return value === false ? "false" : "true";
      return typeof value === "string" && value.trim() !== "" ? value : CFG_DEFAULTS[field];
    }
    /** 草稿文本 → 写入计划；非法（组合键缺主键/修饰键）返回 undefined 阻断保存 */
    function cfgParse(field, text) {
      if (cfgSpec[field].kind === "bool") return { kind: "set", value: text === "true" };
      const trimmed = String(text ?? "").trim();
      return parseCombo(trimmed) ? { kind: "set", value: trimmed } : undefined;
    }

    function KitConfigCard({ scope }) {
      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
      react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [open, setOpen] = react.useState(false);
      // 正在录制快捷键的字段；null = 非录制态（同一时间至多一个）
      const [capturing, setCapturing] = react.useState(null);

      // 录制期：capture 截获下一个组合键；Esc 取消；纯修饰键继续等待
      react.useEffect(() => {
        if (!capturing) return undefined;
        shortcutCapture = capturing;
        const onKey = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            setCapturing(null);
            return;
          }
          const combo = comboFromEvent(e);
          if (!combo) return;
          setDrafts((d) => ({ ...d, [capturing]: { text: combo, clear: false } }));
          setFailed(false);
          setCapturing(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
          shortcutCapture = null;
          window.removeEventListener("keydown", onKey, true);
        };
      }, [capturing]);

      // 卡壳永远渲染（加载中也一样）：静默隐身的卡无法和注册失败区分
      try {
        return renderCard();
      } catch (error) {
        console.error("[dsh-kit] 设置卡渲染错误：", error);
        return jsxRuntime.jsx("li", {
          className: "dshk-cfg-card",
          children: jsxRuntime.jsx("p", {
            className: "dshk-cfg-status",
            role: "status",
            children: `dsh-kit card render error: ${String(error?.message ?? error)}`,
          }),
        });
      }

      function renderCard() {
        const loading = snapshot.status === "loading";
        const available = snapshot.status === "ready";
        const writable = snapshot.writable === true;

        /** raw user 层是否携带该键（"已覆盖"的判据） */
        const stored = (field) =>
          snapshot.user !== undefined && snapshot.user !== null && typeof snapshot.user === "object"
            ? Object.prototype.hasOwnProperty.call(snapshot.user, field)
            : false;
        const sectionText = (field) =>
          cfgFormat(
            field,
            available && snapshot.value && typeof snapshot.value === "object" ? snapshot.value[field] : undefined,
          );
        const stagedOf = (field) => drafts[field];

        const fieldState = (field) => {
          const staged = stagedOf(field);
          if (staged === undefined) return { text: sectionText(field), overridden: stored(field), invalid: false };
          if (staged.clear) return { text: staged.text, overridden: false, invalid: false };
          const parsed = cfgParse(field, staged.text);
          return { text: staged.text, overridden: true, invalid: parsed === undefined };
        };

        const edit = (field, text) => {
          setDrafts((d) => ({ ...d, [field]: { text, clear: false } }));
          setFailed(false);
        };
        // 恢复默认：暂存 base 值 + clear 标记（保存时 unset，回落 schema 默认）
        const resetField = (field) => {
          const base = snapshot.base && typeof snapshot.base === "object" ? snapshot.base[field] : undefined;
          setDrafts((d) => ({ ...d, [field]: { text: cfgFormat(field, base), clear: true } }));
          setFailed(false);
        };
        const discard = () => {
          setDrafts({});
          setFailed(false);
          setCapturing(null);
        };

        /** 保存要执行的写入列表：无变化跳过、非法阻断整体（返回 null） */
        const computeWrites = () => {
          if (!available) return [];
          const writes = [];
          for (const { key } of CFG_FIELDS) {
            const staged = stagedOf(key);
            if (staged === undefined) continue;
            if (staged.clear) {
              if (stored(key)) writes.push({ run: () => clearField(key) });
              continue;
            }
            if (staged.text === sectionText(key)) continue;
            const parsed = cfgParse(key, staged.text);
            if (parsed === undefined) return null;
            writes.push({ run: () => storeField(key, parsed.value) });
          }
          return writes;
        };
        const freshUser = () => scope.getSnapshot().user;
        const storeField = async (field, value) => {
          await scope.set(field, value);
          const user = freshUser();
          return !!(user && typeof user === "object" && user[field] === value);
        };
        const clearField = async (field) => {
          await scope.unset(field);
          const user = freshUser();
          return !(user && typeof user === "object" && Object.prototype.hasOwnProperty.call(user, field));
        };

        const writes = computeWrites();
        const dirty = writes === null || writes.length > 0;
        const invalid = writes === null;
        const blocked = !dirty || invalid || saving;

        const save = async () => {
          const freshWrites = computeWrites();
          if (freshWrites === null || freshWrites.length === 0 || saving) return;
          setSaving(true);
          setFailed(false);
          let landed = true;
          for (const write of freshWrites) landed = (await write.run()) && landed;
          if (landed) setDrafts({});
          setSaving(false);
          setFailed(!landed);
        };

        const startCapture = (field) => setCapturing(capturing === field ? null : field);

        const badges = (state, field) =>
          state.overridden
            ? jsxRuntime.jsxs("span", {
                className: "dshk-cfg-badges",
                children: [
                  jsxRuntime.jsx("span", { className: "dshk-cfg-badge", children: t("overridden") }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-cfg-reset",
                    disabled: !writable,
                    onClick: () => resetField(field),
                    children: t("resetDefault"),
                  }),
                ],
              })
            : null;

        const renderField = (field) => {
          const spec = cfgSpec[field];
          const state = fieldState(field);
          const control =
            spec.kind === "bool"
              ? jsxRuntime.jsx("input", {
                  type: "checkbox",
                  className: "dshk-cfg-check",
                  checked: state.text === "true",
                  disabled: !writable,
                  onChange: () => edit(field, state.text === "true" ? "false" : "true"),
                })
              : jsxRuntime.jsx("button", {
                  type: "button",
                  className: "dshk-cfg-combo",
                  "data-capturing": capturing === field || undefined,
                  disabled: !writable,
                  onClick: () => startCapture(field),
                  children: capturing === field ? t("cfgCapturing") : state.text,
                });
          return jsxRuntime.jsxs("div", {
            className: "dshk-cfg-field",
            children: [
              jsxRuntime.jsxs("div", {
                className: "dshk-cfg-fhead",
                children: [
                  jsxRuntime.jsx("span", { className: "dshk-cfg-label", children: t(cfgLabelKey(field, "")) }),
                  badges(state, field),
                ],
              }),
              control,
              jsxRuntime.jsx("p", {
                className: state.invalid ? "dshk-cfg-invalid" : "dshk-cfg-hint",
                children: state.invalid ? t("invalidCombo") : t(cfgLabelKey(field, "Hint")),
              }),
            ],
          });
        };

        return jsxRuntime.jsxs("li", {
          className: "dshk-cfg-card",
          "data-open": open || undefined,
          children: [
            jsxRuntime.jsxs("button", {
              type: "button",
              className: "dshk-cfg-head",
              "aria-expanded": open,
              onClick: () => setOpen(!open),
              children: [
                jsxRuntime.jsxs("span", {
                  className: "dshk-cfg-headtext",
                  children: [
                    jsxRuntime.jsx("span", { className: "dshk-cfg-name", children: t("cfgTitle") }),
                    jsxRuntime.jsx("span", { className: "dshk-cfg-desc", children: t("cfgDesc") }),
                  ],
                }),
                dirty ? jsxRuntime.jsx("span", { className: "dshk-cfg-pill", children: t("unsaved") }) : null,
                jsxRuntime.jsx("svg", {
                  width: 14,
                  height: 14,
                  viewBox: "0 0 14 14",
                  fill: "none",
                  xmlns: "http://www.w3.org/2000/svg",
                  "aria-hidden": true,
                  className: "dshk-cfg-chev",
                  "data-open": open || undefined,
                  children: jsxRuntime.jsx("path", {
                    d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
                    fill: "currentColor",
                  }),
                }),
              ],
            }),
            open
              ? jsxRuntime.jsxs("div", {
                  className: "dshk-cfg-body",
                  children: [
                    loading ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: t("loadingCfg") }) : null,
                    !loading && !available
                      ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: t("readOnly") })
                      : null,
                    available && !writable
                      ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: t("readOnly") })
                      : null,
                    available ? CFG_FIELDS.map((f) => renderField(f.key)) : null,
                    available
                      ? jsxRuntime.jsxs("div", {
                          className: "dshk-cfg-footer",
                          children: [
                            failed ? jsxRuntime.jsx("p", { className: "dshk-cfg-err", role: "status", children: t("saveFailed") }) : null,
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-cfg-btn dshk-cfg-btn-discard",
                              disabled: !dirty || saving,
                              onClick: discard,
                              children: t("discard"),
                            }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-cfg-btn dshk-cfg-btn-save",
                              disabled: blocked,
                              onClick: save,
                              children: t(saving ? "saving" : "save"),
                            }),
                          ],
                        })
                      : null,
                  ],
                })
              : null,
          ],
        });
      }
    }

    // ─────────── 插件体 ───────────
    function apply(ctx) {
      slotsCtx = ctx;
      injectStyles();
      // 插件配置数据通道：官方 settings scope 绑定本插件命名空间（宿主半边
      // installSettingsSection 已注册 dsh-kit）。绑定失败（老宿主缺 settingsScope）
      // 时 cfgScope 保持 null，功能按内置默认全开、卡片不出现。
      if (ctx.settingsScope && typeof ctx.settingsScope.bind === "function") {
        cfgScope = ctx.settingsScope.bind({ namespace: "dsh-kit" });
      }
      // 全帧浮层宿主：面板渲染、输入框入口与技能页的座位门控、快捷键监听全在
      // KitSurfaces（根作用域常驻，fiber 上下文内做动态 register/dispose）。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "dsh-kit-surfaces", order: 900 },
          KitSurfaces,
        ),
      );
      // 设置→插件配置 卡片（dsh-kit 命名空间）。常驻不受功能开关门控——
      // 否则关掉就再也打不开。
      if (cfgScope) {
        ctx.slots.inject("settings.plugin.item", () =>
          ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: "dsh-kit",
              id: "dsh-kit",
              order: 30,
              inject: () => ({ scope: cfgScope }),
            },
            KitConfigCard,
          ),
        );
      }
      // 导航图标替换是点击驱动的轻量方案：打开设置/面板内切换都源于一次 click
      document.addEventListener("click", scheduleSkillIconSwap, true);
    }

    exports.inject = ["slots", "settingsScope"];
    exports.apply = apply;
    return module.exports;
  },
});
