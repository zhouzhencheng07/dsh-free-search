// dsh-kit 内置浏览器——BrowserService（宿主半边核心，2026-09-04）
//
// 职责：vendored playwright-core（host-vendor/，钉 1.62.1）驱动系统 Edge（channel
// 方式，失败退 executablePath 探测链），管理持久化上下文（专用 profile，登录态跨
// 会话保留）、页面集（agent 活动页 / 面板观察页双指针，见 _viewId 注释）、帧流中继；
// 对工具层（browser-tools.ts）与面板 ws（index.ts）提供同一套操作面。TS 源码（tsc
// 构建出 dist 运行）、零运行时依赖声明；ws 服务器与 node-pty 同款多锚点解析在
// index.ts 完成，这里不重复。
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

// ── vendored playwright 的最小依赖面 ──
// playwright-core 经 createRequire 载入（CJS，类型不随 require 解析），这里只声明
// 我们实际触达的方法作为契约；未列到的能力视为不存在，运行时行为不受影响。
interface PwFrame {}

interface PwLocator {
  count(): Promise<number>
  first(): PwLocator
  click(options?: { timeout?: number }): Promise<void>
  fill(value: string, options?: { timeout?: number }): Promise<void>
  press(key: string, options?: { timeout?: number }): Promise<void>
  setChecked(checked: boolean, options?: { timeout?: number }): Promise<void>
  selectOption(value: string, options?: { timeout?: number }): Promise<void>
  ariaSnapshot(options?: { mode?: string }): Promise<string>
}

/** 纳管页：__dshTabId 是本服务盖在 playwright Page 上的管理标记（幂等锚） */
type PwPage = {
  url(): string
  title(): Promise<string>
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  goBack(options?: { timeout?: number }): Promise<unknown>
  goForward(options?: { timeout?: number }): Promise<unknown>
  reload(options?: { timeout?: number }): Promise<unknown>
  locator(selector: string): PwLocator
  getByRole(role: string, options?: { name?: string }): PwLocator
  getByText(text: string): PwLocator
  evaluate(expression: string): Promise<unknown>
  screenshot(options?: { fullPage?: boolean; type?: string }): Promise<Buffer>
  close(): Promise<void>
  mainFrame(): PwFrame
  on(event: 'framenavigated', cb: (frame: PwFrame) => void): void
  on(event: 'crash', cb: () => void): void
  on(event: 'close', cb: () => void): void
  keyboard: { press(key: string): Promise<void>; insertText(text: string): Promise<void> }
  mouse: {
    move(x: number, y: number): Promise<void>
    down(options?: { button?: string; clickCount?: number }): Promise<void>
    up(options?: { button?: string; clickCount?: number }): Promise<void>
    wheel(dx: number, dy: number): Promise<void>
  }
  __dshTabId?: number
}

interface PwCdpFramePayload {
  data: string
  sessionId?: string
  metadata?: unknown
}

interface PwCdpSession {
  on(event: string, cb: (payload: PwCdpFramePayload) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  detach(): Promise<void>
}

interface PwBrowserProcess {
  pid?: number
}

interface PwContext {
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  on(event: 'page', cb: (page: PwPage) => void): void
  on(event: 'close', cb: () => void): void
  newCDPSession(page: PwPage): Promise<PwCdpSession>
  close(): Promise<void>
  browser?(): { process?(): PwBrowserProcess | null } | null
}

interface PwModule {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<PwContext>
  }
}

/** 事件总线负载（index.ts 的 ws state/event 转发据此成型） */
export type BrowserEvent =
  | { kind: 'state' }
  | { kind: 'closed' }
  | { kind: 'navigated'; tabId: number; url: string; title: string }
  | { kind: 'crashed'; tabId: number }

/** act 工具参数的宿主侧契约（browser-tools 校验后原样传入） */
export interface ActArgs {
  action?: string
  tabId?: number
  value?: string
  key?: string
  timeoutMs?: number
  snapshot?: boolean
  role?: string
  name?: string
  text?: string
  selector?: string
}

/** 人机共驾输入消息（面板画布 → ws → 本服务；坐标已按帧原始尺寸换算）。
 *  kind:'key' = 面板 keydown 直转的组合键（英文逐键/快捷键）；kind:'text' =
 *  面板 IME 组合提交的整段文本（中文等组合输入无法用合成 keydown 表达，
 *  走 keyboard.insertText 在远程光标处整段插入）。 */
export type HumanInputMsg =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown'; x: number; y: number; button?: number; clicks?: number }
  | { kind: 'mouseup'; button?: number; clicks?: number }
  | { kind: 'wheel'; dx?: number; dy?: number }
  | { kind: 'key'; combo?: string }
  | { kind: 'text'; text?: string }

const IDLE_CLOSE_MS = 10 * 60 * 1000
const IDLE_TICK_MS = 30 * 1000
const GOTO_TIMEOUT = 15000
const ACT_TIMEOUT_DEFAULT = 5000
const ACT_TIMEOUT_MAX = 15000
const SNAPSHOT_CAP = 8 * 1024
const EVAL_CAP = 64 * 1024
const LAUNCH_TIMEOUT = 30000

/** 载入 vendored playwright-core（CJS 入口 index.js）。失败返回 null（能力整体不可用）。 */
function loadPlaywright(): PwModule | null {
  let vendorDir: string
  try {
    vendorDir = fileURLToPath(new URL('../host-vendor/playwright-core/', import.meta.url))
  } catch {
    return null
  }
  const entry = path.join(vendorDir, 'index.js')
  if (!fs.existsSync(entry)) return null
  try {
    return createRequire(import.meta.url)(entry) as PwModule
  } catch {
    return null
  }
}

/** 找系统 Chromium 系浏览器（channel 失败后的 executablePath 兜底链，按平台列常见路径）。 */
function browserExecutableCandidates(): string[] {
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
export function capText(text: string, cap: number = SNAPSHOT_CAP): string {
  if (typeof text !== 'string') return ''
  if (text.length <= cap) return text
  return text.slice(0, cap) + `\n…（快照超过 ${cap} 字符已截断，可用 locator('body').ariaSnapshot 的区域化观察替代——当前版本请缩小断言范围）`
}

/** 从 PNG 字节取宽高（IHDR 定长偏移，纯函数供单测） */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 校验 act 的定位参数：三选一（role+name / text / selector），返回归一化对象或错误 */
export function normalizeLocatorArgs(args?: ActArgs): { kind: 'selector'; selector: string } | { kind: 'role'; role: string; name: string } | { kind: 'text'; text: string } | { error: string } {
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
export function normalizeActArgs(args?: ActArgs): { action: string } | { error: string } {
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
function dshHomeDir(): string {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env.trim() : path.join(os.homedir(), '.dsh')
}

export class BrowserService {
  private _log: (msg: string) => void
  private _pw: PwModule | null
  private _context: PwContext | null
  private _launchError: string | null
  private _launching: Promise<{ ok: true } | { ok: false; error: string }> | null
  private _pages: Map<number, PwPage>
  private _titles: Map<number, string>
  private _nextId: number
  private _activeId: number | null
  /** 面板观察页：帧流、人机共驾输入、面板 URL 栏都作用于它；agent 的默认目标页是
   *  _activeId。两者分离（人看 A 页、agent 干 B 页互不干扰）。观察页跟随 agent 是
   *  恒定语义（用户定稿：浏览器就该与 agent 同步），保守跟随：只有"状态改变"类
   *  agent 操作（navigate/act/新页）才拽画面，snapshot/截图/eval 等观察类不打扰。 */
  private _viewId: number | null
  private _listeners: Set<(evt: BrowserEvent) => void>
  private _lastActivity: number
  private _idleTimer: NodeJS.Timeout | null
  private _watchers: number
  private _stream: { cdp: PwCdpSession; tabId: number } | null
  private _disposed: boolean
  private _inputQueue: Promise<void>
  private _onFrame: ((data: string, metadata: unknown) => void) | undefined

  constructor({ log = () => {} }: { log?: (msg: string) => void } = {}) {
    this._log = log
    this._pw = loadPlaywright()
    this._context = null
    this._launchError = null
    this._launching = null
    this._pages = new Map() // tabId → Page
    this._titles = new Map() // tabId → title
    this._nextId = 1
    this._activeId = null
    this._viewId = null
    this._listeners = new Set()
    this._lastActivity = Date.now()
    this._idleTimer = null
    this._watchers = 0 // 面板帧流订阅数（保活）
    this._stream = null // { cdp, tabId }
    this._disposed = false
    this._inputQueue = Promise.resolve()
    if (this._pw) this._startIdleTimer()
  }

  /** 插件/宿主能力面是否可用（vendor 加载成功） */
  get available(): boolean {
    return this._pw !== null
  }

  get launchError(): string | null {
    return this._launchError
  }

  on(cb: (evt: BrowserEvent) => void): () => boolean {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  private _emit(evt: BrowserEvent): void {
    for (const cb of this._listeners) {
      try {
        cb(evt)
      } catch {
        // 监听方异常不传染
      }
    }
  }

  private _touch(): void {
    this._lastActivity = Date.now()
  }

  private _startIdleTimer(): void {
    if (this._idleTimer) return
    this._idleTimer = setInterval(() => {
      if (this._disposed) return
      const idleFor = Date.now() - this._lastActivity
      if (this._context && this._watchers === 0 && idleFor > IDLE_CLOSE_MS) {
        this._log('browser: 空闲超时，自动关闭（登录态保留在专用 profile）')
        void this._closeContext()
      }
    }, IDLE_TICK_MS)
    this._idleTimer.unref?.()
  }

  /** 启动前清理上次异常留下的孤儿实例（pidfile 信任 + 进程名核验） */
  private _cleanupOrphan(): void {
    const pidFile = path.join(dshHomeDir(), 'dsh-kit', 'browser-profile', '.pid')
    let pid = 0
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    } catch {
      return
    }
    if (!Number.isInteger(pid) || pid <= 0) return
    const isBrowser = () =>
      new Promise<boolean>((resolve) => {
        let out = ''
        let child: import('node:child_process').ChildProcess
        try {
          child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
        } catch {
          resolve(false)
          return
        }
        child.stdout?.on('data', (d: Buffer) => {
          out += d
        })
        child.on('error', () => resolve(false))
        child.on('close', () => resolve(/msedge|chrome/i.test(out)))
      })
    const kill = () =>
      new Promise<boolean>((resolve) => {
        let child: import('node:child_process').ChildProcess
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
  async ensure(): Promise<{ ok: true } | { ok: false, error: string }> {
    this._touch()
    if (this._context) return { ok: true }
    if (this._launchError) return { ok: false, error: this._launchError }
    if (!this._launching) {
      // 落定即清：context 事后关闭（关最后一页/空闲关闭/崩溃）后 _launching 若残留
      // 已落定的旧 promise，这里会误报 ok，调用方拿 null context 去 newPage 直接崩，
      // 服务从此砖死到重启——正式环境 0.4.3 实际踩中过
      this._launching = this._launch().finally(() => { this._launching = null })
    }
    return this._launching
  }

  private async _launch(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this._pw) {
      this._launchError = 'playwright-core vendor 不可用（host-vendor 缺失或损坏）'
      return { ok: false, error: this._launchError }
    }
    this._cleanupOrphan()
    // 启动即广播：面板拿到 launching 状态可提示「启动中」而不是空白等待
    this._emit({ kind: 'state' })
    const userDataDir = path.join(dshHomeDir(), 'dsh-kit', 'browser-profile')
    fs.mkdirSync(userDataDir, { recursive: true })
    const common = {
      headless: true,
      viewport: { width: 1280, height: 800 },
      timeout: LAUNCH_TIMEOUT,
    }
    let context: PwContext | null = null
    let lastError: unknown = null
    const attempts: Array<{ channel?: string; executablePath?: string }> = [
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
    ]
    for (const attempt of attempts) {
      try {
        context = await this._pw.chromium.launchPersistentContext(userDataDir, { ...common, ...attempt })
        break
      } catch (error) {
        lastError = error
        this._log(`browser: 启动失败（${attempt.channel ?? attempt.executablePath}）：${error instanceof Error ? error.message : error}`)
      }
    }
    if (!context) {
      this._launchError = `无法启动系统浏览器（Edge/Chrome）：${lastError instanceof Error ? lastError.message : lastError}`
      this._emit({ kind: 'state' })
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
  private _adopt(page: PwPage): number {
    if (page.__dshTabId !== undefined) {
      // 已纳管（newPage 与 'page' 事件都会走到这里）：提升为 agent 活动页，
      // 观察页恒跟随（浏览器与 agent 同步）
      this._activeId = page.__dshTabId
      this._setView(page.__dshTabId)
      return page.__dshTabId
    }
    const tabId = this._nextId++
    this._pages.set(tabId, page)
    this._activeId = tabId
    page.__dshTabId = tabId
    this._setView(tabId)
    page.title().then((t) => {
      this._titles.set(tabId, t)
      this._emit({ kind: 'navigated', tabId, url: page.url(), title: t })
    }).catch(() => {})
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const id = page.__dshTabId
      if (id === undefined) return
      page.title().then((t) => {
        this._titles.set(id, t)
      }).catch(() => {})
      this._touch()
      this._emit({ kind: 'navigated', tabId: id, url: page.url(), title: this._titles.get(id) ?? '' })
      this._resyncStream(id)
    })
    page.on('crash', () => {
      const id = page.__dshTabId
      if (id === undefined) return
      this._emit({ kind: 'crashed', tabId: id })
      this._pages.delete(id)
      this._titles.delete(id)
      this._pageGone(id)
    })
    page.on('close', () => {
      const id = page.__dshTabId
      if (id === undefined) return
      this._pages.delete(id)
      this._titles.delete(id)
      this._pageGone(id)
      this._emit({ kind: 'state' })
    })
    this._emit({ kind: 'state' })
    return tabId
  }

  /** 切观察页（幂等）：帧流重挂到新页；每次都广播 state（面板页签条高亮要跟随） */
  private _setView(tabId: number): void {
    if (this._viewId === tabId) return
    this._viewId = tabId
    this._emit({ kind: 'state' })
    void this._resyncStream(tabId)
  }

  /** 页面消失（关闭/崩溃）后两个指针的回退：agent 活动页取剩余首页；观察页优先跟随活动页 */
  private _pageGone(id: number): void {
    if (this._activeId === id) this._activeId = this._pages.keys().next().value ?? null
    if (this._viewId === id) {
      this._viewId = this._activeId ?? this._pages.keys().next().value ?? null
      if (this._viewId !== null) void this._resyncStream(this._viewId)
    }
    // 流的宿主页没了就拆掉：CDP 会话已死，留着会让面板把最后一帧当成活画面
    // （关最后一页后面板冻结在旧视图，看起来像还在直播，误导人以为页面还在）
    if (this._stream && this._stream.tabId === id) void this._detachStream()
  }

  /** 无页则建一页（about:blank） */
  async ensurePage(): Promise<{ ok: true; tabId?: number } | { ok: false; error: string }> {
    const ensureResult = await this.ensure()
    if (!ensureResult.ok) return ensureResult
    if (this._activeId === null || !this._pages.has(this._activeId)) {
      await this._context!.newPage()
      // newPage 触发 'page' 事件 → _adopt 设为活动页
      if (this._activeId === null) return { ok: false, error: '页面创建失败' }
    }
    return { ok: true, tabId: this._activeId }
  }

  private _page(tabId?: number | null): PwPage | null {
    if (tabId === undefined || tabId === null) {
      if (this._activeId === null) return null
      return this._pages.get(this._activeId) ?? null
    }
    return this._pages.get(Number(tabId)) ?? null
  }

  async listPages(): Promise<{ ok: true; pages: Array<{ tabId: number; url: string; title: string; active: boolean; viewed: boolean }>; activeId: number | null; viewId: number | null } | { ok: false; error: string }> {
    const ensureResult = await this.ensure()
    if (!ensureResult.ok) return { ok: false, error: ensureResult.error }
    const pages: Array<{ tabId: number; url: string; title: string; active: boolean; viewed: boolean }> = []
    for (const [tabId, page] of this._pages) {
      pages.push({ tabId, url: page.url(), title: this._titles.get(tabId) ?? '', active: tabId === this._activeId, viewed: tabId === this._viewId })
    }
    return { ok: true, pages, activeId: this._activeId, viewId: this._viewId }
  }

  async state(): Promise<{ available: false; error: string } | { available: true; running: false; launching: boolean; error: string | null } | { available: true; running: true; launching: false; pages: Array<{ tabId: number; url: string; title: string; active: boolean; viewed: boolean }>; activeId: number | null; viewId: number | null }> {
    if (!this._pw) return { available: false, error: this._launchError ?? 'playwright-core vendor 不可用' }
    if (!this._context) return { available: true, running: false, launching: this._launching !== null, error: this._launchError }
    const listed = await this.listPages()
    if (!listed.ok) return { available: true, running: true, launching: false, pages: [], activeId: null, viewId: null }
    return {
      available: true,
      running: true,
      launching: false,
      pages: listed.pages,
      activeId: listed.activeId,
      viewId: listed.viewId,
    }
  }

  /** 导航（工具与面板共用）：返回 { tabId, title, url, snapshot? }。
   *  agent 路径作用于 agent 活动页（成功后按 follow 开关把观察页拽过去）；
   *  forHuman（面板 URL 栏）作用于观察页、不动 agent 活动页。 */
  async navigate(url: string, { newTab = false, snapshot = true, forHuman = false }: { newTab?: boolean; snapshot?: boolean; forHuman?: boolean } = {}): Promise<{ ok: true; tabId: number; url: string; title: string; snapshot?: string } | { ok: false; error: string }> {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: '仅支持 http/https URL' }
    }
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const anchorId = forHuman ? this._viewId : this._activeId
    let page: PwPage | undefined
    if (newTab || anchorId === null || !this._pages.has(anchorId)) {
      page = await this._context!.newPage()
      // newPage 与 'page' 事件都会走 _adopt（幂等），显式 adopt 一次拿稳 tabId
      this._adopt(page)
      page = this._pages.get(this._activeId!)
    } else {
      page = this._pages.get(anchorId)!
    }
    const tabId = page!.__dshTabId!
    try {
      await page!.goto(url.trim(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT })
    } catch (error) {
      return { ok: false, error: `导航失败：${error instanceof Error ? error.message : error}（页面可能仍在加载，可重试或改用 snapshot 观察）` }
    }
    this._touch()
    const title = await page!.title().catch(() => '')
    this._titles.set(tabId, title)
    const result: { ok: true; tabId: number; url: string; title: string; snapshot?: string } = { ok: true, tabId, url: page!.url(), title }
    if (snapshot) result.snapshot = capText(await this._snapshotOf(page!))
    // 观察页跟随（恒定语义）：agent 导航与人的 URL 栏导航都作用于观察页
    this._setView(tabId)
    this._emit({ kind: 'navigated', tabId, url: result.url, title })
    return result
  }

  private async _snapshotOf(page: PwPage): Promise<string> {
    try {
      return await page.locator('body').ariaSnapshot({ mode: 'ai' })
    } catch (error) {
      return `（快照失败：${error instanceof Error ? error.message : error}）`
    }
  }

  /** 紧凑树观察 */
  async snapshot(tabId?: number | null): Promise<{ ok: true; tabId: number; url: string; title: string; snapshot: string } | { ok: false; error: string }> {
    const ensured = await this.ensure()
    if (!ensured.ok) return { ok: false, error: ensured.error }
    const page = this._page(tabId)
    if (!page) return { ok: false, error: `页不存在：${tabId ?? '(缺省)'}（用 browser_navigate 或先开一页）` }
    this._touch()
    const id = page.__dshTabId!
    return { ok: true, tabId: id, url: page.url(), title: this._titles.get(id) ?? '', snapshot: capText(await this._snapshotOf(page)) }
  }

  /** 统一动作：click/type/press/check/uncheck/select；默认返回新快照（动作即观察） */
  async act(args: ActArgs): Promise<{ ok: true; tabId: number; url: string; title: string; matched: number | null; warning?: string; snapshot?: string } | { ok: false; error: string }> {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const page = this._page(args.tabId)
    if (!page) return { ok: false, error: `页不存在：${args.tabId}` }
    const act = normalizeActArgs(args)
    if ('error' in act) return { ok: false, error: act.error }
    const timeout = Math.min(Math.max(Number(args.timeoutMs) || ACT_TIMEOUT_DEFAULT, 1000), ACT_TIMEOUT_MAX)
    const hasLocator = [args?.role, args?.name, args?.text, args?.selector].some(
      (v) => v !== undefined && v !== null && String(v).trim() !== '',
    )
    let locator: PwLocator | null = null
    let loc: ReturnType<typeof normalizeLocatorArgs> | null = null
    try {
      if (!hasLocator && act.action === 'press') {
        // 无定位目标的键盘事件直接发给页面
        await page.keyboard.press(args.key ?? '')
        locator = null
      } else {
        loc = normalizeLocatorArgs(args)
        if ('error' in loc) return { ok: false, error: loc.error }
        if (loc.kind === 'selector') locator = page.locator(loc.selector)
        else if (loc.kind === 'role') locator = page.getByRole(loc.role, loc.name ? { name: loc.name } : {})
        else locator = page.getByText(loc.text)
      }
    } catch (error) {
      return { ok: false, error: `定位失败：${error instanceof Error ? error.message : error}` }
    }
    let matched: number | null = null
    if (locator) {
      try {
        matched = await locator.count()
      } catch {
        matched = null
      }
      if (matched === 0) {
        const l = loc!
        return {
          ok: false,
          error: `目标未找到（${l.kind}${l.kind === 'role' ? `=${l.role}` : ''}${'name' in l && l.name ? ` name=${l.name}` : ''}${l.kind === 'text' ? ` text=${l.text}` : ''}${l.kind === 'selector' ? ` selector=${l.selector}` : ''}）——重取 browser_snapshot 再构造定位，不要原样重试`,
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
            await target.press(args.key ?? '', { timeout })
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
        return { ok: false, error: `${act.action} 失败：${error instanceof Error ? error.message : error}——重取 browser_snapshot 后重建定位，不要原样重试` }
      }
    }
    const result: { ok: true; tabId: number; url: string; title: string; matched: number | null; warning?: string; snapshot?: string } = {
      ok: true,
      tabId: page.__dshTabId!,
      url: page.url(),
      title: await page.title().catch(() => ''),
      matched,
    }
    // act 是 agent 的状态改变操作：观察页恒跟随（与 navigate 同规则）
    this._setView(page.__dshTabId!)
    if (matched !== null && matched > 1) result.warning = `目标不唯一（${matched} 个匹配），已作用于第一个——可加 name/text 收窄`
    if (args.snapshot !== false) result.snapshot = capText(await this._snapshotOf(page))
    return result
  }

  /** 页面内 JS（返回 JSON 值，限长） */
  async evaluate(expression: string, tabId?: number | null): Promise<{ ok: true; tabId: number; value: string } | { ok: false; error: string }> {
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
      let json: string
      try {
        json = JSON.stringify(value ?? null)
      } catch {
        json = String(value)
      }
      if (json.length > EVAL_CAP) json = json.slice(0, EVAL_CAP) + '…（结果超长已截断）'
      return { ok: true, tabId: page.__dshTabId!, value: json }
    } catch (error) {
      return { ok: false, error: `evaluate 失败：${error instanceof Error ? error.message : error}` }
    }
  }

  /** 截图：返回 buffer + 尺寸（image 附件化在 browser-tools 里做，需 exec/ctx） */
  async screenshot({ fullPage = false, tabId }: { fullPage?: boolean; tabId?: number | null } = {}): Promise<{ ok: true; tabId: number; url: string; buffer: Buffer; size: { width: number; height: number } | null } | { ok: false; error: string }> {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    const page = this._page(tabId)
    if (!page) return { ok: false, error: `页不存在：${tabId}` }
    this._touch()
    try {
      const buffer = await page.screenshot({ fullPage: fullPage === true, type: 'png' })
      return { ok: true, tabId: page.__dshTabId!, url: page.url(), buffer, size: pngSize(buffer) }
    } catch (error) {
      return { ok: false, error: `截图失败：${error instanceof Error ? error.message : error}` }
    }
  }

  /** 关一页 */
  async closePage(tabId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const page = this._pages.get(Number(tabId))
    if (!page) return { ok: false, error: `页不存在：${tabId}` }
    try {
      await page.close()
    } catch (error) {
      return { ok: false, error: `关闭失败：${error instanceof Error ? error.message : error}` }
    }
    // 关掉最后一个页签 = 整个浏览器收摊（正常浏览器语义：0 页即关窗，不留空转
    // 实例）；优雅关闭落盘 cookie，agent 下次使用懒启动重来。崩溃路径不走这里
    // （页面崩 ≠ 用户要停），空态交给面板提示兜底
    if (this._pages.size === 0 && this._context !== null) await this.closeNow()
    return { ok: true }
  }

  /** 人切观察页（面板页签条）：只动观察指针，agent 的默认目标页不受影响 */
  async activatePage(tabId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = Number(tabId)
    if (!this._pages.has(id)) return { ok: false, error: `页不存在：${tabId}` }
    this._touch()
    this._setView(id)
    return { ok: true }
  }

  /** 面板「＋」新建页签：新页即观察页（adopt 会把它提为 agent 活动页，保持既有
   *  语义）；无页时的首建走 ensurePage 兜底 */
  async humanNewTab(): Promise<{ ok: true; tabId?: number } | { ok: false; error: string }> {
    const ensureResult = await this.ensure()
    if (!ensureResult.ok) return ensureResult
    if (this._activeId === null || !this._pages.has(this._activeId)) return this.ensurePage()
    await this._context!.newPage()
    // newPage 触发 'page' 事件 → _adopt（活动页 + follow 观察页）
    return { ok: true, tabId: this._viewId ?? undefined }
  }

  /** 面板历史按钮（作用于观察页）：back/forward/reload。无历史可退/超时不视为
   *  故障（页面维持原状），仍回报当前位置 */
  async history(op: 'back' | 'forward' | 'reload'): Promise<{ ok: true; tabId: number; url: string; title: string } | { ok: false; error: string }> {
    const page = this._viewId !== null ? this._pages.get(this._viewId) ?? null : null
    if (!page) return { ok: false, error: '无观察页（浏览器未运行或页签已关）' }
    this._touch()
    try {
      if (op === 'back') await page.goBack({ timeout: GOTO_TIMEOUT })
      else if (op === 'forward') await page.goForward({ timeout: GOTO_TIMEOUT })
      else await page.reload({ timeout: GOTO_TIMEOUT })
    } catch (error) {
      this._log(`browser: history ${op}：${error instanceof Error ? error.message : error}`)
    }
    const tabId = page.__dshTabId!
    const title = await page.title().catch(() => '')
    this._titles.set(tabId, title)
    this._emit({ kind: 'navigated', tabId, url: page.url(), title })
    return { ok: true, tabId, url: page.url(), title }
  }

  // ── 面板帧流 ──

  /** 面板订阅帧流（引用计数；复路：同一活动页只挂一条 CDP 会话） */
  async watcherOpen(onFrame: (data: string, metadata: unknown) => void): Promise<{ ok: true } | { ok: false; error: string }> {
    const ensured = await this.ensure()
    if (!ensured.ok) return ensured
    this._watchers++
    this._touch()
    this._onFrame = onFrame
    if (!this._stream) await this._attachStream()
    return { ok: true }
  }

  watcherClose(): void {
    this._watchers = Math.max(0, this._watchers - 1)
    if (this._watchers === 0 && this._stream) {
      void this._detachStream()
    }
  }

  private async _attachStream(): Promise<void> {
    const page = this._viewId !== null ? this._pages.get(this._viewId) ?? null : null
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
      this._stream = { cdp, tabId: page.__dshTabId! }
      // 首帧兜底：screencast 只在重绘时推帧，静态页面可能长时间没有首帧（面板
      // 空白）。attach 后立即抓一帧推给面板，之后帧流自然接管。
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
        const data = (shot as { data?: string })?.data
        if (data && this._onFrame) this._onFrame(data, null)
      } catch {}
    } catch (error) {
      this._log(`browser: 帧流启动失败：${error instanceof Error ? error.message : error}`)
    }
  }

  private async _detachStream(): Promise<void> {
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
  private async _resyncStream(tabId: number): Promise<void> {
    if (!this._stream || this._stream.tabId === tabId) return
    await this._detachStream()
    if (this._watchers > 0) await this._attachStream()
  }

  /** 面板 URL 栏手动导航（作用于观察页，不动 agent 活动页；不取快照） */
  async humanOpen(url: string): Promise<{ ok: true; tabId: number; url: string; title: string } | { ok: false; error: string }> {
    return this.navigate(url, { snapshot: false, forHuman: true })
  }

  /** 观察页切换后的帧流重挂（index.ts 在收到 state 事件时调用；幂等兜底——
   *  _setView 内部已重挂，这里覆盖事件驱动的路径） */
  async resyncStream(): Promise<void> {
    if (this._stream && this._viewId !== null && this._stream.tabId !== this._viewId) {
      await this._detachStream()
      if (this._watchers > 0) await this._attachStream()
    }
  }

  /** 优雅关闭（面板/协议可调）：context.close() 落盘 cookie 后再走，下次启动免登录 */
  async closeNow(): Promise<{ ok: true }> {
    this._touch()
    await this._closeContext()
    return { ok: true }
  }

  /**
   * 人机共驾输入派发：面板画布的鼠标/滚轮/键盘 → 观察页。
   * 设计约束：不自动拉起浏览器（未运行即拒绝，避免悬停误启动）；事件进顺序队列
   * 串行派发（鼠标移动高频，乱序会拖拽断裂）；坐标由面板按帧原始尺寸换算好。
   */
  async humanInput(msg: HumanInputMsg): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this._context) return { ok: false, error: '浏览器未运行' }
    const page = this._viewId !== null ? this._pages.get(this._viewId) ?? null : null
    if (!page) return { ok: false, error: '无观察页面' }
    const buttonName = (b: number | undefined) => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left')
    const coord = (v: number) => {
      const n = Math.round(Number(v))
      return Number.isFinite(n) ? Math.min(20000, Math.max(0, n)) : 0
    }
    const dispatch = async (): Promise<void> => {
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
        case 'text':
          // IME 组合提交的整段文本：insertText 只派发文本输入（无 key 事件），
          // 在远程光标处插入；限长防面板侧异常把宿主当管道灌爆
          if (typeof msg.text === 'string' && msg.text !== '') {
            const text = msg.text.length > 2000 ? msg.text.slice(0, 2000) : msg.text
            await page.keyboard.insertText(text)
          }
          break
        default:
          return
      }
    }
    this._touch()
    // 顺序队列：人手高频输入与 agent 工具动作都走同一 page，乱序会拖拽断裂
    this._inputQueue = this._inputQueue.then(dispatch).catch(() => {})
    return { ok: true }
  }

  /** 关闭浏览器上下文（保 profile） */
  private async _closeContext(): Promise<void> {
    const context = this._context
    if (!context) return
    this._context = null
    this._pages.clear()
    this._titles.clear()
    this._activeId = null
    this._viewId = null
    await this._detachStream()
    try {
      await context.close()
    } catch {}
    this._emit({ kind: 'closed' })
    this._touch()
  }

  /** 插件卸载：全量清理（幂等） */
  async dispose(): Promise<void> {
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
