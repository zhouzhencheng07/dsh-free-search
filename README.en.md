English | [中文](README.md)

# dsh-kit

A page-capability kit plugin for DeepSeek Harness (dsh): optional add-ons for
the dsh browser UI, each one independent and dependency-free; with none used,
dsh stays stock.

## Current capability: terminal

A VSCode-style in-page terminal:

- Floating `>_` button at the bottom-right corner or **Ctrl+`** toggles the
  bottom terminal panel
- Opens in the **current session's workspace directory** (session cwd; falls
  back to the most recent workspace path)
- On Windows prefers pwsh (PowerShell 7+), falls back to powershell.exe;
  one-click restart inside the panel
- Closing the panel / refreshing the page ends the shell process (no orphans)

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing; a
terminal entry appears at the bottom-right of the page.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## How it works

- `src/index.js`: host side — mounts a `/dsh-kit/terminal` WebSocket endpoint
  via `ctx.webServer.registerUpgrade` (Origin same-origin check before upgrade;
  each connection = one node-pty session, JSON text-frame protocol, see the
  file-header comment), and serves the official prebuilt xterm UMD assets under
  `client/vendor/` as `/dsh-kit/vendor/*`.
- `client/bundle.js`: browser side (hand-written ModuleLoader-format client
  bundle, no build step) — registers the floating entry on the `shell.overlay`
  slot and lazy-loads the vendor xterm when the panel first opens.
- `cordis.patch.yml`: inserts the `dsh-kit` row into the bundle layer.
- Host-side `node-pty`/`ws` declare no dependencies: they resolve at runtime
  from the profile fallback node_modules.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT
