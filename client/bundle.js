// dsh-kit 浏览器半边 —— 手写 client bundle，与官方 lib/client.js 产物同形，
// 无构建步骤：改完本文件重装/重启即生效。
//
// 结构：两个官方槽位——
//   shell.overlay（列表槽）：右下角 ">_" 悬浮按钮 + Ctrl+` 切换的底部终端面板；
//   sidebar.footer.action（列表槽）：侧边栏底部的文件树开关按钮，面板停靠在
//     侧边栏区域，根目录 = 当前会话工作目录。数据走宿主半边 /dsh-kit/tree。
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
      treeToggle: "文件树（当前会话工作目录）",
      treeClose: "关闭文件树",
      treeRefresh: "刷新",
      treeLoading: "加载中…",
      treeEmpty: "（空目录）",
      treeFail: "加载失败",
      treeTruncated: "条目过多，列表已截断",
      copied: "已复制路径",
      copyFail: "复制失败",
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
      treeToggle: "File tree (current session workspace)",
      treeClose: "Close file tree",
      treeRefresh: "Refresh",
      treeLoading: "Loading…",
      treeEmpty: "(empty)",
      treeFail: "Failed to load",
      treeTruncated: "Too many entries, list truncated",
      copied: "Path copied",
      copyFail: "Copy failed",
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
.dshk-btn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.dshk-body{flex:1 1 auto;min-height:0;padding:4px 8px 8px;position:relative}
.dshk-term{height:100%}
.dshk-term .xterm{height:100%}
.dshk-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dshk-fab{position:fixed;right:18px;bottom:18px;width:38px;height:38px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-layer-2,#202020);color:var(--dsw-alias-label-secondary,#ccc);z-index:900;pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;font:700 13px ui-monospace,Consolas,monospace;box-shadow:0 4px 14px rgba(0,0,0,.2);padding:0}
.dshk-fab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
/* 让位布局：终端打开时把对话列顶起，内容不被遮挡（终端宽度即对话列宽） */
body.dshk-open [class*="_centerCol"]{padding-bottom:var(--dshk-dock-h,${DOCK_H})}
[class*="_centerCol"]{transition:padding-bottom .18s ease}
@media (prefers-reduced-motion:reduce){[class*="_centerCol"]{transition:none}}
/* 文件树面板：停靠在侧边栏区域（宽度=侧栏列宽，随开合跟随） */
.dshk-tree{position:fixed;top:0;bottom:0;left:0;width:var(--dshk-tree-w,280px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-right:1px solid var(--dsw-alias-border-l1);box-shadow:6px 0 20px rgba(0,0,0,.10);z-index:780;pointer-events:auto}
.dshk-tree-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 4px 12px;font-size:13px}
.dshk-row{display:flex;align-items:center;gap:5px;height:26px;padding:0 6px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dshk-row:hover{background:var(--dsw-alias-fill-l2)}
.dshk-chev{width:13px;flex:none;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
.dshk-name{overflow:hidden;text-overflow:ellipsis}
.dshk-file .dshk-name{color:var(--dsw-alias-label-secondary)}
.dshk-note{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshk-ftbtn[aria-pressed="true"]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
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

    /** 单层目录状态：{status:'loading'|'ready'|'error', entries?, truncated?, error?} */
    function TreeNode({ entry, depth, expanded, onToggle, onCopy }) {
      const info = entry.dir ? expanded[entry.path] : undefined;
      const rows = [jsxRuntime.jsxs("div", {
        className: `dshk-row${entry.dir ? "" : " dshk-file"}`,
        style: { paddingLeft: 8 + depth * 14 },
        title: entry.path,
        onClick: () => (entry.dir ? onToggle(entry) : onCopy(entry)),
        children: [
          jsxRuntime.jsx("span", { className: "dshk-chev", children: entry.dir ? (info ? "▾" : "▸") : "" }),
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
            rows.push(jsxRuntime.jsx(TreeNode, { entry: child, depth: depth + 1, expanded, onToggle, onCopy }, child.path));
          }
          if (info.truncated) {
            rows.push(jsxRuntime.jsx("div", { className: "dshk-note", style: { paddingLeft: 8 + (depth + 1) * 14 }, children: t("treeTruncated") }, `${entry.path}::truncated`));
          }
        }
      }
      return jsxRuntime.jsxs(jsxRuntime.Fragment, { children: rows });
    }

    function FileTreePanel({ cwd, onClose }) {
      // expanded: 路径 → 目录单层状态；根目录就是 cwd
      const [expanded, setExpanded] = react.useState({});
      const [nonce, setNonce] = react.useState(0);
      const [toast, setToast] = react.useState("");
      const toastTimer = react.useRef(0);
      const abortsRef = react.useRef(new Set());
      // 宽度跟随侧栏列（测量对话列左缘，同终端的跟随手法）
      const [width, setWidth] = react.useState(null);

      react.useLayoutEffect(() => {
        const el = document.querySelector('[class*="_centerCol"]');
        if (!el) return undefined;
        const update = () => {
          const r = el.getBoundingClientRect();
          if (r.width > 0) setWidth(Math.max(260, Math.min(r.left, 380)));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      const showToast = (msg) => {
        setToast(msg);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(""), 1600);
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

      // Esc 关闭面板
      react.useEffect(() => {
        const onKey = (e) => {
          if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [onClose]);

      react.useEffect(() => () => window.clearTimeout(toastTimer.current), []);

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

      const copyPath = (entry) => {
        const done = () => showToast(t("copied"));
        const fail = () => showToast(t("copyFail"));
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(entry.path).then(done, fail);
        } else {
          try {
            const ta = document.createElement("textarea");
            ta.value = entry.path;
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

      const rootInfo = cwd ? expanded[cwd] : undefined;

      return jsxRuntime.jsxs("div", {
        className: "dshk-tree",
        style: width ? { width } : undefined,
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx(FolderIcon, {}),
              jsxRuntime.jsx("span", { className: "dshk-title", children: t("treeLabel") }),
              cwd ? jsxRuntime.jsx("span", { className: "dshk-sub", title: cwd, children: cwd }) : null,
              toast !== "" ? jsxRuntime.jsx("span", { className: "dshk-status", children: toast }) : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeRefresh"),
                onClick: () => setNonce((n) => n + 1),
                children: "⟳",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeClose"),
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
                : !rootInfo || rootInfo.status === "loading"
                  ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") })
                  : rootInfo.status === "error"
                    ? jsxRuntime.jsx("div", { className: "dshk-note", title: rootInfo.error ?? "", children: `${t("treeFail")}${rootInfo.error ? `：${rootInfo.error}` : ""}` })
                    : rootInfo.entries.length === 0
                      ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeEmpty") })
                      : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                          children: [
                            rootInfo.entries.map((entry) =>
                              jsxRuntime.jsx(TreeNode, { entry, depth: 0, expanded, onToggle: toggleDir, onCopy: copyPath }, entry.path),
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
          open ? jsxRuntime.jsx(TerminalPanel, { cwd, onClose: () => setOpen(false) }) : null,
          open
            ? null
            : jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-fab",
                title: t("toggle"),
                onClick: () => setOpen(true),
                children: ">_",
              }),
        ],
      });
    }

    /** sidebar.footer.action 入口：开关按钮 + 停靠面板（同组件持有状态，免跨槽同步） */
    function FileTreeDock(props) {
      const cwd = useCurrentCwd(props);
      const [open, setOpen] = react.useState(false);
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
          open ? jsxRuntime.jsx(FileTreePanel, { cwd, onClose: () => setOpen(false) }) : null,
        ],
      });
    }

    // ─────────── 插件体 ───────────
    function apply(ctx) {
      injectStyles();
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", key: "dsh-kit-terminal", id: "dsh-kit-terminal", order: 50, label: t("label") },
          TerminalDock,
        ),
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-kit-filetree", order: 60, label: t("treeLabel") },
          FileTreeDock,
        ),
      );
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
