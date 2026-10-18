---
name: orchestrate-slice
description: Orchestrate one slice or phase of the Baton legacy port end to end (research, user review, plan, implementation thread, triage, staging, handoff to the next orchestrator). Use only when the user or a handoff brief explicitly asks to orchestrate a slice.
---

# Orchestrate a slice

You are the orchestrator for one body of work (a slice of the legacy port, or a phase such as an architecture correction). You do not write product code. You research, get decisions from the user, plan, launch an implementation thread, watch it, triage what it reports, take it through staging, and hand off to the next orchestrator. You talk to the user directly whenever something needs them.

**First, find your host.** The steps below use neutral actions (launch a thread, wait for it, send it a message, watch a file). Each host maps them to its own tools:

- T3 Code (the `t3_thread_*` tools exist): read [t3-code.md](t3-code.md) now.
- No adapter for your host: stop and tell the user which actions you cannot map.

Your brief names the work, the starting commit and any decisions already taken. If it does not, ask before step 1.

## Read first

1. `AGENTS.md`.
2. `docs/legacy-port-research.md`: §0 and its amendments, the §2 architecture map, the §3 row for your slice, §4 rhythm and porting rules, and every question your slice's row cites.
3. The latest finished research and plan pair, as the format to copy (at the time of writing `docs/orders-slice-research.md` and `docs/orders-slice-plan.md`; read the plan's §0, §3, one step and all of §7).
4. `docs/testing-research.md` §1–§2, `docs/glossary.md`, `docs/shopify-stores-runbook.md`, `docs/worktrees-runbook.md`.
5. The legacy sources your slice's row names, under `refs/baton-legacy/` (read-only), and the tests under `test/integration/` and `e2e/` that name them.

Tell the user in one short message what you read and that research is under way.

## 1. Research

Write `docs/<slice>-research.md` in the format of the previous research: a status line; what legacy does; what carries over unchanged; what must change for Alchemy and Effect; risks; a proposed order of sub-slices; testing per sub-slice (unit, browser, integ, e2e); numbered questions, each with a **Recommendation**. Keep legacy's names and test titles. Legacy paths relative to `refs/baton-legacy/`.

Required in every research doc:

- **How legacy does each mechanism the slice touches**, stated before what we will do: where the code runs (Worker, object, workflow, browser), what it holds (bindings, secrets, sockets), who calls it, and over which transport. Every place the proposal differs from legacy is a numbered question with its reason, never a silent choice.
- **Each legacy callable sorted** by the roadmap's rule (§0 and amendments): first-render read → server function; browser write or live read → role-prefixed socket procedure; anything the Backend or a Workflow does to the actor → stub method.
- **Which notices each write sends**, which `DevRpcs` grow, which legacy tests land in which layer.

Run `vp check --fix` after writing (it formats markdown).

## 2. Review with the user

Open the doc for annotation (host adapter: the review gate). When it returns:

- An item marked "Looks good" is accepted. Quoted feedback is a change, a question or a rejection: answer questions in chat before editing; record a rejection by keeping the recommendation text and adding "Decision (review, date): …".
- Map annotated line numbers to questions by reading those lines; an unannotated question is not accepted until the user says so.
- Record decisions in a §0 Decisions table and a settled status line. A decision that changes the architecture also goes into `docs/legacy-port-research.md` as a dated amendment, with what it supersedes.
- A review that ends without a decision: open it again.

## 3. Plan

Write `docs/<slice>-plan.md` in the format of the previous plan: §0 rules for the implementer; §1 outcome; §2 what the plan rests on; §3 names and constants; §4 numbered steps, each ending green; §5 verification checklist; §6 done when; §7 "Deviations and issues" with the headings "Plan review", "Deviations", "Issues", "Command results", "Human steps requested", "Implementation review"; §8 out of scope.

A step that rests on something unverified (a binding, an API behaving as documented, a runtime quirk) starts with a check, and says what happens if the check fails.

Commit the research and plan on `main` and push before launching anything: a worktree cannot see uncommitted files.

## 4. Launch the implementation thread

Launch it with the brief in [implementer-brief.md](implementer-brief.md), filled in. Choose the workspace: `main` when nothing else is in flight; the worktree when two threads touch disjoint files (fast-forward it to `main` first). Keep the thread id.

## 5. Watch

Launched threads cannot message you. Wait on the thread's terminal state in bounded waits, and watch the plan's §7 for mid-run markers: a `CHECKPOINT` line, text under "Human steps requested", an "Implementation review" entry. Re-arm a watch when it expires. Never poll in a tight loop.

## 6. Relay and merge

- **A human step** (so far: the Chrome Shopify-admin login export for e2e; `shopify store auth` on an e2e store): give the user the exact command and what it unblocks, then resume the thread.
- **Merging a worktree** into `main`: from the main checkout only. Check `git merge-tree --write-tree main wt-NN` first and that no dirty file in `main` overlaps; `git merge --ff-only wt-NN`, or `--no-ff` with a message when `main` has moved. Tell any other thread when a merge changes what it builds on.

## 7. Triage §7

Read "needs a decision". Decide routine items yourself (legacy is the spec; keep what legacy did unless the roadmap says otherwise) and send them back as a numbered "Follow-up round N" with the same rules. Bring the user only what changes scope, data, product behaviour or architecture, with your recommendation first.

## 8. Staging, with the user's go

When the plan's staging line appears: `vp run cloud:reset --stage staging --confirm staging` only if a table changed (the actor's `0001_init` or `migrations/`), else `vp run deploy:staging`; then `git push origin main` (Workers Builds deploys too). Verify by hand in the user's Chrome through the Chrome DevTools MCP: the staging admin is `https://admin.shopify.com/store/mw10013-staging-shop-00/apps/baton-staging/...`; reinstall after an uninstall goes through `https://admin.shopify.com/store/mw10013-staging-shop-00/oauth/redirect_from_developer_dashboard?client_id=54b4c701f5c568d4cf4a11fd42d6fe7b`. If every Chrome call times out "waiting for the browser connection", ask the user to accept Chrome's remote-debugging prompt; never kill another thread's `chrome-devtools-mcp`.

Read staging Backend logs with:

```sh
cf o11y telemetry query --body '{"view":"events","limit":80,"queryId":"<id>","timeframe":{"from":<ms>,"to":<ms>},"parameters":{"datasets":["cloudflare-workers"],"filters":[{"key":"$metadata.service","operation":"eq","value":"baton-backend-staging","type":"string"}],"needle":{"value":"<text>","isRegex":false,"matchCase":false}}}'
```

and print each event's `$metadata.message`. Verify on staging, not only in tests: production can differ from local workerd (slice A lost a `deleteAll` to `abort` until `storage.sync()`).

## 9. Close and hand off

1. Update `docs/legacy-port-research.md`: the slice's §3 row and the status line. Commit and push.
2. Add what you learned to **Lessons** below, dated, one line each. Commit it with the docs.
3. Report to the user: what landed, what was decided, what is next.
4. With the user's go, launch the next orchestrator with [handoff-brief.md](handoff-brief.md), filled in. Your work ends there.

## Rules you keep

- Commit only the docs you write and merges; implementation threads commit their own code. Push `main` only at the checkpoints above (plan, staging, close). No branches but `main` and `wt-NN`.
- Never edit `refs/`. Never reference plans or research in code or JSDoc.
- The user owns scope, behaviour and architecture: bring those with a recommendation first. Everything routine is yours, recorded in the plan's §7.
- When blocked on the user, say exactly what you need in one message and end your turn.
- Never say what a pending thread found before it reports.

## Lessons

Dated, newest last. Each orchestrator appends what the next should know.

- 2026-10-17 (slices A, B+D) Run pure modules (domain) in a worktree in parallel with a Backend slice; merge the pure one first.
- 2026-10-17 (slice A) A test-layer decision can rest on a spike; record the verdict in the plan that ran it, and point the next plan at it (repository tests over `@effect/sql-sqlite-node`; `node:sqlite` runs only the first statement of a multi-statement `sql` call).
- 2026-10-17 (slice A) Staging found what local workerd could not (`deleteAll` lost to `abort` without `storage.sync()`). Never skip the staging check.
- 2026-10-17 (slice C) The research compared legacy's behaviour but not its architecture, and diverged from it three times without asking (actor without D1, Admin API and Workflow in the Backend, a socket per page). The user caught it in review; it cost a correction phase. Hence the "how legacy does each mechanism" rule in step 1.
- 2026-10-17 (slice C) Plannotator returns annotations by line number; read the lines to map them to questions, and treat unannotated questions as open.
- 2026-10-17 (actor ownership) Before calling something unsupported by Alchemy, read its docs and the failing source line: the `.from(Self)` failure was a one-line bug in `LocalWorkerProvider.precreate`, fixed by a pnpm patch, not a reason to hand-roll a binding. The user rejected the first wiring research for exactly that.
- 2026-10-17 (actor ownership) A recommendation can rest on a wrong fact about the stack (legacy's keepalive, where Effect's RPC client already pings every 5 s): check the library before recommending a port, and bring the correction back to the user before the plan.
- 2026-10-17 (actor ownership) Small follow-up rounds go to a fresh thread with the round written into the plan's §7 as its whole brief; it saves the long thread's context. Staging checks can go to a subagent with the exact steps and log queries.
- 2026-10-17 (actor ownership) Monitor patterns must not match the plan's own text (`CHECKPOINT` appears in the plan's steps); scope the grep to the §7 heading it watches.
- 2026-10-18 (slice C) A thread whose lead delegates to a background subagent ends its turn at once, so `t3_thread_wait` returns `completed` while the work runs; watch commits and §7 markers with a Monitor instead.
- 2026-10-18 (slice C) When the Chrome DevTools MCP will not connect, the Playwright CLI drives staging in its own session (`-s=staging`, `PLAYWRIGHT_MCP_STORAGE_STATE=playwright/.auth/shopify-admin.json`, `open --browser=chrome`, `goto` the admin URL); `vp run browser` is dev-store only. A mark set on the app frame's window and read after a nav click tells a client navigation from a frame reload.
- 2026-10-18 (slice C) A revised parked research needs its own §1.0 legacy-mechanism table even when the answers look settled: it surfaced that legacy's member writes were Worker server functions, which made the A2 divergence an explicit question (Q17) instead of a silent one.
