# Order detail state model plan

Implementation plan for `docs/order-detail-state-model-research.md`. Every question in that doc is decided (section 14). Read the research first: sections 9, 10 and 13 hold the reasoning that the JSDoc written below must carry inline, because the research doc will be deleted.

Written 2026-09-24 for an LLM agent. Work on `main`, no branches. Do not commit unless told. After each step: `pnpm typecheck && pnpm lint && pnpm test`. At the end: `pnpm fmt`, keep every file it touches. Record anything that did not go as written in section 12 of this file.

## What this delivers

1. Cancelled runs no longer exist. Cancel run, Change workflow and reconcile delete the run row. `RunStatus` is `pending | active | done`.
2. Three pure Domain derivations: `lineItemState`, `runActions`, `taskActions` (the last renamed in place and widened). One matrix JSDoc on `runActions`, one table-driven test.
3. `ShopAgent` refuses any run write whose action field is false, for both actors.
4. The order page renders each line item by switching on `lineItemState` and each button by reading an action field. Reassign becomes a modal. Cancel run gets a confirmation modal. A closed order shows one banner and no writes.
5. The member work page and run list read the same action sets.
6. Member callables renamed `member*`.
7. JSDoc across `Domain`, `WorkflowRunRepository`, `ShopAgent`, the routes and the components aligned to the new rules, with no reference left to cancelled runs, Undo cancel, or per-site conditions.

## What this does not change

- Reconcile flag semantics, `FlagBanner`, `RunNote`, `RunSteps`, the Change workflow modal, the at-rest workflow picker, the deleted-team attention picker, the orders index, billing, the open-run ceiling.
- The member work page layout. Only its gates move to `runActions` and `taskActions`.

## Prerequisites

- Schema edits go into the initial DDL in `src/lib/ShopAgent.ts` in line. No migration: the project is prototyping and the user resets all Durable Object and local state after schema changes. Say so in the final report so they do.
- `pnpm port` gives the dev port. E2E runs headless with `npm run test:e2e --`.
- For looking at the rendered page, either `pnpm playwright-cli --session="$(pnpm port)-state" open ...` or the Chrome DevTools MCP (`mcp__chrome-devtools__navigate_page`, `take_screenshot`, `take_snapshot`). Chrome MCP is the easier of the two for the embedded admin because the session is already signed in; use whichever works. Wait for `body[data-hydrated="true"]` before interacting.

## Step 1. Rename member callables (Q9)

One commit's worth of mechanical change, done first so later diffs are not also renames.

In `src/lib/ShopAgent.ts`, rename the member run-write callables and their `@callable` names:

| From              | To                     |
| ----------------- | ---------------------- |
| `startTask`       | `memberStartTask`      |
| `completeTask`    | `memberCompleteTask`   |
| `uncompleteTask`  | `memberUncompleteTask` |
| `unstartTask`     | `memberUnstartTask`    |
| `setRunNote`      | `memberSetRunNote`     |
| `blockRun`        | `memberBlockRun`       |
| `setBlockReason`  | `memberSetBlockReason` |
| `dismissFlag`     | `memberDismissFlag`    |
| `getRunForMember` | `memberGetRun`         |

Leave `listRuns`, `subscribeRuns`, `subscribeRun` (reads; the member connection tag already scopes them). Leave `cancelRun`, `attachWorkflow`, `assignRunTaskTeam`, `listRunsForOrder` as merchant-only bare names for now, or prefix them `merchant*` too; do the latter, so the rule below has no exceptions.

Update every caller: `src/lib/ShopAgentClient.ts`, `src/lib/useMemberRunActions.ts`, `src/routes/shop.$shop.workflows.$runId.tsx`, `src/routes/shop.$shop.index.tsx`, `src/routes/app.orders.$orderId.tsx`, and the tests under `test/integration/` that call them (`member-runs-socket`, `shop-agent-callables`, `shop-agent-workflows`, `member-area`). Grep for each old name after the rename; nothing may remain.

JSDoc: on the `ShopAgent` class, or on the first run callable, add the rule: "Every run-write callable is named `<role><Verb>` where the role is the `ConnectionRole` allowed to call it. The merchant acts through the embedded admin session; a member through a member connection with its team ids. The two paths load different context, so they are separate callables rather than one with a role switch." Add a test in `shop-agent-callables.test.ts` titled with that rule that asserts a member connection cannot call a `merchant*` callable and vice versa, if such a test does not already exist.

## Step 2. Remove cancelled runs (Q13)

**Amended by section 13 (decided 2026-09-24).** Cancel run does not delete the row. It deletes the tasks and keeps a `cancelled` marker, so reconcile starts nothing on the item until the merchant picks a workflow. Change workflow and reconcile still delete. Where this step and 13e disagree, 13e wins: `cancelled` stays in `RunStatus`, `cancelledAt` stays on `WorkflowRun`, and the constraint is the total `unique (lineItemId)` with no partial index. Everything else below stands: no Undo cancel, no revive, no `uncancelRun`, no `ItemHasRun`, no `runIsLive`.

### 2a. Schema, `src/lib/ShopAgent.ts`

In the `WorkflowRun` DDL:

- `status` check becomes `('pending', 'active', 'done')`.
- Delete the `cancelledAt` column on `WorkflowRun` (not on `ShopOrder`, which keeps its Shopify `cancelledAt`).
- Replace `unique (lineItemId, workflowId)` and the partial `WorkflowRun_live_item_uidx` with `lineItemId text not null unique` (or a plain unique index on `lineItemId`). One run per line item is now a plain constraint.
- `WorkflowRun_open_age_idx` keeps its `where status in ('pending', 'active')`.
- Update the schema JSDoc near line 398 that explains the partial index: the rule is now "one run per line item, and a run is deleted rather than cancelled, so the constraint is total".

`WorkflowRunTask` already cascades on delete.

### 2b. Domain, `src/lib/Domain.ts`

- `RunStatus`: drop `"cancelled"`. Rewrite its JSDoc gate table: remove the Un-cancel row, remove "cancelled" from every row, and add the sentence "A run is never cancelled in place. Cancel run, Change workflow and reconcile delete the row, because a cancelled run has no reader: Shopify's own model is that a cancel is final and the way back is to start again, and a tombstone row only served an Undo that merchants do not expect (see `cancelRun`)."
- Delete `runIsLive`. Every caller becomes unconditional (the run exists) or `runIsOpen` where the intent was "not done". Audit each call site by hand; do not search-and-replace. The note gate ("note on the run: `runIsLive`") becomes "always, while the run exists".
- `WorkflowRun` schema: drop `cancelledAt`.
- `RunResult`: drop `ItemHasRun`. Rewrite the `Terminal` doc: it now only means "the run is done and this write needs an open run".
- Delete the `cancelled` field from `RunCounts` if present, and from the reconcile counts type rename it `removed`.
- `taskActions`: `live` becomes `mine`. Full rewrite comes in step 3; here only remove the status reference.

### 2c. Repository, `src/lib/WorkflowRunRepository.ts`

- `cancelRun`: `delete from WorkflowRun where id = ?` after the `runIsOpen` check, then `releaseOpenRunLimit`. JSDoc: state the deletion and why (research 13), and that the merchant confirms in a modal that names the loss, so the repository does not need a second guard.
- Delete `uncancelRun` and `RunItemBusyError`.
- `setRun`: delete the un-cancel branch. The incumbent live run, if any, is deleted (not set cancelled) before the insert. Update the JSDoc on `setRun` and on the "what the merchant means" paragraph: switching back to a workflow the item ran before starts fresh.
- `cancelPending` in reconcile: delete instead of update. Rename the summary count `cancelled` to `removed`. Update the JSDoc on reconcile that says "a cancelled run keeps its key and is left alone".
- Every `status <> 'cancelled'` predicate (about 15) goes away; the query is over all rows.
- `RunTerminalError` JSDoc: now only done.
- `RunFinishedError` JSDoc: "replacing it would rewrite that record to cancelled" becomes "replacing it would delete a finished record".

### 2d. Order repository, `src/lib/OrderRepository.ts`

Remove `status <> 'cancelled'` from the run subqueries and update the JSDoc at the `OPEN` and count helpers that say "a cancelled run counts as no run at all".

### 2e. ShopAgent

- Delete the `uncancelRun` callable and the `ItemHasRun` mapping in the error-to-result function.
- `memberGetRun` returns none for a run that no longer exists, which it already does for an unknown id.

### 2f. Member pages

- `src/routes/shop.$shop.workflows.$runId.tsx`: the Done / Cancelled badge becomes Done only. The not-found path (run id resolves to nothing) shows the same copy the run list uses for a run that left the member's teams; check it renders a page, not a thrown error, when a merchant cancels while the page is open. `useSubscribedQuery` should already deliver the miss on the next socket update; verify.
- `src/routes/shop.$shop.index.tsx`: the comment at 339 about cancelled rows; delete or reword.

### 2g. Order page, first pass

Delete the cancelled run row, `Undo cancel`, the `Terminal` copy "That workflow run was cancelled", and the JSDoc at 89-93 and 959-961. Cancel run now opens a confirmation modal (`s-modal#cancel-run`): heading "Cancel this run?", body "N of M steps are done. That work will be lost." when N > 0, else no body, secondary "Keep run", primary critical "Cancel run". Success toast: "Run cancelled." The change-workflow toast drops "X was cancelled." and says "Changed to Y."

### 2h. Tests

- `workflow-run-repository.test.ts`: delete the un-cancel tests, rewrite the "setRun over a live run" test to assert the old row is gone, rewrite the reconcile tests that assert `status === "cancelled"` to assert the row is absent and the count is `removed`.
- `shop-agent-workflows.test.ts`, `member-runs-socket.test.ts`, `shopify-webhook.test.ts`, `order-repository.test.ts`, `domain.test.ts`: same substitutions. Grep for `cancelled` in `test/` and `e2e/`; the only legitimate remaining hits are order-level (`cancelledAt` on `ShopOrder`, `order_cancelled` flag, `isCancelled`).
- `e2e/orders.spec.ts`: the assertion "The replaced run stays on the page, cancelled" becomes "the replaced run is gone"; the new Cancel run modal gets a test; `e2e/seed.ts` and `e2e/fixture.ts` drop any cancelled-run seeding.

## Step 3. Domain derivations (research 9, 10)

All in `src/lib/Domain.ts`, next to `taskActions`.

### 3a. Actor

Extend the member variant of `Actor` with `teamIds: Schema.Array(TeamId)` as an optional key, or add a separate `RunActor` type if the attribution schema must stay unchanged on stored rows. Prefer extending `Actor` with an optional key; the stored `by` never sets it. JSDoc on the key: "Present when the actor is gating, absent when it is attribution."

### 3b. `LineItemState`

```ts
export const LineItemState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("removed") }),
  Schema.Struct({ kind: Schema.Literal("unmatched") }),
  Schema.Struct({ kind: Schema.Literal("startable"), options: Schema.Array(WorkflowOption), matched: Schema.Array(WorkflowId) }),
  Schema.Struct({ kind: Schema.Literal("running"), run: WorkflowRun, tasks: Schema.Array(RunTaskView) }),
  Schema.Struct({ kind: Schema.Literal("finished"), run: WorkflowRun, tasks: Schema.Array(RunTaskView) }),
]);
export const lineItemState = (order, item, runs, workflows): LineItemState
```

Decision tree is research 9c. JSDoc states: one kind per layout; the flag is not a kind because it changes the banner, not the card; the closed order is not a kind because it is a page-level banner and an all-false action set. Use `Match` for the derivation.

### 3c. `RunActions` and `runActions(actor, order, run)`

Fields: `note, block, editReason, liftFlag, cancel, changeWorkflow`, all booleans. JSDoc is the run matrix from research 9d minus the `uncancel` column and the cancelled row, with one sentence per column giving the reason for its blank cells:

- `note`: always, both actors. A note is a record, not work.
- `block`: open, unflagged, both actors (member needs a ready task on their team). Not on a flagged run because it would overwrite the reconcile record.
- `editReason`, `liftFlag`: flagged, both actors; `editReason` only when `runIsBlocked`.
- `cancel`: open, merchant only, including on a closed order (it is how the merchant clears an `order_cancelled` run from team views).
- `changeWorkflow`: open, merchant only, `canAttachRun(order)`.
- Every field except `note`, `liftFlag` and `cancel` is false when `!canAttachRun(order)`.

### 3d. `TaskActions` and `taskActions(actor, order, run, task)`

Rename in place and widen. Fields: `start, done, putBack, reopen: { blockedBy } | null, reassign`. `start` member only. `done`, `putBack` both actors (the member with the team gate). `reopen` both, carrying the blocker, renamed from `undo`. `reassign` merchant only, open run, task not completed, `canAttachRun(order)`. All false on a closed order. JSDoc is the task matrix from research 9d, with the existing paragraphs on "no primary styling" and "nothing on a member screen renders the blocker" kept.

### 3e. Test

New `test/integration/run-actions.test.ts`. One fixture builder per matrix row (order open or closed, run status, flag, task readiness, actor merchant or member with or without the team). For each cell: assert the field. Test titles are the row labels verbatim from the JSDoc table so a failing test names the cell. Also a test titled "lineItemState has one kind per layout" that walks the decision tree.

## Step 4. ShopAgent enforcement (Q12)

In every `merchant*` and `member*` run-write callable, after loading the run (and the order, via the existing order lookup used by `attachWorkflow`), compute `runActions` or `taskActions` for the caller and refuse with `RunResult.NotAllowed` when the field is false. Keep the repository guards; they are the second line. JSDoc on the first callable, linked from the rest: "The action set is the one gate. The page rendered the button because the field was true; the callable checks the same field with the same inputs so a stale tab or a second admin cannot write what the page would not offer."

Order lookup: the run row carries `orderId`; `OrderRepository` has a get by id. One extra read per write is acceptable.

Tests: extend `run-actions.test.ts` with, per blank cell, a callable call that asserts `NotAllowed`. Use the existing socket harness in `test/integration/agent-socket.ts` for member calls and the direct stub for merchant calls, as the other callable tests do.

## Step 5. Order page rewrite

`src/routes/app.orders.$orderId.tsx`.

- `renderLineItem` becomes a `Match.value(Domain.lineItemState(...))` with one branch per kind. Delete `live`, `removed`, `ambiguous`, `changeable`, `options` locals and every per-control condition listed in research section 1.
- `runBadges`: `[status] [flag]`, no buttons. Dismiss on a done run moves into `FlagBanner` (which now renders for any flag, as on the member page), with `liftFlagLabel` picking the word.
- `manageRows`: `renderActions` reads `taskActions(merchant, order, run, task)`; `renderExtra` keeps the "Can't reopen" sentence from `reopen.blockedBy`. The run-action row reads `runActions`.
- Reassign: delete `reassigning` state and the inline picker. New `s-modal#reassign-task`: heading "Reassign <task name>", select defaulted to the current team, secondary "Keep <team>", primary "Assign". Reuse the option list from the attention row's picker. The attention row's inline picker stays.
- Cancel run modal from step 2g.
- Closed order: when `!Domain.canAttachRun(order)`, one `s-banner` above the items, tone `critical` for cancelled, `info` for fulfilled, heading "Cancelled in Shopify" / "Fulfilled in Shopify", body "Work on this order is read-only. Dismiss the flags to clear them from the team views." The "No workflows can start" sentence is not shown on a closed order.
- Delete `interveneMutation` and its `kind` union. One mutation per action field, each calling the matching `merchant*` client wrapper.
- Every remaining JSDoc on this route that states a condition is replaced by `{@link Domain.runActions}` or `{@link Domain.lineItemState}`. The route keeps JSDoc only for layout reasons (why a control sits where it sits), never for gating.

## Step 6. Member pages

- `src/routes/shop.$shop.workflows.$runId.tsx`: Block's gate, `FlagBanner` actions and the note's `canEdit` read `runActions(member, order, run)`. Task buttons read `taskActions`. The page needs the order's open or closed state; add `canAttachRun`'s two inputs (`cancelledAt`, `fulfillmentStatus`) to `RunView` if not present, with a JSDoc saying why.
- `src/routes/shop.$shop.index.tsx`: the row menu and the Done tab's Undo read `taskActions`. Rename `undo` to `reopen` in `useMemberRunActions` and `runTabs.ts`; the button label may stay "Undo" if the member research decided that, but the field is `reopen`.
- Behaviour should not change on either page. If a button appears or disappears, that is a finding for section 12, not something to patch locally.

## Step 7. JSDoc alignment pass

Do this as its own step after the code is green, reading every JSDoc in these files top to bottom:

- `src/lib/Domain.ts`: the file header rule list; `RunStatus`; `RunFlag`; `runIsOpen`; `runIsDone`; `canAttachRun` (add R1 sentence); `RunResult`; `taskActions`; `runActions`; `lineItemState`; `Actor`.
- `src/lib/WorkflowRunRepository.ts`: every error class; `setRun`; `cancelRun`; reconcile; `recomputeStatus`; `requireActionable`.
- `src/lib/ShopAgent.ts`: schema comments; callable naming rule; enforcement rule.
- `src/routes/app.orders.$orderId.tsx`, `src/routes/shop.$shop.workflows.$runId.tsx`, `src/routes/shop.$shop.index.tsx`, `src/components/MemberRun.tsx`, `src/components/RunSteps.tsx`, `src/lib/useMemberRunActions.ts`, `src/lib/runTabs.ts`.

For each: no mention of cancelled runs, `runIsLive`, Undo cancel, `ItemHasRun`, `intervene`, or an inline gate condition. Every gate sentence is a `{@link}` to the Domain owner. Every rule sentence has a test whose title is the rule; where one is missing, add it. `pnpm lint` runs `scripts/rules-lint.ts`, which refuses inline status comparisons; expect it to catch stragglers.

## Step 8. Seed and look

Extend `src/routes/api.dev.seed.ts` (and `e2e/seed.ts` if the E2E fixture is separate) with the rows the research says have never been looked at:

1. An open order with an active run carrying `item_removed` (open reconcile flag: banner with Dismiss, no Mark done, Reassign present).
2. A Shopify-cancelled order with an active run (`order_cancelled` flag): page banner, banner with Dismiss, Cancel run present, nothing else.
3. A done run with `quantity_changed`: Done badge, banner with Dismiss, Reopen present.
4. A blocked pending run: red badge, banner with Edit reason and Unblock, Reassign present, no Mark done.
5. An item with three matching workflows and no run: picker with matched first.

Open each in the browser (Chrome MCP or playwright-cli), take a screenshot at final size, and compare against research section 4. Record every mismatch in section 12 before fixing it.

## Step 9. E2E

`e2e/orders.spec.ts`: update selectors for Reassign (modal), Cancel run (modal), Dismiss (banner), and delete Undo cancel assertions. Add one spec per seeded row from step 8 that asserts the visible controls. `e2e/member-runs.member.spec.ts`: rename `undo` references if the label changed; otherwise unchanged. Run `npm run test:e2e --` headless and paste failures, if any, into section 12.

## Step 10. Final checks

```bash
pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e -- && pnpm fmt
```

Grep gates, all must be empty:

```bash
grep -rn "runIsLive\|uncancelRun\|ItemHasRun\|Undo cancel\|interveneMutation\|status <> 'cancelled'" src test e2e
grep -rn "'cancelled'" src/lib/WorkflowRunRepository.ts src/lib/Domain.ts
```

Report: what changed, that the user must reset local Durable Object state and D1 (`pnpm d1:reset` and the DO reset they use), and section 12 in full.

## 11. Order of commits, if asked to commit

1. Rename member callables.
2. Remove cancelled runs.
3. Domain derivations and matrix test.
4. ShopAgent enforcement.
5. Order page rewrite.
6. Member pages.
7. JSDoc alignment, seed, E2E.

## 12. Deviations and issues

The implementing agent records here, as it goes, anything that differed from the plan above, with the reason and what was done instead. Also record: any cell of the matrix where the existing code disagreed with the research table and the disagreement looked deliberate; any place a member page's button set changed in step 6; any screenshot from step 8 that did not match research section 4; any test that had to be deleted rather than rewritten; any JSDoc whose reasoning could not be carried inline because the research doc was its only source.

Format, one entry per item:

- **Step N, file:symbol.** What the plan said. What was found. What was done. Open or resolved.

- **Step 2, `WorkflowRunRepository.cancelRun`, reconcile.** The plan said Cancel run deletes the run. Found: the cancelled row did a third job the research missed. Its `unique (lineItemId, workflowId)` key stopped reconcile from auto-starting the same workflow on that item again. With the row deleted, the next `orders/updated` webhook, Apply or Turn on starts a fresh run of the workflow the merchant just cancelled. Resolved by section 13: a task-less `cancelled` marker.
- **Step 1, `ShopAgentClient.getRunForMember`.** Renamed to `memberGetRun` along with the callable, so the client wrapper and the RPC share a name. `Domain.GetRunForMemberInput` kept its name. The test helpers `memberActions` / `merchantActions` in `test/integration/agent-socket.ts` keep their short keys (`completeTask`, ...) and now call the `member*` / `merchant*` callables. Resolved.
- **Step 1, naming rule.** The `<role><Verb>` JSDoc sits on `merchantListRunsForOrder`, the first run callable in the file. Its test is in `shop-agent-callables.test.ts`, titled with the rule. Resolved.
- **Step 3b, `Domain.lineItemState`.** The plan's decision tree checks `currentQuantity === 0` first. That would hide an active run flagged `item_removed`, which is seed row 1 of step 8 (banner with Dismiss). A run is checked first, then `removed`. The signature is `(item, runs, workflows)` with no order, because the order only hides the resting picker, which the page does with `canAttachRun`. `startable` gained `ambiguous: boolean` for the ambiguity sentence. `Domain.runTaskViews` was added so the order page gets `RunTaskView`s from its own rows. Resolved.
- **Step 3c, `Domain.runActions`.** It takes the run's tasks as a fourth argument, because every "m" cell needs "a ready task on the member's team" and `note` needs "the member can see the run". Resolved.
- **Step 3c, matrix cell "done, quantity flag / liftFlag / m".** The research table says M m. The repository's `dismissFlag` requires a ready task on the member's team, and a done run has none, so the member has always been refused. The JSDoc table marks the cell M only and says why. The work page used to draw a Dismiss button there that the server always refused; it no longer draws it. Decided 2026-09-24: kept merchant-only. The member work page's banner on a done run's flag says "Your merchant will review this." instead of drawing no button. Resolved.
- **Step 6, work page Block.** It used to show on any open, unflagged run and the repository refused a member whose task was not ready. It now follows `runActions.block`, so Block disappears when none of the member's tasks on the run is ready. The same happens to Edit reason and the lift. Behaviour change, deliberate.
- **Step 3d / 6, closed orders on member pages.** `taskActions` is all false on a closed order, so a member loses Start, Done, Put back and Undo on a closed order's run after the flag is dismissed. A run list row with no allowed verb now draws no menu button. Behaviour change, per R1.
- **Step 3/6, `Domain.OrderState`.** Member views need the order's open or closed state. `OrderState` (`cancelledAt`, `fulfillmentStatus`) was added to `RunView`, `RunListItem` and `DoneItem`, read by join. A run whose order is missing is dropped from those reads (retention deletes both together). `canAttachRun`, `isCancelled` and `isFulfilled` now take the narrow shape. Resolved.
- **Step 4, enforcement.** `WorkflowRunRepository.getRunGate` loads run, task views and order state in one call. The rule JSDoc is on `ShopAgent`'s module-level `requireRunAction` (the enforcer) rather than on the first callable. `merchantCancelRun` reads the team scope before the delete, because afterwards the run is gone. `AssignRunTaskTeamResult` gained `NotAllowed`. Some refusals that used to come back as `Terminal` now come back as `NotAllowed`. Resolved.
- **Section 13, implemented.** `cancelled` is back in `RunStatus` as a task-less marker with `cancelledAt`. `cancelRun` deletes the tasks and clears note and flag. `setRun` replaces a marker with `replaced: null`, the same workflow included. Reconcile's `adjust` skips markers. `getRunView` and `getRunGate` answer none for one. `RunCounts` gained `cancelled`; `orderNeeds`, `NO_WORKFLOW` and the count facts treat it as decided. `LineItemState` gained the `cancelled` kind. Seed progress gained `cancelled` (`Domain.SeedProgress`, `e2e/seed.ts`). Resolved.
- **Step 2, `WorkflowRunRepository.setRunNote`.** The repository refuses a note on the marker with `RunTerminalError` as a second line under `runActions.note`. `RunTerminalError`'s JSDoc now says "the run's status refuses the write" rather than "the run is done". Resolved.
- **Step 4, `merchantAssignRunTaskTeam` on a finished task.** The action-set gate now answers `NotAllowed` before the repository's `TaskFinished` can. The test in `shop-agent-workflows.test.ts` was changed to expect `NotAllowed`; the page copy for it is "That task can no longer be reassigned." `TaskFinished` and `RunNotOpen` stay as the repository's second line. Resolved.
- **Step 2 tests, `workflow-run-repository.test.ts`.** Two assertions were deleted rather than rewritten: the un-cancel refusal test ("un-cancel is refused while another live run occupies the item"), and in the unassign test the `RunTerminalError` from assigning a task of a cancelled run, then un-cancelling it. Neither state exists any more; the marker has no tasks. The rest were rewritten: reconcile deletions assert the row is absent and count `removed`; the "partial index" test is now "the unique index refuses a second row for an item, and a cancelled marker still holds the slot"; the un-cancel reconcile test is now "a cancelled item starts nothing on reconcile". Resolved.
- **Step 5, `renderLineItem`.** The plan says `Match.value(Domain.lineItemState(...))`. oxlint reads JSX arrows in `Match`'s object literal as components defined in render (`react(no-unstable-nested-components)`), so the page uses an exhaustive `switch` with a `satisfies never` default. The Domain derivation uses `Match`. Resolved.
- **Step 5, Change workflow on a removed item.** An open run on a line at zero units (`item_removed`) still offers Change workflow, because `runActions.changeWorkflow` does not read units. Seen on #1031 in step 8. Decided 2026-09-24: `runActions` takes the line item and `changeWorkflow` needs units to make (matrix row "open, nothing to make"); `merchantAttachWorkflow` answers `NothingToMake` on a zero-unit item; a cancelled item at zero units draws its line with no picker (`LineItemState.cancelled.startable`). Resolved.
- **Step 5, toast on a plain Start.** Starting a workflow from the picker now toasts "Started X." (it was silent), so the start over a cancelled marker says "Started", never "resumed", as 13d asks. Resolved.
- **Step 8, screenshots.** #1031 (item removed), #1019 (cancelled in Shopify), #1032 (done, quantity changed), #1033 (blocked, pending), #1034 (three matches) and #1035 (cancelled item) were opened in the embedded admin and match section 4 and 13d, including the Cancel run and Reassign modals. The local Durable Object still had the old schema (which accepts the marker), so no reset was needed to look. No mismatch recorded.
- **Step 10, lint.** The pre-existing `jsx-curly-brace-presence` warning on the order page and the eight in `scripts/icon.ts` are fixed (`**`, `toReversed`, named `u` regex groups, and a no-op `split/join/replace` chain removed from `indent`). `pnpm lint` reports no warnings. Resolved.
- **Step 10, grep gate 2.** `grep "'cancelled'" src/lib/WorkflowRunRepository.ts src/lib/Domain.ts` is not empty: `cancelRun` writes `status = 'cancelled'`. That is the section 13 marker, which the gate predates. The literal in `Domain.ts` is in `RunStatus` and `runIsCancelled`, as the Domain rule requires, spelled with double quotes. Resolved.
- **Step 9, E2E.** `orders.spec.ts`: Reassign asserts the modal; the change test asserts the replaced run is gone, then cancels through the modal and starts the same workflow fresh; a new spec "each order-page state draws the controls its action set allows" covers the step 8 rows. `member-runs.member.spec.ts`: one JSDoc no longer names `runIsLive` (the button still reads Undo). Full headless run: 63 of 64 passed; the new spec failed because it opened #9502 through the index, whose default Open filter hides a Shopify-cancelled order. It now opens each order by URL and passes on its own. Resolved.

### Review (2026-09-24)

A second pass over the finished implementation against this plan and section 13. Code, schema, enforcement and tests match the decided model; `pnpm typecheck`, `pnpm lint` and `pnpm test` (445) pass. Section 12's deviations are all sound. What the pass found and did:

- **JSDoc still describing delete-on-cancel.** `ShopAgent.merchantCancelRun` ("Deletes the run"), the order page's `NotFound` copy comment, and the work page's not-found comment all said a cancel deletes the run. Rewritten to the marker. Resolved.
- **`Domain.WorkflowRun` said a run outlives an order delete and must not join `ShopOrder`.** Retention already deleted runs with their orders, and step 3/6 added an inner join to `ShopOrder` on the run list, Done tier and `getRunGate`, so the claim was false twice over. The JSDoc and the `orderProcessedAt` note now say the snapshots are for reading alone and an order delete takes its runs. The seed comment on `replaceWorkflows` that repeated the claim is reworded. Resolved.
- **`Domain.RunResult` vs `RunTerminalError`.** `Terminal` said "the run is done"; the repository's error said "the run's status refuses the write" (it also covers the note on a marker). Aligned, and `NotFound` now says it is what every write on a marker gets, because `getRunGate` treats the marker as no run. `getRunGate`'s interface JSDoc says the same. Resolved.
- **`merchantAttachWorkflow` JSDoc** did not mention the marker (fresh start, `replaced: null`) or `NothingToMake`. Added. Resolved.
- **Work page banner without a button.** The page showed "Your merchant will review this." on a done run only, by `runIsDone`; a member whose tasks are all downstream on an open flagged run got a banner with no button and no sentence. It now shows the note whenever `runActions.liftFlag` is false, so the page reads one field and the JSDoc says both cases. Resolved.
- **Not changed, worth knowing.** `requireRunAction` raises `RunNotAllowedError` with `teamId: ""` because the error's shape is the team gate's; harmless, but the field is now a misnomer for the action-set refusal. `scripts/icon.ts` was touched for lint warnings the plan did not ask about. Section 12's "grep gate 2" hit (`status = 'cancelled'` in `cancelRun`) is the marker write and stays.
- **Looked at.** #1035 (cancelled item: neutral badge, the line, the picker with the cancelled workflow first) and #1019 (cancelled in Shopify: page banner, flag banner with Dismiss, note, Manage) in the embedded admin match 13d and section 4.

## 13. Cancelled items: open design

Found during step 2. This section reopens Q13 of the research. Answer inline; the recommendation under each question is mine.

### 13a. What the cancelled row was doing

Today (before this plan) a cancelled run was a full `WorkflowRun` row with `status = 'cancelled'`. It served three purposes:

1. **Undo cancel.** Decided away (research Q1, Q13).
2. **Resume on reattach.** Picking the same workflow revived the row with its done tasks. Decided away.
3. **Blocking auto-restart.** Nobody listed this one. Reconcile creates a run for an item with exactly one matching workflow and no live run. `insertRun` uses `on conflict do nothing`, and the cancelled row still held `(lineItemId, workflowId)`, so the insert was skipped. The merchant's cancel stuck.

Delete-on-cancel keeps 1 and 2 gone but loses 3. Where it bites:

| Who deletes the run                     | Can reconcile restart it?      | Why                                                                                                    |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Merchant: Cancel run                    | **Yes**, on the next reconcile | The item still matches by tag, the order is open and paid, and nothing is left on the item             |
| Merchant: Change workflow               | No                             | The new run holds the item                                                                             |
| Reconcile: order cancelled or fulfilled | No                             | A closed order starts nothing                                                                          |
| Reconcile: line dropped to zero units   | No                             | `matchesTag` needs `currentQuantity > 0`. If an edit raises it again, starting again is arguably right |

So only Cancel run needs something to remember it. Reconcile runs on every `orders/updated` webhook (payment, fulfilment, tags, note, edits) and on every Apply, Turn on or date change of an active workflow. A cancelled run would typically be back within minutes or hours.

### 13b. The model you described: cancel is final, the item is visible, a new workflow is a fresh run

Restating it so we agree on it:

- Cancel run kills the run completely. No undo, no revive, ever.
- Afterwards the item is visibly **cancelled** on the order page, and nothing starts on it automatically.
- The merchant may give it a workflow by hand: any workflow, including the one just cancelled. That is a fresh run copied from the definition, with no link to the old one.
- The new run replaces the cancelled marker. An item never holds more than one thing.

I agree with this, and it is simpler than the research's "cancel means gone" for one reason: it names the state the merchant is in. Once auto-restart has to be blocked, a cancelled item is a real state with a real rule ("nothing starts here by itself"). Hiding it would leave the merchant staring at a picker with no idea why the tag match that routes every other item did nothing here. Shopify's own cancelled order is the same shape: visibly Cancelled, final, and the way forward is a new thing, not a revived old one.

### 13c. Where the marker lives

| Option                                            | How                                                                                                                                                                                                                                                                                                                                     | Cost                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. A stripped `WorkflowRun` row** (recommended) | Cancel run deletes the tasks and keeps the row with `status = 'cancelled'`, `cancelledAt`, `workflowName`. The total `unique (lineItemId)` from step 2 stays, so the marker takes the item's one slot and can never accumulate. A manual attach deletes it and inserts the fresh run in one transaction, as Change workflow does today. | Every reader that means "a run with work" must skip `cancelled` again: roughly the open, done and ambiguity SQL in `OrderRepository`, `getRunView`, `lineItemState`, and the counts. That is fewer than before this plan, because a marker has no tasks: the run list, Done tier, readiness SQL and team fan-out never see it. |
| B. A marker on `OrderLineItem`                    | e.g. `routing = 'manual'`                                                                                                                                                                                                                                                                                                               | `OrderLineItem` rows are deleted and reinserted on every sync (`OrderRepository.upsertOrder`), so the upsert has to carry the marker across. It is easy to lose in a later edit. Nothing on the item can show which workflow was cancelled or when, so the card line in 13d has nothing to print.                              |
| C. A table of its own                             | e.g. `RunHold (lineItemId primary key, at)`                                                                                                                                                                                                                                                                                             | You did not want another table. It also duplicates what option A's row already holds.                                                                                                                                                                                                                                          |

**Why the partial index does not come back under A.** It existed only so that many cancelled rows could sit beside one live run on the same item. Under A the marker _is_ the item's one row, so `unique (lineItemId)` stays total. Cancel run turns the run into the marker in place, and a manual attach replaces the marker.

**Why deleting the tasks matters.** With no tasks there is nothing to revive, by construction rather than by a rule someone has to remember. It also keeps the marker out of every task-driven read (run list, Done tier, readiness, team fan-out, the open-run ceiling).

### 13d. What the merchant sees

The line item card, under the title and facts:

```
Engraved cutting board — Walnut
× 1 · SKU ECB-W                                   [Cancelled]

Engraving workflow cancelled · 3h ago. Nothing starts on this item until you choose a workflow.
Workflow  [ Choose workflow ▾ ]  [Start]
```

- The badge on the title line is **Cancelled**, neutral or subdued rather than red. It is a decision the merchant made, not an alarm. (Red stays for Blocked and for Shopify cancelling the order.)
- One subdued line names what was cancelled and when, and says the consequence. It is the only place the old workflow's name survives.
- The picker at rest lists every active workflow, the matched ones first as today, **including the one just cancelled**. Start creates a fresh run. The toast says "Started Engraving." with no "resumed" wording anywhere.
- No Manage, no note, no Undo. A marker has no tasks, and its note goes with it (see 13f Q-C4).
- On a closed order the line stays and the picker goes (R1).

The Cancel run modal says the consequence up front, so nobody is surprised by the card afterwards:

> **Cancel this run?**
> 2 of 3 steps are done. That work will be lost. Nothing will start on this item until you choose a workflow.
> [Keep run] [Cancel run]

### 13e. What changes in the plan if A is chosen

| Area                                                  | Change                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStatus`                                           | `pending \| active \| done \| cancelled`. JSDoc: `cancelled` is a marker with no tasks. No write moves a run out of it; a manual attach replaces the row. Only Cancel run writes it.                                                                            |
| `WorkflowRun`                                         | `cancelledAt` comes back (nullable, set only on the marker).                                                                                                                                                                                                    |
| Schema                                                | Keep the total `lineItemId unique` from step 2. Status check gains `'cancelled'`. No partial index.                                                                                                                                                             |
| `cancelRun`                                           | In one transaction: delete the tasks, set `status = 'cancelled'`, `cancelledAt`, clear `flag`, `flagAt`, `flagDetail` and `note`, release the ceiling.                                                                                                          |
| `setRun`                                              | An incumbent that is `cancelled` is replaced like an open one, but `replaced` comes back `null` (nothing was running). A `done` incumbent is still refused. The same workflow as a cancelled incumbent is **not** `AlreadyExists`; it starts fresh.             |
| Reconcile                                             | An item holding a marker counts as having a run, so nothing auto-starts. `adjust` skips markers. The marker is not flagged when the order is cancelled or fulfilled (nothing to stop). Reconcile's own deletions (13a rows 3–4) stay deletions, with no marker. |
| `Domain.runIsCancelled`                               | New predicate. `runIsOpen`, `runIsDone` unchanged.                                                                                                                                                                                                              |
| `lineItemState`                                       | New kind `cancelled: { run, options, matched }`, one per layout: the cancelled line plus the picker.                                                                                                                                                            |
| `runActions` / `taskActions`                          | Not computed for a marker: the page has no run controls for the `cancelled` kind. `ShopAgent`'s `getRunGate` answers `NotFound` for a marker, so every run write refuses.                                                                                       |
| `OrderRepository` SQL, `runCounts`, `productionState` | Open and done count as before. `ANY_RUN` and `RUN_FOR_ITEM` decide the needs; see Q-C2.                                                                                                                                                                         |
| Member pages                                          | `getRunView` answers none for a marker, so an open work page on a cancelled run shows not-found, as a deleted run would. The run list never sees it (no tasks).                                                                                                 |
| Tests                                                 | Rewrite the reconcile test "keeps a cancelled run cancelled" as "a cancelled item starts nothing on reconcile" (the rule gets a test titled with it). Add: "a manual attach on a cancelled item starts a fresh run, even of the same workflow".                 |

### 13f. Decisions (2026-09-24)

| #    | Decision                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-C1 | The marker is a stripped `WorkflowRun` row: `status = 'cancelled'`, `cancelledAt`, no tasks, under the total `unique (lineItemId)`.            |
| Q-C2 | A cancelled item counts as decided: not `no_workflow`, not `choose_workflow`. `RunCounts` gains `cancelled` so `orderNeeds` and the SQL agree. |
| Q-C3 | The word is `cancelled`, for the literal and the badge.                                                                                        |
| Q-C4 | Cancel run clears the note and the flag. The modal names the note when there is one.                                                           |
| Q-C5 | Change workflow leaves no marker.                                                                                                              |
| Q-C6 | Reconcile's own deletions leave no marker.                                                                                                     |
| Q-C7 | On a closed order the cancelled line stays and the picker goes.                                                                                |
| Q-C8 | Step 2 is amended by 13e; work resumes from there.                                                                                             |
