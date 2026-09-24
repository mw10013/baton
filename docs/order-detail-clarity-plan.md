# Order detail clarity: implementation plan

Hand-off plan for the decisions in `docs/order-detail-clarity-research.md` (sections 1 to 7, decided 2026-09-23 and 2026-09-24). Read that doc's "Summary" table and section 7 ("Iteration 2") first. This plan is self-contained otherwise.

Three files carry the change: `src/routes/app.orders.$orderId.tsx`, `src/routes/shop.$shop.workflows.$runId.tsx`, and a new `src/components/RunSteps.tsx`, plus the e2e specs that name the old controls. No schema, no Domain rule, no server change, no migration. `Domain.WorkflowLimits` and `Domain.NAME_MAX_LENGTH` are not touched.

The implementing agent may use the Chrome DevTools MCP (`mcp__chrome-devtools__*`) to look at the pages against local dev. Open `http://localhost:$(pnpm port)/app/orders/<legacyId>` inside the Shopify admin the way `e2e/app.ts` does, or run the orders e2e project headed. Screenshots are required at the end of phase 3 and phase 5; see "Look at it".

## The change in one paragraph

Today the merchant order page names its facts by position: a `tags:` fragment under the item, a spelled-count sentence listing every matching workflow with its tag, an unlabelled grid of customer attributes, a run line that repeats the item title as the workflow name, a "now" line of middle-dot fragments (step, task, team), and a Manage drawer whose rows are either a bordered box or a one-line string and which renders an empty "Assign team" select on every open task. After the change: the tags line is gone; the ambiguous item says "More than one workflow matches this item, so none was started." over a select of every active workflow, matched first, with a Start button; the attribute grid has a "Properties" heading; the run line is the status badge and "Step k of n · task names"; and Manage opens with a "<workflow name> workflow" header line over the same step cards the member run page draws (a `Step n` caption, one bordered box per step, parallel tasks separated by rules, each task as name and badge, team on its own line, then buttons), with the merchant's buttons (Mark done, Put back, Reopen, Reassign) and a tertiary Reassign that reveals the team picker on demand. The step cards move to a shared `RunSteps` component that both pages render.

## Target render

Card at rest, item with a live run:

```
Leather journal                                          [ Manage ˅ ]
× 1 · SKU LJ-A5

Properties
Initials   T.W.

[Not started]  Step 1 of 3 · Cut leather
```

Ambiguous item (no run, two or more matched):

```
Engraved cutting board
× 1

Properties
Engraving   Rush — Dad's birthday

More than one workflow matches this item, so none was started.
Workflow  [ Choose workflow            ▾ ]  [Start]
```

Manage open:

```
Leather journal workflow

Step 1
┌────────────────────────────────────────────┐
│ Cut leather                        Ready   │
│ Leather                                    │
│ [Mark done] [Reassign]                     │
└────────────────────────────────────────────┘

Step 2
┌────────────────────────────────────────────┐
│ Stamp monogram                             │
│ Engraving                          Reassign│
├────────────────────────────────────────────┤
│ Stitch spine                               │
│ Leather                            Reassign│
└────────────────────────────────────────────┘

Step 3
┌────────────────────────────────────────────┐
│ Condition and inspect                      │
│ Leather                            Reassign│
└────────────────────────────────────────────┘
─────
[Block] [Cancel run] [Change workflow] [Add note]
```

Reassign pressed on "Stamp monogram":

```
│ Stamp monogram                             │
│ [ Engraving                ▾ ] [Assign] [Cancel]
```

Done task, with a blocker:

```
│ Cut leather                        Done    │
│ Leather · Merchant · 2:11 PM               │
│ Can't reopen: Stamp monogram (Engraving) already started — put it back or reopen it first
```

Unchanged: the blocked strip on the card, the attention rows on the card (deleted team, empty team), the cancelled run's badge and Undo cancel, the Order details aside, the run note block, the modals.

## Order of work

Run `pnpm typecheck && pnpm lint` after every phase. Run `pnpm test` after phase 2. Run the e2e projects named in phase 6. Run `pnpm fmt` at the end and keep every file it touches.

### Phase 1: copy and cuts on the order page

All in `src/routes/app.orders.$orderId.tsx`. No new component yet.

1. **Tags line.** In `facts` inside `renderLineItem`, delete the `tags:` entry and its condition. Rewrite the JSDoc above `facts`: quantity and SKU only; the tags were "why a workflow matched" and the picker's option list is that answer now.
2. **Ambiguity sentence.** Delete `SPELLED`, `nameList` and the JSDoc that explains them. Replace `ambiguitySentence` with a constant string, `"More than one workflow matches this item, so none was started."`. Keep the `s-paragraph` where it is. Rewrite the JSDoc: the sentence says why the merchant is being asked and nothing that can drift from the select under it; it does not count, because a count that must agree with a list is a second source of truth; it does not name the tags, because the merchant changes the workflow, not the product, from here.
3. **Ambiguous select options.** In `options`, the `ambiguous` branch returns every workflow in `itemWorkflows` with the matched ones first: `[...matched, ...itemWorkflows.filter(w => !matched.some(m => m.id === w.id))]`. Between the two groups render one disabled `s-option` with value `""` and label `"—"`; if the disabled option does not render as a separator in the browser (check in phase 3), remove it and keep the ordering alone, and say so in "Deviations". Rewrite the `renderLineItem` JSDoc's **ambiguous** bullet: the picker offers every active workflow, the matches first, because the item has no Manage and the select is the only way to a workflow the tags did not pull in.
4. **Button label.** `actionLabel` returns `"Start"` for both the ambiguous and the no-run case; keep `"Change"` for the live-run case. Delete the sentence in the JSDoc that distinguishes Choose from Start.
5. **Properties heading.** Above the `customAttributes` grid, add `<s-text color="subdued">Properties</s-text>` (or `s-heading` at the smallest size if `s-text` reads too light beside the grid; decide in phase 3 and record it). Wrap the heading and grid in one `s-stack gap="small-300"` so they read as a block. Add a comment: "Properties" is Shopify's merchant-facing name for line item `customAttributes` (Help Center and theme docs say "line item properties"; the API says `customAttributes`), shortened because the heading already sits inside the line item's card.
6. **Workflow name off the card.** In `renderRun`, remove the `s-text type="strong">{run.workflowName}` from the header stack. The badge and any flag badge, Dismiss, and Undo cancel stay in that stack. Rewrite the `renderRun` JSDoc: the card is headed by the line item; the workflow's name is the Manage drawer's header (phase 2) because the merchant who wants it is the one who opened Manage, and on a shop whose workflows are named after products the card would otherwise print one string twice.
7. **Team off the now line.** In `nowLine`, drop `teams` from the returned string: `Step k of n · <task names>` and the `since` suffix as today. Delete the `teams` binding. Rewrite the JSDoc's description of the line: position and task names only; the team is inside Manage, on its own line under the task, where a 64-character team name has room. Keep the paragraph explaining why this is a second phrasing beside the Manage task line, but point it at `RunSteps` (phase 2) instead of `manageStateLine`.

### Phase 2: the shared step cards

1. **Create `src/components/RunSteps.tsx`.** Move from `src/routes/shop.$shop.workflows.$runId.tsx`:
   - `taskState` and its JSDoc, unchanged in behaviour. It takes `Domain.WorkflowRunTask & { ready: boolean }`; the member page's `Domain.RunTaskView` already has `ready`, and the order page computes it from `Domain.readyTasks` (see step 3).
   - The step loop (the `s-stack accessibilityRole="ordered-list"` over `WorkflowLayout.stepsOf`, the `Step n` caption, the bordered `s-box` per step) and the per-task row shape from `renderTask` (the `s-box padding="small"` with the top rule on every task but the first, the name-and-badge line, the state line, the reopened line, the instructions line, the button row).
   - Export one component, `RunSteps`, with props: `tasks: readonly T[]` where `T extends Domain.WorkflowRunTask & { readonly ready: boolean }`; `renderActions: (task: T) => React.ReactNode` returning the button row's contents or null; `renderExtra?: (task: T) => React.ReactNode` returning content rendered after the state line and before the buttons (the order page uses it for the Reassign picker and the "Can't reopen" sentence; the member page passes nothing). Whether instructions are shown is a prop too, `showInstructions: boolean`, because the member page shows them and the merchant page does not today; keep that difference and say why in the JSDoc (the merchant reads the workflow page for instructions; the worker reads them here).
   - The module JSDoc states the rules both pages agree on, once, in the words of the member run page research: one caption and one box per step; parallel tasks share the box separated by rules; the badge states the task's state and the line never repeats it; the team leads the subdued line because task and team names are both merchant text and side by side they read as one noun phrase; a waiting task has no badge and its line is the team alone. Each page's route JSDoc `{@link}`s these rather than restating them.
2. **Member page.** `shop.$shop.workflows.$runId.tsx` renders `<RunSteps tasks={view.tasks} showInstructions renderActions={...} />`, passing the existing Start, Done, Put back, Undo buttons from `renderTask`. Delete `taskState`, `renderTask`, and the step loop from the route. Keep the JSDoc that says the buttons follow `Domain.taskActions`; it is about this page's buttons, not the card shape.
3. **Order page Manage.** In `manageRows`, replace everything above the run-action `s-divider` with `<RunSteps tasks={...} renderActions={...} renderExtra={...} />` under a header line `<s-text type="strong">{`${run.workflowName} workflow`}</s-text>`. Build the task list as `tasks.map(task => ({ ...task, ready: readyIds.has(task.id) }))` using the existing `readyIds`.
   - `renderActions(task)`: Mark done (when `task.ready && !Domain.runIsFlagged(run)`), Put back (when ready, started, not flagged), Reopen (when completed and `Domain.undoBlockedBy` returns null), and Reassign (when `open && task.completedAt === null && reassigning !== task.id`). All `variant="secondary"` except Reassign, which is `variant="tertiary"`. Same disabled conditions as today (`!identified || busy`).
   - `renderExtra(task)`: when the task is completed and blocked, the existing "Can't reopen: …" `s-text` and its comment; when `reassigning === task.id`, the picker (step 4).
   - Delete `manageStateLine` and the one-line waiting form. Delete `stepCount` if `nowLine` is its only remaining caller and inline it there; otherwise keep it.
4. **Reassign picker.** Add state `reassigning: string | null` (a run task id) beside `assignChoice`. The existing `assignTeam(runTaskId)` grid gains a third column, a `variant="tertiary"` Cancel button that sets `reassigning` to null and clears `assignChoice[runTaskId]`. On a successful `assignMutation` also set `reassigning` to null (in the mutation's `onSuccess`, next to the existing invalidate). The picker's `s-select` keeps its `label="Assign team"` with `labelAccessibilityVisibility="exclusive"` and placeholder `Assign team`, so the e2e locator by combobox name still works. Rewrite the `assignTeam` JSDoc: it renders in two places, the attention row (open by default, because a task with no team is the one thing on the card that must be acted on) and a Manage task row after Reassign is pressed (closed by default, because a task that has a team is a fact, and four open selects on a run whose tasks are all assigned read as four unanswered questions).
5. **Manage rows JSDoc.** Rewrite the `manageRows` JSDoc: the drawer is the member page's step cards with the merchant's buttons, `{@link RunSteps}` for the shape; the header line names the workflow because the card does not; the run-level actions follow under a rule. Keep the paragraphs about the Reopen verdict being computed here, no Start, and no primary button. Delete the paragraph about a task with no state rendering as one line.

### Phase 3: look at it

Seed a worst case before looking: a workflow with 20 tasks across at least four steps with one parallel step, task names and team names at 64 characters, and an order with three line items of which one is ambiguous, one has a run in step 2 with a done step 1, and one has no matching workflow. `pnpm seed` and `e2e/seed.ts` are the starting points; if the seed cannot express this, add a fixture in the e2e seed rather than hand-editing the object.

Open the order with the Chrome DevTools MCP or a headed e2e run and take screenshots of:

1. The page at rest, all three cards.
2. Manage open on the running item, scrolled to the top and to the bottom.
3. Reassign pressed on a waiting task.
4. The ambiguous item's select open.

Compare each with "Target render". Decide the three things this plan leaves to the browser and record each in "Deviations": whether the disabled `s-option` separator renders acceptably (phase 1 step 3); whether the Properties heading is `s-text` or `s-heading` (phase 1 step 5); and whether the tertiary Reassign at the end of the team line sits on the same line or wraps under it at 64-character team names, and which you kept.

### Phase 4: JSDoc alignment

The rule in `AGENTS.md`: a behaviour more than one site agrees on is stated once on the symbol that is the concept, and other sites link it. Read each of these and rewrite or link; a stale description of the old layout is a defect.

- `src/components/RunSteps.tsx` module JSDoc: the one statement of the step card rules (phase 2 step 1).
- `src/routes/shop.$shop.workflows.$runId.tsx`: the route JSDoc and the comment above the steps section; both now `{@link RunSteps}` and keep only what is this page's own (which buttons, why none is primary, page-level banners).
- `src/routes/app.orders.$orderId.tsx`: `renderLineItem` JSDoc (ambiguous bullet, no-run bullet, the `facts` paragraph), `renderRun`, `nowLine`, `manageRows`, `assignTeam`, `attentionRows` (its sentence "every other intervention is inside Manage" still holds; its sentence about the picker being the remedy still holds). The `RouteComponent` JSDoc's summary of what the page shows should no longer mention tags.
- `src/lib/Domain.ts`: `OrderAttribute` JSDoc mentions "line-item personalization"; leave it, it is describing the data. If `OrderLineItem.productTags` JSDoc says the tags are shown on the order page, correct it: they are read for matching and shown nowhere on the order page now. Check `matchedWorkflowIds` JSDoc for the same.
- `src/components/MemberRun.tsx` module JSDoc: unchanged, unless it names `renderTask` or the step loop; if so, point it at `RunSteps`.
- `docs/member-run-page-plan.md` "Out of scope" names the order page as disagreeing with a decision; that disagreement is now resolved. Do not edit the doc; it is a record.

### Phase 5: member page check

Open a member run page (`/shop/$shop/workflows/$runId`) with the same seeded run and screenshot it. It must look the same as before phase 2 except for nothing; the shared component is a move, not a change. If a difference appears, it is a defect in the extraction.

### Phase 6: tests

- `e2e/orders.spec.ts`, the ambiguous-item test (around the `E2E Twice` item): the sentence assertion becomes `"More than one workflow matches this item, so none was started."`; the option count becomes the number of active workflows in the fixture shop plus one if the separator option is kept (count `getByRole("option")` excluding disabled, or assert the first two options are the matched ones by label); the button becomes `Start`. Update the comment above it.
- `e2e/orders.spec.ts`, the Manage tests (`E2E Manage Cuff` and the Put back, Reopen, Block tests): `Mark done` locators are unchanged. Add one assertion after Manage opens that no combobox named `Assign team` is visible until `Reassign` is pressed, then press `Reassign` on the first task, assert the combobox appears, press `Cancel`, assert it is gone. Add an assertion that the drawer shows the `Step 1` caption.
- Any test that asserts the workflow name is visible on the card after starting a run (the ambiguous test does: `item.getByText(ENGRAVING, { exact: true })`): the name is now inside Manage. Open Manage first, or assert on the `Manage` button's presence as the test's own comment already suggests is the real gate.
- Any test that asserts `tags:` text or the `Choose` button: none found by grep at plan time; confirm with `grep -rn "Choose\b\|tags:" e2e/`.
- `e2e/member-runs.member.spec.ts`: run the member project; nothing should change. `MINE_STATE = "Step 1 of 1"` is the run list row, not this page.
- Run: `npm run test:e2e -- --project=e2e` and `npm run test:e2e -- --project=member` (project names from `playwright.config.ts`).

## Out of scope

- Collapsing done steps to their caption (research 7d, Q15). Both pages together, later, after seeing the 20-task drawer.
- The Order details aside, the run note, the blocked strip, the attention rows, the modals: unchanged.
- The orders index row line (`Domain.runRowLine`), which has its own "Step k of n" form and is not this page.
- Raising `WorkflowLimits`.

## Deviations and issues

The implementing agent records here anything that differs from this plan or from the research decisions, with the reason, so the next reader does not have to diff the code against the plan. Also record the three browser decisions from phase 3 and the screenshots' paths.

Implemented 2026-09-24.

**Browser decisions (phase 3).**

- Separator option: kept. The disabled `s-option` renders as a greyed `—` row between the matches and the rest. Seeded option order: `WC Engraving, WC Rush, —, Leather journal…, WC Alpha, WC Bravo, WC Charlie`.
- Properties heading: `s-text color="subdued"`. It matches the attribute keys in weight and color, but it sits alone on its own line above the grid and reads as a label for the block. `s-heading` competed with the line item title above it.
- Reassign position: in the task's button row, not at the end of the team line. On a waiting task that row holds Reassign alone, directly under the team. At 64-character team names the team line wraps to two lines at phone width, and a trailing button beside it would have wrapped under it in any case. This differs from the target render, which puts Reassign at the right of the team line.

**Other deviations.**

- Select label and placeholder: "Choose workflow" for both the ambiguous item and the item with no run, per research 7a. Before this change the no-run select was named "Start workflow". The change picker keeps "Change workflow".
- `reassigning` is cleared only when the assign result is `Assigned`. On a refusal the picker stays open under the banner, so the merchant can pick another team.
- The `RunSteps` rules are in the `RunSteps` component's JSDoc, not in a module-level comment, so that `{@link RunSteps}` resolves to them.
- `stepCount` is kept because `nowLine` calls it twice.
- `Domain.sameActor` was deleted in review (2026-09-24): `manageStateLine` was its only caller, and the shared line in `RunSteps` names the completer without comparing it to the starter.
- More e2e edits than the plan listed. The Manage test read the deleted state lines ("Done by Merchant"), and the Put back test read "In progress since"; both now read the team line. The Manage test's final assertion is now `Done · 2 steps`, because "Done" alone matches three badges. `e2e/workflows.spec.ts` ("turning on a workflow offers…") asserted the workflow name on the card; it now opens Manage and reads the header line. Two comments in `e2e/fixture.ts` that quoted the old wording were updated.

**The worst-case order is now in the dev fixture.** The plan asked for the phase 3 worst case as an e2e fixture, if the seed could not express it. It was first seeded with a throwaway script, and it proved useful: it was the only data that showed how the Manage drawer and the member run page behave at the caps. We discussed it after implementation and decided to keep it in `e2e/fixture.ts`, so that `pnpm seed` always produces it. The additions are:

- A team named at 64 characters, `AT_CAP_TEAM`.
- A workflow at the caps: 20 tasks over 18 steps, with one 3-task parallel step and 64-character task and workflow names. It uses the tag `heirloom-journal`.
- Order `#1030` with three items: an ambiguous one (`board` and `rush`), one running the at-cap workflow in step 2 with step 1 done, and one that nothing matches.

No spec imports the fixture, so no test changed.

**Tests.** `pnpm test`: 417 passed. `npm run test:e2e -- --project=e2e` ran all 58 tests, including the member project. The first run had one failure, the `workflows.spec.ts` test above; after the fix, that test passes when run alone.

**Screenshots** (`logs/order-detail-clarity/`, gitignored). They use a worst-case seed: 20 tasks across 18 steps with one 3-task parallel step, 64-character task, team and workflow names, and three line items (ambiguous, running in step 2, unmatched).

- `1-rest.png`: all three cards at rest.
- `2-manage.png`: the full Manage drawer from the top to the run actions.
- `3-reassign.png`: Reassign pressed on the step 3 task.
- `5-phone.png`: the page at 390px width with Manage and a picker open.
- `member-before.png` / `member-after.png`: phase 5. The member run page before and after the extraction, on the same seeded run. `magick compare -metric AE` reports 0 differing pixels, and the `data-tsd-source` attribute confirms that the two renders came from the old route and from `RunSteps`.
