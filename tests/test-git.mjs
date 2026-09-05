// git 联动纯解析函数单测（src/git.ts）。
// 用法（dsh-kit 根）：node tests\test-git.mjs
import { parseStatusBranch, parseLogRecords, parseBranchList, parseTrack, parseDecoration, LOG_FS, LOG_RS } from '../src/git.ts'

let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? "PASS  " : "FAIL  "}${label}`)
  if (!cond) failed++
}

// 1) parseStatusBranch
let r = parseStatusBranch('## main')
check('无上游：branch=main upstream=null', r.branch === 'main' && r.upstream === null && r.ahead === 0 && r.behind === 0)
r = parseStatusBranch('## main...origin/main')
check('带上游无计数', r.branch === 'main' && r.upstream === 'origin/main' && r.ahead === 0 && r.behind === 0)
r = parseStatusBranch('## main...origin/main [ahead 1]')
check('ahead 1', r.branch === 'main' && r.upstream === 'origin/main' && r.ahead === 1 && r.behind === 0)
r = parseStatusBranch('## main...origin/main [ahead 3, behind 2]')
check('ahead 3 behind 2', r.ahead === 3 && r.behind === 2 && r.gone === false)
r = parseStatusBranch('## fix/中文名...origin/fix/中文名 [ahead 2]')
check('中文分支名 + 计数', r.branch === 'fix/中文名' && r.upstream === 'origin/fix/中文名' && r.ahead === 2)
r = parseStatusBranch('## main...origin/main [gone]')
check('gone：剩余上游标记', r.branch === 'main' && r.upstream === 'origin/main' && r.gone === true)
r = parseStatusBranch('## HEAD (no branch)')
check('分离头', r.branch === 'HEAD' && r.detached === true && r.unborn === false)
r = parseStatusBranch('## No commits yet on main')
check('无提交新分支', r.branch === 'main' && r.unborn === true)
r = parseStatusBranch('## No commits yet on 功能/branch')
check('无提交 + 斜杠名', r.branch === '功能/branch' && r.unborn === true)
r = parseStatusBranch(undefined)
check('非法输入不抛错', r.branch === '')
r = parseStatusBranch('##  ')
check('空分支名', r.branch === '')

// 2) parseLogRecords（结构化提交记录：%x1e 分记录、%x1f 分字段，git 会在记录间补 \n）
const rs = LOG_RS
const fs = LOG_FS
const rec = (H, P, h, an, at, s, d) => H + fs + P + fs + h + fs + an + fs + at + fs + s + fs + d + rs
const out = (
  rec('aaa111aaa111aaa111aaa111aaa111aaa111aaa111', 'bbb222bbb222bbb222bbb222bbb222bbb222bbb222', 'aaa111a', '张三', 1756000000, 'feat: 图谱', 'HEAD -> main, origin/main')
  + '\n' + rec('bbb222bbb222bbb222bbb222bbb222bbb222bbb222', '', 'bbb222b', '李四', 1755990000, 'fix: 分支', '')
  + '\n' + rec('ccc333ccc333ccc333ccc333ccc333ccc333ccc333', 'ddd444 ddd555', 'ccc333c', '王五', 1755980000, 'merge: 合并', 'tag: v0.3.0')
)
const records = parseLogRecords(out)
check('记录条数', records.length === 3)
check('首记录字段切分', records[0].H === 'aaa111aaa111aaa111aaa111aaa111aaa111aaa111' && records[0].h === 'aaa111a' && records[0].an === '张三' && records[0].s === 'feat: 图谱')
check('父哈希数组（含跨记录 \\n 剥离）', records[0].p.length === 1 && records[0].p[0] === 'bbb222bbb222bbb222bbb222bbb222bbb222bbb222')
check('时间戳数值化', records[0].at === 1756000000)
check('空父（根提交）→ 空数组', records[1].p.length === 0)
check('合并提交多父拆分', records[2].p.length === 2 && records[2].p[0] === 'ddd444' && records[2].p[1] === 'ddd555')
check('装饰保留原文', records[2].d === 'tag: v0.3.0')
check('缺字段安全默认', parseLogRecords('x' + fs + rs).length === 1 && parseLogRecords('x' + fs)[0].at === 0)
check('空输入', parseLogRecords('').length === 0)
check('非字符串输入', parseLogRecords(null).length === 0)
check('CRLF 剥离', parseLogRecords('h' + fs + '' + fs + 'h' + fs + 'a' + fs + '1' + fs + 's' + fs + '' + rs + '\r\n').length === 1)

// 3) parseTrack
let tr = parseTrack('[ahead 1, behind 2]')
check('track ahead/behind', tr && tr.ahead === 1 && tr.behind === 2 && tr.gone === false)
tr = parseTrack('[ahead 1]')
check('track 仅 ahead', tr && tr.ahead === 1 && tr.behind === 0)
tr = parseTrack('[gone]')
check('track gone', tr && tr.gone === true && tr.ahead === 0)
tr = parseTrack('')
check('track 空', tr === null)
tr = parseTrack('[behind 9]')
check('track 仅 behind', tr && tr.ahead === 0 && tr.behind === 9)

// 4) parseBranchList
const bLine = (name, head, up, track) => name + fs + head + fs + up + fs + track
const br = parseBranchList([
  bLine('main', '', 'origin/main', '[ahead 1]'),
  bLine('dev', '*', '', ''),
  bLine('fix/中文', '', 'origin/fix/中文', '[gone]'),
].join('\n'))
check('分支列表数量', br.branches.length === 3)
check('当前分支识别', br.current && br.current.name === 'dev' && br.current.isHead === true)
check('上游/跟踪字段', br.branches[0].upstream === 'origin/main' && br.branches[0].track === '[ahead 1]')
check('gone 分支', br.branches[2].track === '[gone]')
const br0 = parseBranchList('')
check('空库无分支', br0.branches.length === 0 && br0.current === null)

// 5) parseDecoration
let dec = parseDecoration('HEAD -> main, origin/main, tag: v0.3.0')
check('装饰顺序与类型', dec.length === 3 && dec[0].kind === 'head' && dec[0].pointsTo === 'main' && dec[1].kind === 'remote' && dec[2].kind === 'tag' && dec[2].name === 'v0.3.0')
dec = parseDecoration('HEAD')
check('分离头 HEAD', dec.length === 1 && dec[0].kind === 'head' && dec[0].pointsTo === null)
dec = parseDecoration('dev, feature/x')
check('普通分支', dec.length === 2 && dec[0].kind === 'branch' && dec[1].name === 'feature/x')
dec = parseDecoration('')
check('空装饰', dec.length === 0)

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exitCode = failed === 0 ? 0 : 1