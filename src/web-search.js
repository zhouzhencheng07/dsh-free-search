// free-search plugin for DeepSeek Harness (dsh)
// A free, multi-source web search provider for the dsh web seam.
//
// Registers as a `ctx.web` search provider so the harness's built-in
// `web_search` tool runs on a free engine chain (Tavily keyless first, then
// keyless fallbacks), replacing the paid deepseek-official route. Keeps the
// native citation cards: the seam renders `sources[]` directly.
//
// Plain ESM JavaScript on purpose: it loads on any dsh build (source checkout
// or installed artifact) without a TypeScript build step, and has zero
// dependencies beyond Node builtins.

import { searchChain } from './engine-chain.js'

export const name = 'free-search'

export const inject = ['web']

/**
 * The web seam's search provider. `available()` must stay cheap and offline;
 * the chain always ships and Tavily keyless needs no configuration, so it
 * answers true and leaves the honest verdict to execution: a run with no
 * usable engine fails with the per-engine attempt list, which beats a silent
 * false here.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.web?.registerSearchProvider !== 'function') {
    // A developer-preview surface move: degrade to nothing, but say so in the
    // harness log instead of vanishing.
    console.error('[free-search] web seam has no registerSearchProvider; search provider skipped')
    return
  }
  const maxResultsDefault = config.maxResults ?? 5
  ctx.web.registerSearchProvider({
    id: config.providerId ?? 'free-search',
    available: () => true,
    async search(request, signal) {
      const { items, summary } = await searchChain(request.query, {
        maxResults: request.maxResults ?? maxResultsDefault,
        signal,
      })
      return {
        ...(summary ? { content: summary } : {}),
        sources: items.map((item) => ({
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
          ...(item.snippet ? { snippet: item.snippet } : {}),
          ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        })),
        // The seam caps sources[] to the request's maxResults itself.
        truncated: false,
      }
    },
  })
}
