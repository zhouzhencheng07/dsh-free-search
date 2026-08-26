// 预览文本解码：BOM 优先（UTF-8 / UTF-16 LE / UTF-16 BE），无 BOM 时以
// 头部 NUL 字节判定二进制；文本类扩展名含 NUL 时按 UTF-16（LE/BE 双向
// 评分取优）尝试恢复——Windows 工具/记事本"Unicode"保存的无 BOM UTF-16
// 常见，逐字节 NUL 判定会误报二进制，ini 类配置文件的实测问题即源于此。
//
// 单独成模块：宿主侧 index.js 消费，tests/test-text-decode.mjs 单测。

/** 文本类扩展名集合（含无扩展名的点文件，按完整基名匹配） */
const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'ini', 'cfg', 'conf', 'cnf', 'log', 'json', 'jsonc',
  'toml', 'yml', 'yaml', 'xml', 'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'js',
  'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'java', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'cs', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'sql', 'csv', 'tsv', 'env',
  'properties', 'reg', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'vb', 'vue', 'svelte',
  'astro', 'lock', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'dockerignore',
  'gitmodules', 'npmignore', 'eslintrc', 'prettierrc', 'babelrc', 'jshintrc', 'nvmrc',
  'python-version', 'tool-versions', 'hosts', 'profile', 'bashrc', 'zshrc', 'vimrc', 'service',
  'task', 'default', 'sudoers', 'htpasswd',
])

/** 取文本扩展名：`a.ini` → ini；点文件 `.gitignore` → gitignore；无点 → 全名小写 */
export function textExtOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot > 0) return base.slice(dot + 1).toLowerCase()
  return (base.startsWith('.') ? base.slice(1) : base).toLowerCase()
}

/** 解码 UTF-16BE（Node 无直接解码器，字节交换后按 LE 解） */
function decodeUtf16be(buf) {
  const even = buf.length - (buf.length % 2)
  const out = Buffer.allocUnsafe(even)
  for (let i = 0; i < even; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out.toString('utf16le')
}

/**
 * UTF-16 候选评分：含替换符或控制字符直接否决（-1）；否则返回 ASCII
 * 可打印字符占比（0~1）。任意字节对按 UTF-16 解码大多落在可打印区，
 * 控制字符反而最能暴露乱码，ASCII 占比则用来在 LE/BE 两个方向里挑更
 * 像文本的那个（纯 CJK 文本两个方向都 0 分，拒绝——无 BOM 的纯中文
 * UTF-16 罕见，让位给有 BOM 的标准存法）。
 */
function utf16Score(s) {
  if (s.includes('\uFFFD')) return -1
  const n = Math.min(s.length, 2048)
  if (n === 0) return 0
  let good = 0
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12) return -1
    if (c >= 0x20 && c <= 0x7e) good++
  }
  return good / n
}

/** 从 LE/BE 两种解码里挑更像文本的；都不达标返回 null */
function pickUtf16(le, be) {
  const ls = utf16Score(le)
  const bs = utf16Score(be)
  if (ls > bs) return ls >= 0.5 ? le : null
  return bs >= 0.5 ? be : null
}

/**
 * 把文件字节解码为可预览文本。
 * 返回 { binary, content }：binary=true 时 content=null。
 * 规则：①UTF-8/UTF-16 系 BOM 命中 → 按对应编码解码（含 BOM 剥离）；
 * ②无 BOM 且首 4KB 无 NUL → UTF-8；③无 BOM 含 NUL 但扩展名属文本类 →
 *   尝试 UTF-16LE 恢复，解码结果无替换符且控制字符占比 <5% 才认定文本；
 * ④其余 → 二进制。
 */
export function decodePreviewText(buf, name) {
  if (!Buffer.isBuffer(buf)) return { binary: true, content: null }
  const head = buf.subarray(0, 4096)
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    // UTF-16LE（含 BOM）；`00 00` 尾随的 UTF-32 罕见，不专门处理
    return { binary: false, content: buf.subarray(2).toString('utf16le') }
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { binary: false, content: decodeUtf16be(buf.subarray(2)) }
  }
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { binary: false, content: buf.subarray(3).toString('utf8') }
  }
  if (!head.includes(0)) return { binary: false, content: buf.toString('utf8') }
  // 含 NUL：文本类扩展名做 UTF-16 无 BOM 恢复尝试（LE/BE 双向评分取优）
  if (TEXT_EXTS.has(textExtOf(name))) {
    const best = pickUtf16(buf.toString('utf16le'), decodeUtf16be(buf))
    if (best !== null) return { binary: false, content: best }
  }
  return { binary: true, content: null }
}