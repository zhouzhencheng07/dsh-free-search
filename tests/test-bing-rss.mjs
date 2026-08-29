// Bing RSS 解析单元测试：不联网，喂 fixture 验证 item 抽取与实体解码。
// 用法：node tests\test-bing-rss.mjs（退出码即结果）
import assert from 'node:assert/strict'
import { parseBingRss } from '../src/engines/bing.js'

const SAMPLE = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: test query</title>
<item><title>First &amp; result</title><link>https://example.com/a?x=1&amp;y=2</link><description>Snippet with &lt;b&gt;bold&lt;/b&gt; and &#x4e2d;&#25991; entities.</description></item>
<item><title>Second</title><link>https://example.com/b</link></item>
<item><title>No link item</title><description>skipped</description></item>
<item><title>Third</title><link>https://example.com/c</link><description>plain</description></item>
</channel></rss>`

const items = parseBingRss(SAMPLE)
assert.equal(items.length, 3, `应抽取 3 个带 link 的 item，实得 ${items.length}`)

assert.equal(items[0].url, 'https://example.com/a?x=1&y=2', 'link 实体应解码')
assert.equal(items[0].title, 'First & result', 'title 实体应解码')
assert.equal(items[0].snippet, 'Snippet with <b>bold</b> and 中文 entities.', '数字实体应解码为汉字')

assert.equal(items[1].url, 'https://example.com/b')
assert.equal(items[1].snippet, undefined, '缺 description 应为 undefined')
assert.equal(items[2].url, 'https://example.com/c')

assert.deepEqual(parseBingRss('<rss><channel></channel></rss>'), [], '空 feed 应返回空数组')
assert.deepEqual(parseBingRss('not xml at all'), [], '非 XML 输入应返回空数组')

// 双重转义只解一层：&amp;lt; → &lt;（原文即如此，不再继续解成 <）
const doubleEscaped = parseBingRss(
  '<rss><channel><item><link>https://e.com/x</link><description>a&amp;lt;b&amp;amp;c</description></item></channel></rss>',
)
assert.equal(doubleEscaped[0].snippet, 'a&lt;b&amp;c', '&amp; 应最后解码避免二次解')

console.log('ALL BING RSS TESTS OK')
