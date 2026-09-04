// GitHub engine: code/repository search via the public REST API (no key,
// unauthenticated rate limits apply). Participates only for repo-like queries.

const GITHUB_SEARCH = 'https://api.github.com/search/repositories'
const UA = 'dsh-free-search/0.2'

export const githubEngine = {
  id: 'github',
  available: () => true,
  // Repo-like: github.com links, explicit code words, or owner/repo shapes.
  match(query: string): boolean {
    return (
      /github\.com\/[\w.-]+\/[\w.-]+/i.test(query) ||
      /(^|\s)(repo|repository|代码库|仓库|开源项目)(\s|$)/i.test(query) ||
      /^[\w.-]+\/[\w.-]+$/.test(query)
    )
  },
  async search(query: string, { maxResults = 5, signal }: { maxResults?: number; signal?: AbortSignal } = {}) {
    const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(query)}&per_page=${Math.min(maxResults, 10)}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal,
    })
    if (!resp.ok) {
      throw new Error(`github: HTTP ${resp.status}`)
    }
    const data: any = await resp.json()
    const items = (data.items ?? [])
      .map((r: { html_url?: string; full_name?: string; name?: string; description?: string; stargazers_count?: number; updated_at?: string }) => ({
        url: r.html_url ?? '',
        title: r.full_name ?? r.name ?? '',
        snippet: [r.description, r.stargazers_count ? `⭐ ${r.stargazers_count}` : '']
          .filter(Boolean)
          .join(' · '),
        publishedAt: r.updated_at ? r.updated_at.slice(0, 10) : undefined,
      }))
      .filter((it: { url: string }) => it.url)
    return { items }
  },
}
