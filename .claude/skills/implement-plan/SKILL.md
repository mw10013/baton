---
name: implement-plan
description: Take a written Baton plan (docs/<name>-plan.md) from review through implementation by one subagent, triage, the full e2e run, commit and staging. Use when the user or a plan writer's handoff explicitly asks to implement a plan.
---

# Implement a plan

Someone wrote a plan and handed it to you in a new thread; they are done with it. You own it from here to committed and on staging. You do not write the plan's code yourself: one subagent does. You review the plan, run the subagent, triage what it reports, fix what is routine, run the full e2e suite once, and bring the user only what needs them.

**Your host:** in T3 Code (the `t3_thread_*` tools exist) read [t3-code.md](t3-code.md) for the review gate and thread tools. Elsewhere, use the Agent tool for the subagent and tell the user which other action you cannot map.

## For the plan writer: handing off

1. The plan is `docs/<name>-plan.md`, in the format of the latest finished plan: §0 rules, §1 outcome, §2 what it rests on, §3 names, §4 steps each ending green, §5 checklist, §6 done when, §7 "Deviations and issues" (Plan review, Deviations, Issues, Command results, Human steps requested, Implementation review), §8 out of scope. A step that rests on something unverified starts with a check and says what happens if it fails.
2. §0's test rules follow **Testing** below; do not ask for e2e per step.
3. Commit the plan and its research on `main` (a new thread or worktree cannot see uncommitted files).
4. Launch one thread with this skill, model Opus, workspace `main`, with the message: "Use the implement-plan skill on `docs/<name>-plan.md`. Research: `<path or none>`. Decisions: `<where recorded>`." Your work ends there.

## 1. Read and review the plan

Read `AGENTS.md`, the plan whole, and the research sections it cites. Check the steps against the code and the libraries under `refs/`. Write what is wrong or missing under §7 "Plan review". Fix the plan yourself only where it is plainly wrong; anything that changes scope, behaviour or architecture goes to the user with your recommendation first, before the subagent starts.

## 2. Implement, with one subagent

Run one subagent (Agent tool, model opus) with [implementer-brief.md](implementer-brief.md) filled in, and wait for it. It works on `main`, commits each green step, and does not delegate. A human step it records ends its run: give the user the exact steps and what they unblock, then resume the same subagent (SendMessage). If it stops or drifts, finish the remaining steps yourself rather than starting another.

## 3. Triage §7

Read every Deviation, Issue and decision item yourself, and check the code the risky ones touch. Routine items (legacy is the spec; the plan's intent is clear) you decide and fix, recording each in §7. Run the unit and browser tests your fixes touch. Collect for the user only what changes scope, data, product behaviour or architecture.

## 4. Full e2e, once

Run `vp test` and the full `vp run test:e2e` once, after triage. The e2e server is long-lived and Playwright does not start it: `vp run e2e:status` first, and `vp run e2e:start` when it is down (`vp run e2e:restart` after a dependency, stack, patch or schema change). A failure: run that spec alone; fix it or record it; never re-run the full suite to see a known failure again. A flaky spec is simplified until it is stable, or deleted if what remains is not worth its time; record which.

## 5. Report, commit, staging

1. Report to the user: what landed, the numbers, and each open item with your recommendation first. When blocked on them, say exactly what you need and end your turn.
2. With their answers applied, commit the plan's §7 and your fixes on `main` (stage paths explicitly).
3. With the user's go, `git push origin main`. The push is the deploy (Workers Builds runs `deploy:staging`); never run `deploy:staging`, and ask before `cloud:reset` if a table changed. Watch the build with `cf builds list --external-script-id <tag>` (the `id` of `baton-website-staging` in `cf workers scripts search`) until `success`, then check the change on `https://admin.shopify.com/store/mw10013-staging-shop-00/apps/baton-staging/...` through the Chrome DevTools MCP (if every call times out, ask the user to accept Chrome's remote-debugging prompt; never kill another session's MCP). Staging Backend logs: `cf o11y telemetry query` on `cloudflare-workers`, `$metadata.service` = `baton-backend-staging`.
4. Add a dated line to **Lessons** if the next run should know something. The plan is done.

## Testing

E2E runs are the expensive part (the embedded project alone is ~6 minutes), so they are spent once:

- **The implementer**, per step: `vp check --fix`, and `vp test <files>` for the tests the step touches. E2E only for specs the change could break, and only when a step changes what they exercise, never as a per-step ritual. The full `vp test` once at the end. Never the full e2e suite.
- **You**: the full e2e suite once (step 4), and single specs while fixing.
- Nobody re-runs a suite through a failure they already understand.

## Rules you keep

- `main` only (a `wt-NN` worktree only when the user asks for parallel work; merge it into a clean main tree, `git merge --ff-only`).
- Never edit `refs/`. Never reference plans or research in code or JSDoc.
- The user owns scope, behaviour and architecture. Everything routine is yours, recorded in §7.

## Lessons

Dated, newest last.

- 2026-10-17 Staging finds what local workerd cannot (`deleteAll` lost to `abort` without `storage.sync()`). Never skip the staging check.
- 2026-10-17 Before calling something unsupported by Alchemy, read its docs and the failing source; patch a small Alchemy bug with pnpm patch instead of hand-rolling around it.
- 2026-10-18 Keep one `<s-page>` alive from SSR through hydration: App Bridge watches only the `<s-page>` present at a window's load.
- 2026-10-18 Root-cause a flake at each hop before raising timeouts (`E2E_FRAME_LOG=1` instruments frame loads). Re-running a full suite through a known flake cost hours.
- 2026-10-18 A Shopify-side prerequisite (a plan picked on a store, an app made public) blocks every suite once a gate lands: list it before the first code step.
- 2026-10-19 (live reads) Thread-per-role orchestration and per-step e2e cost ~29 of 71 minutes in tests alone; hence one implementer, scoped tests, one full e2e run by the reviewer.
- 2026-10-19 (live reads) The implementer was stopped mid-plan; the reviewer finished the last two steps itself, and its recount found a bug the tests passed (TanStack calls any same-route navigation `stay`). Measure the outcome the plan targets, not only the tests.
- 2026-10-19 (admin console) A spike's credential was invalid, not under-scoped, and its premise (inventory names) failed too; the user parked that part and the slice closed without it. Check a plan's external credential and the response shape a step relies on before the subagent starts. Scoped e2e is `vp run test:e2e <spec>`: a `--` makes Playwright ignore the files.
- 2026-10-19 (public help) A setup project's failure (`install`: a new quick tunnel not yet in DNS) skipped 81 tests twice; read the setup error before re-running, and never re-run a run whose setup failed for an environment reason without addressing it. The implementer's scoped e2e missed `shell.spec`, which also reads the changed landing: scope by screen, not by file name. A plan's claim about Shopify-side behaviour (the app name follows `shopify app dev`) was wrong; check such claims before the subagent starts.
