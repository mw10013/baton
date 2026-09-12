# Plannotator Setup

Plannotator is installed globally for manual document and code review in Claude Code and
OpenCode. This setup uses the standalone binary and three portable skills. It does not use
the Claude Code marketplace plugin, the OpenCode plugin, plan-mode hooks, or OpenCode command
files.

## Installed Components

- `~/.local/bin/plannotator`: standalone Plannotator binary
- `plannotator-annotate`: annotate a file, folder, or URL
- `plannotator-last`: annotate the latest assistant response
- `plannotator-review`: review the current worktree or a pull request

The skills are installed globally under `~/.agents/skills`. Claude Code links to those same
copies from `~/.claude/skills`.

## Install

Install the latest binary in minimal mode:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

`--minimal` installs the binary without plugins, hooks, commands, or optional integrations.

Install the latest versions of the three skills globally for Claude Code and OpenCode:

```bash
DO_NOT_TRACK=1 npx skills add backnotprop/plannotator/apps/skills/core \
  --global \
  --agent claude-code \
  --agent opencode \
  --skill plannotator-annotate \
  --skill plannotator-last \
  --skill plannotator-review \
  --yes
```

`DO_NOT_TRACK=1` disables telemetry from the Vercel Skills CLI.

## Use

### OpenCode V2

OpenCode discovers the installed skills, but the current OpenCode V2 preview does not show
them in its slash-command picker. Invoke a skill explicitly by name in a normal prompt:

```text
Use the plannotator-annotate skill on docs/example.md
```

```text
Use the plannotator-last skill.
```

```text
Use the plannotator-review skill.
```

For a folder, URL, or pull request, include the target in the prompt:

```text
Use the plannotator-annotate skill on docs/
Use the plannotator-annotate skill on https://example.com
Use the plannotator-review skill on https://github.com/owner/repo/pull/123
```

OpenCode loads the named skill, runs the Plannotator binary, waits for the browser session,
and processes the returned annotations in the same conversation.

### Claude Code

Claude Code exposes the installed skills as slash commands:

```text
/plannotator-annotate docs/example.md
/plannotator-last
/plannotator-review
```

## Update

Neither the binary nor the skills auto-updates. Update both together by rerunning the same
two installation commands:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal

DO_NOT_TRACK=1 npx skills add backnotprop/plannotator/apps/skills/core \
  --global \
  --agent claude-code \
  --agent opencode \
  --skill plannotator-annotate \
  --skill plannotator-last \
  --skill plannotator-review \
  --yes
```

Both commands resolve the latest available version when run. There are no version pins to
maintain and no plugins to update separately.

## Verify

```bash
plannotator --version

DO_NOT_TRACK=1 npx skills list \
  --global \
  --agent claude-code \
  --agent opencode
```

## Sources

- [Plannotator](https://github.com/backnotprop/plannotator)
- [Plannotator installation](https://docs.plannotator.ai/open-source/start/installation)
- [OpenCode V2 skills](https://opencode.ai/v2/docs/skills)
- [Vercel Skills CLI](https://github.com/vercel-labs/skills)
