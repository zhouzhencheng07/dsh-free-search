English | [中文](README.md)

# dsh-kit

A page-capability kit plugin for DeepSeek Harness (dsh): optional add-ons for
the dsh browser UI, each one independent and dependency-free; with none used,
dsh stays stock.

## Capabilities

### Terminal

A terminal toggle on the composer tool row or **Ctrl+/** shows/hides the bottom
**terminal dock (tabbed)**:

- **Multiple terminals**: the ＋ button in the dock header spawns a new one bound
  to the current session workspace at that moment; later workspace switches don't
  affect open terminals. Same-workspace tabs get a sequence number
- The entry button and the shortcut only **toggle the dock's visibility** — hidden
  terminals keep running and buffering output; each tab's ✕ kills that session;
  the badge on the entry icon shows how many are alive. Refreshing the page ends
  everything (no orphan processes)
- On Windows prefers pwsh (PowerShell 7+), falls back to powershell.exe

### File tree

A file-tree toggle on the composer tool row:

- The panel takes over the sidebar browsing area, rooted at the **current
  session's workspace directory**, expanding lazily level by level
- **File management**: header ＋📄/＋📁 buttons create a file/folder in the
  current directory; row hover actions — new file/folder on directory rows,
  copy path on any row (double-rectangle icon = **absolute path**, dotted icon
  = **relative path**, relative to the current workspace root), ✎ inline
  rename (selects the stem, keeping the extension; Enter commits,
  Esc cancels) and 🗑 delete on any row (deletes go to the **Recycle Bin** on
  Windows, with a two-step confirm)
- Clicking a file opens a right-docked preview/edit panel: the conversation
  column steps aside, drag the left edge to widen/narrow; ✎ enters edit mode
  (draft-based save, mtime CAS conflict asks to reload, truncated previews are
  not editable), ✕ closes back; ⇄ switches to the colored diff view
- Data flows through the plugin host's `/dsh-kit/tree` (directory listing),
  `/dsh-kit/read` (file content, 512 KB cap with truncation + text decoding),
  `/dsh-kit/write` (edit save: cwd-subtree validation + mtime CAS guard against
  concurrent overwrites) and `/dsh-kit/fs/op` (create/rename/delete: targets are
  confined to the cwd subtree, names whitelist-checked; same-origin checked;
  the webserver binds loopback only)
- **Text decoding** (`/dsh-kit/read`, same path as txt): BOM wins — UTF-8 /
  UTF-16 LE / UTF-16 BE decode by their encoding; without a BOM, a NUL-free
  first 4 KB is read as UTF-8. Files containing NULs are judged by extension —
  config-class extensions like **ini / cfg / conf / cnf / properties / reg**
  get a UTF-16LE/BE two-way score recovery (the real-world case of Windows
  Notepad's "Unicode" save); log / json / toml / yml and dozens of other text
  extensions work the same way; dotfiles like `.gitignore` match by their full
  basename. Only files that fail text detection are treated as binary

### Source control

A source-control toggle on the composer tool row (default **Ctrl+Alt+.** —
steering clear of Ctrl+., which Chinese IMEs claim for punctuation toggle), an
in-page git workbench:

- Shares the sidebar browsing slot with the file tree (one at a time); while
  visible, the changes list **refreshes silently in the background** — AI edits
  appear live without flicker
- Groups **Staged Changes / Changes** (untracked files marked `U`) with
  collapsible headers; each row shows name, folder hint, `+N −N` stats and a
  status badge
- Hover actions: **Stage ＋ / Unstage － / Discard ↩** (discard is destructive,
  guarded by an inline two-step confirm); a commit box at the top commits staged
  content and offers **Commit All** when nothing is staged (`add -A` first),
  Enter submits
- Click a file to open the docked **diff view** (default): full-file colored
  rendering (removed red / added green, not a raw patch); very large files fall
  back to the raw diff. The header **⇄** toggles the plain-text view anytime —
  both entries share the same preview panel (the entry only picks the default),
  and ✎ editing works from either side
- Not a repository? One-click **Initialize Repository** (idempotent);
  non-ASCII filenames fully supported (`core.quotePath=false`)
- Data flows through host endpoints `/dsh-kit/git/status`, `/dsh-kit/git/diff`,
  `/dsh-kit/git/init` and `/dsh-kit/git/op`
  (stage/unstage/discard/stageAll/commit; spawns the git CLI directly, no
  library; all same-origin checked)

### Background jobs

The background-jobs toggle in the composer toolbar (between source control and
terminal), with a live count badge on the icon:

- Opens a **centered modal** listing the current session's running background
  jobs (the official job dropdown is read-only; this panel adds the controls)
- Each row: kind badge + command + status · elapsed time; **Output** expands
  live incremental output (shares the read cursor with the model's
  `job_output`), **Stop** terminates the job (same as `job_kill`, permission
  scoped per session — cross-session requests are rejected)
- Close via the ✕ button, clicking the backdrop, or Esc; finished jobs drop
  off the list (running jobs only)
- Data flows through host endpoints `/dsh-kit/jobs/kill` (POST) and
  `/dsh-kit/jobs/output` (GET incremental read); the task source is the
  official `session/jobs` push — no extra polling

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

### Phone access

A new "Phone access" page in the settings: scan a QR code with your phone
browser to reach the dsh web running on this computer:

- **Token-gated links**: a built-in gateway (default port 3090, **editable in
  the page**, 1-65535, auto-restarts on the new port after saving) bound to
  0.0.0.0 sends `?k=<token>` → HttpOnly Cookie → 302 to the loopback GUI; any
  missing/wrong token gets a 404, and expired cookies are rejected
- **Off on every startup by default**: after a DSH restart the gateway no
  longer restores itself; check "Keep enabled across restarts" in the page to
  reuse the last enabled state (same token, authorized devices stay signed in)
- **Manual token rotation**: the "New link" button in the page invalidates the
  current link and issues a fresh one — old links and authorized devices die
  instantly; start/stop no longer rotates automatically, restarts reuse the
  same token
- LAN and remote dual links: one `http://<ip>:<port>/?k=…` per local IPv4, plus
  `https://<domain>/?k=…` when a remote domain is configured (frp + caddy
  templates in `scripts/vps/`) — scan and go; **remote links hide the address
  text and QR code** (the URL carries the access token; prevents
  screenshot/shoulder-surfing leaks) and keep only a copy button
- **Full HTTP/WS passthrough**: Host rewritten to the loopback upstream,
  Origin stripped, gateway cookies never leak upstream; the terminal WebSocket
  tunnel works both ways (the terminal can even be used from your phone remotely)
- Security posture: a token equals full access on this machine (for your own
  use only); the remote tunnel is TLS-encrypted; stopping the gateway makes
  links unreachable and the next start issues a fresh credential
- Gateway token/state live in `data/dsh-kit-phone-gateway.json`, not in settings

### Web search

A host-side capability merged in from
[dsh-free-search](https://github.com/zhouzhencheng07/dsh-free-search) v0.2.0
(that repository stays at v0.2.0 and no longer evolves on its own):

- Registers the **free-search** provider on the dsh web seam, replacing the
  base layer's pinned `deepseek-official` (which costs one paid DeepSeek model
  call per search)
- A keyless engine chain fails over by priority: **Tavily** (keyless; set
  `TAVILY_API_KEY` for keyed quota) → **Bing** (RSS output, keyless) →
  **Sogou** (general fallback), with four
  domain engines — **GitHub / arXiv / StackExchange / Hacker News** — joining
  first when a query strongly signals their domain. Zero configuration.
- The agent's `web_search` tool keeps producing native citation cards
  (`sources[]` renders as usual)
- The "Enable web search" switch on the settings card: on = the free engine
  chain, off = the official default channel (`deepseek-official`); changes
  apply after restart. A later profile patch can also pin `searchProvider`
  to anything
- "Search result count" on the settings card (1-8, default 5): the per-search
  source cap, applied as the smaller of the seam request and this limit — more
  results means more context usage; applies immediately after saving (no
  restart needed)

### Settings card

The dsh-kit card under the official Settings → plugin configuration page
(namespace `dsh-kit`):

- Feature switches — terminal / file tree / source control / **background
  jobs** / skills page / web search / **sidebar-shortcut group** / **phone
  access page** — each independent: turning one off hides its entry button and
  disables its shortcut, instantly resetting any open view; the skills-page
  and phone-access switches remove their entries from the settings nav
  (the capabilities themselves are unaffected)
- Shortcut customization: terminal **Ctrl+/**, file tree **Ctrl+,**, source
  control **Ctrl+Alt+.** (the old Ctrl+. default is intercepted by Chinese IMEs
  for punctuation toggle), sidebar **Ctrl+B** — click Change to enter recording
  mode; the next key combo becomes the new shortcut (Esc cancels)
- A switch's child options stay collapsed until enabled (WYSIWYG); keys
  overridden at the user layer carry an "Overridden" badge with one-click
  reset to default
- CardForm-style draft model: edits stage locally and persist on save, with a
  write-then-read-back check; read-only deployments show a notice
- The web-search switch is consumed host-side (all others gate browser-side):
  when off, the agent's searches go through the official default channel;
  this switch applies after restart

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-kit"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). Restart `dsh web` after installing; four
toggles — Files / Source Control / Background Jobs / Terminal — appear on the
composer tool row, and the agent's `web_search` switches to the free
multi-source chain.

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-kit"
```

## How it works

- `src/index.js`: host side — mounts these endpoints: a `/dsh-kit/terminal`
  WebSocket endpoint via `ctx.webServer.registerUpgrade` (Origin same-origin
  check before upgrade; each connection = one node-pty session, JSON text-frame
  protocol, see the file-header comment), static `/dsh-kit/vendor/*` assets
  (official prebuilt xterm UMD), a read-only `/dsh-kit/tree?path=…`
  single-level directory listing (the official browse RPC lists directories
  only, so the file tree uses this), a read-only `/dsh-kit/read?path=…`
  single-file text reader (512 KB cap + text decoding via text-decode.js:
  BOM wins, and text-class extensions containing NULs get a UTF-16LE/BE
  recovery attempt), `/dsh-kit/write`
  edit save (cwd-subtree validation + mtime CAS), `/dsh-kit/fs/op` file
  management (create/rename/delete; targets confined to the cwd subtree,
  deletes go to the Recycle Bin on Windows), `/dsh-kit/jobs/kill` (POST: stop a
  background job) and `/dsh-kit/jobs/output` (GET: incremental output read) —
  both use the same caller-permission semantics as the official job_kill /
  job_output tools, plus the phone-access info/link/gateway endpoints
  (implementation in phone-gateway.js).
- `src/skill-pool.js`: skill-management host side — `GET /dsh-kit/skills`
  enumerates skills under the whitelist roots (pool / user / project) with
  registry-based attribution enrichment, and `POST /dsh-kit/skills/op` performs
  copy/move/delete (into the pool trash area)/disable (frontmatter keys).
  Sources must be direct children of a root and every path is realpath-checked
  for containment.
- `src/phone-gateway.js`: the phone-access gateway — a separate
  HTTP/WS reverse proxy on its own port (default 3090, 0.0.0.0). `?k=` token →
  HttpOnly Cookie → 302 to the loopback upstream; unauthorized requests get
  404, Host is rewritten to loopback, Origin stripped, gateway cookies never
  leak; `rotate()` (auto-rotated on off→on) and a state file
  (`data/dsh-kit-phone-gateway.json`) persist on/off and the token.
- `client/bundle.js`: browser side (hand-written ModuleLoader-format client
  bundle, no build step) — registers four toggles (Files / Source Control /
  Background Jobs / Terminal) on the `conversation.input.left` slot; the file
  tree and source control share the `sidebar.workspaces` slot, and clicking a
  file opens a self-drawn right-docked preview/edit/diff panel — a
  `body.dshk-pane-open` class + `--dshk-pane-w` variable shift the
  conversation column aside via CSS, instead of the native details column /
  `ctx.layout`, because `openDetails()` is fixed at 360 and `setDetails` is
  unreachable from dynamic plugins); the background-jobs panel (running list +
  output/stop controls) and the terminal dock render in `shell.overlay`; plus
  the Skills page and the Phone access page on the `settings.section` slot and
  the plugin settings card on `settings.plugin.item`.
- `src/web-search.js` + `src/engine-chain.js` + `src/engines/*`: web-search
  host side (merged verbatim from dsh-free-search v0.2.0) — registers the
  `free-search` provider on the web seam, gated by the settings card's
  `searchEnabled` (decided at startup: on = engine chain, off = same-id
  forwarding to the official channel); the engine chain fails over
  by priority and domain engines only join on strong query signals.
- `cordis.patch.yml`: inserts the `dsh-kit` row into the bundle layer and
  rewrites the web row's `searchProvider` from the base layer's pinned
  `deepseek-official` to `free-search` (a later profile patch can pin any
  provider back).
- Host-side `node-pty`/`ws` declare no dependencies: they resolve at runtime
  from the profile fallback node_modules.

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero declared dependencies, zero build step

## License

MIT
