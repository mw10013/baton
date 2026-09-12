# Plannotator: visual Markdown and code review for coding agents

Research into the tool remembered as "Planetator": what it is, how it integrates with
Claude Code and OpenCode, whether it belongs in user or project configuration, and a
recommended manual-first workflow for iterating on Markdown documents and reviewing code.

**Status: researched and installed 2026-09-12.** The project is
[backnotprop/plannotator](https://github.com/backnotprop/plannotator), spelled
**Plannotator**. At research time it has 8,636 GitHub stars, 646 forks, dual MIT / Apache
2.0 licensing, and an active latest release, `v0.27.14` (published 2026-09-11). It was
created in December 2025, so it is popular and actively developed but still young.

## 1. Verdict

**Try it, installed globally for this user, but do not add it to Baton.** More precisely:

1. Use Plannotator's `--minimal` installer to install only the verified `plannotator`
   executable under `~/.local/bin`.
2. Use Vercel's independent [`skills`](https://github.com/vercel-labs/skills) CLI to install
   only `plannotator-annotate`, `plannotator-last`, and `plannotator-review` globally for
   Claude Code and OpenCode.
3. **Do not install the Claude Code marketplace plugin.** It supplies automatic plan-mode
   interception, which this workflow does not use.
4. **Do not install the OpenCode package plugin or its OpenCode-specific command files.**
   OpenCode V2 loads the globally installed skills and exposes them as slash entries.
5. Keep every skill explicitly user-invoked. Nothing should open until a
   `/plannotator-*` skill is deliberately run.
6. Always install the latest binary and latest skill contents. Neither auto-updates; rerun
   both installation commands together whenever updating.

"Global" here does **not** mean an npm global install and does not mean committing config
to every product. It means a user-level binary plus user-level skills managed by a general
skill installer. That makes the tool available in Baton and every other checkout while
keeping product repositories free of personal workflow policy and Plannotator package code.

Project-local installation would be appropriate only if the team decided that every
contributor should use Plannotator, wanted one repo to use different workflow options, or
needed a reproducible pinned integration checked into the repository. None of those is a
current requirement.

## 2. What it is

Plannotator is a local, browser-based review surface that sits between a person and a coding
agent. It is not itself the coding agent and it is not primarily an AI reviewer. It turns
plans, documents, and diffs into a visual review UI, then returns human annotations to the
active agent as structured feedback.

The `plannotator` executable is an ordinary user-level CLI on `PATH`, so any terminal or agent
that can launch a foreground process can call it. `plannotator annotate` and
`plannotator review` write their result to stdout. A host skill or command is only a small
instruction wrapper that launches the binary, waits, and tells the agent how to interpret
that stdout; it is not required to render the UI. `plannotator last` additionally knows how
to discover recent messages from the supported agent hosts, so that subcommand is not generic
to an unknown CLI without a supported session format.

Its main workflows are, in order of relevance here:

- **Document review:** open a Markdown/text/HTML file, a folder, or a URL; annotate rendered
  content; send the feedback to the agent. A folder gets a file browser. HTML can be rendered
  as an artifact rather than converted to Markdown.
- **Code review:** open uncommitted changes or a GitHub PR / GitLab MR in a PR-style unified
  or side-by-side diff. Add line comments and suggestions, then send them to the current
  agent. The local viewer can also stage and unstage files, so it is not necessarily
  read-only.
- **Last-message review:** visually annotate the active agent's most recent answer rather
  than explaining revisions in another terminal prompt.
- **Plan review:** when a supported agent submits or exits a formal plan, Plannotator can
  automatically open the plan and gate implementation. This is a separate optional workflow
  and is not needed when the human and agent iterate on an ordinary Markdown file.

Optional features include asking an AI about selected review context, launching review
agents, sharing a review, saving plans to Obsidian or Bear, and an integrated agent terminal.
Those are additions, not prerequisites for the core human-feedback loop.

This is what the project means by a "plugin": some hosts can load integration code that
registers commands, exposes a tool, or intercepts plan completion. A plugin is distinct from
the standalone binary, an Agent Skill, and a native Markdown slash-command file. Both hosts
can use the manual workflows without loading Plannotator plugin code.

| Layer              | What it is                                                           | Does it appear after `/`?                             |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| CLI binary         | `~/.local/bin/plannotator`; starts the server/UI and returns stdout  | No; something invokes it                              |
| Claude Code skill  | Generic instructions installed for Claude Code by Vercel's CLI       | Yes; Claude exposes installed user skills as commands |
| OpenCode skill     | Portable instructions the model can load and follow                  | Yes by default in V2                                  |
| OpenCode command   | An optional Markdown prompt template in OpenCode's command directory | Yes; omitted in the skills-only setup                 |
| OpenCode plugin    | Executable TypeScript integration loaded into the OpenCode server    | Can register/intercept commands; unnecessary here     |
| Claude plan plugin | Marketplace hook for `ExitPlanMode`                                  | Not relevant to the three manual commands             |

## 3. How the two host integrations differ

### Claude Code

Vercel's `skills` CLI installs the selected generic skills globally for Claude Code, normally
as links under `~/.claude/skills` to one canonical managed copy:

```text
/plannotator-annotate <file|folder|url>
/plannotator-last
/plannotator-review [PR URL]
```

These skills tell Claude to run the local CLI in the foreground, wait for the browser review,
and act on returned annotations in the same conversation. Their metadata has
`disable-model-invocation: true`, and the user invokes them deliberately.

The separate Claude marketplace plugin contributes automatic plan review through a
`PermissionRequest` hook matching `ExitPlanMode`. It does not supply the three manual
workflows and is unnecessary here. Omitting it means Plannotator adds no Claude plan hook.

### OpenCode V2

Vercel's CLI installs the canonical generic skills under `~/.agents/skills`, which OpenCode
V2 documents as a global compatibility source. It links Claude Code to those same copies.
OpenCode makes skills slash-visible by default, so the three skill IDs provide the desired
entry points:

```text
/plannotator-annotate <file|folder|url>
/plannotator-last
/plannotator-review [PR URL]
```

When invoked, OpenCode loads the skill's instructions, the model runs `plannotator` in the
foreground, and returned stdout is handled in the same conversation. No OpenCode-specific
command file is required.

Because Plannotator's installer runs in `--minimal` mode, it writes no OpenCode command files
and touches no plugin cache. This is the simplest mental model: one CLI plus three skills
managed by a host-neutral skill tool.

The optional `@plannotator/opencode` package can register direct executable commands that
avoid routing the launcher through the model. It also supplies plan-agent tooling when
configured for that workflow. Neither benefit is necessary here. Avoiding it removes an npm
package, its postinstall behavior, its embedded server, V2 beta API compatibility, a separate
version pin, and migration concern when the `opencode2` preview becomes the normal `opencode`
release.

## 4. Recommended installation on this Mac

Current local state on 2026-09-12:

| Component     | Detected version / state                              |
| ------------- | ----------------------------------------------------- |
| macOS         | 14.7.1, Apple silicon (`arm64`)                       |
| Claude Code   | `2.1.269`; three skills installed, no plugin          |
| OpenCode V2   | `v0.0.0-next-17403`; three skills, no commands/plugin |
| OpenCode V1   | `1.18.25` (not the target for this setup)             |
| Bun           | `1.3.1`                                               |
| Plannotator   | `0.27.14`; minimal binary-only install                |
| global config | `~/.config/opencode/opencode.jsonc` already exists    |
| Baton config  | `.opencode/opencode.jsonc` has MCP settings only      |

### 4.1 Install only the user-level CLI

Install the latest release in binary-only mode:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

Why this form:

- The executable goes to `~/.local/bin/plannotator`, which is already the intended user-level
  location.
- The installer resolves the latest GitHub release each time and verifies the downloaded
  binary against its published SHA-256 checksum.
- `--minimal` is the key boundary. It installs only `~/.local/bin/plannotator`; it installs no
  skills, hooks, slash-command files, plugins, `sem` sidecar, CallDiff runtime, integrated
  agent terminal, or per-agent configuration.
- The binary does **not** auto-update. Plannotator UI surfaces check GitHub for a newer release
  and may notify, but they do not replace the executable. Rerun the minimal installer to
  update it.

Verify the binary before installing any skills:

```bash
plannotator --version
plannotator --help
plannotator annotate docs/plannotator-research.md
```

The last command is a standalone smoke test. Close it or submit feedback; direct CLI feedback
is printed to stdout because no agent session owns it. Plain `annotate` has no approval button.

### 4.2 Install three skills with Vercel's CLI

The npm package is `skills` from [vercel-labs/skills](https://github.com/vercel-labs/skills)
(MIT). The following source and discovery path was validated on 2026-09-12 and finds all four
core skills under `apps/skills/core`.

Install only the three requested action skills globally for both hosts:

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

`DO_NOT_TRACK=1` disables the Skills CLI's anonymous installation telemetry. The default
symlink installation is intentional: `skills` keeps one canonical copy and links each
agent-specific global skill directory to it. Do not pass `--copy` unless a host has a concrete
symlink problem.

The omitted fourth skill, `plannotator`, is a broad CLI reference covering plan review,
archives, Guided Reviews, sharing, and less-common flags. The three focused skills are
self-contained for document, last-message, and code review. Add the reference later only if
those other CLI surfaces become useful.

#### Other available Plannotator skills

Plannotator currently contains these additional skills:

| Skill                          | Set   | Purpose                                                                      | Recommendation here |
| ------------------------------ | ----- | ---------------------------------------------------------------------------- | ------------------- |
| `plannotator`                  | Core  | Broad CLI reference: archives, sessions, guides, sharing, and uncommon flags | Skip initially      |
| `plannotator-compound`         | Extra | Analyze denied-plan history and produce a feedback-pattern dashboard         | Skip; plan-centric  |
| `plannotator-setup-goal`       | Extra | Interview, fact-sheet, and plan workflow for a structured goal package       | Skip initially      |
| `plannotator-visual-explainer` | Extra | Generate and annotate visual HTML plans, PR explainers, diagrams, and decks  | Consider later      |

`plannotator-visual-explainer` is the only likely near-term addition: it can produce visual
architecture explanations and PR walkthroughs, not just formal plans. Its general visual path
also depends on `nicobailon/visual-explainer`, so it is a larger workflow than the three thin
launchers. Trial the core review loop first.

This use of `skills` for Plannotator's **core** skills works and was validated with `--list`,
but Plannotator's own guide currently recommends its standard installer for core skills and
mentions `npx skills` primarily for extras. The difference is support/lifecycle policy, not a
technical incompatibility.

Tradeoffs of this split installation:

- **Simpler ownership:** Plannotator owns one binary; the general Skills CLI owns three
  portable skills. No host-specific integration code or configuration is involved.
- **One canonical skill source:** Vercel's default symlink mode avoids independent Claude and
  OpenCode copies drifting from one another.
- **Generic Claude behavior:** Plannotator's full installer has Claude-specific skill variants
  that use Claude's inline shell injection and `allowed-tools`. Installing `apps/skills/core`
  through Vercel gives Claude the generic portable variant instead. It still works, but the
  model performs the shell call using normal Claude permissions rather than the optimized
  Claude-only launcher.
- **Separate updates:** upgrading the binary does not upgrade the skills. Rerun both latest
  installation commands together.
- **No optional sidecars:** `--minimal` omits `sem`, CallDiff, and the integrated agent
  terminal. Basic document and code review still work; optional semantic/call-flow review
  enhancements are absent.
- **Slightly outside the documented happy path:** Plannotator officially directs core-skill
  users to its full installer. If a future core skill layout changes, the direct path can fail
  clearly and the installation command will need updating.

**Recommendation:** use this split installation. Its limitations are acceptable for explicit
document, last-message, and basic code review, and it matches the existing preference to
manage general agent skills consistently through Vercel's tool.

### 4.3 Verify both hosts

Restart Claude Code and OpenCode, then type `/plannotator`. Both should show:

```text
/plannotator-annotate
/plannotator-last
/plannotator-review
```

Use Vercel's inventory command to confirm the global target links:

```bash
DO_NOT_TRACK=1 npx skills list \
  --global \
  --agent claude-code \
  --agent opencode
```

Do **not** run `/plugin marketplace add backnotprop/plannotator` or install
`plannotator@plannotator`. That marketplace plugin is the `ExitPlanMode` hook. It can be added
later if formal Claude plan mode becomes part of the workflow, but it provides no benefit for
manual document review today.

There is also no Plannotator entry to add to
`~/.config/opencode/opencode.jsonc` or Baton's `.opencode/opencode.jsonc`, no files under
`~/.config/opencode/commands`, and `opencode2 plugin list` should continue to show no
Plannotator package.

"Discovered" and "invoked" are different here. Claude Code and OpenCode discover the files so
they can display `/plannotator-*`; you then invoke one explicitly. Claude honors the generic
skills' `disable-model-invocation: true`. The OpenCode skill remains available to its model as
a relevant skill because the generic file does not carry OpenCode's host-specific
`metadata.opencode/autoinvoke: false`. That does not require automatic use and does not change
the recommended slash workflow. Add host-specific metadata only if a strict prohibition on
model-selected loading becomes a real requirement.

Invoking a skill still uses the model to execute its instructions:

```text
Shared skill only:
  user runs /plannotator-annotate file.md
  -> OpenCode loads the plannotator-annotate skill
  -> model calls shell(plannotator annotate file.md)
  -> browser review returns feedback
  -> model processes feedback

With optional plugin command interception:
  user runs /plannotator-annotate file.md
  -> plugin code directly launches plannotator annotate file.md
  -> browser review returns feedback into the session
  -> model processes feedback
```

That is how the plugin can save one model API round-trip: it replaces the model's initial
decision to call the shell. It does not remove the later model work needed to understand and
apply annotations. Saving one launcher call is not enough to justify a beta host plugin for
this manual, low-frequency workflow.

## 5. Rough day-to-day use

### Iterate on a Markdown document

From either host:

```text
/plannotator-annotate docs/plannotator-research.md
/plannotator-annotate docs/
/plannotator-last
```

The first command reviews one rendered document, the second opens the docs folder with a file
browser, and the third reviews the agent's last reply. Submitting feedback returns it to the
same agent.

A normal document iteration is deliberately manual:

1. Ask the agent to create or revise `docs/example.md` as usual.
2. Run `/plannotator-annotate docs/example.md`.
3. Select text in the browser and add comments, replacements, insertions, or deletions.
4. Choose **Send Feedback**. The command returns the annotations to the current agent, which
   applies them to the Markdown file.
5. Run `/plannotator-annotate docs/example.md` again when ready for another pass.

Plain `/plannotator-annotate` is a feedback session; it has no approval button. If a particular
document needs an explicit acceptance gate, ask the agent to "open `docs/example.md` in
Plannotator for review and approval." The generic skill then uses
`plannotator annotate docs/example.md --gate --json`. The direct CLI equivalent is:

```bash
plannotator annotate docs/example.md --gate --json
```

The same skill body handles this in both hosts. For the normal iterative workflow, **Send
Feedback** plus closing the final review is sufficient.

### Review the last agent message

Run `/plannotator-last` immediately after the answer to review. Do not send a preamble first:
the command intentionally targets the latest rendered assistant message. When the browser
closes, the returned annotations become input to the agent's next response.

### Review code

```text
/plannotator-review
/plannotator-review https://github.com/owner/repo/pull/123
```

The first opens the current working-copy diff. Add line comments or suggestions, then send
them back to the active agent to fix. The second loads a GitHub PR through authenticated Git
and GitHub CLI context. Review the final `git diff` / `git diff --cached` afterward because
the viewer can stage or unstage local files.

The standalone equivalents are useful outside an agent:

```bash
plannotator annotate docs/
plannotator review
plannotator sessions
plannotator archive
```

## 6. Privacy, security, and operational caveats

- Plans, local diffs, annotations, drafts, history, and configuration stay local by default,
  normally under `~/.plannotator`. The UI is served from a temporary local process and opened
  in the browser.
- Every plan, annotate, archive, sharing, and code-review UI load checks GitHub for a newer
  release. It sends no reviewed content, but GitHub receives an ordinary request; the project
  currently documents no opt-out for this check.
- URL annotation fetches the URL, using Jina Reader by default for public pages. Set
  `PLANNOTATOR_JINA=0` to disable Jina and fetch directly.
- Ask AI and review-agent features send relevant selected/repository/diff context to the
  configured model provider. Leave them unused, or set `PLANNOTATOR_AI=disabled`, when local
  review only is required.
- Sharing is not the same as local-only use. Small shares put compressed but unencrypted
  content in the URL fragment; large/raw-HTML shares upload client-encrypted ciphertext whose
  key remains in the fragment. Anyone with the full link can read it. Set
  `PLANNOTATOR_SHARE=disabled` to remove accidental sharing from the trial.
- GitHub/GitLab PR review necessarily contacts the host and uses authenticated CLIs/remotes.
  Local Git review may run `git ls-remote` against `origin` to identify the default branch and
  stale baseline even though it does not send the diff.
- This setup uses no Plannotator npm package and no OpenCode plugin API. Its OpenCode surface
  is portable Markdown skills in OpenCode's documented global skill directory. That sharply
  reduces compatibility risk during the OpenCode V2 cutover.
- Vercel's `skills` CLI clones the public Plannotator repository and normally reports
  anonymous install telemetry. `DO_NOT_TRACK=1` disables that telemetry.
- Manual foreground skill runs hold the agent turn open while the browser review is active.
  Close or submit abandoned reviews rather than leaving sessions blocked.

Persist provenance verification for future installer runs in `~/.plannotator/config.json`:

```json
{
  "verifyAttestation": true
}
```

For a local-only initial policy, export these in the shell environment that starts the agents:

```bash
export PLANNOTATOR_AI=disabled
export PLANNOTATOR_SHARE=disabled
export PLANNOTATOR_JINA=0
```

The attestation setting persists safer upgrades. The environment flags make AI, sharing, and
Jina URL fetching explicit opt-ins while learning the tool.

## 7. Updates, rollback, and removal

Neither the binary nor the skills auto-update. Always update both together by rerunning the
same two latest-version commands:

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

The first command resolves and installs Plannotator's latest GitHub release. The second uses
the current Vercel Skills CLI and the latest default branch of the Plannotator repository,
then refreshes the three selected global skills. There is no Claude or OpenCode plugin to
update separately.

When OpenCode V2 becomes the normal `opencode` command, verify that `/plannotator-*` still
appears and completes one smoke review. The files live in OpenCode's documented
`~/.agents/skills` compatibility location and use no plugin API, so the executable rename
itself should require no Plannotator change.

To remove everything, preview first:

```bash
plannotator uninstall --dry-run
plannotator uninstall
```

Because the skills were installed independently, remove them with their manager:

```bash
DO_NOT_TRACK=1 npx skills remove \
  --global \
  --agent claude-code \
  --agent opencode \
  plannotator-annotate \
  plannotator-last \
  plannotator-review \
  --yes
```

The Plannotator uninstaller does not own Vercel-managed skill links. Its default mode removes
the binary and recognized Plannotator-managed components but retains local plans, history,
drafts, and settings. `plannotator uninstall --purge` also removes recognized local data and
is irreversible.

## 8. Trial acceptance criteria

Use it for a week before making the global integration permanent. The trial succeeds if:

1. `/plannotator-annotate docs/` is materially faster than reviewing long Markdown in the
   terminal.
2. Repeated `/plannotator-annotate <file>` rounds return clear feedback to both Claude Code
   and OpenCode without unexpectedly invoking plan mode.
3. `/plannotator-last` is more precise than writing a follow-up prompt for long agent answers.
4. `/plannotator-review` makes line-specific feedback easier without causing index/staging
   mistakes.
5. Browser context switching is worth the clearer review surface. Plannotator is browser
   based; if staying inside the existing herdr/Ghostty workflow matters more, the previously
   researched terminal Markdown viewer remains complementary rather than replaced.
6. Local/network behavior is acceptable with AI, sharing, and Jina disabled by default.

If only document annotation proves useful, keep this exact skills-only setup and simply ignore
the other skills. If the browser itself is the problem, uninstall Plannotator rather than
adding hooks or broader agent permissions.

## 9. Sources

- [Plannotator repository and README](https://github.com/backnotprop/plannotator)
- [Latest release](https://github.com/backnotprop/plannotator/releases/tag/v0.27.14)
- [Official installation guide](https://docs.plannotator.ai/open-source/start/installation)
- [Official quickstart](https://docs.plannotator.ai/open-source/start/quickstart)
- [Claude Code integration](https://docs.plannotator.ai/open-source/agents/claude-code)
- [OpenCode integration](https://docs.plannotator.ai/open-source/agents/opencode)
- [Plannotator skills and host-specific files](https://docs.plannotator.ai/open-source/start/skills)
- [`@plannotator/opencode` source and V2 notes](https://github.com/backnotprop/plannotator/tree/main/apps/opencode-plugin)
- [OpenCode V2 configuration locations and precedence](https://opencode.ai/v2/docs/config)
- [OpenCode V2 global and compatibility skills](https://opencode.ai/v2/docs/skills)
- [Vercel Skills CLI](https://github.com/vercel-labs/skills)

Repository/release metadata and local tool versions were checked directly on 2026-09-12.
