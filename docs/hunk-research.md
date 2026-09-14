# Hunk research: install + agent review workflow

**Status: current as of 2026-09-14** — Hunk 0.22.0, installed via
Homebrew, `hunk update --check` reports up to date. Workflow sections
sourced from `https://hunk.dev/docs` and the bundled `hunk-review`
skill text.

## 1. Install

```sh
brew install hunk
command -v hunk            # /opt/homebrew/bin/hunk
hunk --version             # 0.22.0
hunk skill path            # .../libexec/skills/hunk-review/SKILL.md under the Cellar
```

Update and uninstall:

```sh
hunk update                # delegates to Homebrew for a brew install
hunk update --check        # check without installing
brew upgrade hunk / brew uninstall hunk
```

Why brew: one managed binary on the system `PATH`
(`/opt/homebrew/bin`), so interactive terminals and headless consumers
(OpenCode server, agent shells) all resolve it with no shell-dotfile
bookkeeping; clean upgrade/uninstall; declarable in a `Brewfile`. No
managed extensions installed (`hunk extension list` is empty).

## 2. Agent workflow: the handoff is a chat prompt, not a button

There is **no button or command in the Hunk TUI that pushes your
comments to the agent**. The handoff is always a prompt you type to the
agent in chat. Both directions below are pull-style over the local
loopback daemon — the human owns the TUI window, the agent drives it via
`hunk session *` from another shell and never launches `hunk diff`
itself.

### 2.1 Setup (every review)

You keep a review window open; the agent attaches to it:

```sh
hunk diff            # you, in your terminal; keep the window open
hunk diff --watch    # optional: auto-reload as the tree changes
```

Watch mode is optional. Without it, press `r` for a manual refresh, or
the agent can swap the session contents with `hunk session reload`.

Then tell the agent to load the skill (per-review prompt — no
persistent install in this repo):

```
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

Notes:

- The skill is generated per Hunk version and lives under the install,
  so `hunk skill path` must be re-resolved after upgrades — never
  hardcode the Cellar path.
- A web-readable copy of the same generated artifact exists at
  `https://hunk.dev/docs/hunk-review-skill.md`.
- Machine-readable docs index for tight budgets:
  `https://hunk.dev/llms.txt`, `llms-small.txt`, `llms-full.txt`;
  any docs page URL plus `.md` returns Markdown source.
- Second bundled skill, `hunk-extensions`, is for _building_ Hunk
  extensions — irrelevant to review workflow.

### 2.2 Direction A — agent narrates, you follow

You ask the agent to walk you through its changeset. Typical agent flow:

```sh
hunk session list                              # find live sessions
hunk session get --repo .                      # inspect path / repo / source
hunk session review --repo . --json            # file/hunk structure first (no patch)
hunk session review --repo . --include-patch --json   # raw diff text, only for files it must read
hunk session context --repo .                  # check your current focus when needed
hunk session navigate --repo . --file src/App.tsx --hunk 2        # move your viewport
hunk session comment add --repo . --file src/App.tsx --new-line 42 --summary "Check this boundary"
printf '%s\n' '{"comments":[...]}' | hunk session comment apply --repo . --stdin   # batch notes
hunk session highlight add --repo . --file src/App.tsx --new-line 42 --start 6 --end 19 --focus
```

Pacing: by default the agent works through the whole changeset in one
go — its `navigate` / `comment` / `highlight` commands execute
back-to-back, moving your viewport as they land, and it summarizes when
done. Nothing blocks or waits for you mid-tour; you follow at your own
pace afterwards, walking annotated hunks with `{` and `}`. If you want
it step-by-step instead, say so in the prompt ("walk me through one
file at a time and wait for my go-ahead before continuing").

Conventions from the skill: `review --json` first without `--include-patch`
to protect agent context; `comment apply` (one stdin batch) over many
`comment add` calls; `highlight --focus` to steer your eyes to the exact
expression while narrating, `highlight clear` before the next topic;
`--focus` on comments sparingly; don't comment every hunk — intent,
structure, risks, follow-ups.

### 2.3 Direction B — you review, agent addresses your notes

In the TUI you select a hunk and press `c` (or click the add-note
affordance) to leave a note. Human and agent notes are labeled by
source. Then you prompt the agent — e.g. "pull my Hunk notes and
address them" — and it runs:

```sh
hunk session comment list --repo . --type user --json   # YOUR notes (default list shows agent view)
hunk session navigate --repo . --next-comment           # walk annotated hunks (--prev-comment to go back)
hunk session comment add --repo . --reply-to user:123 --summary "Addressed in the latest revision"
```

Pacing: same model as Direction A — the agent pulls _all_ your notes in
the one `comment list` call and works through them in a single turn,
then summarizes. It does not stop between notes unless you ask it to
("address the first note, then stop and let me re-review"). After
fixing, it can `reload` the session (`hunk session reload --repo . --
diff`); note attention marks on changed files drop on reload, and you
re-walk with `{` / `}`.

What to know:

- `--type user` is the load-bearing flag: without `--type`, `comment list`
  preserves the legacy live-agent-comment view and your notes won't show.
  `--type all` shows both.
- Replies anchor via `--reply-to <note-id>` and inherit the parent's line;
  root agent notes need `--file` plus exactly one of `--old-line` /
  `--new-line`.
- `comment clear` is destructive and needs confirmation (`--yes`); clearing
  your notes requires `--include-user` (or `--all` for everything).
- Either side can navigate either side's notes (`--comment <id>`,
  `--next-comment` / `--prev-comment` need no `--file`).

### 2.4 Failure modes

- **"No active Hunk sessions" while Hunk is visibly running** — the agent
  sandbox blocks loopback. Retry with network/sandbox escalation, not by
  exposing the daemon remotely. `hunk daemon serve` exists for manual
  startup/debugging.
- **"Multiple active sessions match"** — pass `<session-id>` explicitly
  (from `session list`) instead of `--repo`.
- **Daemon build mismatch after upgrade** — old daemon keeps running while
  an old window holds it open; every `session` command fails naming both
  builds. Check `hunk daemon status`, then `hunk daemon restart` (ask
  first), and relaunch old-build windows.
- **"No diff file matches ..."** — the file isn't in the loaded review;
  check `context`, then `reload` if needed.
