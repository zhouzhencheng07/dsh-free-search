// Free engine chain for the dsh web seam.
//
// Tries engines in priority order and fails over automatically. Specialized
// engines (GitHub, arXiv, StackExchange, HN) only participate when the query
// strongly signals their domain; general engines (Tavily keyless, Bing RSS,
// Sogou HTML) always participate. All engines are free: Tavily runs in keyless
// mode unless TAVILY_API_KEY is set, everything else needs no key at all.
//
// Engine contract:
//   {
//     id: string,
//     available(): boolean,                 // cheap, offline
//     match?(query): boolean,               // specialized engines only
//     search(query, { maxResults, signal }): Promise<{
//       items: [{ url, title?, snippet?, publishedAt? }],
//       summary?: string,
//     }>,
//   }

import { tavilyEngine } from './engines/tavily.js'
import { bingEngine } from './engines/bing.js'
import { sogouEngine } from './engines/sogou.js'
import { githubEngine } from './engines/github.js'
import { arxivEngine } from './engines/arxiv.js'
import { stackExchangeEngine } from './engines/stackexchange.js'
import { hnEngine } from './engines/hn.js'

// Priority order: specialized first when matched (they are the best fit for
// their domain), then the general engines by result quality.
const ENGINES = [
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
export async function searchChain(query, { maxResults = 5, signal } = {}) {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) {
    throw new Error('free-search: query is empty')
  }
  const attempts = []
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

function runWithTimeout(engine, query, maxResults, signal) {
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

function capItems(items, maxResults) {
  if (!Array.isArray(items)) return []
  return maxResults > 0 ? items.slice(0, maxResults) : items
}

/** Shared HTTP helper: one fetch with timeout wiring already applied via signal. */
export async function httpJson(url, init = {}) {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  }
  return resp.json()
}

export const chainEngines = ENGINES.map((e) => e.id)
