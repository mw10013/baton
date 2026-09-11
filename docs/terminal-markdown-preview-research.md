# TUI markdown preview with Mermaid for Ghostty + herdr

Research into a second herdr pane that renders markdown formatted (not raw
text) with pixel-perfect Mermaid diagrams, next to a pane running a coding
agent. Covers standalone TUI CLIs and the Neovim alternative.

**Status: validated 2026-09-10** — markdown-reader v1.34.75 installed via
`brew tap leboiko/tap && brew trust leboiko/tap && brew install
markdown-reader` and confirmed running in a herdr pane (Ghostty 1.3.1, herdr
0.9.0): file tree, tabs, formatted GFM render all good. Pixel-perfect
Mermaid rendering in-pane not yet explicitly verified — run the §7 fixture
to close that out.

**Requirements (confirmed):**

1. Runs inside herdr (TUI/CLI, no browser window).
2. Formatted markdown view, not raw text.
3. Mermaid support, **pixel-perfect** (ASCII fallback not acceptable).
4. Auto-reload on file change preferred; manual refresh tolerable if Mermaid
   is compelling.
5. Single-file preview acceptable; a file chooser / repo browser is a big
   plus.
6. Compare standalone TUI vs Neovim, including the learning-curve cost.

## 1. Verdict

| Rank                    | Tool                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Try first**        | **markdown-reader** (`markdown-tui-explorer`)        | Only candidate that hits all four: pixel-perfect Mermaid on Ghostty, live file watching, repo browser + tabs + search (the file-chooser plus), zero Node/Chromium. `brew install`, no Rust toolchain needed.                                                                                                                                                                                                  |
| 2. Simplest single-file | **tmdp** (`tmp`, subinium/terminal-markdown-preview) | `tmp README.md` and done. Explicit Ghostty TUI row, live reload on by default, pure-Rust Mermaid. But brand-new (1 star, 5 commits, Apr 2026), `cargo install` only, single file, no browser.                                                                                                                                                                                                                 |
| 3. Niche                | **bmd** (manji-0/bmd)                                | Vim-style single-file viewer, auto-reload on save, Ghostty-listed Mermaid via `merman`. 0 stars, `cargo install` only, no Homebrew. Try only if you dislike the top two.                                                                                                                                                                                                                                      |
| Rejected                | **liham**                                            | Nice split source/preview + file browser + `bunx` (fits this machine), but Mermaid is **colored ASCII art only** — fails the pixel-perfect requirement.                                                                                                                                                                                                                                                       |
| Rejected                | **glow**                                             | The default TUI markdown reader, but ` ```mermaid ` renders as plain code. ASCII support is an unmerged PR (#904) / fork behaviour, not upstream. Fails the core requirement.                                                                                                                                                                                                                                 |
| Neovim                  | only via image stack                                 | ASCII path (`render-markdown.nvim` + `render-markdown-mermaid.nvim`) fails pixel-perfect. Pixel-perfect path (`image.nvim` + `diagram.nvim` / `nvim-beautiful-mermaid` / `nvim-inline-markdown`) works but needs Neovim + treesitter + ImageMagick + a renderer (mmdc/Bun/resvg) and Kitty-backend tuning. Overkill for a read-only preview pane; worth it only if you are moving editing into Neovim anyway. |

Suggested path: `brew install markdown-reader`, run the §7 smoke test in a
herdr split. If the repo-browser chrome feels heavy, try `tmdp` for a
minimal single-file pane. Skip Neovim for this use case (detail in §5).

## 2. Why pixel-perfect in a herdr pane is feasible

- Ghostty implements the Kitty graphics protocol, and all three recommended
  Rust tools list Ghostty explicitly as a pixel-perfect target (tmdp README
  table; markdown-reader "Kitty, Ghostty, WezTerm, and Konsole get the best
  quality via the Kitty graphics protocol"; bmd requirements list Ghostty).
- herdr embeds `libghostty-vt` and virtualizes Kitty image IDs/placements
  per pane for the host terminal, so in-pane images are a designed-for path,
  not a hack.
- One hard rule from markdown-reader's README: **do not run tmux inside the
  preview pane.** When `$TMUX` is set it disables graphics unconditionally
  (tmux strips image sequences without passthrough config). herdr itself is
  the multiplexer here; no nested tmux.

## 3. Standalone TUI candidates

All three pixel-perfect options share the same pure-Rust Mermaid pipeline
(`mermaid-rs-renderer` → SVG → `resvg` → PNG → Kitty graphics), so no
Node.js or Chromium is needed. Fidelity ceiling is whatever
`mermaid-rs-renderer 0.2.x` supports (flowcharts, sequence, state, class,
ER, Gantt, pie and more; complex layouts can have quirks). The Node-based
`mmdc` renderer (Neovim path) has higher fidelity but drags in a browser
engine.

### 3.1 markdown-reader — recommended

- Repo: <https://github.com/leboiko/markdown-reader> (72 stars, 390 commits,
  MIT). Crate `markdown-tui-explorer`, binary `markdown-reader`.
- Install (no Rust toolchain; prebuilt macOS ARM64 tarball + Homebrew):
  `brew tap leboiko/tap && brew trust leboiko/tap && brew install markdown-reader`, or
  `cargo install markdown-tui-explorer`.
- Usage: `markdown-reader` (cwd), `markdown-reader ~/docs`,
  `cat README.md | markdown-reader`.
- Mermaid: inline real images (Kitty/Sixel/iTerm2, halfblock fallback),
  background-thread render with `rendering…` placeholder, per-document cache.
  18 diagram types in the text fallback crate. Scrolling a diagram partly off
  screen shows a `scroll to view diagram` placeholder rather than a squashed
  image.
- Watch: tree and open tabs reload on disk change, scroll preserved — the
  agent-rewrites-file case.
- File chooser (the requested plus): file tree (`.gitignore`-aware,
  git-status colours), up to 32 tabs with picker, global content search with
  smartcase, outline navigator (`o`), session restore per project, HTML
  export and `--check-links` CLI modes.
- Extras: LaTeX→Unicode math (opt-in typeset math images), 8 themes, wide
  tables with fullscreen modal, hybrid live-preview editing (`i` reveals raw
  source of the block under the cursor, `I` for fullscreen edit).
- Risks: larger surface than a single-file viewer; Mermaid quirks inherit
  from `mermaid-rs-renderer`; macOS Gatekeeper warning on first run of the
  unsigned binary (right-click → Open once).

### 3.2 tmdp (`tmp`) — simplest single-file

- Repo: <https://github.com/subinium/terminal-markdown-preview> (1 star,
  5 commits, MIT, published Apr 2026). Crate `tmdp`.
- Install: `cargo install tmdp` — **only** install path found; no Homebrew
  tap, no release binaries. This machine has no Cargo today, so this is the
  highest-friction install of the shortlist.
- Usage: `tmp README.md`. Auto-detects terminal; `--no-watch` to disable
  reload, `--tui` / `--cat` to force a mode.
- Modes: Ghostty → TUI with Kitty images + interactive scroll; iTerm2/Warp
  → cat mode with OSC 1337 images + native scrollback.
- Mermaid: parallel-thread render, source-hash cache, zlib-compressed Kitty
  frames. 15 tree-sitter languages for code highlighting; LaTeX→Unicode math
  approximation.
- Gaps vs markdown-reader: single file only (no tree/tabs/search), smaller
  language set, youngest codebase, unknown maintenance cadence.
- Use when: you want the smallest possible preview pane and accept
  `cargo install` (or `cargo install` via a Rust toolchain you set up once).

### 3.3 bmd — vim-style single-file

- Repo: <https://github.com/manji-0/bmd> (0 stars, 99 commits, Apache-2.0).
- Install: `cargo install bmd` (devbox-based source build otherwise). No
  Homebrew. Same Cargo-friction caveat as tmdp.
- Usage: `bmd README.md`, `bmd < file.md`, pipes supported. File paths
  reload automatically on save with scroll preserved.
- Mermaid: pure-Rust `merman` crate, inline via detected graphics protocol
  (Kitty/iTerm2/Sixel, halfblock fallback); image drawing pauses while
  scrolling and resumes 100 ms after. Relative image paths resolve against
  the input file's directory.
- Navigation: vim keys (`j/k/d/u/g/G`, `[`/`]` headings, `t` outline
  sidebar, `/` search, marks, yank incl. link/heading/code-block copy),
  clickable checkboxes (session-only), anchor + `./other.md` link stack for
  moving between files, floating zoomable diagram preview.
- Gaps: single file at a time (link-following only), no repo tree or global
  search, smallest community of the three.
- Use when: you live in vim keys and want outline + search + link-following
  without a repo browser.

### 3.4 Rejected: liham (ASCII Mermaid) and glow (no Mermaid)

- **liham** (<https://github.com/MrNiceRicee/liham>, MIT, Bun-native):
  split source/preview (`l`), TOC, vim search, file browser with fuzzy
  filter + watching, Kitty images for media — but Mermaid is explicitly
  "diagrams rendered as colored ASCII art". Fails pixel-perfect. Reconsider
  only if the requirement relaxes; its `bunx @mrnicericee/liham README.md`
  trial is the cheapest of any tool here (Bun is already installed).
- **glow** (<https://github.com/charmbracelet/glow>): best-known TUI reader
  with repo discovery and pager, but upstream renders ` ```mermaid ` as plain
  code (issues #342, discussion #839). ASCII preprocessing exists only as
  PR #904 / forks / wrapper scripts. Even if merged it would be ASCII, not
  pixel-perfect. Out.

## 4. Herdr recipe (Ghostty)

Layout: one workspace tab, two panes — agent left, preview right.

```
# in herdr, inside the workspace tab:
<prefix>+v            # split right (default prefix is ctrl+b)
# left pane:  opencode / claude / codex ...
# right pane: markdown-reader docs
<prefix>+z            # zoom preview pane when a diagram needs full width
<prefix>+h/j/k/l      # move between panes (or click to focus)
```

Notes:

- Run the preview from the repo root (`markdown-reader docs` or
  `markdown-reader .`) so the tree covers every file the agent may rewrite.
  Single-file tools need a restart or refocus to change files; the tree does
  not.
- Keep the preview pane reasonably wide. All three renderers degrade on
  narrow widths (truncated tables, `scroll to view diagram` placeholders).
- Mouse works out of the box in herdr: click to focus, drag borders to
  resize, wheel to scroll the preview.
- If images ever stop rendering, check (in order): pane width, nested
  `tmux`/`$TMUX` in the preview pane, then `--info`-style capability flags
  (`liham --info` exists; the Rust tools query at startup).
- Ghostty-side: no special config is needed for Kitty graphics; keep image
  duties inside herdr panes rather than Ghostty-native splits so the layout
  survives detach/reconnect.

## 5. Neovim investigation

Neovim splits into three tiers. Only the middle tier meets the
pixel-perfect-in-terminal bar, and it is the most expensive option on this
machine (Neovim is not installed; neither is Cargo).

### 5.1 Inline text rendering — simple, but ASCII Mermaid only

- `render-markdown.nvim` (MeanderingProgrammer): renders headings, code,
  tables, checkboxes inline via extmarks/conceal; `:RenderMarkdown preview`
  shows a rendered buffer to the side. No Mermaid of its own.
- `render-markdown-mermaid.nvim` (cavanaug) adds Mermaid by shelling out to
  `bm` (`beautiful-mermaid-cli`, preferred) or `mermaid-ascii` (fallback).
  Output is Unicode/ASCII box-drawing above/below (or in place of) the
  fence — **not** pixel-perfect images. Install: `npm i -g
beautiful-mermaid-cli` (or `brew install okooo5km/tap/bm`), plus
  treesitter `markdown`/`markdown_inline` parsers, `:checkhealth
render-markdown-mermaid` to verify.
- `markview.nvim` (OXY2DEV) is the same tier: excellent in-buffer markdown /
  LaTeX / Typst styling and split view, but no Mermaid image rendering.
- Fit: fine for prose + code, fails the stated Mermaid requirement.

### 5.2 Inline image rendering — pixel-perfect, but heavy

- Stack: `image.nvim` (3rd, Kitty backend) + one of `diagram.nvim`,
  `nvim-beautiful-mermaid`, or `nvim-inline-markdown`.
- `diagram.nvim` shells to `mmdc` (mermaid-cli) for mermaid/plantuml/d2/
  gnuplot; needs Kitty or Überzug++ plus ImageMagick. Highest Mermaid
  fidelity (real mermaid.js), highest install cost (Node + `mmdc`, which
  pulls a headless browser).
- `nvim-beautiful-mermaid` renders via Bun + `beautiful-mermaid` and
  rasterizes with resvg/rsvg/ImageMagick; auto-detects Ghostty/Kitty/WezTerm
  for inline SVG via image.nvim, ASCII elsewhere. Bun is already on this
  machine, which helps, but image.nvim + rasterizer + treesitter + config
  remains.
- `nvim-inline-markdown` renders ` ```mermaid ` to PNG via `mmdc` (cached by
  content hash) and shows it below the source via image.nvim; needs
  ImageMagick and Kitty-graphics terminal.
- Caveats: image.nvim's own README still marks Ghostty support "SUBJECT TO
  CHANGE"; image layout inside herdr's tiled panes needs real-world
  checking (extmark virtual padding vs pane width); tmux-inside-herdr needs
  passthrough config.
- Fit: the only Neovim path that satisfies pixel-perfect, at the cost of a
  full Neovim setup for what is currently a read-only use case.

### 5.3 Browser preview — disqualified by the TUI constraint

`markdown-preview.nvim` (Node), `peek.nvim` (Deno), `md-view.nvim` (zero-dep,
CDN mermaid — the nicest of the three), `remark-preview.nvim` (Kroki),
`nvim-markview` (SSE server) all render Mermaid beautifully — in a browser
tab. That breaks requirement 1 (stay in the herdr split). Listed here only
so the comparison is complete; do not pick these for this workflow.

### Learning-curve call

- Standalone TUI: install one binary, learn ~10 keys (`j/k`, search, quit).
  Minutes.
- Neovim text tier: install Neovim + plugin manager + treesitter + one
  plugin block; learn modal basics. Hours to days for a non-vimmer.
- Neovim image tier: everything above plus image.nvim backend tuning,
  ImageMagick, and a Mermaid renderer toolchain. Days, plus ongoing config.
- Recommendation stands: unless editing is moving into Neovim, the preview
  pane does not justify the curve. (If light editing without Neovim appeals,
  markdown-reader's `i` hybrid-edit mode covers it with zero new editor to
  learn.)

## 6. Local toolchain note (2026-09-10)

- Present: Homebrew 6.0.22, Node, Bun.
- Absent: `cargo`, `nvim`.
- Effect: `brew install markdown-reader` and `bunx …/liham` are one-liners
  today; `tmdp`/`bmd` need a Rust toolchain first (`brew install rustup`
  or rustup.rs, then `cargo install …`); every Neovim path starts with
  `brew install neovim` plus plugin/config work.

## 7. Smoke test before committing (~15 min)

````bash
# 1. install the favourite
brew tap leboiko/tap && brew trust leboiko/tap && brew install markdown-reader
# (bare `brew install markdown-reader` fails: the formula is in the author's
# tap, not Homebrew core, and new Homebrew requires an explicit `brew trust`)

# 2. fixture with both diagram families
cat > /tmp/mdpreview-test.md <<'EOF'
# Preview test

```mermaid
flowchart TD
  A[Agent] --> B{Preview}
  B -- watch --> C[Re-render]
````

```mermaid
sequenceDiagram
  participant U as You
  participant P as Preview
  U->>P: save file
  P-->>U: updated diagram
```

EOF

# 3. in herdr: split right, run `markdown-reader /tmp` (or the repo docs dir)

# 4. check: formatted text, two pixel images, edit+save re-renders in place

# 5. negative controls: narrow the pane (placeholder behaviour?), then

# `tmp /tmp/mdpreview-test.md` and `bmd /tmp/mdpreview-test.md` for feel

```

Promote to done when one tool renders both diagrams inline in a herdr pane
and re-renders on save. If none do, capture the failure (screenshot +
`$TERM`, Ghostty version, herdr version) and fall back to `liham --info`
capability output before reopening the search.
```
