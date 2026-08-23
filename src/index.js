// dsh-kit — DSH 页面能力插件包（宿主半边）
//
// 当前能力：
//   终端（terminal）——见下方协议注释；
//   文件树（file tree）——GET /dsh-kit/tree?path=<绝对目录> 返回该层
//     目录+文件的 JSON 列表（官方 browse RPC 只列目录不列文件，故自建）；
//   文件预览（file preview）——GET /dsh-kit/read?path=<绝对文件> 读取文本
//     内容（限长 + 二进制探测），浏览器端在右侧 details 列展示。
//
// 浏览器半边（client/bundle.js）：终端/文件树入口按钮注册在对话输入框工具行
// （conversation.input.left），面板本体挂 shell.overlay 全帧浮层；终端开合底部
// 停靠面板（Ctrl+`），文件树临时接管侧边栏浏览区（sidebar.workspaces 单槽）。
// 插件设置卡（dsh-kit 命名空间，settings.plugin.item）提供功能开关与快捷键自定义。
//
// 宿主半边（本文件）挂四个端点（webserver 默认只绑 loopback）：
//   1) WebSocket /dsh-kit/terminal —— 每条连接一个 node-pty 会话；
//   2) 静态 /dsh-kit/vendor/* —— xterm 官方预编译 UMD，按需加载；
//   3) GET /dsh-kit/tree?path=… —— 单层目录列表（含文件），只读；
//   4) GET /dsh-kit/read?path=… —— 单文件文本内容，只读。
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
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { applySkillPool, findProjectRoot } from './skill-pool.js'

export const name = 'dsh-kit'

const require = createRequire(import.meta.url)

/**
 * 多锚点加载依赖：包以 `dsh plugin add <目录>` 安装时是软链，真实路径在
 * 工作区，parent-walk 够不到 harness 的 fallback node_modules；此时退而从
 * 运行中的 dsh 本体解析（process.argv[1] = dsh bin，其 node_modules 与
 * fallback 同源）。两种安装形态（软链 / tarball、git 真实拷贝）都覆盖。
 */
function loadDep(spec) {
  try {
    return require(spec)
  } catch {
    // 落到运行中 dsh 本体的锚点
  }
  const anchor = process.argv[1]
  if (anchor) {
    try {
      return createRequire(anchor)(spec)
    } catch {
      // 两个锚点都没有则按缺失处理
    }
  }
  return null
}

const pty = loadDep('node-pty')
const WebSocketServer = loadDep('ws')?.WebSocketServer ?? null
if (!pty || !WebSocketServer) {
  console.warn('dsh-kit: node-pty/ws 不可用，终端能力不可用')
}

// 插件设置命名空间依赖（任务5）：junction 直装下静态 import @deepseek-ai/*
// 会在 dev 环境启动即 ERR_MODULE_NOT_FOUND（parent-walk 够不到 fallback
// node_modules），与 node-pty/ws 同走 loadDep 运行时解析。dsh-settings 是纯
// ESM，require() 依赖 Node ≥22.12 的 require(esm)；schemastery 自带 cjs 导出。
const dshSettings = loadDep('@deepseek-ai/dsh-settings')
const schemasteryMod = loadDep('@deepseek-ai/schemastery')
const installSettingsSection = dshSettings?.installSettingsSection ?? null
const settingsNamespace = dshSettings?.settingsNamespace ?? null
const z = schemasteryMod?.default ?? schemasteryMod ?? null
if (!installSettingsSection || !settingsNamespace || !z || typeof z.object !== 'function') {
  console.warn('dsh-kit: @deepseek-ai/dsh-settings 或 @deepseek-ai/schemastery 不可用，插件设置命名空间未注册')
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

/** Windows 优先 pwsh（PowerShell 7+），退回 powershell.exe；其它平台用 $SHELL 或 bash。结果缓存。 */
let shellCache
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
      ? { file: pwsh, args: ['-NoLogo'], label: 'pwsh' }
      : { file: 'powershell.exe', args: ['-NoLogo'], label: 'powershell' }
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
])
const VENDOR_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
])

export function apply(ctx) {
  // ── 插件设置命名空间（任务5）──
  // 浏览器半边设置卡（client/bundle.js 的 dsh-kit 卡片，settings.plugin.item）
  // 的数据通道：terminalEnabled/fileTreeEnabled/skillsPageEnabled 三个功能开关
  // + terminalShortcut/fileTreeShortcut 两个快捷键。宿主自身不消费这些值（门控
  // 全在浏览器端），但命名空间必须注册——否则浏览器端 settings.mutate 报
  // "namespace not registered"。installSettingsSection 内部自等 settings 服务
  // （ctx.inject），不能拿 ctx.get('settings') 判存在后跳过。
  if (installSettingsSection && settingsNamespace && z && typeof z.object === 'function') {
    const Config = z.object({
      terminalEnabled: z.boolean().default(true),
      fileTreeEnabled: z.boolean().default(true),
      skillsPageEnabled: z.boolean().default(true),
      terminalShortcut: z.string().default('Ctrl+`'),
      fileTreeShortcut: z.string().default('Ctrl+E'),
      scShortcut: z.string().default('Ctrl+G'),
    })
    installSettingsSection(ctx, settingsNamespace('dsh-kit'), Config, {}, {
      setSource: () => {},
      onChange: () => {},
    })
  }

  // 技能池端点（M1，见 src/skill-pool.js）：自带 webServer 注入与同源校验。
  // skills 注册表是可选增强（归属展示），服务晚于本行就绪也无碍——注入回调捕获引用。
  let skillsRegistry = null
  ctx.inject(['skills'], (skillsCtx) => {
    skillsRegistry = skillsCtx.skills
  })
  applySkillPool(ctx, { getRegistry: () => skillsRegistry })

  // webServer 可能在本插件 apply 之后才挂载，用动态注入等它就绪
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      // ── vendor 静态资源 ──
      const disposeVendor = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-kit/vendor',
        handler: (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://dsh-kit.local').pathname
          const file = VENDOR_FILES.get(pathname)
          if (file === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
            res.writeHead(404)
            res.end()
            return
          }
          fs.readFile(path.join(VENDOR_DIR, file), (error, body) => {
            if (error) {
              res.writeHead(404)
              res.end()
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
                const binary = head.includes(0)
                json(200, {
                  path: file.path,
                  size: file.size,
                  mtimeMs: file.mtimeMs,
                  truncated: true,
                  binary,
                  content: binary ? null : head.toString('utf8'),
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
            // 二进制探测：头部出现 NUL 字节视为二进制，不返回文本内容
            const head = body.subarray(0, 4096)
            const binary = head.includes(0)
            const content = binary ? null : body.toString('utf8')
            json(200, { path: file.path, size: file.size, mtimeMs: file.mtimeMs, truncated: false, binary, content })
          })
        },
      })

      // ── 编辑保存端点：POST /dsh-kit/write（任务3）──
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

      // ── git 联动端点（任务4，只读）──
      // spawn git CLI（不引库）；无 git / 非仓库 / 超时统一回 {available:false}，
      // 前端据此隐藏入口。status 供文件树徽标，diff 供预览面板查看改动。
      const GIT_TIMEOUT = 10000
      /** 跑一条 git 命令；任何失败（ENOENT/非零/超时）都 resolve {ok:false} */
      const runGit = (args, cwdDir) =>
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
          }, GIT_TIMEOUT)
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
            const r = await runGit(['-c', 'core.quotePath=false', 'status', '--porcelain'], root)
            if (!r.ok) {
              json(200, { available: false })
              return
            }
            const entries = []
            const untrackedDirs = []
            for (const line of r.out.split('\n')) {
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
            json(200, { available: true, root, entries })
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

      // POST /dsh-kit/git/op {cwd, op, path?, message?, all?}：源代码管理的写操作集
      //   stage(path)      = git add -- <rel>
      //   unstage(path)    = git restore --staged -- <rel>
      //   discard(path)    = git restore -- <rel>（放弃未暂存改动，破坏性；前端已二次确认）
      //   stageAll         = git add -A
      //   commit(message, all?) = 可选先 add -A（暂存区为空时的"提交全部"），再 commit -m
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

      return () => {
        disposeVendor()
        disposeTree()
        disposeRead()
        disposeWrite()
        disposeGitStatus()
        disposeGitDiff()
        disposeGitInit()
        disposeGitOp()
        if (disposeHttp) disposeHttp()
        if (disposeUpgrade) disposeUpgrade()
      }
    }, 'dsh-kit: terminal endpoint + vendor assets + tree/read endpoint')
  })
}
