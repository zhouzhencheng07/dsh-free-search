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
//     开满宽度、对话左移让位、左缘可拖宽），数据走宿主半边 /dsh-kit/read；
//     PDF 走 /dsh-kit/raw 原始字节端点（Range/206），pdf.js（vendor 懒加载）
//     逐页 canvas 渲染——Edge 内置查看器对 http:// 源灰屏，不可依赖。
//     面板让位用 body.dshk-pane-open + --dshk-pane-w，自绘不依赖原生 details 列。
// xterm 不打进 bundle，由宿主半边伺服 /dsh-kit/vendor/* 静态资源（官方预编译
// UMD），首次打开终端面板时按需加载。
//
// 外观跟随：面板 chrome 全部用 --dsw-alias-* 令牌（随 DSH 明暗主题自动切换）；
// xterm 需要具体色值，从 body 的 data-ds-dark-theme 属性判断明暗，
// 再读令牌的 computed 值做背景/前景，ANSI 用明/暗两套通用标准调色板，
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
    // 右侧标签页容器（ZCode 式）：previews（文件预览标签数组，二级标签——预览大
    // 标签内套文件小标签）/jobsOpen/browserOpen 是「标签存在性」，dockTab 是当前
    // 激活大标签，activePreview 是预览内激活的文件；打开某功能 = 确保标签存在并
    // 激活，互斥清场废除（切走不丢状态）。dockCollapsed = 暂时收起（存在性保留、
    // 入口按钮恢复；视为人为退出——agent 导航不再弹回）。
    let kitUi = { treeOpen: false, gitOpen: false, previews: [], activePreview: null, terminals: [], activeTermId: null, termDockOpen: false, jobsOpen: false, browserOpen: false, dockTab: null, dockCollapsed: false };
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

    // 浏览器自动打开的人为抑制：人手动切走浏览器标签（或收起面板）后置位（agent
    // 再导航也不拽回），手动点回浏览器标签/入口按钮解除。关掉整个浏览器标签会卸载
    // 面板（WS 断、事件源消失），重开（入口按钮）自然解除。
    let autoOpenSuppressed = false;

    const PREVIEW_MAX_DEFAULT = 8;
    /** 预览标签上限（设置卡可配 1-20；快照未就绪回落默认 8） */
    function previewLimit() {
      const v = cfgFromSnapshot(getCfgSnapshot()).previewMaxTabs;
      return Math.max(1, Number.isInteger(v) ? v : PREVIEW_MAX_DEFAULT);
    }
    /** 右侧标签页共存的活性判定（渲染右坞与否） */
    const dockAlive = (ui) => (ui.previews?.length ?? 0) > 0 || ui.jobsOpen === true || ui.browserOpen === true;
    /** 打开/激活文件预览标签：已存在则置顶激活（usedAt 刷新，deleted/untracked
     *  同步为本次状态）；超过上限按 LRU 逐出最久未用的（绝不含本次）；顺带取消
     *  最小化态并激活预览大标签。deleted=已删除文件，预览只承载删除 diff。 */
    function openPreviewTab(ui, path, from, untracked, deleted) {
      const now = Date.now();
      const items = ui.previews ?? [];
      let list = items.some((x) => x.path === path)
        ? items.map((x) => (x.path === path ? { ...x, from: from ?? x.from, untracked: untracked === true, deleted: deleted === true, usedAt: now } : x))
        : [...items, { path, from: from ?? "tree", untracked: untracked === true, deleted: deleted === true, usedAt: now }];
      const max = previewLimit();
      while (list.length > max) {
        let oldest = null;
        for (const x of list) {
          if (x.path !== path && (oldest === null || x.usedAt < oldest.usedAt)) oldest = x;
        }
        if (oldest === null) break;
        list = list.filter((x) => x.path !== oldest.path);
      }
      return { previews: list, activePreview: path, dockCollapsed: false, dockTab: "preview" };
    }
    /** 关一个文件预览标签（按 path）：激活位顺延邻居；关完全部文件则预览大标签消失 */
    function closePreviewTab(ui, path) {
      const items = ui.previews ?? [];
      const idx = items.findIndex((x) => x.path === path);
      if (idx < 0) return {};
      const rest = items.filter((x) => x.path !== path);
      const patch = { previews: rest };
      if (ui.activePreview === path) {
        patch.activePreview = rest.length > 0 ? rest[Math.min(idx, rest.length - 1)].path : null;
      }
      return patch;
    }
    /** 关一个右侧大标签：清存在性；关的是激活标签时激活位顺延剩余标签，全空收容器 */
    function closeDockTab(ui, tab) {
      const patch = {};
      if (tab === "preview") {
        patch.previews = [];
        patch.activePreview = null;
      } else if (tab === "jobs") patch.jobsOpen = false;
      else patch.browserOpen = false;
      if (ui.dockTab === tab) {
        const remaining = [];
        if (tab !== "preview" && (ui.previews?.length ?? 0) > 0) remaining.push("preview");
        if (tab !== "jobs" && ui.jobsOpen) remaining.push("jobs");
        if (tab !== "browser" && ui.browserOpen) remaining.push("browser");
        patch.dockTab = remaining[0] ?? null;
      }
      return patch;
    }

    // ── 多终端会话模型 ──
    // terminals:[{id,cwd}] 创建顺序即标签顺序；每个终端在创建那一刻绑定当时的
    // 会话工作区，之后切换会话不影响已开的终端。termDockOpen 只管坞的可见性——
    // 隐藏不杀进程，后台标签的 shell 继续跑、xterm 继续缓冲输出；标签 ✕ 才断开
    // 对应 WS（宿主随即杀掉 pty）。
    let termSeq = 0;
    const makeTerm = (cwd) => ({ id: `term-${++termSeq}`, cwd });
    /** 入口按钮与 Ctrl+/ 共用：开=恢复视图（无会话则新建绑定当前 cwd）；关=仅隐藏 */
    function toggleTermDock(ui, cwd) {
      if (ui.termDockOpen) return { termDockOpen: false };
      if (ui.terminals.length === 0) {
        const nt = cwd ? makeTerm(cwd) : null;
        return nt ? { termDockOpen: true, terminals: [nt], activeTermId: nt.id } : { termDockOpen: true };
      }
      return { termDockOpen: true, activeTermId: ui.activeTermId ?? ui.terminals[ui.terminals.length - 1].id };
    }
    /** ＋ 新建终端：绑定调用那一刻的当前会话工作区 */
    function spawnTerm(ui, cwd) {
      const nt = makeTerm(cwd ?? "");
      return { terminals: [...ui.terminals, nt], activeTermId: nt.id, termDockOpen: true };
    }
    /** 标签 ✕：从列表移除（组件卸载即断 WS 杀进程），激活位顺延邻居 */
    function killTerm(ui, id) {
      const idx = ui.terminals.findIndex((x) => x.id === id);
      if (idx < 0) return {};
      const rest = ui.terminals.filter((x) => x.id !== id);
      const patch = { terminals: rest };
      if (ui.activeTermId === id) {
        patch.activeTermId = rest.length > 0 ? rest[Math.min(idx, rest.length - 1)].id : null;
      }
      if (rest.length === 0) patch.termDockOpen = false;
      return patch;
    }

    // ─────────── 插件配置 ───────────
    // 数据通道：官方 settings scope（宿主 installSettingsSection 注册的
    // dsh-kit 命名空间）。快照未就绪时一律回退内置默认——功能全开、默认键位。
    const CFG_DEFAULTS = {
      terminalEnabled: true,
      fileTreeEnabled: true,
      sourceControlEnabled: true,
      chatOpenFilePreview: false,
      skillsPageEnabled: true,
      searchEnabled: true,
      searchMaxResults: 5,
      previewMaxTabs: 8,
      phoneEnabled: false,
      phoneRemoteDomain: "",
      phonePort: 3090,
      phoneKeepGatewayOn: false,
      jobsEnabled: true,
      browserEnabled: true,
      terminalShortcut: "Ctrl+/",
      fileTreeShortcut: "Ctrl+,",
      scShortcut: "Ctrl+Alt+.",
      sidebarShortcut: "Ctrl+B",
      sidebarShortcutEnabled: true,
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
        sourceControlEnabled: v.sourceControlEnabled !== false,
        chatOpenFilePreview: v.chatOpenFilePreview === true,
        skillsPageEnabled: v.skillsPageEnabled !== false,
        searchEnabled: v.searchEnabled !== false,
        previewMaxTabs:
          Number.isInteger(v.previewMaxTabs) && v.previewMaxTabs >= 1 && v.previewMaxTabs <= 20
            ? v.previewMaxTabs
            : CFG_DEFAULTS.previewMaxTabs,
        phoneEnabled: v.phoneEnabled === true,
        phoneRemoteDomain: typeof v.phoneRemoteDomain === "string" ? v.phoneRemoteDomain : "",
        jobsEnabled: v.jobsEnabled !== false,
        browserEnabled: v.browserEnabled !== false,
        terminalShortcut:
          typeof v.terminalShortcut === "string" && parseCombo(v.terminalShortcut)
            ? v.terminalShortcut
            : CFG_DEFAULTS.terminalShortcut,
        fileTreeShortcut:
          typeof v.fileTreeShortcut === "string" && parseCombo(v.fileTreeShortcut)
            ? v.fileTreeShortcut
            : CFG_DEFAULTS.fileTreeShortcut,
        scShortcut:
          typeof v.scShortcut === "string" && parseCombo(v.scShortcut)
            ? v.scShortcut
            : CFG_DEFAULTS.scShortcut,
        sidebarShortcut:
          typeof v.sidebarShortcut === "string" && parseCombo(v.sidebarShortcut)
            ? v.sidebarShortcut
            : CFG_DEFAULTS.sidebarShortcut,
        sidebarShortcutEnabled: v.sidebarShortcutEnabled !== false,
      };
    }
    // 模块级通道（apply 注入 / KitSurfaces 订阅 / 设置卡捕获互斥）
    let cfgScope = null;
    let shortcutCapture = null; // 正在录制快捷键的字段名；非 null 时面板快捷键监听让路
    let inlineEditCapture = false; // 树行内改名输入激活：面板快捷键（含 Esc 分层关闭）让路
    const subscribeCfg = (listener) => (cfgScope ? cfgScope.subscribe(listener) : () => {});
    const getCfgSnapshot = () => (cfgScope ? cfgScope.getSnapshot() : null);

    // ─────────── 对话文件点击接管（设置项，默认关闭）───────────
    // 官方对话中「产物文件」chips、markdown 内联代码提及与 read/write/edit
    // 工具行的文件链接都点击走 session.openWorkspacePath RPC → 系统默认程序
    // 打开（前两者渲染成 button[title=路径]，工具行是 button[class*=_fileLink]
    // 文本路径，详见拦截器注释）；插件 /dsh-kit/read 支持任意绝对路径，开启
    // cfg.chatOpenFilePreview 后在这里拦截并把路径交给右侧预览面板。
    // 判定链任何一环不命中都放行官方。
    let chatPreviewHook = null;

    /** title 是否为可接管路径：盘符/UNC/根斜杠绝对路径，或含分隔符的相对路径 */
    function isChatOpenPathish(title) {
      return (
        /^[A-Za-z]:[\\/]/.test(title) ||
        title.startsWith("\\\\") ||
        title.startsWith("/") ||
        (/[\\/]/.test(title) && !/\s/.test(title))
      );
    }

    /** 对话文件路径解析：绝对直接用；相对按 cwd 拼接（与官方 resolveWorkspacePath
     *  同语义）；反斜杠归一避免混用分隔符触发宿主校验问题。 */
    function resolveChatOpenPath(cwd, title) {
      // POSIX 写法的盘符绝对路径（/D:/… 或 \D:\…）先归一为盘符开头：这类路径
      // 官方 resolveWorkspacePath 同样按绝对处理，直接拼 cwd 会产出 D:\D:\…
      // 双盘符假路径（agent 回复里惯用 /D:/… 引用 Windows 绝对文件）。
      let t = title;
      if (/^\/[A-Za-z]:/.test(t)) t = t.slice(1);
      else if (/^\\[A-Za-z]:/.test(t)) t = t.slice(1);
      const raw =
        /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\")
          ? t
          : t.startsWith("/")
            ? `${cwd}\\${t.slice(1)}`
            : `${cwd}\\${t}`;
      const parts = raw.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
      const out = [];
      for (const s of parts) {
        if (s === "..") out.pop();
        else out.push(s);
      }
      // out 已含盘符元素（D:）或 UNC 的首段；盘符形不能再补 `D:\` 前缀，
      // 否则产出 D:\D:\… 双盘符（绝对盘符 title 曾因此读不到文件）
      if (raw.startsWith("\\\\")) return `\\\\${out.join("\\")}`;
      return out.join("\\");
    }

    /** document capture：开启配置后接管官方对话区文件打开按钮的点击。
     *  两种形态：① markdown 内联代码与「产物文件」chips → button[title=路径]；
     *  ② read/write/edit 工具行（ui-tool ToolRow）→ button[class*=_fileLink]，
     *     无 title，按钮文本即工具 path/file_path 参数按 cwd 相对化的路径
     *     （relativizeToCwd 剥掉的前缀由 resolveChatOpenPath 拼回，语义还原）。 */
    function onChatOpenFileClick(ev) {
      if (!ev.isTrusted) return;
      const hook = chatPreviewHook;
      if (!hook || !hook.ready) return;
      if (!(ev.target instanceof Element)) return;
      const btn =
        ev.target.closest("button[title]") || ev.target.closest('button[class*="_fileLink"]');
      if (!btn) return;
      // 插件自身面板/入口的元素不拦（title 可能是路径的只有文件树行等）。
      // 但命中元素必须是真插件容器：面板打开时 body 挂的让位标记类
      // （dshk-pane-open/dshk-open）是全体对话的祖先，若不剔除，预览/终端
      // 一开拦截就整体失效（点击放行官方 → 系统默认程序打开）
      const kitAnc = btn.closest('[class*="dshk-"]');
      if (kitAnc && kitAnc !== document.body && kitAnc !== document.documentElement) return;
      // 仅官方对话滚动区内的文件按钮（markdown 提及、产物 chips、工具行都在其中）
      if (!btn.closest('[class*="_scroll"]')) return;
      let path = (btn.getAttribute("title") || "").trim();
      if (path === "") {
        // ② 工具行 fileLink：文本必为路径（参数解析不出路径时官方渲染 span）；
        // 家目录缩写形态（~/…）客户端还原不了宿主 home，放行官方
        path = (btn.textContent || "").trim();
        if (path === "" || path.startsWith("~")) return;
      } else if (!isChatOpenPathish(path)) {
        return;
      }
      // 无会话工作区时：仅盘符绝对/UNC（含 /D:… 归一的盘符形态）可脱离 cwd
      // 预览；相对路径解析无依，放行官方
      if (!hook.cwd) {
        const t2 = path.startsWith("\\\\") ? path : path.replace(/^[\\/](?=[A-Za-z]:)/, "");
        if (!/^[A-Za-z]:[\\/]/.test(t2) && !t2.startsWith("\\\\")) return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      hook.openPreview(resolveChatOpenPath(hook.cwd, path));
    }

    // ─────────── 对话 @ 引用（文件树 → 输入框）───────────
    // 官方 ui-conversation 注册 `conversation` 服务（ConversationController），
    // 其 .input = InputHub，`hub.shell(当前会话 id)` 返回 SessionInputShell
    // （公开 actions.setDraft 草稿写入 + 官方 @ 面板同款插入体
    // insertReference(ref, span) 引用芯片直插）——文件树「@到对话」优先直插
    // 真实引用 chip（不弹官方 @ 面板），失败兜底追加 @ 语法文本，均与手打
    // @ 等价（提交后按官方 file-reference 语法解析）。使用点现取（懒解析）。
    /** 取当前会话的输入 shell；任一步未就绪返回 null */
    function currentComposerShell() {
      if (!slotsCtx) return null;
      let conv;
      try {
        conv = slotsCtx.get("conversation");
      } catch {
        return null;
      }
      const hub = conv && conv.input;
      if (!hub || typeof hub.shell !== "function") return null;
      let sessions;
      try {
        sessions = slotsCtx.get("sessions");
      } catch {
        return null;
      }
      const current = sessions?.list?.getSnapshot?.()?.current;
      if (!current) return null;
      try {
        return hub.shell(current) ?? null;
      } catch {
        return null;
      }
    }

    /** 官方 @ 引用文本（对齐 dsh-client-ui-reference 的 formatFileMention）：
     *  路径无空白 → @rel/path；有空白 → @"rel/a b.txt"；目录保留开放引号 @"dir/ */
    function chatMentionText(relPath) {
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(relPath)) return null;
      if (relPath.endsWith("/")) return /\s/u.test(relPath) ? `@"${relPath}` : `@${relPath}`;
      return /\s/u.test(relPath) ? `@"${relPath}"` : `@${relPath}`;
    }

    // ─────────── 文案 ───────────
    const zh = {
      label: "终端",
      noCwd: "没有可用的会话工作区：先打开或创建一个会话",
      connecting: "连接中…",
      exited: "已退出",
      code: "代码",
      restart: "重新启动终端",
      termNew: "新建终端",
      termHide: "隐藏终端坞（进程继续运行）",
      termTabClose: "结束此终端",
      termCloseAll: "结束全部终端",
      vendorFail: "终端组件加载失败",
      treeLabel: "文件树",
      treeClose: "关闭文件树",
      treeRefresh: "刷新",
      treeLoading: "加载中…",
      treeEmpty: "（空目录）",
      treeFail: "加载失败",
      treeTruncated: "条目过多，列表已截断",
      treeNewFile: "新建文件",
      treeNewFolder: "新建文件夹",
      treeUpload: "上传文件到当前目录",
      uploadDone: "已上传 {n} 个文件",
      uploadFail: "上传失败",
      treeRename: "重命名",
      treeDelete: "删除",
      treeCopyAbs: "复制绝对路径",
      treeCopyRel: "复制相对路径",
      treeCopied: "已复制路径",
      treeAt: "@ 到对话",
      treeAtUnavailable: "输入框未就绪（无会话或不可用）",
      treeMenu: "更多操作",
      promptFileName: "新文件名：",
      promptFolderName: "新文件夹名：",
      confirmDelete: "删除「{name}」？内容将移入回收站。",
      created: "已创建",
      renamed: "已重命名",
      deleted: "已删除",
      scTitle: "源代码管理",
      scStaged: "暂存的更改",
      scChanges: "更改",
      scEmpty: "（没有更改）",
      scNotGit: "当前目录不是 git 仓库",
      scInit: "初始化仓库",
      scInitFail: "初始化失败",
      scStage: "暂存",
      scUnstage: "取消暂存",
      scDiscard: "放弃更改",
      scDiscardConfirm: "放弃该文件的未暂存改动？此操作不可恢复。",
      cmtPlaceholder: "提交信息（必填）",
      scCommit: "提交",
      scCommitAll: "提交全部更改",
      cmtAllConfirm: "暂存区为空，将暂存并提交全部更改（含新文件）。继续？",
      committed: "已提交",
      scBranch: "分支",
      scBranchNew: "新分支名（Enter 新建）",
      scBranchCreate: "新建",
      scBranchCreateSwitch: "新建并切换",
      scBranchSwitch: "切换分支",
      scBranchDelete: "删除分支",
      scBranchDeleteConfirm: "删除分支「{name}」？",
      scBranchForceConfirm: "该分支未合并，强制删除？（分支上的提交可能丢失）",
      scBranchCurrent: "当前",
      scBranchEmpty: "（暂无分支）",
      scBranchCreated: "已创建分支 {name}",
      scBranchNewTag: "新建",
      scBranchCreatedTag: "本次新建的分支",
      scBranchSwitched: "已切换到 {name}",
      scBranchDeleted: "已删除分支 {name}",
      scBranchOpFail: "分支操作失败",
      scBranchUpstream: "上游",
      scDetached: "分离头",
      scActions: "更多操作",
      scPublish: "发布分支",
      scPush: "推送到远程",
      scPushAhead: "推送 {n} 个提交到远程",
      scBehind: "落后 {n} 个提交",
      scPushDone: "已推送",
      scPushFail: "推送失败",
      scPushNoUpstream: "当前分支没有上游，首次推送前需先设置",
      scPushSetUpstream: "设置上游并推送",
      scGraph: "提交图谱",
      scGraphEmpty: "（尚无提交）",
      scGraphFail: "图谱加载失败",
      scCommitDetail: "提交详情",
      scBack: "返回",
      scMergedCommit: "合并提交",
      scAuthored: "作者",
      scFiles: "更改的文件",
      contentClose: "关闭预览",
      toDiff: "切换到 diff 视图",
      toText: "切换到原文视图",
      edit: "编辑",
      editSave: "保存",
      editCancel: "取消",
      editSaved: "已保存",
      editFail: "保存失败",
      editConflict: "文件在打开后被外部修改，重新加载最新版本？",
      diffFail: "diff 加载失败",
      diffEmpty: "（无未暂存差异）",
      diffUntracked: "未跟踪文件，暂无 diff",
      mdCopyCode: "复制代码",
      mdCopied: "已复制",
      gitM: "已修改",
      gitA: "新文件",
      gitD: "已删除",
      gitR: "重命名",
      gitU: "未跟踪",
      gitTip: "git 变更",
      contentLoading: "加载中…",
      contentBinary: "二进制文件，无法预览",
      pdfNewTab: "在新标签页打开",
      pdfJump: "跳转到指定页",
      sheetRowCap: "表格较大，仅加载部分行列；悬停单元格可看完整内容",
      previewTooLarge: "文件超过 20MB，不预览",
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
      cfgDesc: "终端 / 文件树 / 技能页 / 网页搜索的功能开关与快捷键。",
      cfgTerminalEnabled: "启用终端",
      cfgTerminalEnabledHint: "关闭后隐藏入口按钮与快捷键",
      cfgFileTreeEnabled: "启用文件树",
      cfgFileTreeEnabledHint: "关闭后隐藏入口按钮与快捷键",
      cfgChatOpenFilePreview: "对话文件用插件预览打开",
      cfgChatOpenFilePreviewHint: "对话中的产物/提及文件点击后改用插件预览（默认由系统程序打开）",
      cfgSkillsPageEnabled: "启用技能页",
      cfgSkillsPageEnabledHint: "关闭后设置里不显示「技能」页",
      cfgSearchEnabled: "启用网页搜索",
      cfgSearchEnabledHint: "关闭后走官方搜索渠道（重启生效）",
      cfgSearchMaxResults: "搜索结果条数",
      cfgSearchMaxResultsHint: "1-8，默认 5；越多越耗上下文，保存即生效",
      cfgPhoneEnabled: "显示「手机访问」页",
      cfgPhoneEnabledHint: "在设置中显示「手机访问」页",
      cfgJobsEnabled: "启用后台任务面板",
      cfgJobsEnabledHint: "输入框旁的任务按钮：查看并结束后台任务",
      cfgBrowserEnabled: "启用内置浏览器",
      cfgBrowserEnabledHint: "输入框旁的浏览器按钮：实时画面查看并操作 agent 的浏览器（重启生效）",
      cfgPreviewMaxTabs: "文件预览最多标签数",
      cfgPreviewMaxTabsHint: "预览标签超过该数时，打开新文件自动关掉最久没看的那个（1-20，即时生效）",
      browserTitle: "浏览器",
      browserUrlPh: "输入网址，回车打开",
      browserGo: "打开",
      browserBack: "后退",
      browserForward: "前进",
      browserReload: "刷新",
      browserNewTab: "新建页签",
      browserCloseTab: "关闭页签",
      browserStarting: "浏览器启动中…",
      browserReconnect: "连接断开，重连中…",
      browserAgentPage: "agent 正在此页操作",
      browserNotRunning: "浏览器未启动——在上方输入网址回车，或等 agent 首次使用时自动拉起",
      dockPreview: "预览",
      dockJobs: "任务",
      dockBrowser: "浏览器",
      dockClose: "关闭标签",
      pvCloseTab: "关闭此预览",
      pvDeletedNote: "文件已删除——此预览仅展示删除 diff；可在源代码管理里 ↩ 恢复文件",
      dockCloseAll: "全部关闭",
      dockMinimize: "最小化面板",
      dockRestore: "展开面板",
      browserStarting: "正在拉起浏览器…",
      browserErr: "浏览器出错：{error}",
      phoneGateStart: "启动网关",
      phoneGateStop: "关闭网关",
      phoneStoppedHint: "网关未启动。开启后可用「刷新链接」作废旧链接。",
      cfgRemoteHint: "非本机访问：上游把设置镜像钉在本机浏览器，配置在手机/远程只读——请在电脑端查看与修改。",
      cfgPhoneRemoteDomain: "远程域名",
      cfgPhonePort: "网关端口",
      cfgPhonePortHint: "手机网关监听端口，1-65535（默认 3090）；保存后网关自动按新端口重启。",
      cfgPhoneKeepGatewayOn: "重启后保留开启",
      cfgPhoneKeepGatewayOnHint: "重启后恢复上次的开启状态（保存后下次启动生效）",
      phoneTitle: "手机访问",
      phoneStatusOn: "网关运行中 · 端口 {port}",
      phoneStatusErr: "网关未运行：{error}",
      phoneLoading: "正在生成链接…",
      phoneLoadFail: "读取失败：{error}",
      phoneLan: "局域网",
      phoneRemote: "远程",
      phoneScanHint: "用手机浏览器扫码，或复制地址到手机打开；首次打开后该设备长期有效。",
      phoneCopy: "复制链接",
      phoneCopied: "已复制",
      phoneRemoteCaution: "远程链接含访问令牌，二维码谨防被他人扫码。",
      phonePortInvalid: "端口需为 1-65535 的整数",
      phoneRotate: "刷新链接",
      phoneRotateHint: "作废当前链接并生成新链接，已授权设备将全部失效。",
      phoneRotated: "链接已刷新，旧链接已失效",
      phoneRotateFail: "刷新失败：{error}",
      jobsTitle: "后台任务",
      jobsEmpty: "没有运行中的后台任务。",
      jobsStatusRunning: "运行中",
      jobsStatusStopping: "停止中",
      jobsStatusCompleted: "已完成",
      jobsStatusKilled: "已结束",
      jobsStatusFailed: "失败",
      jobsDuration: "已运行 {duration}",
      jobsKill: "结束",
      jobsKillHint: "结束此任务（等同 job_kill）",
      jobsKillDone: "已请求结束",
      jobsKillFail: "结束失败：{error}",
      jobsClose: "关闭任务面板",
      jobsOutput: "输出",
      jobsOutputHint: "查看此任务的实时输出（与 job_output 共享读取游标）",
      jobsOutputEmpty: "（暂无输出）",
      jobsOutputTransient: "输出读取失败：{error}",
      cfgTerminalShortcut: "终端快捷键",
      cfgFileTreeShortcut: "文件树快捷键",
      cfgSidebarShortcut: "侧边栏展开/收起快捷键",
      cfgSidebarShortcutEnabled: "启用侧边栏快捷键",
      cfgSidebarShortcutEnabledHint: "关闭后快捷键不再响应",
      cfgSourceControlEnabled: "启用源代码管理",
      cfgSourceControlEnabledHint: "关闭后隐藏入口按钮与快捷键",
      cfgScShortcut: "源代码管理快捷键",
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
      invalidNumber: "需为 1-8 的整数。",
    };
    const en = {
      label: "Terminal",
      noCwd: "No session workspace available: open or create a session first",
      connecting: "Connecting…",
      exited: "Exited",
      code: "code",
      restart: "Restart terminal",
      termNew: "New terminal",
      termHide: "Hide dock (processes keep running)",
      termTabClose: "Kill this terminal",
      termCloseAll: "Kill all terminals",
      vendorFail: "Failed to load terminal components",
      treeLabel: "Files",
      treeClose: "Close file tree",
      treeRefresh: "Refresh",
      treeLoading: "Loading…",
      treeEmpty: "(empty)",
      treeFail: "Failed to load",
      treeTruncated: "Too many entries, list truncated",
      treeNewFile: "New File",
      treeNewFolder: "New Folder",
      treeUpload: "Upload files to this folder",
      uploadDone: "Uploaded {n} file(s)",
      uploadFail: "Upload failed",
      treeRename: "Rename",
      treeDelete: "Delete",
      treeCopyAbs: "Copy absolute path",
      treeCopyRel: "Copy relative path",
      treeCopied: "Path copied",
      treeAt: "Insert @ mention",
      treeAtUnavailable: "Composer is not ready (no active session)",
      treeMenu: "More actions",
      promptFileName: "New file name:",
      promptFolderName: "New folder name:",
      confirmDelete: "Delete \"{name}\"? It will be moved to the Recycle Bin.",
      created: "Created",
      renamed: "Renamed",
      deleted: "Deleted",
      scTitle: "Source Control",
      scStaged: "Staged Changes",
      scChanges: "Changes",
      scEmpty: "(no changes)",
      scNotGit: "This folder is not in a git repository",
      scInit: "Initialize Repository",
      scInitFail: "git init failed",
      scStage: "Stage",
      scUnstage: "Unstage",
      scDiscard: "Discard changes",
      scDiscardConfirm: "Discard unstaged changes in this file? This cannot be undone.",
      cmtPlaceholder: "Commit message (required)",
      scCommit: "Commit",
      scCommitAll: "Commit All",
      cmtAllConfirm: "Nothing staged. Stage ALL changes (including untracked) and commit?",
      committed: "Committed",
      scBranch: "Branches",
      scBranchNew: "New branch name (Enter to create)",
      scBranchCreate: "Create",
      scBranchCreateSwitch: "Create & switch",
      scBranchSwitch: "Switch branch",
      scBranchDelete: "Delete branch",
      scBranchDeleteConfirm: "Delete branch \"{name}\"?",
      scBranchForceConfirm: "This branch is not fully merged. Force delete? (commits on it may be lost)",
      scBranchCurrent: "current",
      scBranchEmpty: "(no branches)",
      scBranchCreated: "Created branch {name}",
      scBranchNewTag: "new",
      scBranchCreatedTag: "Just created",
      scBranchSwitched: "Switched to {name}",
      scBranchDeleted: "Deleted branch {name}",
      scBranchOpFail: "Branch operation failed",
      scBranchUpstream: "upstream",
      scDetached: "detached HEAD",
      scActions: "More actions…",
      scPublish: "Publish branch",
      scPush: "Push to remote",
      scPushAhead: "Push {n} commit(s) to remote",
      scBehind: "{n} commit(s) behind",
      scPushDone: "Pushed",
      scPushFail: "Push failed",
      scPushNoUpstream: "This branch has no upstream; set one before the first push",
      scPushSetUpstream: "Set upstream & push",
      scGraph: "Commit graph",
      scGraphEmpty: "(no commits yet)",
      scGraphFail: "Failed to load graph",
      scCommitDetail: "Commit detail",
      scBack: "Back",
      scMergedCommit: "Merge commit",
      scAuthored: "Author",
      scFiles: "Changed files",
      contentClose: "Close preview",
      toDiff: "Switch to diff view",
      toText: "Switch to plain view",
      diffFail: "Failed to load diff",
      diffEmpty: "(no unstaged changes)",
      diffUntracked: "Untracked file, no diff yet",
      mdCopyCode: "Copy",
      mdCopied: "Copied",
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
      pdfNewTab: "Open in new tab",
      pdfJump: "Jump to page",
      sheetRowCap: "Large sheet: partially loaded; hover a cell for full content",
      previewTooLarge: "File exceeds 20MB, preview skipped",
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
      cfgDesc: "Feature switches and shortcuts for terminal / files / skills / web search.",
      cfgTerminalEnabled: "Enable terminal",
      cfgTerminalEnabledHint: "Hides the entry button and its shortcut",
      cfgFileTreeEnabled: "Enable file tree",
      cfgFileTreeEnabledHint: "Hides the entry button and its shortcut",
      cfgChatOpenFilePreview: "Open chat files in plugin preview",
      cfgChatOpenFilePreviewHint: "Chat produced/mentioned file links open in the plugin preview pane (system default app otherwise)",
      cfgSkillsPageEnabled: "Enable skills page",
      cfgSkillsPageEnabledHint: "Hides the Skills page in Settings",
      cfgSearchEnabled: "Enable web search",
      cfgSearchEnabledHint: "Off = the official search channel (restart to apply)",
      cfgSearchMaxResults: "Search result count",
      cfgSearchMaxResultsHint: "1-8, default 5; more uses more context; applies on save",
      cfgPhoneEnabled: "Show phone access page",
      cfgPhoneEnabledHint: "Shows the \"Phone access\" page in Settings",
      cfgJobsEnabled: "Enable background jobs panel",
      cfgJobsEnabledHint: "Composer-side button to watch and stop background jobs",
      cfgBrowserEnabled: "Enable built-in browser",
      cfgBrowserEnabledHint: "Composer-side browser button: watch and operate the agent's browser (restart to apply)",
      cfgPreviewMaxTabs: "Max file preview tabs",
      cfgPreviewMaxTabsHint: "Beyond the limit, opening a new file closes the least-recently-viewed preview tab (1-20, applies immediately)",
      browserTitle: "Browser",
      browserUrlPh: "Type a URL and press Enter",
      browserGo: "Go",
      browserBack: "Back",
      browserForward: "Forward",
      browserReload: "Reload",
      browserNewTab: "New tab",
      browserCloseTab: "Close tab",
      browserStarting: "Browser starting…",
      browserReconnect: "Reconnecting…",
      browserAgentPage: "agent is working on this page",
      browserNotRunning: "Browser not started — type a URL above or wait for the agent's first use",
      dockPreview: "Preview",
      dockJobs: "Jobs",
      dockBrowser: "Browser",
      dockClose: "Close tab",
      pvCloseTab: "Close preview",
      pvDeletedNote: "File deleted — this preview shows the deletion diff only; restore it via ↩ in source control",
      dockCloseAll: "Close all",
      dockMinimize: "Minimize panel",
      dockRestore: "Expand panel",
      browserStarting: "Starting browser…",
      browserErr: "Browser error: {error}",
      phoneGateStart: "Start gateway",
      phoneGateStop: "Stop gateway",
      phoneStoppedHint: "Gateway is off. Use \"New link\" after starting to invalidate old links.",
      cfgRemoteHint: "Non-local access: upstream pins the settings mirror to the local machine, so config stays read-only here — please view and edit it on the computer.",
      cfgPhoneRemoteDomain: "Remote domain",
      cfgPhonePort: "Gateway port",
      cfgPhonePortHint: "Port the phone gateway listens on, 1-65535 (default 3090); the gateway restarts on the new port after saving.",
      cfgPhoneKeepGatewayOn: "Keep enabled across restarts",
      cfgPhoneKeepGatewayOnHint: "Restores the last enabled state on restart (applies next start)",
      cfgTerminalShortcut: "Terminal shortcut",
      cfgFileTreeShortcut: "File tree shortcut",
      cfgSidebarShortcut: "Sidebar toggle shortcut",
      cfgSidebarShortcutEnabled: "Enable sidebar shortcut",
      cfgSidebarShortcutEnabledHint: "Disables the sidebar shortcut",
      cfgSourceControlEnabled: "Enable source control",
      cfgSourceControlEnabledHint: "Hides the entry button and its shortcut",
      cfgScShortcut: "Source control shortcut",
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
      invalidNumber: "Must be an integer from 1-8.",
      phoneTitle: "Phone access",
      phoneStatusOn: "Gateway running · port {port}",
      phoneStatusErr: "Gateway not running: {error}",
      phoneLoading: "Generating links…",
      phoneLoadFail: "Failed to load: {error}",
      phoneLan: "LAN",
      phoneRemote: "Remote",
      phoneScanHint: "Scan with your phone browser, or copy the address over; a device stays authorized once opened.",
      phoneCopy: "Copy link",
      phoneCopied: "Copied",
      phoneRemoteCaution: "The remote link carries an access token; keep the QR code from being scanned by others.",
      phonePortInvalid: "Port must be an integer from 1-65535",
      phoneRotate: "New link",
      phoneRotateHint: "Invalidate the current link and issue a new one; all authorized devices are signed out.",
      phoneRotated: "Link rotated; the old one is dead",
      phoneRotateFail: "Rotate failed: {error}",
      jobsTitle: "Background jobs",
      jobsEmpty: "No running background jobs.",
      jobsStatusRunning: "running",
      jobsStatusStopping: "stopping",
      jobsStatusCompleted: "completed",
      jobsStatusKilled: "cancelled",
      jobsStatusFailed: "failed",
      jobsDuration: "Running for {duration}",
      jobsKill: "Stop",
      jobsKillHint: "Stop this job (same as job_kill)",
      jobsKillDone: "Stop requested",
      jobsKillFail: "Failed to stop: {error}",
      jobsClose: "Close tasks panel",
      jobsOutput: "Output",
      jobsOutputHint: "View live output (shares the read cursor with job_output)",
      jobsOutputEmpty: "(no output yet)",
      jobsOutputTransient: "Failed to read output: {error}",
    };
    /** 语言判定：只认 DSH 的 locale 权威 —— <html lang> 由 dsh-client-locale 的
     *  syncDocumentLanguage 在启动与每次切换时同步（设置→通用→语言），页面内
     *  恒有值（服务端标记初始为 en）。不设 navigator.language 回退：中文系统
     *  浏览器语言恒为 zh-CN，回退会把 DSH 已切到英文的界面锁回中文（实测回归的
     *  根源）；且 DSH 自身无浏览器语言匹配时的兜底语义就是英文（FALLBACK_LOCALE），
     *  插件保持一致即可。非 zh 一律按英文渲染。 */
    function resolveZh() {
      if (typeof document === "undefined" || !document.documentElement) return false;
      return /^zh/i.test(document.documentElement.lang || "");
    }
    // 每次现读现判，不在模块加载时钉死：DSH 的 locale 服务异步把语言同步到
    // <html lang>（syncDocumentLanguage），时机晚于本 bundle 顶层执行，一次性求值
    // 会拿到旧值而把界面锁死在英文。
    const lang = () => (resolveZh() ? zh : en);
    const t = (key) => lang()[key] ?? key;
    /** 带占位符的文案变体：tf("phoneStatusOn", { port: 3090 }) */
    const tf = (key, vars) => {
      let s = lang()[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) s = s.split(`{${name}}`).join(String(value));
      return s;
    };

    // 语言切换响应：外部 store + <html lang> 的 MutationObserver。DSH 异步改写
    // <html lang> 后 bump version，组件经 useSyncExternalStore 订阅 version，
    // 变化即 re-render，届时 t/tf 已读到新语言。与上方 cfg 快照订阅同一模式。
    const localeStore = { version: 0, listeners: new Set() };
    const subscribeLocale = (fn) => {
      localeStore.listeners.add(fn);
      return () => localeStore.listeners.delete(fn);
    };
    const getLocaleVersion = () => localeStore.version;
    if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
      let lastLang = document.documentElement.lang || "";
      new MutationObserver(() => {
        const cur = document.documentElement.lang || "";
        if (cur !== lastLang) {
          lastLang = cur;
          localeStore.version++;
          for (const l of localeStore.listeners) {
            try { l(); } catch (_e) { /* ignore */ }
          }
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

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
/* 多终端：入口图标数量角标 + 标签条 + 堆叠 pane（隐藏 pane 离屏缓冲输出） */
.dshk-enbtn{position:relative}
.dshk-term-badge{position:absolute;top:-4px;right:-4px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:600}
.dshk-tabs{display:inline-flex;align-items:center;gap:2px;min-width:0;overflow:hidden}
.dshk-tab{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 5px 0 9px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;max-width:170px;user-select:none}
.dshk-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-tab-on,.dshk-tab-on:hover{background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary)}
.dshk-tab-label{overflow:hidden;text-overflow:ellipsis}
.dshk-tab-x{appearance:none;border:0;background:none;color:inherit;width:15px;height:15px;border-radius:4px;font-size:10px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;visibility:hidden}
.dshk-tab:hover .dshk-tab-x,.dshk-tab-x:hover{visibility:visible}
.dshk-tab-x:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-tstack{position:relative;flex:1 1 auto;min-height:0}
.dshk-tpane{position:absolute;inset:0;padding:2px 8px 8px;box-sizing:border-box;display:none}
.dshk-tpane[data-on]{display:block}
.dshk-tbody{height:100%;position:relative}
.dshk-term-note{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:8px;max-width:92%;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);pointer-events:none;z-index:5}
.dshk-term-note button{pointer-events:auto}
/* 让位布局：终端打开时把对话列顶起，内容不被遮挡（终端宽度即对话列宽） */
body.dshk-open [class*="_centerCol"]{padding-bottom:var(--dshk-dock-h,${DOCK_H})}
/* 面板开合只保留 dock 的 padding-bottom 过渡：margin-right 如果也带过渡动画，
   每帧都会触发官方对话宽度 ResizeObserver 重发布 + 长消息流重排（卡顿），
   让位改为瞬时完成一次，视觉缓冲交给面板自身的 width 过渡 */
[class*="_centerCol"]{transition:padding-bottom .18s ease}
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
/* 行内改名输入框（✎ 触发）：聚焦时只选中最后一个扩展名分隔符之前的主名 */
.dshk-rename{appearance:none;flex:1 1 auto;min-width:0;height:22px;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;padding:0 6px}
.dshk-rename:focus-visible{outline:none}
.dshk-note{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
/* 入口按钮选中态：底色用主题真实存在的 tool-bar-fill，图标转品牌色；
   :hover 一并声明避免 hover 规则在选中态下把底色洗掉 */
.dshk-enbtn[aria-pressed="true"],.dshk-enbtn[aria-pressed="true"]:hover{background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-brand-primary)}
/* 文件预览面板：fixed 停靠右侧（自绘，不依赖原生 details 列，宽度自控 --dshk-pane-w） */
.dshk-pane{position:fixed;top:0;right:0;bottom:0;width:var(--dshk-pane-w,560px);display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-6px 0 20px rgba(0,0,0,.10);z-index:790;pointer-events:auto;transition:width .18s var(--ds-ease-in-out)}
.dshk-pane[data-dragging]{transition:none}
.dshk-pane-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 10px 12px}
.dshk-pane-pre{margin:0;padding:4px 0;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;tab-size:4;-webkit-overflow-scrolling:touch;user-select:text}
/* PDF 预览：pdf.js 逐页 canvas，纵向滚动（面板身即滚动容器）。懒加载：
   全量占位（第 1 页纵横比）撑出真实滚动条，进预载区才渲染 canvas、滚远释放位图；
   右下角 sticky 悬浮页码指示器（当前页实时 + 输入回车跳页） */
.dshk-pdfwrap{padding:8px 0 16px;display:flex;flex-direction:column;align-items:center}
.dshk-pdf-scroll{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%}
.dshk-pdf-slot{background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25);max-width:100%;display:flex;align-items:center;justify-content:center}
.dshk-pdf-slotno{color:#9a9a9a;font-size:13px;user-select:none}
/* 页码指示器挂预览面板标题栏（固定 UI 区，不遮内容），占位/canvas 全由 mountPdfViewer 管 */
.dshk-pdf-indicator{flex:none;display:flex;align-items:center;gap:2px;padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshk-pdf-jump{width:3.2em;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:center;outline:none}
/* Excel 预览：工作表标签 + 虚拟滚动表（冻结表头 sticky、窗口渲染、固定行高列宽，
   单元格 textContent 注入免消毒） */
.dshk-sheetwrap{padding:6px 0 16px;display:flex;flex-direction:column;gap:8px}
.dshk-sheet-tabs{display:flex;gap:4px;flex-wrap:wrap}
.dshk-sheet-tab{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 10px;font-size:12px;cursor:pointer;max-width:14em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshk-sheet-tab-on,.dshk-sheet-tab-on:hover{background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);border-color:transparent}
.dshk-sheet-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.dshk-sheet-head{position:sticky;top:0;z-index:2;display:flex;width:max-content;min-width:100%;background:var(--dsw-alias-bg-base);border-bottom:2px solid var(--dsw-alias-border-l2)}
.dshk-sheet-hcell{flex:none;padding:0 8px;line-height:25px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshk-sheet-body{position:relative}
.dshk-sheet-window{position:absolute;left:0}
.dshk-sheet-row{display:flex;width:max-content;min-width:100%}
.dshk-sheet-cell{flex:none;padding:0 8px;line-height:25px;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshk-sheet-num{text-align:right;font-variant-numeric:tabular-nums}
/* docx 预览：mammoth 语义 HTML 复用 .dshk-md 排版，补表格/图片规则 */
.dshk-docwrap{padding:8px 0 16px}
.dshk-doc{max-width:72em;margin:0 auto}
.dshk-doc table,.dshk-md table{border-collapse:collapse}
.dshk-doc td,.dshk-doc th,.dshk-md td,.dshk-md th{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px}
.dshk-doc img{max-width:100%}
/* 拖拽手柄：面板左缘 6px 竖条，拖动更新 --dshk-pane-w */
.dshk-pane-handle{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:791;touch-action:none}
.dshk-pane-handle:hover::after{content:"";position:absolute;left:2px;top:0;bottom:0;width:2px;background:var(--dsw-alias-interactive-bg-hover);border-radius:2px}
/* 让位布局：面板打开时中列（对话）右侧让出 --dshk-pane-w，对话随之左移 */
body.dshk-pane-open [class*="_centerCol"]{margin-right:var(--dshk-pane-w,560px)}
@media (prefers-reduced-motion:reduce){body.dshk-pane-open [class*="_centerCol"]{transition:none}}
/* 官方轮次导航横条（TurnNavigator，v0.1.2-alpha.5 起）：面板打开压缩对话列后，
   官方按容器宽度（@container width<=900px）把它隐藏——这里恢复显示；横条随对话
   列左移后自然落在面板左侧，hover 预览与点击跳转保持可用。语义后缀选择器同
   _centerCol 先例，不命中 dshk-* 自身类 */
body.dshk-pane-open [class*="_scroll"] > [class*="_slot"]{display:block!important}
/* 技能管理页（settings.section）：三分组卡片；技能行单行布局，操作不换行、描述先收缩 */
.dshk-sk{font-size:13px;color:var(--dsw-alias-label-primary);user-select:text}
.dshk-sk-head{display:flex;align-items:center;gap:8px;margin:2px 0 10px}
.dshk-sk-title{font-weight:600;font-size:14px}
.dshk-sk-status{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshk-sk-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:12px;overflow:hidden}
.dshk-sk-group-head{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px}
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
.dshk-sk-target{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-top:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover)}
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
.dshk-cfg-field{display:flex;align-items:center;gap:8px;padding:8px 0}
.dshk-cfg-group ~ .dshk-cfg-group{border-top:1px solid var(--dsw-alias-border-l2)}
.dshk-cfg-sub{margin-left:14px}
.dshk-cfg-label{flex:none;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshk-cfg-badges{display:inline-flex;align-items:center;gap:8px;flex:none;height:19px;margin-left:auto}
.dshk-cfg-badge{display:inline-flex;align-items:center;height:19px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dshk-cfg-reset{font:inherit;background:none;border:0;padding:0;height:18px;display:inline-flex;align-items:center;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dshk-cfg-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshk-cfg-check{flex:none;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dshk-cfg-hint{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshk-cfg-invalid{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshk-cfg-status{padding:6px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dshk-cfg-combo{appearance:none;flex:1;min-width:0;font:inherit;font-family:ui-monospace,Consolas,monospace;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;line-height:1.5}
.dshk-cfg-combo:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-cfg-combo:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-cfg-combo[data-capturing]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}
.dshk-cfg-text{flex:1;min-width:0;width:200px;font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;line-height:1.5}
.dshk-cfg-num{flex:none;width:64px}
.dshk-phone-port{flex:none;width:5.5em;font-size:11px;padding:5px 8px}
.dshk-cfg-text:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-cfg-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}
.dshk-cfg-err{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dshk-cfg-btn{appearance:none;font:inherit;cursor:pointer;font-size:13px;line-height:1.5;border-radius:8px;padding:5px 14px}
.dshk-cfg-btn-discard{background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshk-cfg-btn-save{border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff}
.dshk-cfg-btn[disabled]{opacity:.5;cursor:default}
/* 手机访问页（settings.section 内联区块，与技能页同级） */
.dshk-phone{width:100%;max-width:460px}
.dshk-phone-head{display:flex;align-items:center;gap:8px;margin:2px 0 10px}
.dshk-phone-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshk-phone-status{margin:0 0 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dshk-phone-notice{font-size:11px;line-height:1.5;color:var(--dsw-alias-brand-primary)}
.dshk-phone-body{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding-bottom:4px}
.dshk-phone-tabs{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3)}
.dshk-phone-tab{appearance:none;border:0;background:none;font:inherit;font-size:11px;line-height:1;padding:5px 12px;border-radius:999px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshk-phone-tab[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);color:#fff}
.dshk-phone-qrwrap{display:flex;align-items:center;justify-content:center;min-height:120px;border-radius:10px;background:#fff;padding:6px;align-self:center}
.dshk-phone-urlrow{display:flex;align-items:center;gap:6px;width:100%}
.dshk-phone-copybtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1;padding:7px 10px;border-radius:8px;cursor:pointer}
.dshk-phone-copybtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-phone-copybtn[disabled]{opacity:.5;cursor:default}
.dshk-phone-hint{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.dshk-phone-domain{display:flex;align-items:center;gap:6px;width:100%;margin-bottom:10px}
.dshk-phone-domain-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshk-phone-domain-input{flex:1;min-width:0;font-size:11px;padding:5px 8px}
.dshk-phone-gatebtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;padding:9px 10px;border-radius:8px;cursor:pointer;width:100%;margin-bottom:10px}
.dshk-phone-rotate{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;padding:7px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.dshk-phone-rotate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-phone-rotate[disabled]{opacity:.5;cursor:default}
.dshk-phone-gatebtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-phone-gatebtn[disabled]{opacity:.5;cursor:default}
.dshk-phone-gatebtn-stop{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
/* 后台任务面板（任务按钮 + 居中浮层）。点击遮罩收起（kn应行为同 terminal 坞） */
/* 后台任务面板：右侧停靠（复用 .dshk-pane，与文件预览互斥共享停靠位） */
.dshk-jobs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshk-jobs-headside{display:flex;align-items:center;gap:6px}
.dshk-jobs-count{font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshk-jobs-close{appearance:none;border:1px solid transparent;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;width:22px;height:22px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.dshk-jobs-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-jobs-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:1px;overflow:auto;padding:0 10px 10px}
.dshk-jobs-row{display:flex;flex-direction:column;gap:4px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-fill-l2,transparent)}
.dshk-jobs-row[data-live="true"]{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.dshk-jobs-rowline{display:flex;align-items:center;gap:8px;min-width:0}
.dshk-jobs-kind{flex:none;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);border-radius:5px;padding:0 6px;font-size:11px;line-height:18px}
.dshk-jobs-label{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dshk-jobs-status{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshk-jobs-actions{display:flex;align-items:center;gap:6px;flex:none}
.dshk-jobs-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1;padding:4px 9px;border-radius:6px;cursor:pointer}
.dshk-jobs-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-jobs-btn:disabled{opacity:.5;cursor:default}
.dshk-jobs-btn-kill{border-color:color-mix(in srgb,var(--dsw-alias-danger,#cd3131) 45%,transparent);color:var(--dsw-alias-danger,#cd3131)}
.dshk-jobs-output{margin-top:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;user-select:text}
.dshk-jobs-empty{padding:10px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}
/* 内置浏览器面板：右侧停靠（复用 .dshk-pane）；URL 栏 + 实时画面 canvas（人机共驾） */
/* 右侧标签页容器：内容视图占满（非激活标签 display:none 保挂载） */
.dshk-pane-view{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.dshk-brw-tabrow,.dshk-pv-tabrow{flex:none;display:flex;align-items:center;gap:4px;padding:8px 10px 2px;min-width:0;overflow:hidden}
.dshk-tab-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-brand-primary);flex:none}
.dshk-brw-newtab{padding:0 7px;font-size:13px}
.dshk-brw-nav{flex:none;min-width:26px}
.dshk-jobs-btn:disabled{opacity:.4;cursor:default}
.dshk-brw-bar{display:flex;gap:6px;padding:0 12px 8px}
.dshk-brw-url{flex:1;min-width:0;font-size:12px;font-family:ui-monospace,Consolas,monospace;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dshk-brw-url:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshk-brw-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:0 10px 10px;overflow:hidden}
.dshk-brw-canvas{max-width:100%;height:auto;margin:auto 0;display:block;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);outline:none}
.dshk-brw-canvas:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dshk-brw-note{padding:8px 12px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
/* 最小化状态的右缘竖条：窄、贴边、垂直文字 */
.dshk-dock-stub{position:fixed;right:0;top:30%;writing-mode:vertical-rl;padding:12px 5px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-right:0;border-radius:8px 0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;z-index:789;box-shadow:-4px 0 12px rgba(0,0,0,.08);transition:color .12s var(--ds-ease-in-out),background .12s var(--ds-ease-in-out)}
.dshk-dock-stub:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* 透明 IME 输入：只做组合事件宿主，视觉隐形、不拦截点击 */
.dshk-brw-ime{position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;border:0;padding:0;margin:0;outline:none;pointer-events:none;z-index:-1;background:transparent}
/* 手机触控增强：斜杠菜单（input-trigger）在触屏上滚不动/悬停粘滞的兜底。
   类名是前端构建哈希（_3e4SsG_*），升级换哈希后本段静默失效——需跟随维护。 */
@media (hover: none) {
  [class*="_3e4SsG_menu"]{touch-action:pan-y}
  [class*="_3e4SsG_viewport"]{-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  [class*="_3e4SsG_item"]:hover{background:0 0}
  [class*="_3e4SsG_item"][class*="_3e4SsG_active"]{background:var(--dsw-alias-interactive-bg-hover)}
}
/* 轻提示（双击复制路径等的单例浮层） */
.dshk-toast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%) translateY(8px);z-index:950;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 16px rgba(0,0,0,.12);opacity:0;pointer-events:none;transition:opacity .15s var(--ds-ease-in-out),transform .15s var(--ds-ease-in-out)}
.dshk-toast[data-show]{opacity:1;transform:translateX(-50%) translateY(0)}
/* 预览 Markdown 渲染视图 */
.dshk-md{flex:1;min-height:0;overflow:auto;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);user-select:text}
.dshk-md h1,.dshk-md h2,.dshk-md h3,.dshk-md h4{margin:1.2em 0 .5em;line-height:1.3}
.dshk-md h1{font-size:1.5em}.dshk-md h2{font-size:1.3em}.dshk-md h3{font-size:1.15em}
.dshk-md p{margin:.6em 0}
.dshk-md ul,.dshk-md ol{margin:.6em 0;padding-left:1.5em}
.dshk-md code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:var(--dsw-alias-bg-layer-3);border-radius:4px;padding:.15em .35em}
.dshk-md pre{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;overflow:auto}
.dshk-md pre code{background:none;padding:0}
.dshk-md-code{margin:.6em 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.dshk-md-code pre{margin:0;border:0;border-radius:0}
.dshk-md-codebar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 10px;background:var(--dsw-alias-bg-layer-3);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshk-md-lang{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshk-md-copy{appearance:none;border:0;background:none;font:inherit;font-size:11px;line-height:1.4;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:2px 6px;border-radius:4px}
.dshk-md-copy:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshk-md blockquote{margin:.6em 0;padding:2px 12px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshk-md table{border-collapse:collapse;margin:.6em 0;font-size:12px}
.dshk-md th,.dshk-md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;text-align:left}
.dshk-md img{max-width:100%}
.dshk-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2);margin:1em 0}
.dshk-md a{color:var(--dsw-alias-brand-primary)}
/* CodeMirror 宿主与语法配色令牌（明暗两套，随 data-ds-dark-theme） */
.dshk-cm-host{flex:1;min-height:0;display:flex}
.dshk-cm-host .cm-editor{flex:1;min-width:0;height:100%;background:var(--dsw-alias-bg-base)}
.dshk-cm-host .cm-scroller{overflow:auto;height:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55}
/* 短文件长行：内容区至少撑满面板高度，横向滚动条钉在面板底部而非内容中部 */
.dshk-cm-host .cm-content{min-height:100%}
.dshk-cm-scope{--dshk-tok-keyword:#953800;--dshk-tok-string:#0a3069;--dshk-tok-comment:#697077;--dshk-tok-number:#0550ae;--dshk-tok-fn:#8250df;--dshk-tok-type:#0550ae;--dshk-tok-operator:#953800;--dshk-tok-meta:#6639ba;--dshk-tok-link:#0550ae;--dshk-tok-heading:#0550ae}
body[data-ds-dark-theme] .dshk-cm-scope{--dshk-tok-keyword:#ff7b72;--dshk-tok-string:#a5d6ff;--dshk-tok-comment:#8b949e;--dshk-tok-number:#79c0ff;--dshk-tok-fn:#d2a8ff;--dshk-tok-type:#ffa657;--dshk-tok-operator:#ff7b72;--dshk-tok-meta:#79c0ff;--dshk-tok-link:#a5d6ff;--dshk-tok-heading:#f0883e}
.dshk-editarea.dshk-cm-host{min-height:280px}
/* git 状态徽标与 diff 着色 */
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
/* 提交框 + 行悬停操作 + 可折叠组头（源代码管理） */
.dshk-cmt{display:flex;gap:6px;padding:8px 8px 2px}
.dshk-cmt-input{flex:1;min-width:0;height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:0 10px}
.dshk-cmt-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-chg-head{cursor:pointer;user-select:none}
.dshk-chg-chev{flex:none;font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .15s var(--ds-ease-in-out);display:inline-block}
.dshk-chg-chev[data-open]{transform:rotate(90deg)}
.dshk-rowact{display:none;gap:2px;align-items:center;margin-left:auto}
.dshk-row:hover .dshk-rowact,.dshk-chg-row:hover .dshk-rowact{display:inline-flex}
.dshk-rowact button{appearance:none;width:20px;height:20px;font-size:11px;line-height:1;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dshk-rowact button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 行 ⋯ 菜单：fixed 全局浮层（不受树 body 滚动裁切影响），主题令牌跟随 */
.dshk-menu{position:fixed;min-width:152px;padding:4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-elevation-panel,0 4px 16px rgba(0,0,0,.18));z-index:1200;font-size:13px}
.dshk-menu > button{display:flex;width:100%;align-items:center;gap:8px;border:0;background:none;color:var(--dsw-alias-label-primary);padding:6px 10px;border-radius:6px;cursor:pointer;text-align:left;white-space:nowrap}
.dshk-menu > button:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 全文件着色 diff：完整内容内联渲染，删除红/新增绿/上下文正常 */
.dshk-inline{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;padding:4px 0;user-select:text;color:var(--dsw-alias-label-secondary)}
.dshk-il-add{color:#0dbc79;background:rgba(13,188,121,.08)}
.dshk-il-del{color:#cd3131;background:rgba(205,49,49,.08)}
/* 「更改」清单（源代码管理视图） */
.dshk-changes{margin:2px 4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.dshk-chg-head{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}
.dshk-diff{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;padding:4px 0;white-space:pre;overflow-x:auto;user-select:text;color:var(--dsw-alias-label-secondary)}
.dshk-diff-add{color:#0dbc79;background:rgba(13,188,121,.08)}
.dshk-diff-del{color:#cd3131;background:rgba(205,49,49,.08)}
.dshk-diff-hunk{color:#4daafc}
.dshk-diff-meta{color:var(--dsw-alias-label-tertiary)}
/* 编辑模式 */
.dshk-edithost{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:4px 10px 12px}
.dshk-editbar{display:flex;align-items:center;gap:6px}
.dshk-editarea{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;padding:8px 10px;white-space:pre;overflow:auto}
.dshk-editarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshk-btn-save{appearance:none;border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff;border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 10px;cursor:pointer}
.dshk-btn-save[disabled]{opacity:.6;cursor:default}
.dshk-btn-cancel{appearance:none;background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 10px;cursor:pointer}
.dshk-btn-cancel:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
/* 源代码管理：分支/推送/图谱（头部工具、分支浮层、提交图谱） */
.dshk-headbtn{flex:none}
.dshk-headbtn-on{color:var(--dsw-alias-brand-primary)}
.dshk-branchbtn{display:inline-flex;align-items:center;gap:4px;max-width:150px;padding:2px 7px;border-color:var(--dsw-alias-border-l2)}
.dshk-branchbtn .dshk-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshk-caret{font-size:9px;color:var(--dsw-alias-label-tertiary)}
.dshk-pushhint{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshk-pushhint span{flex:1;min-width:0}
.dshk-branch{margin:2px 4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.dshk-branch-title{padding:5px 10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}
.dshk-branch-row{display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.dshk-branch-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-branch-cur{color:var(--dsw-alias-brand-primary)}
.dshk-branch-ico{flex:none;font-size:8px;color:var(--dsw-alias-label-tertiary)}
.dshk-branch-cur .dshk-branch-ico{color:var(--dsw-alias-brand-primary)}
.dshk-branch-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshk-branch-track{flex:none;font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshk-branch-gone{color:#e7757f}
.dshk-branch-curtag{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshk-branch-new{display:flex;gap:6px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshk-branch-new .dshk-cmt-input{height:26px;font-size:11px}
.dshk-branch-new .dshk-btn-save,.dshk-branch-new .dshk-btn-cancel{white-space:nowrap}
.dshk-branch-del{appearance:none;flex:none;width:18px;height:18px;font-size:10px;line-height:1;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:4px;padding:0}
.dshk-branch-newtag{flex:none;font-size:10px;color:var(--dsw-alias-brand-primary)}
.dshk-branch-del:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 分支按钮的领先/落后计数（vs 式 main ↑1↓2） */
.dshk-branch-ar{flex:none;font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary)}
/* 分支浮层（fixed 悬浮面板）：自带内部滚动，不参与 .dshk-tree 的 flex 挤压 */
.dshk-branch-menu{width:236px;max-height:min(70vh,420px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}
.dshk-branch-menu .dshk-branch-title{flex:none;padding:6px 10px 4px;background:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshk-branch-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 0}
.dshk-branch-menu .dshk-branch-new{flex:none;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
/* ⋯ 菜单禁用项 */
.dshk-menu > button[disabled]{opacity:.5;cursor:default}
.dshk-menu > button[disabled]:hover{background:none}
/* 提交图谱（等宽行，横向滚动） */
.dshk-graph{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;overflow-x:auto;user-select:text;padding:2px 0}
.dshk-grow{display:flex;align-items:center;white-space:pre;padding:0 8px;min-height:24px}
.dshk-grow-click{cursor:pointer}
.dshk-grow-click:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-graph-g{flex:none;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dshk-gglyph{flex:none;width:14px;height:24px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;color:var(--dsw-alias-label-tertiary)}
.dshk-gdot{width:10px;height:10px;border-radius:50%;background:currentColor;box-shadow:0 0 0 1px color-mix(in srgb, currentColor 35%, transparent)}
.dshk-godot{width:10px;height:10px;border-radius:50%;border:2px solid currentColor;box-sizing:border-box}
.dshk-gvline{flex:none;width:2px;height:24px;background:currentColor;border-radius:1px;opacity:.8}
.dshk-gslash{flex:none;width:2px;height:38px;background:currentColor;border-radius:1px;opacity:.8;transform:rotate(37deg);transform-origin:center}
.dshk-gbslash{flex:none;width:2px;height:38px;background:currentColor;border-radius:1px;opacity:.8;transform:rotate(-37deg);transform-origin:center}
.dshk-gref{flex:none;font-size:10px;line-height:1.4;margin-right:4px;padding:0 5px;border-radius:5px;border:1px solid currentColor;white-space:nowrap}
.dshk-gref[data-k="head"]{color:#e2c08d}
.dshk-gref[data-k="branch"]{color:#4daafc}
.dshk-gref[data-k="tag"]{color:#b088e0}
.dshk-gref[data-k="remote"]{color:#73c991}
.dshk-ghash{flex:none;color:var(--dsw-alias-label-tertiary);width:62px;display:inline-block;margin-right:6px}
.dshk-gsubj{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.dshk-gdetail-head{display:flex;align-items:center;gap:8px;padding:6px 10px}
.dshk-gdetail-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshk-gmeta{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshk-gmeta-row{display:flex;gap:8px;align-items:baseline;font-size:12px}
.dshk-gmeta-k{flex:none;color:var(--dsw-alias-label-tertiary);width:44px}
.dshk-gmeta-date{flex:1;min-width:0;text-align:right;color:var(--dsw-alias-label-tertiary)}
.dshk-gmeta-hash{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-top:2px}
.dshk-gmeta-subj{font-size:12px;color:var(--dsw-alias-label-primary);margin-top:2px}
.dshk-gmeta-body{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;margin-top:2px}
.dshk-gmeta-merge{margin-top:2px;font-size:11px;color:#e2c08d}
.dshk-gfiles-head{padding:5px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshk-gfile{display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.dshk-gfile:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-gfile .dshk-name{flex:none}
.dshk-gfile .dshk-dir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
    /** 预览增强库按需加载：md 渲染（marked+DOMPurify）/ 代码读写（CodeMirror 6）。
     *  全部走 /dsh-kit/vendor/*，不打开对应文件类型就一个字节都不下载。 */
    function ensureMdLibs() {
      const jobs = [];
      if (typeof window.marked === "undefined") jobs.push(loadScript("/dsh-kit/vendor/marked.min.js"));
      if (typeof window.DOMPurify === "undefined") jobs.push(loadScript("/dsh-kit/vendor/purify.min.js"));
      return Promise.all(jobs);
    }
    function ensureCmLib() {
      return typeof window.CM6 === "object" && window.CM6 !== null
        ? Promise.resolve()
        : loadScript("/dsh-kit/vendor/codemirror.bundle.js");
    }
    /** 解析沙箱（srcdoc iframe 新 realm，原生 Promise）。不能在宿主页面直接跑解
     *  析库：DSH 前端把 window.Promise 换成了自己的实现（外观伪装 native），pdf.js
     *  3.x 渲染管线在它上面会卡死——第 1 页渲染后所有后续 page.render() 永久
     *  pending（同浏览器同库在同源空白页 34ms 渲染成功，已二分定位）；mammoth 的
     *  转换同样是真 Promise 链。srcdoc iframe 是全新 realm、原生 Promise；不带
     *  sandbox 属性保持同源，主文档可直接调用沙箱函数、互传字节/字符串（pdf 的
     *  canvas 反着来：在主文档创建、沙箱执笔——跨文档采纳会丢位图）。 */
    const boxPromises = new Map(); // key → Promise<win>，失败即剔除可重试
    function ensureBox(key, scripts, setup) {
      const cached = boxPromises.get(key);
      if (cached) return cached;
      const p = new Promise((resolve, reject) => {
        const ifr = document.createElement("iframe");
        ifr.style.display = "none";
        ifr.srcdoc = "<!doctype html><html><head></head><body></body></html>";
        const fail = (error) => {
          boxPromises.delete(key);
          reject(error);
        };
        ifr.onload = () => {
          const win = ifr.contentWindow;
          const origin = location.origin;
          const loadAt = (i) => {
            if (i >= scripts.length) {
              try {
                if (setup) setup(win);
                resolve(win);
              } catch (error) {
                fail(error);
              }
              return;
            }
            try {
              const s = win.document.createElement("script");
              s.src = origin + scripts[i];
              s.onload = () => loadAt(i + 1);
              s.onerror = () => fail(new Error(scripts[i] + " 加载失败"));
              win.document.head.appendChild(s);
            } catch (error) {
              fail(error);
            }
          };
          loadAt(0);
        };
        ifr.onerror = () => fail(new Error("沙箱 iframe 创建失败"));
        document.body.appendChild(ifr);
      });
      boxPromises.set(key, p);
      return p;
    }
    function ensurePdfBox() {
      return ensureBox("pdf", ["/dsh-kit/vendor/pdf.min.js"], (win) => {
        win.pdfjsLib.GlobalWorkerOptions.workerSrc = location.origin + "/dsh-kit/vendor/pdf.worker.min.js";
      });
    }
    /** SheetJS 解析：打开工作簿留在沙箱（__dshkSheetOpen），按表号取**全量格式化
     *  矩阵**（__dshkSheetGet）——虚拟滚动渲染，不再生成表格 HTML。上限 5 万行 ×
     *  256 列 + 150 万单元格总量（超限裁行并标记 truncated）；列宽取自工作簿
     *  !cols（wpx/wch 换算），无则默认。raw:false 取显示文本（日期等已格式化）。 */
    function ensureSheetBox() {
      return ensureBox("sheet", ["/dsh-kit/vendor/xlsx.full.min.js"], (win) => {
        const X = win.XLSX;
        const ROW_CAP = 50000;
        const COL_CAP = 256;
        const CELL_CAP = 1500000;
        let boxWb = null;
        win.__dshkSheetOpen = (bytes) => {
          boxWb = X.read(bytes, { type: "array" });
          return boxWb.SheetNames.slice();
        };
        win.__dshkSheetGet = (idx) => {
          if (!boxWb) throw new Error("工作簿未打开");
          const name = boxWb.SheetNames[idx];
          const ws = boxWb.Sheets[name];
          const range = X.utils.decode_range(ws["!ref"] ?? "A1");
          const totalRows = range.e.r - range.s.r + 1;
          const totalCols = range.e.c - range.s.c + 1;
          const cols = Math.min(totalCols, COL_CAP);
          const rows = Math.min(totalRows, ROW_CAP, Math.max(1, Math.floor(CELL_CAP / cols)));
          range.e.c = range.s.c + cols - 1;
          range.e.r = range.s.r + rows - 1;
          // 裁剪后的工作表：范围收界；合并只保留完整落界的（虚拟滚动不跨格渲染，
          // 仅首行横向合并由渲染层单独处理）
          const merges = (ws["!merges"] ?? []).filter((m) => m.e.r <= range.e.r && m.e.c <= range.e.c);
          const clipped = Object.assign({}, ws, { "!ref": X.utils.encode_range(range), "!merges": merges });
          const matrix = X.utils.sheet_to_json(clipped, { header: 1, raw: false, defval: "" });
          const norm = matrix.map((r) => {
            const out = new Array(cols);
            for (let c = 0; c < cols; c++) out[c] = r && r[c] != null ? String(r[c]) : "";
            return out;
          });
          while (norm.length < rows) norm.push(new Array(cols).fill(""));
          const header = norm.shift() ?? new Array(cols).fill("");
          const headerSpans = merges
            .filter((m) => m.s.r === range.s.r)
            .map((m) => ({ c: m.s.c - range.s.c, span: Math.min(m.e.c, range.e.c) - m.s.c + 1 }))
            .filter((s) => s.c >= 0 && s.span > 1);
          const rawCols = ws["!cols"] ?? [];
          const colWidths = [];
          for (let c = 0; c < cols; c++) {
            const w = rawCols[c];
            if (w && w.wpx) colWidths.push(Math.min(360, Math.max(40, Math.round(w.wpx))));
            else if (w && w.wch) colWidths.push(Math.min(360, Math.max(40, Math.round(w.wch * 8 + 12))));
            else colWidths.push(110);
          }
          return {
            name,
            header,
            headerSpans,
            rows: norm,
            colWidths,
            totalRows,
            totalCols,
            shownRows: rows,
            shownCols: cols,
            truncated: totalRows > rows || totalCols > cols,
          };
        };
      });
    }
    /** mammoth 解析：docx → 语义 HTML（标题/列表/表格/粗斜体/内联 base64 图片）。
     *  jszip 用 instanceof ArrayBuffer 验型——跨 realm 会失败，须在沙箱内重建
     *  原生 ArrayBuffer 再喂给 mammoth（SheetJS 只做索引访问所以不受此限）。 */
    function ensureDocBox() {
      return ensureBox("doc", ["/dsh-kit/vendor/mammoth.browser.min.js"], (win) => {
        win.__dshkDocxParse = (bytes) => {
          const ab = new win.ArrayBuffer(bytes.length);
          new win.Uint8Array(ab).set(bytes);
          return win.mammoth.convertToHtml({ arrayBuffer: ab }).then((r) => r.value);
        };
      });
    }
    /** PDF 懒加载查看器：先按第 1 页纵横比铺全量占位（滚动条即真实页数长度），
     *  占位进入预载区（IntersectionObserver，root=滚动容器）才渲染 canvas，
     *  距所有预载区页超过 EVICT 页则释放位图——大文档内存只随视口附近页数走。
     *  页码指示器（实时当前页 + 回车跳页）挂 headSlot（面板标题栏槽位，固定区
     *  不遮内容），跳转由占位承接、滚过去即渲染。cancelled() 为真则中止；返回
     *  dispose（断观察器/监听 + 清 DOM）或 null（未建成）。 */
    async function mountPdfViewer(scrollEl, headSlot, doc, cancelled) {
      const p1 = await doc.getPage(1);
      if (cancelled()) return null;
      const vb1 = p1.getViewport({ scale: 1 });
      const total = doc.numPages;
      const scroller = scrollEl.closest(".dshk-pane-body") ?? scrollEl;
      const EVICT = 6; // 距所有预载区页超过此数才释放位图（滞回，防边界反复渲染）
      const slots = [null];
      const rendered = new Map(); // 页码 → canvas
      const pending = new Set();  // 已入队未完成
      const visible = new Set();  // 预载区内的页（observer 维护）
      const queue = [];
      let disposed = false;
      let rendering = false;
      let pageTops = null; // 各占位在滚动内容中的 offset（二分当前页/跳页用）
      let topsDirty = true;
      let currentPage = 1;
      let scrollRaf = 0;
      let resizeTimer = 0;
      let lastW = 0;

      const slotWidth = () => Math.max(280, (scrollEl.clientWidth || 480) - 20);
      const slotLabel = (p) => {
        const no = document.createElement("span");
        no.className = "dshk-pdf-slotno";
        no.textContent = String(p);
        return no;
      };
      // canvas 释放/重建尺寸后把占位还原成带页码的空白页
      const restoreSlot = (p) => {
        const slot = slots[p];
        slot.textContent = "";
        slot.appendChild(slotLabel(p));
        slot.style.aspectRatio = `${vb1.width} / ${vb1.height}`;
        topsDirty = true;
      };

      const frag = document.createDocumentFragment();
      const indicator = document.createElement("div");
      indicator.className = "dshk-pdf-indicator";
      const jump = document.createElement("input");
      jump.className = "dshk-pdf-jump";
      jump.type = "text";
      jump.inputMode = "numeric";
      jump.value = "1";
      jump.setAttribute("aria-label", t("pdfJump"));
      const totalSpan = document.createElement("span");
      totalSpan.textContent = `/ ${total}`;
      indicator.append(jump, totalSpan);
      for (let i = 1; i <= total; i++) {
        const slot = document.createElement("div");
        slot.className = "dshk-pdf-slot";
        slot.dataset.page = String(i);
        slot.appendChild(slotLabel(i));
        slots.push(slot);
        frag.appendChild(slot);
      }
      scrollEl.appendChild(frag);
      // 指示器挂标题栏槽位（React 提供挂载点）；槽位缺席时静默降级为无指示器
      if (headSlot) headSlot.appendChild(indicator);

      const applySizes = () => {
        lastW = slotWidth();
        for (let i = 1; i <= total; i++) slots[i].style.width = `${lastW}px`;
      };
      applySizes();
      for (let i = 1; i <= total; i++) slots[i].style.aspectRatio = `${vb1.width} / ${vb1.height}`;

      const nearVisible = (p, slack) => {
        for (const v of visible) if (Math.abs(p - v) <= slack) return true;
        return false;
      };
      const evictFar = () => {
        for (const [p, canvas] of rendered) {
          if (nearVisible(p, EVICT)) continue;
          canvas.remove();
          rendered.delete(p);
          restoreSlot(p);
        }
      };
      const pump = () => {
        if (rendering || disposed) return;
        let next = 0;
        while (queue.length) {
          const p = queue.shift();
          if (rendered.has(p) || !pending.has(p)) continue;
          if (visible.has(p)) { next = p; break; }
          pending.delete(p); // 已滚离预载区：丢弃，路过时 observer 会重新入队
        }
        if (!next) return;
        rendering = true;
        renderPage(next)
          .catch((error) => console.warn("[dsh-kit] pdf 页渲染失败", next, error))
          .finally(() => {
            pending.delete(next);
            rendering = false;
            if (!disposed) pump();
          });
      };
      const renderPage = async (p) => {
        const slot = slots[p];
        if (disposed || !slot || !slot.isConnected || rendered.has(p)) return;
        const page = await doc.getPage(p);
        if (disposed || rendered.has(p)) return;
        const vb = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const w = slotWidth();
        const viewport = page.getViewport({ scale: (w / vb.width) * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        // 混合页尺寸文档：渲染时把占位比例改成实际值，防渲染完成瞬间跳动
        slot.style.aspectRatio = `${vb.width} / ${vb.height}`;
        slot.textContent = "";
        slot.appendChild(canvas);
        rendered.set(p, canvas);
        topsDirty = true;
        // intent:"print"——续绘走微任务而非 rAF，宿主窗口被遮挡时不冻结（见 ensurePdfBox 注释）
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "#ffffff", intent: "print" }).promise;
      };
      const io = new IntersectionObserver(
        (entries) => {
          if (disposed) return;
          for (const en of entries) {
            const p = Number(en.target.dataset.page);
            if (en.isIntersecting) visible.add(p);
            else visible.delete(p);
          }
          for (const p of visible) {
            if (!rendered.has(p) && !pending.has(p)) { pending.add(p); queue.push(p); }
          }
          evictFar();
          pump();
        },
        { root: scroller, rootMargin: "1500px 0px" }
      );
      for (let i = 1; i <= total; i++) io.observe(slots[i]);

      const recomputeTops = () => {
        const sRect = scroller.getBoundingClientRect();
        const st = scroller.scrollTop;
        pageTops = [0];
        for (let i = 1; i <= total; i++) pageTops[i] = slots[i].getBoundingClientRect().top - sRect.top + st;
        topsDirty = false;
      };
      const syncCurrent = () => {
        if (topsDirty || !pageTops) recomputeTops();
        const center = scroller.scrollTop + scroller.clientHeight * 0.5;
        let lo = 1;
        let hi = total;
        let ans = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (pageTops[mid] <= center) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        currentPage = ans;
        if (document.activeElement !== jump) jump.value = String(ans);
      };
      const onScroll = () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          if (!disposed) syncCurrent();
        });
      };
      scroller.addEventListener("scroll", onScroll, { passive: true });

      const jumpTo = (n) => {
        const target = Math.min(total, Math.max(1, n));
        if (topsDirty || !pageTops) recomputeTops();
        scroller.scrollTop = Math.max(0, pageTops[target] - 12);
        syncCurrent();
      };
      jump.addEventListener("focus", () => jump.select());
      jump.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { jumpTo(parseInt(jump.value, 10) || 1); jump.blur(); }
        else if (e.key === "Escape") { jump.value = String(currentPage); jump.blur(); }
      });
      jump.addEventListener("blur", () => { jump.value = String(currentPage); });

      // 面板可拖宽：宽度变化后按新宽度重摆——已渲染页全部释放重渲染，简单可靠
      const ro = new ResizeObserver(() => {
        if (disposed) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed || Math.abs(slotWidth() - lastW) < 4) return;
          for (const [p, canvas] of [...rendered]) { canvas.remove(); rendered.delete(p); restoreSlot(p); }
          applySizes();
          syncCurrent();
          for (const p of visible) {
            if (!pending.has(p)) { pending.add(p); queue.push(p); }
          }
          pump();
        }, 200);
      });
      ro.observe(scrollEl);

      const teardown = () => {
        disposed = true;
        clearTimeout(resizeTimer);
        if (scrollRaf) cancelAnimationFrame(scrollRaf);
        io.disconnect();
        ro.disconnect();
        scroller.removeEventListener("scroll", onScroll);
        // 只在本查看器 DOM 还挂着时清空——effect 清理可能已 innerHTML=""，
        // 而新一次 mount 已建好内容，此时再清会误伤新查看器；指示器 pill 自摘
        if (slots[1] && slots[1].isConnected) scrollEl.textContent = "";
        indicator.remove();
      };
      syncCurrent();
      return teardown;
    }
    /** Excel 虚拟滚动表：冻结表头（sticky）+ 窗口渲染——数据全量在手，只画视口
     *  附近 ±若干行，滚动时重算窗口（rAF 节流）；固定行高 + 固定列宽（来自工作
     *  簿）是窗口化的前提。单元格用 textContent 注入，天然免消毒。返回 dispose。 */
    function mountSheetTable(scrollEl, sheet) {
      scrollEl.textContent = "";
      const ROW_H = 26;
      const totalW = sheet.colWidths.reduce((a, b) => a + b, 0);
      // 冻结表头：sticky 钉在滚动口顶部，横向随内容滚动，宽度对齐列
      const head = document.createElement("div");
      head.className = "dshk-sheet-head";
      head.style.height = `${ROW_H}px`;
      const spans = new Map(sheet.headerSpans.map((s) => [s.c, s.span]));
      let c = 0;
      while (c < sheet.header.length) {
        const cell = document.createElement("div");
        cell.className = "dshk-sheet-hcell";
        const span = spans.has(c) ? spans.get(c) : 1;
        cell.style.width = `${sheet.colWidths.slice(c, c + span).reduce((a, b) => a + b, 0)}px`;
        cell.textContent = sheet.header[c] ?? "";
        head.appendChild(cell);
        c += span;
      }
      // 撑出真实滚动高度的空壳 + 绝对定位的渲染窗口
      const bodyWrap = document.createElement("div");
      bodyWrap.className = "dshk-sheet-body";
      bodyWrap.style.height = `${sheet.rows.length * ROW_H}px`;
      bodyWrap.style.width = `${totalW}px`;
      const winEl = document.createElement("div");
      winEl.className = "dshk-sheet-window";
      bodyWrap.appendChild(winEl);
      scrollEl.append(head, bodyWrap);

      let raf = 0;
      const isNumeric = (v) => /^-?[\d,.\s]+%?$/.test(v) && /\d/.test(v);
      const render = () => {
        raf = 0;
        const first = Math.max(0, Math.floor(scrollEl.scrollTop / ROW_H) - 5);
        const count = Math.ceil(scrollEl.clientHeight / ROW_H) + 11;
        const last = Math.min(sheet.rows.length, first + count);
        winEl.style.top = `${first * ROW_H}px`;
        winEl.textContent = "";
        const frag = document.createDocumentFragment();
        for (let i = first; i < last; i++) {
          const row = document.createElement("div");
          row.className = "dshk-sheet-row";
          row.style.height = `${ROW_H}px`;
          const cells = sheet.rows[i];
          for (let j = 0; j < cells.length; j++) {
            const cell = document.createElement("div");
            cell.className = "dshk-sheet-cell" + (isNumeric(cells[j]) ? " dshk-sheet-num" : "");
            cell.style.width = `${sheet.colWidths[j]}px`;
            cell.textContent = cells[j];
            cell.title = cells[j]; // 省略时悬停看全值
            row.appendChild(cell);
          }
          frag.appendChild(row);
        }
        winEl.appendChild(frag);
      };
      const onScroll = () => {
        if (!raf) raf = requestAnimationFrame(render);
      };
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      render();
      return () => {
        if (raf) cancelAnimationFrame(raf);
        scrollEl.removeEventListener("scroll", onScroll);
      };
    }
    function extOf(p) {
      const m = /\.([a-z0-9]+)$/i.exec(String(p ?? ""));
      return m ? m[1].toLowerCase() : "";
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

    /** 写剪贴板：优先 Clipboard API；手机经局域网 http 访问时无安全上下文，退 execCommand */
    function writeClipboard(text) {
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      };
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        return navigator.clipboard.writeText(text).then(
          () => true,
          () => fallback(),
        );
      }
      return Promise.resolve(fallback());
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

    // ─────────── 终端坞（多标签）───────────
    // TerminalPane = 一个终端会话（一条 WS/一个 pty），挂载即连接、卸载即杀；
    // TerminalDock = 底部停靠容器：头部标签条（＋ 新建 / — 隐藏），body 纵向堆叠
    // 各 pane，仅激活 pane 可见。隐藏的 pane 保持挂载：xterm 离屏继续缓冲输出，
    // 切回不丢内容（display:none 期间跳过 fit，切回由 ResizeObserver 自动补）。
    function TerminalPane({ term, visible, restartKey, onRestart, onShell }) {
      const bodyRef = react.useRef(null);
      const [state, setState] = react.useState({ phase: "connecting", detail: "" });
      const visibleRef = react.useRef(visible);
      visibleRef.current = visible;

      react.useEffect(() => {
        if (!term.cwd) {
          setState({ phase: "error", detail: t("noCwd") });
          return undefined;
        }
        let disposed = false;
        setState({ phase: "connecting", detail: "" });

        let termInst = null;
        let host = null;
        let ws = null;
        let fitAddon = null;
        let resizeTimer = 0;
        let themeObserver = null;

        const sendResize = () => {
          if (disposed || !visibleRef.current || !termInst || !fitAddon) return; // 隐藏时不 fit
          try {
            fitAddon.fit();
          } catch {
            return;
          }
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "r", cols: termInst.cols, rows: termInst.rows }));
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
            termInst = new window.Terminal({
              fontSize: 13,
              lineHeight: 1.25,
              fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", "Courier New", monospace',
              cursorBlink: true,
              scrollback: 5000,
              theme: xtermTheme(),
            });
            // DSH 明暗切换时热更新调色板（presenter 改 body 属性）
            themeObserver = new MutationObserver(() => {
              if (!disposed && termInst) {
                try {
                  termInst.options.theme = xtermTheme();
                } catch {
                  // 忽略
                }
              }
            });
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
            fitAddon = new window.FitAddon.FitAddon();
            termInst.loadAddon(fitAddon);
            host = document.createElement("div");
            host.className = "dshk-term";
            bodyRef.current.appendChild(host);
            termInst.open(host);
            try {
              if (visibleRef.current) fitAddon.fit();
            } catch {
              // ResizeObserver 会再触发
            }
            termInst.onData((d) => {
              if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
            });
            ro.observe(bodyRef.current);

            ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/dsh-kit/terminal`);
            ws.onopen = () => {
              ws.send(JSON.stringify({ t: "init", cwd: term.cwd, cols: termInst.cols, rows: termInst.rows }));
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
                termInst.write(m.d);
              } else if (m.t === "started") {
                setState({ phase: "ready", detail: m.shell ?? "" });
                if (onShell) onShell(term.id, m.shell ?? "");
                if (visibleRef.current) termInst.focus(); // 后台启动的终端不抢焦点
              } else if (m.t === "exit") {
                setState({ phase: "exited", detail: String(m.exitCode ?? "") });
                termInst.write(`\r\n\x1b[90m[${t("exited")} · ${t("code")} ${m.exitCode}]\x1b[0m\r\n`);
              } else if (m.t === "error") {
                setState({ phase: "error", detail: String(m.message ?? "") });
                termInst.write(`\r\n\x1b[31m${m.message ?? ""}\x1b[0m\r\n`);
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
          if (termInst) {
            try {
              termInst.dispose();
            } catch {
              // 已释放
            }
          }
          if (host) host.remove();
        };
      }, [term.id, restartKey]);

      const statusText =
        state.phase === "connecting"
          ? t("connecting")
          : state.phase === "exited"
            ? `${t("exited")}${state.detail !== "" ? ` · ${t("code")} ${state.detail}` : ""}`
            : "";

      return jsxRuntime.jsxs("div", {
        className: "dshk-tpane",
        "data-on": visible || undefined,
        children: [
          jsxRuntime.jsx("div", { className: "dshk-tbody", ref: bodyRef }),
          statusText !== "" || state.phase === "error"
            ? jsxRuntime.jsxs("div", { className: "dshk-term-note", children: [
                jsxRuntime.jsx("span", {
                  title: state.detail ?? "",
                  children: state.phase === "error" ? `${t("contentFail")}：${state.detail}` : statusText,
                }),
                state.phase === "exited"
                  ? jsxRuntime.jsx("button", {
                      type: "button",
                      className: "dshk-btn-cancel",
                      onClick: onRestart,
                      children: t("restart"),
                    })
                  : null,
              ] })
            : null,
        ],
      });
    }

    /** 标签文案：工作区目录名；同 cwd 多开时追加序号区分 */
    function termTabLabel(term, items) {
      const base = String(term.cwd ?? "").split(/[\\/]/).filter(Boolean).pop() || term.cwd || "?";
      const same = items.filter((x) => x.cwd === term.cwd);
      return same.length > 1 ? `${base} ${same.indexOf(term) + 1}` : base;
    }

    function TerminalDock({ open, cwd, onSpawn, onHide, onActivate, onKill, onKillAll }) {
      const ui = useKitUi();
      const items = ui.terminals;
      const activeId = ui.activeTermId ?? (items.length > 0 ? items[items.length - 1].id : null);
      const activeItem = items.find((x) => x.id === activeId) ?? null;
      // 每标签的重启计数（⟳ 触发该 pane 重连）与 shell 名（started 时回填头部展示）
      const [restartMap, setRestartMap] = react.useState({});
      const [shells, setShells] = react.useState({});
      const onShell = (id, label) => setShells((s) => (s[id] === label ? s : { ...s, [id]: label }));
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

      return jsxRuntime.jsxs("div", {
        className: "dshk-dock",
        style: {
          ...(pos ? { left: pos.left, width: pos.width } : {}),
          ...(open ? {} : { display: "none" }), // 隐藏≠卸载：后台会话保持运行
        },
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-title", children: t("label") }),
              jsxRuntime.jsxs("span", { className: "dshk-tabs", children: [
                items.map((tab) =>
                  jsxRuntime.jsxs("div", {
                    className: `dshk-tab${tab.id === activeId ? " dshk-tab-on" : ""}`,
                    title: tab.cwd ?? "",
                    onClick: () => onActivate(tab.id),
                    children: [
                      jsxRuntime.jsx("span", { className: "dshk-tab-label", children: termTabLabel(tab, items) }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dshk-tab-x",
                        title: t("termTabClose"),
                        onClick: (e) => {
                          e.stopPropagation();
                          onKill(tab.id);
                        },
                        children: "✕",
                      }),
                    ],
                  }, tab.id),
                ),
              ] }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("termNew"),
                onClick: onSpawn,
                children: "＋",
              }),
              activeItem
                ? jsxRuntime.jsx("span", {
                    className: "dshk-sub",
                    title: activeItem.cwd ?? "",
                    children: `${shells[activeItem.id] ? `${shells[activeItem.id]} · ` : ""}${activeItem.cwd ?? ""}`,
                  })
                : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("restart"),
                onClick: () => {
                  if (!activeId) return;
                  setRestartMap((m) => ({ ...m, [activeId]: (m[activeId] ?? 0) + 1 }));
                },
                children: "⟳",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("termHide"),
                onClick: onHide,
                children: "—",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("termCloseAll"),
                onClick: onKillAll,
                children: "✕",
              }),
            ],
          }),
          // pane 必须挂在 tstack（position:relative）里：绝对定位 inset:0 以它为
          // 包含块，只盖住头部以下的内容区——直接挂 dock 下会连头部一起盖掉
          jsxRuntime.jsx("div", {
            className: "dshk-tstack",
            children: [
              items.length === 0 ? jsxRuntime.jsx("div", { className: "dshk-msg", children: t("noCwd") }) : null,
              ...items.map((tt) =>
                jsxRuntime.jsx(
                  TerminalPane,
                  {
                    term: tt,
                    visible: tt.id === activeId,
                    restartKey: restartMap[tt.id] ?? 0,
                    onRestart: () => setRestartMap((m) => ({ ...m, [tt.id]: (m[tt.id] ?? 0) + 1 })),
                    onShell,
                  },
                  `pane-${tt.id}`,
                ),
              ),
            ],
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

    /** git 状态：available:false = 非 git 目录，前端隐藏徽标；available 时含
        branch/upstream/ahead/behind/detached/unborn（宿主 status -b 分支摘要） */
    function fetchGitStatus(cwd, signal) {
      return fetch(`/dsh-kit/git/status?cwd=${encodeURIComponent(cwd)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
    }
    /** git 图谱：available:false = 非 git 目录/失败；lines 空数组 = 尚无提交 */
    function fetchGitLog(cwd, n, signal) {
      const url = `/dsh-kit/git/log?cwd=${encodeURIComponent(cwd)}&n=${Number(n) || 120}`;
      return fetch(url, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
    }
    /** git 单个提交详情（图谱点开行用） */
    function fetchGitShow(cwd, commit, signal) {
      return fetch(`/dsh-kit/git/show?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commit)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
    }
    /** git 本地分支列表（{current, branches:[{name,isHead,upstream,track,trackParsed}]}） */
    function fetchGitBranch(cwd, signal) {
      return fetch(`/dsh-kit/git/branch?cwd=${encodeURIComponent(cwd)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
    }
    /** 图谱引用装饰解析（与宿主侧 src/git.js parseDecoration 保持同步，入参为 %D 原文） */
    function parseDecoration(text) {
      const out = [];
      if (typeof text !== "string" || text === "") return out;
      for (const item of text.split(",").map((x) => x.trim())) {
        if (item === "") continue;
        if (item === "HEAD") out.push({ kind: "head", name: "HEAD", pointsTo: null });
        else if (item.startsWith("HEAD -> ")) out.push({ kind: "head", name: "HEAD", pointsTo: item.slice(8) });
        else if (item.startsWith("tag: ")) out.push({ kind: "tag", name: item.slice(5) });
        else if (item.startsWith("origin/")) out.push({ kind: "remote", name: item });
        else out.push({ kind: "branch", name: item });
      }
      return out;
    }

    /** 在目录初始化仓库（源代码管理空态按钮用；已是仓库则幂等返回 created:false） */
    function fetchGitInit(cwd) {
      return fetch("/dsh-kit/git/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd }),
      }).then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok || typeof b.created !== "boolean") throw new Error(b.error || `HTTP ${res.status}`);
        return b;
      });
    }

    /** 文件管理操作（新建/重命名/删除）：POST /dsh-kit/fs/op，宿主做子树与名称校验 */
    function postFsOp(payload) {
      return fetch("/dsh-kit/fs/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
        return b;
      });
    }

    /** 文件行尾的 git 状态小徽标（M/A/D/R/U）：porcelain 未跟踪是 "??"，统一显示 U */
    function GitBadge({ xy }) {
      const s = String(xy).trim();
      const label = s === "??" || s === "?" ? "U" : s || "M";
      const tipMap = { M: "gitM", A: "gitA", D: "gitD", R: "gitR", U: "gitU" };
      return jsxRuntime.jsx("span", {
        className: "dshk-gitbadge",
        "data-k": label,
        title: `${t(tipMap[label] ?? "gitTip")}（${String(xy)}）`,
        children: label,
      });
    }

    /** git 状态轮询周期：可见时低频拉取，回窗口/聚焦立即补一次 */
    const GIT_POLL_MS = 4000;

    /**
     * 把 unified patch 的 hunk 套回完整新文件内容，产出全文件着色行：
     * [type, text]，type ∈ ctx | add | del。上下文行来自新文件本体，
     * 删除行插在原位、不推进新文件游标。hunk 与内容对不上时返回 null（调用方回退原始 patch）。
     */
    function buildInlineRows(patch, newLines) {
      const lines = String(patch ?? "").split("\n");
      const rows = [];
      let idx = 0;
      let i = 0;
      let seenHunk = false;
      while (i < lines.length && !/^@@ /.test(lines[i])) i++;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("diff ") || line.startsWith("index ")) break;
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (m) {
          seenHunk = true;
          const newStart = parseInt(m[1], 10);
          if (newStart < idx + 1) return null; // hunk 乱序，放弃内联
          while (idx < newStart - 1) {
            if (idx >= newLines.length) return null;
            rows.push(["ctx", newLines[idx++]]);
          }
          continue;
        }
        if (line.startsWith("+")) {
          rows.push(["add", line.slice(1)]);
          idx++;
        } else if (line.startsWith("-")) {
          rows.push(["del", line.slice(1)]);
        } else if (line.startsWith(" ")) {
          if (idx >= newLines.length) return null;
          rows.push(["ctx", newLines[idx] === undefined ? line.slice(1) : newLines[idx]]);
          idx++;
        }
        // "\ No newline at end of file" 等杂项行忽略
      }
      while (idx < newLines.length) rows.push(["ctx", newLines[idx++]]);
      return seenHunk ? rows : null;
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

    /** 后台任务图标：正方形框（用户定稿：任务标记用方框，不要待办清单样式）。
    外框圆角方 + 顶部短横线（窗口/任务语义），与终端描边体系一致 */
    function JobsIcon() {
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
            jsxRuntime.jsx("rect", { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 1.6 }),
            jsxRuntime.jsx("path", { d: "M5.4 6.3h5.2" }),
          ],
        },
      );
    }

    /** 浏览器图标：地球（圆 + 经纬弧线），与终端/任务描边体系一致 */
    function BrowserIcon() {
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
            jsxRuntime.jsx("circle", { cx: 8, cy: 8, r: 6 }),
            jsxRuntime.jsx("path", { d: "M2 8h12" }),
            jsxRuntime.jsx("path", { d: "M8 2c1.8 1.6 2.7 3.6 2.7 6S9.8 12.4 8 14c-1.8-1.6-2.7-3.6-2.7-6S6.2 3.6 8 2z" }),
          ],
        },
      );
    }

    /** 上传图标：向上箭头 + 底部托盘 */
    function UploadIcon() {
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
            jsxRuntime.jsx("path", { d: "M8 10.5V2.5" }),
            jsxRuntime.jsx("path", { d: "M4.8 5.7L8 2.5l3.2 3.2" }),
            jsxRuntime.jsx("path", { d: "M2.5 10.5v3h11v-3" }),
          ],
        },
      );
    }

    /** 新建文件图标：文件折角 + 加号 */
    function FilePlusIcon() {
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
            jsxRuntime.jsx("path", { d: "M3.5 1.5h5l4 4v9h-9z" }),
            jsxRuntime.jsx("path", { d: "M8.5 1.5v4h4" }),
            jsxRuntime.jsx("path", { d: "M8 7.8v3.4M6.3 9.5h3.4" }),
          ],
        },
      );
    }

    /** 新建文件夹图标：FolderIcon 轮廓 + 加号 */
    function FolderPlusIcon() {
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
            jsxRuntime.jsx("path", { d: "M1.5 3.5c0-.55.45-1 1-1h3.2l1.6 1.8h6.2c.55 0 1 .45 1 1v7.2c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-9z" }),
            jsxRuntime.jsx("path", { d: "M8 7.6v3.6M6.2 9.4h3.6" }),
          ],
        },
      );
    }

    /** 删除图标：垃圾桶 */
    function TrashIcon() {
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
            jsxRuntime.jsx("path", { d: "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 10h6.6L12 4" }),
            jsxRuntime.jsx("path", { d: "M6.7 6.8v4.6M9.3 6.8v4.6" }),
          ],
        },
      );
    }

    /** 复制绝对路径图标：经典双矩形 copy */
    function CopyAbsIcon() {
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
            jsxRuntime.jsx("path", { d: "M9.5 3.5h-5a1 1 0 0 0-1 1v5" }),
            jsxRuntime.jsx("rect", { x: "6.5", y: "6.5", width: "7", height: "7", rx: "1" }),
          ],
        },
      );
    }

    /** 复制相对路径图标：单矩形 + 省略点（前缀被略去） */
    function CopyRelIcon() {
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
            jsxRuntime.jsx("rect", { x: "3.5", y: "4.5", width: "9.5", height: "7.5", rx: "1" }),
            jsxRuntime.jsx("path", { d: "M6 8.25h.01M8.25 8.25h.01M10.5 8.25h.01", strokeWidth: 1.6 }),
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

    /** 行悬停操作小按钮（新建/重命名/删除共用）：点击不触发行本身的打开/折叠 */
    function RowActionBtn({ title, onClick, children }) {
      return jsxRuntime.jsx("button", {
        type: "button",
        title,
        onClick: (e) => {
          e.stopPropagation();
          onClick(e); // 事件转发：⋯ 菜单需要 currentTarget 定位锚点
        },
        children,
      });
    }

    /**
     * 单层目录状态：{status:'loading'|'ready'|'error', entries?, truncated?, error?}
     * actions 可选——缺省时不渲染行悬停操作（渲染级验证桩调用即不带）：
     *   onCreate(dirPath,isDir) / onDelete(entry) / onRename(entry)=进入行内改名；
     *   onCopyPath(entry, relative)=复制绝对/相对路径；
     *   renamingPath + onRenameSubmit(entry,value) + onRenameCancel() 驱动行内输入框。
     */
    function TreeNode({ entry, depth, expanded, onToggle, onOpenFile, actions }) {
      const info = entry.dir ? expanded[entry.path] : undefined;
      const acts = actions ?? {};
      const renaming = !!acts.onRenameSubmit && acts.renamingPath === entry.path;
      // 行按钮「常用 + 更多」：常驻 hover 只留 @到对话、复制绝对路径与 ⋯ 菜单；
      // 新建/复制相对/重命名/删除收敛进 ⋯（用户定稿：留 @ 和绝对路径）
      const rowActions = [];
      if (acts.onMention) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeAt"), onClick: () => acts.onMention(entry), children: "@" }, "at"));
      }
      if (acts.onCopyPath) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeCopyAbs"), onClick: () => acts.onCopyPath(entry, false), children: jsxRuntime.jsx(CopyAbsIcon, {}) }, "ca"));
      }
      if (acts.onMenu) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeMenu"), onClick: (e) => acts.onMenu(entry, e.currentTarget), children: "⋯" }, "mm"));
      }
      // 改名输入框：聚焦时只选中最后一个 "." 之前的主名（保留扩展名）；
      // 目录与点开头的隐藏文件（如 .gitignore）没有扩展名概念，选全名
      const nameEl = renaming
        ? jsxRuntime.jsx("input", {
            className: "dshk-rename",
            defaultValue: entry.name,
            spellCheck: false,
            autoFocus: true,
            "aria-label": t("treeRename"),
            onClick: (e) => e.stopPropagation(),
            onFocus: (e) => {
              const v = e.currentTarget.value;
              const i = v.lastIndexOf(".");
              const end = !entry.dir && i > 0 ? i : v.length;
              e.currentTarget.setSelectionRange(0, end);
            },
            onKeyDown: (e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                acts.onRenameSubmit(entry, e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                acts.onRenameCancel();
              }
            },
            onBlur: () => {
              if (acts.renamingPath === entry.path) acts.onRenameCancel();
            },
          }, "rename")
        : jsxRuntime.jsx("span", { className: "dshk-name", children: entry.name }, "name");
      const rowChildren = [
        jsxRuntime.jsx("span", { className: "dshk-chev", children: entry.dir ? jsxRuntime.jsx(ChevronIcon, { open: !!info }) : null }, "chev"),
        nameEl,
      ];
      if (rowActions.length > 0) {
        rowChildren.push(jsxRuntime.jsx("span", { className: "dshk-rowact", children: rowActions }, "acts"));
      }
      const rows = [jsxRuntime.jsxs("div", {
        className: `dshk-row${entry.dir ? "" : " dshk-file"}`,
        style: { paddingLeft: 8 + depth * 14 },
        title: entry.path,
        onClick: () => {
          if (renaming) return; // 行内改名中：点击不触发打开/折叠
          if (entry.dir) onToggle(entry);
          else onOpenFile(entry.path);
        },
        children: rowChildren,
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
            rows.push(jsxRuntime.jsx(TreeNode, { entry: child, depth: depth + 1, expanded, onToggle, onOpenFile, actions }, child.path));
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
      // expanded: 路径 → 目录单层状态；根目录就是 cwd
      const [expanded, setExpanded] = react.useState({});
      // 供 nonce 刷新 effect 读取最新展开集合（保留展开状态用）
      const expandedRef = react.useRef({});
      expandedRef.current = expanded;
      const [nonce, setNonce] = react.useState(0);
      const abortsRef = react.useRef(new Set());
      // 正在行内改名的条目路径；null = 无
      const [renamingPath, setRenamingPath] = react.useState(null);
      // ⋯ 菜单：{entry, rect}；null = 关闭
      const [menuFor, setMenuFor] = react.useState(null);

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
      }, [cwd]);

      // ⟳ 手动刷新：保留展开状态，只重拉根与所有已展开层的内容（树是懒加载的，
      // 展开过的目录才需要刷新；未展开的下层等用户点开时自然拉最新）
      react.useEffect(() => {
        if (!nonce || !cwd) return undefined;
        const keys = Object.keys(expandedRef.current);
        const next = {};
        for (const k of keys) next[k] = { status: "loading" };
        setExpanded(next);
        for (const k of keys) loadDir(k);
        return undefined;
      }, [nonce]);

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

      // ── 文件管理（新建/重命名/删除）：数据走 POST /dsh-kit/fs/op，宿主做子树校验 ──
      /** 取父目录：无分隔符时回落 cwd */
      const parentOf = (p) => {
        const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
        return i > 0 ? p.slice(0, i) : cwd ?? p;
      };
      // ── 复制路径：entry.path 本就是绝对路径；相对路径 = 去掉树根（cwd）前缀 ──
      // 前缀比较必须卡在分隔符边界（cwd=D:\proj 时 D:\project2\x 不能误切成 ect2\x），
      // 不满足边界时回落绝对路径
      const copyEntryPath = (entry, relative) => {
        let text = entry.path;
        if (relative && cwd && entry.path.startsWith(cwd)) {
          const rest = entry.path.slice(cwd.length);
          if (rest === "" || /^[\\/]/.test(rest)) text = rest.replace(/^[\\/]+/, "");
        }
        writeClipboard(text).then((ok) => {
          if (ok) flashToast(t("treeCopied"));
        });
      };
      /** 清掉以 prefix 为根的整棵子树的展开缓存（目录改名/删除后这些键全部过期） */
      const pruneExpandedFrom = (prefix) => {
        const a = `${prefix}\\`;
        const b = `${prefix}/`;
        setExpanded((m) => {
          const next = {};
          for (const k of Object.keys(m)) {
            if (k === prefix || k.startsWith(a) || k.startsWith(b)) continue;
            next[k] = m[k];
          }
          return next;
        });
      };
      // ── 相对路径（@ 引用用，/ 分隔、目录尾 /）：越界/无法表示回落 null ──
      const relativePathOf = (entry) => {
        if (!cwd || !entry.path.startsWith(cwd)) return null;
        const rest = entry.path.slice(cwd.length);
        if (rest !== "" && !/^[\\/]/.test(rest)) return null;
        const norm = (rest === "" ? entry.name : rest.replace(/^[\\/]+/, "")).replace(/\\/g, "/");
        return entry.dir ? `${norm.replace(/\/+$/, "")}/` : norm;
      };
      // ── 对话 @ 引用：把选中条目作为官方引用直接插入当前会话输入框 ──
      // 优先走官方引用芯片直插（shell.insertReference，官方 @ 面板 pick 的
      // 同款槽位事件监听体，公开实例方法）：phase 须为 plain/claimed、
      // span.draftRev 须等于当前 rev（CAS），成功即产生真实引用 chip（提交
      // 时按官方 codec 序列化为 @语法文本），不经过官方 @ 面板；失败兜底为
      // @ 语法文本追加草稿末尾（与手打一致，此时面板可见属官方行为）。
      const mentionEntry = (entry) => {
        const shell = currentComposerShell();
        if (!shell || typeof shell.actions?.setDraft !== "function") {
          flashToast(t("treeAtUnavailable"));
          return;
        }
        const relPath = relativePathOf(entry);
        if (relPath === null) {
          flashToast(t("treeAtUnavailable"));
          return;
        }
        const mention = chatMentionText(relPath);
        if (mention === null) {
          flashToast(t("treeAtUnavailable"));
          return;
        }
        // 目录的开放引号形态（@"dir/）补上闭合引号，作为独立引用提交
        const chipMention = mention.includes('"') && !mention.endsWith('"') ? `${mention}"` : mention;
        const chipRef = {
          source: "reference",
          ref: chipMention,
          label: entry.dir ? `${(entry.name || "").replace(/\/+$/, "")}/` : entry.name || relPath.split("/").pop() || relPath,
          appearance: entry.dir ? "folder" : "file",
          clipboardText: mention,
        };
        if (typeof shell.insertReference === "function") {
          const phase = shell.core && shell.core.state ? shell.core.state.phase : null;
          const detectText = typeof shell.projection?.detectText === "string" ? shell.projection.detectText : "";
          const rev = typeof shell.rev === "number" ? shell.rev : -1;
          if ((phase === "plain" || phase === "claimed") && rev >= 0) {
            const span = { start: detectText.length, end: detectText.length, draftRev: rev };
            let applied = false;
            try {
              applied = shell.insertReference(chipRef, span) === true;
            } catch {
              applied = false;
            }
            if (applied) return;
          }
        }
        // 兜底：官方 @ 语法文本追加草稿末尾
        const state = typeof shell.state?.getSnapshot === "function" ? shell.state.getSnapshot() : null;
        const draft = state && typeof state.draft === "string" ? state.draft : "";
        shell.actions.setDraft(draft === "" ? mention : `${draft} ${mention}`);
      };
      /** 预览中的文件被改名/删除后关掉对应预览标签（含其子路径；激活位顺延） */
      const closeStalePreview = (prefix) => {
        const stale = (f) => f === prefix || f.startsWith(`${prefix}\\`) || f.startsWith(`${prefix}/`);
        const items = kitUi.previews ?? [];
        const rest = items.filter((pv) => !stale(pv.path));
        if (rest.length === items.length) return;
        const patch = { previews: rest };
        if (kitUi.activePreview && stale(kitUi.activePreview)) {
          patch.activePreview = rest.length > 0 ? rest[rest.length - 1].path : null;
        }
        setKitUi(patch);
      };
      const runFsOp = async (payload, confirmText) => {
        if (confirmText && !window.confirm(confirmText)) return false;
        try {
          await postFsOp({ cwd, ...payload });
          return true;
        } catch (error) {
          flashToast(`${t("skOpFail")}：${error?.message ?? error}`);
          return false;
        }
      };
      /** 在 dirPath 下新建文件/文件夹；完成后刷新该目录（未展开则顺带展开） */
      const createEntry = async (dirPath, wantDir) => {
        if (!cwd) return;
        const rawName = window.prompt(wantDir ? t("promptFolderName") : t("promptFileName"));
        if (rawName === null) return;
        const name = rawName.trim();
        if (name === "") return;
        const okDone = await runFsOp({ op: "create", dir: dirPath, name, kind: wantDir ? "dir" : "file" });
        if (!okDone) return;
        flashToast(t("created"));
        loadDir(dirPath);
      };
      // ── 行内改名（✎ 触发）：聚焦时只选中最后一个扩展名分隔符之前的
      // 主名（目录/隐藏文件选全名），Enter 提交、Esc/失焦取消；改名期间面板快捷键
      // 让路（inlineEditCapture），Esc 不会顺手关掉树/预览 ──
      const startRename = (entry) => {
        if (!cwd) return;
        setRenamingPath(entry.path);
      };
      const cancelRename = () => setRenamingPath(null);
      const submitRename = async (entry, rawValue) => {
        setRenamingPath(null);
        const name = String(rawValue ?? "").trim();
        if (name === "" || name === entry.name) return;
        const okDone = await runFsOp({ op: "rename", path: entry.path, name });
        if (!okDone) return;
        flashToast(t("renamed"));
        closeStalePreview(entry.path);
        pruneExpandedFrom(entry.path);
        loadDir(parentOf(entry.path));
      };
      react.useEffect(() => {
        inlineEditCapture = renamingPath !== null;
        return () => {
          inlineEditCapture = false;
        };
      }, [renamingPath]);
      const deleteEntry = async (entry) => {
        const okDone = await runFsOp(
          { op: "delete", path: entry.path },
          t("confirmDelete").replace("{name}", entry.name),
        );
        if (!okDone) return;
        flashToast(t("deleted"));
        closeStalePreview(entry.path);
        pruneExpandedFrom(entry.path);
        loadDir(parentOf(entry.path));
      };
      // 上传：input[type=file] 唤起设备自己的选择器（手机上是手机相册/文件——
      // 原生对话框只弹在运行它的机器上，手机够不到电脑端），选完 POST
      // /dsh-kit/upload 写入当前目录，成功后 bump nonce 刷新树
      const uploadInputRef = react.useRef(null);
      const uploadFiles = async (fileList) => {
        const files = [...(fileList ?? [])];
        if (!cwd || files.length === 0) return;
        const saved = [];
        const fails = [];
        for (const f of files) {
          try {
            const fd = new FormData();
            fd.append("file", f, f.name);
            const r = await fetch(`/dsh-kit/upload?dir=${encodeURIComponent(cwd)}`, { method: "POST", body: fd });
            const j = await r.json().catch(() => ({}));
            if (r.ok) saved.push(...(j.saved ?? []));
            else fails.push(`${f.name}：${j.error ?? `HTTP ${r.status}`}`);
          } catch (error) {
            fails.push(`${f.name}：${error?.message ?? error}`);
          }
        }
        if (saved.length > 0) {
          flashToast(t("uploadDone").replace("{n}", String(saved.length)));
          setNonce((n) => n + 1);
        }
        if (fails.length > 0) flashToast(`${t("uploadFail")}：${fails[0]}`);
      };

      const treeActions = {
        onCreate: createEntry,
        onDelete: deleteEntry,
        onRename: startRename,
        onCopyPath: copyEntryPath,
        onMention: mentionEntry,
        onMenu: (entry, anchor) => setMenuFor({ entry, rect: anchor.getBoundingClientRect() }),
        renamingPath,
        onRenameSubmit: submitRename,
        onRenameCancel: cancelRename,
      };
      // ⋯ 菜单：点菜单外任意处关闭
      react.useEffect(() => {
        if (!menuFor) return undefined;
        const onDoc = (e) => {
          if (!(e.target instanceof Element) || !e.target.closest(".dshk-menu")) setMenuFor(null);
        };
        document.addEventListener("click", onDoc, true);
        return () => document.removeEventListener("click", onDoc, true);
      }, [menuFor]);

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
              // 根目录新建文件/文件夹
              cwd
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("treeNewFile"),
                    onClick: () => createEntry(cwd, false),
                    children: jsxRuntime.jsx(FilePlusIcon, {}),
                  })
                : null,
              cwd
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("treeNewFolder"),
                    onClick: () => createEntry(cwd, true),
                    children: jsxRuntime.jsx(FolderPlusIcon, {}),
                  })
                : null,
              cwd
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("treeUpload"),
                    onClick: () => uploadInputRef.current?.click(),
                    children: jsxRuntime.jsx(UploadIcon, {}),
                  })
                : null,
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeRefresh"),
                onClick: () => setNonce((n) => n + 1),
                children: "⟳",
              }),
              // 隐藏的文件选择器：按钮只负责 click()，选择结果走 uploadFiles
              jsxRuntime.jsx("input", {
                ref: uploadInputRef,
                type: "file",
                multiple: true,
                style: { display: "none" },
                onChange: (e) => {
                  const files = e.target.files;
                  uploadFiles(files);
                  e.target.value = "";
                },
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
                            jsxRuntime.jsx(TreeNode, { entry, depth: 0, expanded, onToggle: toggleDir, onOpenFile, actions: treeActions }, entry.path),
                          ),
                          rootInfo.truncated
                            ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeTruncated") })
                            : null,
                        ],
                      }),
          }),
          menuFor
            ? jsxRuntime.jsx(TreeRowMenu, {
                entry: menuFor.entry,
                rect: menuFor.rect,
                actions: treeActions,
                onClose: () => setMenuFor(null),
              })
            : null,
        ],
      });
    }

    // ─────────── 树行 ⋯ 菜单（收敛操作：新建/复制相对/重命名/删除）───────────
    // fixed 定位浮层（树 body 滚动裁切不影响的全局层），按钮下方左缘对齐、
    // 向右展开（与官方对话三点菜单方向一致），右侧空间不足时回退左移。
    function TreeRowMenu({ entry, rect, actions, onClose }) {
      react.useEffect(() => {
        const onKey = (e) => {
          if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [onClose]);
      const items = [];
      if (entry.dir && actions.onCreate) {
        items.push({ key: "nf", label: t("treeNewFile"), run: () => actions.onCreate(entry.path, false) });
        items.push({ key: "nd", label: t("treeNewFolder"), run: () => actions.onCreate(entry.path, true) });
      }
      if (actions.onCopyPath) items.push({ key: "cr", label: t("treeCopyRel"), run: () => actions.onCopyPath(entry, true) });
      if (actions.onRename) items.push({ key: "rn", label: t("treeRename"), run: () => actions.onRename(entry) });
      if (actions.onDelete) items.push({ key: "dl", label: t("treeDelete"), run: () => actions.onDelete(entry) });
      const height = items.length * 32 + 8;
      const MENU_W = 160; // min-width 152 + padding 8
      const viewportW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1200;
      const viewportH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
      const style = {
        left: Math.min(Math.max(8, rect.left), Math.max(8, viewportW - MENU_W)),
        top: Math.min(Math.max(8, rect.bottom + 6), Math.max(8, viewportH - height - 8)),
      };
      return jsxRuntime.jsx("div", {
        className: "dshk-menu",
        style,
        children: items.map((item) =>
          jsxRuntime.jsx(
            "button",
            {
              type: "button",
              onClick: () => {
                onClose();
                item.run();
              },
              children: item.label,
            },
            item.key,
          ),
        ),
      });
    }

    // ─────────── 分支浮层（fixed 悬浮面板，vs 式 quick-pick）───────────
    // 不参与 .dshk-tree 的 flex 布局——更改条目再多也不会挤压分支列表；面板自带
    // 纵向滚动，超出视口高度时 clamp 至视口内。Esc / 点击面板外关闭；点回触发
    // 按钮不关（按钮自身 onClick 负责切换），用 data-popkey 识别。
    function GitBranchMenu({ rect, branches, busy, name, created, onName, onCreate, onSwitch, onDelete, onClose }) {
      const hostRef = react.useRef(null);
      react.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        const onDown = (e) => {
          if (e.target instanceof Element) {
            const el = e.target.closest("[data-popkey]");
            if (el && el.getAttribute("data-popkey") === "branch") return; // 触发按钮自己管切换
          }
          if (hostRef.current && e.target instanceof Element && !hostRef.current.contains(e.target)) onClose();
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onDown, true);
        return () => {
          window.removeEventListener("keydown", onKey, true);
          window.removeEventListener("pointerdown", onDown, true);
        };
      }, [onClose]);
      const MENU_W = 236;
      const viewportW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1200;
      const viewportH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
      const style = {
        left: Math.min(Math.max(8, rect.left), Math.max(8, viewportW - MENU_W)),
        top: Math.min(Math.max(8, rect.top), Math.max(8, viewportH - 420)),
      };
      return jsxRuntime.jsxs("div", {
        ref: hostRef,
        className: "dshk-menu dshk-branch-menu",
        style,
        children: [
          jsxRuntime.jsx("div", { className: "dshk-branch-title", children: t("scBranch") }),
          jsxRuntime.jsx("div", { className: "dshk-branch-list", children:
            Array.isArray(branches?.branches) && branches.branches.length > 0
              ? branches.branches.map((b) =>
                  jsxRuntime.jsxs(
                    "div",
                    {
                      className: "dshk-branch-row" + (b.isHead ? " dshk-branch-cur" : ""),
                      title: b.upstream
                        ? `${b.upstream}${b.trackParsed && (b.trackParsed.ahead || b.trackParsed.behind) ? " [" + (b.trackParsed.ahead ? "ahead " + b.trackParsed.ahead : "") + (b.trackParsed.behind ? " behind " + b.trackParsed.behind : "") + "]" : ""}`
                        : b.name,
                      onClick: () => { if (!b.isHead && !busy) onSwitch(b.name); },
                      children: [
                        jsxRuntime.jsx("span", { className: "dshk-branch-ico", children: b.isHead ? "●" : "○" }),
                        jsxRuntime.jsx("span", { className: "dshk-branch-name", children: b.name }),
                        created && b.name === created
                          ? jsxRuntime.jsx("span", { className: "dshk-branch-newtag", title: t("scBranchCreatedTag"), children: t("scBranchNewTag") })
                          : null,
                        trackBadgeFor(b),
                        jsxRuntime.jsx("span", { className: "dshk-spring" }),
                        b.isHead
                          ? jsxRuntime.jsx("span", { className: "dshk-branch-curtag", children: t("scBranchCurrent") })
                          : jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-branch-del",
                              title: t("scBranchDelete"),
                              disabled: busy,
                              onClick: (e) => { e.stopPropagation(); onDelete(b.name); },
                              children: "✕",
                            }),
                      ],
                    },
                    b.name,
                  ),
                )
              : jsxRuntime.jsx("div", { className: "dshk-note", children: t("scBranchEmpty") }),
          }),
          jsxRuntime.jsxs("div", { className: "dshk-branch-new", children: [
            jsxRuntime.jsx("input", {
              autoFocus: true,
              className: "dshk-cmt-input",
              placeholder: t("scBranchNew"),
              value: name,
              onChange: (e) => onName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") onCreate(false); },
            }),
            jsxRuntime.jsx("button", {
              type: "button",
              className: "dshk-btn-save",
              disabled: name.trim() === "" || busy,
              onClick: () => onCreate(false),
              children: t("scBranchCreate"),
            }),
            jsxRuntime.jsx("button", {
              type: "button",
              className: "dshk-btn-cancel",
              disabled: name.trim() === "" || busy,
              onClick: () => onCreate(true),
              children: t("scBranchCreateSwitch"),
            }),
          ] }),
        ],
      });
    }
    /** 分支行上游领先/落后/失效小标记（与面板内 trackBadge 同源，独立函数便于悬浮面板复用） */
    function trackBadgeFor(b) {
      const tp = b.trackParsed;
      if (!tp) return null;
      if (tp.gone === true) return jsxRuntime.jsx("span", { className: "dshk-branch-track dshk-branch-gone", title: b.track || b.upstream, children: "gone" });
      if (tp.ahead === 0 && tp.behind === 0) return null;
      return jsxRuntime.jsx("span", { className: "dshk-branch-track", title: b.track || b.upstream, children: `${tp.ahead ? "↑" + tp.ahead : ""}${tp.behind ? "↓" + tp.behind : ""}` });
    }

    // ─────────── ⋯ 操作菜单（vs 式：推送/发布分支收敛在标题行）───────────
    // 事件面与 GitBranchMenu 相同：Esc / 外部点击关闭，触发按钮以 data-popkey="actions"
    // 豁免（自身 toggle）。items: [{key, label, disabled?, run}]。
    function GitActionsMenu({ rect, items, onClose }) {
      const hostRef = react.useRef(null);
      react.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        const onDown = (e) => {
          if (e.target instanceof Element) {
            const el = e.target.closest("[data-popkey]");
            if (el && el.getAttribute("data-popkey") === "actions") return;
          }
          if (hostRef.current && e.target instanceof Element && !hostRef.current.contains(e.target)) onClose();
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onDown, true);
        return () => {
          window.removeEventListener("keydown", onKey, true);
          window.removeEventListener("pointerdown", onDown, true);
        };
      }, [onClose]);
      const viewportW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1200;
      const viewportH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
      const style = {
        left: Math.min(Math.max(8, rect.left), Math.max(8, viewportW - 200)),
        top: Math.min(Math.max(8, rect.top), Math.max(8, viewportH - 140)),
      };
      return jsxRuntime.jsx("div", {
        ref: hostRef,
        className: "dshk-menu",
        style,
        children: items.map((item) =>
          jsxRuntime.jsx(
            "button",
            {
              type: "button",
              disabled: item.disabled === true,
              onClick: () => {
                onClose();
                item.run();
              },
              children: item.label,
            },
            item.key,
          ),
        ),
      });
    }

    // ─────────── 源代码管理视图（sidebar.workspaces 的 git 模式）───────────
    // 文件树头部分支按钮进入；与文件树互斥占用同一单槽，**无 ✕**——原文件树入口
    // 按钮（及 Ctrl+E）就是切换开关：树 ⇄ 源代码管理 来回切。
    // 布局：标题行（分支图标+分支按钮（名称+↑N↓M）+条目数+图谱/⋯/刷新）
    // →「暂存的更改」组 →「更改」组（未跟踪 U 归入更改组）；分支浮层与 ⋯ 菜单是
    // fixed 悬浮层（不参与面板布局，更改条目再多分支也完整显示；Esc/外部点击关闭，
    // 分支列表自带滚动；新建分支输入打开即聚焦，仅新建不切换时浮层保留、新分支
    // 打「新建」标记）。非 git 目录给「初始化仓库」按钮（POST /git/init，幂等）。
    // 图谱视图（⧉ 切换）见 GitGraphPanel；⋯ 菜单 = 推送（有上游）/ 发布分支
    // （无上游，push -u），失败且无上游时给「设置上游并推送」提示。
    function GitChangesPanel({ cwd, onOpenFile }) {
      const [data, setData] = react.useState(null); // null=加载中；{available, root?, entries?}
      const [initializing, setInitializing] = react.useState(false);
      const [msg, setMsg] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [collapsed, setCollapsed] = react.useState({});
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

      // 视图：changes（更改清单，默认）⇄ graph（提交图谱）；分支浮层内联展开
      const [view, setView] = react.useState("changes");
      const [branchOpen, setBranchOpen] = react.useState(false);
      const [branches, setBranches] = react.useState(null); // null=未加载；{current, branches[]}
      const [newBranch, setNewBranch] = react.useState("");
      const [createdBranch, setCreatedBranch] = react.useState(null); // 刚新建的分支名（列表打「新建」标记）
      const [branchBusy, setBranchBusy] = react.useState(false);
      const [pushing, setPushing] = react.useState(false);
      // ⋯ 操作菜单 / 分支浮层（fixed 悬浮）：anchor 为按钮矩形锚点 {left, top}
      const [actionsOpen, setActionsOpen] = react.useState(false);
      const [actionsAnchor, setActionsAnchor] = react.useState(null);
      const [branchAnchor, setBranchAnchor] = react.useState(null);
      const branchBtnRef = react.useRef(null);
      const actionsBtnRef = react.useRef(null);
      /** 按钮锚点：按钮左下 + 6px，视口内 clamp（浮层自带内部滚动，上限留高） */
      const anchorOf = (ref) => {
        const el = ref.current;
        const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1200;
        const vh = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
        if (!el) return { left: 8, top: 8 };
        const r = el.getBoundingClientRect();
        return {
          left: Math.min(Math.max(8, r.left), Math.max(8, vw - 244)),
          top: Math.min(Math.max(8, r.bottom + 6), Math.max(8, vh - 430)),
        };
      };
      const openBranch = () => {
        setActionsOpen(false);
        setActionsAnchor(null);
        setBranchAnchor(anchorOf(branchBtnRef));
        setBranchOpen(true);
      };
      const closeBranch = () => {
        setBranchOpen(false);
        setBranchAnchor(null);
        setCreatedBranch(null);
      };
      const toggleBranch = () => {
        if (branchOpen) closeBranch();
        else openBranch();
      };
      const openActions = () => {
        setBranchOpen(false);
        setBranchAnchor(null);
        setActionsAnchor(anchorOf(actionsBtnRef));
        setActionsOpen(true);
      };
      const closeActions = () => {
        setActionsOpen(false);
        setActionsAnchor(null);
      };
      const [pushHint, setPushHint] = react.useState(false); // 无上游时的「设置上游并推送」提示
      // 图谱面板暴露的刷新句柄（图谱挂载后由 GitGraphPanel 回填），供头部 ⟳ 一并刷新
      const graphRef = react.useRef(null);
      const branchRef = react.useRef(null);
      branchRef.current = () => {
        if (!cwd) return;
        const c = new AbortController();
        fetchGitBranch(cwd, c.signal)
          .then((b) => {
            if (!c.signal.aborted && b.available === true) setBranches(b);
          })
          .catch(() => {});
      };
      // 分支浮层数据：打开时拉取（关闭后保留已加载数据，下次瞬开）
      react.useEffect(() => {
        if (branchOpen && branchRef.current) branchRef.current();
      }, [branchOpen, cwd]);

      /** 推送（upstream=true 时设置上游再推，即首次推送）：失败按无上游给提示 */
      const doPush = async (withUpstream) => {
        if (pushing || !cwd || !available) return false;
        setPushing(true);
        try {
          const res = await fetch("/dsh-kit/git/op", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd, op: "push", upstream: withUpstream === true }),
          });
          const b = await res.json().catch(() => ({}));
          if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
          flashToast(t("scPushDone"));
          setPushHint(false);
          if (fetchRef.current) fetchRef.current();
          return true;
        } catch (error) {
          const message = String(error?.message ?? error);
          flashToast(`${t("scPushFail")}：${message}`);
          const hintable = /no upstream/i.test(message) || /no configured push destination/i.test(message) || /couldn't find remote ref/i.test(message);
          setPushHint(hintable);
          return false;
        } finally {
          setPushing(false);
        }
      };

      /** 分支操作（新建/切换/删除）：成功后刷新状态 + 分支列表 */
      const runBranchOp = async (payload, confirmText) => {
        if (branchBusy || !cwd) return false;
        if (confirmText !== undefined && confirmText !== null && !window.confirm(confirmText)) return false;
        setBranchBusy(true);
        try {
          const res = await fetch("/dsh-kit/git/op", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd, ...payload }),
          });
          const b = await res.json().catch(() => ({}));
          if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
          if (fetchRef.current) fetchRef.current();
          if (branchRef.current) branchRef.current();
          setNewBranch("");
          return true;
        } catch (error) {
          flashToast(`${t("scBranchOpFail")}：${error?.message ?? error}`);
          return false;
        } finally {
          setBranchBusy(false);
        }
      };

      /** 新建分支（doSwitch=true 时一并切换）；成功后收起浮层（分支名已变） */
      const createBranch = async (doSwitch) => {
        const name = newBranch.trim();
        if (name === "" || branchBusy) return;
        const ok = await runBranchOp({ op: "branchCreate", name, switch: doSwitch === true });
        if (ok) {
          flashToast(t(doSwitch ? "scBranchSwitched" : "scBranchCreated").replace("{name}", name));
          if (doSwitch) {
            closeBranch(); // 已切换：收起浮层，头部分支按钮显示新名
          } else {
            setCreatedBranch(name); // 仅新建：浮层保留，列表刷新后新分支打「新建」标记
          }
        }
      };

      /** 写操作（暂存/取消暂存/放弃/提交）：可选二次确认，成功后静默刷新状态 */
      const runOp = async (payload, confirmText) => {
        if (busy || !cwd) return false;
        if (confirmText !== undefined && confirmText !== null && !window.confirm(confirmText)) return false;
        setBusy(true);
        try {
          const res = await fetch("/dsh-kit/git/op", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd, ...payload }),
          });
          const b = await res.json().catch(() => ({}));
          if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
          if (fetchRef.current) fetchRef.current();
          return true;
        } catch (error) {
          flashToast(`${t("skOpFail")}：${error?.message ?? error}`);
          return false;
        } finally {
          setBusy(false);
        }
      };

      const doCommit = async () => {
        const message = msg.trim();
        if (message === "" || busy || !available) return false;
        // 暂存区为空 → 提交全部更改（含新文件），需确认；否则只提交已暂存
        const all = stagedList.length === 0;
        const okDone = await runOp({ op: "commit", message, all }, all ? t("cmtAllConfirm") : undefined);
        if (okDone) {
          setMsg("");
          flashToast(t("committed"));
        }
        return okDone;
      };

      const available = data !== null && data.available === true;
      const entries = available && Array.isArray(data.entries) ? data.entries : [];
      const root = available ? data.root ?? null : null;
      // 分组：暂存（xy 第一列非空格且非 ??）与其余（含未跟踪 U），分两组
      const stagedList = [];
      const workList = [];
      for (const e of entries) {
        const first = e.xy && e.xy[0] !== " " && e.xy[0] !== "?" ? stagedList : workList;
        first.push(e);
      }
      const groups = [
        { key: "staged", title: t("scStaged"), list: stagedList, isStaged: true },
        { key: "work", title: t("scChanges"), list: workList, isStaged: false },
      ].filter((g) => g.list.length > 0);

      const renderRow = (item, isStaged) => {
        const rel =
          root && item.abs.startsWith(root)
            ? item.abs.slice(root.length).replace(/^[\\/]/, "")
            : item.path;
        const segs = rel.split(/[\\/]/);
        const name = segs[segs.length - 1];
        const dir = segs.slice(0, -1).join("/");
        const isUntracked = String(item.xy).trim() === "?";
        // 已删除文件（xy 含 D）：工作区里已无文本可读，点击进「仅删除 diff」预览
        // （git diff HEAD 能给出被删内容；不做文本预览以免"文件不存在"报错）
        const isDeleted = !isUntracked && (item.xy[0] === "D" || item.xy[1] === "D");
        return jsxRuntime.jsxs(
          "div",
          {
            className: "dshk-row dshk-chg-row",
            title: item.abs,
            onClick: () => onOpenFile(item.abs, isUntracked, isDeleted),
            children: [
              jsxRuntime.jsx("span", { className: "dshk-name", children: name }),
              dir !== "" ? jsxRuntime.jsx("span", { className: "dshk-dir", title: rel, children: dir }) : null,
              // 悬停操作（行内命令）：暂存＋ / 放弃↩ / 取消暂存－
              jsxRuntime.jsxs("span", { className: "dshk-rowact", children: [
                isStaged
                  ? jsxRuntime.jsx("button", { type: "button", title: t("scUnstage"), disabled: busy, onClick: (e) => { e.stopPropagation(); runOp({ op: "unstage", path: item.abs }); }, children: "－" })
                  : jsxRuntime.jsx("button", { type: "button", title: t("scStage"), disabled: busy, onClick: (e) => { e.stopPropagation(); runOp({ op: "stage", path: item.abs }); }, children: "＋" }),
                !isStaged && !isUntracked
                  ? jsxRuntime.jsx("button", { type: "button", title: t("scDiscard"), disabled: busy, onClick: (e) => { e.stopPropagation(); runOp({ op: "discard", path: item.abs }, t("scDiscardConfirm")); }, children: "↩" })
                  : null,
              ] }),
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
      };

      const initRepo = async () => {
        if (initializing || !cwd) return;
        setInitializing(true);
        try {
          await fetchGitInit(cwd);
          if (fetchRef.current) fetchRef.current();
        } catch (error) {
          flashToast(`${t("scInitFail")}：${error?.message ?? error}`);
        } finally {
          setInitializing(false);
        }
      };

      const ahead = available && typeof data?.ahead === "number" ? data.ahead : 0;
      const behind = available && typeof data?.behind === "number" ? data.behind : 0;

      return jsxRuntime.jsxs("div", {
        className: "dshk-tree",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx(BranchIcon, {}),
              // 分支按钮（vs 式：名称 + 领先/落后计数）：点击开固定悬浮分支浮层
              available && data
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    ref: branchBtnRef,
                    className: "dshk-btn dshk-branchbtn" + (branchOpen ? " dshk-headbtn-on" : ""),
                    title: t("scBranch"),
                    "data-popkey": "branch",
                    "aria-pressed": branchOpen || undefined,
                    onClick: toggleBranch,
                    children: [
                      jsxRuntime.jsx("span", {
                        className: "dshk-branch-name",
                        children: data.detached === true ? t("scDetached") : data.branch || "—",
                      }),
                      !data.detached && (ahead > 0 || behind > 0)
                        ? jsxRuntime.jsx("span", {
                            className: "dshk-branch-ar",
                            title: `${ahead > 0 ? t("scPushAhead").replace("{n}", String(ahead)) : ""}${ahead > 0 && behind > 0 ? " · " : ""}${behind > 0 ? t("scBehind").replace("{n}", String(behind)) : ""}`,
                            children: `${ahead > 0 ? "↑" + ahead : ""}${behind > 0 ? "↓" + behind : ""}`,
                          })
                        : null,
                      jsxRuntime.jsx("span", { className: "dshk-caret", children: "▾" }),
                    ],
                  })
                : jsxRuntime.jsx("span", { className: "dshk-dir", title: root ?? "", children: t("scTitle") }),
              available && entries.length > 0
                ? jsxRuntime.jsx("span", { className: "dshk-status", children: String(entries.length) })
                : null,
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn dshk-headbtn" + (view === "graph" ? " dshk-headbtn-on" : ""),
                title: t("scGraph"),
                "aria-pressed": view === "graph" || undefined,
                onClick: () => setView((v) => (v === "graph" ? "changes" : "graph")),
                children: "⧉",
              }),
              // ⋯ 操作菜单（vs 式）：推送 / 发布分支收敛在这里
              available && data
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    ref: actionsBtnRef,
                    className: "dshk-btn dshk-headbtn" + (actionsOpen ? " dshk-headbtn-on" : ""),
                    title: ahead > 0 ? t("scPushAhead").replace("{n}", String(ahead)) : t("scActions"),
                    "data-popkey": "actions",
                    "aria-pressed": actionsOpen || undefined,
                    onClick: openActions,
                    children: pushing ? t("saving") : "⋯",
                  })
                : null,
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-btn",
                title: t("treeRefresh"),
                onClick: () => {
                  if (fetchRef.current) fetchRef.current();
                  if (graphRef.current) graphRef.current();
                },
                children: "⟳",
              }),
            ],
          }),
          // 分支浮层 / ⋯ 操作菜单：fixed 悬浮（.dshk-menu 模式），不参与面板布局，
          // 更改条目再多也不会挤压分支列表；关浮层由组件内 Esc/外部点击触发
          branchOpen && branchAnchor
            ? jsxRuntime.jsx(GitBranchMenu, {
                rect: branchAnchor,
                branches,
                busy: branchBusy,
                name: newBranch,
                created: createdBranch,
                onName: setNewBranch,
                onCreate: createBranch,
                onSwitch: async (name) => {
                  const ok = await runBranchOp({ op: "branchSwitch", name });
                  if (ok) {
                    flashToast(t("scBranchSwitched").replace("{name}", name));
                    closeBranch();
                  }
                },
                onDelete: async (name) => {
                  if (!window.confirm(t("scBranchDeleteConfirm").replace("{name}", name))) return;
                  const ok = await runBranchOp({ op: "branchDelete", name });
                  if (ok) {
                    flashToast(t("scBranchDeleted").replace("{name}", name));
                    return;
                  }
                  // -d 失败（典型：未合并）→ 二次确认强制删除
                  if (window.confirm(t("scBranchForceConfirm"))) {
                    const ok2 = await runBranchOp({ op: "branchDelete", name, force: true });
                    if (ok2) flashToast(t("scBranchDeleted").replace("{name}", name));
                  }
                },
                onClose: closeBranch,
              })
            : null,
          actionsOpen && actionsAnchor
            ? jsxRuntime.jsx(GitActionsMenu, {
                rect: actionsAnchor,
                items: [
                  {
                    key: "push",
                    label: data && data.upstream ? t("scPush") : t("scPublish"),
                    disabled: pushing || !available || data?.detached === true || data?.branch === "",
                    run: () => doPush(!(data && data.upstream)),
                  },
                ],
                onClose: closeActions,
              })
            : null,
          // 无上游提示（push 失败后出现）：一键设置上游并重推
          pushHint && view === "changes"
            ? jsxRuntime.jsxs("div", { className: "dshk-pushhint", children: [
                jsxRuntime.jsx("span", { children: t("scPushNoUpstream") }),
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "dshk-btn-save",
                  disabled: pushing,
                  onClick: () => doPush(true),
                  children: t("scPushSetUpstream"),
                }),
              ] })
            : null,
          jsxRuntime.jsx("div", {
            className: "dshk-tree-body",
            children:
              !cwd
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("noCwd") })
                : data === null
                  ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") })
                  : !available
                    ? jsxRuntime.jsxs("div", { style: { padding: "16px 10px", textAlign: "center" }, children: [
                        jsxRuntime.jsx("div", { className: "dshk-note", style: { padding: 0 }, children: t("scNotGit") }),
                        jsxRuntime.jsx("div", { style: { marginTop: 10 } , children:
                          jsxRuntime.jsx("button", {
                            type: "button",
                            className: "dshk-btn-save",
                            disabled: initializing,
                            onClick: initRepo,
                            children: t(initializing ? "saving" : "scInit"),
                          }),
                        }),
                      ] })
                    : view === "graph"
                    ? jsxRuntime.jsx(GitGraphPanel, { cwd, root, refreshRef: graphRef, onOpenFile })
                    : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          // 提交框：暂存空=提交全部（需确认），否则只提交已暂存
                          jsxRuntime.jsxs("div", { className: "dshk-cmt", children: [
                            jsxRuntime.jsx("input", {
                              className: "dshk-cmt-input",
                              placeholder: t("cmtPlaceholder"),
                              value: msg,
                              onChange: (e) => setMsg(e.target.value),
                              onKeyDown: (e) => { if (e.key === "Enter") doCommit(); },
                            }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-btn-save",
                              disabled: msg.trim() === "" || busy,
                              title: stagedList.length > 0 ? t("scCommit") : t("scCommitAll"),
                              onClick: doCommit,
                              children: t(stagedList.length > 0 ? "scCommit" : "scCommitAll"),
                            }),
                          ] }),
                          groups.length === 0
                            ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("scEmpty") })
                            : groups.map((group) => {
                                const isOpen = !collapsed[group.key];
                                return jsxRuntime.jsxs(
                                  "div",
                                  {
                                    className: "dshk-changes",
                                    children: [
                                      jsxRuntime.jsxs("div", {
                                        className: "dshk-chg-head",
                                        onClick: () => setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] })),
                                        children: [
                                          jsxRuntime.jsx("span", { className: "dshk-chg-chev", "data-open": isOpen || undefined, children: "▶" }),
                                          jsxRuntime.jsx("span", { children: group.title }),
                                          jsxRuntime.jsx("span", { className: "dshk-sk-status", children: String(group.list.length) }),
                                        ],
                                      }),
                                      isOpen ? group.list.map((item) => renderRow(item, group.isStaged)) : null,
                                    ],
                                  },
                                  group.key,
                                );
                              }),
                        ],
                      }),
          }),
        ],
      });
    }

    // ─────────── 提交图谱（源代码管理面板的 graph 视图）───────────
    // 数据走 GET /dsh-kit/git/log（git log --all --graph 的 ASCII 图谱 + 结构化
    // 字段），等宽渲染：图谱前缀 → 引用装饰 chip → 短哈希 → 提交说明；纯连线续行
    // 只画前缀。点提交行进详情（/dsh-kit/git/show）：作者/时间/说明/文件清单，
    // 清单行可点开进右侧预览面板（A 类按未跟踪语义进原文视图）。
    // refreshRef：头部 ⟳ 一并刷新的句柄（由 GitChangesPanel 传入并回填）。
    /** 图谱 ASCII 前缀 → 图元（* 实心点 / o 空心点 / | 竖线 / \\ 斜线）。
     * 每个图元占一列定宽轨道；按轨道列（lane）循环分色，分支结构一眼可辨。
     * 空格原样占位（pre 保留列位）。工厂顶层函数，render-check 直接导出渲染。 */
    const LANE_COLORS = ["#4daafc", "#73c991", "#e2c08d", "#b088e0"];
    function GraphGlyph({ g }) {
      const out = [];
      const glyph = (i, cls) =>
        jsxRuntime.jsx(
          "span",
          { className: "dshk-gglyph", style: { color: LANE_COLORS[i % LANE_COLORS.length] }, children: jsxRuntime.jsx("span", { className: cls }) },
          "g" + i,
        );
      for (let i = 0; i < g.length; i++) {
        const ch = g[i];
        if (ch === "*") out.push(glyph(i, "dshk-gdot"));
        else if (ch === "o") out.push(glyph(i, "dshk-godot"));
        else if (ch === "|") out.push(glyph(i, "dshk-gvline"));
        else if (ch === "/") out.push(glyph(i, "dshk-gslash"));
        else if (ch === "\\") out.push(glyph(i, "dshk-gbslash"));
        else out.push(ch); // 空格等原样（pre 保留列位）
      }
      return jsxRuntime.jsx("span", { className: "dshk-graph-g", children: out });
    }

    function GitGraphPanel({ cwd, root, refreshRef, onOpenFile }) {
      const [data, setData] = react.useState(null); // null=加载中；{available, lines?}
      const [error, setError] = react.useState(null);
      const [sel, setSel] = react.useState(null); // null=列表；否则为选中的提交哈希
      const [detail, setDetail] = react.useState(null); // null | {phase, meta?, files?}
      const fetchRef = react.useRef(null);
      fetchRef.current = () => {
        if (!cwd) return;
        const c = new AbortController();
        fetchGitLog(cwd, 200, c.signal)
          .then((b) => {
            if (c.signal.aborted) return;
            setError(null);
            setData(b);
          })
          .catch((e) => {
            if (!c.signal.aborted && e?.name !== "AbortError") setError(String(e?.message ?? e));
          });
      };
      // 把本面板的刷新函数暴露给父级的 ⟳
      if (refreshRef) refreshRef.current = () => fetchRef.current();
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

      /** 详情拉取控制器（供返回键中止在途请求） */
      const detailFetchRef = react.useRef(null);
      const openDetail = (hash) => {
        setSel(hash);
        setDetail({ phase: "loading" });
        const c = new AbortController();
        detailFetchRef.current = c;
        fetchGitShow(cwd, hash, c.signal)
          .then((b) => {
            if (c.signal.aborted) return;
            if (b.available !== true) throw new Error("unavailable");
            setDetail({ phase: "ready", meta: b.meta, files: b.files || [] });
          })
          .catch((e) => {
            if (!c.signal.aborted) setDetail({ phase: "error", error: String(e?.message ?? e) });
          });
      };
      const closeDetail = () => {
        const c = detailFetchRef.current;
        if (c) {
          try {
            c.abort();
          } catch {
            // 已结束
          }
        }
        setSel(null);
        setDetail(null);
      };

      const renderRefChips = (d) => {
        const decs = parseDecoration(d);
        return decs.map((r, i) =>
          jsxRuntime.jsx(
            "span",
            {
              className: "dshk-gref",
              "data-k": r.kind,
              title: r.kind === "head" && r.pointsTo ? `HEAD → ${r.pointsTo}` : r.name,
              children: r.kind === "head" && r.pointsTo ? r.pointsTo : r.name,
            },
            `${r.kind}-${i}`,
          ),
        );
      };

      if (!cwd) {
        return jsxRuntime.jsx("div", { className: "dshk-note", children: t("noCwd") });
      }

      // ── 提交详情子视图 ──
      if (sel !== null) {
        const isMerge = typeof detail?.meta?.parents === "string" && detail.meta.parents.trim().includes(" ");
        return jsxRuntime.jsxs("div", { className: "dshk-graph", children: [
          jsxRuntime.jsxs("div", { className: "dshk-gdetail-head", children: [
            jsxRuntime.jsx("button", {
              type: "button",
              className: "dshk-btn-cancel",
              onClick: closeDetail,
              children: t("scBack"),
            }),
            jsxRuntime.jsx("span", { className: "dshk-gdetail-title", children: t("scCommitDetail") }),
          ] }),
          detail === null || detail.phase === "loading"
            ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") })
            : detail.phase === "error"
              ? jsxRuntime.jsx("div", { className: "dshk-note", children: `${t("scGraphFail")}：${detail.error}` })
              : jsxRuntime.jsxs("div", { children: [
                  jsxRuntime.jsxs("div", { className: "dshk-gmeta", children: [
                    jsxRuntime.jsxs("div", { className: "dshk-gmeta-row", children: [
                      jsxRuntime.jsx("span", { className: "dshk-gmeta-k", children: t("scAuthored") }),
                      jsxRuntime.jsx("span", { children: detail.meta.an }),
                      jsxRuntime.jsx("span", { className: "dshk-gmeta-date", children: detail.meta.ad }),
                    ] }),
                    jsxRuntime.jsx("div", { className: "dshk-gmeta-hash", children: detail.meta.H }),
                    jsxRuntime.jsx("div", { className: "dshk-gmeta-subj", children: detail.meta.s }),
                    detail.meta.b
                      ? jsxRuntime.jsx("div", { className: "dshk-gmeta-body", children: detail.meta.b })
                      : null,
                    isMerge
                      ? jsxRuntime.jsx("div", { className: "dshk-gmeta-merge", children: `${t("scMergedCommit")}：${detail.meta.parents}` })
                      : null,
                  ] }),
                  jsxRuntime.jsx("div", { className: "dshk-gfiles-head", children: t("scFiles") }),
                  detail.files.length === 0
                    ? jsxRuntime.jsx("div", { className: "dshk-note", children: isMerge ? t("scMergedCommit") : t("scEmpty") })
                    : detail.files.map((f) => {
                        const st = f.st === "C" ? "R" : f.st;
                        const base = f.path.split(/[\\/]/).pop() || f.path;
                        return jsxRuntime.jsxs(
                          "div",
                          {
                            className: "dshk-gfile",
                            title: f.abs,
                            onClick: () => onOpenFile(f.abs, st === "A"),
                            children: [
                              jsxRuntime.jsx("span", { className: "dshk-gitbadge", "data-k": st, children: st }),
                              jsxRuntime.jsx("span", { className: "dshk-name", children: base }),
                              jsxRuntime.jsx("span", { className: "dshk-dir", children: f.path }),
                            ],
                          },
                          f.path,
                        );
                      }),
                ] }),
        ] });
      }

      // ── 图谱列表 ──
      if (data === null) {
        return jsxRuntime.jsx("div", { className: "dshk-note", children: t("treeLoading") });
      }
      if (data.available !== true) {
        return jsxRuntime.jsx("div", { className: "dshk-note", children: error ? `${t("scGraphFail")}：${error}` : t("scGraphFail") });
      }
      const lines = Array.isArray(data.lines) ? data.lines : [];
      if (lines.length === 0) {
        return jsxRuntime.jsx("div", { className: "dshk-note", children: t("scGraphEmpty") });
      }
      return jsxRuntime.jsx("div", {
        className: "dshk-graph",
        children: lines.map((line, i) => {
          // 纯连线行（无 %H 字段）不可点：必须判非空字符串，否则 undefined !== ""
          // 会把连线行误判成提交行（悬浮 undefined tooltip、点击 commit=undefined → 400）
          const clickable = typeof line.H === "string" && line.H !== "";
          return jsxRuntime.jsxs(
            "div",
            {
              className: clickable ? "dshk-grow dshk-grow-click" : "dshk-grow",
              title: clickable ? `${line.an ?? ""} · ${line.ad ?? ""}
${line.s ?? ""}` : undefined,
              onClick: clickable ? () => openDetail(line.H) : undefined,
              children: [
                jsxRuntime.jsx(GraphGlyph, { g: line.g }),
                clickable
                  ? jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                      renderRefChips(line.d),
                      jsxRuntime.jsx("span", { className: "dshk-ghash", children: line.h }),
                      jsxRuntime.jsx("span", { className: "dshk-gsubj", children: line.s }),
                    ] })
                  : null,
              ],
            },
            i,
          );
        }),
      });
    }

    // ─────────── 文件内容预览（右侧停靠面板，自绘）───────────
    // 点击文件树中的文件 → 打开右侧 fixed 停靠面板展示内容（不依赖原生 details
    // 槽/ctx.layout：openDetails 默认宽只有 360 且无法从动态插件调 setDetails）。
    // 让位布局：挂 body.dshk-pane-open 类 + 根节点设 --dshk-pane-w，
    // 样式规则把中列（对话）margin-right 顶开面板宽度——对话左移，内容不被遮挡。
    // 默认宽度即最大（左移到底），左缘拖拽手柄可收窄/放宽。
    /** 把 md 里的相对/站内链接解析为可打开的绝对路径；解析不出返回 null。
     *  fromPath 为当前预览文件绝对路径（正反斜杠皆可），cwd 为工作区根
     *  （合成站内 / 开头链接用），href 已剥过 query/hash。 */
    function resolveMdLink(fromPath, cwd, href) {
      const raw = (() => {
      try {
        return decodeURIComponent(href.split(/[?#]/, 1)[0]);
      } catch {
        return href.split(/[?#]/, 1)[0];
      }
    })();
      if (raw === "") return null;
      const norm = (p) => {
        const parts = p.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
        const out = [];
        for (const s of parts) {
          if (s === "..") out.pop();
          else out.push(s);
        }
        return out.join("\\");
      };
      if (raw.startsWith("/")) {
        return cwd && cwd.trim() !== "" ? norm(`${cwd}\\${raw.slice(1)}`) : null;
      }
      const dir = fromPath.split(/[\\/]+/).slice(0, -1).join("\\");
      return norm(`${dir}\\${raw}`);
    }
    function FileContentPane({ path, source, untracked, deleted, cwd, onOpenFile }) {
      const [state, setState] = react.useState({ phase: "loading" });
      // git/diff 视图状态——xy=null 表示无变更或非仓库；diff 数据懒加载。
      // 视图模式：默认随入口（源代码管理=diff，文件树=原文；未跟踪文件没有
      // 基线，即便从 SCM 进入也默认原文），头部 ⇄ 随时互切；
      // 同一面板会话内换文件保留用户选中的模式。
      // 二进制专用预览通道（pdf/xlsx/docx）：git diff 只有 "Binary files differ"
      // 一句话——无 diff 视图，⇄ 与 ✎ 都禁用，SCM 入口不默认 diff
      const isPdf = /\.pdf$/i.test(path);
      const isSheet = /\.(xlsx|xlsm|xls)$/i.test(path);
      const isDoc = /\.docx$/i.test(path);
      const binaryPreview = isPdf || isSheet || isDoc;
      const [mode, setMode] = react.useState(deleted === true || (source === "scm" && untracked !== true && !binaryPreview) ? "diff" : "text");
      const [diff, setDiff] = react.useState({ phase: "loading" });
      // 编辑态（draft 受控 textarea；reloadNonce 供 409 冲突后重读）
      const [editing, setEditing] = react.useState(false);
      // 来源切换（文件树 ↔ 源代码管理）时视图模式回到该来源的默认视图：
      // 面板在 tree/scm 之间复用同一实例，mode 只随挂载初始化一次，不跟随
      // source 的话在树里看过原文后进 SCM 点文件仍是只读原文——来源变了
      // 默认视图就该跟着换；同一来源内换文件仍保留用户手动选中的模式。
      const sourceRef = react.useRef(source);
      react.useEffect(() => {
        if (sourceRef.current === source) return;
        sourceRef.current = source;
        setMode(deleted === true || (source === "scm" && untracked !== true && !binaryPreview) ? "diff" : "text");
      }, [source]);
      // deleted 翻转（同一文件先预览后被删 / ↩ 恢复后重开）：实例不重挂（key=path），
      // 这里手动跟上——进 deleted 强制 diff 视图并置 deleted 态；解除则重读文本
      const deletedRef = react.useRef(deleted);
      react.useEffect(() => {
        if (deletedRef.current === deleted) return;
        deletedRef.current = deleted;
        if (deleted === true) {
          setMode("diff");
          setState({ phase: "deleted" });
        } else {
          setMode(source === "scm" && untracked !== true && !binaryPreview ? "diff" : "text");
          setReloadNonce((n) => n + 1);
        }
      }, [deleted]);
      const [draft, setDraft] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [reloadNonce, setReloadNonce] = react.useState(0);
      // 预览增强：md 渲染 + CodeMirror 读写高亮。库懒加载；md 只读默认渲染，
      // 需要源码时进编辑即是源码（无独立「切源码」按钮）。
      const [cmReady, setCmReady] = react.useState(false);
      const [mdHtml, setMdHtml] = react.useState(null);
      // PDF 渲染态：错误信息 / 渲染完成（占位与 canvas 由 mountPdfViewer 直接管）
      const [pdfError, setPdfError] = react.useState(null);
      const [pdfDone, setPdfDone] = react.useState(false);
      // Excel 渲染态：sheetNames（非 null 即工作簿已在沙箱打开）/ sheetIdx（活动表）/
      // sheet（活动表全量矩阵，虚拟滚动渲染）/ 错误
      const [sheetNames, setSheetNames] = react.useState(null);
      const [sheetIdx, setSheetIdx] = react.useState(0);
      const [sheet, setSheet] = react.useState(null);
      const [sheetError, setSheetError] = react.useState(null);
      const sheetHostRef = react.useRef(null);
      // docx 渲染态：消毒后的语义 HTML / 错误
      const [docHtml, setDocHtml] = react.useState(null);
      const [docError, setDocError] = react.useState(null);
      const mdHostRef = react.useRef(null);
      const pdfHostRef = react.useRef(null);
      // 标题栏页码指示器槽位（React 只给挂载点，内容归 mountPdfViewer 命令式管理）
      const pdfIndicatorRef = react.useRef(null);
      const readHostRef = react.useRef(null);
      const editHostRef = react.useRef(null);
      react.useEffect(() => {
        ensureCmLib().then(() => setCmReady(true)).catch(() => {});
        return undefined;
      }, []);

      // diff 拉取（静默版）：已有内容时后台更新不闪「加载中」，数据到位再整体替换
      const diffFetchRef = react.useRef(null);
      diffFetchRef.current = () => {
        const c = new AbortController();
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
            if (!c.signal.aborted && error?.name !== "AbortError") setDiff({ phase: "error", error: String(error?.message ?? error) });
          });
      };
      // diff 数据（仅 diff 视图激活时）：进入时拉一次，可见期间低频静默跟随
      // （AI 边改边看也能跟上），转回可见/聚焦立即补；切回原文视图即停轮询。
      // 已删除文件即使二进制也拉（删除 diff 是一行 "Binary files differ"，可显示）
      react.useEffect(() => {
        if (mode !== "diff" || (binaryPreview && deleted !== true) || !cwd) return undefined;
        setDiff({ phase: "loading" });
        if (diffFetchRef.current) diffFetchRef.current();
        const tick = () => {
          if (document.visibilityState !== "hidden" && diffFetchRef.current) diffFetchRef.current();
        };
        const timer = window.setInterval(tick, GIT_POLL_MS);
        document.addEventListener("visibilitychange", tick);
        window.addEventListener("focus", tick);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", tick);
          window.removeEventListener("focus", tick);
        };
      }, [mode, path, cwd]);

      // 让位布局（body 类/宽度/拖拽）由右侧标签页容器统一负责，本组件只管内容。

      react.useEffect(() => {
        // 已删除文件：文本必然读不到（报错无意义），预览只承载删除 diff——
        // 不发 read 请求，直接进 deleted 态（✎/⇄ 等文本面全部隐藏）
        if (deleted === true) {
          setState({ phase: "deleted" });
          return undefined;
        }
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
      }, [path, reloadNonce, deleted]);

      const base = path.split(/[\\/]/).pop() || path;

      // ── md 渲染 + CM 只读/编辑挂载（依赖就绪后接管对应宿主 div）──
      const isMd = /\.(md|markdown)$/i.test(path);
      const ready = state.phase === "ready" && state.body && !state.body.binary && state.body.content !== null;
      const mdActive = isMd && mode === "text" && !editing && ready;
      react.useEffect(() => {
        if (!mdActive) {
          setMdHtml(null);
          return undefined;
        }
        let alive = true;
        ensureMdLibs()
          .then(() => {
            if (!alive) return null;
            const raw = window.marked.parse(state.body.content ?? "", { async: false, gfm: true, breaks: true });
            return window.DOMPurify.sanitize(String(raw));
          })
          .then((html) => {
            if (alive) setMdHtml(typeof html === "string" ? html : "");
          })
          .catch(() => {
            if (alive) setMdHtml("");
          });
        return () => {
          alive = false;
        };
      }, [mdActive, state.body?.content]);
      // md 代码块增强：给每个 pre>code 包一层头部条（语言标签 + 复制按钮），
      // 复制走容器级事件委托。dangerouslySetInnerHTML 的内容 React 不再触碰，
      // DOM 后处理不会被重渲染覆盖；内容变化时 mdHtml 变更触发重挂 innerHTML，
      // 本 effect 随之重跑（React 会复用同一容器节点，委托监听重挂即可）。
      react.useEffect(() => {
        const host = mdHostRef.current;
        if (!mdActive || mdHtml === null || !host) return undefined;
        host.querySelectorAll("pre > code").forEach((code) => {
          const pre = code.parentElement;
          if (!pre || (pre.parentElement && pre.parentElement.classList.contains("dshk-md-code"))) return;
          const m = /language-([\w+#.-]+)/.exec(code.className || "");
          const bar = document.createElement("div");
          bar.className = "dshk-md-codebar";
          const lang = document.createElement("span");
          lang.className = "dshk-md-lang";
          lang.textContent = m ? m[1] : "";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dshk-md-copy";
          btn.textContent = t("mdCopyCode");
          bar.appendChild(lang);
          bar.appendChild(btn);
          const wrap = document.createElement("div");
          wrap.className = "dshk-md-code";
          pre.replaceWith(wrap);
          wrap.appendChild(bar);
          wrap.appendChild(pre);
        });
        // 外链补 target=_blank（在插件面板内点击不丢会话）；站内/相对链接走下方拦截
        host.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href") ?? "";
          if (/^(https?:|mailto:|tel:)/i.test(href) && !a.hasAttribute("target")) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
          }
        });
        const onClick = (e) => {
          const target = e.target instanceof Element ? e.target : null;
          const btn = target ? target.closest(".dshk-md-copy") : null;
          if (btn) {
            const wrap = btn.closest(".dshk-md-code");
            const code = wrap ? wrap.querySelector("pre > code") : null;
            if (!code) return;
            writeClipboard(code.textContent ?? "").then((ok) => {
              if (!ok) return;
              btn.textContent = t("mdCopied");
              setTimeout(() => {
                btn.textContent = t("mdCopyCode");
              }, 1600);
            });
            return;
          }
          // 相对/站内链接：默认行为会把整页导航到 dsh web 根下的对应 URL（如
          // /README.md）→ 404「找不到此页」。拦下并转插件文件预览打开。
          const a = target ? target.closest("a") : null;
          if (!a || e.defaultPrevented) return;
          const href = a.getAttribute("href") ?? "";
          if (href === "" || href.startsWith("#")) return;
          if (/^(https?:|mailto:|tel:)/i.test(href)) return;
          e.preventDefault();
          const opened = resolveMdLink(path, cwd, href);
          if (opened !== null && typeof onOpenFile === "function") onOpenFile(opened, false);
        };
        host.addEventListener("click", onClick);
        return () => host.removeEventListener("click", onClick);
      }, [mdActive, mdHtml, path, cwd, onOpenFile]);
      // ── PDF 渲染：pdf.js 在 iframe 沙箱（原生 Promise realm）里画 canvas
      // （库懒加载）。查看器本体懒加载：全量占位 + 进视口渲染 + 滚远释放位图，
      // 无页数上限；canvas 建在主文档（跨文档采纳会丢位图），沙箱 pdf.js 只执笔
      react.useEffect(() => {
        if (!isPdf || state.phase !== "ready") return undefined;
        const host = pdfHostRef.current;
        if (!host) return undefined;
        let alive = true;
        let doc = null;
        let disposeUi = null;
        setPdfError(null);
        setPdfDone(false);
        const origin = location.origin;
        ensurePdfBox()
          .then((win) => {
            if (!alive) return null;
            return win.pdfjsLib
              .getDocument({
                url: `${origin}/dsh-kit/raw?path=${encodeURIComponent(path)}`,
                cMapUrl: `${origin}/dsh-kit/vendor/cmaps/`,
                cMapPacked: true,
                standardFontDataUrl: `${origin}/dsh-kit/vendor/standard_fonts/`,
              })
              .promise.then((d) => d);
          })
          .then((d) => {
            if (!alive || !d) return undefined;
            doc = d;
            return mountPdfViewer(host, pdfIndicatorRef.current, d, () => !alive);
          })
          .then((dispose) => {
            if (!dispose) return;
            disposeUi = dispose;
            if (alive) setPdfDone(true);
          })
          .catch((error) => {
            if (alive) setPdfError(String(error?.message ?? error));
          });
        return () => {
          alive = false;
          if (disposeUi) disposeUi();
          host.innerHTML = "";
          if (doc) doc.destroy();
        };
      }, [isPdf, state.phase, path, reloadNonce]);
      // ── Excel 渲染：fetch raw 字节 → 沙箱打开工作簿（全量留沙箱）→ 按表取矩阵
      react.useEffect(() => {
        if (!isSheet || state.phase !== "ready") return undefined;
        let alive = true;
        setSheetNames(null);
        setSheet(null);
        setSheetIdx(0);
        setSheetError(null);
        if ((state.body?.size ?? 0) > 20 * 1024 * 1024) {
          setSheetError(t("previewTooLarge"));
          return undefined;
        }
        const origin = location.origin;
        Promise.all([
          fetch(`${origin}/dsh-kit/raw?path=${encodeURIComponent(path)}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
          ensureSheetBox(),
        ])
          .then(([buf, win]) => setSheetNames(win.__dshkSheetOpen(new Uint8Array(buf))))
          .catch((error) => {
            if (alive) setSheetError(String(error?.message ?? error));
          });
        return () => {
          alive = false;
        };
      }, [isSheet, state.phase, path, reloadNonce]);
      // 活动表矩阵加载（工作簿留在沙箱，切表零重复解析）
      react.useEffect(() => {
        if (!isSheet || sheetNames === null) return undefined;
        let alive = true;
        setSheet(null);
        ensureSheetBox()
          .then((win) => {
            if (!alive) return;
            setSheet(win.__dshkSheetGet(Math.min(sheetIdx, sheetNames.length - 1)));
          })
          .catch((error) => {
            if (alive) setSheetError(String(error?.message ?? error));
          });
        return () => {
          alive = false;
        };
      }, [isSheet, sheetNames, sheetIdx]);
      // 矩阵 → 虚拟滚动表挂载（切表/换文件时 host 内容由 mount 自己清）
      react.useEffect(() => {
        const host = sheetHostRef.current;
        if (!isSheet || !sheet || !host) return undefined;
        return mountSheetTable(host, sheet);
      }, [isSheet, sheet]);
      // ── docx 渲染：fetch raw 字节 → mammoth 沙箱转语义 HTML → DOMPurify 消毒
      react.useEffect(() => {
        if (!isDoc || state.phase !== "ready") return undefined;
        let alive = true;
        setDocHtml(null);
        setDocError(null);
        if ((state.body?.size ?? 0) > 20 * 1024 * 1024) {
          setDocError(t("previewTooLarge"));
          return undefined;
        }
        const origin = location.origin;
        Promise.all([
          fetch(`${origin}/dsh-kit/raw?path=${encodeURIComponent(path)}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
          ensureDocBox(),
          ensureMdLibs(),
        ])
          .then(([buf, win]) => win.__dshkDocxParse(new Uint8Array(buf)))
          .then((html) => {
            if (!alive) return;
            setDocHtml(window.DOMPurify.sanitize(html, { ADD_DATA_URI_TAGS: ["img"] }));
          })
          .catch((error) => {
            if (alive) setDocError(String(error?.message ?? error));
          });
        return () => {
          alive = false;
        };
      }, [isDoc, state.phase, path, reloadNonce]);
      // 只读视图：文本类文件统一交给 CM（只读实例）；md 渲染态不挂
      react.useEffect(() => {
        const host = readHostRef.current;
        if (!cmReady || !host || mode !== "text" || editing || mdActive) return undefined;
        if (!ready) return undefined;
        const h = window.CM6.create(host, { doc: state.body.content ?? "", readOnly: true, language: extOf(path) });
        return () => h.destroy();
      }, [cmReady, mode, editing, mdActive, path, ready, state.body?.content]);
      // 编辑视图：CM 可编辑实例，文档变更回写 draft（保存/未保存判定全部沿用 draft）
      react.useEffect(() => {
        const host = editHostRef.current;
        if (!cmReady || !editing || !host) return undefined;
        const h = window.CM6.create(host, { doc: draft, readOnly: false, language: extOf(path) });
        h.onDocChanged((text) => setDraft(text));
        return () => h.destroy();
      }, [cmReady, editing, path]);

      /** diff 视图：优先全文件着色（hunk 套回完整内容，删除红/新增绿）；
       *  截断大文件或 hunk 对不上时回退原始 patch 渲染 */
      const renderDiffView = () => {
        if (diff.phase === "loading") return jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") });
        if (diff.phase === "error")
          return jsxRuntime.jsx("div", { className: "dshk-note", title: diff.error, children: `${t("diffFail")}：${diff.error}` });
        if (deleted === true) {
          // 已删除文件：不看 raw diff（diff --git/index/--- 等元数据是噪音）——
          // 只抽删除行、剥掉前缀 `-`，整块按"已删除"红色展示（= 被删文件全文）
          if (diff.clean || diff.text === null) return jsxRuntime.jsx("div", { className: "dshk-note", children: t("diffEmpty") });
          const removed = diff.text
            .split("\n")
            .filter((l) => l.startsWith("-") && !l.startsWith("---"))
            .map((l) => (l.length > 1 ? l.slice(1) : ""));
          if (removed.length === 0) return jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentEmpty") });
          return jsxRuntime.jsx(
            "div",
            {
              className: "dshk-inline",
              children: removed.map((text, i) =>
                jsxRuntime.jsx("div", { className: "dshk-il-del", children: text === "" ? " " : text }, i),
              ),
            },
          );
        }
        if (diff.untracked) {
          // 未跟踪文件没有基线版本：整文件按"新增"着色展示（对齐 git 对未跟踪
          // 文件的 diff 语义，避免只给一行空提示）；内容截断/未就绪时才回落提示
          const content =
            state.body && !state.body.truncated && typeof state.body.content === "string" ? state.body.content : null;
          if (content !== null) {
            return jsxRuntime.jsx(
              "div",
              {
                className: "dshk-inline",
                children: content.split("\n").map((text, i) =>
                  jsxRuntime.jsx("div", { className: "dshk-il-add", children: text === "" ? " " : text }, i),
                ),
              },
            );
          }
          return jsxRuntime.jsx("div", { className: "dshk-note", children: t("diffUntracked") });
        }
        if (diff.clean || diff.text === null) return jsxRuntime.jsx("div", { className: "dshk-note", children: t("diffEmpty") });

        const newLines =
          state.body && !state.body.truncated && typeof state.body.content === "string" ? state.body.content.split("\n") : null;
        const rows = newLines ? buildInlineRows(diff.text, newLines) : null;
        if (rows) {
          return jsxRuntime.jsx(
            "div",
            {
              className: "dshk-inline",
              children: rows.map(([type, text], i) =>
                jsxRuntime.jsx("div", { className: `dshk-il-${type}`, children: text === "" ? " " : text }, i),
              ),
            },
          );
        }
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
            cmReady
              ? jsxRuntime.jsx("div", { className: "dshk-editarea dshk-cm-host", ref: editHostRef })
              : jsxRuntime.jsx("textarea", {
                  className: "dshk-editarea",
                  value: draft,
                  spellCheck: false,
                  onChange: (e) => setDraft(e.target.value),
                }),
          ],
        });

      const startEdit = () => {
        // 截断预览的文件不允许编辑（保存会丢掉 512KB 之后的内容）；PDF 一律不可编辑
        if (binaryPreview || !state.body || state.body.binary || state.body.content === null || state.body.truncated) return;
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
      } else if (state.phase === "deleted" || !state.body) {
        // 已删除（或异常无 body）：deleted 的渲染走独立分支（说明行 + diff 视图），
        // body 只兜占位——严禁在这里读 state.body 的字段（b.binary 崩溃的教训）
        body = jsxRuntime.jsx("div", { className: "dshk-note", children: state.phase === "deleted" ? t("pvDeletedNote") : t("contentLoading") });
      } else {
        const b = state.body;
        if (isPdf) {
          // PDF：pdf.js 逐页 canvas 渲染（Edge 内置查看器对 http:// 源一律灰屏，
          // iframe/顶层都不可用——见 src/index.js raw 端点注释）
          body = jsxRuntime.jsxs("div", {
            className: "dshk-pane-body dshk-pdfwrap",
            children: [
              pdfError
                ? jsxRuntime.jsx("div", { className: "dshk-note", title: pdfError, children: `${t("contentFail")}：${pdfError}` })
                : null,
              jsxRuntime.jsx("div", { className: "dshk-pdf-scroll", ref: pdfHostRef }),
              !pdfError && !pdfDone
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") })
                : null,
            ],
          });
        } else if (isSheet) {
          const activeIdx = sheetNames ? Math.min(sheetIdx, sheetNames.length - 1) : 0;
          body = jsxRuntime.jsxs("div", {
            className: "dshk-pane-body dshk-sheetwrap",
            children: [
              sheetError
                ? jsxRuntime.jsx("div", { className: "dshk-note", title: sheetError, children: `${t("contentFail")}：${sheetError}` })
                : null,
              sheetNames
                ? jsxRuntime.jsx(
                    "div",
                    {
                      className: "dshk-sheet-tabs",
                      children: sheetNames.map((name, i) =>
                        jsxRuntime.jsx("button", {
                          type: "button",
                          className: "dshk-sheet-tab" + (i === activeIdx ? " dshk-sheet-tab-on" : ""),
                          title: name,
                          onClick: () => setSheetIdx(i),
                          children: name,
                        }),
                      ),
                    },
                  )
                : null,
              jsxRuntime.jsx("div", { className: "dshk-sheet-scroll", ref: sheetHostRef }),
              sheet && sheet.truncated
                ? jsxRuntime.jsx("div", {
                    className: "dshk-note",
                    title: `共 ${sheet.totalRows} 行 × ${sheet.totalCols} 列，已加载前 ${sheet.shownRows} 行 × ${sheet.shownCols} 列`,
                    children: t("sheetRowCap"),
                  })
                : null,
              !sheetError && sheetNames === null
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") })
                : null,
            ],
          });
        } else if (isDoc) {
          body = jsxRuntime.jsxs("div", {
            className: "dshk-pane-body dshk-docwrap",
            children: [
              docError
                ? jsxRuntime.jsx("div", { className: "dshk-note", title: docError, children: `${t("contentFail")}：${docError}` })
                : null,
              docHtml !== null
                ? jsxRuntime.jsx("div", { className: "dshk-md dshk-doc", dangerouslySetInnerHTML: { __html: docHtml } })
                : null,
              !docError && docHtml === null
                ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") })
                : null,
            ],
          });
        } else if (b.binary) {
          body = jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentBinary") });
        } else if (b.content === null || b.content === "") {
          body = jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentEmpty") });
        } else {
          body = jsxRuntime.jsxs("div", {
            className: "dshk-pane-body",
            children: [
              b.truncated ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentTruncated") }) : null,
              mdActive
                ? mdHtml === null
                  ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") })
                  : jsxRuntime.jsx("div", { className: "dshk-md", ref: mdHostRef, dangerouslySetInnerHTML: { __html: mdHtml } })
                : cmReady
                  ? jsxRuntime.jsx("div", { className: "dshk-cm-host", ref: readHostRef })
                  : jsxRuntime.jsx("pre", { className: "dshk-pane-pre", children: b.content }),
            ],
          });
        }
      }

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              // 只留文件名；绝对路径放悬停 tooltip（用户定稿：相对路径信息量低，
              // 且文件在工作区根时与文件名重复）
              jsxRuntime.jsx("span", { className: "dshk-title", title: path, children: base }),
              jsxRuntime.jsx("span", { className: "dshk-spring" }),
              // PDF 页码指示器：挂标题栏固定区不遮内容；文档加载失败时不给槽位
              isPdf && state.phase === "ready" && !pdfError
                ? jsxRuntime.jsx("span", { ref: pdfIndicatorRef })
                : null,
              // 原文 ⇄ diff 双视图切换（同一预览面板，入口只决定默认视图）；
              // PDF 无 diff 视图，不显示
              !editing && !binaryPreview && deleted !== true
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t(mode === "diff" ? "toText" : "toDiff"),
                    onClick: () => setMode((m) => (m === "diff" ? "text" : "diff")),
                    children: "⇄",
                  })
                : null,
              // PDF 新标签页兜底：手机端个别浏览器不支持 iframe 内嵌 PDF
              isPdf && state.phase === "ready"
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("pdfNewTab"),
                    onClick: () => window.open(`/dsh-kit/raw?path=${encodeURIComponent(path)}`, "_blank", "noopener"),
                    children: "↗",
                  })
                : null,
              // ✎ 编辑不再限文件树来源；截断/二进制不可编辑的判定不变；
              // PDF 即使解码成文本也禁编辑（文本方式保存 PDF 会损坏文件）
              state.phase === "ready" && state.body && !binaryPreview && !state.body.binary && !state.body.truncated && !editing
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("edit"),
                    onClick: startEdit,
                    children: "✎",
                  })
                : null,
            ],
          }),
          deleted === true
            ? jsxRuntime.jsxs(jsxRuntime.Fragment, {
                children: [
                  jsxRuntime.jsx("div", { className: "dshk-brw-note", children: t("pvDeletedNote") }),
                  jsxRuntime.jsx("div", { className: "dshk-pane-body", children: renderDiffView() }),
                ],
              })
            : editing
              ? renderEditor()
              : mode === "diff" && !binaryPreview
                ? jsxRuntime.jsx("div", { className: "dshk-pane-body", children: renderDiffView() })
                : body,
        ],
      });
    }

    // ─────────── 入口按钮（conversation.input.left）───────────
    // 只负责开合与按压态；面板本体在 KitSurfaces（shell.overlay）渲染。
    // 选中态标记：aria-pressed 属性选择器命中 .dshk-enbtn[aria-pressed="true"]
    // 规则（底色 + 品牌色图标）。此前用的 --dsw-alias-fill-l2 在主题里并不存在，
    // 背景解析为透明，选中态等于没有——已换成真实存在的 tool-bar-fill 令牌。
    function TerminalEntry(props) {
      const ui = useKitUi();
      const cwd = useCurrentCwd(props);
      const count = ui.terminals.length;
      const dockOn = ui.termDockOpen && count > 0;
      return jsxRuntime.jsxs("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": dockOn,
        title: count > 0 ? `${t("label")} · ${count}` : t("label"),
        onClick: () => {
          // 只开/关终端坞：隐藏不杀进程，后台会话继续跑；无会话时新建并绑定
          // 当时的当前会话工作区（之后切换会话不影响已开终端）
          setKitUi(toggleTermDock(kitUi, cwd));
        },
        children: [
          jsxRuntime.jsx(TerminalIcon, {}),
          count > 0
            ? jsxRuntime.jsx("span", { className: "dshk-term-badge", "aria-hidden": true, children: String(count) })
            : null,
        ],
      });
    }

    // ── 侧边栏兜底与快捷键 ──
    // 文件树/源代码管理视图承载在 sidebar.workspaces 里，侧边栏收起时只剩图标栏，
    // 视图会挤进铁轨里很难看——所以打开动作做自动展开：状态探测官方切换按钮
    // （aria-label 随状态变化，收起态是「打开侧边栏」/"Open sidebar"，注意关键字
    // 是「打开」不是「展开」），只在收起态点击——幂等且方向安全。此前优先走官方
    // 注入的 expandSidebar 回调，但该闭包捕获渲染时的 folded 状态且槽位注销后不再
    // 刷新，残留宽态实例调用是空操作（收起后首次打开不展开的根因），已整体移除。
    function sidebarBtn() {
      try {
        const labelled = document.querySelectorAll("[aria-label]");
        for (const el of labelled) {
          const label = (el.getAttribute("aria-label") ?? "").trim();
          if (!/侧边栏|sidebar/i.test(label)) continue;
          if (/^(打开|展开|Open|Expand)/i.test(label)) return { collapsed: true, btn: el };
          if (/^(收起|Collapse)/i.test(label)) return { collapsed: false, btn: el };
        }
      } catch {
        // 探测失败按展开处理
      }
      return { collapsed: false, btn: null };
    }
    /** 打开动作：收起态才点击官方切换按钮 */
    function expandSidebarNow() {
      const { collapsed, btn } = sidebarBtn();
      if (collapsed && btn) btn.click();
    }
    /** 快捷键用：展开/收起侧边栏切换 */
    function toggleSidebar() {
      const { btn } = sidebarBtn();
      if (btn) btn.click();
    }

    function FileTreeEntry() {
      const ui = useKitUi();
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": ui.treeOpen,
        title: t("treeLabel"),
        onClick: () => {
          // Ctrl+E/按钮同语义：非文件树态 → 打开文件树；已是文件树 → 关闭回会话列表。
          // 打开动作先兜底展开被收起的侧边栏（否则视图渲染进图标栏等于不可见）；
          // 关闭动作保留文件预览（预览有独立 ✕，关来源视图不连带关预览）
          if (!ui.treeOpen) expandSidebarNow();
          setKitUi({ treeOpen: !ui.treeOpen, gitOpen: false });
        },
        children: jsxRuntime.jsx(FolderIcon, {}),
      });
    }

    /** 源代码管理入口：独立开关——非 SCM 态打开(收起文件树)；已开 → 关闭回会话列表 */
    function ScmEntry() {
      const ui = useKitUi();
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": ui.gitOpen,
        title: t("scTitle"),
        onClick: () => {
          if (!ui.gitOpen) expandSidebarNow();
          setKitUi({ gitOpen: !ui.gitOpen, treeOpen: false });
        },
        children: jsxRuntime.jsx(BranchIcon, {}),
      });
    }

    // ─────────── 手机访问页（settings.section，与技能页同类）───────────
    // 数据源：宿主半边 /dsh-kit/phone/info|link（rotate 无 UI 入口——轮换在
    // 宿主侧随「关闭→开启」自动触发）。这些端点挂在主 webserver
    // （只绑回环，LAN 够不到），宿主侧另有同源校验。二维码用 vendored
    // qrcode-generator（/dsh-kit/vendor/qrcode.js），首次打开面板时按需加载，
    // 与 xterm 同策略。
    function fetchPhoneInfo(signal) {
      return fetch("/dsh-kit/phone/info", { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        // 字段以宿主回包为准：visible 是页面可见性，网关状态看 gatewayOn/running
        if (!res.ok || !body || typeof body.visible !== "boolean") throw new Error(`HTTP ${res.status}`);
        return body;
      });
    }
    function fetchPhoneLinks(signal) {
      return fetch("/dsh-kit/phone/link", { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !Array.isArray(body.links)) throw new Error((body && body.error) || `HTTP ${res.status}`);
        return body;
      });
    }
    /** 把链接画上 canvas：白色静区 + 码点，按 devicePixelRatio 输出清晰图 */
    function drawPhoneQr(canvas, text) {
      const qrcode = window.qrcode;
      if (typeof qrcode !== "function") throw new Error("qrcode lib not loaded");
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const quiet = 4;
      const cell = Math.max(3, Math.floor(220 / (count + quiet * 2)));
      const size = cell * (count + quiet * 2);
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#111111";
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
        }
      }
    }
    function PhoneSection() {
      const [info, setInfo] = react.useState(null);
      const [linkData, setLinkData] = react.useState(null);
      const [loadErr, setLoadErr] = react.useState("");
      const [activeIdx, setActiveIdx] = react.useState(0);
      const [qrReady, setQrReady] = react.useState(false);
      const [copied, setCopied] = react.useState(false);
      const [notice, setNotice] = react.useState("");
      const canvasRef = react.useRef(null);
      // 远程域名的页内编辑（配置卡不再承载）：草稿态 + 保存即写 settings 并刷新链接
      const [domainValue, setDomainValue] = react.useState("");
      const [domainTouched, setDomainTouched] = react.useState(false);
      const [domainSaving, setDomainSaving] = react.useState(false);
      // 网关端口页内编辑：与远程域名同一条保存链（保存后宿主按新端口重启网关）
      const [portValue, setPortValue] = react.useState("");
      const [portTouched, setPortTouched] = react.useState(false);
      // 网关启停开关（POST /dsh-kit/phone/gateway；状态文件直管，不经 settings）
      const [gateBusy, setGateBusy] = react.useState(false);
      const toggleGateway = async (next) => {
        if (gateBusy) return;
        setGateBusy(true);
        try {
          const res = await fetch("/dsh-kit/phone/gateway", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ on: next }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || typeof body.gatewayOn !== "boolean") throw new Error(`HTTP ${res.status}`);
          // 以端点回包为准更新状态（不依赖 settings 读取器，无滞后）
          setInfo((info) =>
            info === null
              ? info
              : { ...info, gatewayOn: body.gatewayOn, running: body.running === true, error: body.error ?? null },
          );
          if (body.gatewayOn && body.running) {
            fetchPhoneLinks(new AbortController().signal).then(setLinkData).catch(() => {});
          } else {
            setLinkData(null);
          }
        } catch {
          // 失败保持原状：下一次 info 刷新为准
        }
        setGateBusy(false);
      };
      // 手动轮换令牌：作废旧链接生成新链接（启停不再自动轮换，见宿主 setGatewayEnabled）
      const rotateLink = async () => {
        if (gateBusy) return;
        setGateBusy(true);
        try {
          const res = await fetch("/dsh-kit/phone/rotate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || !Array.isArray(body.links)) throw new Error(`HTTP ${res.status}`);
          setLinkData(body);
          setNotice(t("phoneRotated"));
          setTimeout(() => setNotice(""), 3000);
        } catch (e) {
          setNotice(tf("phoneRotateFail", { error: String(e?.message ?? e) }));
          setTimeout(() => setNotice(""), 3000);
        }
        setGateBusy(false);
      };
      const shownDomain = domainTouched
        ? domainValue
        : info && typeof info.remoteDomain === "string"
          ? info.remoteDomain
          : "";
      const shownPort = portTouched
        ? portValue
        : info && Number.isFinite(info.port)
          ? String(info.port)
          : "3090";
      const savePhoneNet = async () => {
        if (domainSaving || !cfgScope) return;
        // 端口草稿非法：阻断保存并提示（不落盘、不清草稿）
        let nextPort = null;
        if (portTouched) {
          const n = Number(String(portValue).trim());
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            setNotice(t("phonePortInvalid"));
            setTimeout(() => setNotice(""), 3000);
            return;
          }
          nextPort = n;
        }
        setDomainSaving(true);
        try {
          if (domainTouched) await cfgScope.set("phoneRemoteDomain", shownDomain.trim());
          if (nextPort !== null) await cfgScope.set("phonePort", nextPort);
          setDomainTouched(false);
          setPortTouched(false);
          setNotice(t("save") + " ✓");
          if (info !== null && info.gatewayOn && info.running) {
            fetchPhoneLinks(new AbortController().signal).then(setLinkData).catch(() => {});
          }
          // 端口变更时宿主侧重启网关是异步的：延迟刷新状态与链接跟进新端口
          if (nextPort !== null) {
            setTimeout(() => {
              fetchPhoneInfo(new AbortController().signal)
                .then((body) => {
                  setInfo(body);
                  if (body.gatewayOn && body.running) {
                    return fetchPhoneLinks(new AbortController().signal).then(setLinkData).catch(() => {});
                  }
                  return undefined;
                })
                .catch(() => {});
            }, 1200);
          }
        } catch {
          // 保存失败保持草稿供修改
        } finally {
          setDomainSaving(false);
          setTimeout(() => setNotice(""), 3000);
        }
      };

      // 打开即取状态与链接；网关未跑时只显示原因
      react.useEffect(() => {
        const ctrl = new AbortController();
        fetchPhoneInfo(ctrl.signal)
          .then((body) => {
            setInfo(body);
            if (body.gatewayOn && body.running) {
              return fetchPhoneLinks(ctrl.signal).then(setLinkData).catch((e) => setLoadErr(String(e?.message ?? e)));
            }
            return undefined;
          })
          .catch((e) => setLoadErr(String(e?.message ?? e)));
        return () => ctrl.abort();
      }, []);
      // vendored 二维码库按需加载一次
      react.useEffect(() => {
        if (typeof window !== "undefined" && typeof window.qrcode === "function") {
          setQrReady(true);
          return undefined;
        }
        loadScript("/dsh-kit/vendor/qrcode.js")
          .then(() => setQrReady(true))
          .catch(() => {});
        return undefined;
      }, []);

      const links = linkData && Array.isArray(linkData.links) ? linkData.links : [];
      const activeUrl = links[activeIdx] ? links[activeIdx].url : "";
      // 链接统一出二维码（LAN/远程同等待遇）；远程链接公网可达，页面提示谨防
      // 他人扫码（见 phoneRemoteCaution）。悬停复制按钮 title 可查看完整链接。
      const activeIsRemote = !!(links[activeIdx] && links[activeIdx].label === "remote");
      react.useEffect(() => {
        if (!qrReady || activeUrl === "" || !canvasRef.current) return;
        try {
          drawPhoneQr(canvasRef.current, activeUrl);
        } catch {
          // 绘制失败不阻塞面板：仍可点「复制链接」获取
        }
      }, [qrReady, activeUrl]);

      const copyActive = () => {
        if (activeUrl === "") return;
        writeClipboard(activeUrl).then((ok) => {
          if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }
        });
      };

      const gatewayOn = info !== null && info.gatewayOn === true;
      let statusNode = jsxRuntime.jsx("p", { className: "dshk-phone-status", children: t("phoneLoading") });
      if (info !== null) {
        if (!gatewayOn) statusNode = jsxRuntime.jsx("p", { className: "dshk-phone-status", children: t("phoneStoppedHint") });
        else if (!info.running) statusNode = jsxRuntime.jsx("p", { className: "dshk-phone-status", children: tf("phoneStatusErr", { error: info.error ?? "unknown" }) });
        else statusNode = jsxRuntime.jsx("p", { className: "dshk-phone-status", children: tf("phoneStatusOn", { port: info.port }) });
      }
      if (loadErr !== "") {
        statusNode = jsxRuntime.jsx("p", { className: "dshk-phone-status", children: tf("phoneLoadFail", { error: loadErr }) });
      }

      return jsxRuntime.jsxs("div", {
        className: "dshk-phone",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-phone-head",
            children: [
              jsxRuntime.jsx("span", { className: "dshk-phone-title", children: t("phoneTitle") }),
              jsxRuntime.jsx("span", { style: { flex: 1 } }),
              notice !== ""
                ? jsxRuntime.jsx("span", { className: "dshk-phone-notice", role: "status", children: notice })
                : null,
            ],
          }),
          cfgScope
            ? jsxRuntime.jsx("button", {
                type: "button",
                className: gatewayOn ? "dshk-phone-gatebtn dshk-phone-gatebtn-stop" : "dshk-phone-gatebtn",
                disabled: gateBusy,
                onClick: () => {
                  toggleGateway(!gatewayOn);
                },
                children: t(gatewayOn ? "phoneGateStop" : "phoneGateStart"),
              })
            : null,
          statusNode,
          cfgScope
            ? jsxRuntime.jsxs("div", {
                className: "dshk-phone-domain",
                children: [
                  jsxRuntime.jsx("span", { className: "dshk-phone-domain-label", children: t("cfgPhoneRemoteDomain") }),
                  jsxRuntime.jsx("input", {
                    type: "text",
                    className: "dshk-cfg-text dshk-phone-domain-input",
                    value: shownDomain,
                    placeholder: "dsh.example.com",
                    spellCheck: false,
                    disabled: domainSaving,
                    onChange: (e) => {
                      setDomainValue(e.target.value);
                      setDomainTouched(true);
                    },
                  }),
                  jsxRuntime.jsx("span", { className: "dshk-phone-domain-label", children: t("cfgPhonePort") }),
                  jsxRuntime.jsx("input", {
                    type: "number",
                    className: "dshk-cfg-text dshk-phone-port",
                    min: 1,
                    max: 65535,
                    step: 1,
                    value: shownPort,
                    title: t("cfgPhonePortHint"),
                    disabled: domainSaving,
                    onChange: (e) => {
                      setPortValue(e.target.value);
                      setPortTouched(true);
                    },
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-phone-copybtn",
                    disabled: domainSaving || (!domainTouched && !portTouched),
                    onClick: () => {
                      savePhoneNet();
                    },
                    children: t("save"),
                  }),
                ],
              })
            : null,
          links.length > 0
            ? jsxRuntime.jsxs(
                "div",
                {
                  className: "dshk-phone-body",
                  children: [
                    links.length > 1
                      ? jsxRuntime.jsx("div", {
                          className: "dshk-phone-tabs",
                          children: links.map((item, index) =>
                            jsxRuntime.jsx(
                              "button",
                              {
                                type: "button",
                                className: "dshk-phone-tab",
                                "aria-pressed": index === activeIdx,
                                onClick: () => setActiveIdx(index),
                                children: item.label === "remote" ? t("phoneRemote") : t("phoneLan"),
                              },
                              item.url,
                            ),
                          ),
                        })
                      : null,
                    jsxRuntime.jsx("div", { className: "dshk-phone-qrwrap", children: jsxRuntime.jsx("canvas", { ref: canvasRef, "aria-label": "QR code" }) }),
                    jsxRuntime.jsxs("div", {
                      className: "dshk-phone-urlrow",
                      children: [
                        jsxRuntime.jsx("button", {
                          type: "button",
                          className: "dshk-phone-copybtn",
                          title: activeUrl,
                          onClick: copyActive,
                          children: copied ? t("phoneCopied") : t("phoneCopy"),
                        }),
                        gatewayOn
                          ? jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-phone-rotate",
                              title: t("phoneRotateHint"),
                              disabled: gateBusy,
                              onClick: () => {
                                rotateLink();
                              },
                              children: t("phoneRotate"),
                            })
                          : null,
                      ],
                    }),
                    jsxRuntime.jsx("p", { className: "dshk-phone-hint", children: t(activeIsRemote ? "phoneRemoteCaution" : "phoneScanHint") }),
                  ],
                },
              )
            : null,
        ],
      });
    }

    // ─────────── 后台任务面板 ───────────
    // 入口按钮（conversation.input.left）只负责开合；面板本体由 KitSurfaces 在
    // shell.overlay 渲染——右侧停靠（复用 .dshk-pane，与文件预览共用停靠位、
    // 互斥打开），对话可继续。任务数据源与官方
    // JobListAction 相同——useSessions 的 jobsBySession（session/jobs 推送）。
    // 「结束」与「输出」走 dsh-kit 宿主端点（/dsh-kit/jobs/kill|output，权限按
    // session 隔离，与 job_kill/job_output 同一套 caller 语义）。
    function JobsEntry(props) {
      const ui = useKitUi();
      const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      const current = useSessions ? useSessions((s) => s.current) : undefined;
      const jobs = useSessions ? useSessions((s) => (current ? s.jobsBySession[current] : undefined)) : undefined;
      const live = Array.isArray(jobs) ? jobs.filter((j) => j.status === "running" || j.status === "stopping") : [];
      const on = ui.jobsOpen && ui.dockTab === "jobs" && ui.dockCollapsed !== true;
      return jsxRuntime.jsxs("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": on,
        title: live.length > 0 ? `${t("jobsTitle")} (${live.length})` : t("jobsTitle"),
        onClick: () => {
          // 标签页语义：确保任务标签存在并激活（不清别的标签）；已是激活标签则关掉
          if (on) setKitUi(closeDockTab(kitUi, "jobs"));
          else setKitUi({ jobsOpen: true, dockTab: "jobs", dockCollapsed: false });
        },
        children: [
          jsxRuntime.jsx(JobsIcon, {}),
          live.length > 0
            ? jsxRuntime.jsx("span", { className: "dshk-term-badge", "aria-hidden": true, children: String(live.length) })
            : null,
        ],
      });
    }

    /** 任务时长：中文「x分y秒」/ 英文 "x m y s"，秒级取整 */
    function fmtJobDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      const zhLang = resolveZh();
      if (hours > 0) return zhLang ? `${hours}小时${minutes}分` : `${hours}h ${minutes}m`;
      if (minutes > 0) return zhLang ? `${minutes}分${seconds}秒` : `${minutes}m ${seconds}s`;
      return zhLang ? `${seconds}秒` : `${seconds}s`;
    }

    function JobsPanel(props) {
      const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      const current = useSessions ? useSessions((s) => s.current) : undefined;
      const jobs = useSessions ? useSessions((s) => (current ? s.jobsBySession[current] : undefined)) : undefined;
      const live = Array.isArray(jobs) ? jobs.filter((j) => j.status === "running" || j.status === "stopping") : [];
      const [expandedId, setExpandedId] = react.useState(null);
      const [outputs, setOutputs] = react.useState({});
      const [killing, setKilling] = react.useState(null);
      const [now, setNow] = react.useState(() => Date.now());

      // 时长随秒更新（有 live 任务才计时）
      react.useEffect(() => {
        if (live.length === 0) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [live.length]);

      // 输出增量轮询：展开且任务仍 live 时每秒拉一次；拉到终态即停。
      // 注意 read 与 job_output 共享读取游标——面板打开期间模型侧读到的是
      // 面板尚未读走的增量（官方语义，无法并行两份）。
      react.useEffect(() => {
        if (!expandedId || !current) return undefined;
        let disposed = false;
        let timer = null;
        const load = () => {
          fetch(
            `/dsh-kit/jobs/output?sessionId=${encodeURIComponent(current)}&jobId=${encodeURIComponent(expandedId)}`,
          )
            .then((res) => res.json().catch(() => null))
            .then((body) => {
              if (disposed) return;
              if (!body || !body.job) {
                setOutputs((prev) => ({ ...prev, [expandedId]: { text: "", error: "HTTP" } }));
                return;
              }
              setOutputs((prev) => ({
                ...prev,
                [expandedId]: {
                  text: (prev[expandedId]?.text ?? "") + (typeof body.text === "string" ? body.text : ""),
                  error: null,
                },
              }));
              const done = body.job.status === "completed" || body.job.status === "killed" || body.job.status === "failed";
              if (done && timer !== null) clearInterval(timer);
            })
            .catch(() => {
              if (!disposed) setOutputs((prev) => ({ ...prev, [expandedId]: { text: prev[expandedId]?.text ?? "", error: "network" } }));
            });
        };
        load();
        timer = setInterval(load, 1000);
        return () => {
          disposed = true;
          if (timer !== null) clearInterval(timer);
        };
      }, [expandedId, current]);

      const killJob = async (job) => {
        setKilling(job.id);
        try {
          const res = await fetch("/dsh-kit/jobs/kill", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: current, jobId: job.id }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
          flashToast(t("jobsKillDone"));
          if (expandedId === job.id) setExpandedId(null);
        } catch (error) {
          flashToast(tf("jobsKillFail", { error: String(error?.message ?? error) }));
        } finally {
          setKilling(null);
        }
      };

      // 让位布局（body 类/宽度/拖拽）由右侧标签页容器统一负责，本组件只管内容。

      const statusWord = (job) => {
        switch (job.status) {
          case "running": return t("jobsStatusRunning");
          case "stopping": return t("jobsStatusStopping");
          case "completed": return t("jobsStatusCompleted");
          case "killed": return t("jobsStatusKilled");
          case "failed": return t("jobsStatusFailed");
          default: return job.status;
        }
      };

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-jobs-head",
            children: [
              jsxRuntime.jsxs("span", {
                className: "dshk-jobs-headside",
                children: [
                  jsxRuntime.jsx("span", { children: t("jobsTitle") }),
                  jsxRuntime.jsx("span", { className: "dshk-jobs-count", children: String(live.length) }),
                ],
              }),
            ],
          }),
          live.length === 0
            ? jsxRuntime.jsx("div", { className: "dshk-jobs-empty", children: t("jobsEmpty") })
            : jsxRuntime.jsx("div", {
                className: "dshk-jobs-list",
                children: live.map((job) => {
                  const isExpanded = expandedId === job.id;
                  const out = outputs[job.id];
                  const stopBusy = killing === job.id || job.status === "stopping";
                  return jsxRuntime.jsxs("div", {
                    className: "dshk-jobs-row",
                    "data-live": job.status === "running" || undefined,
                    children: [
                      jsxRuntime.jsxs("div", {
                        className: "dshk-jobs-rowline",
                        children: [
                          jsxRuntime.jsx("span", { className: "dshk-jobs-kind", children: job.kind }),
                          jsxRuntime.jsx("span", { className: "dshk-jobs-label", title: job.label, children: job.label }),
                          jsxRuntime.jsx("span", {
                            className: "dshk-jobs-status",
                            title: job.detail ?? statusWord(job),
                            children:
                              job.status === "running" || job.status === "stopping"
                                ? `${statusWord(job)} · ${tf("jobsDuration", { duration: fmtJobDuration(now - job.startedAt) })}`
                                : statusWord(job),
                          }),
                          jsxRuntime.jsxs("span", {
                            className: "dshk-jobs-actions",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "dshk-jobs-btn",
                                disabled: stopBusy,
                                title: t("jobsOutputHint"),
                                onClick: () => {
                                  if (isExpanded) {
                                    setExpandedId(null);
                                  } else {
                                    setOutputs((prev) => ({ ...prev, [job.id]: { text: "", error: null } }));
                                    setExpandedId(job.id);
                                  }
                                },
                                children: t("jobsOutput"),
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "dshk-jobs-btn dshk-jobs-btn-kill",
                                disabled: stopBusy,
                                title: t("jobsKillHint"),
                                onClick: () => killJob(job),
                                children: t("jobsKill"),
                              }),
                            ],
                          }),
                        ],
                      }),
                      isExpanded
                        ? jsxRuntime.jsx("div", {
                            className: "dshk-jobs-output",
                            children:
                              out && out.error
                                ? tf("jobsOutputTransient", { error: out.error })
                                : out && out.text && out.text.length > 0
                                  ? out.text
                                  : t("jobsOutputEmpty"),
                          })
                        : null,
                    ],
                  }, job.id);
                }),
              }),
        ],
      });
    }

    // ─────────── 内置浏览器面板（右侧停靠，复用 .dshk-pane 停靠位）───────────
    // 数据走宿主半边 /dsh-kit/browser WS：state/event 广播 + frame 帧流（jpeg）+
    // watch 引用计数 + open/activate/closeTab/nav/newTab（人操作）+ input（人机共驾）。
    // 设计定位：面板是 agent 隔离浏览器的「现场直播 + 遥控」——canvas 绘观察页实时
    // 画面；人的点击/滚轮/键入经画布坐标换算回传宿主，派发到观察页（人与 agent 可
    // 各看各页，画面是否跟随 agent 由宿主侧 follow 开关决定）。面板常驻挂在右侧
    // 标签页容器：WS 一直在，顺带充当「agent 导航自动切到浏览器标签」的事件源；
    // 标签存在性由 browserOpen 控制，关标签即卸载（WS 断=事件源消失=不再自动打开）。
    // 生命周期：关标签仅停流不关浏览器（空闲 10 分钟自动优雅关，登录态保留在
    // 专用 profile，重开无损）。

    function BrowserEntry() {
      const ui = useKitUi();
      const on = ui.browserOpen && ui.dockTab === "browser" && ui.dockCollapsed !== true;
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": on,
        title: t("browserTitle"),
        onClick: () => {
          // 标签页语义：确保浏览器标签存在并激活（不清别的标签）；已是激活标签则
          // 关掉。手动点开=解除自动打开抑制 + 取消收起态。
          autoOpenSuppressed = false;
          if (on) setKitUi(closeDockTab(kitUi, "browser"));
          else setKitUi({ browserOpen: true, dockTab: "browser", dockCollapsed: false });
        },
        children: jsxRuntime.jsx(BrowserIcon, {}),
      });
    }

    function BrowserPanel({ active }) {
      const [state, setState] = react.useState({ running: false, launching: false, pages: [], activeId: null, viewId: null });
      const [draft, setDraft] = react.useState("");
      const [visible, setVisible] = react.useState(document.visibilityState === "visible");
      const [connLost, setConnLost] = react.useState(false);
      const canvasRef = react.useRef(null);
      const imeRef = react.useRef(null); // 透明输入：IME 组合事件宿主（canvas 不可编辑，组合起不来）
      const wsRef = react.useRef(null);
      const frameRef = react.useRef(null); // 最新帧（绘制去抖：只画最新）
      const rafRef = react.useRef(0);
      const moveRef = react.useRef(0); // 输入节流（~30/s）
      const downRef = react.useRef(null); // 双击判定（时间+距离窗）
      // watch 门控与事件回调里要读「最新」的激活/可见态，走 ref（闭包会停在创建帧）
      const activeRef = react.useRef(active);
      activeRef.current = active;
      const visibleRef = react.useRef(visible);
      visibleRef.current = visible;

      // 观察页（页签条/URL 栏数据源；URL 栏与导航按钮都作用于它）
      const viewPage = (state.pages ?? []).find((p) => p.viewed) ?? null;
      const viewUrl = viewPage?.url ?? "";
      const live = state.running === true;

      // 让位布局（body 类/宽度/拖拽）由右侧标签页容器统一负责，本组件只管内容。

      // agent 导航 → 自动切到浏览器标签（恒定行为，无开关，用户定稿：浏览器就该
      // 与 agent 同步）。唯一的人为控制：手动切走/收起后本轮不再拽回（点回浏览器
      // 标签或浏览器入口解除）。抑制只在「标签存在但没激活」时生效——标签关掉
      // 面板即卸载，WS 断了事件源也断，重开后天然解除。
      const maybeAutoOpen = () => {
        if (autoOpenSuppressed || kitUi.dockTab === "browser") return;
        setKitUi({ browserOpen: true, dockTab: "browser", dockCollapsed: false });
      };

      // 帧绘制：base64 jpeg → Image 解码 → canvas（尺寸随帧更新，宽 100% 等比）
      const drawFrame = react.useCallback((data) => {
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${data}`;
      }, []);

      // WS 生命周期：挂载连接 + 断线重连（2.5s）；watch 跟随「实时画面模式 + 页面可见」
      react.useEffect(() => {
        let disposed = false;
        let retry = null;
        const connect = () => {
          const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/dsh-kit/browser`);
          wsRef.current = ws;
          ws.onopen = () => {
            if (disposed) return;
            setConnLost(false);
            sendWatch(); // 首连补发：effect 里那次检查时握手未完成，会被 readyState 挡掉
          };
          ws.onmessage = (e) => {
            let msg;
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (!msg || typeof msg !== "object") return;
            if (msg.t === "state") {
              setState((prev) => ({ ...prev, ...msg }));
              return;
            }
            if (msg.t === "frame" && typeof msg.data === "string") {
              frameRef.current = msg.data;
              if (!rafRef.current) {
                rafRef.current = window.requestAnimationFrame(() => {
                  rafRef.current = 0;
                  const data = frameRef.current;
                  frameRef.current = null;
                  if (data) drawFrame(data);
                });
              }
              return;
            }
            if (msg.t === "event") {
              if (msg.kind === "navigated" && typeof msg.url === "string") {
                setState((prev) => {
                  const pages = (prev.pages ?? []).map((p) =>
                    p.tabId === msg.tabId ? { ...p, url: msg.url, title: msg.title ?? p.title } : p,
                  );
                  return { ...prev, pages, running: true };
                });
                maybeAutoOpen();
                return;
              }
              if (msg.kind === "crashed" || msg.kind === "closed") {
                setState((prev) => ({ ...prev, running: msg.kind === "closed" ? false : prev.running }));
                return;
              }
              if (msg.kind === "error" && typeof msg.message === "string") {
                flashToast(msg.message);
              }
            }
          };
          ws.onclose = () => {
            if (disposed) return;
            setConnLost(true);
            setState((prev) => ({ ...prev, running: false }));
            retry = window.setTimeout(connect, 2500);
          };
          ws.onerror = () => {};
        };
        connect();
        return () => {
          disposed = true;
          if (retry !== null) window.clearTimeout(retry);
          try {
            wsRef.current?.close();
          } catch {
            // 已断
          }
        };
      }, [drawFrame]);

      // watch 开关：「浏览器标签激活 + 页面可见」才要帧（切走/隐藏即停流，回来自动
      // 续）；WS 本身保持连接（自动打开的事件源）。onopen 另有补发——首次连接建立
      // 时本 effect 已跑过（握手未完成被 readyState 挡掉），不补发首连收不到帧。
      const sendWatch = () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== 1) return;
        try {
          ws.send(JSON.stringify({ t: "watch", on: visibleRef.current === true && activeRef.current === true }));
        } catch {
          // 已断
        }
      };
      react.useEffect(() => {
        sendWatch();
      }, [visible, active, connLost]);
      react.useEffect(() => {
        const onVis = () => {
          // 事件回调先于重渲染：先同步 ref 再发，避免 watch 带着过期的可见态
          const vis = document.visibilityState === "visible";
          visibleRef.current = vis;
          setVisible(vis);
          sendWatch();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
      }, []);

      // ── 人机共驾：画布输入 → 页面坐标 → 宿主派发（仅运行中；未运行不误拉起）──
      const sendInput = (obj) => {
        try {
          wsRef.current?.send(JSON.stringify(obj));
        } catch {
          // 已断：丢帧无害（下一帧画面自校正）
        }
      };
      const pagePoint = (e) => {
        const c = canvasRef.current;
        if (!c) return null;
        const rect = c.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || !c.width || !c.height) return null;
        const x = ((e.clientX - rect.left) * c.width) / rect.width;
        const y = ((e.clientY - rect.top) * c.height) / rect.height;
        return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
      };
      const onCanvasPointerDown = (e) => {
        if (!live) return;
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        e.preventDefault();
        try {
          canvasRef.current?.setPointerCapture?.(e.pointerId);
        } catch {
          // 捕获失败不影响转发
        }
        const p = pagePoint(e);
        if (!p) return;
        const now = Date.now();
        const dbl =
          downRef.current !== null &&
          now - downRef.current.t < 350 &&
          Math.abs(p.x - downRef.current.x) < 12 &&
          Math.abs(p.y - downRef.current.y) < 12;
        downRef.current = { t: now, x: p.x, y: p.y };
        sendInput({ t: "input", kind: "mousedown", x: p.x, y: p.y, button: e.button, clicks: dbl ? 2 : 1 });
        // 键入目标：透明输入钉在按下点并接管焦点——它的组合事件（中文输入法）
        // 与 keydown（英文逐键/快捷键）两条路都从这里出去
        const ime = imeRef.current;
        if (ime) {
          ime.style.left = `${e.clientX}px`;
          ime.style.top = `${e.clientY}px`;
          try {
            ime.focus({ preventScroll: true });
          } catch {
            ime.focus();
          }
        }
      };
      const onCanvasPointerMove = (e) => {
        if (!live) return;
        const now = performance.now();
        if (now - moveRef.current < 33) return; // ~30/s 节流（悬停 + 拖拽共用）
        moveRef.current = now;
        const p = pagePoint(e);
        if (!p) return;
        sendInput({ t: "input", kind: "mousemove", x: p.x, y: p.y });
      };
      const onCanvasPointerUp = (e) => {
        if (!live) return;
        const p = pagePoint(e);
        if (!p) return;
        sendInput({ t: "input", kind: "mouseup", x: p.x, y: p.y, button: e.button });
      };
      const onCanvasWheel = (e) => {
        if (!live) return;
        e.preventDefault(); // 画面滚动交给远端页面，不滚面板
        sendInput({ t: "input", kind: "wheel", dx: e.deltaX, dy: e.deltaY });
      };
      const onCanvasKeyDown = (e) => {
        if (!live) return;
        // IME 组合中的 keydown（key=Process / keyCode 229）合成不出任何字，跳过；
        // 组合文本由透明输入的 compositionend → kind:'text' 整段出
        if (e.isComposing === true || e.keyCode === 229) return;
        // 纯修饰键不单独转发（并入下一个键的组合串）
        if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
        e.preventDefault(); // 焦点留在画布，Tab 等也透传给页面
        const parts = [];
        if (e.ctrlKey) parts.push("Control");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Meta");
        parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
        sendInput({ t: "input", kind: "key", combo: parts.join("+") });
      };

      const go = (raw) => {
        const text = String(raw ?? "").trim();
        if (text === "") return;
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
        setDraft(withScheme);
        // 先本地反馈（宿主 navigated 事件随后校正）；humanOpen 作用于观察页
        setState((prev) => ({
          ...prev,
          running: true,
          pages: (prev.pages ?? []).map((p) => (p.viewed ? { ...p, url: withScheme, title: "" } : p)),
        }));
        try {
          wsRef.current?.send(JSON.stringify({ t: "open", url: withScheme }));
        } catch {
          // 连接断开时忽略（重连后用户可再按）
        }
      };

      // URL 栏跟随观察页：切页签/导航事件（宿主侧校正）都把地址栏对到观察页
      react.useEffect(() => {
        setDraft(viewUrl);
      }, [viewPage?.tabId, viewUrl]);

      const tabLabel = (p) => {
        if (typeof p.title === "string" && p.title.trim() !== "") return p.title;
        try {
          return new URL(p.url).host || p.url;
        } catch {
          return p.url || `#${p.tabId}`;
        }
      };

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          // 页签条：高亮=观察页；●=agent 正在此页操作；× 关页签；＋ 新页签
          jsxRuntime.jsx("div", {
            className: "dshk-brw-tabrow",
            children: jsxRuntime.jsxs("span", {
              className: "dshk-tabs",
              children: [
                (state.pages ?? []).map((p) =>
                  jsxRuntime.jsxs("span", {
                    className: `dshk-tab${p.viewed ? " dshk-tab-on" : ""}`,
                    title: `${p.url}${p.active ? ` · ${t("browserAgentPage")}` : ""}`,
                    onClick: () => sendInput({ t: "activate", tabId: p.tabId }),
                    children: [
                      p.active ? jsxRuntime.jsx("span", { className: "dshk-tab-dot", title: t("browserAgentPage") }) : null,
                      jsxRuntime.jsx("span", { className: "dshk-tab-label", children: tabLabel(p) }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dshk-tab-x",
                        "aria-label": t("browserCloseTab"),
                        title: t("browserCloseTab"),
                        onClick: (e) => {
                          e.stopPropagation();
                          sendInput({ t: "closeTab", tabId: p.tabId });
                        },
                        children: "✕",
                      }),
                    ],
                  }, p.tabId),
                ),
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "dshk-tab dshk-brw-newtab",
                  title: t("browserNewTab"),
                  "aria-label": t("browserNewTab"),
                  onClick: () => sendInput({ t: "newTab" }),
                  children: "＋",
                }),
              ],
            }),
          }),
          // URL 栏 + 前进/后退/刷新（都作用于观察页）
          jsxRuntime.jsxs("form", {
            className: "dshk-brw-bar",
            onSubmit: (e) => {
              e.preventDefault();
              go(draft);
            },
            children: [
              jsxRuntime.jsx("button", { type: "button", className: "dshk-jobs-btn dshk-brw-nav", title: t("browserBack"), "aria-label": t("browserBack"), disabled: !live, onClick: () => sendInput({ t: "nav", op: "back" }), children: "◀" }),
              jsxRuntime.jsx("button", { type: "button", className: "dshk-jobs-btn dshk-brw-nav", title: t("browserForward"), "aria-label": t("browserForward"), disabled: !live, onClick: () => sendInput({ t: "nav", op: "forward" }), children: "▶" }),
              jsxRuntime.jsx("button", { type: "button", className: "dshk-jobs-btn dshk-brw-nav", title: t("browserReload"), "aria-label": t("browserReload"), disabled: !live, onClick: () => sendInput({ t: "nav", op: "reload" }), children: "⟳" }),
              jsxRuntime.jsx("input", {
                className: "dshk-brw-url",
                value: draft,
                placeholder: t("browserUrlPh"),
                onChange: (e) => setDraft(e.target.value),
                spellCheck: false,
              }),
              jsxRuntime.jsx("button", { type: "submit", className: "dshk-jobs-btn", children: t("browserGo") }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-brw-body",
            children: jsxRuntime.jsx("canvas", {
              className: "dshk-brw-canvas",
              ref: canvasRef,
              tabIndex: 0,
              onPointerDown: onCanvasPointerDown,
              onPointerMove: onCanvasPointerMove,
              onPointerUp: onCanvasPointerUp,
              onWheel: onCanvasWheel,
              onKeyDown: onCanvasKeyDown,
              onContextMenu: (e) => e.preventDefault(), // 右键菜单交给远端页面
            }),
          }),
          // 透明输入：IME 组合事件宿主（画布不可编辑，中文组合事件起不来）。
          // 点击画布后焦点在此（见 onCanvasPointerDown）——keydown 必须也挂它，
          // 否则英文逐键/快捷键的 keydown 冒泡不到处理器（键盘输入全断的根因）。
          // 组合中 value 只累积不发送；compositionend 把提交文本整段发宿主
          // （kind:'text' → 远端 keyboard.insertText）。非组合的 input（英文
          // 逐键已被 keydown preventDefault 拦下，不入 value）只清 value 不发，
          // 防残字混入下次组合。
          jsxRuntime.jsx("input", {
            ref: imeRef,
            className: "dshk-brw-ime",
            autoComplete: "off",
            tabIndex: -1,
            onKeyDown: onCanvasKeyDown,
            onInput: (e) => {
              const el = e.currentTarget;
              if (el.dataset.composing === "1" || e.isComposing === true) return;
              el.value = "";
            },
            onCompositionStart: (e) => {
              e.currentTarget.dataset.composing = "1";
            },
            onCompositionEnd: (e) => {
              const el = e.currentTarget;
              el.dataset.composing = "0";
              const text = typeof e.data === "string" && e.data !== "" ? e.data : el.value;
              el.value = "";
              if (text !== "") sendInput({ t: "input", kind: "text", text });
            },
          }),
          connLost
            ? jsxRuntime.jsx("div", { className: "dshk-brw-note", children: t("browserReconnect") })
            : state.running === false && state.launching === true
              ? jsxRuntime.jsx("div", { className: "dshk-brw-note", children: t("browserStarting") })
              : state.running === false && viewUrl === ""
                ? jsxRuntime.jsx("div", { className: "dshk-brw-note", children: t("browserNotRunning") })
                : null,
        ],
      });
    }

    // ─────────── 右侧标签页容器（预览 / 任务 / 浏览器共存切换）───────────
    // ZCode 式布局：三个面板共居一个右坞，标签存在性（previews/jobsOpen/
    // browserOpen）与激活位（dockTab）分离；打开某功能=确保标签存在并激活，
    // 互斥清场废除——切到浏览器看 agent 干活，文件预览的滚动位置还在。非激活
    // 标签 display:none 保持挂载（切回不丢状态）；让位 body 类/宽度/拖拽由容器
    // 统一持有（原三面板各自的壳已拆除）。宽度是三标签共享单值，界限必须同一：
    // 用户定稿 2026-09-05——曾按标签各定界限，jobs 上限窄一档，切过去面板被
    // 夹窄与预览/浏览器不一致；现三标签同一界限，切标签绝不改宽。tab 参数仅为
    // render-check 逐一比对防回归保留。下限取三者最大需求（浏览器画布 480）。
    const DOCK_TABS = ["preview", "jobs", "browser"];
    function dockBounds(tab) {
      return { min: 480, max: Math.min(960, Math.max(560, window.innerWidth - 820)) };
    }
    /** 最小化状态的右缘竖条：一枚可点的小按钮，点击展开面板（标题=当前激活大标签，
     *  多文件预览带计数）。存在性状态全部保留，这只是"暂时挪到边上"。 */
    function DockStub() {
      const ui = useKitUi();
      let label = t("dockPreview");
      if (ui.dockTab === "jobs" && ui.jobsOpen) label = t("dockJobs");
      else if (ui.dockTab === "browser" && ui.browserOpen) label = t("dockBrowser");
      else if ((ui.previews?.length ?? 0) > 1) label = `${t("dockPreview")} (${ui.previews.length})`;
      return jsxRuntime.jsx("button", {
        type: "button",
        className: "dshk-dock-stub",
        title: t("dockRestore"),
        "aria-label": t("dockRestore"),
        onClick: () => setKitUi({ dockCollapsed: false }),
        children: label,
      });
    }

    function RightDock({ props, cwd }) {
      const ui = useKitUi();
      // 激活位必须指向「仍存在」的标签：dockTab 失效（配置门控清场等）时落回
      // 第一个存在的标签，避免渲染出没有内容的空容器
      const previewCount = ui.previews?.length ?? 0;
      const exists = { preview: previewCount > 0, jobs: ui.jobsOpen === true, browser: ui.browserOpen === true };
      const tab = ui.dockTab && exists[ui.dockTab]
        ? ui.dockTab
        : exists.preview
          ? "preview"
          : exists.jobs
            ? "jobs"
            : exists.browser
              ? "browser"
              : null;
      const widthRef = react.useRef(0);
      const dragRef = react.useRef(null);
      const [dragging, setDragging] = react.useState(false);

      // 让位类跟随容器存在；宽度初始/切标签时对齐激活标签的界限
      react.useLayoutEffect(() => {
        document.body.classList.add("dshk-pane-open");
        const b = dockBounds(tab);
        const w = Math.min(b.max, Math.max(b.min, widthRef.current > 0 ? widthRef.current : Math.min(720, window.innerWidth - 880)));
        widthRef.current = w;
        document.documentElement.style.setProperty("--dshk-pane-w", `${w}px`);
        return () => {
          document.body.classList.remove("dshk-pane-open");
          document.documentElement.style.removeProperty("--dshk-pane-w");
        };
      }, [tab]);
      react.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          const b = dockBounds(tab);
          const w = Math.min(b.max, Math.max(b.min, d.startW + (d.startX - e.clientX)));
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
      }, [dragging, tab]);
      const onHandleDown = (e) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startW: widthRef.current > 0 ? widthRef.current : 560 };
        setDragging(true);
      };

      const tabDefs = [];
      if (previewCount > 0) {
        tabDefs.push({ id: "preview", label: previewCount > 1 ? `${t("dockPreview")} (${previewCount})` : t("dockPreview") });
      }
      if (ui.jobsOpen) tabDefs.push({ id: "jobs", label: t("dockJobs") });
      if (ui.browserOpen) tabDefs.push({ id: "browser", label: t("dockBrowser") });
      const switchTab = (id) => {
        // 人为离开浏览器标签 → 抑制自动拽回；点回浏览器标签 → 解除
        if (kitUi.dockTab === "browser" && id !== "browser") autoOpenSuppressed = true;
        if (id === "browser") autoOpenSuppressed = false;
        setKitUi({ dockTab: id });
      };
      const closeTab = (id) => {
        if (id === "browser") autoOpenSuppressed = false; // 关标签=面板卸载，重开自然解除
        setKitUi(closeDockTab(kitUi, id));
      };

      return jsxRuntime.jsxs("div", {
        className: "dshk-pane",
        "data-dragging": dragging || undefined,
        role: "dialog",
        "aria-label": ({ preview: t("dockPreview"), jobs: t("dockJobs"), browser: t("dockBrowser") })[tab] ?? "",
        children: [
          jsxRuntime.jsx("div", { className: "dshk-pane-handle", onPointerDown: onHandleDown }),
          jsxRuntime.jsxs("div", {
            className: "dshk-jobs-head",
            children: [
              jsxRuntime.jsx("span", {
                className: "dshk-tabs",
                children: tabDefs.map((d) =>
                  jsxRuntime.jsxs("span", {
                    className: `dshk-tab${d.id === tab ? " dshk-tab-on" : ""}`,
                    onClick: () => switchTab(d.id),
                    children: [
                      jsxRuntime.jsx("span", { className: "dshk-tab-label", children: d.label }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dshk-tab-x",
                        "aria-label": t("dockClose"),
                        title: t("dockClose"),
                        onClick: (e) => {
                          e.stopPropagation();
                          closeTab(d.id);
                        },
                        children: "✕",
                      }),
                    ],
                  }, d.id),
                ),
              }),
              // 快捷控制：全部关闭 + 暂时收起（存在性保留，入口按钮恢复）
              jsxRuntime.jsxs("span", {
                className: "dshk-jobs-headside",
                children: [
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-jobs-close",
                    "aria-label": t("dockCloseAll"),
                    title: t("dockCloseAll"),
                    onClick: () => setKitUi({ previews: [], activePreview: null, jobsOpen: false, browserOpen: false, dockTab: null }),
                    children: "✕",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-jobs-close",
                    "aria-label": t("dockMinimize"),
                    title: t("dockMinimize"),
                    onClick: () => {
                      // 最小化 = 人为退出：浏览器标签若存在，agent 导航不再拽回
                      autoOpenSuppressed = true;
                      setKitUi({ dockCollapsed: true });
                    },
                    children: "»",
                  }),
                ],
              }),
            ],
          }),
          // 预览大标签：文件小标签条（二级标签，>1 个文件才显示）+ 多实例内容
          // （非激活文件 display:none 保挂载——切回滚动位置/编辑草稿不丢）
          jsxRuntime.jsxs("div", {
            className: "dshk-pane-view",
            style: { display: tab === "preview" ? "flex" : "none" },
            children: [
              previewCount > 1
                ? jsxRuntime.jsx("div", {
                    className: "dshk-pv-tabrow",
                    children: jsxRuntime.jsx("span", {
                      className: "dshk-tabs",
                      children: (ui.previews ?? []).map((pv) =>
                        jsxRuntime.jsxs("span", {
                          className: `dshk-tab${pv.path === ui.activePreview ? " dshk-tab-on" : ""}`,
                          title: pv.path,
                          onClick: () => setKitUi(openPreviewTab(kitUi, pv.path, pv.from, pv.untracked)),
                          children: [
                            jsxRuntime.jsx("span", { className: "dshk-tab-label", children: pv.path.split(/[\\/]/).pop() || pv.path }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "dshk-tab-x",
                              "aria-label": t("pvCloseTab"),
                              title: t("pvCloseTab"),
                              onClick: (e) => {
                                e.stopPropagation();
                                setKitUi(closePreviewTab(kitUi, pv.path));
                              },
                              children: "✕",
                            }),
                          ],
                        }, pv.path),
                      ),
                    }),
                  })
                : null,
              (ui.previews ?? []).map((pv) =>
                jsxRuntime.jsx("div", {
                  className: "dshk-pane-view",
                  style: { display: pv.path === ui.activePreview ? "flex" : "none" },
                  children: jsxRuntime.jsx(FileContentPane, {
                    key: pv.path,
                    path: pv.path,
                    source: pv.from ?? "tree",
                    untracked: pv.untracked === true,
                    deleted: pv.deleted === true,
                    cwd,
                    onOpenFile: (p, untracked) => setKitUi(openPreviewTab(kitUi, p, "md-link", untracked === true)),
                  }),
                }, pv.path),
              ),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-pane-view",
            style: { display: tab === "jobs" ? "flex" : "none" },
            children: ui.jobsOpen ? jsxRuntime.jsx(JobsPanel, { ...props }) : null,
          }),
          jsxRuntime.jsx("div", {
            className: "dshk-pane-view",
            style: { display: tab === "browser" ? "flex" : "none" },
            children: ui.browserOpen ? jsxRuntime.jsx(BrowserPanel, { active: tab === "browser" }) : null,
          }),
        ],
      });
    }

    // ─────────── 面板宿主（shell.overlay 全帧浮层）───────────
    // 终端停靠面板与文件预览面板在这里渲染（fixed 定位不受 composer 祖先
    // stacking context 影响）；文件树的 sidebar.workspaces 动态注册、让位 body 类、
    // 快捷键监听全部挂在这个常驻根组件里。
    function KitSurfaces(props) {
      react.useSyncExternalStore(subscribeLocale, getLocaleVersion); // 跟随 DSH 语言切换重绘
      const cwd = useCurrentCwd(props);
      const ui = useKitUi();
      const snap = react.useSyncExternalStore(subscribeCfg, getCfgSnapshot);
      const cfg = cfgFromSnapshot(snap);
      // 对话文件点击接管状态：面板门控（预览可用）与当前会话 cwd 每次渲染同步，
      // 供模块级 capture 拦截器读取。ready=false（默认）时拦截器完全不介入。
      chatPreviewHook = {
        ready: cfg.chatOpenFilePreview === true && (cfg.fileTreeEnabled || cfg.sourceControlEnabled),
        cwd,
        openPreview: (p) => setKitUi(openPreviewTab(kitUi, p, "chat", false)),
      };

      // 卸载时清空模块级接管状态，避免拦截器持有失效闭包
      react.useEffect(() => () => { chatPreviewHook = null; }, []);

      // 座位门控：按配置动态注册/注销输入框入口与技能页（设置卡本体不受门控，
      // 否则关掉就再也打不开）。快照未就绪按默认全开处理，首个 ready 快照到达后
      // 本效果自动重跑纠正。
      react.useEffect(() => {
        if (!slotsCtx) return undefined;
        const handles = [];
        const want = [
          // 输入框入口排序（左→右）：文件树、源代码管理、后台任务、终端；手机访问与
          // 技能页同类，走 settings.section 页面入口（order：技能 40 → 手机 45）
          ["filetree", cfg.fileTreeEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-filetree", order: 10 }, FileTreeEntry)],
          ["scm", cfg.sourceControlEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-scm", order: 11 }, ScmEntry)],
          ["jobs", cfg.jobsEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-jobs", order: 12 }, JobsEntry)],
          ["browser", cfg.browserEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-browser", order: 14 }, BrowserEntry)],
          ["terminal", cfg.terminalEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-terminal", order: 13 }, TerminalEntry)],
          ["skills", cfg.skillsPageEnabled, () =>
            slotsCtx.slots.register(
              { name: "settings.section", id: "kit-skills", order: 40, label: () => t("skillsLabel") },
              SkillsManager,
            )],
          ["phone", cfg.phoneEnabled, () =>
            slotsCtx.slots.register(
              { name: "settings.section", id: "kit-phone", order: 45, label: () => t("phoneTitle") },
              PhoneSection,
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
      }, [cfg.phoneEnabled, cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.sourceControlEnabled, cfg.skillsPageEnabled, cfg.jobsEnabled, cfg.browserEnabled]);

      // 配置关闭但视图还开着（如设置卡保存瞬间）：立即归位，预览随来源跟随清掉；
      // 终端功能关闭 = 结束全部终端会话（连 WS 杀 pty，与单终端时代语义一致）
      react.useEffect(() => {
        if (!cfg.terminalEnabled && (ui.termDockOpen || ui.terminals.length > 0)) {
          setKitUi({ terminals: [], activeTermId: null, termDockOpen: false });
        }
        if (!cfg.fileTreeEnabled && ui.treeOpen) setKitUi({ treeOpen: false, previews: [], activePreview: null });
        if (!cfg.sourceControlEnabled && ui.gitOpen) setKitUi({ gitOpen: false, previews: [], activePreview: null });
        // 配置门控清场走 closeDockTab：清存在性的同时把激活位顺延到剩余标签
        if (!cfg.jobsEnabled && ui.jobsOpen) setKitUi(closeDockTab(kitUi, "jobs"));
        if (!cfg.browserEnabled && ui.browserOpen) setKitUi(closeDockTab(kitUi, "browser"));
      }, [cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.sourceControlEnabled, cfg.jobsEnabled, cfg.browserEnabled]);

      // 侧边栏浏览区占用：文件树与「更改」视图互斥共享 sidebar.workspaces 单槽
      // （gitOpen 时切换到更改页，✕ 关闭回到仍处打开状态的文件树）。
      // 动态注册若在运行时抛错，捕获并回滚开合状态，避免入口被错误边界退役。
      react.useEffect(() => {
        if (!slotsCtx || (!ui.treeOpen && !ui.gitOpen)) return undefined;
        let dispose;
        try {
          // 单槽遮蔽原生需要更低 priority（数字越小越先渲染，原生在 priority 0）。
          // owner 携带官方注入的 wide（侧边栏是否展开）：①宽态正常渲染面板；
          // ②收起态不渲染内容（用户定稿：收起不需要占位，也不把树/SCM 挤进铁轨）。
          dispose = slotsCtx.slots.register({ name: "sidebar.workspaces", priority: -1000 }, (owner) => {
            const side = owner ?? {};
            if (side.wide === false) return null;
            return ui.gitOpen
              ? jsxRuntime.jsx(GitChangesPanel, { cwd, onOpenFile: (p, untracked, deleted) => setKitUi(openPreviewTab(kitUi, p, "scm", untracked === true, deleted === true)), ...owner })
              : jsxRuntime.jsx(FileTreePanel, { cwd, onOpenFile: (p) => setKitUi(openPreviewTab(kitUi, p, "tree", false)), ...owner });
          });
        } catch (error) {
          console.error("[dsh-kit] 注册 sidebar.workspaces 面板失败：", error);
          setKitUi({ treeOpen: false, gitOpen: false, previews: [], activePreview: null });
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

      // 终端让位布局：坞可见时挂 body 类 + 设高度变量，样式规则顶起对话/详情列
      //（隐藏/无会话时不顶——后台会话继续跑但不占布局）
      react.useEffect(() => {
        if (ui.terminals.length === 0 || !ui.termDockOpen || !cfg.terminalEnabled) return undefined;
        document.documentElement.style.setProperty("--dshk-dock-h", DOCK_H);
        document.body.classList.add("dshk-open");
        return () => {
          document.body.classList.remove("dshk-open");
          document.documentElement.style.removeProperty("--dshk-dock-h");
        };
      }, [ui.termDockOpen, ui.terminals.length, cfg.terminalEnabled]);

      // 快捷键统一在此监听：组合键来自配置（默认 Ctrl+` / Ctrl+E，capture 拦截
      // 避免页面其它快捷键抢先），对应功能关闭时不响应；设置卡录制新键时让路。
      // Esc 分两层先关预览再关树（不拦截，避免挡掉其它 Esc 行为）。
      react.useEffect(() => {
        const termCombo = parseCombo(cfg.terminalShortcut);
        const treeCombo = parseCombo(cfg.fileTreeShortcut);
        const scCombo = parseCombo(cfg.scShortcut);
        const sidebarCombo = parseCombo(cfg.sidebarShortcut);
        const onKey = (e) => {
          if (shortcutCapture !== null) return;
          if (inlineEditCapture) return;
          if (termCombo && cfg.terminalEnabled && comboMatches(e, termCombo)) {
            e.preventDefault();
            e.stopPropagation();
            // 与入口按钮同语义：只开/关坞（隐藏不杀进程）；无会话时新建绑定当前 cwd
            setKitUi(toggleTermDock(kitUi, cwd));
            return;
          }
          if (treeCombo && cfg.fileTreeEnabled && comboMatches(e, treeCombo)) {
            e.preventDefault();
            e.stopPropagation();
            // Ctrl+E 只管文件树：非文件树态 → 打开（展开侧边栏）；已是 → 关闭回会话列表
            //（关闭保留文件预览）
            if (!kitUi.treeOpen) expandSidebarNow();
            setKitUi({ treeOpen: !kitUi.treeOpen, gitOpen: false });
            return;
          }
          if (scCombo && cfg.sourceControlEnabled && comboMatches(e, scCombo)) {
            e.preventDefault();
            e.stopPropagation();
            // 源代码管理同语义：非 SCM 态 → 打开（展开侧边栏）；已是 → 关闭回会话列表
            if (!kitUi.gitOpen) expandSidebarNow();
            setKitUi({ gitOpen: !kitUi.gitOpen, treeOpen: false });
            return;
          }
          if (sidebarCombo && cfg.sidebarShortcutEnabled !== false && comboMatches(e, sidebarCombo)) {
            e.preventDefault();
            e.stopPropagation();
            toggleSidebar();
            return;
          }
          if (e.key === "Escape") {
            // 右侧标签页容器：Esc 关当前激活标签（预览=关当前文件小标签；无激活位
            // 则关第一个存在的标签）；收起态不吞 Esc（面板本就不可见）
            if (dockAlive(kitUi) && kitUi.dockCollapsed !== true) {
              if (kitUi.dockTab === "preview" && kitUi.activePreview) {
                setKitUi(closePreviewTab(kitUi, kitUi.activePreview));
              } else {
                const tab = kitUi.dockTab ?? ((kitUi.previews?.length ?? 0) > 0 ? "preview" : kitUi.jobsOpen ? "jobs" : "browser");
                setKitUi(closeDockTab(kitUi, tab));
              }
            } else if (kitUi.gitOpen) setKitUi({ gitOpen: false });
            else if (kitUi.treeOpen) setKitUi({ treeOpen: false });
            else if (kitUi.termDockOpen) setKitUi({ termDockOpen: false }); // 只隐藏，不杀会话
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // cwd 必须在依赖里：否则闭包缓存首帧（会话未水化时为 null）的工作区，
        // 之后按快捷键开终端永远绑到 null
      }, [cwd, cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.terminalShortcut, cfg.fileTreeShortcut, cfg.scShortcut, cfg.sidebarShortcut, cfg.sidebarShortcutEnabled]);

      return jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          cfg.terminalEnabled && ui.terminals.length > 0
            ? jsxRuntime.jsx(TerminalDock, {
                open: ui.termDockOpen,
                cwd,
                onSpawn: () => {
                  if (!cwd) {
                    flashToast(t("noCwd"));
                    return;
                  }
                  setKitUi(spawnTerm(kitUi, cwd));
                },
                onHide: () => setKitUi({ termDockOpen: false }),
                onActivate: (id) => setKitUi({ activeTermId: id, termDockOpen: true }),
                onKill: (id) => setKitUi(killTerm(kitUi, id)),
                onKillAll: () => setKitUi({ terminals: [], activeTermId: null, termDockOpen: false }),
              })
            : null,
          // 右侧标签页容器：预览/任务/浏览器共存切换；最小化时隐藏容器、右缘留
          // 一枚竖条（DockStub）点击展开——最小化不卸载状态，入口按钮同样可恢复
          dockAlive(ui)
            ? ui.dockCollapsed === true
              ? jsxRuntime.jsx(DockStub, {})
              : jsxRuntime.jsx(RightDock, { props, cwd })
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
    // 未知 id 一律回退齿轮。没有注册缝，这里按标签文字找到对应行，把行内第一个
    // svg 换成自绘分层图标——纯外观增强：任何一步失败都静默保持齿轮。
    const SVG_OPEN =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    const NAV_ICON_HTML = [
      {
        label: () => t("skillsLabel"),
        attr: "data-dshk-skill",
        html:
          SVG_OPEN +
          '<path d="M8 1.8 14.2 5 8 8.2 1.8 5z"/>' +
          '<path d="M1.8 8.1 8 11.2l6.2-3.1"/>' +
          '<path d="M1.8 11.3 8 14.4l6.2-3.1"/>' +
          "</svg>",
      },
      {
        label: () => t("phoneTitle"),
        attr: "data-dshk-phone",
        html:
          SVG_OPEN +
          '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/>' +
          '<path d="M6.8 3.4h2.4"/>' +
          '<path d="M8 12.6h.01"/>' +
          "</svg>",
      },
    ];

    let iconSwapPending = false;
    function swapKitNavIcons() {
      try {
        const rows = document.querySelectorAll('[role="dialog"][aria-modal="true"] nav button');
        if (rows.length === 0) return;
        for (const row of rows) {
          const span = row.querySelector("span");
          if (!span) continue;
          const entry = NAV_ICON_HTML.find((candidate) => span.textContent === candidate.label());
          if (!entry) continue;
          const current = row.querySelector("svg");
          if (!current || current.getAttribute(entry.attr) === "1") continue;
          const holder = document.createElement("span");
          holder.innerHTML = entry.html;
          const icon = holder.firstElementChild;
          if (!icon) continue;
          icon.setAttribute(entry.attr, "1");
          current.replaceWith(icon);
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
        swapKitNavIcons();
        window.setTimeout(swapKitNavIcons, 250); // React 重渲染后的二次补换
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

    // ─────────── 插件设置卡（settings.plugin.item）───────────
    // 交互规范照官方 CardForm（同 dsh-memory 卡片）：编辑只暂存草稿、保存才写；
    // "已覆盖" = raw user 层含该键；恢复默认暂存 base 值（保存时 unset 回落默认）。
    // 写入后回读 user 层验证落盘（Host 是唯一权威，scope.set 失败静默回滚重读）。
    // 快捷键字段是捕获控件：点「修改」进录制态，下一个含非修饰主键的 keydown 即为
    // 新组合键；录制期模块级 shortcutCapture 置位，KitSurfaces 面板快捷键让路。
    const CFG_FIELDS = [
      { key: "terminalEnabled", kind: "bool" },
      { key: "fileTreeEnabled", kind: "bool" },
      { key: "previewMaxTabs", kind: "number", max: 20 },
      { key: "sourceControlEnabled", kind: "bool" },
      { key: "chatOpenFilePreview", kind: "bool" },
      { key: "skillsPageEnabled", kind: "bool" },
      { key: "searchEnabled", kind: "bool" },
      { key: "searchMaxResults", kind: "number" },
      { key: "phoneEnabled", kind: "bool" },
      { key: "phoneKeepGatewayOn", kind: "bool" },
      { key: "jobsEnabled", kind: "bool" },
      { key: "browserEnabled", kind: "bool" },
      { key: "sidebarShortcutEnabled", kind: "bool" },
      { key: "terminalShortcut", kind: "combo" },
      { key: "fileTreeShortcut", kind: "combo" },
      { key: "scShortcut", kind: "combo" },
      { key: "sidebarShortcut", kind: "combo" },
    ];
    // 分组渲染：开关行 + 该功能启用时才显示的子配置（所见即所得，保存才落盘生效）
    // 组顺序：文件树 → 源代码管理 → 终端 → 技能页 → 网页搜索 → 手机访问（用户定稿
    // 放最下）。远程域名不在此卡——编辑入口在「手机访问」页面内（PhoneSection）。
    const CFG_GROUPS = [
      { switchKey: "sidebarShortcutEnabled", fields: ["sidebarShortcut"] },
      { switchKey: "fileTreeEnabled", fields: ["fileTreeShortcut", "previewMaxTabs"] },
      { switchKey: "chatOpenFilePreview", fields: [] },
      { switchKey: "sourceControlEnabled", fields: ["scShortcut"] },
      { switchKey: "jobsEnabled", fields: [] },
      { switchKey: "browserEnabled", fields: [] },
      { switchKey: "terminalEnabled", fields: ["terminalShortcut"] },
      { switchKey: "skillsPageEnabled", fields: [] },
      { switchKey: "searchEnabled", fields: ["searchMaxResults"] },
      { switchKey: "phoneEnabled", fields: ["phoneKeepGatewayOn"] },
    ];
    const cfgSpec = Object.fromEntries(CFG_FIELDS.map((f) => [f.key, f]));
    const cfgLabelKey = (field, suffix) =>
      `cfg${field[0].toUpperCase()}${field.slice(1)}${suffix}`;

    /** 字段显示文本：bool → "true"/"false"；number → 整数字符串；text/combo → 字符串（空回落内置默认） */
    function cfgFormat(field, value) {
      if (cfgSpec[field].kind === "bool") return value === false ? "false" : "true";
      if (cfgSpec[field].kind === "number") return String(Number.isFinite(value) ? value : CFG_DEFAULTS[field]);
      return typeof value === "string" && value.trim() !== "" ? value : CFG_DEFAULTS[field];
    }
    /** 草稿文本 → 写入计划；非法（数字越界/非整数、组合键缺主键/修饰键）返回 undefined 阻断保存 */
    function cfgParse(field, text) {
      if (cfgSpec[field].kind === "bool") return { kind: "set", value: text === "true" };
      if (cfgSpec[field].kind === "number") {
        const trimmed = String(text ?? "").trim();
        const n = Number(trimmed);
        const hi = cfgSpec[field].max ?? 8;
        return Number.isInteger(n) && n >= 1 && n <= hi ? { kind: "set", value: n } : undefined;
      }
      if (cfgSpec[field].kind === "text") return { kind: "set", value: String(text ?? "").trim() };
      const trimmed = String(text ?? "").trim();
      return parseCombo(trimmed) ? { kind: "set", value: trimmed } : undefined;
    }

    function KitConfigCard({ scope }) {
      react.useSyncExternalStore(subscribeLocale, getLocaleVersion); // 跟随 DSH 语言切换重绘
      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
      react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [open, setOpen] = react.useState(false);
      // 正在录制快捷键的字段；null = 非录制态（同一时间至多一个）
      const [capturing, setCapturing] = react.useState(null);
      // 非本机访问（手机/远程）时上游把设置镜像钉在本机，快照会永远停在 loading——
      // 数秒后仍未就绪且地址栏非回环，就把"读取中"换成明确的远程只读提示。
      const [stuckLoading, setStuckLoading] = react.useState(false);
      const offDevice =
        typeof location !== "undefined" && !["localhost", "127.0.0.1"].includes(location.hostname);
      react.useEffect(() => {
        if (snapshot.status !== "loading") {
          setStuckLoading(false);
          return undefined;
        }
        if (!offDevice) return undefined;
        const timer = setTimeout(() => setStuckLoading(true), 4000);
        return () => clearTimeout(timer);
      }, [snapshot.status, offDevice]);
      const loadingHint = stuckLoading && offDevice ? t("cfgRemoteHint") : t("loadingCfg");

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

        const renderField = (field, isSub) => {
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
              : spec.kind === "number"
                ? jsxRuntime.jsx("input", {
                    type: "number",
                    className: "dshk-cfg-text dshk-cfg-num",
                    min: 1,
                    max: 8,
                    step: 1,
                    value: state.text,
                    disabled: !writable,
                    onChange: (e) => edit(field, e.target.value),
                  })
                : spec.kind === "text"
                ? jsxRuntime.jsx("input", {
                    type: "text",
                    className: "dshk-cfg-text",
                    value: state.text,
                    placeholder: "dsh.example.com",
                    spellCheck: false,
                    disabled: !writable,
                    onChange: (e) => edit(field, e.target.value),
                  })
                : jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-cfg-combo",
                    "data-capturing": capturing === field || undefined,
                    disabled: !writable,
                    onClick: () => startCapture(field),
                    children: capturing === field ? t("cfgCapturing") : state.text,
                  });
          // 紧凑单行（用户定稿）：勾选框在标题前，其余控件跟在标题后，短说明
          // 占据剩余宽度（超长省略号 + 悬停看全），覆盖徽标恒右对齐；组合键
          // 字段无说明——按钮文本即当前值，非法时原位显示错误
          const hintEl = state.invalid
            ? jsxRuntime.jsx("span", {
                className: "dshk-cfg-invalid",
                children: t(spec.kind === "number" ? "invalidNumber" : "invalidCombo"),
              })
            : spec.kind === "combo"
              ? null
              : jsxRuntime.jsx("span", {
                  className: "dshk-cfg-hint",
                  title: t(cfgLabelKey(field, "Hint")),
                  children: t(cfgLabelKey(field, "Hint")),
                });
          return jsxRuntime.jsxs("div", {
            className: isSub ? "dshk-cfg-field dshk-cfg-sub" : "dshk-cfg-field",
            children: [
              spec.kind === "bool" ? control : null,
              jsxRuntime.jsx("span", { className: "dshk-cfg-label", children: t(cfgLabelKey(field, "")) }),
              spec.kind === "bool" ? null : control,
              hintEl,
              badges(state, field),
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
                    loading ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: loadingHint }) : null,
                    !loading && !available
                      ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: t("readOnly") })
                      : null,
                    available && !writable
                      ? jsxRuntime.jsx("p", { className: "dshk-cfg-status", role: "status", children: t("readOnly") })
                      : null,
                    available
                      ? CFG_GROUPS.map((group) => {
                          // 勾选启用才展开该功能的子配置（草稿态即时显隐，保存落盘生效）
                          const on = fieldState(group.switchKey).text === "true";
                          return jsxRuntime.jsxs(
                            "div",
                            {
                              className: "dshk-cfg-group",
                              children: [
                                renderField(group.switchKey),
                                on ? group.fields.map((f) => renderField(f, true)) : null,
                              ],
                            },
                            group.switchKey,
                          );
                        })
                      : null,
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
      // 已按 ctx.settings.installSection 注册 dsh-kit）。绑定失败（老宿主缺 settingsScope）
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
      // 对话文件点击接管（默认关闭：设置卡 chatOpenFilePreview 开启才生效）
      document.addEventListener("click", onChatOpenFileClick, true);
    }

    exports.inject = ["slots", "settingsScope"];
    exports.apply = apply;
    return module.exports;
  },
});
