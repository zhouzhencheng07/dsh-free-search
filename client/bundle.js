// dsh-kit 浏览器半边 —— 手写 client bundle，与官方 lib/client.js 产物同形，
// 无构建步骤：改完本文件刷新浏览器即生效（本地目录 junction 直装）。
//
// 结构（两个 sidebar.footer.action 菜单按钮 + 文件树动态接管浏览区）：
//   终端：侧边栏底部按钮（'>_'）开合底部停靠终端面板（Ctrl+` 亦可切换）；
//     数据走宿主半边 /dsh-kit/terminal WS。
//   文件树：侧边栏底部按钮（文件夹图标）开合；打开时临时注册进单槽
//     sidebar.workspaces——把侧边栏浏览区整体换成文件树，关闭时 dispose 注销、
//     原生工作区列表自动回归。根目录 = 当前会话工作目录，数据走宿主半边 /dsh-kit/tree。
//     点击文件 → 右侧停靠面板预览内容（默认开满宽度、对话左移让位、左缘可拖宽），
//     数据走宿主半边 /dsh-kit/read。面板让位用 body.dshk-pane-open + --dshk-pane-w，
//     自绘不依赖原生 details 列/ctx.layout（其 openDetails 固定 360）。
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

    /** apply 时捕获的 ctx；文件树按钮用它动态 register/dispose sidebar.workspaces 单槽 */
    let slotsCtx = null;

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
      copied: "已复制路径",
      copyFail: "复制失败",
      contentClose: "关闭预览",
      contentCopy: "复制路径",
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
      copied: "Path copied",
      copyFail: "Copy failed",
      contentClose: "Close preview",
      contentCopy: "Copy path",
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
.dshk-ftbtn[aria-pressed="true"]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
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
    function TreeNode({ entry, depth, expanded, onToggle, onOpenFile }) {
      const info = entry.dir ? expanded[entry.path] : undefined;
      const rows = [jsxRuntime.jsxs("div", {
        className: `dshk-row${entry.dir ? "" : " dshk-file"}`,
        style: { paddingLeft: 8 + depth * 14 },
        title: entry.path,
        onClick: () => (entry.dir ? onToggle(entry) : onOpenFile(entry.path)),
        children: [
          jsxRuntime.jsx("span", { className: "dshk-chev", children: entry.dir ? jsxRuntime.jsx(ChevronIcon, { open: !!info }) : null }),
          jsxRuntime.jsx("span", { className: "dshk-name", children: entry.name }),
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
            rows.push(jsxRuntime.jsx(TreeNode, { entry: child, depth: depth + 1, expanded, onToggle, onOpenFile }, child.path));
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
      const [nonce, setNonce] = react.useState(0);
      const abortsRef = react.useRef(new Set());

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

      // 根目录 / 刷新：清空缓存重拉
      react.useEffect(() => {
        abortsRef.current.forEach((c) => c.abort());
        abortsRef.current.clear();
        if (!cwd) {
          setExpanded({});
          return undefined;
        }
        setExpanded({ [cwd]: { status: "loading" } });
        loadDir(cwd);
        return () => {
          abortsRef.current.forEach((c) => c.abort());
          abortsRef.current.clear();
        };
      }, [cwd, nonce]);

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
                              jsxRuntime.jsx(TreeNode, { entry, depth: 0, expanded, onToggle: toggleDir, onOpenFile }, entry.path),
                            ),                            rootInfo.truncated
                              ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeTruncated") })
                              : null,
                          ],
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
      const [toast, setToast] = react.useState("");
      const [dragging, setDragging] = react.useState(false);
      const toastTimer = react.useRef(0);
      // 拖过的宽度（px）；0 = 未拖过，用 CSS fallback 默认宽度
      const widthRef = react.useRef(0);
      const dragRef = react.useRef(null);

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
      }, [path]);

      react.useEffect(() => () => window.clearTimeout(toastTimer.current), []);

      const showToast = (msg) => {
        setToast(msg);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(""), 1600);
      };

      const copyPath = () => {
        const done = () => showToast(t("copied"));
        const fail = () => showToast(t("copyFail"));
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(path).then(done, fail);
        } else {
          try {
            const ta = document.createElement("textarea");
            ta.value = path;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            done();
          } catch {
            fail();
          }
        }
      };

      const base = path.split(/[\\/]/).pop() || path;
      const displayPath = cwd && path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]/, "") : path;

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
              toast !== "" ? jsxRuntime.jsx("span", { className: "dshk-status", children: toast }) : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("contentCopy"),
                onClick: copyPath,
                children: "⧉",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("contentClose"),
                onClick: onClose,
                children: "✕",
              }),
            ],
          }),
          body,
        ],
      });
    }

    // ─────────── 槽位入口组件 ───────────
    function TerminalDock(props) {
      const cwd = useCurrentCwd(props);
      const [open, setOpen] = react.useState(false);

      // Ctrl+` 切换（VSCode 习惯键位），capture 阶段拦截避免页面其它快捷键抢先
      react.useEffect(() => {
        const onKey = (e) => {
          if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "`" || e.code === "Backquote")) {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, []);

      // 让位布局：打开时挂 body 类 + 设高度变量，样式规则顶起对话/详情列
      react.useEffect(() => {
        if (!open) return undefined;
        document.documentElement.style.setProperty("--dshk-dock-h", DOCK_H);
        document.body.classList.add("dshk-open");
        return () => {
          document.body.classList.remove("dshk-open");
          document.documentElement.style.removeProperty("--dshk-dock-h");
        };
      }, [open]);

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsx("button", {
            type: "button",
            className: "dshk-btn dshk-ftbtn",
            "aria-pressed": open,
            title: t("toggle"),
            onClick: () => setOpen((v) => !v),
            children: jsxRuntime.jsx(TerminalIcon, {}),
          }),
          open ? jsxRuntime.jsx(TerminalPanel, { cwd, onClose: () => setOpen(false) }) : null,
        ],
      });
    }

    /** sidebar.footer.action 入口：开关按钮。打开时临时注册进 sidebar.workspaces 单槽，
     *  把侧边栏浏览区整体换成文件树；关闭时 dispose 注销、原生工作区列表自动回归。
     *  点击文件时再注册进 details 单槽（原生右侧第三列），内容在右列展示、对话左移。 */
    function FileTreeDock(props) {
      const cwd = useCurrentCwd(props);
      const [open, setOpen] = react.useState(false);
      // 当前打开预览的文件路径；null = 未打开任何文件
      const [openFile, setOpenFile] = react.useState(null);

      react.useEffect(() => {
        if (!open || !slotsCtx) return undefined;
        // 注册文件树为 sidebar.workspaces occupant（遮蔽原生浏览器），返回值即 disposer。
        // 动态注册若在运行时抛错（跨 fiber/生命周期约束），捕获并回滚 open，避免入口被错误边界退役。
        let dispose;
        try {
          // 单槽遮蔽原生需要更低 priority（数字越小越先渲染，原生在 priority 0）
          dispose = slotsCtx.slots.register({ name: "sidebar.workspaces", priority: -1000 }, (owner) =>
            jsxRuntime.jsx(FileTreePanel, { cwd, onOpenFile: (p) => setOpenFile(p), ...owner }),
          );
        } catch (error) {
          console.error("[dsh-kit] 注册 sidebar.workspaces 文件树失败：", error);
          setOpen(false);
          return undefined;
        }
        return () => {
          try {
            dispose();
          } catch {
            // 忽略注销异常
          }
        };
      }, [open, cwd]);

      // 关掉文件树时同步清掉文件预览（重开树不带残留预览）
      react.useEffect(() => {
        if (!open) setOpenFile(null);
      }, [open]);

      // Esc 分两层：先关文件预览，再关文件树（不拦截事件，避免挡掉其它 Esc 行为）
      react.useEffect(() => {
        const onKey = (e) => {
          if (e.key !== "Escape") return;
          if (openFile) setOpenFile(null);
          else if (open) setOpen(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [open, openFile]);

      // Ctrl+E 切换文件树/工作区树（capture 阶段拦截，避免页面其它快捷键抢先）
      react.useEffect(() => {
        const onKey = (e) => {
          if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "e" || e.code === "KeyE")) {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, []);

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsx("button", {
            type: "button",
            className: "dshk-btn dshk-ftbtn",
            "aria-pressed": open,
            title: t("treeToggle"),
            onClick: () => setOpen((v) => !v),
            children: jsxRuntime.jsx(FolderIcon, {}),
          }),
          // 文件预览：自绘右侧停靠面板直接渲染（挂 body 类让位，见 FileContentPane）
          open && openFile
            ? jsxRuntime.jsx(FileContentPane, { path: openFile, cwd, onClose: () => setOpenFile(null) })
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

    // ─────────── 插件体 ───────────
    function apply(ctx) {
      slotsCtx = ctx;
      injectStyles();
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-kit-terminal", order: 55, label: t("label") },
          TerminalDock,
        ),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-kit-filetree", order: 60, label: t("treeLabel") },
          FileTreeDock,
        ),
      );
      // 设置面板新增整页（settings.section 列表槽）：技能（M1 技能池）
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "kit-skills", order: 40, label: () => t("skillsLabel") },
          SkillsManager,
        ),
      );
      // 导航图标替换是点击驱动的轻量方案：打开设置/面板内切换都源于一次 click
      document.addEventListener("click", scheduleSkillIconSwap, true);
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
