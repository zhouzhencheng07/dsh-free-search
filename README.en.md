English | [中文](README.md)

# dsh-kit

A page-capability kit plugin for DeepSeek Harness (dsh): optional add-ons for the
dsh browser UI, each independent and dependency-free; with none used, dsh stays stock.

## Features

- **Terminal** (composer-row toggle / **Ctrl+/**): a tabbed bottom terminal dock
  bound to the session workspace at open time; hidden docks keep running; prefers
  pwsh on Windows
- **File tree** (composer-row toggle): browse the session workspace; create/
  rename/delete (to Recycle Bin)/copy path; click a file for a right-docked
  preview/edit (mtime CAS)/colored diff; one-click copy on md code blocks
- **Source control** (composer-row toggle, default **Ctrl+Alt+.**): an in-page git
  workbench — stage/unstage/discard/commit, diff view, branch switch/create/delete,
  one-click push, commit graph; one-click repo init for non-git directories
- **Background jobs** (composer-row toggle): a right-docked panel listing the
  session's running jobs, with output viewing and job termination (official
  `job_output`/`job_kill` semantics)
- **Skill pool** (new Settings page): workspace / user-level / skill-pool groups
  with copy, move, delete, disable/enable; shadowed same-name skills get a dashed
  badge
- **Phone access** (new Settings page): scan a QR code to reach the local dsh web —
  token-gated gateway (default port 3090, editable), off on every startup by
  default; LAN and remote dual links, full HTTP/WS passthrough
- **Web search** (merged from dsh-free-search): a keyless engine chain
  (Tavily → Bing → Sogou, failover by priority) replaces the paid
  `deepseek-official`; toggle via the settings card
- **Settings card**: dsh-kit config card — per-feature switches, shortcut
  customization (terminal / file tree / source control / sidebar), search-result
  count, etc.

## Install & update

Install the latest release (recommended):

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit#semver:*"
```

Or track the latest commit on main:

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

Update to the latest version:

```bash
dsh plugin --profile web update dsh-kit
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer. After installing/updating, restart `dsh web`: four toggles — Files / Source
Control / Background Jobs / Terminal — appear on the composer tool row, and the
agent's `web_search` switches to the free multi-source chain.

## How it works

- `src/index.js`: host side — `/dsh-kit/terminal` WebSocket endpoint (node-pty),
  `/tree`, `/read` (512 KB cap + text decoding), `/write` (cwd subtree + mtime
  CAS), `/fs/op`, `/jobs/kill|output`, and the phone-gateway endpoints
- `client/bundle.js`: browser side (hand-written ModuleLoader bundle, no build) —
  four toggles on `conversation.input.left`; the file tree and source control
  share the sidebar slot; self-drawn preview panels and the terminal dock
  (conversation made room via CSS); settings page + card on the settings slots
- `src/web-search.js` + `src/engine-chain.js` + `src/engines/*`: registers the
  `free-search` provider on the web seam, gated by the settings card's
  `searchEnabled`
- `cordis.patch.yml`: inserts the dsh-kit row into the bundle layer and rewrites
  the web row's `searchProvider` to `free-search`
- Host-side `node-pty`/`ws` declare no dependencies: resolved at runtime from the
  profile fallback node_modules

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT