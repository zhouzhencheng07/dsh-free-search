// arXiv engine: paper/preprint search via the public API (no key).
// Participates only for arXiv-ish queries (explicit "arxiv"/preprint words).

const ARXIV_API = 'https://export.arxiv.org/api/query'

export const arxivEngine = {
  id: 'arxiv',
  available: () => true,
  match(query: string): boolean {
    return /\barxiv\b|预印本|preprint/i.test(query)
  },
  async search(query: string, { maxResults = 5, signal }: { maxResults?: number; signal?: AbortSignal } = {}) {
    // "arxiv 1706.03762" style: fetch the paper directly by id.
    const idMatch = query.match(/\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/)
    const url = idMatch
      ? `${ARXIV_API}?id_list=${idMatch[1]}`
      : `${ARXIV_API}?search_query=${encodeURIComponent(`all:${query.replace(/\barxiv\b|预印本|preprint/gi, ' ').trim() || query}`)}&max_results=${Math.min(maxResults, 10)}&sortBy=relevance`
    const resp = await fetch(url, { signal })
    if (!resp.ok) {
      throw new Error(`arxiv: HTTP ${resp.status}`)
    }
    const xml = await resp.text()
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
    const items = entries
      .map((entry) => {
        const id = entry.match(/<id>https?:\/\/([^<]+)<\/id>/)?.[1] ?? ''
        const title = clean(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
        const summary = clean(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '')
        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
        return {
          url: id ? `https://${id}` : '',
          title,
          snippet: summary.slice(0, 300),
          publishedAt: published ? published.slice(0, 10) : undefined,
        }
      })
      .filter((it) => it.url)
    return { items }
  },
}

function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}
