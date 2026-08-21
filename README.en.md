English | [中文](README.md)

# dsh-kit

A page-capability kit plugin for DeepSeek Harness (dsh): optional add-ons for
the dsh browser UI, each one independent and dependency-free; with none used,
dsh stays stock.

## Capabilities

### Terminal

A VSCode-style in-page terminal:

- Floating `>_` button at the bottom-right corner or **Ctrl+`** toggles the
  bottom terminal panel
- Opens in the **current session's workspace directory** (session cwd; falls
  back to the most recent workspace path)
- On Windows prefers pwsh (PowerShell 7+), falls back to powershell.exe;
  one-click restart inside the panel
- Closing the panel / refreshing the page ends the shell process (no orphans)

### File tree

A file-tree toggle at the sidebar foot (next to Settings):

- The panel docks over the sidebar area, rooted at the **current session's
  workspace directory**
- Directories expand lazily level by level; clicking a file copies its
  absolute path (handy for pasting an @ reference)
- Data comes from the plugin host's read-only `/dsh-kit/tree` endpoint
  (same-origin checked; the webserver binds loopback only)

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing; a
terminal entry appears at the bottom-right of the page and a file-tree toggle
at the sidebar foot.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## How it works

- `src/index.js`: host side — mounts three endpoints: a `/dsh-kit/terminal`
  WebSocket endpoint via `ctx.webServer.registerUpgrade` (Origin same-origin
  check before upgrade; each connection = one node-pty session, JSON text-frame
  protocol, see the file-header comment), static `/dsh-kit/vendor/*` assets
  (official prebuilt xterm UMD), and a read-only `/dsh-kit/tree?path=…`
  single-level directory listing (the official browse RPC lists directories
  only, so the file tree uses this).
- `client/bundle.js`: browser side (hand-written ModuleLoader-format client
  bundle, no build step) — registers the terminal entry on the `shell.overlay`
  slot (lazy-loading the vendor xterm on first open) and the file-tree toggle
  on the `sidebar.footer.action` slot (panel docks over the sidebar area).
- `cordis.patch.yml`: inserts the `dsh-kit` row into the bundle layer.
- Host-side `node-pty`/`ws` declare no dependencies: they resolve at runtime
  from the profile fallback node_modules.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT
