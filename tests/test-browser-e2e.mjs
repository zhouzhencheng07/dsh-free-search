// dsh-kit 浏览器服务端到端测试：合成 todo 页上跑完整 agent 循环
// navigate → snapshot → type/click → 断言快照 → check → 负路径 → screenshot → dispose
// 无 Edge/Chrome 环境自动 skip；DSH_HOME 重定向到临时目录（不碰真实 profile）。
// 运行：node tests/test-browser-e2e.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BrowserService } from '../src/browser.ts'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
if (!EDGE_CANDIDATES.some((p) => fs.existsSync(p))) {
  console.log('SKIP：本机无 Edge/Chrome，端到端跳过')
  process.exit(0)
}

const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>待办清单</title><style>
body{font-family:system-ui;max-width:420px;margin:40px auto}li.done span{text-decoration:line-through;color:#888}
#err{color:#c00;display:none}</style></head><body>
<h1>待办清单</h1>
<input id="inp" aria-label="新待办" placeholder="要做什么？"><button id="add" onclick="add()">添加</button>
<div id="err" role="alert">内容不能为空</div>
<ul id="list"></ul><div id="status" role="status"></div>
<script>
let todos=[]
function render(){
  const ul=document.getElementById('list');ul.innerHTML=''
  todos.forEach((t,i)=>{const li=document.createElement('li');if(t.done)li.className='done'
    const cb=document.createElement('input');cb.type='checkbox';cb.checked=t.done;cb.setAttribute('aria-label','完成: '+t.text)
    cb.onchange=()=>{todos[i].done=cb.checked;render()}
    const sp=document.createElement('span');sp.textContent=t.text
    li.append(cb,sp);ul.append(li)})
  document.getElementById('status').textContent='共 '+todos.length+' 项，已完成 '+todos.filter(t=>t.done).length+' 项'}
function add(){const inp=document.getElementById('inp');const v=inp.value.trim()
  if(!v){document.getElementById('err').style.display='block';return}
  document.getElementById('err').style.display='none';todos.push({text:v,done:false});inp.value='';render()}
</script></body></html>`

const server = http.createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  r.end(HTML)
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const base = `http://127.0.0.1:${server.address().port}/`

// DSH_HOME 重定向：profile/截图/pid 全落临时目录
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kit-e2e-'))
process.env.DSH_HOME = tmpHome

const events = []
let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ✔ ${name}`)
}

const service = new BrowserService({ log: () => {} })
const off = service.on((evt) => events.push(evt.kind))
try {
  const nav = await service.navigate(base, { snapshot: true })
  assert.equal(nav.ok, true, `navigate 失败：${nav.error}`)
  assert.match(nav.snapshot, /textbox "新待办"/)
  assert.match(nav.snapshot, /button "添加"/)
  ok(`navigate 返回内嵌快照（title=${nav.title}）`)

  const typed = await service.act({ action: 'type', role: 'textbox', name: '新待办', value: '买牛奶' })
  assert.equal(typed.ok, true, `type 失败：${typed.error}`)
  ok('act type 填输入框')

  const added = await service.act({ action: 'click', role: 'button', name: '添加' })
  assert.equal(added.ok, true, `click 失败：${added.error}`)
  assert.match(added.snapshot, /买牛奶/)
  assert.match(added.snapshot, /共 1 项/)
  ok('act click 提交且快照断言新条目')

  const checked = await service.act({ action: 'check', role: 'checkbox', name: '完成: 买牛奶' })
  assert.equal(checked.ok, true, `check 失败：${checked.error}`)
  assert.match(checked.snapshot, /\[checked\]/)
  ok('act check 勾选且快照断言 [checked]')

  const negative = await service.act({ action: 'click', role: 'button', name: '添加' })
  assert.equal(negative.ok, true)
  assert.match(negative.snapshot, /内容不能为空/)
  ok('负路径：空输入错误提示可见')

  const notFound = await service.act({ action: 'click', role: 'button', name: '不存在的按钮' })
  assert.equal(notFound.ok, false)
  assert.match(notFound.error, /目标未找到/)
  ok('act 目标未找到给出可恢复错误')

  // 人机共驾：坐标点击（输入派发与 agent 工具落在同一页面）
  const typed2 = await service.act({ action: 'type', role: 'textbox', name: '新待办', value: '人机共驾' })
  assert.equal(typed2.ok, true)
  const rectJson = await service.evaluate(`JSON.stringify(document.querySelector('#add').getBoundingClientRect())`)
  assert.equal(rectJson.ok, true)
  const rect = JSON.parse(rectJson.value)
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)
  const moved = await service.humanInput({ kind: 'mousemove', x: cx, y: cy })
  assert.equal(moved.ok, true)
  await service.humanInput({ kind: 'mousedown', x: cx, y: cy, button: 0, clicks: 1 })
  await service.humanInput({ kind: 'mouseup', x: cx, y: cy, button: 0, clicks: 1 })
  await new Promise((r) => setTimeout(r, 300))
  const afterInput = await service.snapshot()
  assert.match(afterInput.snapshot, /人机共驾/)
  ok('humanInput 坐标点击与工具层同页生效')

  // 未运行时不误拉起：新建服务实例（未 launch）输入应被拒绝
  const cold = new BrowserService({ log: () => {} })
  const rejected = await cold.humanInput({ kind: 'mousemove', x: 1, y: 1 })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /未运行/)
  await cold.dispose()
  ok('humanInput 未运行时拒绝（不误拉起）')

  const shot = await service.screenshot({})
  assert.equal(shot.ok, true, `screenshot 失败：${shot.error}`)
  assert.ok(shot.size.width > 0 && shot.size.height > 0 && shot.buffer.length > 1000)
  ok(`screenshot 返回 PNG（${shot.size.width}×${shot.size.height}，${shot.buffer.length}B）`)

  const listed = await service.listPages()
  assert.equal(listed.ok, true)
  assert.ok(listed.pages.length >= 1)
  ok(`listPages 列出 ${listed.pages.length} 页`)

  assert.ok(events.includes('navigated'), '应收到 navigated 事件（面板联动源）')
  ok('事件流包含 navigated（面板联动）')
} finally {
  off()
  await service.dispose()
  server.close()
  fs.rmSync(tmpHome, { recursive: true, force: true })
}
console.log(`\n端到端全部通过：${passed} 项`)
