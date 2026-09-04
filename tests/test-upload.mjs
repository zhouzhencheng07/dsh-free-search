// upload 单测：multipart 解析 / boundary 提取 / 文件名清洗 / 重名序号。
// 用法（dsh-kit 根）：node tests\test-upload.mjs
import { multipartBoundary, parseMultipart, safeUploadName, dedupeName } from '../src/upload.ts'
import path from 'node:path'

let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS  ' : 'FAIL  '}${label}`)
  if (!cond) failed++
}

// ── multipartBoundary ──
check('标准头取 boundary', multipartBoundary('multipart/form-data; boundary=----abc123') === '----abc123')
check('带 charset 的头', multipartBoundary('multipart/form-data; charset=utf-8; boundary="xyz"') === 'xyz')
check('非 multipart → null', multipartBoundary('application/json') === null)
check('缺 boundary → null', multipartBoundary('multipart/form-data') === null)
check('非字符串 → null', multipartBoundary(undefined) === null)

// ── parseMultipart：手工构造标准 body ──
const B = '----webkitFormBoundaryTest'
const buildBody = (parts) => {
  const chunks = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${B}\r\n`))
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${p.name}"\r\n`))
    chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'))
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, 'utf8'))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${B}--\r\n`))
  return Buffer.concat(chunks)
}
const body = buildBody([
  { name: 'a.txt', data: 'hello 世界' },
  { name: 'b.bin', data: Buffer.from([0, 1, 2, 0xff, 0xfe]) },
])
let parts = parseMultipart(body, B)
check('解析出两个 part', parts.length === 2)
check('文本 part 文件名与内容', parts[0]?.filename === 'a.txt' && parts[0]?.data.toString('utf8') === 'hello 世界')
check('二进制 part 字节级一致', parts[1]?.filename === 'b.bin' && Buffer.compare(parts[1]?.data ?? Buffer.alloc(0), Buffer.from([0, 1, 2, 0xff, 0xfe])) === 0)

// filename*（RFC 5987 URL 编码 UTF-8）优先：中文文件名的手机/浏览器形态
const bodyStar = `--${B}\r\nContent-Disposition: form-data; name="file"; filename*=utf-8''%E6%8A%A5%E5%91%8A.xlsx\r\n\r\nDATA\r\n--${B}--\r\n`
parts = parseMultipart(Buffer.from(bodyStar, 'utf8'), B)
check('filename* 解码中文', parts[0]?.filename === '报告.xlsx' && parts[0]?.data.toString() === 'DATA')

// 二进制内容里含边界样文不会误切（样文在内容中部；紧跟 CRLF 的 --boundary 按
// RFC 就是定界符，任何解析器都无法区分——boundary 的选取本就要求不出现在内容里）
const tricky = buildBody([
  { name: 'c.bin', data: Buffer.concat([Buffer.from('PREFIX--' + B + 'X-not-a-delimiter'), Buffer.from([0, 255])]) },
])
parts = parseMultipart(tricky, B)
check(
  '内容含边界样文不误切',
  parts.length === 1 &&
    Buffer.compare(
      parts[0]?.data ?? Buffer.alloc(0),
      Buffer.concat([Buffer.from('PREFIX--' + B + 'X-not-a-delimiter'), Buffer.from([0, 255])]),
    ) === 0,
)

// 容错
check('非 Buffer → 空数组', parseMultipart('str', B).length === 0)
check('空 boundary → 空数组', parseMultipart(body, '').length === 0)
check('无文件字段跳过', (() => {
  const b = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="note"\r\n\r\njust text\r\n--${B}--\r\n`)
  return parseMultipart(b, B).length === 0
})())

// ── safeUploadName ──
check('普通名原样', safeUploadName('报告 最终版.xlsx') === '报告 最终版.xlsx')
check('取 basename', safeUploadName('C:\\Users\\zzc\\a.txt') === 'a.txt' && safeUploadName('/tmp/x/b.png') === 'b.png')
check('去控制字符与非法字符', safeUploadName('a\x00\x1fb:c*d?e"f<g>h|i') === 'abcdefghi')
check('空/点目录 → null', safeUploadName('') === null && safeUploadName('..') === null && safeUploadName('   ') === null)
check('超长保尾部', safeUploadName('x'.repeat(200) + '.txt') === 'x'.repeat(116) + '.txt')

// ── dedupeName ──
const mkExists = (set) => (p) => set.has(p)
check('不存在原样返回', dedupeName('/d', 'a.txt', mkExists(new Set())) === 'a.txt')
check('重名追加序号', dedupeName('/d', 'a.txt', mkExists(new Set([path.join('/d', 'a.txt')]))) === 'a (1).txt')
check(
  '连续占用顺延',
  dedupeName(
    '/d',
    'a.txt',
    mkExists(new Set([path.join('/d', 'a.txt'), path.join('/d', 'a (1).txt'), path.join('/d', 'a (2).txt')])),
  ) === 'a (3).txt',
)
check('无扩展名也适用', dedupeName('/d', 'README', mkExists(new Set([path.join('/d', 'README')]))) === 'README (1)')
check('目录 join 正确（win 反斜杠）', (() => {
  let got = null
  dedupeName('D:\\x', 'a.txt', (p) => {
    got = p
    return false
  })
  return got === path.join('D:\\x', 'a.txt')
})())

if (failed) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
