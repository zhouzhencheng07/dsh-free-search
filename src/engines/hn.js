// Hacker News engine: tech-news search via the Algolia public API (no key).
// Participates only for explicit HN-ish queries.

const HN_API = 'https://hn.algolia.com/api/v1/search'

export const hnEngine = {
  id: 'hn',
  available: () => true,
  match(query) {
    return /hacker news|\bhn\b|ycombinator/i.test(query)
  },
  async search(query, { maxResults = 5, signal } = {}) {
    const url = `${HN_API}?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(maxResults, 10)}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'dsh-free-search/0.2' },
      signal,
    })
    if (!resp.ok) {
      throw new Error(`hn: HTTP ${resp.status}`)
    }
    const data = await resp.json()
    const items = (data.hits ?? []).map((h) => ({
      url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
      title: h.title ?? h.story_title ?? '',
      snippet: [h.points ? `${h.points} points` : '', h.num_comments ? `${h.num_comments} comments` : '']
        .filter(Boolean)
        .join(' · '),
      publishedAt: h.created_at ? h.created_at.slice(0, 10) : undefined,
    })).filter((it) => it.url)
    return { items }
  },
}
