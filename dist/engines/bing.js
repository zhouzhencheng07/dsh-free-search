// Bing engine: free general web search via its RSS output (no key).
// https://www.bing.com/search?q=...&format=rss
//
// `format=rss` is an undocumented-but-stable Bing parameter returning the SERP
// as an RSS 2.0 feed (title/link/description per item; hard cap of 10 items —
// the `count` parameter is ignored). The host may 302 to a regional host
// (cn.bing.com etc.); fetch follows transparently, so results come back
// region-localized. Unofficial and rate-limited; sits between Tavily
// (primary) and Sogou (last resort).
const BING_SEARCH = 'https://www.bing.com/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const bingEngine = {
    id: 'bing',
    available: () => true,
    async search(query, { maxResults = 5, signal } = {}) {
        const url = `${BING_SEARCH}?q=${encodeURIComponent(query)}&format=rss`;
        const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal });
        if (!resp.ok) {
            throw new Error(`bing: HTTP ${resp.status}`);
        }
        const xml = await resp.text();
        const items = parseBingRss(xml).slice(0, maxResults);
        if (items.length === 0) {
            throw new Error('bing: no results in RSS (anti-bot or layout change)');
        }
        return { items };
    },
};
/** RSS 2.0 文本 → 规范 items。导出仅为单元测试（正则解析是唯一脆弱点） */
export function parseBingRss(xml) {
    const items = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1] ?? '';
        const url = decodeEntities(extractTag(block, 'link'));
        const title = decodeEntities(extractTag(block, 'title'));
        const snippet = decodeEntities(extractTag(block, 'description'));
        if (!url)
            continue;
        items.push({ url, title: title || undefined, snippet: snippet || undefined });
    }
    return items;
}
function extractTag(block, tag) {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? (m[1] ?? '').trim() : '';
}
/** 实体解码：数字实体先解，&amp; 最后解（避免双重解码） */
function decodeEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => safeFromCode(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}
function safeFromCode(code) {
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
