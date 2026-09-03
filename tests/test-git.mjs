// git 联动纯解析函数单测（src/git.js）。
// 用法（dsh-kit 根）：node tests\test-git.mjs
import { parseStatusBranch, parseLogGraph, parseBranchList, parseTrack, parseDecoration, LOG_FS } from '../src/git.js'

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

// 2) parseLogGraph
const fs = LOG_FS
const gLine = (g, H, h, an, ad, s, d) => g + fs + H + fs + h + fs + an + fs + ad + fs + s + fs + d
const out = [
  gLine('* ', 'aaa111aaa111aaa111aaa111aaa111aaa111aaa111', 'aaa111a', '张三', '2026-08-24 10:00', 'feat: 图谱', 'HEAD -> main, origin/main, tag: v0.3.0'),
  gLine('* | ', 'bbb222bbb222bbb222bbb222bbb222bbb222bbb222', 'bbb222b', '李四', '2026-08-24 09:00', 'fix: 分支', ''),
  '|/  ', // 纯连线续行：git 只输出图谱前缀、无字段分隔符
  gLine('* ', 'ccc333ccc333ccc333ccc333ccc333ccc333ccc333', 'ccc333c', '张三', '2026-08-24 08:00', '初始提交', 'main'),
].join('\n')
const lines = parseLogGraph(out)
check('图谱行数', lines.length === 4)
check('首行字段切分', lines[0].g === '* ' && lines[0].h === 'aaa111a' && lines[0].an === '张三' && lines[0].ad === '2026-08-24 10:00' && lines[0].s === 'feat: 图谱')
check('装饰保留原文', lines[0].d === 'HEAD -> main, origin/main, tag: v0.3.0')
check('空装饰', lines[1].d === '')
check('纯连线续行字段补全（g 保留、提交字段为空字符串）', lines[2].g === '|/  ' && lines[2].H === '' && lines[2].h === '' && lines[2].an === '' && lines[2].ad === '' && lines[2].s === '' && lines[2].d === '')
check('单分支行', lines[3].s === '初始提交' && lines[3].d === 'main')
check('空输入', parseLogGraph('').length === 0)
check('非字符串输入', parseLogGraph(null).length === 0)
check('CRLF 行尾剥离', parseLogGraph('* a\r\n').length === 1)

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