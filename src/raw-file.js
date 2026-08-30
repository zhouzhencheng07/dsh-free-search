// 原始字节端点（/dsh-kit/raw）辅助：content-type 白名单 + Range 请求头解析。
// 白名单按扩展名收口——只放行明确支持的预览类型，避免把任意二进制按
// octet-stream 喂给浏览器（触发下载）；新增预览格式时在此扩表。
//
// 单独成模块：宿主侧 index.js 消费，tests/test-raw-file.mjs 单测。

/** 可原始预览的类型：扩展名 → content-type */
const RAW_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['xls', 'application/vnd.ms-excel'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
])

/** 取小写扩展名：`a.PDF` → pdf；无点/点文件 → '' */
export function rawExtOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 命中白名单返回 content-type，否则 null */
export function rawContentType(name) {
  return RAW_TYPES.get(rawExtOf(name)) ?? null
}

/**
 * 解析 Range 请求头（RFC 7233 单区间）。返回：
 * - {start, end}：含端 0 基字节区间（end 已收敛到 size-1）；
 * - null：请求本身有效但无法满足（start 越界 / 后缀 0 / 空文件），调用方回 416；
 * - undefined：无 Range 头或语法不认（多区间、单位错、乱写），调用方按无
 *   Range 处理回 200 全量——服务端允许忽略 Range，浏览器自会兜底。
 */
export function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return undefined
  if (m[1] === '') {
    // 后缀形式 bytes=-N：最后 N 字节
    const n = Number(m[2])
    if (n === 0 || size === 0) return null
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return null
  if (m[2] !== '') {
    const end = Number(m[2])
    // last-byte-pos < first-byte-pos 语法无效，按未带 Range 处理
    if (end < start) return undefined
    return { start, end: Math.min(end, size - 1) }
  }
  return { start, end: size - 1 }
}
