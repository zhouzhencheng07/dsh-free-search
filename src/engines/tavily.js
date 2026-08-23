// Tavily engine: keyless by default, keyed when TAVILY_API_KEY is set.
// https://docs.tavily.com/documentation/api-reference/endpoint/search

const TAVILY_BASE = 'https://api.tavily.com'
const KEYLESS_HEADER = { 'X-Tavily-Access-Mode': 'keyless' }

export const tavilyEngine = {
  id: 'tavily',
  available: () => true,
  async search(query, { maxResults = 5, signal } = {}) {
    const apiKey = process.env.TAVILY_API_KEY
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    } else {
      Object.assign(headers, KEYLESS_HEADER)
    }
    const resp = await fetch(`${TAVILY_BASE}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        max_results: Math.min(maxResults, 8),
        search_depth: 'basic',
        ...(apiKey ? { include_answer: true } : {}),
      }),
      signal,
    })
    if (!resp.ok) {
      throw new Error(`tavily: HTTP ${resp.status}`)
    }
    const data = await resp.json()
    const items = (data.results ?? []).map((r) => ({
      url: r.url ?? '',
      title: r.title ?? '',
      snippet: r.content ?? '',
    })).filter((it) => it.url)
    return {
      items,
      ...(typeof data.answer === 'string' && data.answer ? { summary: data.answer } : {}),
    }
  },
}
