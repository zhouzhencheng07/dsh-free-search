// dsh-kit 技能池宿主半边（M1.1）
//
// 设计稿：docs/dsh-kit-next-features.md §1。技能池 $DSH_HOME/skill-pool 不挂任何
// 扫描根（DSH 不会把它当技能源），只作为工作区之间流通的仓库货架；本模块提供
// 管理面端点，浏览器半边在 settings.section 渲染"技能管理"页。
//
// 端点（同源校验同 index.js；webserver 默认只绑 loopback）：
//   GET  /dsh-kit/skills?cwd=<会话cwd>
//       按三个逻辑组返回：workspace（.dsh/.agents 两根聚合）、user（$DSH_HOME 与
//       ~/.agents 两根聚合）、pool。每个技能带 root（物理根）、rank（DSH 扫描
//       优先级，越小越优先）、shadowed（同名跨根时非最优者）。另附注册表中非
//       白名单来源的技能（插件自带/运行时/custom 目录——只读展示）。
//   POST /dsh-kit/skills/op   body 为 JSON：
//       {op:'copy',  src, dest, overwrite?}   复制到目标根（dest=物理根 id）
//       {op:'move',  src, dest, overwrite?}   复制校验后移除源（数据先落目标再撤源）
//       {op:'delete', src}                    直接永久删除（客户端两步确认兜底）
//       {op:'disable', src, disabled}         改 SKILL.md frontmatter 双键：
//                                             disable-model-invocation:true +
//                                             user-invocable:false（chokidar 热生效）；
//                                             disabled=false 即删掉这两个键恢复。
//       同名冲突回 409 {error:'conflict'}，客户端确认后带 overwrite:true 重发。
//
// 安全边界：
//   - 可写范围白名单：池目录、项目级两根（自 cwd 推导）、用户级两根；之外一律拒绝。
//   - 源必须是某根的**直接子项**（官方发现规则就是一层：dir/SKILL.md 或根下 *.md）。
//   - 全路径 realpath 后再做包含性校验，符号链接逃逸出白名单即拒。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const POOL_DIRNAME = 'skill-pool'

/**
 * 物理根定义：group = 所属逻辑分组；rank = DSH 扫描优先级（数值越小越优先，
 * 对齐 dsh-skill-filesystem 的 roots() 常量；pool 不是扫描根，不参与排序）。
 */
const PHYSICAL_ROOTS = [
  { id: 'project-dsh', group: 'workspace', rank: 100 },
  { id: 'project-agents', group: 'workspace', rank: 200 },
  { id: 'user-dsh', group: 'user', rank: 400 },
  { id: 'user-agents', group: 'user', rank: 500 },
  { id: 'pool', group: 'pool', rank: null },
]

/** 逻辑分组展示顺序：工作区 → 用户级 → 技能池 */
const GROUP_ORDER = ['workspace', 'user', 'pool']

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env.trim() : path.join(os.homedir(), '.dsh')
}

/** 自 start 向上找 .git（目录或文件都算），找不到退回 start 本身（对齐 skill-filesystem 语义） */
function findProjectRoot(start) {
  let current = start
  for (;;) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current
    } catch {
      // 无权限探测就当没有，继续向上
    }
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** 解析全部白名单物理根（带逻辑分组与 rank）；cwd 缺省则无项目组 */
export function resolveRoots(cwd) {
  const home = dshHome()
  const dirById = {
    pool: path.join(home, POOL_DIRNAME),
    'user-dsh': path.join(home, 'skills'),
    'user-agents': path.join(os.homedir(), '.agents', 'skills'),
  }
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    try {
      const projectRoot = findProjectRoot(fs.realpathSync(path.resolve(cwd.trim())))
      dirById['project-agents'] = path.join(projectRoot, '.agents', 'skills')
      dirById['project-dsh'] = path.join(projectRoot, '.dsh', 'skills')
    } catch {
      // cwd 非法就没有项目组
    }
  }
  return PHYSICAL_ROOTS.filter((def) => dirById[def.id] !== undefined).map((def) => ({ ...def, dir: dirById[def.id] }))
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 宽容解析 frontmatter：返回 { data, blockStart, blockEnd }。
 * data 仅取行级 `key: value`（值去掉成对引号）；block* 是首块的字节区间（含围栏行），
 * 无 frontmatter 时三个字段为 null。不追求 YAML 完备——技能 frontmatter 本就要求
 * 平铺的 name/description/布尔开关，行级足够。
 */
function parseFrontmatter(text) {
  const head = text.slice(0, 4096)
  if (!/^---[ \t]*\r?\n/.test(head)) return { data: {}, blockStart: -1, blockEnd: -1 }
  const close = head.slice(3).match(/^---[ \t]*(?:\r?\n|$)/m)
  if (!close) return { data: {}, blockStart: -1, blockEnd: -1 }
  const fenceLen = close[0].length
  const innerEnd = 3 + close.index
  const blockEnd = innerEnd + fenceLen
  const data = {}
  for (const rawLine of head.slice(3, innerEnd).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(rawLine)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    }
    data[m[1].toLowerCase()] = value
  }
  return { data, blockStart: 0, blockEnd }
}

function boolFlag(value) {
  if (value === undefined) return null
  const v = String(value).trim().toLowerCase()
  return v !== '' && v !== 'false' && v !== 'no' && v !== '0'
}

/**
 * 行级改写 frontmatter 的两个弃用键（不重写其余内容，零 YAML 依赖）：
 * disabled=true → 两键置为 true/false（已有则原位改值，缺失则补在块尾）；
 * disabled=false → 删除这两行。无 frontmatter 且要禁用时新建一个最小块。
 */
function setDisableFlags(text, disabled) {
  const lines = text.split(/\r?\n/)
  // 定位首块（第 0 行必须是 --- 围栏）
  if (lines[0] !== undefined && /^---[ \t]*$/.test(lines[0])) {
    let closeIdx = -1
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
      if (/^---[ \t]*$/.test(lines[i])) {
        closeIdx = i
        break
      }
    }
    if (closeIdx > 0) {
      const keepRe = /^[A-Za-z][A-Za-z0-9_-]*[ \t]*:/
      const dropRe = /^(disable-model-invocation|user-invocable)[ \t]*:/
      if (!disabled) {
        const filtered = lines.filter((line, i) => !(i > 0 && i < closeIdx && dropRe.test(line)))
        return filtered.join('\n')
      }
      const wanted = { 'disable-model-invocation': 'true', 'user-invocable': 'false' }
      const inner = lines.slice(1, closeIdx)
      for (const key of Object.keys(wanted)) {
        const idx = inner.findIndex((line) => {
          const m = keepRe.exec(line)
          return m && m[0].slice(0, -1).trim().toLowerCase() === key
        })
        if (idx >= 0) inner[idx] = `${key}: ${wanted[key]}`
        else inner.push(`${key}: ${wanted[key]}`)
      }
      return [...lines.slice(0, 1), ...inner, ...lines.slice(closeIdx)].join('\n')
    }
  }
  // 没有 frontmatter：禁用则补最小块，启用则原样返回
  if (!disabled) return text
  return `---\ndisable-model-invocation: true\nuser-invocable: false\n---\n${text}`
}

/** 扫单个根：一层条目，目录须含 SKILL.md，平铺 .md 也算技能 */
function scanRoot(root) {
  const skills = []
  let dirents
  try {
    dirents = fs.readdirSync(root.dir, { withFileTypes: true })
  } catch {
    return skills
  }
  for (const ent of dirents) {
    if (ent.name.startsWith('.')) continue
    const entryPath = path.join(root.dir, ent.name)
    let skillFile = null
    let kind = null
    if (ent.isDirectory()) {
      const candidate = path.join(entryPath, 'SKILL.md')
      if (fs.existsSync(candidate)) {
        kind = 'dir'
        skillFile = candidate
      }
    } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
      kind = 'file'
      skillFile = entryPath
    }
    if (!kind) continue
    let text = ''
    try {
      text = fs.readFileSync(skillFile, 'utf8')
    } catch {
      // 读不了就保留占位信息
    }
    const fm = parseFrontmatter(text)
    const disableModel = boolFlag(fm.data['disable-model-invocation'])
    const userInvocableRaw = fm.data['user-invocable']
    const modelInvocable = disableModel === null ? true : !disableModel
    const userInvocable = userInvocableRaw === undefined ? true : boolFlag(userInvocableRaw) === true
    skills.push({
      name: typeof fm.data.name === 'string' && fm.data.name !== '' ? fm.data.name : ent.name.replace(/\.md$/i, ''),
      description: typeof fm.data.description === 'string' ? fm.data.description : '',
      path: entryPath,
      file: skillFile,
      kind,
      disabled: modelInvocable === false || userInvocable === false,
      modelInvocable,
      userInvocable,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return skills
}

/** 路径必须真实存在且落在某个白名单根内；返回 {root, real} 或 null */
function locateInside(roots, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null
  let target
  try {
    target = fs.realpathSync(path.resolve(rawPath.trim()))
  } catch {
    return null
  }
  for (const root of roots) {
    let realRoot
    try {
      realRoot = fs.realpathSync(root.dir)
    } catch {
      continue
    }
    const rel = path.relative(realRoot, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    return { root: { ...root, real: realRoot }, real: target }
  }
  return null
}

/** 源必须是根的直接子项（官方技能发现只有一层） */
function directChildOnly(located) {
  return path.dirname(located.real) === located.root.real
}

function jsonOf(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        rejectPromise(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        rejectPromise(new Error('invalid json'))
      }
    })
    req.on('error', rejectPromise)
  })
}

/** cpSync + 目标完整性校验后移除源（移动语义的数据安全：目标验证过才动源） */
function moveTo(srcReal, dstPath, srcKind) {
  fs.cpSync(srcReal, dstPath, { recursive: true })
  const marker = srcKind === 'dir' ? path.join(dstPath, 'SKILL.md') : dstPath
  if (!fs.existsSync(marker)) throw new Error('移动后校验失败：目标缺少技能入口文件')
  fs.rmSync(srcReal, { recursive: true, force: true })
}

/**
 * 注册技能池端点。registryApi 由外部注入回调捕获（ctx.skills 服务可能晚于本模块就绪）。
 */
export function applySkillPool(ctx, hooks) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const origins = (req) => {
        const origin = req.headers.origin
        const host = req.headers.host
        if (typeof origin !== 'string' || origin === '') return true
        if (typeof host !== 'string') return false
        try {
          return new URL(origin).host === host
        } catch {
          return false
        }
      }

      // ── GET 枚举 ──
      const disposeList = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/skills',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            jsonOf(res, 405, { error: 'method not allowed' })
            return
          }
          if (!origins(req)) {
            jsonOf(res, 403, { error: 'cross-origin denied' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh-kit.local')
          const cwd = url.searchParams.get('cwd') ?? ''
          const roots = resolveRoots(cwd)
          const scannedDirs = []
          const buckets = new Map(GROUP_ORDER.map((id) => [id, []]))
          for (const root of roots) {
            const exists = isDir(root.dir)
            const skills = exists ? scanRoot(root) : []
            for (const skill of skills) {
              skill.root = root.id
              skill.rank = root.rank
            }
            buckets.get(root.group).push({ id: root.id, dir: root.dir, exists, skills })
            if (exists) scannedDirs.push(root.dir)
          }
          // 三逻辑组：物理根聚合；同名跨根按 rank（小者优先）标注被覆盖
          const groups = GROUP_ORDER.map((id) => {
            const rootsOf = buckets.get(id)
            return { id, roots: rootsOf, skills: rootsOf.flatMap((r) => r.skills) }
          })
          const winner = new Map()
          for (const group of groups) {
            for (const skill of group.skills) {
              if (typeof skill.rank !== 'number') continue
              const cur = winner.get(skill.name)
              if (cur === undefined || skill.rank < cur) winner.set(skill.name, skill.rank)
            }
          }
          for (const group of groups) {
            for (const skill of group.skills) {
              skill.shadowed = typeof skill.rank === 'number' && winner.get(skill.name) < skill.rank
            }
          }
          // 注册表增强：插件自带 / 运行时 / custom 等不在白名单根里的技能，只读展示。
          const providers = []
          const registry = hooks && typeof hooks.getRegistry === 'function' ? hooks.getRegistry() : null
          if (registry && typeof registry.list === 'function') {
            try {
              const summaries = registry.list(typeof cwd === 'string' && cwd.trim() !== '' ? { cwd: cwd.trim() } : {})
              for (const summary of Array.isArray(summaries) ? summaries : []) {
                if (!summary || typeof summary.name !== 'string') continue
                const base = summary.resourceBase && typeof summary.resourceBase.path === 'string' ? summary.resourceBase.path : ''
                const covered = base !== '' && scannedDirs.some((dir) => {
                  const rel = path.relative(dir, base)
                  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
                })
                if (covered) continue
                providers.push({
                  name: summary.name,
                  description: typeof summary.description === 'string' ? summary.description : '',
                  provider: typeof summary.provider === 'string' ? summary.provider : '',
                  source: typeof summary.source === 'string' ? summary.source : '',
                  invocation: summary.invocation ?? null,
                })
              }
            } catch (error) {
              // 注册表不可用就不给这一段，枚举本身不受影响
              console.warn('[dsh-kit] skills registry list failed:', error?.message ?? error)
            }
          }
          jsonOf(res, 200, { cwd, groups, providers })
        },
      })

      // ── POST 操作 ──
      const disposeOp = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-kit/skills/op',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            jsonOf(res, 405, { error: 'method not allowed' })
            return
          }
          if (!origins(req)) {
            jsonOf(res, 403, { error: 'cross-origin denied' })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch (error) {
            jsonOf(res, 400, { error: `请求体非法：${error?.message ?? error}` })
            return
          }
          const cwd = typeof body.cwd === 'string' ? body.cwd : ''
          const roots = resolveRoots(cwd)

          try {
            if (body.op === 'copy' || body.op === 'move') {
              const located = locateInside(roots, body.src)
              if (!located || !directChildOnly(located)) {
                jsonOf(res, 400, { error: '源不是白名单根下的技能条目' })
                return
              }
              const destRoot = roots.find((r) => r.id === body.dest)
              if (!destRoot) {
                jsonOf(res, 400, { error: '未知目标根' })
                return
              }
              let destReal
              try {
                // 目标根不存在则按需创建（池/工作区/用户级首次使用即落盘）
                fs.mkdirSync(destRoot.dir, { recursive: true })
                destReal = fs.realpathSync(destRoot.dir)
              } catch {
                jsonOf(res, 400, { error: '目标根不可用' })
                return
              }
              if (destReal === located.root.real) {
                jsonOf(res, 400, { error: '目标与源在同一根' })
                return
              }
              const name = path.basename(located.real)
              const dst = path.join(destReal, name)
              if (fs.existsSync(dst) && body.overwrite !== true) {
                jsonOf(res, 409, { error: 'conflict', message: `目标已存在同名技能：${name}`, target: dst })
                return
              }
              if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true })
              fs.cpSync(located.real, dst, { recursive: true })
              if (body.op === 'move') {
                // 移动语义的数据安全：确认目标入口文件真实存在后才撤源
                const marker = isDir(located.real) ? path.join(dst, 'SKILL.md') : dst
                if (!fs.existsSync(marker)) throw new Error('移动后校验失败：目标缺少技能入口文件')
                fs.rmSync(located.real, { recursive: true, force: true })
              }
              jsonOf(res, 200, { ok: true, op: body.op, dest: path.join(destReal, name) })
              return
            }

            if (body.op === 'delete') {
              const located = locateInside(roots, body.src)
              if (!located || !directChildOnly(located)) {
                jsonOf(res, 400, { error: '源不是白名单根下的技能条目' })
                return
              }
              // 直接永久删除（客户端两步确认兜底误触）
              fs.rmSync(located.real, { recursive: true, force: true })
              jsonOf(res, 200, { ok: true, op: 'delete' })
              return
            }

            if (body.op === 'disable') {
              const located = locateInside(roots, body.src)
              if (!located || !directChildOnly(located)) {
                jsonOf(res, 400, { error: '源不是白名单根下的技能条目' })
                return
              }
              const isSkillDir = isDir(located.real) && fs.existsSync(path.join(located.real, 'SKILL.md'))
              const isFlatMd = located.real.toLowerCase().endsWith('.md') && fs.statSync(located.real).isFile()
              if (!isSkillDir && !isFlatMd) {
                jsonOf(res, 400, { error: '该路径不是技能（目录需含 SKILL.md，或为根下 .md 文件）' })
                return
              }
              const file = isSkillDir ? path.join(located.real, 'SKILL.md') : located.real
              const before = fs.readFileSync(file, 'utf8')
              const after = setDisableFlags(before, body.disabled === true)
              if (after !== before) fs.writeFileSync(file, after, 'utf8')
              const fm = parseFrontmatter(after)
              const disableModel = boolFlag(fm.data['disable-model-invocation'])
              const userInvocable = fm.data['user-invocable'] === undefined ? true : boolFlag(fm.data['user-invocable']) === true
              jsonOf(res, 200, {
                ok: true,
                op: 'disable',
                file,
                disabled: disableModel === false || userInvocable === false,
              })
              return
            }

            jsonOf(res, 400, { error: '未知操作' })
          } catch (error) {
            jsonOf(res, 500, { error: `操作失败：${error?.message ?? error}` })
          }
        },
      })

      return () => {
        disposeList()
        disposeOp()
      }
    }, 'dsh-kit: skill pool endpoints')
  })
}
