English | [中文](README.md)

# dsh-tavily-search

Free keyless [Tavily](https://tavily.com) web search tool for DeepSeek Harness (dsh).

Registers one tool: `tavily_search` — real-time web search returning titles, URLs and content snippets. Uses Tavily's keyless access mode (`X-Tavily-Access-Mode: keyless`), so **no API key and no extra cost** are needed.

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-tavily-search"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing, then
the model gains the `tavily_search` tool.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-tavily-search"
```

> If you previously loaded this plugin via a `--patch ./scratch-plugin/...`
> flag, remove that flag from the launch command — the bundle now owns the
> `tavily-search` row, and a duplicate insert would fail to boot.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- `@deepseek-ai/dsh-tools` reachable from the profile (dsh installs it; no
  explicit dependency declaration needed — resolved via Node parent-walk)

## Development

- Source: `src/tavily-search.js` (plain ESM on purpose — no build step, loads on
  any dsh build).
- The package is a dsh **bundle**: `package.json` declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, which is what turns
  a `dsh plugin add` install into an active profile layer.

## License

MIT
