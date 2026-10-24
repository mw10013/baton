# Friction in the 2026-10-24 production exploratory test: research

Status: research, 2026-10-24. Nothing built yet, except the two agent memories in #5, which now point at the agent Chrome CLI. The Cloudflare token side is in `docs/cloudflare-token-research.md`. The questions are at the end.

Recommendation: one committed procedure for an exploratory test on staging or production, with the helpers it needs, so the next run spends its time on the app and not on the tools. In order of payoff: the preflight (#1), a committed `cdt.sh` with `waitfor`, `appsnap`, `setv` and a fail-loud `uid` (#2 to #4), `vp run logs` (#6), then the browser rule in `AGENTS.md` (#5) and `browser agent --session` (#7).

Source: session `f3866e1e` main transcript (03:39–04:20 UTC, before fixes started) and the merchant subagent `a7db84107410af003` (03:44–04:19 UTC). The member side and the cross-side checks ran in the lead thread. The merchant side ran in the subagent.

Totals: the lead made 146 tool calls with 620 s of tool time. The merchant subagent made 169 calls with 1,259 s of tool time over 35 min of wall clock. The test took 41 min, and it produced three real bugs, all fixed the same day.

There was no repeatable procedure for this test. `verify-baton` covers only the dev store and the Playwright CLI, and it says "Never run `chrome-devtools start`". So both agents built their tooling during the run: `cdt.sh`, `acts.sh` and `tail.mjs` in the scratchpad. Most of the items below come from that.

## Ranked sticking points

### 1. The test ran against a production build 21 commits behind `main` (highest consequence)

- **What happened:** nothing checked what was live before the test started. At 04:28 the user noted that production had not been deployed. `git log origin/production..origin/main` then showed 21 commits, with `production` still at `b7828d7` from Oct 22.
- **Cost:** none of the findings were invalidated, because the lead checked that none of the 21 commits touched the affected code. But it led to roughly 20 min of release-procedure discussion (04:28–04:48): "Why do I push with a sha?", the token and Workers Builds question, the `cf builds` question, and a runbook rewrite.
- **Root cause:** no preflight step. The release runbook only covers checks after a promotion.
- **Fix:** give the exploratory-test procedure (see #2) a preflight:
  - Run `git fetch origin && git log --oneline origin/production..origin/main`.
  - Run `cf workers deployments list --script-name baton-website-production` (and the backend) to see what is live.
  - If `main` is ahead, ask the user whether to promote first, using the procedure in `docs/production-release-runbook.md` § Promote.
  - That runbook now has build status through `gh api …/check-runs`, added in this session as 7031dc6. So the procedure can point to it without restating it.

### 2. No committed driver for the chrome-devtools CLI, so its argument shapes were learned by trial (about 25 calls and 8–10 min across both agents, plus one near-false finding)

The errors, in order:

- **03:41:52 (lead):** `chrome-devtools click 1_8 $S >/dev/null 2>&1` left out the page id, and the redirect swallowed the error. The agent believed the clicks had happened.
- **03:41:57:** `evaluate_script` returned "Cannot read properties of null", a side effect of those dead clicks.
- **03:42:06:** reading a screenshot failed with "File does not exist". `take_screenshot --pageId 2` was the wrong form, because the page id is positional.
- **03:42:08–03:43:20:** 4 `--help` calls followed. The helper was then patched twice with `sed` (`navigate_page --pageId $PG` failed with "Unknown argument: 2"). That cost about 1.5 min.
- **03:50:41:** the lead found that `chrome-devtools fill` **appends** to a Polaris field that already has a value. The workflow Tag came out as "xs cross workflowbaton-production-smoke". The lead had to message the subagent through SendMessage, because the subagent had already produced a team named "QA Dupqa dup" and nearly reported it.
- **03:49:04–03:49:28 (subagent):** it tried `Meta+a`, `Control+a` and `type_text` before finding that only End, Shift+Home, Backspace clears a Polaris field over CDP. That was 4 calls.
- **Empty uid lookups (subagent, 6 times):** the `uid` helper returned an empty string, so `fil $(uid …) "value"` ran as `fill <page> "value"`. The errors were `Element uid "  QA Dup  " not found on page 3` and `Not enough non-option arguments: got 1, need at least 2`. This happened at 03:47:27, 03:58:50, 04:10:21, 04:13:39 and twice more, and cleanup (04:13–04:15) needed 3 tries.
- **The lead's `js` helper:** it returns output in a ` ```json ` fence. Parsing it with `tr -d` failed, so opening a second member tab took 3 calls (03:53:09–03:53:21).
- **Root cause:** the agent read `../notes/systems/chrome-devtools-cli-runbook.md`, which says "Every page tool takes a page id first", but it has no table of argument shapes. The CLI ships a `chrome-devtools-cli/SKILL.md` with exact examples, such as `click <pageId> <uid>` and `evaluate_script … --pageId 1`. Nobody read it, because its path includes an install id. Neither doc mentions the Polaris fill-append and select-all behavior.
- **Fixes:**
  - **Commit the helper.** Put it in `.claude/skills/verify-baton/cdt.sh`, or a new `explore-baton` skill (see #9).
    - Start from `cdt.sh` and `acts.sh`.
    - Make `uid` fail loudly (exit 1, printing the pattern) when nothing matches.
    - Make `setv` (click, End, Shift+Home, Backspace, fill) the only way to fill a field.
    - Add a `url` helper that strips the JSON fence.
    - Never send stderr to `/dev/null`.
  - **Add a "CLI facts" list to `../notes/systems/chrome-devtools-cli-runbook.md` § How the CLI runs.** It should state:
    - `take_snapshot`, `click`, `fill`, `press_key`, `navigate_page`, `take_screenshot`, `close_page` and `list_*` take the page id as a positional argument. `evaluate_script` takes `--pageId`.
    - `evaluate_script` prints fenced JSON.
    - `new_page` prints every page.
    - `fill` appends to a Polaris text field that already has a value.
    - Meta+A and Control+A do not select in Polaris fields. End, Shift+Home, Backspace does.
  - **Make `vp run browser agent` print the path of the shipped CLI skill.** It is found with `ls -d ~/.local/share/vite-plus/packages/chrome-devtools-mcp/*/lib/node_modules/chrome-devtools-mcp`, and the change goes in `scripts/browser.ts`, in `agent`'s final `Console.log`.

### 3. Fixed sleeps instead of waits (about 12.5 min of sleep inside tool calls)

- **What happened:** 168 `sleep` calls in the subagent (416 s) and 94 in the lead (336 s), usually `sleep 2`–`sleep 6` after every click or navigation (`go()` sleeps 4 s by default). Two long leading sleeps were blocked by the harness:
  - 03:59:27: `Blocked: sleep 30 followed by …`
  - 04:15:25: `Blocked: sleep 50 …`
- **Root cause:** the CLI has no `wait_for` (the runbook says so). The helpers had no "wait until this text or role is in the snapshot" primitive.
- **Fix:** add `waitfor '<pattern>' [timeout]` to the committed helper. It polls `take_snapshot` every 300 ms until a grep matches, and fails with the last snapshot path on timeout. `go` uses it on the target heading instead of `sleep 4`. The skill should also say: never start a Bash call with `sleep N`; use an until-loop on a condition.

### 4. Snapshot noise from the Shopify admin (about 27 filtering calls in the subagent, a similar share in the lead, and tokens in the output)

- **What happened:** every `take_snapshot` of the admin includes the admin nav, Sidekick, the alerts feed, and `url="…"` on every link. Those URLs include the app frame's `hmac`, `id_token` and `session` parameters.
- Agents filtered by hand with patterns like `sed -n '/Iframe "Baton"/,/Sidekick/p'`, `grep -v Sidekick` and `sed -n '/_56 main/,/Iframe/p'`. That last one depends on uid numbering.
  - Four lead calls (03:47:41–03:48:13) went to finding the Add member dialog's fields in that noise.
  - The lead's output printed a full embedded URL with `hmac` at 03:52:42.
- **Root cause:** no helper that returns only the title bar and the app frame. `verify-baton` warns to write snapshots with `--filePath`, but that is the Playwright path.
- **Fix:** add helpers to the committed `cdt.sh`:
  - `appsnap` prints the title-bar region plus the `Iframe "Baton"` subtree, with `url="…"` attributes removed.
  - `rawsnap` writes the full snapshot to a file.
  - Use them by default, so the noise and the tokens never reach the transcript.

### 5. Wrong turn to the chrome-devtools MCP for the member side, needing a user interrupt (3 calls, about 1 min, and the user had to step in)

- **What happened:**
  - 03:40:36: ToolSearch loaded the `mcp__chrome-devtools__*` tools.
  - 03:40:38: `new_page` with `isolatedContext: "member"` failed with "Could not connect to Chrome … DevToolsActivePort".
  - The user interrupted: "You should not use Chrome MCP, right? You should be using the CLI …".
- **Root cause:** three sources point the other way.
  - Memory `production-member-sign-in.md` says to request the link "in an isolated Chrome DevTools MCP context".
  - Memory `verify-ui-with-chrome-mcp.md` says to check pages "with the chrome-devtools MCP".
  - `AGENTS.md` § Browser checks says "Playwright CLI or Chrome MCP: choose as useful".
- **Fixes:**
  - **`AGENTS.md` § Browser checks:** agents drive the agent Chrome only (Playwright CLI, or the `chrome-devtools` CLI with the checkout's `--sessionId`). The chrome-devtools MCP attaches to the user's own Chrome; use it only when the user asks.
  - **Memory `production-member-sign-in.md`:** replace "Chrome DevTools MCP context" with the CLI form, `chrome-devtools new_page https://baton.mw10013.com/sign-in --isolatedContext member --sessionId=<member session>`.
  - **Memory `verify-ui-with-chrome-mcp.md`:** retarget it to the agent Chrome CLI.
  - The newer memory `production-exploratory-test-2026-10-24.md` already says "Never the chrome-devtools MCP", but the older two contradict it.

### 6. Production log access was improvised (6 calls and about 1.5 min to a working query, plus about 3 min waiting on logs)

- **What happened:**
  - 03:39:46: `cf o11y telemetry query --help` printed an "AGENT COMMAND DISCOVERY" banner.
  - 03:39:50: grepping the docs for `o11y` found only prose.
  - 03:39:58: the flag form failed with `--parameters-order-by-value is required when any --parameters-* flag is set`.
  - 03:40:03: a `--body` with an `in` filter returned 400 `invalid_union`. The fix was a `{"kind":"group","filterCombination":"or","filters":[eq…, eq…]}` group, which worked at 03:40:17.
  - The lead then wrote `tail.mjs`, a 15 s poller over both Workers that appends one line per event to `prod.log`. It worked well.
- **Later wait trouble:**
  - **Two blocked `sleep 30` and `sleep 50` calls**, waiting for log ingestion.
  - **A 117 s until-loop (04:16:11–04:18:08).** The subagent waited for any event later than 04:16:20, after it had closed its tabs. With no traffic, the condition could only become true once some unrelated event arrived.
- **Root cause:**
  - `AGENTS.md` § Logs names the dataset and filter for staging only, with no runnable command and no production line.
  - No committed tail exists.
  - The poller records no watermark, so "has the log caught up to time T" cannot be asked.
- **Fixes:**
  - **`scripts/logs.ts` plus a `logs` script in `package.json`:** `vp run logs <stage> [--since 10m] [--follow --out <file>]`, ported from `tail.mjs`. It writes a `# watermark <iso>` line, or a sidecar file, after every poll, and has a `vp run logs wait <iso>` that returns once the watermark passes that time.
  - **`AGENTS.md` § Logs:** add production (`baton-website-production` and `baton-backend-production`) and name `vp run logs`.
  - **`docs/production-release-runbook.md` § Check a release:** replace its prose `cf o11y` line with that command.

### 7. A second chrome-devtools session was started by hand, against the skill's rule (1 call, plus the risk of a logged-out headless Chrome)

- **What happened:** at 03:41:41 the lead ran `chrome-devtools start --sessionId=3901 --browserUrl=http://127.0.0.1:9333 …` for the member side. It worked, but `verify-baton` says "Never run `chrome-devtools start` or `stop` yourself". `vp run browser agent` starts only `--sessionId=<WEBSITE_PORT>`.
- **Root cause:** `scripts/browser.ts` has no way to make a second, named session.
- **Fix:** give `agent` in `scripts/browser.ts` an optional session suffix, for example `vp run browser agent --session member`. It would start `--sessionId=<WEBSITE_PORT><n>` with the same flags and print the id. An isolated context on the main session (`new_page … --isolatedContext member --sessionId=3900`) would also have worked, so the skill should say which of the two to use.

### 8. Two agents acted as the merchant on the same shop and the same CLI session (attribution cost)

- **What happened:** the lead ran its own merchant actions on page 4 of session 3900, the session the subagent was using: XS team, workflow, member add, remove and delete. It logged them only as `date -u` echoes in its transcript. The subagent kept its own `merchant-actions.log`.
- The subagent's report then had a section, "prod.log errors I could not tie to my actions", for two `Network connection lost.` exceptions that came from the lead's member delete and sign-out.
- **Fix:** have every side append to one shared action log (`act <side> <text>`, where side is merchant, member or lead) in the committed helper. The procedure should also say which agent owns which records and name prefixes, such as `XS` for cross-side and `QA` for merchant-only.

### 9. No skill or procedure for a production exploratory test (the root of #2–#4 and #7)

`verify-baton` is scoped to "this checkout's dev store", uses the Playwright CLI, and refuses parallel drivers. The production test needed:

- the chrome-devtools CLI
- two sessions or contexts
- a production log tail
- member magic-link sign-in
- a preflight on the live build

**Fix:** add `.claude/skills/explore-baton/SKILL.md`, or an "Exploratory test on staging or production" section in `.claude/skills/verify-baton/SKILL.md`, with `cdt.sh` next to it. It holds:

- the preflight (#1)
- `vp run browser agent` and the member session (#7)
- `vp run logs production --follow` (#6)
- member sign-in: the agent requests the link, the user pastes the newest one, and the link expires in 5 min
- the helper commands (#2–#4)
- the shared action log (#8)
- record prefixes and cleanup
- the report shape: finding, repro, screenshot, log line, severity, and a PASS list

### 10. Small items

- **Subagent `update_plan`:** the subagent called it and got a hook error, `you are a subagent … Do not call update_plan`. 1 call. The lead's subagent prompt could say so up front.
- **Hoisted More actions menu items (CLI):**
  - `Failed to interact with the element … did not become interactive` came up 5 times (lead at 03:55:40; subagent at 04:00:27, 04:09:35 and 04:11:06).
  - `verify-baton` documents the Playwright workaround, which is to click the in-frame menu button natively, but there is no CLI equivalent.
  - Add one to the helper: `js` clicking `s-menu … s-button` by its text, inside the app frame.
- **Screenshots:** each one is 2400×1906 (DPR 2) and was read back at 2000×1588. That happened 3 times in the lead and about 11 times in the subagent. One Read failed because of the screenshot syntax error in #2. A `shot` helper that uses `--format jpeg --quality 70`, or a 1200-wide viewport, would cut the image tokens about four-fold.
- **"Invalid token":** it did not happen during the test. It came later (06:40, `vp run cloud:reset` on staging, `cf builds triggers list` → `[12006] Invalid token`), from the account `CLOUDFLARE_API_TOKEN` in `~/.zshrc`. It is already recorded in memory `cf-token-in-zshrc.md` and is out of scope here.

## What went smoothly

- **Agent Chrome:** `vp run browser agent` was ready and logged in after 10 s (03:39:34–03:39:44), with no Shopify login trouble.
- **Member sign-in:**
  - The link was requested at 03:43:32 and the user pasted it at 03:44:23. The lead launched the merchant subagent while it waited, so no time was lost.
  - The isolated context kept the member's cookies apart from the admin's.
  - Spent-link reuse and external `callbackURL` probes were quick.
- **The `prod.log` poller:**
  - Once written, it gave millisecond-level correlation. For example, `Runs.memberStartTask` at 03:59:05.270 against the removal at 03:59:05.680 settled the race ordering.
  - It mapped the `Network connection lost.` exceptions to the revoke, which became fix #3.
- **Delegation:** sending the merchant side to a subagent let both sides run at once. The subagent's report was well structured: findings with repro, log line and screenshot, a PASS list, and the records it created and deleted.
- **Timestamps and cleanup:**
  - The subagent's action log (UTC per action) made findings traceable.
  - The subagent deleted all of its own records.
  - The lead closed its tabs, stopped session 3901 and killed the poller.
- **Results:** the three main findings were real and were released as fixes the same day (`03fe6b7`, `753be8b`, and the stale-editor series ending `c14af38`).

## Fixes by file

| File                                                                                                             | Change                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/explore-baton/SKILL.md` + `cdt.sh` (new), or a section in `.claude/skills/verify-baton/SKILL.md` | Production/staging exploratory procedure: preflight, sessions, logs, member sign-in, helpers (`appsnap`, `waitfor`, `setv`, fail-loud `uid`, `url`, menu click, jpeg `shot`), shared action log, cleanup, report shape |
| `scripts/logs.ts` (new) + `package.json`                                                                         | `vp run logs <stage> [--since] [--follow --out] [wait <iso>]` with a watermark, ported from the scratchpad `tail.mjs`                                                                                                  |
| `scripts/browser.ts`                                                                                             | `agent --session <name>` for a second session; print the shipped chrome-devtools CLI `SKILL.md` path                                                                                                                   |
| `AGENTS.md`                                                                                                      | § Browser checks: agent Chrome only, MCP only on request. § Logs: production line and `vp run logs`                                                                                                                    |
| `../notes/systems/chrome-devtools-cli-runbook.md`                                                                | CLI facts: positional page id versus `--pageId`, fenced `evaluate_script` output, `fill` appends, select-all does not work in Polaris, no `wait_for`                                                                   |
| `docs/production-release-runbook.md`                                                                             | § Check a release: use `vp run logs production --since <deploy time>`                                                                                                                                                  |
| Memory `production-member-sign-in.md`, `verify-ui-with-chrome-mcp.md`                                            | Replace the chrome-devtools MCP guidance with the agent Chrome CLI                                                                                                                                                     |

## Questions

1. A new `explore-baton` skill, or a section in `verify-baton`? Recommendation: a new skill. `verify-baton` is about one change on the dev store and refuses parallel drivers; an exploratory run on a deployed stage is a different job with different rules.
2. Build `vp run logs` as a committed script? Recommendation: yes. Every release check and every test reads production logs, and the query shape took six tries to find.
3. Change `AGENTS.md` § Browser checks to "agent Chrome only; the chrome-devtools MCP only when the user asks"? Recommendation: yes. It is the line that sent the agent to the wrong browser.
4. Run the test with a preflight that stops when `main` is ahead of `production`? Recommendation: yes, and ask whether to promote first.
