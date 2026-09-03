// dsh-kit git 联动 · 纯解析函数（零依赖，供 src/index.js 的 git 端点使用，单测见
// tests/test-git.mjs）。所有输入是 git CLI 的直接输出字符串，解析失败一律返回
// 安全默认值而非抛错——端点侧据此回落，不让解析异常打穿 HTTP 层。

/**
 * 解析 `git status --porcelain -b` 的分支头行（以 "## " 开头）。
 *
 * 输入形态（git 实际输出）：
 *   ## main
 *   ## main...origin/main
 *   ## main...origin/main [ahead 1]
 *   ## main...origin/main [ahead 1, behind 2]
 *   ## main...origin/main [gone]
 *   ## HEAD (no branch)               ← 分离头
 *   ## No commits yet on main         ← 无提交的新分支
 *
 * 返回 {branch, upstream, ahead, behind, gone, detached, unborn}；解析不出分支名时
 * branch 为 ''（端点侧当 "无分支" 处理）。
 */
export function parseStatusBranch(line) {
  const out = { branch: '', upstream: null, ahead: 0, behind: 0, gone: false, detached: false, unborn: false }
  if (typeof line !== 'string') return out
  const s = line.replace(/^##\s*/, '')
  if (s === '') return out
  if (s.startsWith('No commits yet on ')) {
    out.branch = s.slice('No commits yet on '.length)
    out.unborn = true
    return out
  }
  if (s.startsWith('HEAD (no branch)')) {
    out.branch = 'HEAD'
    out.detached = true
    return out
  }
  // 末尾的 [ahead N, behind M] / [gone] 可选段
  let core = s
  const bracket = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(s)
  if (bracket) {
    core = bracket[1]
    const opts = bracket[2].split(',').map((x) => x.trim())
    for (const o of opts) {
      if (o === 'gone') out.gone = true
      else {
        const m = /^ahead (\d+)$/.exec(o)
        if (m) out.ahead = Number(m[1])
        else {
          const m2 = /^behind (\d+)$/.exec(o)
          if (m2) out.behind = Number(m2[1])
        }
      }
    }
  }
  const dot = core.indexOf('...')
  if (dot >= 0) {
    out.branch = core.slice(0, dot)
    out.upstream = core.slice(dot + 3)
  } else {
    out.branch = core
  }
  return out
}

/** 图谱行字段分隔符（与 src/index.js 的 git log --pretty=format 约定一致，0x1F） */
export const LOG_FS = String.fromCharCode(31)

/**
 * 解析 `git log --all --graph --pretty=format:...` 输出 → 行数组。
 *
 * 每行 = 图谱 ASCII 前缀 + 可选字段段（首个分隔符之后、按 %H %h %an %ad %s %D
 * 顺序）。纯连线续行（只有图谱前缀、没有提交）无字段段，返回 {g} 单要素行，
 * 前端照画竖线即可；%b 类多行字段在端点侧已约定放末尾，此处不再 join 兜底。
 */
export function parseLogGraph(out) {
  const lines = []
  if (typeof out !== 'string') return lines
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    const i = line.indexOf(LOG_FS)
    if (i < 0) {
      // 纯连线续行没有字段段：补全空字段，保证 JSON 结构一致（前端靠
      // H 是否非空字符串判断可点；缺字段会被 undefined !== '' 误判成提交行）
      lines.push({ g: line, H: '', h: '', an: '', ad: '', s: '', d: '' })
      continue
    }
    const f = line.slice(i + 1).split(LOG_FS)
    lines.push({
      g: line.slice(0, i),
      H: f[0] || '',
      h: f[1] || '',
      an: f[2] || '',
      ad: f[3] || '',
      s: f[4] || '',
      d: f[5] || '',
    })
  }
  return lines
}

/**
 * 解析 `git branch --format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)` 输出
 * → {current, branches:[{name, isHead, upstream, track}]}。分离头时 git 会给一行
 * refname:short="(HEAD detached at <hash>)" 且 HEAD="*"，current 即该行；空库（无
 * 分支）返回空数组。
 */
export function parseBranchList(out) {
  const branches = []
  if (typeof out !== 'string') return { current: null, branches }
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    const f = line.split(LOG_FS)
    if (f.length < 2 || f[0] === '') continue
    branches.push({
      name: f[0],
      isHead: f[1] === '*',
      upstream: f[2] || '',
      track: typeof f[3] === 'string' ? f[3] : '',
    })
  }
  const current = branches.find((b) => b.isHead) ?? null
  return { current, branches }
}

/**
 * 解析 `%(upstream:track)` 的方括号段：'[ahead 1, behind 2]' / '[ahead 1]' /
 * '[gone]' / ''。解析不出数字返回 null（调用方视为无上游信息）。
 */
export function parseTrack(text) {
  if (typeof text !== 'string') return null
  const m = /^\[([^\]]*)\]$/.exec(text.trim())
  if (!m) return null
  const opts = m[1].split(',').map((x) => x.trim())
  const out = { ahead: 0, behind: 0, gone: false }
  let any = false
  for (const o of opts) {
    if (o === '') continue
    any = true
    if (o === 'gone') out.gone = true
    else {
      const a = /^ahead (\d+)$/.exec(o)
      if (a) out.ahead = Number(a[1])
      else {
        const b = /^behind (\d+)$/.exec(o)
        if (b) out.behind = Number(b[1])
      }
    }
  }
  return any ? out : null
}

/**
 * 解析 git log %D（引用装饰）→ 有序装饰列表。
 * 元素：HEAD -> main / main / origin/main / tag: v0.3.0 / HEAD（分离头）。
 * kind: 'head' | 'branch' | 'remote' | 'tag'；'head' 的 pointsTo 为指向的分支名
 * （HEAD 单独出现时为 null = 分离头）。
 */
export function parseDecoration(text) {
  const out = []
  if (typeof text !== 'string' || text === '') return out
  for (const item of text.split(',').map((x) => x.trim())) {
    if (item === '') continue
    if (item === 'HEAD') {
      out.push({ kind: 'head', name: 'HEAD', pointsTo: null })
    } else if (item.startsWith('HEAD -> ')) {
      out.push({ kind: 'head', name: 'HEAD', pointsTo: item.slice(8) })
    } else if (item.startsWith('tag: ')) {
      out.push({ kind: 'tag', name: item.slice(5) })
    } else if (item.startsWith('origin/')) {
      out.push({ kind: 'remote', name: item })
    } else {
      out.push({ kind: 'branch', name: item })
    }
  }
  return out
}
