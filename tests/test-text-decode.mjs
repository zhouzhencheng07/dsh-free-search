// text-decode 单测：BOM 解码 / NUL 二进制判定 / 无 BOM UTF-16LE 恢复。
// 用法（dsh-kit 根）：node tests\test-text-decode.mjs
import { decodePreviewText, textExtOf } from '../src/text-decode.js'

let failed = 0
/** Buffer 辅助：字符串按指定编码转 Buffer，并可选加 BOM */
const enc = (s, codec = 'utf8', bom = null) => {
  const b = Buffer.from(s, codec)
  return bom ? Buffer.concat([bom, b]) : b
}
const LE = Buffer.from([0xff, 0xfe])
const BE = Buffer.from([0xfe, 0xff])
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf])

const check = (label, cond) => {
  console.log(`${cond ? 'PASS  ' : 'FAIL  '}${label}`)
  if (!cond) failed++
}

// 1) 常规 UTF-8（ASCII / 中文）
let r = decodePreviewText(enc('[server]\r\nport = 8000'), 'config.ini')
check('ascii ini 按文本解码', r.binary === false && r.content.startsWith('[server]'))
r = decodePreviewText(enc('你好，插件'), 'a.txt')
check('utf8 中文按文本解码', r.binary === false && r.content === '你好，插件')

// 2) UTF-8 BOM 剥离
r = decodePreviewText(enc('[x]', 'utf8', BOM8), 'a.ini')
check('utf8 BOM 剥离', r.binary === false && r.content === '[x]')

// 3) UTF-16LE/BE 带 BOM → 正常解码且不含 BOM
const iniLe = Buffer.from('[server]\r\nport = 8000', 'utf16le')
r = decodePreviewText(Buffer.concat([LE, iniLe]), 'config.ini')
check('utf16le BOM 解码', r.binary === false && r.content === '[server]\r\nport = 8000')
const iniBe = Buffer.from([0, 0x5b, 0, 0x73, 0, 0x65, 0, 0x72, 0, 0x76, 0, 0x65, 0, 0x72, 0, 0x5d]) // "[server]" BE
r = decodePreviewText(Buffer.concat([BE, iniBe]), 'config.ini')
check('utf16be BOM 解码', r.binary === false && r.content === '[server]')
// 奇数长度 UTF-16BE 不抛错
r = decodePreviewText(Buffer.concat([BE, iniBe, Buffer.from([0x00])]), 'config.ini')
check('utf16be 奇数尾字节不抛错', r.binary === false && r.content === '[server]')

// 4) 无 BOM 含 NUL：
//    a. 非文本扩展名 → 二进制
r = decodePreviewText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 'a.png')
check('png 含 NUL 判二进制', r.binary === true && r.content === null)
//    b. 文本扩展名但含 NUL 且内容不像 UTF-16 → 仍二进制（ASCII 评分不达标）
r = decodePreviewText(Buffer.from(Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0x05 : 0x00))), 'a.ini')
check('ini 乱字节仍判二进制', r.binary === true)
r = decodePreviewText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x00, 0x01, 0x02]), 'a.txt')
check('txt 乱字节仍判二进制', r.binary === true)
//    c. 无 BOM UTF-16LE（Windows 记事本"Unicode"保存）→ 恢复为文本
const noBomLe = Buffer.from('port = 8000\r\n', 'utf16le')
r = decodePreviewText(noBomLe, 'config.ini')
check('ini 无 BOM UTF-16LE 恢复为文本', r.binary === false && r.content === 'port = 8000\r\n')
//    d. 无 BOM UTF-16LE 但扩展名不在文本集 → 二进制（不做无谓恢复）
r = decodePreviewText(noBomLe, 'a.dat')
check('dat 无 BOM UTF-16LE 保持二进制', r.binary === true)
//    e. 无 BOM UTF-16BE（对称恢复，评分挑 ASCII 更像的 BE 方向）
const noBomBe = Buffer.from([0, 0x70, 0, 0x6f, 0, 0x72, 0, 0x74]) // "port" BE
r = decodePreviewText(noBomBe, 'config.ini')
check('ini 无 BOM UTF-16BE 也恢复为文本', r.binary === false && r.content === 'port')

// 5) 点文件扩展名匹配
check('textExtOf config.ini → ini', textExtOf('config.ini') === 'ini')
check('textExtOf .gitignore → gitignore', textExtOf('.gitignore') === 'gitignore')
check('textExtOf 无扩展名 → 全文', textExtOf('README') === 'readme')
r = decodePreviewText(noBomLe, '.gitignore')
check('点文件无 BOM UTF-16LE 恢复', r.binary === false && r.content === 'port = 8000\r\n')

// 6) 强制二进制扩展名：纯 ASCII 的极简 PDF 无 NUL，按常规流程会误判成文本
r = decodePreviewText(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'), 'a.pdf')
check('pdf 纯 ASCII 也强制二进制', r.binary === true && r.content === null)

process.exit(failed === 0 ? 0 : 1)