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
    let kitUi = { treeOpen: false, gitOpen: false, openFile: null, openFrom: null, terminals: [], activeTermId: null, termDockOpen: false, jobsOpen: false };
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
      skillsPageEnabled: true,
      searchEnabled: true,
      searchMaxResults: 5,
      phoneEnabled: false,
      phoneRemoteDomain: "",
      phonePort: 3090,
      phoneKeepGatewayOn: false,
      jobsEnabled: true,
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
        skillsPageEnabled: v.skillsPageEnabled !== false,
        searchEnabled: v.searchEnabled !== false,
        phoneEnabled: v.phoneEnabled === true,
        phoneRemoteDomain: typeof v.phoneRemoteDomain === "string" ? v.phoneRemoteDomain : "",
        jobsEnabled: v.jobsEnabled !== false,
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
      treeRename: "重命名",
      treeDelete: "删除",
      treeCopyAbs: "复制绝对路径",
      treeCopyRel: "复制相对路径",
      treeCopied: "已复制路径",
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
      cfgDesc: "终端 / 文件树 / 技能页 / 网页搜索的功能开关与快捷键。",
      cfgTerminalEnabled: "启用终端",
      cfgTerminalEnabledHint: "关闭后隐藏输入框旁的终端按钮，快捷键一并失效。",
      cfgFileTreeEnabled: "启用文件树",
      cfgFileTreeEnabledHint: "关闭后隐藏输入框旁的文件树按钮，快捷键一并失效。",
      cfgSkillsPageEnabled: "启用技能页",
      cfgSkillsPageEnabledHint: "关闭后设置里不再显示「技能」页；技能本身不受影响。",
      cfgSearchEnabled: "启用网页搜索",
      cfgSearchEnabledHint: "免费多源搜索（free-search）。关闭后 AI 的 web_search 走官方默认渠道；变更重启后生效。",
      cfgSearchMaxResults: "搜索结果条数",
      cfgSearchMaxResultsHint: "网页搜索返回的来源条数上限，1-8 的整数（默认 5）。条数越多 AI 上下文消耗越大；保存后即时生效。",
      cfgPhoneEnabled: "显示「手机访问」页",
      cfgPhoneEnabledHint: "是否在设置中显示「手机访问」页；网关在该页内按需启停。",
      cfgJobsEnabled: "启用后台任务面板",
      cfgJobsEnabledHint: "输入框旁的任务按钮：查看运行中的后台任务、实时输出，并可一键结束。",
      phoneGateLabel: "启动网关（需要时开启；链接与令牌随之生成）",
      phoneGateStart: "启动网关",
      phoneGateStop: "关闭网关",
      phoneStoppedHint: "网关未启动。开启网关会生成全新链接，旧链接立即失效。",
      cfgRemoteHint: "非本机访问：上游把设置镜像钉在本机浏览器，配置在手机/远程只读——请在电脑端查看与修改。",
      cfgPhoneRemoteDomain: "远程域名",
      cfgPhoneRemoteDomainHint: "可选。VPS 反向隧道指向本 GUI 的域名（如 dsh.example.com），填后面板会同时给出远程二维码。",
      cfgPhonePort: "网关端口",
      cfgPhonePortHint: "手机网关监听端口，1-65535（默认 3090）；保存后网关自动按新端口重启。",
      cfgPhoneKeepGatewayOn: "重启后保留开启",
      cfgPhoneKeepGatewayOnHint: "手机访问网关：勾选后 DSH 重启自动恢复上次的开启状态（同一令牌，已授权设备不掉线）；不勾则每次启动都是关闭的。保存后下次启动生效。",
      phoneTitle: "手机访问",
      phoneStatusOn: "网关运行中 · 端口 {port}",
      phoneStatusErr: "网关未运行：{error}",
      phoneOff: "手机访问未启用：请在 设置 → 插件配置 → dsh-kit 打开「启用手机访问」并重启。",
      phoneLoading: "正在生成链接…",
      phoneLoadFail: "读取失败：{error}",
      phoneLan: "局域网",
      phoneRemote: "远程",
      phoneScanHint: "用手机浏览器扫码，或复制地址到手机打开；首次打开后该设备长期有效。",
      phoneCopy: "复制",
      phoneCopied: "已复制",
      phoneRemoteHidden: "远程链接含访问令牌，不直接展示——点「复制」获取后自行打开。",
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
      cfgTerminalShortcutHint: "切换终端面板的组合键；需一个主键加至少一个修饰键（Ctrl/Alt/Shift/Meta）。",
      cfgFileTreeShortcut: "文件树快捷键",
      cfgFileTreeShortcutHint: "切换文件树的组合键；需一个主键加至少一个修饰键（Ctrl/Alt/Shift/Meta）。",
      cfgSidebarShortcut: "侧边栏展开/收起快捷键",
      cfgSidebarShortcutHint: "切换侧边栏展开/收起的组合键（默认 Ctrl+B）；需一个主键加至少一个修饰键。",
      cfgSidebarShortcutEnabled: "启用侧边栏快捷键",
      cfgSidebarShortcutEnabledHint: "关闭后侧边栏快捷键不再响应。",
      cfgSourceControlEnabled: "启用源代码管理",
      cfgSourceControlEnabledHint: "关闭后隐藏源代码管理按钮，快捷键一并失效。",
      cfgScShortcut: "源代码管理快捷键",
      cfgScShortcutHint: "切换源代码管理视图的组合键；需一个主键加至少一个修饰键。默认避开中文输入法占用的 Ctrl+.（中英文标点切换）。",
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
      treeRename: "Rename",
      treeDelete: "Delete",
      treeCopyAbs: "Copy absolute path",
      treeCopyRel: "Copy relative path",
      treeCopied: "Path copied",
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
      contentClose: "Close preview",
      toDiff: "Switch to diff view",
      toText: "Switch to plain view",
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
      cfgDesc: "Feature switches and shortcuts for terminal / files / skills / web search.",
      cfgTerminalEnabled: "Enable terminal",
      cfgTerminalEnabledHint: "Hides the terminal button next to the composer and disables its shortcut.",
      cfgFileTreeEnabled: "Enable file tree",
      cfgFileTreeEnabledHint: "Hides the file-tree button next to the composer and disables its shortcut.",
      cfgSkillsPageEnabled: "Enable skills page",
      cfgSkillsPageEnabledHint: "Removes the Skills entry from Settings (skills themselves are unaffected).",
      cfgSearchEnabled: "Enable web search",
      cfgSearchEnabledHint: "Free multi-source web search (free-search). When off, the agent's web_search uses the official default channel; changes apply after restart.",
      cfgSearchMaxResults: "Search result count",
      cfgSearchMaxResultsHint: "Upper bound of sources returned per web search, integer 1-8 (default 5). More results means more context usage; applies immediately after saving.",
      cfgPhoneEnabled: "Show phone access page",
      cfgPhoneEnabledHint: "Whether the \"Phone access\" page appears in Settings; the gateway starts/stops inside that page on demand.",
      cfgJobsEnabled: "Enable background jobs panel",
      cfgJobsEnabledHint: "Task button next to the composer: watch running background jobs, live output, and stop them with one click.",
      phoneGateLabel: "Start gateway (on demand; links are generated with it)",
      phoneGateStart: "Start gateway",
      phoneGateStop: "Stop gateway",
      phoneStoppedHint: "Gateway is stopped. Starting it issues a brand-new link and invalidates old ones.",
      cfgRemoteHint: "Non-local access: upstream pins the settings mirror to the local machine, so config stays read-only here — please view and edit it on the computer.",
      cfgPhoneRemoteDomain: "Remote domain",
      cfgPhoneRemoteDomainHint: "Optional. Domain of your VPS tunnel pointing to this GUI (e.g. dsh.example.com); the panel then also offers a remote QR code.",
      cfgPhonePort: "Gateway port",
      cfgPhonePortHint: "Port the phone gateway listens on, 1-65535 (default 3090); the gateway restarts on the new port after saving.",
      cfgPhoneKeepGatewayOn: "Keep enabled across restarts",
      cfgPhoneKeepGatewayOnHint: "Phone gateway: when checked, a DSH restart restores the last enabled state (same token, authorized devices stay signed in); unchecked, it starts off every time. Applies on the next start after saving.",
      cfgTerminalShortcut: "Terminal shortcut",
      cfgTerminalShortcutHint: "Combo that toggles the terminal panel; needs a modifier (Ctrl/Alt/Shift/Meta) + a key.",
      cfgFileTreeShortcut: "File tree shortcut",
      cfgFileTreeShortcutHint: "Combo that toggles the file tree; needs a modifier (Ctrl/Alt/Shift/Meta) + a key.",
      cfgSidebarShortcut: "Sidebar toggle shortcut",
      cfgSidebarShortcutHint: "Combo that collapses/expands the sidebar (default Ctrl+B); needs a modifier (Ctrl/Alt/Shift/Meta) + a key.",
      cfgSidebarShortcutEnabled: "Enable sidebar shortcut",
      cfgSidebarShortcutEnabledHint: "When off, the sidebar toggle combo stops responding.",
      cfgSourceControlEnabled: "Enable source control",
      cfgSourceControlEnabledHint: "Hides the source-control button and disables its shortcut.",
      cfgScShortcut: "Source control shortcut",
      cfgScShortcutHint: "Combo that toggles the source control view; needs a modifier (Ctrl/Alt/Shift/Meta) + a key. The default avoids Ctrl+., which Chinese IMEs claim for punctuation toggle.",
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
      phoneOff: "Phone access is disabled: turn it on under Settings → Plugin config → dsh-kit, then restart.",
      phoneLoading: "Generating links…",
      phoneLoadFail: "Failed to load: {error}",
      phoneLan: "LAN",
      phoneRemote: "Remote",
      phoneScanHint: "Scan with your phone browser, or copy the address over; a device stays authorized once opened.",
      phoneCopy: "Copy",
      phoneCopied: "Copied",
      phoneRemoteHidden: "The remote link contains the access token and is hidden — use Copy and open it yourself.",
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
    const lang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? zh : en;
    const t = (key) => lang[key] ?? key;
    /** 带占位符的文案变体：tf("phoneStatusOn", { port: 3090 }) */
    const tf = (key, vars) => {
      let s = lang[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) s = s.split(`{${name}}`).join(String(value));
      return s;
    };

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
.dshk-cfg-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshk-cfg-group ~ .dshk-cfg-group{border-top:1px solid var(--dsw-alias-border-l2)}
.dshk-cfg-sub{margin-left:14px}
.dshk-cfg-fhead{display:flex;align-items:center;gap:8px}
.dshk-cfg-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshk-cfg-badges{display:inline-flex;align-items:center;gap:8px;flex:none;height:19px}
.dshk-cfg-badge{display:inline-flex;align-items:center;height:19px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dshk-cfg-reset{font:inherit;background:none;border:0;padding:0;height:18px;display:inline-flex;align-items:center;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dshk-cfg-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshk-cfg-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dshk-cfg-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshk-cfg-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dshk-cfg-status{padding:6px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dshk-cfg-combo{appearance:none;font:inherit;font-family:ui-monospace,Consolas,monospace;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;line-height:1.5}
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
.dshk-phone-url{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.4;color:var(--dsw-alias-label-secondary);word-break:break-all;user-select:text}
.dshk-phone-copybtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1;padding:7px 10px;border-radius:8px;cursor:pointer}
.dshk-phone-copybtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-phone-copybtn[disabled]{opacity:.5;cursor:default}
.dshk-phone-hint{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.dshk-phone-domain{display:flex;align-items:center;gap:6px;width:100%;margin-bottom:10px}
.dshk-phone-domain-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshk-phone-domain-input{flex:1;min-width:0;font-size:11px;padding:5px 8px}
.dshk-phone-gatebtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;padding:9px 10px;border-radius:8px;cursor:pointer;width:100%;margin-bottom:10px}
.dshk-phone-btnrow{display:flex;gap:8px;margin-bottom:10px}
.dshk-phone-btnrow .dshk-phone-gatebtn{flex:1;margin-bottom:0}
.dshk-phone-rotate{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:9px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
.dshk-phone-rotate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-phone-rotate[disabled]{opacity:.5;cursor:default}
.dshk-phone-gatebtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshk-phone-gatebtn[disabled]{opacity:.5;cursor:default}
.dshk-phone-gatebtn-stop{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
/* 后台任务面板（任务按钮 + 居中浮层）。点击遮罩收起（kn应行为同 terminal 坞） */
.dshk-jobs-mask{position:fixed;inset:0;z-index:840;background:rgba(0,0,0,.28);pointer-events:auto}
.dshk-jobs-pop{position:fixed;z-index:850;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:min(520px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 6px 20px rgba(0,0,0,.14));padding:4px;overflow:hidden;pointer-events:auto}
.dshk-jobs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshk-jobs-headside{display:flex;align-items:center;gap:6px}
.dshk-jobs-count{font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshk-jobs-close{appearance:none;border:1px solid transparent;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;width:22px;height:22px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.dshk-jobs-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshk-jobs-list{display:flex;flex-direction:column;gap:1px;overflow:auto;padding:0 2px 2px}
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
/* 全文件着色 diff：完整内容内联渲染，删除红/新增绿/上下文正常 */
.dshk-inline{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;padding:4px 0;user-select:text;color:var(--dsw-alias-label-secondary)}
.dshk-il-add{color:#0dbc79;background:rgba(13,188,121,.08)}
.dshk-il-del{color:#cd3131;background:rgba(205,49,49,.08)}
/* 「更改」清单（VSCode 源代码管理式） */
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

    /** git 状态：available:false = 非 git 目录，前端隐藏徽标 */
    function fetchGitStatus(cwd, signal) {
      return fetch(`/dsh-kit/git/status?cwd=${encodeURIComponent(cwd)}`, { signal }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.available !== "boolean") {
          throw new Error(`HTTP ${res.status}`);
        }
        return body;
      });
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
          onClick();
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
      const rowActions = [];
      if (entry.dir && acts.onCreate) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeNewFile"), onClick: () => acts.onCreate(entry.path, false), children: jsxRuntime.jsx(FilePlusIcon, {}) }, "nf"));
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeNewFolder"), onClick: () => acts.onCreate(entry.path, true), children: jsxRuntime.jsx(FolderPlusIcon, {}) }, "nd"));
      }
      if (acts.onCopyPath) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeCopyAbs"), onClick: () => acts.onCopyPath(entry, false), children: jsxRuntime.jsx(CopyAbsIcon, {}) }, "ca"));
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeCopyRel"), onClick: () => acts.onCopyPath(entry, true), children: jsxRuntime.jsx(CopyRelIcon, {}) }, "cr"));
      }
      if (acts.onRename && !renaming) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeRename"), onClick: () => acts.onRename(entry), children: "✎" }, "rn"));
      }
      if (acts.onDelete && !renaming) {
        rowActions.push(jsxRuntime.jsx(RowActionBtn, { title: t("treeDelete"), onClick: () => acts.onDelete(entry), children: jsxRuntime.jsx(TrashIcon, {}) }, "dl"));
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
      /** 预览中的文件被改名/删除后关闭预览（含其子路径） */
      const closeStalePreview = (prefix) => {
        const f = kitUi.openFile;
        if (f && (f === prefix || f.startsWith(`${prefix}\\`) || f.startsWith(`${prefix}/`))) {
          setKitUi({ openFile: null, openFrom: null });
        }
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
      // ── 行内改名（✎ 触发，VSCode 式）：聚焦时只选中最后一个扩展名分隔符之前的
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
      const treeActions = {
        onCreate: createEntry,
        onDelete: deleteEntry,
        onRename: startRename,
        onCopyPath: copyEntryPath,
        renamingPath,
        onRenameSubmit: submitRename,
        onRenameCancel: cancelRename,
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
                            jsxRuntime.jsx(TreeNode, { entry, depth: 0, expanded, onToggle: toggleDir, onOpenFile, actions: treeActions }, entry.path),
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

    // ─────────── 源代码管理视图（sidebar.workspaces 的 git 模式，对标 VSCode SCM）───────────
    // 文件树头部分支按钮进入；与文件树互斥占用同一单槽，**无 ✕**——原文件树入口
    // 按钮（及 Ctrl+E）就是切换开关：树 ⇄ 源代码管理 来回切。
    // 布局对标 VSCode：标题行（分支图标+名称+条目数+⟳）→「暂存的更改」组 →「更改」组
    // （未跟踪 U 归入更改组）；非 git 目录给「初始化仓库」按钮（POST /git/init，幂等）。
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
      // 分组：暂存（xy 第一列非空格且非 ??）与其余（含未跟踪 U），对标 VSCode 两组
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
        return jsxRuntime.jsxs(
          "div",
          {
            className: "dshk-row dshk-chg-row",
            title: item.abs,
            onClick: () => onOpenFile(item.abs, isUntracked),
            children: [
              jsxRuntime.jsx("span", { className: "dshk-name", children: name }),
              dir !== "" ? jsxRuntime.jsx("span", { className: "dshk-dir", title: rel, children: dir }) : null,
              // 悬停操作（对标 VSCode 行内命令）：暂存＋ / 放弃↩ / 取消暂存－
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

      return jsxRuntime.jsxs("div", {
        className: "dshk-tree",
        children: [
          jsxRuntime.jsxs("div", {
            className: "dshk-head",
            children: [
              jsxRuntime.jsx(BranchIcon, {}),
              jsxRuntime.jsx("span", { className: "dshk-dir", title: root ?? "", children: t("scTitle") }),
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

    // ─────────── 文件内容预览（右侧停靠面板，自绘）───────────
    // 点击文件树中的文件 → 打开右侧 fixed 停靠面板展示内容（不依赖原生 details
    // 槽/ctx.layout：openDetails 默认宽只有 360 且无法从动态插件调 setDetails）。
    // 让位布局：挂 body.dshk-pane-open 类 + 根节点设 --dshk-pane-w，
    // 样式规则把中列（对话）margin-right 顶开面板宽度——对话左移，内容不被遮挡。
    // 默认宽度即最大（左移到底），左缘拖拽手柄可收窄/放宽。
    function FileContentPane({ path, source, untracked, cwd, onClose }) {
      const [state, setState] = react.useState({ phase: "loading" });
      const [dragging, setDragging] = react.useState(false);
      // git/diff 视图状态——xy=null 表示无变更或非仓库；diff 数据懒加载。
      // 视图模式：默认随入口（源代码管理=diff，文件树=原文；未跟踪文件没有
      // 基线，即便从 SCM 进入也默认原文），头部 ⇄ 随时互切；
      // 同一面板会话内换文件保留用户选中的模式
      const [mode, setMode] = react.useState(source === "scm" && untracked !== true ? "diff" : "text");
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
        setMode(source === "scm" && untracked !== true ? "diff" : "text");
      }, [source]);
      const [draft, setDraft] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [reloadNonce, setReloadNonce] = react.useState(0);
      // 拖过的宽度（px）；0 = 未拖过，用 CSS fallback 默认宽度
      const widthRef = react.useRef(0);
      const dragRef = react.useRef(null);
      // 预览增强：md 渲染 + CodeMirror 读写高亮。库懒加载；md 只读默认渲染，
      // 需要源码时进编辑即是源码（无独立「切源码」按钮）。
      const [cmReady, setCmReady] = react.useState(false);
      const [mdHtml, setMdHtml] = react.useState(null);
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
      // （AI 边改边看也能跟上），转回可见/聚焦立即补；切回原文视图即停轮询
      react.useEffect(() => {
        if (mode !== "diff" || !cwd) return undefined;
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

      // 挂让位类 + 初始宽度直接拉满（左移到底）；卸载复原。
      // useLayoutEffect：变量在绘制前就位，避免打开瞬间先画 fallback 宽度再过渡。
      react.useLayoutEffect(() => {
        document.body.classList.add("dshk-pane-open");
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
              mdActive
                ? mdHtml === null
                  ? jsxRuntime.jsx("div", { className: "dshk-note", children: t("contentLoading") })
                  : jsxRuntime.jsx("div", { className: "dshk-md", dangerouslySetInnerHTML: { __html: mdHtml } })
                : cmReady
                  ? jsxRuntime.jsx("div", { className: "dshk-cm-host", ref: readHostRef })
                  : jsxRuntime.jsx("pre", { className: "dshk-pane-pre", children: b.content }),
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
              // 原文 ⇄ diff 双视图切换（同一预览面板，入口只决定默认视图）
              !editing
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t(mode === "diff" ? "toText" : "toDiff"),
                    onClick: () => setMode((m) => (m === "diff" ? "text" : "diff")),
                    children: "⇄",
                  })
                : null,
              // ✎ 编辑不再限文件树来源；截断/二进制不可编辑的判定不变
              state.phase === "ready" && state.body && !state.body.binary && !state.body.truncated && !editing
                ? jsxRuntime.jsx("button", {
                    type: "button",
                    className: "dshk-btn",
                    title: t("edit"),
                    onClick: startEdit,
                    children: "✎",
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
            : mode === "diff"
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
    // 视图会挤进铁轨里很难看——所以：①打开动作走官方注入的 expandSidebar 回调
    // 自动展开（拿不到再退回点击官方切换按钮）；②sidebar.workspaces 的 owner 带
    // wide 标记，收起时不渲染内容（用户定稿：收起不显示，也无须占位提示）。
    // 官方切换按钮恒在，aria-label 随状态变化：收起态是「打开侧边栏」/“Open
    // sidebar”（注意关键字是「打开」不是「展开」，此前正则写错导致只能收不能开）。
    let sidebarExpandRef = { current: null };
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
    /** 打开动作：优先官方 expandSidebar 回调；拿不到回退 DOM 按钮点击 */
    function expandSidebarNow() {
      if (sidebarExpandRef.current) {
        try {
          sidebarExpandRef.current();
        } catch {
          // 官方回调抛错不阻塞打开
        }
        return;
      }
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
      // 远程链接含访问令牌：不展示地址与二维码，只留复制按钮（防截屏/旁观泄露）
      const activeIsRemote = !!(links[activeIdx] && links[activeIdx].label === "remote");
      react.useEffect(() => {
        if (!qrReady || activeUrl === "" || !canvasRef.current) return;
        try {
          drawPhoneQr(canvasRef.current, activeUrl);
        } catch {
          // 绘制失败不阻塞面板：URL 文案仍可手动输入
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
            ? jsxRuntime.jsxs("div", {
                className: "dshk-phone-btnrow",
                children: [
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: gatewayOn ? "dshk-phone-gatebtn dshk-phone-gatebtn-stop" : "dshk-phone-gatebtn",
                    disabled: gateBusy,
                    onClick: () => {
                      toggleGateway(!gatewayOn);
                    },
                    children: t(gatewayOn ? "phoneGateStop" : "phoneGateStart"),
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
              })
            : null,
          statusNode,
          cfgScope
            ? jsxRuntime.jsxs("div", {
                className: "dshk-phone-domain",
                children: [
                  jsxRuntime.jsx("span", { className: "dshk-phone-domain-label", children: t("phoneRemoteDomain") }),
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
                    activeIsRemote
                      ? null
                      : jsxRuntime.jsx("div", { className: "dshk-phone-qrwrap", children: jsxRuntime.jsx("canvas", { ref: canvasRef, "aria-label": "QR code" }) }),
                    jsxRuntime.jsxs("div", {
                      className: "dshk-phone-urlrow",
                      children: [
                        activeIsRemote
                          ? null
                          : jsxRuntime.jsx("span", { className: "dshk-phone-url", children: activeUrl }),
                        jsxRuntime.jsx("button", { type: "button", className: "dshk-phone-copybtn", onClick: copyActive, children: copied ? t("phoneCopied") : t("phoneCopy") }),
                      ],
                    }),
                    jsxRuntime.jsx("p", { className: "dshk-phone-hint", children: t(activeIsRemote ? "phoneRemoteHidden" : "phoneScanHint") }),
                  ],
                },
              )
            : null,
        ],
      });
    }

    // ─────────── 后台任务面板 ───────────
    // 入口按钮（conversation.input.left）只负责开合；面板本体由 KitSurfaces 在
    // shell.overlay 渲染（.dshk-jobs-pop 右上角浮层）。任务数据源与官方
    // JobListAction 相同——useSessions 的 jobsBySession（session/jobs 推送）。
    // 「结束」与「输出」走 dsh-kit 宿主端点（/dsh-kit/jobs/kill|output，权限按
    // session 隔离，与 job_kill/job_output 同一套 caller 语义）。
    function JobsEntry(props) {
      const ui = useKitUi();
      const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      const current = useSessions ? useSessions((s) => s.current) : undefined;
      const jobs = useSessions ? useSessions((s) => (current ? s.jobsBySession[current] : undefined)) : undefined;
      const live = Array.isArray(jobs) ? jobs.filter((j) => j.status === "running" || j.status === "stopping") : [];
      const on = ui.jobsOpen;
      return jsxRuntime.jsxs("button", {
        type: "button",
        className: "dshk-btn dshk-enbtn",
        "aria-pressed": on,
        title: live.length > 0 ? `${t("jobsTitle")} (${live.length})` : t("jobsTitle"),
        onClick: () => setKitUi({ jobsOpen: !on }),
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
      const zhLang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "");
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
          jsxRuntime.jsx("div", { className: "dshk-jobs-mask", onClick: () => setKitUi({ jobsOpen: false }) }),
          jsxRuntime.jsxs("div", {
            className: "dshk-jobs-pop",
            role: "dialog",
            "aria-label": t("jobsTitle"),
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
              jsxRuntime.jsx("button", {
                type: "button",
                className: "dshk-jobs-close",
                "aria-label": t("jobsClose"),
                title: t("jobsClose"),
                onClick: () => setKitUi({ jobsOpen: false }),
                children: "\u2715",
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
          }),
        ],
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
          // 输入框入口排序（左→右）：文件树、源代码管理、后台任务、终端；手机访问与
          // 技能页同类，走 settings.section 页面入口（order：技能 40 → 手机 45）
          ["filetree", cfg.fileTreeEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-filetree", order: 10 }, FileTreeEntry)],
          ["scm", cfg.sourceControlEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-scm", order: 11 }, ScmEntry)],
          ["jobs", cfg.jobsEnabled, () =>
            slotsCtx.slots.register({ name: "conversation.input.left", id: "dsh-kit-jobs", order: 12 }, JobsEntry)],
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
      }, [cfg.phoneEnabled, cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.sourceControlEnabled, cfg.skillsPageEnabled, cfg.jobsEnabled]);

      // 配置关闭但视图还开着（如设置卡保存瞬间）：立即归位，预览随来源跟随清掉；
      // 终端功能关闭 = 结束全部终端会话（连 WS 杀 pty，与单终端时代语义一致）
      react.useEffect(() => {
        if (!cfg.terminalEnabled && (ui.termDockOpen || ui.terminals.length > 0)) {
          setKitUi({ terminals: [], activeTermId: null, termDockOpen: false });
        }
        if (!cfg.fileTreeEnabled && ui.treeOpen) setKitUi({ treeOpen: false, openFile: null, openFrom: null });
        if (!cfg.sourceControlEnabled && ui.gitOpen) setKitUi({ gitOpen: false, openFile: null, openFrom: null });
        if (!cfg.jobsEnabled && ui.jobsOpen) setKitUi({ jobsOpen: false });
      }, [cfg.terminalEnabled, cfg.fileTreeEnabled, cfg.sourceControlEnabled, cfg.jobsEnabled]);

      // 侧边栏浏览区占用：文件树与「更改」视图互斥共享 sidebar.workspaces 单槽
      // （gitOpen 时切换到更改页，✕ 关闭回到仍处打开状态的文件树）。
      // 动态注册若在运行时抛错，捕获并回滚开合状态，避免入口被错误边界退役。
      react.useEffect(() => {
        if (!slotsCtx || (!ui.treeOpen && !ui.gitOpen)) return undefined;
        let dispose;
        try {
          // 单槽遮蔽原生需要更低 priority（数字越小越先渲染，原生在 priority 0）。
          // owner 携带官方注入的 wide（侧边栏是否展开）与 expandSidebar 回调：
          // ①宽态正常渲染面板；②收起态不渲染内容（用户定稿：收起不需要占位，
          // 也不把树/SCM 挤进铁轨）；③把回调存到模块级，打开动作优先走它自动展开。
          dispose = slotsCtx.slots.register({ name: "sidebar.workspaces", priority: -1000 }, (owner) => {
            const side = owner ?? {};
            sidebarExpandRef.current = typeof side.expandSidebar === "function" ? side.expandSidebar : null;
            if (side.wide === false) return null;
            return ui.gitOpen
              ? jsxRuntime.jsx(GitChangesPanel, { cwd, onOpenFile: (p, untracked) => setKitUi({ openFile: p, openFrom: "scm", openUntracked: untracked === true }), ...owner })
              : jsxRuntime.jsx(FileTreePanel, { cwd, onOpenFile: (p) => setKitUi({ openFile: p, openFrom: "tree", openUntracked: false }), ...owner });
          });
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
            if (kitUi.openFile) setKitUi({ openFile: null, openFrom: null });
            else if (kitUi.gitOpen) setKitUi({ gitOpen: false });
            else if (kitUi.treeOpen) setKitUi({ treeOpen: false });
            else if (kitUi.jobsOpen) setKitUi({ jobsOpen: false });
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
          ui.openFile && (cfg.fileTreeEnabled || cfg.sourceControlEnabled)
            ? jsxRuntime.jsx(FileContentPane, {
                path: ui.openFile,
                source: ui.openFrom ?? "tree",
                untracked: ui.openUntracked === true,
                cwd,
                onClose: () => setKitUi({ openFile: null, openFrom: null, openUntracked: null }),
              })
            : null,
          cfg.jobsEnabled && ui.jobsOpen ? jsxRuntime.jsx(JobsPanel, { ...props }) : null,
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
      { key: "sourceControlEnabled", kind: "bool" },
      { key: "skillsPageEnabled", kind: "bool" },
      { key: "searchEnabled", kind: "bool" },
      { key: "searchMaxResults", kind: "number" },
      { key: "phoneEnabled", kind: "bool" },
      { key: "phoneKeepGatewayOn", kind: "bool" },
      { key: "jobsEnabled", kind: "bool" },
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
      { switchKey: "fileTreeEnabled", fields: ["fileTreeShortcut"] },
      { switchKey: "sourceControlEnabled", fields: ["scShortcut"] },
      { switchKey: "jobsEnabled", fields: [] },
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
        return Number.isInteger(n) && n >= 1 && n <= 8 ? { kind: "set", value: n } : undefined;
      }
      if (cfgSpec[field].kind === "text") return { kind: "set", value: String(text ?? "").trim() };
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
          return jsxRuntime.jsxs("div", {
            className: isSub ? "dshk-cfg-field dshk-cfg-sub" : "dshk-cfg-field",
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
                children: state.invalid
                  ? t(spec.kind === "number" ? "invalidNumber" : "invalidCombo")
                  : t(cfgLabelKey(field, "Hint")),
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
