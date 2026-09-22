# Step ownership: implementation plan

Date: 2026-09-22. Research and decisions: `docs/step-ownership-research.md`.

For the implementing agent: read the research first, section 1 (the current
model) and section 6 (the six decisions). This plan is the mechanics. Record
anything you did differently, and anything that surprised you, in section 9
at the end of this file.

## 1. Outcome

Two changes to the run step model, both member-side and merchant-side:

1. A new verb, **Put back**, that takes an in-progress step back to Ready by
   clearing its Start record. Offered to every member of the step's team and
   to the merchant.
2. **Undo** (member) / **Reopen** (merchant) clears a member's Start as well
   as the merchant's, so an undone step returns as Ready, not "In progress
   by <old starter> since <old time>".

Everything else stays: team assignment keeps `startedBy`, no confirmation
dialogs, no new actor slot, no audit table.

## 2. Rules, stated once

Each rule lives on the symbol named, as JSDoc, and has a test whose title is
the rule (`CLAUDE.md`). Other sites `{@link}` it.

| rule                                                                                                                                                                              | symbol                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Put back clears the Start record of an in-progress step; refused on a finished step, an unstarted step, a run that is not open, a flagged run, or a step not on the caller's team | `WorkflowRunRepository.unstartStep`                                 |
| Put back is offered wherever Done is, and only on a started step                                                                                                                  | `Domain.stepActions` (new `putBack` boolean)                        |
| Undo returns a step to Ready: it clears every Start column, member or merchant, and writes the `reopened*` slot                                                                   | `WorkflowRunRepository.uncompleteStep` (existing JSDoc rewritten)   |
| The `RunStatus` table gains a row: `Put back` gated by `runIsOpen`, and the step started and ready                                                                                | `Domain.RunStatus` JSDoc                                            |
| Team reassignment keeps `startedBy`                                                                                                                                               | `Domain.AssignRunStepTeamResult` JSDoc, already stated; leave as is |

## 3. Domain (`src/lib/Domain.ts`)

1. **`RunStatus` table.** Add a row after Block:
   `| Put back (clear a step's Start) | {@link runIsOpen}, and the step started and ready |`.
2. **`WorkflowRunStep` JSDoc.** The paragraph on `reopened*` says "the next
   `completeStep` clears it". Add that Undo now clears the whole Start slot
   so a reopened step reads Ready, and that Put back clears the Start slot
   with no slot of its own: "a put-back step is plain Ready and the next
   Start writes a fresh record".
3. **`UnstartStepInput`.** `export const UnstartStepInput = CompleteStepInput;`
   with a JSDoc: "Put back: clears a started step's Start record. Same shape;
   the rule is on `WorkflowRunRepository.unstartStep`."
4. **`UnstartStepCommand`.** Interface `{ runStepId; actor; teamIds? }` like
   `UncompleteStepCommand`. JSDoc: "No slot records the actor: the step is
   plain Ready again ({@link WorkflowRunStep}). `actor` is taken for the log
   line and for symmetry with the other step commands."
5. **`stepActions`.** Add `readonly putBack: boolean` to the return type,
   computed as `ready && step.startedAt !== null` where `ready` is the local
   already computed for Done. Update the JSDoc's first paragraph to name Put
   back beside Start and Done ("Start, Done and Put back need
   {@link runIsOpen}"). Decision 6.2 (whole team) is implied by using the same
   `mine` gate; say so in one sentence.
6. **`RunResult`.** No new variant: Put back on an unstarted or finished step
   is `NotReady` (`StepNotReadyError`), matching how Undo on an unfinished
   step reports. Extend the `StepNotReadyError` JSDoc in the repository
   (section 4) rather than adding a variant.
7. **`tierOf` JSDoc.** Add one sentence: Put back and Undo both clear
   `startedByEmail`, so they are the two ways a run leaves Mine without being
   finished.

`scripts/rules-lint.ts` refuses inline status comparisons; use the predicates.

## 4. Repository (`src/lib/WorkflowRunRepository.ts`)

1. **`StepNotReadyError` JSDoc.** Extend: "... for undo, not yet completed;
   for put back, not yet started or already completed."
2. **`unstartStep`.** Add to the service interface next to `uncompleteStep`,
   with the same error union as `startStep` (`RunNotFoundError`,
   `RunNotAllowedError`, `RunFlaggedError`, `StepNotReadyError`,
   `RunTerminalError`, `SqlError`). Implementation, in a transaction:
   - `requireActionable({ runStepId, teamIds })` (default gate `runIsOpen`).
   - `if (run.flag !== null) yield* new RunFlaggedError(...)`: a flag means
     stop, and Put back is doing, not undoing. State this in the JSDoc: Undo
     is allowed under a flag because it takes work back; Put back is refused
     because a held step is the one someone needs to write on, and clearing
     who has it under a hold loses the one name the merchant needs.
   - `if (step.startedAt === null || step.completedAt !== null) yield* new StepNotReadyError(...)`.
   - `if (!(yield* isReady(runStepId))) yield* new StepNotReadyError(...)`.
     A started step is always ready by construction (Start required it and
     nothing behind it can reopen while it is started), but the check is
     cheap and keeps the four step writes reading alike.
   - `update WorkflowRunStep set startedAt = null, startedBy = null, startedByEmail = null, startedByRole = null where id = ?`.
   - `recomputeStatus(run.id, now)`. Check what `recomputeStatus` derives:
     if the run's `active` status is "any step has `startedAt`", a put-back
     first step must return the run to `pending`. Read the function and its
     JSDoc; if it already recomputes from the steps, nothing to do, and say
     so in section 9. If `pending` and `active` are distinguished some other
     way, make Put back honour it and write the rule down on `RunStatus`.
3. **`uncompleteStep`.** Change the `startedAt` / `startedByRole` `case`
   expressions to unconditional `null`, and null `startedBy` /
   `startedByEmail` too. Replace the inline comment ("A merchant 'start' is
   only ever the backfill...") with the new rule: Undo returns the step to
   Ready; who reopened it is the `reopened*` slot; the old Start is a claim
   the starter no longer makes and a time that is no longer true. Cite the
   research doc's reasoning inline, not by file name.
4. **Service interface JSDoc** on `uncompleteStep` (around the "Allowed"
   paragraph near `reopenedAt` at the top of the interface) currently says
   the step becomes Ready for a worker to Start. Check it agrees; it should
   now be exactly true.

## 5. ShopAgent (`src/lib/ShopAgent.ts`)

1. **`unstartStep`** member callable, a copy of `startStep` calling
   `repository.unstartStep` with `actor: { role: "member", ... }` and
   `teamIds`, log line `ShopAgent.unstartStep: shop=… step=… memberId=…`,
   then `publishToTeams({ runStepId })`.
2. **`merchantUnstartStep`** merchant callable, a copy of
   `merchantUncompleteStep` calling `repository.unstartStep` with
   `actor: { role: "merchant" }` and no `teamIds`.
3. `test/integration/shop-agent-callables.test.ts` has a role map of every
   callable; add `unstartStep: "member"` and `merchantUnstartStep: "merchant"`
   or the test fails.

## 6. Member side

1. **`src/lib/useMemberRunActions.ts`.** Add an `unstart` mutation beside
   `uncomplete`, and include it in the `mutations` array so `pending` covers
   it.
2. **`src/routes/shop.$shop.workflows.$runId.tsx`.**
   - `renderStep`: add a `Put back` secondary button after Done when
     `can.putBack`, calling `actions.unstart.mutate(step.id)`. Include
     `can.putBack` in `anyAction`.
   - `stepState`: no change. After Put back the step has no `startedAt` and
     renders Ready. After Undo it now also renders Ready (badge `Ready`, text
     team name) with the "Reopened by … · <relative>" line under it, which
     the existing render already handles since it is keyed on the reopened
     slot, not on `startedAt`. Confirm by eye with Chrome MCP or
     `playwright-cli`.
   - Read the file's JSDoc on the button row and on Undo ("Undo is offered
     where it is allowed and nowhere else") and add Put back to the same
     sentence.
3. **`src/routes/shop.$shop.index.tsx`** (run list). Rows do not go through
   `Domain.stepActions`; the row renders Start and Done directly from the
   step's `startedAt` (around the `startedBy` read near the row's state
   line and the `actions.start` / `actions.complete` buttons), and the Done
   today tier calls `stepActions` for Undo (`doneUndo`). Add `Put back` to
   the Mine row's `s-menu` (the kebab with `accessibilityLabel` "Actions for
   <order>") beside the existing items, shown only when the row's step has
   `startedAt` and the run is open and not flagged, calling
   `actions.unstart.mutate(step.id)`. Mine is where a mistaken Start lands,
   so it is the row that needs the one-press fix; Up next rows have nothing
   started and do not need it. Read the row's JSDoc on Start ("Starting a
   step is what puts the row in Mine") and add the sentence that Put back
   is the inverse.
4. **`src/lib/runTabs.ts`** JSDoc mentions Undo returning a row to Mine.
   Grep for "Mine" and "Undo" there and in `Domain.DoneItem` and correct any
   sentence that says Undo keeps the starter.

## 7. Merchant side (`src/routes/app.orders.$orderId.tsx`)

1. **`Intervention` union.** Add `{ kind: "putBack"; runStepId; toast }`.
   Wire it in the `intervene` switch to `stub.merchantUnstartStep({ runStepId })`.
2. **Manage row buttons.** After Mark done, when `step.startedAt !== null && step.completedAt === null && !Domain.runIsFlagged(run)`,
   render a secondary `Put back` button with toast `${step.name} put back`.
   Use `Domain.stepStartedBy(step) !== null` rather than the raw column if a
   predicate reads better; `startedAt` is not a status literal so
   `rules-lint` does not object either way.
3. **`resultMessage` / `RunResult` handling.** `NotReady` on a put back means
   "already put back or already done"; check the existing `NotReady` copy
   reads correctly for that case and adjust the wording if it names Done
   specifically.
4. **`manageStateLine`.** No change: a put-back step is Ready and the
   existing branch renders it.
5. The `Reopen` blocker comment block in the Manage row explains that the
   merchant can reopen the blocking step. With Put back the merchant's path
   from the screenshot state is: Put back step 3, Reopen step 2, Reopen
   step 1. Add one sentence there naming Put back as the way past an
   in-progress blocker, since Reopen only clears a finished one.

## 8. Tests

Unit / integration (`pnpm test`):

- `test/integration/domain.test.ts`, `describe("Domain.stepActions")`: add
  cases titled with the rule: "Put back is offered wherever Done is, and only
  on a started step"; flagged run hides it; other team hides it; finished
  step hides it.
- `test/integration/workflow-run-repository.test.ts`: add `unstartStep`
  cases: clears the four Start columns and republishes Ready; refused on an
  unstarted step (`StepNotReadyError`); refused on a finished step; refused
  on a flagged run (`RunFlaggedError`); refused for the wrong team
  (`RunNotAllowedError`); refused on a cancelled run (`RunTerminalError`);
  run status returns to `pending` when the only started step is put back.
  Update the existing `uncompleteStep`
  cases that assert the member starter survives Undo: the test titled
  "uncompleteStep re-opens a step, keeps its starter, un-readies the next
  stage, and is refused once downstream started" and the later merchant
  backfill cases that assert `startedByRole` is `member` after an Undo. Retitle
  to "Undo returns a step to Ready" and assert all four Start columns are null.
- `test/integration/shop-agent-callables.test.ts`: role map, above.

E2E (`npm run test:e2e --`):

- `e2e/member-runs.member.spec.ts`, test "undo puts a finished step back in
  progress": the row now returns to Up next, not Mine. Rename to "undo puts a
  finished step back to Ready" and change the assertions and the JSDoc above
  it. Add a test "put back returns a started step to Up next for everyone":
  Start on Mine, Put back, assert Up next count and that a second member
  (the spec already seeds `MAKER` and `MATE`) sees it under Up next.
- `e2e/member-runs.member.spec.ts`, test "a done run's work page offers Undo
  on its last step": after Undo the step reads `Ready`, not `In progress`.
  Adjust.
- `e2e/orders.spec.ts`, test "the merchant marks a step done, reopens it, and
  blocks the run": after Reopen the Manage row reads Ready. Add a merchant
  put back: Mark done cannot produce a started-not-done step (there is no
  merchant Start), so have the member fixture Start it, or use the seed's
  `advance` + Start (`Domain` seed JSDoc mentions "Start what is ready so the
  run list shows In progress"). Then Put back from Manage and assert Ready.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm fmt` and keep
every file it touches. E2E needs the dev server (`pnpm app:dev`) and the
seeded shop; see `CLAUDE.md`. Chrome MCP (`mcp__chrome-devtools__*`) is
available for looking at the pages at `http://localhost:$(pnpm port)` if a
screenshot helps; the member page is
`/shop/<shop>/workflows/<runId>` and the merchant order page is
`/app/orders/<orderId>` inside the embedded admin.

Do not commit.

## 9. Deviations and issues

Record here, as you go: anything done differently from the plan and why;
anything the plan got wrong about the code; tests that could not be made to
pass and what they said; and questions for the reviewer. One bullet each.

- `recomputeStatus` already derives `pending` / `active` from the steps (`active` when any step is started or finished), so a put-back only started step returns the run to `pending` with no change. Covered by the repository test "Put back clears the Start record of an in-progress step".
- Run list (`shop.$shop.index.tsx`): Put back is on every row with a started step, not only Mine rows. The menu is built per step, not per tab, and decision 6.2 (whole team) means a row a teammate started (Teammates tab) should offer it too. A row with several ready steps gets one `Put back · <step>` item per started step, beside its `Done · <step>`.
- The run list's rows are all open, ready and on the member's teams, so the only extra gate the menu needs is the flag, which already returns early with the lift-flag item alone.
- Member `NotReady` copy (`useMemberRunActions.ts`) named only "someone finished an earlier step"; reworded to "This step or an earlier one changed just now, or this step is waiting on another team. Refresh." so it reads for a raced Put back. Merchant copy became "That step changed just now, or a step in an earlier stage is still open."
- The merchant blocker sentence now reads "… already started — put it back or reopen it first" (was "reopen it first"), since Reopen alone cannot clear an in-progress blocker. `e2e/orders.spec.ts` pins the new text. The plan asked for a sentence in the comment; the rendered text needed to change too.
- `Domain.runIsFlagged` JSDoc and the `RunFlag` table said "Start and Done are refused"; both now include Put back.
- Repository tests do not observe publishing, so "republishes Ready" is asserted as `getRunView` reporting the step `ready` again; the E2E test covers the push to a second member.
- Added a repository test "the merchant puts back a member's Start" and a merchant `RunFlaggedError` assertion, beyond the plan's list.
- E2E merchant Put back uses the seed's `started: true` on a one-step workflow (order `#9304`) rather than a member browser.
- The work page after Undo was not checked with a screenshot; the E2E test "a done run's work page offers Undo on its last step" asserts the `Ready` badge, the "Reopened by" line, Start offered and no in-progress line.
- `e2e/member-runs.member.spec.ts`: tab-count assertions on an empty Mine need `exact: true`, because the empty state renders a "Go to Up next · N" button that also matches.
- First full E2E run: 50 passed, 2 failed, 3 skipped (serial mode). Neither failure was caused by this change. Both were real app bugs, investigated and fixed at the user's request after the Put back work was done; see section 10.

## 10. Out-of-scope fixes made during this work

The user asked for these after the first full E2E run. They are unrelated to step ownership and are recorded here so a reviewer can judge them separately. Final state after both fixes: `pnpm typecheck` and `pnpm lint` clean, `pnpm test` 400/400, full `npm run test:e2e --` 55/55.

### 10.1 Server-rendered Polaris tables rendered no rows

- **Symptom.** `e2e/admin.admin.spec.ts` "shops lists installed shops, filters by domain, and drills into one" failed on every run: it timed out clicking the shop's link in the `/admin/shops` table. A person on that page saw the same thing: headers, no rows. The `s-table-row` elements were in the DOM, so the test's `row.count() > 0` check passed and the click then found nothing clickable.
- **Cause.** `src/routes/__root.tsx` loaded `https://cdn.shopify.com/shopifycloud/polaris.js` at the end of `<body>`. By then the server-rendered table is fully parsed, so when Polaris calls `customElements.define`, existing elements upgrade in _define_ order, not document order. Logged in the browser on 2026-09-22, that order is `s-table-row > s-table-cell > s-table-body > s-table > s-table-header > s-table-header-row`. A row reads its layout (`table` or `list`) and its column headers from the enclosing `s-table` through a context lookup when it upgrades. With no `s-table` upgraded yet, it gets the defaults (`list` layout, no headers), renders an empty `<section class="list-container">`, and never re-resolves. It stayed empty even when moved into a working table. The header row is defined after `s-table`, so it rendered correctly, which is why the headers showed and the rows did not.
- **How it was pinned down.** A fresh `s-table` built on the same page rendered fine, and a fresh row added to the page's own table rendered fine. The server-rendered row stayed broken wherever it was put, and viewport width made no difference. The row `id` containing dots was ruled out. Wrapping `customElements.define` in a Playwright init script gave the define order above.
- **Why it passed before.** Not proven. `polaris.js` is loaded unversioned from Shopify's CDN, the admin route files did not change after the test was added (commit `d033e15`, 2026-09-18), and the likeliest explanation is that Shopify changed the define order since then.
- **Fix.** `polaris.js` now loads in `<head>`, after `<HeadContent />` so App Bridge (rendered there by the `/app` route's `head.scripts`) stays the document's first script tag, as App Store requirement 2.2.3 needs. Elements now upgrade as the parser reaches them, parent before child. The JSX comment at the script tag in `__root.tsx` states this so it is not moved back.
- **Reach.** Any server-rendered `s-table` was exposed, not only the admin console: `app.orders.index`, `app.teams.index`, `app.teams.$teamId`, `app.workflows.index`, `app.members`, and the two admin object consoles all render `s-table-body`. Their tests passed because their rows happened to render on the client, or the tests did not look at the rows.
- **Not checked.** A sync script in `<head>` blocks parsing until `polaris.js` loads. That is Shopify's documented setup and made no visible difference locally. Load time over a tunnel or in production was not measured.

### 10.2 Add member submitted an empty email

- **Symptom.** `e2e/members.spec.ts` "members screen adds, staffs, normalizes, and removes a member" failed in full-suite runs and passed alone. The second Add left the dialog open showing "Email is required", and the dialog then blocked the next click ("Edit teams") until the 120s timeout.
- **Cause.** The Add member `s-modal` in `src/routes/app.members.tsx` called `form.reset()` in `onShow`. The `show` event can fire after the field has already taken input (the test fills it immediately after opening; a fast typist can too), and the reset wiped it. The test's asserts after the second Add (row count 1, chip visible) were already true before the Add, so they did not catch the refusal.
- **Fix.** Reset moved to `onAfterHide`, so the form is cleared on the way out and opening the dialog never touches input. The form starts empty, so the first open needs no reset. Verified 3/3 runs alone and in the final full suite.

### 10.3 Other modals with the same pattern, not touched

These reset or seed their form state in `onShow`, so the same race could wipe what someone typed or selected. None has failed a test yet. Left as they are.

| modal               | file                                       | what `onShow` does                                             | note                                                                                                                                                              |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create team         | `src/routes/app.teams.index.tsx`           | `form.reset()`, clears the name error                          | same shape as Add member; `onAfterHide` works                                                                                                                     |
| Rename team         | `src/routes/app.teams.$teamId.tsx`         | `form.reset({ name: team.name })`                              | seeds from current data, so moving the reset to `onAfterHide` alone would leave the first open empty; seed the form's defaults from `team.name` and reset on hide |
| Add members to team | `src/routes/app.teams.$teamId.tsx`         | clears the search query and the selection                      | a search typed or a box checked before `show` would be lost                                                                                                       |
| Create workflow     | `src/routes/app.workflows.index.tsx`       | `resetCreateForm` (name, tag, errors)                          | plain reset; `onAfterHide` works                                                                                                                                  |
| Duplicate workflow  | `src/routes/app.workflows.$workflowId.tsx` | `seedDuplicateForm` (suggested name and tag from the workflow) | seeds from current data, same caveat as Rename team                                                                                                               |

`src/components/WorkflowSwitch.tsx` also uses `onShow`, but only to set an open flag; it clears no input and is not at risk.
