English | [中文](README.md)

# dsh-free-search

A free, multi-source web search plugin for DeepSeek Harness (dsh).

Registers as a search provider on dsh's native `web` seam, so the built-in
`web_search` tool runs on a free engine chain with **native citation cards** —
and stops burning DeepSeek API credits (the base layer's default
`deepseek-official` route costs one model call per search).

## Engine chain (all free, automatic failover)

| Engine | Auth | Trigger | Notes |
|---|---|---|---|
| GitHub Search API | keyless | query mentions repo/仓库/`owner/repo` or a github.com link | code/repo search |
| arXiv API | keyless | query mentions arxiv/preprint or an arXiv ID (e.g. `arxiv 1706.03762`) | direct paper lookup / search |
| StackExchange API | keyless | query mentions stackoverflow etc. | programming Q&A |
| Hacker News (Algolia) | keyless | query mentions hacker news etc. | tech news |
| **Tavily** | **keyless by default**; keyed when `TAVILY_API_KEY` is set | always (primary) | keyed mode adds answer summaries |
| Sogou web search | keyless (HTML) | always (fallback) | Chinese-language fallback; redirect links auto-resolved |

Priority: a matched specialized engine runs first, then Tavily keyless → Sogou;
a failing engine is skipped automatically, and when all fail the error lists
every attempt. Optional env: `TAVILY_API_KEY`.

> Note: Baidu's current SERP is JS-rendered (no results in static HTML) so it
> cannot be scraped; Exa/Brave/Google free APIs are unreachable from the
> network this plugin targets, so they are not included.

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-free-search"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing; the
built-in `web_search` then runs on the free engine chain.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-free-search"
```

> If you previously loaded this plugin via a `--patch ./scratch-plugin/...`
> flag, remove that flag from the launch command — the bundle now owns the
> `free-search` row, and a duplicate insert would fail to boot.

## How it works

- `src/web-search.js`: `ctx.web.registerSearchProvider({ id: 'free-search', ... })`.
- `src/engine-chain.js`: engine priority, query routing (specialized engines
  join on query signals), failover, timeout and cancellation (`AbortSignal`
  forwarding).
- `src/engines/*.js`: per-engine requests and normalization into a uniform
  `{ url, title?, snippet?, publishedAt? }` item list.
- `cordis.patch.yml`: repoints the `web` row's `searchProvider` from
  `deepseek-official` to `free-search` (that row's config has only this one
  base key, so a wholesale replacement is safe; a later profile patch can pin
  any provider back).

## Requirements

- Node.js ≥ 22 (dsh requirement)
- No API key required; plain ESM, zero dependencies, zero build step

## License

MIT
