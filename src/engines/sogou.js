// Sogou engine: free Chinese web search via its HTML endpoint (no key).
// https://www.sogou.com/web?query=...
//
// Sogou's SERP is server-rendered (unlike Baidu's JS-only shell). Result
// anchors point at /link?url=... redirect pages, whose real target is
// resolved from the redirect page's `window.location.replace("...")`.
// Unofficial and rate-limited; used as a fallback, never the primary.

const SOGOU_WEB = 'https://www.sogou.com/web'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const sogouEngine = {
  id: 'sogou',
  available: () => true,
  async search(query, { maxResults = 5, signal } = {}) {
    const url = `${SOGOU_WEB}?query=${encodeURIComponent(query)}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal,
    })
    if (!resp.ok) {
      throw new Error(`sogou: HTTP ${resp.status}`)
    }
    const html = await resp.text()
    const blocks = parseResultBlocks(html)
    if (blocks.length === 0) {
      throw new Error('sogou: no results in SERP (anti-bot or layout change)')
    }
    // Resolve the /link?url=... redirects to real URLs (parallel, capped).
    const resolved = await Promise.all(
      blocks.slice(0, maxResults).map(async (b) => {
        if (!b.redirect) return b
        try {
          return { ...b, url: await resolveSogouLink(b.redirect, signal) }
        } catch {
          return b
        }
      }),
    )
    return { items: resolved.filter((it) => it.url) }
  },
}

function parseResultBlocks(html) {
  const blocks = []
  const wraps = html.match(/<div class="vrwrap">[\s\S]*?(?=<div class="vrwrap">|$)/g) ?? []
  for (const wrap of wraps) {
    const titleMatch = wrap.match(
      /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    )
    if (!titleMatch) continue
    const redirect = titleMatch[1]
    const title = cleanText(titleMatch[2])
    const snippetMatch = wrap.match(
      /<div[^>]*class="[^"]*fz-mid space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    )
    const snippet = snippetMatch ? cleanText(snippetMatch[1]) : ''
    if (!title && !snippet) continue
    blocks.push({ title, snippet, redirect })
  }
  return blocks
}

async function resolveSogouLink(redirect, signal) {
  const resp = await fetch(`https://www.sogou.com${redirect}`, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.sogou.com/web',
    },
    redirect: 'manual',
    signal,
  })
  const page = await resp.text()
  const m = page.match(/location\.replace\("([^"]+)"\)/) ?? page.match(/URL='([^']+)'/)
  if (!m) throw new Error('no target')
  return m[1]
}

function cleanText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
