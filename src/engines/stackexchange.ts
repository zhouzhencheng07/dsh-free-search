// StackExchange engine: programming Q&A search via the public API (no key).
// Participates only for explicit StackOverflow-ish queries.

const SE_API = 'https://api.stackexchange.com/2.3/search/advanced'

export const stackExchangeEngine = {
  id: 'stackexchange',
  available: () => true,
  match(query: string): boolean {
    return /stackoverflow|stack exchange|stackexchange|程序员问答/i.test(query)
  },
  async search(query: string, { maxResults = 5, signal }: { maxResults?: number; signal?: AbortSignal } = {}) {
    const url = `${SE_API}?site=stackoverflow&q=${encodeURIComponent(query)}&pagesize=${Math.min(maxResults, 10)}&order=desc&sort=relevance`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'dsh-free-search/0.2' },
      signal,
    })
    if (!resp.ok) {
      throw new Error(`stackexchange: HTTP ${resp.status}`)
    }
    const data: any = await resp.json()
    const items = (data.items ?? [])
      .map((r: { link?: string; title?: string; tags?: string[]; creation_date?: number }) => ({
        url: r.link ?? '',
        title: r.title ?? '',
        snippet: Array.isArray(r.tags) ? r.tags.join(', ') : '',
        publishedAt: r.creation_date
          ? new Date(r.creation_date * 1000).toISOString().slice(0, 10)
          : undefined,
      }))
      .filter((it: { url: string }) => it.url)
    return { items }
  },
}
