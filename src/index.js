// dsh-kit — DSH 页面能力插件包（宿主半边）
//
// 当前能力：
//   终端（terminal）——见下方协议注释；
//   文件树（file tree）——GET /dsh-kit/tree?path=<绝对目录> 返回该层
//     目录+文件的 JSON 列表（官方 browse RPC 只列目录不列文件，故自建）。
//
// 浏览器半边（client/bundle.js）在 shell.overlay 槽位注册 VSCode 风格的
// 底部终端面板 + 右下角悬浮按钮（Ctrl+` 切换），在 sidebar.footer.action
// 槽位注册文件树开关按钮（面板停靠在侧边栏区域）。
//
// 宿主半边（本文件）挂三个端点（webserver 默认只绑 loopback）：
//   1) WebSocket /dsh-kit/terminal —— 每条连接一个 node-pty 会话；
//   2) 静态 /dsh-kit/vendor/* —— xterm 官方预编译 UMD，按需加载；
//   3) GET /dsh-kit/tree?path=… —— 单层目录列表（含文件），只读。
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

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

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

      // ── 终端 WebSocket 端点 ──
      let disposeUpgrade = null
      let disposeHttp = null
      if (pty && WebSocketServer) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

        /** 一条 WS 连接 = 一个 pty 会话 */
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

        console.log('dsh-kit: 终端端点已注册 /dsh-kit/terminal')
      }

      console.log('dsh-kit: vendor 资源已注册 /dsh-kit/vendor/*')
      return () => {
        disposeVendor()
        disposeTree()
        if (disposeHttp) disposeHttp()
        if (disposeUpgrade) disposeUpgrade()
      }
    }, 'dsh-kit: terminal endpoint + vendor assets + tree endpoint')
  })
}
