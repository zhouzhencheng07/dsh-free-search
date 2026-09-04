// dsh-kit 手机访问网关 —— 唯一对外监听口（默认 0.0.0.0:3090），把已授权的
// 手机浏览器请求透传给本机回环上的 dsh web 主端口。
//
// 为什么必须有这个进程：dsh web 有意只绑 127.0.0.1（CLI 显式拒绝
// --host 0.0.0.0，见 @deepseek-ai/dsh-web-app/lib/startup.js），而插件路由只能
// 叠加在主 webserver 上、拦不住别人的路由——「验链接」这件事没地方放，只能前置。
//
// 授权模型（授权内嵌在链接里）：
//   二维码 URL 携带一次性下发的高熵令牌 ?k=<token>；
//   首次校验通过后种长期 Cookie（dshk_phone），此后普通地址即可直达；
//   「刷新链接」= 轮换令牌，旧链接（含已种 Cookie 的旧令牌）立即全部失效。
//   未授权请求一律返回不起眼的 404 Not Found（不暴露这里跑着什么）。
//
// 转发策略（全功能模式）：Host 重写为 127.0.0.1:<upstream>、剥离 Origin 与本网关
// Cookie。这会让 dsh 的 browser-trust fence 把请求当回环同源放行（含特权 RPC——
// 上游把它们钉死 loopback）。安全上自洽：令牌即认证层，持有链接者本就能借 agent
// 对话执行任意命令，特权钉死对该威胁模型无增量；而直连回环的本机访问不受影响，
// dsh 本体零改动。
//
// dsh web ≥ v0.1.2-alpha.5 起带浏览器会话鉴权：回环直连请求也必须携带
// client-connection 签名 cookie，否则 index 一律 401（手机端会看到
// "dsh web authentication required; reopen the URL printed by dsh web"）。
// 网关自铸该会话 cookie（与 dsh web 共享 credentials 的
// client-connection/browser-session 记录密钥，算法见 dshSessionCookie）
// 随每次反代上送，手机浏览器无需感知；密钥未就绪时网关其余功能照常，
// 仅手机访问 401。
//
// WebSocket：会话事件流 / 终端 / 客户端 HMR 全靠 WS 升级，upgrade 事件做同样的
// 鉴权后手动隧道（101 头回写 + 双向 pipe），流式响应一律不缓冲。

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 网关下发的授权 Cookie 名 */
export const PHONE_COOKIE = 'dshk_phone'

/**
 * insecure-context 兜底：前端用 crypto.randomUUID 生成 rpcId，该 API 仅在
 * 安全上下文（HTTPS / localhost）存在，局域网明文 HTTP 访问会全站抛
 * "crypto.randomUUID is not a function"，官方 RPC 全灭而 kit 端点幸存。
 * 用不要求安全上下文的 getRandomValues 实现同形兜底，注入进代理的 HTML。
 */
const POLYFILL_SCRIPT =
  '<script>(function(){var c=window.crypto;if(!c||typeof c.randomUUID==="function")return;' +
  'try{Object.defineProperty(c,"randomUUID",{configurable:true,value:function(){' +
  'var b=c.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;' +
  'var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));' +
  'return h.join("").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,"$1-$2-$3-$4-$5");}})}catch(e){}})();</script>'

/** 在 HTML 的 <head> 开标签后插入脚本；找不到开标签就整体前置 */
export function injectHeadScript(html, script) {
  const match = /<head[^>]*>/i.exec(html)
  if (match === null) return script + html
  const idx = match.index + match[0].length
  return html.slice(0, idx) + script + html.slice(idx)
}

/** 生成一个高熵令牌（192-bit，URL 安全） */
export function newToken() {
  return crypto.randomBytes(24).toString('base64url')
}

/** base64url 编码（与 dsh client-connection 的 encodeBase64Url 一致） */
function encodeBase64Url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * 铸造 dsh web 浏览器会话 cookie。算法对齐 @deepseek-ai/dsh-client-connection：
 * 名 = `dsh-auth-<b64url(sha256(authority))>`，值 = `v1.<b64url(payload)>.<b64url(hmac(secret, body))>`，
 * payload = {version:1, authority, issuedAt, expiresAt}。跨度取 1 天：dsh 校验要求
 * 跨度 ≤ 其 cookieMaxAgeDays 配置（默认 30），而网关每请求现铸（issuedAt≈now），
 * 跨度只影响上限兼容——取 1 天对任何 ≥1 天的配置都成立。
 * @param {Buffer} secret 32 字节 HMAC 原始密钥
 * @param {string} authority 校验 authority（= 转发时重写后的 Host，即 127.0.0.1:<upstream>）
 */
export function dshSessionCookie({ secret, authority, issuedAt = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 }) {
  const name = 'dsh-auth-' + encodeBase64Url(crypto.createHash('sha256').update(authority).digest())
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + maxAgeMs }
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const value = `v1.${body}.${encodeBase64Url(crypto.createHmac('sha256', secret).update(body).digest())}`
  return `${name}=${value}`
}

/** 定长无关的恒时字符串比较 */
function safeEq(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** 极简 Cookie 解析（只需要取一个名值对） */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

/**
 * 默认令牌持久化文件：<DSH_HOME>/data/dsh-kit-phone-gateway.json。
 * 重启 dsh 后令牌不变，手机端 Cookie 继续有效；文件损坏则重新生成
 * （等价于一次轮换，旧链接失效属预期）。
 */
export function defaultStateFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : os.tmpdir()
  return path.join(home, 'data', 'dsh-kit-phone-gateway.json')
}

/**
 * 状态文件读写（令牌 + 网关启用位）。启用位独立于 settings 通道：
 * 设置读取器回填有时序滞后，网关开关用文件直管，见 index.js 的
 * /dsh-kit/phone/gateway 端点。
 */
export function loadGatewayState(stateFile, log = () => {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (typeof raw?.token !== 'string' || raw.token.length < 20) throw new Error('token 缺失或过短')
    return {
      token: raw.token,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`状态文件读取失败，将重新生成：${error?.message ?? error}`)
    return { token: newToken(), enabled: false }
  }
}

export function saveGatewayState(stateFile, { token, enabled }, log = () => {}) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const body = JSON.stringify({ token, enabled, createdAt: new Date().toISOString() })
    const tmp = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, stateFile)
  } catch (error) {
    log(`状态文件写入失败（重启后将回退默认）：${error?.message ?? error}`)
  }
}

/** 本机非回环 IPv4 地址列表（二维码里局域网链接的候选） */
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/**
 * 启动网关监听。
 * @param {object} opts
 * @param {number} opts.port 对外端口（默认 3090）
 * @param {number} opts.upstreamPort dsh web 主端口（回环）
 * @param {string} [opts.stateFile] 令牌持久化路径
 * @param {Buffer | (() => Buffer | null) | null} [opts.sessionSecret] dsh web 浏览器
 *   会话密钥（32 字节原始密钥）；可传取值函数以便读好后自动生效。null/未就绪时
 *   不注入会话 cookie（手机访问显示 401，网关其余功能不受影响）。
 * @param {(msg: string) => void} [opts.log]
 */
export function startPhoneGateway({ port, upstreamPort, stateFile = defaultStateFile(), log = () => {}, sessionSecret = null }) {
  if (!Number.isInteger(port) || port < 0 || !Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    throw new Error('startPhoneGateway: port 必须是非负整数（0=系统自选），upstreamPort 必须是正整数')
  }
  const boot = loadGatewayState(stateFile, log)
  let token = boot.token
  // 首次运行立即落盘：否则重启会重新随机生成，手机 Cookie 活不过第一次重启
  saveGatewayState(stateFile, { token, enabled: boot.enabled }, log)

  /** 从请求里验令牌：query ?k= 或 Cookie，二者其一命中即可 */
  function authorized(req, urlObj) {
    const q = urlObj.searchParams.get('k')
    if (q !== null && q !== '' && safeEq(q, token)) return true
    const cookie = parseCookies(req.headers.cookie)[PHONE_COOKIE]
    return typeof cookie === 'string' && cookie !== '' && safeEq(cookie, token)
  }

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('Not Found')
  }

  /** 自铸的 dsh web 会话 cookie 头值；密钥未就绪时返回 null */
  const sessionCookieHeader = () => {
    if (sessionSecret === null) return null
    const secret = typeof sessionSecret === 'function' ? sessionSecret() : sessionSecret
    if (secret === null) return null
    return dshSessionCookie({ secret, authority: `127.0.0.1:${upstreamPort}` })
  }

  /**
   * 组装转发头：Host 改写为回环上游、剥 Origin（fence 视作回环同源）、
   * 剥本网关 Cookie（不把网关令牌漏给上游）、注入 dsh web 会话 Cookie、滤逐跳头。
   */
  function proxyHeaders(src, upgrade) {
    const headers = { ...src }
    headers.host = `127.0.0.1:${upstreamPort}`
    delete headers.origin
    // 统一要未压缩响应：HTML 注入需要原文；远程层由 VPS caddy 重新压缩给手机
    delete headers['accept-encoding']
    // 合并 Cookie：上游原值 + 自铸的 dsh web 会话 cookie（新版 dsh web 鉴权必需），
    // 再摘掉网关令牌，其余原样透传
    const cookies = parseCookies(headers.cookie)
    const session = sessionCookieHeader()
    if (session !== null) {
      const eq = session.indexOf('=')
      if (eq > 0) cookies[session.slice(0, eq)] = session.slice(eq + 1)
    }
    delete cookies[PHONE_COOKIE]
    const pairs = Object.entries(cookies)
    if (pairs.length > 0) headers.cookie = pairs.map(([name, value]) => `${name}=${value}`).join('; ')
    else delete headers.cookie
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    if (upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = String(src.upgrade ?? 'websocket')
    } else {
      delete headers.connection
      delete headers['keep-alive']
    }
    return headers
  }

  const server = http.createServer((req, res) => {
    let urlObj
    try {
      urlObj = new URL(req.url ?? '/', 'http://gateway.local')
    } catch {
      notFound(res)
      return
    }
    // 链接里的明文令牌：验证即种长期 Cookie 并甩掉 query（地址栏不留令牌）
    const q = urlObj.searchParams.get('k')
    if (q !== null && q !== '') {
      if (!safeEq(q, token)) {
        notFound(res)
        return
      }
      res.writeHead(302, {
        location: urlObj.pathname,
        'set-cookie': `${PHONE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (!authorized(req, urlObj)) {
      notFound(res)
      return
    }

    const headers = proxyHeaders(req.headers, false)
    const up = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers },
      (upRes) => {
        const out = { ...upRes.headers }
        delete out.connection
        delete out['keep-alive']
        delete out['transfer-encoding']
        if (/text\/html/i.test(String(out['content-type'] ?? '')) && req.method !== 'HEAD') {
          // HTML 需注入兜底脚本：缓冲整个页面（dsh 首页仅十余 KB）再回写
          const chunks = []
          upRes.on('data', (c) => chunks.push(c))
          upRes.on('end', () => {
            const injected = injectHeadScript(Buffer.concat(chunks).toString('utf8'), POLYFILL_SCRIPT)
            out['content-length'] = String(Buffer.byteLength(injected))
            delete out.etag
            res.writeHead(upRes.statusCode ?? 502, out)
            res.end(injected)
          })
          upRes.on('error', () => res.destroy())
          return
        }
        res.writeHead(upRes.statusCode ?? 502, out)
        upRes.pipe(res)
        upRes.on('error', () => res.destroy())
      },
    )
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      res.end('dsh-kit phone gateway: upstream unavailable')
    })
    res.on('close', () => up.destroy())
    req.pipe(up)
  })

  // WebSocket 升级：同样鉴权后手动隧道（101 回写 + 双向 pipe，不经过任何缓冲）
  server.on('upgrade', (req, socket, head) => {
    let urlObj = null
    try {
      urlObj = new URL(req.url ?? '/', 'http://gateway.local')
    } catch {
      socket.destroy()
      return
    }
    if (!authorized(req, urlObj)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const headers = proxyHeaders(req.headers, true)
    const up = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      path: req.url,
      headers,
    })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      // 方向易错点：head 是客户端随升级请求早到的字节（发往上游）；upHead 是
      // 服务端 101 后立即推的字节——真实 dsh 会在此推初始事件帧（实测 436B），
      // 必须写给客户端。两者接反的表现是握手成功但零帧、随即 1002 断开。
      if (head !== undefined && head.length > 0) upSocket.write(head)
      if (upHead !== undefined && upHead.length > 0) socket.write(upHead)
      upSocket.setNoDelay(true)
      socket.setNoDelay(true)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      const die = () => {
        try { socket.destroy() } catch { /* 已销毁 */ }
        try { upSocket.destroy() } catch { /* 已销毁 */ }
      }
      upSocket.on('error', die)
      socket.on('error', die)
      upSocket.on('close', die)
      socket.on('close', die)
    })
    up.on('error', () => socket.destroy())
    up.end()
  })

  const state = { listening: false, error: null }
  server.on('listening', () => {
    state.listening = true
    state.error = null
  })
  server.on('error', (error) => {
    state.listening = false
    state.error = error?.message ?? String(error)
    log(`网关监听异常：${state.error}`)
  })
  server.listen(port, '0.0.0.0')

  return {
    /** 实际监听端口（支持 port 0 由系统自选后回读） */
    port: () => {
      const addr = server.address()
      return typeof addr === 'object' && addr !== null ? addr.port : null
    },
    /** 当前令牌（轮换后变化） */
    token: () => token,
    /** 轮换令牌并持久化；旧链接与旧 Cookie 立即失效 */
    rotate() {
      token = newToken()
      saveGatewayState(stateFile, { token, enabled: boot.enabled }, log)
      return token
    },
    /** 令牌尾迹（日志/状态展示用，不暴露全文） */
    fingerprint: () => token.slice(-4),
    /** 运行状态快照 */
    state: () => ({ listening: state.listening, error: state.error }),
    close() {
      try {
        server.close()
      } catch { /* 已关闭 */ }
    },
  }
}
