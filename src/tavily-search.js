// tavily-search plugin for DeepSeek Harness (dsh)
// A free, keyless web search tool (Tavily keyless API).
//
// Plain ESM JavaScript on purpose: it loads on any dsh build (source checkout
// or installed artifact) without a TypeScript build step. `@deepseek-ai/dsh-tools`
// is resolved at runtime through Node's parent-walk (the harness installs it in
// the profile fallback node_modules).
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tavily-search'

export const inject = ['tools']

const TAVILY_URL = 'https://api.tavily.com/search'
const TIMEOUT_MS = 30_000
const MAX_RESULTS = 5

function formatResults(results) {
  if (!results || results.length === 0) {
    return 'No results found.'
  }
  const lines = []
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title ?? ''}`)
    lines.push(`    URL: ${r.url ?? ''}`)
    if (r.content) {
      lines.push(`    ${r.content}`)
    }
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'tavily_search',
      description:
        'Search the web for real-time information. Returns summarized results with titles, URLs, and content snippets. Uses the free keyless Tavily API (no API key needed). Prefer this over other search tools for general web lookups.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The search term to look up on the web.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        if (!args.query || !args.query.trim()) {
          throw new Error('tavily_search: query is empty')
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        exec.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        })
        try {
          const resp = await fetch(TAVILY_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tavily-Access-Mode': 'keyless',
            },
            body: JSON.stringify({
              query: args.query.trim(),
              max_results: MAX_RESULTS,
              search_depth: 'basic',
            }),
            signal: controller.signal,
          })
          if (!resp.ok) {
            throw new Error(`tavily_search: HTTP ${resp.status}`)
          }
          const data = await resp.json()
          return formatResults(data.results ?? [])
        } finally {
          clearTimeout(timer)
        }
      },
    }),
  )
}
