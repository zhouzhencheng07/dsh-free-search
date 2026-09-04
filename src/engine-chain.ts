// Free engine chain for the dsh web seam.
//
// Tries engines in priority order and fails over automatically. Specialized
// engines (GitHub, arXiv, StackExchange, HN) only participate when the query
// strongly signals their domain; general engines (Tavily keyless, Bing RSS,
// Sogou HTML) always participate. All engines are free: Tavily runs in keyless
// mode unless TAVILY_API_KEY is set, everything else needs no key at all.

import { tavilyEngine } from './engines/tavily.ts'
import { bingEngine } from './engines/bing.ts'
import { sogouEngine } from './engines/sogou.ts'
import { githubEngine } from './engines/github.ts'
import { arxivEngine } from './engines/arxiv.ts'
import { stackExchangeEngine } from './engines/stackexchange.ts'
import { hnEngine } from './engines/hn.ts'

/** 规范化的单条结果（seam 与工具返回共用这个形状） */
export interface SearchResultItem {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface SearchResult {
  items: SearchResultItem[]
  summary?: string
}

/** 引擎契约：available 廉价离线；match 仅专用引擎有 */
export interface SearchEngine {
  id: string
  available(): boolean
  match?(query: string): boolean
  search(query: string, opts: { maxResults?: number; signal?: AbortSignal }): Promise<SearchResult>
}

// Priority order: specialized first when matched (they are the best fit for
// their domain), then the general engines by result quality.
const ENGINES: SearchEngine[] = [
  githubEngine,
  arxivEngine,
  stackExchangeEngine,
  hnEngine,
  tavilyEngine,
  bingEngine,
  sogouEngine,
]

const ENGINE_TIMEOUT_MS = 12_000

/**
 * Run one search through the chain. Returns the first successful engine's
 * normalized result; throws with a per-engine attempt trail when all fail.
 */
export async function searchChain(
  query: string,
  { maxResults = 5, signal }: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<{ engine: string; attempts: string[]; items: SearchResultItem[]; summary?: string }> {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) {
    throw new Error('free-search: query is empty')
  }
  const attempts: string[] = []
  for (const engine of ENGINES) {
    if (!engine.available()) continue
    if (typeof engine.match === 'function' && !engine.match(q)) continue
    try {
      const result = await runWithTimeout(engine, q, maxResults, signal)
      return {
        engine: engine.id,
        attempts,
        items: capItems(result.items, maxResults),
        ...(result.summary ? { summary: result.summary } : {}),
      }
    } catch (error) {
      attempts.push(`${engine.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `free-search: no usable engine answered (${attempts.join('; ') || 'no engine available'})`,
  )
}

function runWithTimeout(engine: SearchEngine, query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS)
  timer.unref?.()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return engine
    .search(query, { maxResults, signal: controller.signal })
    .finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
}

function capItems(items: unknown, maxResults: number): SearchResultItem[] {
  if (!Array.isArray(items)) return []
  return maxResults > 0 ? items.slice(0, maxResults) : items
}
