# Hunk install: curl vs Homebrew, and why OpenCode couldn't find it

**Status: researched 2026-09-13** — curl install (`~/.hunk/bin/hunk`,
0.22.0) inspected live on this machine; Homebrew formula
(`hunk`, stable 0.22.0, Homebrew/homebrew-core `Formula/h/hunk.rb`)
read but not yet installed (`brew info hunk` → "Not installed").
Recommendation below is researched, not yet executed.

**Verdict:** install with `brew install hunk`. It puts a managed binary on
the system `PATH` (`/opt/homebrew/bin`), so interactive terminals _and_
headless consumers (OpenCode server) both find it with no dotfile edits.
Only use `curl -fsSL https://hunk.dev/install.sh | sh` if you need
`HUNK_INSTALL_DIR` customization or a version brew doesn't have yet.

## 1. What happened

`hunk --version` and `hunk skill path` worked in a terminal tab but failed
from OpenCode with `zsh:1: command not found: hunk`.

Root cause, verified on this box:

- `command -v hunk` (OpenCode's non-interactive shell) → not found;
  `~/.hunk/bin` absent from its `PATH`.
- `zsh -i -c 'command -v hunk'` (interactive) → `/Users/mw/.hunk/bin/hunk`.
- `~/.zshrc` line 36–37 holds the only `PATH` entry, added by the
  installer:
  `# Added by the Hunk installer (https://hunk.dev)` /
  `export PATH='/Users/mw/.hunk/bin':"$PATH"`.
- `~/.zshenv` is empty; `~/.zprofile` holds only `brew shellenv`.
- `~/.hunk/bin/hunk --version` → `0.22.0`;
  `~/.hunk/bin/hunk skill path` →
  `/Users/mw/.hunk/skills/hunk-review/SKILL.md`.

So the binary was fine; only its directory was missing from the
non-interactive `PATH`.

## 2. Why: interactive vs non-interactive (and login)

OpenCode's TUI is interactive with _you_, but when it runs a shell tool it
spawns a headless child (`zsh -c "..."`) with no prompt/tty, purely to
capture output. From `zsh`'s view that child is non-interactive (and
non-login). `zsh` startup order:

1. `.zshenv` — always (every invocation).
2. `.zprofile` / `.zlogin` — login shells only (new Terminal tab on macOS,
   SSH session).
3. `.zshrc` — interactive shells only (human typing at a prompt).

The split keeps script/tool children fast and machine-readable (no prompt
themes, completions, banners leaking into captured output). `PATH` a tool
needs belongs in layer 1; human comforts (`compinit`, `fpath`, prompts,
heavy `eval $(...)`) stay in layer 3.

The OpenCode background server compounds it: it's a long-lived daemon
holding the `PATH` from when it started. A `curl | sh` install today
updates `.zshrc` for _future_ terminal tabs, but the already-running
server never re-reads `.zshrc` — each tool child only re-reads `.zshenv`.

## 3. Install methods compared

| Method                          | Binary location                          | Skills                                                                  | PATH handling                                                                                        | Update / uninstall                                                                                     |
| ------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `curl .../install.sh \| sh`     | `~/.hunk/bin/hunk`                       | `~/.hunk/skills` (walk-up)                                              | Appends to `~/.zshrc` only (bash→`.bashrc`, fish→`config.fish`)                                      | `hunk update` (in place, touches no dotfiles); full removal = `rm -rf ~/.hunk` + delete `.zshrc` lines |
| `brew install hunk` (recommend) | `/opt/homebrew/bin/hunk` (Cellar + link) | Bundled via `libexec` (formula test asserts `hunk skill path` resolves) | None needed — `/opt/homebrew/bin` is already on system `PATH` via `/etc/paths.d`, visible to daemons | `brew upgrade hunk` / `brew uninstall hunk`; declarable in a `Brewfile`                                |
| `npm install -g hunkdiff`       | per-Node global `bin/`                   | bundled with package                                                    | Depends on the Node manager's `bin` being on `PATH` (nvm/mise per-version gotcha)                    | Same manager (`npm uninstall -g hunkdiff`); Windows path                                               |

Installer details (from `https://hunk.dev/install.sh`, read 2026-09-13):

- `zsh` → always patches `~/.zshrc`, never `.zshenv`/`.zprofile`.
- `add_path_line` is idempotent (greps for the exact line), so upgrades
  don't stack duplicates — but moving the line to `.zshenv` manually means
  the next `curl | sh` re-appends it to `.zshrc` (one copy in each file,
  harmless duplicate `PATH` entry).
- `--no-modify-path` / `HUNK_NO_MODIFY_PATH=1` leaves startup files alone;
  `HUNK_INSTALL_DIR` relocates (then `hunk update` can't auto-detect —
  re-run the installer with the same dir).
- Competing-install guard refuses when another `hunk` is on `PATH`
  unless `--force`; it canonicalizes symlinks, so a symlink to its own
  target doesn't count as a conflict.

## 4. Recommendation

Prefer Homebrew for the usual reasons: tracked install, clean
upgrade/uninstall, no per-shell `PATH` bookkeeping, works for daemons.

```sh
brew install hunk
command -v hunk            # /opt/homebrew/bin/hunk
hunk --version             # expect 0.22.0 (or newer)
hunk skill path            # expect .../SKILL.md under the Cellar/libexec
hunk update --check
```

Then remove the curl install so two `hunk`s never shadow each other
(`PATH` order would decide silently):

```sh
rm -rf ~/.hunk
# delete from ~/.zshrc:
#   # Added by the Hunk installer (https://hunk.dev)
#   export PATH='/Users/mw/.hunk/bin':"$PATH"
command -v hunk
grep -ri hunk ~/.zshrc ~/.zshenv ~/.zprofile
```

Restart open terminals (`exec zsh -l`) and `opencode2 service restart`
so the stale `PATH` falls out of the running server. If `hunk extension
install` was ever used, run `hunk extension list` first — those live
outside `~/.hunk`.

## 5. Alternatives considered (and rejected)

- **Move the line to `~/.zshenv`.** Works (`hunk update` doesn't touch
  dotfiles), but every future `curl | sh` re-adds it to `.zshrc` —
  manual re-deletion nobody will remember.
- **Symlink** (`ln -s ~/.hunk/bin/hunk /opt/homebrew/bin/hunk`). Works
  and survives in-place upgrades, but it's untracked state brew doesn't
  know about; uninstall/documentation burden stays manual. Preferable to
  `.zshenv` surgery, worse than letting brew own the link.
