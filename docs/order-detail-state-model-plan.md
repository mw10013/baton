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

(none yet)
