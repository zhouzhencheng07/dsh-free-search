// raw-file 单测：content-type 白名单 / Range 头解析（含 416 与忽略语义）。
// 用法（dsh-kit 根）：node tests\test-raw-file.mjs
import { rawExtOf, rawContentType, parseRangeHeader } from '../src/raw-file.js'

let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS  ' : 'FAIL  '}${label}`)
  if (!cond) failed++
}

// ── rawExtOf / rawContentType ──
check('小写扩展名命中 pdf', rawContentType('a.pdf') === 'application/pdf')
check('大写扩展名命中', rawContentType('报告.PDF') === 'application/pdf')
check('Windows 反斜杠路径取基名', rawContentType('D:\\x\\a.pdf') === 'application/pdf')
check('xlsx 命中 OOXML 表格类型', rawContentType('a.xlsx') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
check('xlsm 命中宏表类型', rawContentType('a.xlsm') === 'application/vnd.ms-excel.sheet.macroEnabled.12')
check('xls 命中 legacy 类型', rawContentType('a.xls') === 'application/vnd.ms-excel')
check('docx 命中 OOXML 文档类型', rawContentType('a.docx') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
check('白名单外返回 null', rawContentType('a.exe') === null && rawContentType('a.doc') === null && rawContentType('a.wasm') === null)
check('无扩展名返回 null', rawContentType('a') === null && rawContentType('a.') === null)
check('点文件不算扩展名', rawExtOf('.pdf') === '')
check('双扩展取最后一个', rawExtOf('a.b.pdf') === 'pdf')

// ── parseRangeHeader：正常区间 ──
check('无头 → undefined（200 全量）', parseRangeHeader(undefined, 100) === undefined)
check('空串 → undefined', parseRangeHeader('', 100) === undefined)
check('bytes=0- 全量', JSON.stringify(parseRangeHeader('bytes=0-', 100)) === '{"start":0,"end":99}')
check('bytes=10-19 精确区间', JSON.stringify(parseRangeHeader('bytes=10-19', 100)) === '{"start":10,"end":19}')
check('bytes=10- 开区间', JSON.stringify(parseRangeHeader('bytes=10-', 100)) === '{"start":10,"end":99}')
check('bytes=-5 后缀形式', JSON.stringify(parseRangeHeader('bytes=-5', 100)) === '{"start":95,"end":99}')
check('end 越界收敛', JSON.stringify(parseRangeHeader('bytes=0-999', 100)) === '{"start":0,"end":99}')
check('带空白容忍', JSON.stringify(parseRangeHeader(' bytes=0-9 ', 100)) === '{"start":0,"end":9}')

// ── parseRangeHeader：416（null）──
check('start 越界 → null', parseRangeHeader('bytes=100-', 100) === null)
check('空文件任何 start → null', parseRangeHeader('bytes=0-', 0) === null)
check('空文件后缀 → null', parseRangeHeader('bytes=-5', 0) === null)
check('后缀 -0 → null', parseRangeHeader('bytes=-0', 100) === null)

// ── parseRangeHeader：语法不认 → undefined（忽略 Range 回 200）──
check('多区间 → undefined', parseRangeHeader('bytes=0-1,5-9', 100) === undefined)
check('单位错 → undefined', parseRangeHeader('items=0-5', 100) === undefined)
check('乱写 → undefined', parseRangeHeader('bytes=abc-def', 100) === undefined)
check('end<start → undefined', parseRangeHeader('bytes=5-2', 100) === undefined)
check('双空 → undefined', parseRangeHeader('bytes=-', 100) === undefined)

if (failed) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
