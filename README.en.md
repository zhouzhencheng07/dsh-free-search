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

### Skill pool management

A new "Skills" page in the settings panel:

- **Three groups**: **Workspace** (`.agents/skills` + `.dsh/skills` merged),
  **User level** (`$DSH_HOME/skills`, `~/.agents/skills`) and the
  **Skill pool** (`$DSH_HOME/skill-pool` — not a scan root, DSH never reads it;
  purely a shelf for moving skills between workspaces). Plugin-bundled /
  runtime skills are listed read-only under "Other sources" with their
  provider/source attribution.
- One line per skill: name + priority badge (e.g. `(200)`; the group head lists
  roots as `.dsh/skills(100) | .agents/skills(200)` — lower rank wins) +
  truncated description + all actions inline.
- Operations: **Copy / Move** (click expands an inline destination picker —
  pick a root to execute; same-name conflicts ask before overwrite),
  **Delete** (permanent, guarded by an inline two-step confirm), and
  **Disable/Enable** (toggles `disable-model-invocation` + `user-invocable`
  in the SKILL.md frontmatter — the registry's native mechanism, hot-reloaded
  via chokidar; pool skills offer no disable since the pool is never scanned;
  plugin-bundled skills have no files to edit, so their actions are disabled).
- **Priority visualization**: DSH resolves same-name skills by scan-root rank
  (`.dsh`(100) > `.agents`(200) > `$DSH_HOME`(400) > `~/.agents`(500));
  shadowed copies get a dashed "Shadowed" badge with a hover explanation.
- Click any skill to view its details inline. Data flows through host
  endpoints `/dsh-kit/skills` (listing) and `/dsh-kit/skills/op` (operations),
  both whitelist-path validated and same-origin checked.
- The "Skills" nav row uses a self-drawn layers icon (the official navIcon is
  a hardcoded id map falling back to the gear; this is a cosmetic DOM swap by
  label text that silently keeps the gear on failure).

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
- `src/skill-pool.js`: skill-management host side — `GET /dsh-kit/skills`
  enumerates skills under the whitelist roots (pool / user / project) with
  registry-based attribution enrichment, and `POST /dsh-kit/skills/op` performs
  copy/move/delete (into the pool trash area)/disable (frontmatter keys).
  Sources must be direct children of a root and every path is realpath-checked
  for containment.
- `client/bundle.js`: browser side (hand-written ModuleLoader-format client
  bundle, no build step) — registers two toggles on the `sidebar.footer.action`
  slot: the terminal (bottom-docked panel, lazy-loading the vendor xterm on
  first open) and the file tree (temporarily takes over the
  `sidebar.workspaces` slot; clicking a file opens a self-drawn right-docked
  preview panel — a `body.dshk-pane-open` class + `--dshk-pane-w` variable
  shift the conversation column aside via CSS, instead of the native details
  column / `ctx.layout`, because `openDetails()` is fixed at 360 and
  `setDetails` is unreachable from dynamic plugins); plus a full "Skills"
  page registered on the `settings.section` slot.
- `cordis.patch.yml`: inserts the `dsh-kit` row into the bundle layer.
- Host-side `node-pty`/`ws` declare no dependencies: they resolve at runtime
  from the profile fallback node_modules.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT
