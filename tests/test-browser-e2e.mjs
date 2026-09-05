// dsh-kit 浏览器服务端到端测试：合成 todo 页上跑完整 agent 循环
// navigate → snapshot → type/click → 断言快照 → check → 负路径 → screenshot →
// ref 回填/hover/scroll/upload/dialog 可见性/viewport → 双指针（agent 活动页/
// 观察页）切换隔离 → history → dispose
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
<div id="hov" style="padding:10px;border:1px solid #ccc" onmouseover="document.getElementById('status').textContent='hovered'">悬停区</div>
<input type="file" id="f" aria-label="附件" onchange="document.getElementById('status').textContent='picked:'+(this.files.length)">
<button id="del" onclick="if(confirm('确认删除？')){document.getElementById('status').textContent='已删除'}else{document.getElementById('status').textContent='已取消'}">删除</button>
<div style="height:2000px"></div>
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

  // 人机共驾：坐标点击（输入派发与 agent 工具落在同一页面）。注意 evaluate 的
  // 返回值已是 JSON 字符串——表达式里再包一层 JSON.stringify 会双重序列化，
  // rect 字段全变 undefined、坐标 NaN 点到 (0,0)，断言会被输入框旧文本 vacuous
  // 满足（本用例曾假通过）。断言用「提交后状态行」这种点击后才可能出现的字样。
  const typed2 = await service.act({ action: 'type', role: 'textbox', name: '新待办', value: '人机共驾' })
  assert.equal(typed2.ok, true)
  const rectJson = await service.evaluate(`document.querySelector('#add').getBoundingClientRect()`)
  assert.equal(rectJson.ok, true)
  const rect = JSON.parse(rectJson.value)
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)
  assert.ok(Number.isFinite(cx) && cx > 0, `坐标非法：${cx},${cy}`)
  const moved = await service.humanInput({ kind: 'mousemove', x: cx, y: cy })
  assert.equal(moved.ok, true)
  await service.humanInput({ kind: 'mousedown', x: cx, y: cy, button: 0, clicks: 1 })
  await service.humanInput({ kind: 'mouseup', x: cx, y: cy, button: 0, clicks: 1 })
  await new Promise((r) => setTimeout(r, 300))
  const afterInput = await service.snapshot()
  // 此时已由 act 提交过 买牛奶（共 1 项），本次坐标点击提交 人机共驾 → 共 2 项
  assert.match(afterInput.snapshot, /共 2 项/, `提交后状态行未出现（点击未生效）：\n${afterInput.snapshot}`)
  ok('humanInput 坐标点击与工具层同页生效')

  // 键盘键入路径：点击聚焦远程输入框后，humanInput key 组合逐键入文
  const addRectJson = await service.evaluate(`document.querySelector('#inp').getBoundingClientRect()`)
  assert.equal(addRectJson.ok, true)
  const addRect = JSON.parse(addRectJson.value)
  const ix = Math.round(addRect.x + addRect.width / 2)
  const iy = Math.round(addRect.y + addRect.height / 2)
  assert.ok(Number.isFinite(ix) && ix > 0, `坐标非法：${ix},${iy}`)
  await service.humanInput({ kind: 'mousedown', x: ix, y: iy, button: 0, clicks: 1 })
  await service.humanInput({ kind: 'mouseup', x: ix, y: iy, button: 0, clicks: 1 })
  await new Promise((r) => setTimeout(r, 200))
  const focusedInp = await service.evaluate(`document.activeElement && document.activeElement.id`)
  assert.equal(focusedInp.value, '"inp"', `点击后焦点应在输入框：${focusedInp.value}`)
  for (const ch of 'kb') await service.humanInput({ kind: 'key', combo: ch })
  // 文本块路径（IME 组合提交的宿主形态）：一次性插入中文
  await service.humanInput({ kind: 'text', text: '键盘输入' })
  await new Promise((r) => setTimeout(r, 300))
  const afterKeys = await service.evaluate(`document.querySelector('#inp').value`)
  assert.equal(JSON.parse(afterKeys.value), 'kb键盘输入', `键入值不符：${afterKeys.value}`)
  ok('humanInput key 组合逐键入文 + text 块插入（IME 形态）')

  // 未运行时不误拉起：新建服务实例（未 launch）输入应被拒绝
  const cold = new BrowserService({ log: () => {} })
  const rejected = await cold.humanInput({ kind: 'mousemove', x: 1, y: 1 })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /未运行/)
  const coldState = await cold.state()
  assert.equal(coldState.running, false)
  assert.equal(coldState.launching, false, '未启动且未在启动中时 launching=false')
  await cold.dispose()
  ok('humanInput 未运行时拒绝（不误拉起）+ state 带 launching 字段')

  // ── 双指针（agent 活动页 / 面板观察页）与页签条操作 ──
  const st0 = await service.state()
  assert.equal(st0.running, true)
  assert.ok(typeof st0.viewId === 'number' && st0.viewId !== null, 'state 应带 viewId')
  assert.ok(st0.pages.every((p) => typeof p.viewed === 'boolean'), 'pages 应带 viewed 标记')
  ok('state 带 viewId/viewed 字段')

  const t1 = (await service.listPages()).pages[0].tabId
  const navTab = await service.navigate(`${base}?tab=2`, { newTab: true, snapshot: false })
  assert.equal(navTab.ok, true, `开新页签失败：${navTab.error}`)
  const st1 = await service.state()
  assert.equal(st1.activeId, navTab.tabId, '新页签成为 agent 活动页')
  assert.equal(st1.viewId, navTab.tabId, 'follow 开启时观察页跟随新页签')
  ok('agent 开新页签：活动页+观察页到位')

  // 人切观察页 → 只动观察指针，agent 活动页不动
  await service.activatePage(t1)
  const st2 = await service.state()
  assert.equal(st2.viewId, t1, '观察页切回第一页')
  assert.equal(st2.activeId, navTab.tabId, 'agent 活动页不受人切换影响')
  ok('activatePage 只切观察页（agent 隔离）')

  // 面板 URL 栏 / 历史按钮作用于观察页
  const open2 = await service.humanOpen(`${base}?from=panel`)
  assert.equal(open2.ok, true)
  assert.equal(open2.tabId, t1, 'humanOpen 作用于观察页')
  const back = await service.history('back')
  assert.equal(back.ok, true)
  assert.ok(!back.url.includes('from=panel'), 'back 回到上一地址')
  const fwd = await service.history('forward')
  assert.equal(fwd.ok, true)
  assert.ok(fwd.url.includes('from=panel'), 'forward 回到面板导航地址')
  const reload = await service.history('reload')
  assert.equal(reload.ok, true)
  ok('history back/forward/reload 作用于观察页')
  const st3 = await service.state()
  assert.equal(st3.activeId, navTab.tabId, '历史操作不动 agent 活动页')
  ok('history back/forward/reload 作用于观察页（不动 agent 活动页）')

  const shot = await service.screenshot({})
  assert.equal(shot.ok, true, `screenshot 失败：${shot.error}`)
  assert.ok(shot.size.width > 0 && shot.size.height > 0 && shot.buffer.length > 1000)
  ok(`screenshot 返回 PNG（${shot.size.width}×${shot.size.height}，${shot.buffer.length}B）`)

  const listed = await service.listPages()
  assert.equal(listed.ok, true)
  assert.ok(listed.pages.length >= 1)
  ok(`listPages 列出 ${listed.pages.length} 页`)

  // ── act 升级面：ref 回填 / hover / scroll / upload / dialog 可见性 / viewport ──
  const snapForRef = await service.snapshot()
  assert.equal(snapForRef.ok, true)
  const refLine = snapForRef.snapshot.split('\n').find((l) => l.includes('添加'))
  const refMatch = refLine && refLine.match(/\[ref=(e\d+)\]/)
  assert.ok(refMatch, `快照应含 [ref=eN]：${refLine}`)
  const refClick = await service.act({ action: 'click', ref: refMatch[1] })
  assert.equal(refClick.ok, true, `ref 点击失败：${refClick.error}`)
  assert.match(refClick.snapshot, /内容不能为空/)
  ok(`act ref 回填点击（${refMatch[1]}）一次到位`)

  const hov = await service.act({ action: 'hover', text: '悬停区' })
  assert.equal(hov.ok, true, `hover 失败：${hov.error}`)
  const hovStatus = await service.evaluate(`document.getElementById('status').textContent`)
  assert.equal(JSON.parse(hovStatus.value), 'hovered')
  ok('act hover 触发悬停副作用')

  const scDown = await service.act({ action: 'scroll', dy: 800 })
  assert.equal(scDown.ok, true, `scroll 失败：${scDown.error}`)
  // mouse.wheel 不等待滚动落定（Chromium 逐帧应用），读取前留出落定时间
  await new Promise((r) => setTimeout(r, 300))
  const sy1 = JSON.parse((await service.evaluate(`window.scrollY`)).value)
  assert.ok(sy1 > 0, `scroll 后 scrollY 应 >0：${sy1}`)
  const scUp = await service.act({ action: 'scroll', dy: -2000 })
  assert.equal(scUp.ok, true)
  await new Promise((r) => setTimeout(r, 300))
  const sy2 = JSON.parse((await service.evaluate(`window.scrollY`)).value)
  assert.equal(sy2, 0, `scroll 回顶失败：${sy2}`)
  const scView = await service.act({ action: 'scroll', text: '悬停区' })
  assert.equal(scView.ok, true, `scrollIntoView 失败：${scView.error}`)
  ok('act scroll 真实滚轮下滚/回滚/定位滚到元素')
  const scBad = await service.act({ action: 'scroll' })
  assert.equal(scBad.ok, false)
  assert.match(scBad.error, /dx\/dy/)
  ok('scroll 无定位无增量给出可恢复错误')

  const upFile = path.join(tmpHome, 'upload-me.txt')
  fs.writeFileSync(upFile, 'upload-payload')
  const up = await service.act({ action: 'upload', selector: '#f', value: upFile })
  assert.equal(up.ok, true, `upload 失败：${up.error}`)
  const fCount = JSON.parse((await service.evaluate(`document.getElementById('f').files.length`)).value)
  assert.equal(fCount, 1, `文件未进入 input：${fCount}`)
  ok('act upload setInputFiles 落进文件选择框')

  const dlg = await service.act({ action: 'click', role: 'button', name: '删除' })
  assert.equal(dlg.ok, true, `dialog 路径点击失败（页面若冻结=未 dismiss）：${dlg.error}`)
  assert.ok(dlg.warning && /confirm/.test(dlg.warning) && /确认删除/.test(dlg.warning), `应带回对话框 warning：${dlg.warning}`)
  const dlgStatus = JSON.parse((await service.evaluate(`document.getElementById('status').textContent`)).value)
  assert.equal(dlgStatus, '已取消')
  ok('act 触发 confirm：自动关闭且弹出事实带回 warning')

  const vp = await service.setViewport({ width: 375, height: 812 })
  assert.equal(vp.ok, true, `viewport 失败：${vp.error}`)
  assert.deepEqual(vp.viewport, { width: 375, height: 812 })
  const iw = JSON.parse((await service.evaluate(`window.innerWidth`)).value)
  assert.equal(iw, 375, `innerWidth 应为 375：${iw}`)
  const vpBad = await service.setViewport({ width: 100, height: 100 })
  assert.equal(vpBad.ok, false)
  assert.match(vpBad.error, /320/)
  ok('viewport 设置生效 + 越界拒绝')

  // ── 关掉最后一页 = 整个浏览器优雅关闭；下次导航必须能重新拉起。回归：
  // _launching 落定后若不清，context 事后关闭会让 ensure 误报 ok，
  // 调用方拿 null context 去 newPage 崩掉（正式环境 0.4.3 踩中过）──
  const remaining = (await service.listPages()).pages
  assert.ok(remaining.length >= 1)
  for (const p of remaining) await service.closePage(p.tabId)
  await new Promise((r) => setTimeout(r, 500))
  const closedState = await service.state()
  assert.equal(closedState.running, false, '关掉最后一页后浏览器应已收摊')
  assert.ok(events.includes('closed'), '应广播 closed 事件（面板收标签联动源）')
  const renavigated = await service.navigate(`${base}?relaunch`, { snapshot: false })
  assert.equal(renavigated.ok, true, `收摊后重新导航失败：${renavigated.error}`)
  const restate = await service.state()
  assert.equal(restate.running, true, '重新导航后浏览器应已重新拉起')
  ok('close-on-last 收摊 → 再次导航重新拉起（_launching 落定即清）')

  assert.ok(events.includes('navigated'), '应收到 navigated 事件（面板联动源）')
  ok('事件流包含 navigated（面板联动）')
} finally {
  off()
  await service.dispose()
  server.close()
  fs.rmSync(tmpHome, { recursive: true, force: true })
}
console.log(`\n端到端全部通过：${passed} 项`)
