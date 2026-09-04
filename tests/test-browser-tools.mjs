// dsh-kit 浏览器纯逻辑单测（不启浏览器）：
//   1) browser.js 纯函数：capText / pngSize / normalizeLocatorArgs / normalizeActArgs
//   2) browser-tools.js：defineTool mock 下 5 个工具的 schema/render/execute 投影
// 运行：node tests/test-browser-tools.mjs
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { capText, pngSize, normalizeLocatorArgs, normalizeActArgs, BrowserService } = await import(
  pathToFileURL(path.join(root, 'src/browser.js')).href
)
const { buildBrowserTools } = await import(pathToFileURL(path.join(root, 'src/browser-tools.js')).href)

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ✔ ${name}`)
}

// ── capText ──
{
  const short = 'hello'
  assert.equal(capText(short), 'hello')
  ok('capText 短文本原样')
  const long = 'x'.repeat(9000)
  const capped = capText(long, 8 * 1024)
  assert.ok(capped.length > 8 * 1024 && capped.startsWith('x') && capped.includes('已截断'))
  ok('capText 超长截断带提示')
}

// ── pngSize ──
{
  const head = Buffer.alloc(24)
  head.writeUInt32BE(0x89504e47, 0)
  head.writeUInt32BE(3, 16)
  head.writeUInt32BE(7, 20)
  assert.deepEqual(pngSize(head), { width: 3, height: 7 })
  assert.equal(pngSize(Buffer.alloc(10)), null)
  assert.equal(pngSize('nope'), null)
  ok('pngSize 解析 IHDR 与非法输入')
}

// ── normalizeLocatorArgs ──
{
  assert.deepEqual(normalizeLocatorArgs({ role: 'button', name: '添加' }), { kind: 'role', role: 'button', name: '添加' })
  assert.deepEqual(normalizeLocatorArgs({ role: 'button' }), { kind: 'role', role: 'button', name: '' })
  assert.deepEqual(normalizeLocatorArgs({ text: ' 登录 ' }), { kind: 'text', text: ' 登录 ' })
  assert.deepEqual(normalizeLocatorArgs({ selector: '#go' }), { kind: 'selector', selector: '#go' })
  assert.ok(normalizeLocatorArgs({}).error)
  assert.ok(normalizeLocatorArgs().error)
  ok('normalizeLocatorArgs 三选一归一化与缺参报错')
}

// ── normalizeActArgs ──
{
  assert.deepEqual(normalizeActArgs({ action: 'click' }), { action: 'click' })
  assert.ok(normalizeActArgs({ action: 'type' }).error) // type 缺 value
  assert.deepEqual(normalizeActArgs({ action: 'type', value: 'hi' }), { action: 'type' })
  assert.ok(normalizeActArgs({ action: 'press' }).error) // press 缺 key
  assert.deepEqual(normalizeActArgs({ action: 'press', key: 'Enter' }), { action: 'press' })
  assert.ok(normalizeActArgs({ action: 'hover' }).error) // 未知动作
  ok('normalizeActArgs 动作/参数配套校验')
}

// ── buildBrowserTools（mock defineTool + mock service）──
{
  const captured = []
  const defineTool = (def) => {
    captured.push(def)
    return def
  }
  const calls = []
  const service = {
    navigate: async (url, opts) => {
      calls.push(['navigate', url, opts])
      return { ok: true, tabId: 1, url, title: 'T', snapshot: '- heading "T"' }
    },
    snapshot: async () => ({ ok: true, tabId: 1, url: 'u', title: 'T', snapshot: '- s' }),
    act: async (args) => {
      calls.push(['act', args])
      return { ok: true, tabId: 1, url: 'u', title: 'T', matched: 1, snapshot: '- after' }
    },
    evaluate: async (expression) => {
      calls.push(['eval', expression])
      return { ok: true, tabId: 1, url: 'u', value: '"v"' }
    },
    screenshot: async () => ({ ok: true, tabId: 1, url: 'u', buffer: Buffer.from('png'), size: { width: 2, height: 3 } }),
  }
  const defs = buildBrowserTools({ defineTool, service, ctx: { get: () => undefined }, isDisabled: () => false })
  assert.equal(defs.length, 5)
  assert.deepEqual(
    defs.map((d) => d.name),
    ['browser_navigate', 'browser_snapshot', 'browser_act', 'browser_eval', 'browser_screenshot'],
  )
  ok('5 个工具按序注册')

  // navigate：execute → 返回值 + render 文本投影
  const navValue = await defs[0].execute({ url: 'http://x/' })
  assert.equal(navValue.tabId, 1)
  assert.ok(defs[0].output.render({}, navValue)[0].text.includes('http://x/'))
  assert.ok(defs[0].output.render({}, navValue)[0].text.includes('- heading "T"'))
  ok('navigate execute+render 内嵌快照')

  // act：无定位且非 press → 报错；press 无定位 → 放行
  await assert.rejects(() => defs[2].execute({ action: 'click' }), /缺少定位参数/)
  const pressValue = await defs[2].execute({ action: 'press', key: 'Enter' })
  assert.equal(pressValue.ok, true)
  ok('act 定位校验与 press 无定位放行')

  // screenshot：无 attachments 服务 → 优雅退化（note + 无 image 块）
  const shotValue = await defs[4].execute({ fullPage: false }, { agent: undefined })
  assert.ok(shotValue.path.endsWith('.png'))
  assert.equal(shotValue.image, null)
  assert.match(shotValue.note, /不支持图片输入|附件服务/)
  const shotBlocks = defs[4].output.render({}, shotValue)
  assert.equal(shotBlocks.length, 1)
  assert.match(shotBlocks[0].text, /截图已保存/)
  ok('screenshot 非多模态优雅退化（纯文本）')

  // screenshot：带 attachments + 多模态 → image 块
  const ctx2 = {
    get(name) {
      if (name === 'attachments') return { saveImages: async () => [{ ref: 1 }] }
      if (name === 'llm')
        return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
      return undefined
    },
  }
  const defs2 = buildBrowserTools({
    defineTool,
    service,
    ctx: ctx2,
    isDisabled: () => false,
  })
  const exec2 = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }, signal: { aborted: false } }
  const shot2 = await defs2[4].execute({}, exec2)
  assert.deepEqual(shot2.image, { ref: 1 })
  const blocks2 = defs2[4].output.render({}, shot2)
  assert.equal(blocks2.length, 2)
  assert.equal(blocks2[1].type, 'image')
  assert.deepEqual(blocks2[1].attachment, { ref: 1 })
  ok('screenshot 多模态 image 块附加')

  // isDisabled 守卫
  const defs3 = buildBrowserTools({ defineTool, service, ctx: {}, isDisabled: () => true })
  await assert.rejects(() => defs3[0].execute({ url: 'http://x/' }), /停用/)
  ok('browserEnabled 关闭时 execute 守卫生效')
}

// ── BrowserService vendor 缺失形态 ──
{
  // 传入不存在的目录?——BrowserService 无参注入点，此处仅验证对象可建、available 反映 vendor
  const svc = new BrowserService()
  assert.equal(typeof svc.available, 'boolean')
  await svc.dispose()
  ok('BrowserService 可构造且 dispose 幂等')
}

console.log(`\n全部通过：${passed} 项`)
