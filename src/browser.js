// dsh-kit 内置浏览器——BrowserService（宿主半边核心，2026-09-04）
//
// 职责：vendored playwright-core（host-vendor/，钉 1.62.1）驱动系统 Edge（channel
// 方式，失败退 executablePath 探测链），管理持久化上下文（专用 profile，登录态跨
// 会话保留）、页面集、帧流中继；对工具层（browser-tools.js）与面板 ws（index.js）
// 提供同一套操作面。纯 JS、零依赖声明；ws 服务器与 node-pty 同款多锚点解析在
// index.js 完成，这里不重复。
//
// 生命周期语义：
//   懒启动（首次工具调用/面板 watch 时 launchPersistentContext）；
//   引用计数 + 空闲 10 分钟自动 close（登录态在专用 profile 里，重开无损）；
//   插件 dispose 兜底 close；启动时按 pidfile 清理上次异常退出的孤儿实例。
// 安全边界：
//   专用 profile 目录（$DSH_HOME/dsh-kit/browser-profile），绝不指向用户日常配置；
//   URL 白名单 http/https（file:// 拒绝）；snapshot 8KB / eval 64KB / 帧 1600px 限长。
// 观察面：ariaSnapshot({ mode: 'ai' })——紧凑树 + [ref=eN]（playwright 1.62 原生）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const IDLE_CLOSE_MS = 10 * 60 * 1000
const IDLE_TICK_MS = 30 * 1000
const GOTO_TIMEOUT = 15000
const ACT_TIMEOUT_DEFAULT = 5000
const ACT_TIMEOUT_MAX = 15000
const SNAPSHOT_CAP = 8 * 1024
const EVAL_CAP = 64 * 1024
const LAUNCH_TIMEOUT = 30000

/** 载入 vendored playwright-core（CJS 入口 index.js）。失败返回 null（能力整体不可用）。 */
function loadPlaywright() {
  let vendorDir
  try {
    vendorDir = fileURLToPath(new URL('../host-vendor/playwright-core/', import.meta.url))
  } catch {
    return null
  }
  const entry = path.join(vendorDir, 'index.js')
  if (!fs.existsSync(entry)) return null
  try {
    return createRequire(import.meta.url)(entry)
  } catch {
    return null
  }
}

/** 找系统 Chromium 系浏览器（channel 失败后的 executablePath 兜底链，按平台列常见路径）。 */
function browserExecutableCandidates() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA || ''
    return [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter((p) => p && p !== path.sep)
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/** 快照文本限长（保尾部提示，让模型知道被截断） */
export function capText(text, cap = SNAPSHOT_CAP) {
  if (typeof text !== 'string') return ''
  if (text.length <= cap) return text
  return text.slice(0, cap) + `\n…（快照超过 ${cap} 字符已截断，可用 locator('body').ariaSnapshot 的区域化观察替代——当前版本请缩小断言范围）`
}

/** 从 PNG 字节取宽高（IHDR 定长偏移，纯函数供单测） */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 校验 act 的定位参数：三选一（role+name / text / selector），返回归一化对象或错误 */
export function normalizeLocatorArgs(args) {
  const { role, name, text, selector } = args ?? {}
  if (selector !== undefined && selector !== null && String(selector).trim() !== '') {
    return { kind: 'selector', selector: String(selector).trim() }
  }
  if (role !== undefined && role !== null && String(role).trim() !== '') {
    return { kind: 'role', role: String(role).trim(), name: name === undefined || name === null ? '' : String(name) }
  }
  if (text !== undefined && text !== null && String(text).trim() !== '') {
    return { kind: 'text', text: String(text) }
  }
  return { error: '缺少定位参数：role（+name）/ text / selector 三选一' }
}

const ACT_KINDS = new Set(['click', 'type', 'press', 'check', 'uncheck', 'select'])
/** 校验 act 的动作与参数配套（type/select 需要 value，press 需要 key） */
export function normalizeActArgs(args) {
  const action = String(args?.action ?? '').trim()
  if (!ACT_KINDS.has(action)) {
    return { error: `未知 action：${action || '(空)'}——可选 click/type/press/check/uncheck/select` }
  }
  if ((action === 'type' || action === 'select') && (args?.value === undefined || String(args.value) === '')) {
    return { error: `action=${action} 需要 value` }
  }
  if (action === 'press' && (args?.key === undefined || String(args.key).trim() === '')) {
    return { error: 'action=press 需要 key（如 Enter、Control+A）' }
  }
  return { action }
}

/** dshHome（对齐 skill-pool.js 的解析） */
function dshHomeDir() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env.trim() : path.join(os.homedir(), '.dsh')
}

export class BrowserService {
  constructor({ log = () => {} } = {}) {
    this._log = log
    this._pw = loadPlaywright()
    this._context = null
    this._launchError = null
    this._launching = null
    this._pages = new Map() // tabId → Page
    this._titles = new Map() // tabId → title
    this._nextId = 1
    this._activeId = null
    this._listeners = new Set()
    this._lastActivity = Date.now()
    this._idleTimer = null
    this._watchers = 0 // 面板帧流订阅数（保活）
    this._stream = null // { cdp, tabId }
    this._disposed = false
    if (this._pw) this._startIdleTimer()
  }

  /** 插件/宿主能力面是否可用（vendor 加载成功） */
  get available() {
    return this._pw !== null
  }

  get launchError() {
    return this._launchError
  }

  on(cb) {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  _emit(evt) {
    for (const cb of this._listeners) {
      try {
        cb(evt)
      } catch {
        // 监听方异常不传染
      }
    }
  }

  _touch() {
    this._lastActivity = Date.now()
  }

  _startIdleTimer() {
    if (this._idleTimer) return
    this._idleTimer = setInterval(() => {
      if (this._disposed) return
      const idleFor = Date.now() - this._lastActivity
      if (this._context && this._watchers === 0 && idleFor > IDLE_CLOSE_MS) {
        this._log('browser: 空闲超时，自动关闭（登录态保留在专用 profile）')
        void this._closeContext()
      }
    }, IDLE_TICK_MS)
    if (this._idleTimer.unref) this._idleTimer.unref()
  }

  /** 启动前清理上次异常留下的孤儿实例（pidfile 信任 + 进程名核验） */
  _cleanupOrphan() {
    const pidFile = path.join(dshHomeDir(), 'dsh-kit', 'browser-profile', '.pid')
    let pid = 0
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    } catch {
      return
    }
    if (!Number.isInteger(pid) || pid <= 0) return
    const isBrowser = () =>
      new Promise((resolve) => {
        let out = ''
        let child
        try {
          child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
        } catch {
          resolve(false)
          return
        }
        child.stdout?.on('data', (d) => {
          out += d
        })
        child.on('error', () => resolve(false))
        child.on('close', () => resolve(/msedge|chrome/i.test(out)))
      })
    const kill = () =>
      new Promise((resolve) => {
        let child
        try {
          child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } catch {
          resolve(false)
          return
        }
        child.on('error', () => resolve(false))
        child.on('close', () => resolve(true))
      })
    void (async () => {
      if (!(process.platform === 'win32' ? await isBrowser() : true)) {
        try {
          fs.unlinkSync(pidFile)
        } catch {}
        return
      }
      await kill()
      try {
        fs.unlinkSync(pidFile)
      } catch {}
      this._log(`browser: 清理上次残留的浏览器实例（pid ${pid}）`)
    })()
  }

  /** 懒启动持久化上下文（幂等；并发调用共享同一次启动） */
  async ensure() {
    this._touch()
    if (this._context) return { ok: true }
    if (this._launchError) return { ok: false, error: this._launchError }
    if (!this._launching) this._launching = this._launch()
    return this._launching
  }

  async _launch() {
    if (!this._pw) {
      this._launchError = 'playwright-core vendor 不可用（host-vendor 缺失或损坏）'
      return { ok: false, error: this._launchError }
    }
    this._cleanupOrphan()
    const userDataDir = path.join(dshHomeDir(), 'dsh-kit', 'browser-profile')
    fs.mkdirSync(userDataDir, { recursive: true })
    const common = {
      headless: true,
      viewport: { width: 1280, height: 800 },
      timeout: LAUNCH_TIMEOUT,
    }
    let context = null
    let lastError = null
    for (const attempt of [
      { channel: 'msedge' },
      { channel: 'chrome' },
      ...browserExecutableCandidates()
        .filter((p) => {
          try {
            return fs.existsSync(p)
          } catch {
            return false
          }
        })
        .map((executablePath) => ({ executablePath })),
    ]) {
      try {
        context = await this._pw.chromium.launchPersistentContext(userDataDir, { ...common, ...attempt })
        break
      } catch (error) {
        lastError = error
        this._log(`browser: 启动失败（${attempt.channel ?? attempt.executablePath}）：${error?.message ?? error}`)
      }
    }
    if (!context) {
      this._launchError = `无法启动系统浏览器（Edge/Chrome）：${lastError?.message ?? lastError}`
      return { ok: false, error: this._launchError }
    }
    this._context = context
    this._launchError = null
    context.on('close', () => {
      this._context = null
      this._pages.clear()
      this._titles.clear()
      this._activeId = null
      this._stream = null
      this._emit({ kind: 'closed' })
    })
    // pidfile（孤儿防护，尽力而为）
    try {
      const browser = typeof context.browser === 'function' ? context.browser() : null
      const pid = browser && typeof browser.process === 'function' ? browser.process()?.pid : null
      if (pid) fs.writeFileSync(path.join(userDataDir, '.pid'), String(pid))
    } catch {}
    // 既有页纳入管理（persistent context 可能带回上次会话的页）
    for (const page of context.pages()) this._adopt(page)
    context.on('page', (page) => this._adopt(page))
    await this.ensurePage()
    this._log('browser: 已启动（headless，专用 profile）')
    return { ok: true }
  }

  /** 纳管一页（幂等）：缓存标题、监听导航与崩溃；返回 tabId */
  _adopt(page) {
    if (page.__dshTabId !== undefined) {
      // 已纳管（newPage 与 'page' 事件都会走到这里）：只提升为活动页
      this._activeId = page.__dshTabId
      this._emit({ kind: 'state' })
      return page.__dshTabId
    }
    const tabId = this._nextId++
    this._pages.set(tabId, page)
    this._activeId = tabId
    page.__dshTabId = tabId
    page.title().then((t) => {
      this._titles.set(tabId, t)
      this._emit({ kind: 'navigated', tabId, url: page.url(), title: t })
    }).catch(() => {})
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const id = page.__dshTabId
      page.title().then((t) => {
        this._titles.set(id, t)
      }).catch(() => {})
      this._touch()
      this._emit({ kind: 'navigated', tabId: id, url: page.url(), title: this._titles.get(id) ?? '' })
      this._resyncStream(id)
    })
    page.on('crash', () => {
      const id = page.__dshTabId
      this._emit({ kind: 'crashed', tabId: id })
      this._pages.delete(id)
      this._titles.delete(id)
      if (this._activeId === id) this._activeId = this._pages.keys().next().value ?? null
    })
    page.on('close', () => {
      const id = page.__dshTabId
      this._pages.delete(id)
      this._titles.delete(id)
      if (this._activeId === id) this._activeId = this._pages.keys().next().value ?? null
      this._emit({ kind: 'state' })
    })
    this._emit({ kind: 'state' })
    return tabId
  }

  /** 无页则建一页（about:blank） */
  async ensurePage() {
    const ensureResult = await this.ensure()
    if (!ensureResult.ok) return ensureResult
    if (this._activeId === null || !this._pages.has(this._activeId)) {
      await this._context.newPage()
      // newPage 触发 'page' 事件 → _adopt 设为活动页
      if (this._activeId === null) return { ok: false, error: '页面创建失败' }
    }
    return { ok: true, tabId: this._activeId }
  }

  _page(tabId) {
    if (tabId === undefined || tabId === null) {
      if (this._activeId === null) return null
      return this._pages.get(this._activeId) ?? null
    }
    return this._pages.get(Number(tabId)) ?? null
  }

  async listPages() {
    const ensureResult = await this.ensure()
    if (!ensureResult.ok) return { ok: false, error: ensureResult.error }
    const pages = []
    for (const [tabId, page] of this._pages) {
      pages.push({ tabId, url: page.url(), title: this._titles.get(tabId) ?? '', active: tabId === this._activeId })
    }
    return { ok: true, pages, activeId: this._activeId }
  }

  async state() {
    if (!this._pw) return { available: false, error: this._launchError ?? 'playwright-core vendor 不可用' }
    if (!this._context) return { available: true, running: false, error: this._launchError }
    const listed = await this.listPages()
    return {
      available: true,
      running: true,
      pages: listed.pages ?? [],
      activeId: listed.activeId ?? null,
    }
  }

  /** 导航（工具与面板共用）：返回 { tabId, title, url, snapshot? } */
  async navigate(url, { newTab = false, snapshot = true } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: '仅支持 http/https URL' }
    }
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    let page
    if (newTab || this._activeId === null || !this._pages.has(this._activeId)) {
      page = await this._context.newPage()
      // newPage 与 'page' 事件都会走 _adopt（幂等），显式adopt 一次拿稳 tabId
      this._adopt(page)
      page = this._pages.get(this._activeId)
    } else {
      page = this._pages.get(this._activeId)
    }
    const tabId = page.__dshTabId
    try {
      await page.goto(url.trim(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT })
    } catch (error) {
      return { ok: false, error: `导航失败：${error?.message ?? error}（页面可能仍在加载，可重试或改用 snapshot 观察）` }
    }
    this._touch()
    const title = await page.title().catch(() => '')
    this._titles.set(tabId, title)
    const result = { ok: true, tabId, url: page.url(), title }
    if (snapshot) result.snapshot = capText(await this._snapshotOf(page))
    this._emit({ kind: 'navigated', tabId, url: result.url, title })
    return result
  }

  async _snapshotOf(page) {
    try {
      return await page.locator('body').ariaSnapshot({ mode: 'ai' })
    } catch (error) {
      return `（快照失败：${error?.message ?? error}）`
    }
  }

  /** 紧凑树观察 */
  async snapshot(tabId) {
    const ensured = await this.ensure()
    if (!ensured.ok) return { ok: false, error: ensured.error }
    const page = this._page(tabId)
    if (!page) return { ok: false, error: `页不存在：${tabId}（用 browser_navigate 或先开一页）` }
    this._touch()
    return { ok: true, tabId: page.__dshTabId, url: page.url(), title: this._titles.get(page.__dshTabId) ?? '', snapshot: capText(await this._snapshotOf(page)) }
  }

  /** 统一动作：click/type/press/check/uncheck/select；默认返回新快照（动作即观察） */
  async act(args) {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const page = this._page(args.tabId)
    if (!page) return { ok: false, error: `页不存在：${args.tabId}` }
    const act = normalizeActArgs(args)
    if (act.error) return { ok: false, error: act.error }
    const timeout = Math.min(Math.max(Number(args.timeoutMs) || ACT_TIMEOUT_DEFAULT, 1000), ACT_TIMEOUT_MAX)
    const hasLocator = [args?.role, args?.name, args?.text, args?.selector].some(
      (v) => v !== undefined && v !== null && String(v).trim() !== '',
    )
    let locator = null
    let loc = null
    try {
      if (!hasLocator && act.action === 'press') {
        // 无定位目标的键盘事件直接发给页面
        await page.keyboard.press(args.key)
        locator = null
      } else {
        loc = normalizeLocatorArgs(args)
        if (loc.error) return { ok: false, error: loc.error }
        if (loc.kind === 'selector') locator = page.locator(loc.selector)
        else if (loc.kind === 'role') locator = page.getByRole(loc.role, loc.name ? { name: loc.name } : {})
        else locator = page.getByText(loc.text)
      }
    } catch (error) {
      return { ok: false, error: `定位失败：${error?.message ?? error}` }
    }
    let matched = null
    if (locator) {
      try {
        matched = await locator.count()
      } catch {
        matched = null
      }
      if (matched === 0) {
        return {
          ok: false,
          error: `目标未找到（${loc.kind}${loc.kind === 'role' ? `=${loc.role}` : ''}${loc.name ? ` name=${loc.name}` : ''}${loc.kind === 'text' ? ` text=${loc.text}` : ''}${loc.kind === 'selector' ? ` selector=${loc.selector}` : ''}）——重取 browser_snapshot 再构造定位，不要原样重试`,
        }
      }
      const target = locator.first()
      try {
        this._touch()
        switch (act.action) {
          case 'click':
            await target.click({ timeout })
            break
          case 'type':
            await target.fill(String(args.value), { timeout })
            break
          case 'press':
            await target.press(args.key, { timeout })
            break
          case 'check':
            await target.setChecked(true, { timeout })
            break
          case 'uncheck':
            await target.setChecked(false, { timeout })
            break
          case 'select':
            await target.selectOption(String(args.value), { timeout })
            break
        }
      } catch (error) {
        return { ok: false, error: `${act.action} 失败：${error?.message ?? error}——重取 browser_snapshot 后重建定位，不要原样重试` }
      }
    }
    const result = {
      ok: true,
      tabId: page.__dshTabId,
      url: page.url(),
      title: await page.title().catch(() => ''),
      matched,
    }
    if (matched > 1) result.warning = `目标不唯一（${matched} 个匹配），已作用于第一个——可加 name/text 收窄`
    if (args.snapshot !== false) result.snapshot = capText(await this._snapshotOf(page))
    return result
  }

  /** 页面内 JS（返回 JSON 值，限长） */
  async evaluate(expression, tabId) {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const page = this._page(tabId)
    if (!page) return { ok: false, error: `页不存在：${tabId}` }
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { ok: false, error: '缺少 expression（页面上下文中可执行的 JS 表达式）' }
    }
    this._touch()
    try {
      const value = await page.evaluate(expression)
      let json
      try {
        json = JSON.stringify(value ?? null)
      } catch {
        json = String(value)
      }
      if (json.length > EVAL_CAP) json = json.slice(0, EVAL_CAP) + '…（结果超长已截断）'
      return { ok: true, tabId: page.__dshTabId, value: json }
    } catch (error) {
      return { ok: false, error: `evaluate 失败：${error?.message ?? error}` }
    }
  }

  /** 截图：返回 buffer + 尺寸（image 附件化在 browser-tools 里做，需 exec/ctx） */
  async screenshot({ fullPage = false, tabId } = {}) {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const page = this._page(tabId)
    if (!page) return { ok: false, error: `页不存在：${tabId}` }
    this._touch()
    try {
      const buffer = await page.screenshot({ fullPage: fullPage === true, type: 'png' })
      return { ok: true, tabId: page.__dshTabId, url: page.url(), buffer, size: pngSize(buffer) }
    } catch (error) {
      return { ok: false, error: `截图失败：${error?.message ?? error}` }
    }
  }

  /** 关一页 */
  async closePage(tabId) {
    const page = this._pages.get(Number(tabId))
    if (!page) return { ok: false, error: `页不存在：${tabId}` }
    try {
      await page.close()
    } catch (error) {
      return { ok: false, error: `关闭失败：${error?.message ?? error}` }
    }
    return { ok: true }
  }

  // ── 面板帧流 ──

  /** 面板订阅帧流（引用计数；复路：同一活动页只挂一条 CDP 会话） */
  async watcherOpen(onFrame) {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    this._watchers++
    this._touch()
    this._onFrame = onFrame
    if (!this._stream) await this._attachStream()
    return { ok: true }
  }

  watcherClose() {
    this._watchers = Math.max(0, this._watchers - 1)
    if (this._watchers === 0 && this._stream) {
      void this._detachStream()
    }
  }

  async _attachStream() {
    const page = this._page(this._activeId)
    if (!page || !this._context) return
    try {
      const cdp = await this._context.newCDPSession(page)
      cdp.on('Page.screencastFrame', (f) => {
        try {
          if (this._onFrame) this._onFrame(f.data, f.metadata)
        } catch {}
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
      })
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1600,
        maxHeight: 1200,
        everyNthFrame: 1,
      })
      this._stream = { cdp, tabId: page.__dshTabId }
    } catch (error) {
      this._log(`browser: 帧流启动失败：${error?.message ?? error}`)
    }
  }

  async _detachStream() {
    const stream = this._stream
    this._stream = null
    if (!stream) return
    try {
      await stream.cdp.send('Page.stopScreencast')
    } catch {}
    try {
      await stream.cdp.detach()
    } catch {}
  }

  /** 页面切换/崩溃后若在流式中则重挂 */
  async _resyncStream(tabId) {
    if (!this._stream || this._stream.tabId === tabId) return
    await this._detachStream()
    if (this._watchers > 0) await this._attachStream()
  }

  /** 面板 URL 栏手动导航（与工具共用 navigate，不取快照） */
  async humanOpen(url) {
    return this.navigate(url, { snapshot: false })
  }

  /** 活动页切换后的帧流重挂（index.js 在收到 state 事件时调用） */
  async resyncStream() {
    if (this._stream && this._activeId !== null && this._stream.tabId !== this._activeId) {
      await this._detachStream()
      if (this._watchers > 0) await this._attachStream()
    }
  }

  /** 优雅关闭（面板/协议可调）：context.close() 落盘 cookie 后再走，下次启动免登录 */
  async closeNow() {
    this._touch()
    await this._closeContext()
    return { ok: true }
  }

  /**
   * 人机共驾输入派发：面板画布的鼠标/滚轮/键盘 → 活动页面。
   * 设计约束：不自动拉起浏览器（未运行即拒绝，避免悬停误启动）；事件进顺序队列
   * 串行派发（鼠标移动高频，乱序会拖拽断裂）；坐标由面板按帧原始尺寸换算好。
   */
  async humanInput(msg) {
    if (!this._context) return { ok: false, error: '浏览器未运行' }
    const page = this._page(this._activeId)
    if (!page) return { ok: false, error: '无活动页面' }
    const buttonName = (b) => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left')
    const coord = (v) => {
      const n = Math.round(Number(v))
      return Number.isFinite(n) ? Math.min(20000, Math.max(0, n)) : 0
    }
    const dispatch = async () => {
      switch (msg.kind) {
        case 'mousemove':
          await page.mouse.move(coord(msg.x), coord(msg.y))
          break
        case 'mousedown':
          await page.mouse.move(coord(msg.x), coord(msg.y))
          await page.mouse.down({ button: buttonName(msg.button), clickCount: Math.min(3, Math.max(1, Number(msg.clicks) || 1)) })
          break
        case 'mouseup':
          await page.mouse.up({ button: buttonName(msg.button), clickCount: Math.min(3, Math.max(1, Number(msg.clicks) || 1)) })
          break
        case 'wheel':
          await page.mouse.wheel(Math.max(-5000, Math.min(5000, Number(msg.dx) || 0)), Math.max(-5000, Math.min(5000, Number(msg.dy) || 0)))
          break
        case 'key':
          if (typeof msg.combo === 'string' && msg.combo.trim() !== '') {
            await page.keyboard.press(msg.combo.trim())
          }
          break
        default:
          return
      }
    }
    this._touch()
    // 顺序队列：人手高频输入与 agent 工具动作都走同一 page，乱序会拖拽断裂
    this._inputQueue = (this._inputQueue ?? Promise.resolve()).then(dispatch).catch(() => {})
    return { ok: true }
  }

  /** 关闭浏览器上下文（保 profile） */
  async _closeContext() {
    const context = this._context
    if (!context) return
    this._context = null
    this._pages.clear()
    this._titles.clear()
    this._activeId = null
    await this._detachStream()
    try {
      await context.close()
    } catch {}
    this._emit({ kind: 'closed' })
    this._touch()
  }

  /** 插件卸载：全量清理（幂等） */
  async dispose() {
    this._disposed = true
    if (this._idleTimer) {
      clearInterval(this._idleTimer)
      this._idleTimer = null
    }
    this._watchers = 0
    await this._closeContext()
    try {
      fs.unlinkSync(path.join(dshHomeDir(), 'dsh-kit', 'browser-profile', '.pid'))
    } catch {}
    this._listeners.clear()
  }
}
