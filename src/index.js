// dsh-kit — DSH 页面能力插件包（宿主半边）
//
// 当前能力：
//   终端（terminal）——见下方协议注释；
//   文件树（file tree）——GET /dsh-kit/tree?path=<绝对目录> 返回该层
//     目录+文件的 JSON 列表（官方 browse RPC 只列目录不列文件，故自建）；
//   文件预览（file preview）——GET /dsh-kit/read?path=<绝对文件> 读取文本
//     内容（限长 + 二进制探测），浏览器端在右侧 details 列展示；
//   网页搜索（web search）——自 dsh-free-search v0.2.0 并入：向 web seam 注册
//     'free-search' provider（免费引擎链），实现见 src/web-search.js +
//     src/engine-chain.js + src/engines/*。
//
// 浏览器半边（client/bundle.js）：终端/文件树入口按钮注册在对话输入框工具行
// （conversation.input.left），面板本体挂 shell.overlay 全帧浮层；终端开合底部
// 停靠面板（Ctrl+`），文件树临时接管侧边栏浏览区（sidebar.workspaces 单槽）。
// 插件设置卡（dsh-kit 命名空间，settings.plugin.item）提供功能开关与快捷键自定义；
// 其中 searchEnabled 由宿主消费（开=免费引擎链，关=转发官方渠道，重启后生效），
// 其余开关浏览器端消费。
//
// 宿主半边（本文件）挂这些端点（webserver 默认只绑 loopback）：
//   1) WebSocket /dsh-kit/terminal —— 每条连接一个 node-pty 会话；
//   2) 静态 /dsh-kit/vendor/* —— xterm 官方预编译 UMD，按需加载；
//   3) GET /dsh-kit/tree?path=… —— 单层目录列表（含文件），只读；
//   4) GET /dsh-kit/read?path=… —— 单文件文本内容，只读；
//   5) GET /dsh-kit/raw?path=… —— 原始字节透传（扩展名白名单 + Range/206，PDF 预览用）；
//   6) POST /dsh-kit/write —— 编辑保存（cwd 子树校验 + mtime CAS）；
//   7) POST /dsh-kit/fs/op —— 文件树新建/重命名/删除（删除优先移入回收站）；
//   8) GET /dsh-kit/git/status|diff|log|show|branch、POST /dsh-kit/git/init|op ——
//      源代码管理。status 含分支/领先信息（branch/upstream/ahead/behind），
//      log 是提交图谱（git log --all --graph），show 是单个提交详情，
//      branch 是本地分支列表；op 含 stage/unstage/discard/commit/push/
//      branchCreate/branchSwitch/branchDelete。
//
// 终端的工作目录由浏览器端传入（当前会话的 cwd），宿主侧校验后才启动 shell。
//
// 协议（JSON 文本帧，双向）：
//   浏览器 → 宿主：
//     {t:'init', cwd, cols, rows}   连接后第一条：校验 cwd 并启动 shell
//     {t:'i', d}                    键盘输入（原样写入 pty）
//     {t:'r', cols, rows}           面板尺寸变化
//   宿主 → 浏览器：
//     {t:'started', shell, cwd}     pty 就绪
//     {t:'o', d}                    输出
//     {t:'exit', exitCode}          进程退出（随后服务端关闭连接）
//     {t:'error', message}          致命错误（随后关闭连接）
//
// 工作区语义（2026-08-23 用户定稿）：浏览器端在「打开终端」那一刻把当时的
// 工作目录固定下来传给本端点；面板存续期间无论怎么切换会话/工作区都不会
// 重连或换 shell，直到用户关闭面板（连接关闭即杀进程）。

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { applySkillPool, findProjectRoot } from './skill-pool.js'
import { applyWebSearch } from './web-search.js'
import { parseStatusBranch, parseLogGraph, parseBranchList, parseTrack } from './git.js'
import { startPhoneGateway, lanAddresses, defaultStateFile, loadGatewayState, saveGatewayState } from './phone-gateway.js'
import { decodePreviewText } from './text-decode.js'
import { rawContentType, parseRangeHeader } from './raw-file.js'
import { multipartBoundary, parseMultipart, safeUploadName, dedupeName } from './upload.js'

/** 手机访问网关对外端口（0.0.0.0）的默认值，可在设置里改（phonePort，1-65535） */
const PHONE_PORT = 3090

export const name = 'dsh-kit'

const require = createRequire(import.meta.url)

/**
 * 定位运行中 DSH 的 monorepo 根（含 pnpm-workspace.yaml 的目录）。从
 * process.argv[1]（dsh 启动脚本；tsx 开发模式下可能是相对路径，先 path.resolve
 * 成绝对路径，否则 pnpm-workspace.yaml 检查落空）向上走。非 DSH 环境返回 null。
 */
function findMonorepoRoot() {
  const anchor = process.argv[1]
  if (!anchor) return null
  const abs = path.isAbsolute(anchor) ? anchor : path.resolve(process.cwd(), anchor)
  let dir = path.dirname(abs)
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 多锚点加载 dsh-kit 的运行时依赖（node-pty / ws，均为 DSH 自身依赖，不在
 * dsh-kit 的 package.json 里）。按可靠度依次尝试：
 *   1) 本模块 import.meta.url —— 真实安装形态（registry tarball 带依赖）命中这里；
 *   2) DSH 本体锚点（process.argv[1]，绝对路径化）—— 软链装进 profile 后真实路径
 *      落在源仓库、够不到 fallback node_modules，改用 dsh 启动脚本所在处的
 *      node_modules（ws 挂在这里）；
 *   3) DSH monorepo 的 .pnpm store —— node-pty 等原生/patched 依赖挂在某个
 *      workspace 包（如 subprocess-local）的 node_modules，profile 与 dsh bin
 *      都够不到；直接从 pnpm store 按 spec 定位实体加载。
 * 都失败返回 null（终端能力不可用，插件其余功能正常）。
 */
function loadDep(spec) {
  try {
    return require(spec)
  } catch {
    // 落到后续锚点
  }
  const anchor = process.argv[1]
  if (anchor) {
    const abs = path.isAbsolute(anchor) ? anchor : path.resolve(process.cwd(), anchor)
    try {
      return createRequire(abs)(spec)
    } catch {
      // 落到 monorepo store
    }
  }
  const root = findMonorepoRoot()
  if (root) {
    const pnpm = path.join(root, 'node_modules', '.pnpm')
    if (fs.existsSync(pnpm)) {
      let entries = []
      try {
        entries = fs.readdirSync(pnpm)
      } catch {
        /* ignore */
      }
      for (const e of entries) {
        if (!(e === spec + '@' || e.startsWith(spec + '@'))) continue
        const pkgJson = path.join(pnpm, e, 'node_modules', spec, 'package.json')
        if (!fs.existsSync(pkgJson)) continue
        try {
          return createRequire(pkgJson)(spec)
        } catch {
          // 试下一个候选版本
        }
      }
    }
  }
  return null
}

/**
 * 从 DSH monorepo 根直接 import 本地 workspace 包（dsh-settings / schemastery），
 * 不依赖 profile node_modules 里的 junction。
 *
 * dsh-settings/schemastery 的 peerDependencies 全是 pnpm `workspace:` 协议，只能在
 * monorepo 内解析，无法作为 file: 依赖拷出。故从 monorepo 根（见 findMonorepoRoot）
 * 直接 import 根下 lib 入口；其 workspace 依赖在 monorepo 自身 node_modules 内解析，
 * 完整可用。
 */
async function loadMonorepoDep(relEntry) {
  const root = findMonorepoRoot()
  if (!root) return null
  const entry = path.join(root, relEntry)
  if (!fs.existsSync(entry)) return null
  try {
    return await import(pathToFileURL(entry).href)
  } catch {
    return null
  }
}

/**
 * 异步多锚点加载设置命名空间依赖（@deepseek-ai/schemastery 自带 cjs）。按可靠度
 * 依次尝试：
 *   1) 裸 import(spec)——依赖在插件解析路径可达的安装形态直接命中；
 *   2) 运行中 dsh 本体锚点——junction/真实拷贝安装下插件位置 parent-walk 够不到
 *      fallback node_modules，但 schemastery 在 dsh 主程序自身的依赖树里：
 *      createRequire(process.argv[1]).resolve 定位实体文件路径，
 *      再 import(pathToFileURL)。resolve 走 CJS 条件，exports 只有 default 的
 *      纯 ESM 包同样可解析；import 统一处理 ESM/CJS，且等待进程内单例加载完成，
 *      天然避开 require(esm) 的 "not yet fully loaded" 启动期竞争；
 *   3) DSH monorepo 源码开发形态（运行中的 dsh 在 monorepo 里）——按 workspace
 *      相对路径直 import 本地包 lib 入口（见 loadMonorepoDep）。
 * 都失败返回 null（设置命名空间不注册，插件其余功能保持可用性优先）。
 */
async function loadSettingsDep(spec, monorepoEntry) {
  try {
    return await import(spec)
  } catch {
    // 落到下一锚点
  }
  const anchor = process.argv[1]
  if (anchor) {
    try {
      const abs = path.isAbsolute(anchor) ? anchor : path.resolve(process.cwd(), anchor)
      const resolved = createRequire(abs).resolve(spec)
      if (resolved) return await import(pathToFileURL(resolved).href)
    } catch {
      // 落到下一锚点
    }
  }
  return monorepoEntry ? loadMonorepoDep(monorepoEntry) : null
}

const pty = loadDep('node-pty')
const WebSocketServer = loadDep('ws')?.WebSocketServer ?? null
if (!pty || !WebSocketServer) {
  console.warn('dsh-kit: node-pty/ws 不可用，终端能力不可用')
}

/** 尺寸参数收敛到安全区间 */
function clampDim(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 校验浏览器传来的 cwd：绝对路径 + 存在 + 是目录，返回规范化的真实路径 */
function validateCwd(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, message: '缺少工作目录（cwd）' }
  const resolved = path.resolve(raw.trim())
  let real
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return { ok: false, message: `目录不存在：${resolved}` }
  }
  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    return { ok: false, message: `无法读取目录：${real}` }
  }
  if (!stat.isDirectory()) return { ok: false, message: `不是目录：${real}` }
  return { ok: true, path: real }
}

/** 校验浏览器传来的文件路径：绝对路径 + 存在 + 是文件，返回真实路径、大小与修改时间 */
function validateFile(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, message: '缺少文件路径' }
  const resolved = path.resolve(raw.trim())
  let real
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return { ok: false, message: `文件不存在：${resolved}` }
  }
  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    return { ok: false, message: `无法读取文件：${real}` }
  }
  if (!stat.isFile()) return { ok: false, message: `不是文件：${real}` }
  return { ok: true, path: real, size: stat.size, mtimeMs: stat.mtimeMs }
}

/** 校验浏览器传来的路径：绝对路径 + 存在（文件或目录均可），返回真实路径与 stat */
function validateAny(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, message: '缺少路径' }
  const resolved = path.resolve(raw.trim())
  let real
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return { ok: false, message: `路径不存在：${resolved}` }
  }
  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    return { ok: false, message: `无法读取路径：${real}` }
  }
  return { ok: true, path: real, stat }
}

/** target 是否位于 dir 子树内（dir 本身不算在内——根目录不可改删） */
function withinTree(dirReal, targetReal) {
  const rel = path.relative(dirReal, targetReal)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Windows 保留设备名（con.txt 这类同样保留，故只取第一个点之前的部分判） */
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i
/** 新建/重命名的名称合法性：禁空、首尾空白、路径分隔符、控制字符、Windows 特殊字符与相对段 */
function invalidFsName(raw) {
  if (typeof raw !== 'string') return true
  const name = raw.trim()
  if (name === '' || name !== raw) return true
  if (name === '.' || name === '..') return true
  if (/[/\\]/.test(name)) return true
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return true
  if (WIN_RESERVED_NAME.test(name.split('.')[0])) return true
  return false
}

/**
 * 删除进回收站（全局约定：优先进回收站，避免直接永久删除）。
 * Windows 走 powershell.exe + Microsoft.VisualBasic.FileIO.FileSystem（路径单引号
 * 转义后嵌入脚本再以 -Command 原样传递，规避命令行引号转义问题）；其它平台无
 * 回收站 API，resolve(false) 由调用方决定回退方式。
 */
function recycleDelete(target, isDir) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false)
      return
    }
    const esc = String(target).replace(/'/g, "''")
    const method = isDir ? 'DeleteDirectory' : 'DeleteFile'
    const script =
      `try{Add-Type -AssemblyName Microsoft.VisualBasic;` +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${esc}','OnlyErrorDialogs','SendToRecycleBin')}catch{exit 1}`
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
    }, 15000)
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

/** Windows 优先 pwsh（PowerShell 7+），退回 powershell.exe；其它平台用 $SHELL 或 bash。结果缓存。 */
let shellCache
/** PSReadLine 历史预测初始化（灰字建议 + → 接受整条建议，fish 风格）：PowerShell
 *  默认不启用，启动参数显式开启。-EncodedCommand（UTF-16LE base64）把初始化脚本
 *  变成单一 token，规避 Windows 命令行的引号/空格问题；-NoExit 保证执行完初始化
 *  仍进入交互会话，用户 profile 照常加载。Windows PowerShell 5.1 自带的旧版
 *  PSReadLine 无该参数，try/catch 静默跳过；预测要求 VT 控制台，node-pty 的
 *  ConPTY 满足（实测 PREDICT=History）。 */
const PS_PREDICT_INIT = Buffer.from(
  'try { Set-PSReadLineOption -PredictionSource History -ErrorAction Ignore } catch {}',
  'utf16le',
).toString('base64')

function resolveShell() {
  if (shellCache) return shellCache
  if (process.platform === 'win32') {
    let pwsh = null
    for (const dir of (process.env.PATH ?? '').split(';')) {
      if (!dir) continue
      try {
        if (fs.existsSync(path.join(dir.trim(), 'pwsh.exe'))) {
          pwsh = path.join(dir.trim(), 'pwsh.exe')
          break
        }
      } catch {
        // 忽略不可读的 PATH 项
      }
    }
    shellCache = pwsh
      ? { file: pwsh, args: ['-NoLogo', '-NoExit', '-EncodedCommand', PS_PREDICT_INIT], label: 'pwsh' }
      : { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-EncodedCommand', PS_PREDICT_INIT], label: 'powershell' }
  } else {
    const file = process.env.SHELL || '/bin/bash'
    shellCache = { file, args: [], label: file }
  }
  return shellCache
}

/** 同源校验：Origin 必须存在且 host 与请求 Host 完全一致（webserver 默认只绑 loopback）。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// vendor 静态资源：白名单文件名 → client/vendor/ 下同名文件
const VENDOR_DIR = fileURLToPath(new URL('../client/vendor/', import.meta.url))
const VENDOR_FILES = new Map([
  ['/dsh-kit/vendor/xterm.js', 'xterm.js'],
  ['/dsh-kit/vendor/addon-fit.js', 'addon-fit.js'],
  ['/dsh-kit/vendor/xterm.css', 'xterm.css'],
  ['/dsh-kit/vendor/qrcode.js', 'qrcode.js'],
  ['/dsh-kit/vendor/marked.min.js', 'marked.min.js'],
  ['/dsh-kit/vendor/purify.min.js', 'purify.min.js'],
  ['/dsh-kit/vendor/codemirror.bundle.js', 'codemirror.bundle.js'],
  // pdf.js 预览（主文件懒加载；worker/cmaps/standard_fonts 由库按需再取）
  ['/dsh-kit/vendor/pdf.min.js', 'pdf.min.js'],
  ['/dsh-kit/vendor/pdf.worker.min.js', 'pdf.worker.min.js'],
  // Excel/Word 预览解析库（xlsx/docx 懒加载，进沙箱 iframe 解析）
  ['/dsh-kit/vendor/xlsx.full.min.js', 'xlsx.full.min.js'],
  ['/dsh-kit/vendor/mammoth.browser.min.js', 'mammoth.browser.min.js'],
])
// pdf.js 按需取用的资源子目录（CJK cmaps / 标准字体回退），单文件白名单覆盖不了
const VENDOR_SUBDIRS = new Map([
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
])
const VENDOR_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
])

export async function apply(ctx) {
  // ── 插件设置命名空间 ──
  // 浏览器半边设置卡（client/bundle.js 的 dsh-kit 卡片，settings.plugin.item）
  // 的数据通道：terminalEnabled/fileTreeEnabled/skillsPageEnabled 三个功能开关
  // + terminalShortcut/fileTreeShortcut 两个快捷键。宿主自身不消费这些值（门控
  // 全在浏览器端），但命名空间必须注册——否则浏览器端 settings.mutate 报
  // "namespace not registered"。注册经 ctx.inject(['settings']) 等服务就绪，
  // 不能拿 ctx.get('settings') 判存在后跳过。
  // 宿主消费的开关：searchEnabled 在启动期决定 free-search provider 挂哪种
  // 实现——开=免费引擎链，关=同 id 转发官方渠道（见 web-search.js）；
  // searchMaxResults 是每次搜索的来源条数上限（1-8，默认 5），provider 每次
  // 调用现读，改完即生效。phoneEnabled 同为宿主消费：经 onChange 热同步网关
  // 启停/端口，改开关立即生效无需重启。其余开关全在浏览器端门控入口按钮，
  // 宿主不读。先注册设置层再挂搜索，确保注入回调读到的是已落定值。
  // readSettings 提升到 apply 作用域：webServer 注入回调（块外）的手机访问段
  // 也要读开关（远程域名、端口、页面可见性）。网关启用位已改状态文件直管，
  // 不再走 settings。设置层不可用时保持空实现 → phone 关、search 直挂（可用性优先）。
  // 设置注册 API（适配 DSH v0.1.2-alpha.5+）：命名空间注册是 ctx.settings 服务
  // （dsh-settings-file 提供）上的 installSection(owner, ns, schema, entry, hooks)，
  // ns 为裸字符串，注册是插件 fiber 上的 effect（dispose 自动注销）。旧版独立导出
  // installSettingsSection 已随该版本消亡，不再兼容。
  // schemastery 自带 cjs 导出，import() 同样适用（Node 支持 import CJS）；
  // 多锚点解析见 loadSettingsDep：裸 import 失败后先落运行中 dsh 本体锚点
  //（junction/真实拷贝安装都有），最后才落 monorepo 源码开发形态的 workspace 入口。
  const schemasteryMod = await loadSettingsDep('@deepseek-ai/schemastery', 'vendor/schemastery/lib/index.mjs')
  const z = schemasteryMod?.default ?? schemasteryMod ?? null
  const Config = z && typeof z.object === 'function' ? z.object({
    terminalEnabled: z.boolean().default(true),
    fileTreeEnabled: z.boolean().default(true),
    sourceControlEnabled: z.boolean().default(true),
    chatOpenFilePreview: z.boolean().default(false),
    skillsPageEnabled: z.boolean().default(true),
    searchEnabled: z.boolean().default(true),
    searchMaxResults: z.number().step(1).min(1).max(8).default(5),
    // phoneEnabled = 「手机访问」页入口可见性（配置卡最下，纯显示开关）。
    // 网关启停不走 settings（读取器回填滞后），改由状态文件 + kit 端点直管。
    phoneEnabled: z.boolean().default(false),
    phoneRemoteDomain: z.string().default(''),
    phonePort: z.number().step(1).min(1).max(65535).default(3090),
    phoneKeepGatewayOn: z.boolean().default(false),
    jobsEnabled: z.boolean().default(true),
    sidebarShortcut: z.string().default('Ctrl+B'),
    sidebarShortcutEnabled: z.boolean().default(true),
    terminalShortcut: z.string().default('Ctrl+/'),
    fileTreeShortcut: z.string().default('Ctrl+,'),
    scShortcut: z.string().default('Ctrl+Alt+.'),
  }) : null

  let readSettings = () => ({})
  /** phoneSettingsReady：setSource 首次触发时置 true，下游 webServer 注入段由此判断
   *  是立即评估网关启用位还是等 onSettingsReady 回调。解决时序差——readSettings 在
   *  settings 注册前是空函数，phoneKeepGatewayOn() 恒 false */
  let phoneSettingsReady = false
  // 手机网关的设置联动钩子（端口变更热重启等），由 webServer 注入段回填
  let onSettingsReady = () => {}
  let onSettingsChanged = () => {}
  /** setSource/onChange 钩子：settings 首次就绪时触发网关启用位检查（此时 readSettings
   *  才读到真实值）；注意 onSettingsReady 在 webServer 注入回填前是空函数——如果注入
   *  回调还未执行，调用无效果；注入回调已存在时触发首次评估（解决时序差） */
  const settingsHooks = {
    setSource: (current) => {
      readSettings = current
      phoneSettingsReady = true
      onSettingsReady()
    },
    onChange: () => { onSettingsChanged() },
  }
  if (Config) {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.settings.installSection(ctx, 'dsh-kit', Config, {}, settingsHooks)
      } catch (error) {
        console.warn(`dsh-kit: 设置命名空间注册失败：${error?.message ?? error}`)
      }
    })
    applyWebSearch(ctx, {
      getEnabled: () => readSettings().searchEnabled !== false,
      getMaxResults: () => readSettings().searchMaxResults,
    })
  } else {
    // 设置层不可用：搜索按开启处理直接挂链
    applyWebSearch(ctx)
  }

  // 技能池端点（实现见 src/skill-pool.js）：自带 webServer 注入与同源校验。
  // skills 注册表是可选增强（归属展示），服务晚于本行就绪也无碍——注入回调捕获引用。
  let skillsRegistry = null
  ctx.inject(['skills'], (skillsCtx) => {
    skillsRegistry = skillsCtx.skills
  })
  applySkillPool(ctx, { getRegistry: () => skillsRegistry })

  // 后台任务控制（实现见下）：浏览器半边「任务」面板的结束/读输出走这里。
  // jobs 注册表（dsh-jobs-local）与 agents 注册表（dsh-agent）都是宿主组合里的
  // 可选服务，分开注入捕获引用；缺失时对应端点返回 503（面板隐藏对应能力）。
  let jobsRegistry = null
  ctx.inject(['jobs'], (capacityCtx) => {
    jobsRegistry = capacityCtx.jobs
  })
  let agentsRegistry = null
  ctx.inject(['agents'], (capacityCtx) => {
    agentsRegistry = capacityCtx.agents
  })

  // webServer 可能在本插件 apply 之后才挂载，用动态注入等它就绪
  ctx.inject(['webServer', 'credentials'], (webCtx) => {
    webCtx.effect(() => {
      // ── vendor 静态资源 ──
      const disposeVendor = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-kit/vendor',
        handler: (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://dsh-kit.local').pathname
          const notFound = () => {
            res.writeHead(404)
            res.end()
          }
          // 子目录资源（cmaps/*.bcmap、standard_fonts/*.pfb 等）：单段文件名
          // 白名单字符校验，杜绝路径穿越
          let file = null
          const sub = /^\/dsh-kit\/vendor\/(cmaps|standard_fonts)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname)
          if (sub) {
            file = path.join(VENDOR_SUBDIRS.get(sub[1]), sub[2])
          } else {
            file = VENDOR_FILES.get(pathname) ?? null
          }
          if (file === null || (req.method !== 'GET' && req.method !== 'HEAD')) {
            notFound()
            return
          }
          fs.readFile(path.join(VENDOR_DIR, file), (error, body) => {
            if (error) {
              notFound()
              return
            }
            res.writeHead(200, {
              'content-type': VENDOR_TYPES.get(path.extname(file)) ?? 'application/octet-stream',
              'cache-control': 'no-cache',
            })
            res.end(req.method === 'HEAD' ? undefined : body)
          })
        },
      })

      // ── 文件树端点：GET /dsh-kit/tree?path=<绝对目录> ──
      // 只读单层列表（目录+文件，目录在前）。官方 browse RPC（ctx.workspaces
      // .listDirectory）只返回子目录不返回文件，文件树走这里。
      const TREE_LIMIT = 2000
      const disposeTree = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/tree',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          // 同源校验：同源 fetch 的 GET 可能不带 Origin（浏览器行为），带了就必须匹配 Host；
          // webserver 本身只绑 loopback，这里防的是其它本地页面跨源探测。
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('path') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          fs.readdir(dir.path, { withFileTypes: true }, (error, dirents) => {
            if (error) {
              json(404, { error: `读取目录失败：${error?.message ?? error}` })
              return
            }
            // Dirent 不追符号链接：链接项按文件呈现（点击复制路径不受影响）
            const entries = dirents.map((d) => ({
              name: d.name,
              path: path.join(dir.path, d.name),
              dir: d.isDirectory(),
            }))
            entries.sort((a, b) =>
              a.dir === b.dir
                ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
                : a.dir
                  ? -1
                  : 1,
            )
            const truncated = entries.length > TREE_LIMIT
            json(200, {
              path: dir.path,
              entries: truncated ? entries.slice(0, TREE_LIMIT) : entries,
              truncated,
            })
          })
        },
      })

      // ── 文件内容端点：GET /dsh-kit/read?path=<绝对文件> ──
      // 只读单文件文本内容（限长 + 二进制探测）。点击文件树中的文件后，
      // 浏览器端把内容展示进右侧 details 列（对话左移让位）。
      const READ_LIMIT = 512 * 1024
      const disposeRead = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/read',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const file = validateFile(url.searchParams.get('path') ?? '')
          if (!file.ok) {
            json(400, { error: file.message })
            return
          }
          if (file.size > READ_LIMIT) {
            // 大文件也回开头 512KB，让预览至少有内容可看
            fs.open(file.path, 'r', (openError, fd) => {
              if (openError) {
                json(404, { error: `读取文件失败：${openError?.message ?? openError}` })
                return
              }
              const buf = Buffer.alloc(READ_LIMIT)
              fs.read(fd, buf, 0, READ_LIMIT, 0, (readError, bytesRead) => {
                fs.close(fd, () => {})
                if (readError) {
                  json(404, { error: `读取文件失败：${readError?.message ?? readError}` })
                  return
                }
                const head = buf.subarray(0, bytesRead)
                const decoded = decodePreviewText(head, file.path)
                json(200, {
                  path: file.path,
                  size: file.size,
                  mtimeMs: file.mtimeMs,
                  truncated: true,
                  binary: decoded.binary,
                  content: decoded.content,
                })
              })
            })
            return
          }
          fs.readFile(file.path, (error, body) => {
            if (error) {
              json(404, { error: `读取文件失败：${error?.message ?? error}` })
              return
            }
            // 文本/二进制判定与解码：BOM 优先（UTF-8/UTF-16 系），无 BOM 含 NUL
            // 时文本类扩展名按 UTF-16LE 尝试恢复（Windows 常见存法），详见
            // src/text-decode.js（有单测）
            const decoded = decodePreviewText(body, file.path)
            json(200, { path: file.path, size: file.size, mtimeMs: file.mtimeMs, truncated: false, binary: decoded.binary, content: decoded.content })
          })
        },
      })

      // ── 原始字节端点：GET /dsh-kit/raw?path=<绝对文件> ──
      // 二进制透传（PDF 预览用）：扩展名白名单给 content-type，完整流式返回
      // 不截断，支持 Range/206（pdf.js 渐进加载需要）。安全链与 /read 相同；
      // 手机网关是全路径反代，新路径无需单独登记。
      const disposeRaw = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/raw',
        handler: (req, res) => {
          const fail = (code, msg) => {
            res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(msg)
          }
          if (req.method !== 'GET') {
            fail(405, 'method not allowed')
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            fail(403, 'cross-origin denied')
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const file = validateFile(url.searchParams.get('path') ?? '')
          if (!file.ok) {
            fail(400, file.message)
            return
          }
          const type = rawContentType(file.path)
          if (type === null) {
            fail(415, `不支持的类型：${path.extname(file.path) || '(无扩展名)'}`)
            return
          }
          const headers = {
            'content-type': type,
            'cache-control': 'no-cache',
            'accept-ranges': 'bytes',
            'x-content-type-options': 'nosniff',
            // inline + 编码文件名：浏览器标题/另存名取这里，中文不乱码
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
          }
          const range = parseRangeHeader(req.headers.range, file.size)
          if (range === null) {
            res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` })
            res.end()
            return
          }
          const partial = range !== undefined
          let stream
          try {
            stream = fs.createReadStream(file.path, partial ? { start: range.start, end: range.end } : {})
          } catch (error) {
            fail(404, `读取文件失败：${error?.message ?? error}`)
            return
          }
          stream.on('error', (error) => {
            // 头已发出（流中途失败）只能掐断连接；否则还来得及回 404
            if (res.headersSent) {
              res.destroy()
              return
            }
            fail(404, `读取文件失败：${error?.message ?? error}`)
          })
          if (partial) {
            res.writeHead(206, {
              ...headers,
              'content-range': `bytes ${range.start}-${range.end}/${file.size}`,
              'content-length': String(range.end - range.start + 1),
            })
          } else {
            res.writeHead(200, { ...headers, 'content-length': String(file.size) })
          }
          stream.pipe(res)
        },
      })

      // ── 编辑保存端点：POST /dsh-kit/write ──
      // body {path, content, baseMtime, cwd}。校验链：同源（POST 必须带 Origin 且
      // 匹配 Host）→ 文件必须位于 realpath(cwd) 子树内 → 必须是已存在文件 → 内容
      // ≤512KB 且不含 NUL → mtime CAS（baseMtime 不等于当前值回 409 modified，
      // 附带当前 mtimeMs 供前端重载）。成功返回新的 mtimeMs。
      const disposeWrite = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/write',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (!sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const chunks = []
          let total = 0
          let aborted = false
          req.on('data', (c) => {
            if (aborted) return
            total += c.length
            if (total > READ_LIMIT + 65536) {
              aborted = true
              json(413, { error: 'payload too large' })
              req.destroy()
              return
            }
            chunks.push(c)
          })
          req.on('end', () => {
            if (aborted) return
            let body
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              json(400, { error: 'bad json' })
              return
            }
            const dir = validateCwd(String(body?.cwd ?? ''))
            const file = validateFile(String(body?.path ?? ''))
            if (!dir.ok || !file.ok) {
              json(400, { error: !dir.ok ? dir.message : file.message })
              return
            }
            const rel = path.relative(dir.path, file.path)
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
              json(400, { error: '文件不在当前工作区内' })
              return
            }
            if (typeof body.content !== 'string') {
              json(400, { error: '缺少 content' })
              return
            }
            if (Buffer.byteLength(body.content, 'utf8') > READ_LIMIT) {
              json(400, { error: '内容超过 512KB 上限' })
              return
            }
            if (Buffer.from(body.content, 'utf8').includes(0)) {
              json(400, { error: '二进制内容拒绝写入' })
              return
            }
            const baseMtime = Number(body.baseMtime)
            if (!Number.isFinite(baseMtime)) {
              json(400, { error: '缺少 baseMtime' })
              return
            }
            let stat
            try {
              stat = fs.statSync(file.path)
            } catch (error) {
              json(404, { error: `读取文件失败：${error?.message ?? error}` })
              return
            }
            if (stat.mtimeMs !== baseMtime) {
              json(409, { error: 'modified', mtimeMs: stat.mtimeMs })
              return
            }
            fs.writeFile(file.path, body.content, 'utf8', (writeError) => {
              if (writeError) {
                json(500, { error: `写入失败：${writeError?.message ?? writeError}` })
                return
              }
              let next
              try {
                next = fs.statSync(file.path).mtimeMs
              } catch {}
              json(200, { ok: true, mtimeMs: next ?? null })
            })
          })
        },
      })

      // ── 上传端点：POST /dsh-kit/upload?dir=<绝对目录>（multipart 文件，落盘该目录）──
      // 场景：手机访问 DSH 时用 <input type=file> 唤起手机自己的选择器（原生对话框
      // 只会弹在运行它的机器上，手机够不到电脑的），选完经 HTTP 传回写入工作区。
      // 校验链与 /write 一致：同源（POST 强制 Origin）→ dir 走 validateCwd；文件名
      // 只取 basename + 去非法字符，重名自动追加 " (n)" 序号不覆盖。整体缓冲有上限，
      // 单文件另设上限（multipart 手工解析，见 src/upload.js）。
      const UPLOAD_TOTAL_LIMIT = 200 * 1024 * 1024
      const UPLOAD_FILE_LIMIT = 100 * 1024 * 1024
      const disposeUpload = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/upload',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (!sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('dir') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          const boundary = multipartBoundary(req.headers['content-type'])
          if (!boundary) {
            json(415, { error: '需要 multipart/form-data' })
            return
          }
          const chunks = []
          let total = 0
          let aborted = false
          req.on('data', (c) => {
            if (aborted) return
            total += c.length
            if (total > UPLOAD_TOTAL_LIMIT) {
              aborted = true
              json(413, { error: `上传总大小超过 ${Math.round(UPLOAD_TOTAL_LIMIT / 1048576)}MB 上限` })
              req.destroy()
              return
            }
            chunks.push(c)
          })
          req.on('end', () => {
            if (aborted) return
            const parts = parseMultipart(Buffer.concat(chunks), boundary)
            if (parts.length === 0) {
              json(400, { error: '没有可解析的文件' })
              return
            }
            const saved = []
            let warning = null
            for (const part of parts) {
              const name = safeUploadName(part.filename)
              if (!name) {
                warning = `跳过非法文件名：${part.filename}`
                continue
              }
              if (part.data.length > UPLOAD_FILE_LIMIT) {
                warning = `${name} 超过单文件 100MB 上限，已跳过`
                continue
              }
              const final = dedupeName(dir.path, name, (p) => fs.existsSync(p))
              if (!final) {
                warning = `${name} 重名冲突无法命名，已跳过`
                continue
              }
              try {
                fs.writeFileSync(path.join(dir.path, final), part.data)
                saved.push({ name: final, size: part.data.length })
              } catch (error) {
                warning = `写入失败：${error?.message ?? error}`
              }
            }
            if (saved.length === 0) {
              json(400, { error: warning ?? '没有可保存的文件' })
              return
            }
            json(200, { saved, warning })
          })
          req.on('error', () => {})
        },
      })

      // ── 文件管理端点：POST /dsh-kit/fs/op ──
      // body {cwd, op, ...}，供文件树的新建/重命名/删除：
      //   create {dir, name, kind?:'dir'}  在 dir 下新建空文件/文件夹（已存在报错）
      //   rename {path, name}              同目录内重命名（目标已存在报错）
      //   delete {path}                    删除；Windows 移入回收站，其它平台直接递归删。
      //                                    破坏性操作，前端已二次确认。
      // 校验链与 /write 一致：同源（POST 必须带 Origin 且匹配 Host）→ 目标必须位于
      // realpath(cwd) 子树内（工作区根本身不可改删）→ 名称过 invalidFsName 校验。
      const disposeFsOp = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/fs/op',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (!sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          let raw = ''
          req.on('data', (c) => {
            raw += c
            if (raw.length > 65536) req.destroy()
          })
          req.on('end', async () => {
            let body
            try {
              body = JSON.parse(raw)
            } catch {
              json(400, { error: 'bad json' })
              return
            }
            const dir = validateCwd(String(body?.cwd ?? ''))
            if (!dir.ok) {
              json(400, { error: dir.message })
              return
            }
            const op = String(body?.op ?? '')

            if (op === 'create') {
              const pdir = validateCwd(String(body?.dir ?? ''))
              if (!pdir.ok) {
                json(400, { error: pdir.message })
                return
              }
              // 新建的父目录允许就是工作区根本身（与改名/删除的 withinTree 不同）
              const relDir = path.relative(dir.path, pdir.path)
              if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
                json(400, { error: '目标目录不在当前工作区内' })
                return
              }
              if (invalidFsName(body?.name)) {
                json(400, { error: '名称非法：不能为空、含路径分隔符/特殊字符或首尾空白' })
                return
              }
              const name = String(body.name).trim()
              const target = path.join(pdir.path, name)
              let existed = true
              try {
                fs.statSync(target)
              } catch {
                existed = false
              }
              if (existed) {
                json(400, { error: `已存在：${name}` })
                return
              }
              if (body.kind === 'dir') {
                fs.mkdir(target, (mkError) => {
                  if (mkError) {
                    json(500, { error: `创建文件夹失败：${mkError?.message ?? mkError}` })
                    return
                  }
                  json(200, { ok: true, path: target })
                })
              } else {
                fs.writeFile(target, '', { flag: 'wx' }, (wError) => {
                  if (wError) {
                    json(500, { error: `创建文件失败：${wError?.message ?? wError}` })
                    return
                  }
                  json(200, { ok: true, path: target })
                })
              }
              return
            }

            const any = validateAny(String(body?.path ?? ''))
            if (!any.ok) {
              json(400, { error: any.message })
              return
            }
            if (!withinTree(dir.path, any.path)) {
              json(400, { error: '目标不在当前工作区内' })
              return
            }

            if (op === 'rename') {
              if (invalidFsName(body?.name)) {
                json(400, { error: '名称非法：不能为空、含路径分隔符/特殊字符或首尾空白' })
                return
              }
              const name = String(body.name).trim()
              const target = path.join(path.dirname(any.path), name)
              let clash = false
              try {
                fs.statSync(target)
                clash = true
              } catch {}
              if (clash) {
                json(400, { error: `目标已存在：${name}` })
                return
              }
              fs.rename(any.path, target, (rError) => {
                if (rError) {
                  json(500, { error: `重命名失败：${rError?.message ?? rError}` })
                  return
                }
                json(200, { ok: true, path: target })
              })
              return
            }

            if (op === 'delete') {
              const gone = await recycleDelete(any.path, any.stat.isDirectory())
              if (!gone) {
                if (process.platform !== 'win32') {
                  // 无回收站 API 的平台：退回直接删除
                  try {
                    await fs.promises.rm(any.path, { recursive: true })
                  } catch (dError) {
                    json(500, { error: `删除失败：${dError?.message ?? dError}` })
                    return
                  }
                } else {
                  json(500, { error: '移入回收站失败（文件可能被占用或路径过长）' })
                  return
                }
              }
              json(200, { ok: true })
              return
            }

            json(400, { error: 'unknown op' })
          })
        },
      })

      // ── git 联动端点 ──
      // spawn git CLI（不引库）；无 git / 非仓库 / 超时统一回 {available:false}，
      // 前端据此隐藏入口。status 供文件树徽标与分支/领先信息，diff 供预览面板
      // 查看改动，log/show/branch 供提交图谱与分支管理，init/op 是写操作集。
      const GIT_TIMEOUT = 10000
      /** 推送等网络操作允许更长的等待（默认 10s 会误杀慢推） */
      const PUSH_TIMEOUT = 60000
      /** 跑一条 git 命令；任何失败（ENOENT/非零/超时）都 resolve {ok:false} */
      const runGit = (args, cwdDir, timeoutMs = GIT_TIMEOUT) =>
        new Promise((resolve) => {
          let child
          try {
            child = spawn('git', args, { cwd: cwdDir, windowsHide: true })
          } catch {
            resolve({ ok: false, out: '', err: '' })
            return
          }
          let out = ''
          let err = ''
          let settled = false
          const timer = setTimeout(() => {
            try {
              child.kill()
            } catch {}
            finish(false)
          }, timeoutMs)
          const finish = (ok) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ ok, out, err })
          }
          child.stdout?.on('data', (d) => {
            out += d
          })
          child.stderr?.on('data', (d) => {
            err += d
          })
          child.on('error', () => finish(false))
          child.on('close', (code) => finish(code === 0))
        })
      /** cwd 的 git 项目根；非仓库返回 null */
      const gitRootFor = (realCwd) => {
        const root = findProjectRoot(realCwd)
        try {
          return fs.existsSync(path.join(root, '.git')) ? root : null
        } catch {
          return null
        }
      }

      // GET /dsh-kit/git/status?cwd=<绝对目录> →
      //   {available:true, root, entries:[{xy,path:<相对root>,abs}]} | {available:false}
      const disposeGitStatus = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/status',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('cwd') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          const root = gitRootFor(dir.path)
          if (!root) {
            json(200, { available: false })
            return
          }
          ;(async () => {
            // core.quotePath=false：porcelain 对非 ASCII 路径默认输出带引号的八进制
            // 转义（如 "\346\234\233..."），关掉后输出原始 UTF-8 路径
            const r = await runGit(['-c', 'core.quotePath=false', 'status', '--porcelain', '-b'], root)
            if (!r.ok) {
              json(200, { available: false })
              return
            }
            const entries = []
            const untrackedDirs = []
            // -b 的首行是分支摘要（## main...origin/main [ahead 1]），单独解析；
            // 其余行不会出现 "##" 前缀（条目 xy 至多两位），不干扰条目解析
            const branchInfo = { branch: '', upstream: null, ahead: 0, behind: 0, gone: false, detached: false, unborn: false }
            for (const line of r.out.split('\n')) {
              if (line.startsWith('##')) {
                Object.assign(branchInfo, parseStatusBranch(line))
                continue
              }
              if (line.length <= 3) continue
              const xy = line.slice(0, 2)
              let p = line.slice(3).trimEnd()
              // 重命名行取 "old -> new" 的新路径
              const arrow = p.indexOf(' -> ')
              if (arrow >= 0) p = p.slice(arrow + 4)
              // 整个目录未跟踪时 porcelain 只给 '?? dir/'——展开为其中的具体文件，
              // 否则前端会拿目录路径去当文件预览/diff（报"不是文件"）
              if (xy === '??' && /[\\/]$/.test(p)) {
                untrackedDirs.push(p.replace(/[\\/]+$/, ''))
                continue
              }
              entries.push({ xy, path: p, abs: path.join(root, p) })
            }
            if (untrackedDirs.length > 0) {
              const u = await runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', ...untrackedDirs], root)
              if (u.ok) {
                for (const f of u.out.split('\n')) {
                  const relFile = f.trim()
                  if (relFile === '') continue
                  entries.push({ xy: '??', path: relFile, abs: path.join(root, relFile) })
                }
              }
            }
            // ±N 行数统计：一次 numstat 相对 HEAD 合并进条目（未跟踪文件不在其中，
            // 无统计；二进制行为 "- - path" 跳过；重命名路径格式特殊，允许缺失）
            const n = await runGit(['-c', 'core.quotePath=false', 'diff', 'HEAD', '--numstat'], root)
            if (n.ok) {
              const statMap = new Map()
              for (const line of n.out.split('\n')) {
                const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
                if (!m || m[1] === '-' || m[2] === '-') continue
                statMap.set(m[3], { a: Number(m[1]), d: Number(m[2]) })
              }
              for (const e of entries) e.stats = statMap.get(e.path) ?? null
            }
            json(200, { available: true, root, entries, ...branchInfo })
          })()
        },
      })

      // GET /dsh-kit/git/diff?path=<绝对文件>&cwd=<工作目录> →
      //   {available:true, diff:<原文>}——基线为 git diff HEAD，即相对上次提交的
      //   全部未提交改动（含已暂存）；未跟踪 {available:true, untracked:true}；
      //   无变更 {available:true, clean:true}
      const disposeGitDiff = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/diff',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('cwd') ?? '')
          const file = validateFile(url.searchParams.get('path') ?? '')
          if (!dir.ok || !file.ok) {
            json(400, { error: !dir.ok ? dir.message : file.message })
            return
          }
          const root = gitRootFor(dir.path)
          if (!root) {
            json(200, { available: false })
            return
          }
          const rel = path.relative(root, file.path)
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            json(400, { error: '文件不在项目根内' })
            return
          }
          runGit(['status', '--porcelain', '--', rel], root).then((st) => {
            if (!st.ok) {
              json(200, { available: false })
              return
            }
            const line = st.out.split('\n').find((l) => l.length > 3)
            if (!line) {
              json(200, { available: true, clean: true })
              return
            }
            if (line.startsWith('?')) {
              json(200, { available: true, untracked: true })
              return
            }
            runGit(['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', rel], root).then((d) => {
              json(200, { available: true, xy: line.slice(0, 2), diff: d.ok ? d.out : null })
            })
          })
        },
      })

      // POST /dsh-kit/git/init {cwd}：在目录初始化仓库（仅当尚无 .git 时执行；
      // 已是仓库则幂等返回 created:false）。供源代码管理视图的空态按钮使用。
      const disposeGitInit = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/init',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (!sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          let raw = ''
          req.on('data', (c) => {
            raw += c
            if (raw.length > 4096) req.destroy()
          })
          req.on('end', async () => {
            let body
            try {
              body = JSON.parse(raw)
            } catch {
              json(400, { error: 'bad json' })
              return
            }
            const dir = validateCwd(String(body?.cwd ?? ''))
            if (!dir.ok) {
              json(400, { error: dir.message })
              return
            }
            if (gitRootFor(dir.path)) {
              json(200, { created: false, root: dir.path })
              return
            }
            const r = await runGit(['init'], dir.path)
            if (!r.ok) {
              json(500, { error: `git init 失败：${r.err || r.out || 'unknown'}` })
              return
            }
            json(200, { created: true, root: dir.path })
          })
        },
      })

      // POST /dsh-kit/git/op {cwd, op, path?, message?, all?, ...}：源代码管理的写操作集
      //   stage(path)      = git add -- <rel>
      //   unstage(path)    = git restore --staged -- <rel>
      //   discard(path)    = git restore -- <rel>（放弃未暂存改动，破坏性；前端已二次确认）
      //   stageAll         = git add -A
      //   commit(message, all?) = 可选先 add -A（暂存区为空时的"提交全部"），再 commit -m
      //   push(upstream?, remote?) = git push（upstream:true → push -u <remote> <当前分支>）
      //   branchCreate(name, switch?) = git branch <name> 或 git switch -c <name>
      //   branchSwitch(name) = git switch <name>
      //   branchDelete(name, force?) = git branch -d|-D <name>（当前分支拒绝）
      // 分支名一律作为单个 argv 元素传入（无 shell 注入面）并经
      // git check-ref-format --branch 校验；push 网络操作走 PUSH_TIMEOUT 长超时。
      const disposeGitOp = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/op',
        handler: async (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (!sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          let raw = ''
          req.on('data', (c) => {
            raw += c
            if (raw.length > 65536) req.destroy()
          })
          req.on('end', async () => {
            let body
            try {
              body = JSON.parse(raw)
            } catch {
              json(400, { error: 'bad json' })
              return
            }
            const dir = validateCwd(String(body?.cwd ?? ''))
            if (!dir.ok) {
              json(400, { error: dir.message })
              return
            }
            const root = gitRootFor(dir.path)
            if (!root) {
              json(400, { error: '不是 git 仓库' })
              return
            }
            const op = String(body?.op ?? '')
            const pathOp = op === 'stage' || op === 'unstage' || op === 'discard'
            let rel = null
            if (pathOp) {
              const file = validateFile(String(body?.path ?? ''))
              if (!file.ok) {
                json(400, { error: file.message })
                return
              }
              rel = path.relative(root, file.path)
              if (rel.startsWith('..') || path.isAbsolute(rel)) {
                json(400, { error: '文件不在项目根内' })
                return
              }
            }
            let r
            if (op === 'stage') r = await runGit(['add', '--', rel], root)
            else if (op === 'unstage') r = await runGit(['restore', '--staged', '--', rel], root)
            else if (op === 'discard') r = await runGit(['restore', '--', rel], root)
            else if (op === 'stageAll') r = await runGit(['add', '-A'], root)
            else if (op === 'commit') {
              const msg = String(body?.message ?? '').trim()
              if (msg === '') {
                json(400, { error: '缺少提交信息' })
                return
              }
              if (body.all === true) await runGit(['add', '-A'], root)
              r = await runGit(['commit', '-m', msg], root)
              if (!r.ok && /nothing to commit/i.test(r.err + r.out)) {
                json(200, { ok: true, empty: true })
                return
              }
            } else if (op === 'push') {
              // 默认沿用分支已有上游（git push）；upstream:true 显式设置上游，
              // remote 缺省 origin 且必须在 git remote 列表内（防乱传参）
              if (body.upstream === true) {
                const remote = String(body?.remote ?? 'origin').trim()
                if (remote === '' || /[/\\]/.test(remote) || remote.includes('..')) {
                  json(400, { error: '远程名非法' })
                  return
                }
                const rem = await runGit(['remote'], root)
                if (!rem.ok || !rem.out.split('\n').map((s) => s.trim()).includes(remote)) {
                  json(400, { error: `没有远程 ${remote}（git remote -v 查看，git remote add 新建）` })
                  return
                }
                const cur = await runGit(['branch', '--show-current'], root)
                const branch = cur.ok ? cur.out.trim() : ''
                if (branch === '') {
                  json(400, { error: '当前不在任何分支上（分离头无法设置上游）' })
                  return
                }
                r = await runGit(['push', '-u', remote, branch], root, PUSH_TIMEOUT)
              } else {
                r = await runGit(['push'], root, PUSH_TIMEOUT)
              }
            } else if (op === 'branchCreate' || op === 'branchSwitch' || op === 'branchDelete') {
              const name = String(body?.name ?? '').trim()
              if (name === '') {
                json(400, { error: '缺少分支名' })
                return
              }
              const v = await runGit(['check-ref-format', '--branch', name], root)
              if (!v.ok) {
                json(400, { error: `分支名非法：${name}` })
                return
              }
              if (op === 'branchCreate') {
                if (body.switch === true) r = await runGit(['switch', '-c', name], root)
                else r = await runGit(['branch', name], root)
              } else if (op === 'branchSwitch') {
                r = await runGit(['switch', name], root)
              } else {
                const cur = await runGit(['branch', '--show-current'], root)
                if (cur.ok && cur.out.trim() === name) {
                  json(400, { error: '不能删除当前所在分支' })
                  return
                }
                r = await runGit(['branch', body.force === true ? '-D' : '-d', name], root)
              }
            } else {
              json(400, { error: 'unknown op' })
              return
            }
            if (!r.ok) {
              json(500, { error: `git ${op} 失败：${(r.err || r.out || '').trim()}` })
              return
            }
            json(200, { ok: true })
          })
        },
      })

      // GET /dsh-kit/git/log?cwd=<绝对目录>&n=<条数> → 提交图谱
      //   {available:true, root, lines:[{g,H,h,an,ad,s,d}]} | {available:false}
      //   g=图谱 ASCII 前缀（来自 git log --graph；纯连线续行只有 g），
      //   d=%D 引用装饰原文；n 默认 120、上限 500；空库（尚无提交）→ lines:[]。
      const LOG_DEFAULT = 120
      const LOG_MAX = 500
      const disposeGitLog = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/log',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('cwd') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          const root = gitRootFor(dir.path)
          if (!root) {
            json(200, { available: false })
            return
          }
          let n = Number(url.searchParams.get('n') ?? LOG_DEFAULT)
          if (!Number.isInteger(n) || n < 1) n = LOG_DEFAULT
          if (n > LOG_MAX) n = LOG_MAX
          runGit(
            ['-c', 'core.quotePath=false', 'log', '--all', '--date-order', '--graph', `--max-count=${n}`,
              '--pretty=format:%x1f%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D', '--date=format:%Y-%m-%d %H:%M'],
            root,
          ).then((r) => {
            if (!r.ok) {
              // 空库不是错误：git log 报 "does not have any commits yet"
              if (/does not have any commits/i.test(r.err + r.out)) {
                json(200, { available: true, root, lines: [] })
                return
              }
              json(200, { available: false })
              return
            }
            json(200, { available: true, root, lines: parseLogGraph(r.out) })
          })
        },
      })

      // GET /dsh-kit/git/show?cwd=<绝对目录>&commit=<哈希/引用> → 单个提交详情
      //   {available:true, meta:{H,h,an,ae,ad,parents,s,b}, files:[{st,path,abs}]}
      //   files 来自 diff-tree --name-status（合并提交无文件清单）；commit 先经
      //   rev-parse 校验，伪造/不存在回 400。
      const disposeGitShow = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/show',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('cwd') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          const root = gitRootFor(dir.path)
          if (!root) {
            json(200, { available: false })
            return
          }
          const commit = String(url.searchParams.get('commit') ?? '').trim()
          if (commit === '' || commit.length > 200 || /[\u0000-\u001f]/.test(commit)) {
            json(400, { error: '缺少合法的提交引用' })
            return
          }
          runGit(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], root).then((rv) => {
            const full = rv.ok ? rv.out.trim() : ''
            if (!/^[0-9a-f]{40}$/.test(full)) {
              json(400, { error: '提交不存在：' + commit })
              return
            }
            Promise.all([
              runGit(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b', full], root),
              runGit(['-c', 'core.quotePath=false', 'diff-tree', '--no-commit-id', '--name-status', '-r', '--root', full], root),
            ]).then(([show, dt]) => {
              if (!show.ok) {
                json(200, { available: false })
                return
              }
              const f = show.out.split('\n')[0].split('\x1f')
              const meta = {
                H: f[0] || '',
                h: f[1] || '',
                an: f[2] || '',
                ae: f[3] || '',
                ad: f[4] || '',
                parents: f[5] || '',
                s: f[6] || '',
                b: f.slice(7).join('\x1f').trim(),
              }
              const files = []
              if (dt.ok) {
                for (const line of dt.out.split('\n')) {
                  const tab = line.indexOf('\t')
                  if (tab < 0) continue
                  const st = line.slice(0, tab)[0] || ''
                  const rest = line.slice(tab + 1)
                  let p = rest
                  if (st === 'R' || st === 'C') {
                    const arrow = rest.indexOf('\t')
                    if (arrow < 0) continue
                    p = rest.slice(arrow + 1) // 重命名/复制取新路径
                  }
                  if (p === '') continue
                  const abs = path.join(root, p)
                  const rel = path.relative(root, abs)
                  if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                  files.push({ st, path: p, abs })
                }
              }
              json(200, { available: true, meta, files })
            })
          })
        },
      })

      // GET /dsh-kit/git/branch?cwd=<绝对目录> → 本地分支列表
      //   {available:true, current, branches:[{name,isHead,upstream,track,trackParsed}]}
      //   trackParsed 由 parseTrack 归一（{ahead,behind,gone}|null），前端直接展示；
      //   分离头时 current 为 "(HEAD detached at ...)" 伪条目。
      const disposeGitBranch = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/git/branch',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const dir = validateCwd(url.searchParams.get('cwd') ?? '')
          if (!dir.ok) {
            json(400, { error: dir.message })
            return
          }
          const root = gitRootFor(dir.path)
          if (!root) {
            json(200, { available: false })
            return
          }
          // 注意：for-each-ref 的 --format 不做 %xx 转义（与 log --pretty 不同），
          // 分隔符必须传真实字符（0x1F，与 parseBranchList 的 LOG_FS 一致）
          const branchFormat = '%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)'
          runGit(['branch', '--format=' + branchFormat], root).then((r) => {
            if (!r.ok) {
              json(200, { available: false })
              return
            }
            const parsed = parseBranchList(r.out)
            json(200, {
              available: true,
              current: parsed.current ? parsed.current.name : null,
              branches: parsed.branches.map((b) => ({
                name: b.name,
                isHead: b.isHead,
                upstream: b.upstream === '' ? null : b.upstream,
                track: b.track,
                trackParsed: b.upstream === '' ? null : parseTrack(b.track),
              })),
            })
          })
        },
      })

      // ── 终端 WebSocket 端点 ──
      // 一条 WS 连接 = 一个 pty 会话；连接关闭即杀进程（面板语义见文件头注释）。
      let disposeUpgrade = null
      let disposeHttp = null
      if (pty && WebSocketServer) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

        wss.on('connection', (ws) => {
          let proc = null
          let dead = false
          const send = (obj) => {
            if (!dead && ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify(obj))
              } catch {
                // 连接正在断开，忽略
              }
            }
          }

          ws.on('message', (raw) => {
            let msg
            try {
              msg = JSON.parse(String(raw))
            } catch {
              return
            }
            if (!msg || typeof msg !== 'object') return

            if (msg.t === 'init') {
              if (proc) return
              const dir = validateCwd(msg.cwd)
              if (!dir.ok) {
                send({ t: 'error', message: dir.message })
                ws.close(1008, 'invalid cwd')
                return
              }
              const shell = resolveShell()
              const cols = clampDim(msg.cols, 2, 500, 80)
              const rows = clampDim(msg.rows, 2, 300, 24)
              try {
                proc = pty.spawn(shell.file, shell.args, {
                  name: 'xterm-256color',
                  cols,
                  rows,
                  cwd: dir.path,
                  env: { ...process.env, TERM: 'xterm-256color' },
                })
              } catch (error) {
                send({ t: 'error', message: `启动 shell 失败：${error?.message ?? error}` })
                ws.close(1011, 'spawn failed')
                return
              }
              send({ t: 'started', shell: shell.label, cwd: dir.path })
              proc.onData((data) => send({ t: 'o', d: data }))
              proc.onExit(({ exitCode }) => {
                send({ t: 'exit', exitCode })
                try {
                  ws.close(1000, 'exited')
                } catch {
                  // 已关闭
                }
              })
              return
            }

            if (!proc) return
            if (msg.t === 'i' && typeof msg.d === 'string') {
              proc.write(msg.d)
            } else if (msg.t === 'r') {
              try {
                proc.resize(clampDim(msg.cols, 2, 500, 80), clampDim(msg.rows, 2, 300, 24))
              } catch {
                // 进程可能刚退出
              }
            }
          })

          ws.on('close', () => {
            dead = true
            if (proc) {
              try {
                proc.kill()
              } catch {
                // 已退出
              }
              proc = null
            }
          })
          ws.on('error', () => {
            // close 会跟着来
          })
        })

        disposeUpgrade = webCtx.webServer.registerUpgrade({
          path: '/dsh-kit/terminal',
          handler: (req, socket, head) => {
            if (!sameOrigin(req)) {
              socket.destroy()
              return
            }
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
          },
        })

        // 纯 HTTP 探测时给出明确提示（也方便确认端点存在）
        disposeHttp = webCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-kit/terminal',
          handler: (_req, res) => {
            res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('dsh-kit terminal: WebSocket Upgrade Required')
          },
        })
      }

      // ── 手机访问网关（src/phone-gateway.js）──
      // 网关启用位以状态文件直管（loadGatewayState/enabled 字段）：settings 读取器
      // 回填有时序滞后（实测开关写了但 reader 仍报旧值，重进设置页"恢复未开启"），
      // 手机访问页的启停按钮走 /dsh-kit/phone/gateway 端点，不经过 settings。
      // phoneEnabled 只管页面入口可见性，与网关启停解耦。
      const stateFile = defaultStateFile()
      const pageVisible = () => readSettings().phoneEnabled === true
      const phoneRemoteDomain = () => String(readSettings().phoneRemoteDomain ?? '').trim()
      /** 网关端口：设置里读，缺失/非法回落默认 3090 */
      const phonePort = () => {
        const n = readSettings().phonePort
        return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : PHONE_PORT
      }
      /** 重启后保留开启：勾选时启动才恢复上次启用位；不勾=每次启动网关都是关的 */
      const phoneKeepGatewayOn = () => readSettings().phoneKeepGatewayOn === true
      const warnLog = (msg) => console.warn(`dsh-kit: ${msg}`)
      // dsh web ≥ v0.1.2-alpha.5 的浏览器鉴权：网关反代须自带签名会话 cookie，
      // 否则手机端访问 index 一律 401。密钥即 credentials 服务的
      // client-connection/browser-session 记录（与 dsh web 共享），b64url 解码回
      // 32 字节原始密钥。读不到时按降级处理：网关其余功能不受影响，仅手机访问 401。
      let dshSessionSecret = null
      const loadDshSessionSecret = () => {
        try {
          const creds = webCtx.credentials
          if (!creds || typeof creds.readRecord !== 'function') return
          creds.readRecord('client-connection/browser-session').then((record) => {
            const payload = record?.payload
            if (record?.kind !== 'grant' || !payload || payload.version !== 1 || typeof payload.secret !== 'string' || payload.secret === '') {
              warnLog('浏览器会话密钥记录不可用，手机访问将显示 401（网关其余功能正常）')
              return
            }
            const pad = '='.repeat((4 - (payload.secret.length % 4)) % 4)
            const raw = Buffer.from(payload.secret.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64')
            if (raw.length !== 32) {
              warnLog(`浏览器会话密钥长度异常（${raw.length}B），手机访问将显示 401（网关其余功能正常）`)
              return
            }
            dshSessionSecret = raw
          }, (error) => {
            warnLog(`读取浏览器会话密钥失败：${error?.message ?? error}，手机访问将显示 401（网关其余功能正常）`)
          })
        } catch (error) {
          warnLog(`读取浏览器会话密钥失败：${error?.message ?? error}，手机访问将显示 401（网关其余功能正常）`)
        }
      }
      loadDshSessionSecret()
      let phoneGw = null
      let phoneGwError = null
      const bootGwState = loadGatewayState(stateFile, warnLog)
      // 启动评估（phoneGwWanted）和首次 syncPhoneGateway 由 onSettingsReady 执行：
      // readSettings 在 setSource 回调前是空函数，phoneKeepGatewayOn() 恒 false。
      // 若 setSource 已经触发（phoneSettingsReady===true）则在注入段末尾立即评估；
      // 否则等 onSettingsReady 回调。
      let phoneGwWanted = false
      /** 由首次 onSettingsReady 或注入段末尾（phoneSettingsReady 已为 true 时）调用 */
      const bootEvalGateway = () => {
        phoneGwWanted = phoneKeepGatewayOn() && bootGwState.enabled === true
        if (bootGwState.enabled !== phoneGwWanted) {
          saveGatewayState(stateFile, { token: bootGwState.token, enabled: phoneGwWanted }, warnLog)
        }
        syncPhoneGateway()
      }
      onSettingsReady = () => { bootEvalGateway() }
      /** 现役实例监听的端口；null = 无实例。用于识别端口配置变更 */
      let gwPort = null
      /** 按当前启用位同步网关启停 */
      const syncPhoneGateway = () => {
        // 端口配置变更：关掉旧端口的现役实例，走下方重启动路径按新端口起步
        if (phoneGw !== null && gwPort !== null && gwPort !== phonePort()) {
          try {
            phoneGw.close()
          } catch {
            // 死实例 close 可能抛错，忽略
          }
          phoneGw = null
          phoneGwError = null
        }
        // 启动失败（如端口被占）后 phoneGw 仍持有已死实例且 state().error 落定，
        // 若只判 phoneGw === null 会永远跳过重试——带 error 的实例视为死实例，
        // 先关掉清空再重新起步。
        if (phoneGwWanted && (phoneGw === null || phoneGw.state().error !== null)) {
          if (phoneGw !== null) {
            try {
              phoneGw.close()
            } catch {
              // 死实例 close 可能抛错，忽略
            }
            phoneGw = null
            phoneGwError = null
          }
          try {
            gwPort = phonePort()
            phoneGw = startPhoneGateway({ port: gwPort, upstreamPort: webCtx.webServer.port, log: warnLog, sessionSecret: () => dshSessionSecret })
            phoneGwError = null
          } catch (error) {
            gwPort = null
            phoneGwError = String(error?.message ?? error)
            warnLog(`手机访问网关启动失败：${phoneGwError}`)
          }
        } else if (!phoneGwWanted && phoneGw !== null) {
          phoneGw.close()
          phoneGw = null
        }
      }
      // 若 setSource 已触发（phoneSettingsReady===true），本轮注入段末尾立即评估；
      // 否则等 onSettingsReady（setSource 首次调用）。二选一防止首次启动双重调用。
      if (phoneSettingsReady) {
        bootEvalGateway()
      }
      // 设置变更联动：端口改了就热重启（其余键的写入也走这里，sync 幂等无副作用）
      onSettingsChanged = () => {
        syncPhoneGateway()
      }
      /** 改启用位（持久化到状态文件 + 热启停）；由 /dsh-kit/phone/gateway 端点调用。
       *  令牌轮换不再随启停自动发生——页内「刷新链接」按钮经 rotate 端点手动触发，
       *  重启/重开沿用同一令牌（已授权设备不掉线） */
      const setGatewayEnabled = (on) => {
        phoneGwWanted = on === true
        const token = phoneGw ? phoneGw.token() : loadGatewayState(stateFile, warnLog).token
        saveGatewayState(stateFile, { token, enabled: phoneGwWanted }, warnLog)
        syncPhoneGateway()
      }
      /** 带令牌的可扫码链接：局域网每个 IPv4 一条 + 远程域名（配置了才有） */
      const phoneLinks = () => {
        if (!phoneGw) return []
        const k = encodeURIComponent(phoneGw.token())
        const links = lanAddresses().map((ip) => ({ label: 'lan', url: `http://${ip}:${phonePort()}/?k=${k}` }))
        if (phoneRemoteDomain() !== '') {
          links.push({ label: 'remote', url: `https://${phoneRemoteDomain()}/?k=${k}` })
        }
        return links
      }
      const phoneJson = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      /** GET 类守卫：同源 fetch 的 GET 可能不带 Origin，带了就必须匹配 Host */
      const phoneGuardGet = (req, res) => {
        const origin = req.headers.origin
        if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
          phoneJson(res, 403, { error: 'cross-origin denied' })
          return false
        }
        if (req.method !== 'GET') {
          phoneJson(res, 405, { error: 'method not allowed' })
          return false
        }
        return true
      }
      const disposePhoneInfo = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/phone/info',
        handler: (req, res) => {
          if (!phoneGuardGet(req, res)) return
          phoneJson(res, 200, {
            visible: pageVisible(),
            gatewayOn: phoneGwWanted,
            running: phoneGw !== null && phoneGw.state().listening,
            error: phoneGwError ?? phoneGw?.state().error ?? null,
            port: phoneGw ? (phoneGw.port() ?? phonePort()) : phonePort(),
            remoteDomain: phoneRemoteDomain(),
            fingerprint: phoneGw ? phoneGw.fingerprint() : null,
          })
        },
      })
      const disposePhoneLink = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/phone/link',
        handler: (req, res) => {
          if (!phoneGuardGet(req, res)) return
          // 死实例（启动失败/端口被占）不出链接：扫了也是连不上
          if (!phoneGw || !phoneGw.state().listening) {
            phoneJson(res, 409, { error: phoneGwError ?? phoneGw?.state().error ?? 'gateway disabled' })
            return
          }
          phoneJson(res, 200, { links: phoneLinks(), fingerprint: phoneGw.fingerprint() })
        },
      })
      // 手动轮换端点：页内「刷新链接」按钮（+ 脚本/异常场景）作废旧链接用。
      // 启停不再自动轮换——见 setGatewayEnabled。
      const disposePhoneRotate = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/phone/rotate',
        handler: (req, res) => {
          // POST 走 JSON content-type：跨源必触发 CORS 预检被拦，Origin 存在时
          // 仍做同源校验（剥 Origin 的网关链路也能用）
          if (req.method !== 'POST') {
            phoneJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (req.headers.origin !== undefined && !sameOrigin(req)) {
            phoneJson(res, 403, { error: 'cross-origin denied' })
            return
          }
          if (!phoneGw || !phoneGw.state().listening) {
            phoneJson(res, 409, { error: phoneGwError ?? phoneGw?.state().error ?? 'gateway disabled' })
            return
          }
          phoneGw.rotate()
          phoneJson(res, 200, { links: phoneLinks(), fingerprint: phoneGw.fingerprint() })
        },
      })
      const disposePhoneGateway = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/phone/gateway',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            phoneJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (req.headers.origin !== undefined && !sameOrigin(req)) {
            phoneJson(res, 403, { error: 'cross-origin denied' })
            return
          }
          let raw = ''
          req.on('data', (c) => { raw += c.toString('utf8') })
          req.on('end', () => {
            let on = null
            try {
              on = JSON.parse(raw || '{}').on
            } catch {
              on = null
            }
            if (typeof on !== 'boolean') {
              phoneJson(res, 400, { error: 'body 需 {"on": true|false}' })
              return
            }
            setGatewayEnabled(on)
            // server.listen/close 是异步的：listening/error 事件在下一轮事件
            // 循环才触发，立即读 state() 会拿到旧值——实测启停回包恒报
            // running:false + error:null（前端显示"网关未运行：unknown"）。
            // 轮询到状态落定（目标达成 / 出错 / 500ms 超时）再回包。
            const t0 = Date.now()
            const settle = () => {
              const gw = phoneGw
              const running = gw !== null && gw.state().listening
              const error = phoneGwError ?? gw?.state().error ?? null
              if (running === on || error !== null || Date.now() - t0 >= 500) {
                phoneJson(res, 200, { gatewayOn: phoneGwWanted, running, error })
                return
              }
              setTimeout(settle, 30)
            }
            settle()
          })
        },
      })

      // ── 后台任务控制端点 ──
      // 浏览器半边「任务」面板（运行中任务 + 结束 + 输出）的数据源是官方
      // session/jobs 推送（只带元数据，无输出正文）；这里补两个操作口：
      //   1) POST /dsh-kit/jobs/kill    body {sessionId, jobId} —— 结束任务
      //   2) GET  /dsh-kit/jobs/output?sessionId=&jobId= —— 增量读输出
      // 权限对齐官方 job_kill/job_output 工具：caller 必须是任务所属 session 的
      // agent（jobs-local assertAccess 校验 owner.id === caller.id），做不到的
      // 请求（跨会话/未知任务）抛错 → 404/403。jobs 服务缺失（宿主组合没挂
      // dsh-jobs-local）时能力整体不可用，返回 503。
      const disposeJobsKill = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/jobs/kill',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'POST') {
            json(405, { error: 'method not allowed' })
            return
          }
          if (req.headers.origin !== undefined && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          let raw = ''
          req.on('data', (c) => { raw += c.toString('utf8') })
          req.on('end', () => {
            let body
            try {
              body = JSON.parse(raw || '{}')
            } catch {
              json(400, { error: 'bad json' })
              return
            }
            const sessionId = String(body?.sessionId ?? '')
            const jobId = String(body?.jobId ?? '')
            if (sessionId === '' || jobId === '') {
              json(400, { error: '需要 sessionId 与 jobId' })
              return
            }
            if (!jobsRegistry || !agentsRegistry) {
              json(503, { error: '后台任务能力不可用（jobs/agents 服务缺失）' })
              return
            }
            const caller = agentsRegistry.get(sessionId)
            if (!caller) {
              json(404, { error: '会话不存在（本任务面板只操作当前会话的后台任务）' })
              return
            }
            try {
              const outcome = jobsRegistry.kill(jobId, caller, 'user requested via task panel')
              json(200, {
                outcome: outcome === 'already-finished' ? 'already-finished' : 'cancellation-requested',
                jobId,
              })
            } catch (error) {
              json(404, { error: String(error?.message ?? error) })
            }
          })
        },
      })
      const disposeJobsOutput = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/jobs/output',
        handler: (req, res) => {
          const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') {
            json(405, { error: 'method not allowed' })
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && !sameOrigin(req)) {
            json(403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const jobId = url.searchParams.get('jobId') ?? ''
          if (sessionId === '' || jobId === '') {
            json(400, { error: '需要 sessionId 与 jobId' })
            return
          }
          if (!jobsRegistry || !agentsRegistry) {
            json(503, { error: '后台任务能力不可用（jobs/agents 服务缺失）' })
            return
          }
          const caller = agentsRegistry.get(sessionId)
          if (!caller) {
            json(404, { error: '会话不存在（本任务面板只操作当前会话的后台任务）' })
            return
          }
          try {
            // read 返回增量（自上次读取以来），与 job_output 工具共享同一游标；
            // 快照里的 status/detail 用于前端判断终态与停止轮询。
            const read = jobsRegistry.read(jobId, caller)
            json(200, {
              text: read.text,
              job: {
                id: read.snapshot.id,
                kind: read.snapshot.kind,
                label: read.snapshot.label,
                status: read.snapshot.status,
                ...(read.snapshot.detail !== undefined ? { detail: read.snapshot.detail } : {}),
                startedAt: read.snapshot.startedAt,
                ...(read.snapshot.finishedAt !== undefined ? { finishedAt: read.snapshot.finishedAt } : {}),
              },
            })
          } catch (error) {
            json(404, { error: String(error?.message ?? error) })
          }
        },
      })

      return () => {
        disposeVendor()
        disposeTree()
        disposeRead()
        disposeRaw()
        disposeWrite()
        disposeUpload()
        disposeFsOp()
        disposeGitStatus()
        disposeGitDiff()
        disposeGitInit()
        disposeGitOp()
        disposeGitLog()
        disposeGitShow()
        disposeGitBranch()
        if (disposeHttp) disposeHttp()
        if (disposeUpgrade) disposeUpgrade()
        disposePhoneInfo()
        disposePhoneLink()
        disposePhoneRotate()
        disposePhoneGateway()
        disposeJobsKill()
        disposeJobsOutput()
        if (phoneGw) phoneGw.close()
      }
    }, 'dsh-kit: terminal/vendor/tree/read/write/upload/fs-op/git/phone endpoints')
  })
}
