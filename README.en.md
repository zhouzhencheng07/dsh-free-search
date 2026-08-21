English | [中文](README.md)

# dsh-kit

A page-capability kit plugin for DeepSeek Harness (dsh): optional add-ons for
the dsh browser UI, each one independent and dependency-free; with none used,
dsh stays stock.

## Capabilities

### Terminal

A VSCode-style in-page terminal:

- `>_` toggle at the sidebar foot or **Ctrl+`** opens/closes the bottom
  terminal panel
- Opens in the **current session's workspace directory** (session cwd; falls
  back to the most recent workspace path)
- On Windows prefers pwsh (PowerShell 7+), falls back to powershell.exe;
  one-click restart inside the panel
- Closing the panel / refreshing the page ends the shell process (no orphans)

### File tree

A file-tree toggle at the sidebar foot (next to Settings):

- The panel takes over the sidebar browsing area, rooted at the **current
  session's workspace directory**
- Directories expand lazily level by level; **clicking a file previews its
  content in a right-docked panel (opens at full width by default — the
  conversation shifts left to make room; drag the left edge to widen/narrow —
  GitHub-like file view)**; a "copy path" button sits in the preview head
- Data comes from the plugin host's read-only `/dsh-kit/tree` (directory
  listing) and `/dsh-kit/read` (file content, 512 KB cap with truncation +
  binary detection) endpoints (same-origin checked; the webserver binds
  loopback only)

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing; a
terminal toggle and a file-tree toggle appear at the sidebar foot.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## How it works

- `src/index.js`: host side — mounts four endpoints: a `/dsh-kit/terminal`
  WebSocket endpoint via `ctx.webServer.registerUpgrade` (Origin same-origin
  check before upgrade; each connection = one node-pty session, JSON text-frame
  protocol, see the file-header comment), static `/dsh-kit/vendor/*` assets
  (official prebuilt xterm UMD), a read-only `/dsh-kit/tree?path=…`
  single-level directory listing (the official browse RPC lists directories
  only, so the file tree uses this), and a read-only `/dsh-kit/read?path=…`
  single-file text reader (512 KB cap + binary detection).
- `client/bundle.js`: browser side (hand-written ModuleLoader-format client
  bundle, no build step) — registers two toggles on the `sidebar.footer.action`
  slot: the terminal (bottom-docked panel, lazy-loading the vendor xterm on
  first open) and the file tree (temporarily takes over the
  `sidebar.workspaces` slot; clicking a file opens a self-drawn right-docked
  preview panel — a `body.dshk-pane-open` class + `--dshk-pane-w` variable
  shift the conversation column aside via CSS, instead of the native details
  column / `ctx.layout`, because `openDetails()` is fixed at 360 and
  `setDetails` is unreachable from dynamic plugins).
- `cordis.patch.yml`: inserts the `dsh-kit` row into the bundle layer.
- Host-side `node-pty`/`ws` declare no dependencies: they resolve at runtime
  from the profile fallback node_modules.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT
