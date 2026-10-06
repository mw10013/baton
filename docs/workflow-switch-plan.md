# Plan: Active / Inactive, Flow's title bar, and the page note

Written 2026-10-06 from the seven decisions in `docs/workflow-switch-research.md`, all accepted.
It is for an agent that has not seen that research. Read its "Short answers" and "Decisions"
first. This plan does not repeat the reasoning. It says what to change, in what order, and how to
check it.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, normatively, in the JSDoc on the symbol that enforces it. Other sites
    `{@link}` it.
  - A label change starts at the vocabulary row; a control change starts at the row in
    `src/lib/Screen.ts`; a shape change starts at the parts table on `ScreenPart`, then the part,
    then the kit page, then the screens.
  - A stored literal in our own store is the vocabulary word; while prototyping, the DDL in
    `initializeSchema` is edited in place and `pnpm dev:reset` reseeds. No migration.
  - `pnpm spec check` holds the vocabulary's `stored` cells to the DDL, its screen columns to the
    label constants, and every `pinned by` cell to a test title. A renamed test and its cell
    change together.
  - Routes and components outside `src/components/screen/` lay out nothing. Spacing lives in a
    part.
  - JSDoc never cites `docs/`.
  - Run `pnpm fmt` and keep everything it touches. Do not commit unless told to.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` at the end of every phase. Run
  `pnpm dev:reset` after phase 1 (the check constraint changes, so stored rows are invalid). Run
  the e2e `workflows.spec.ts` and `orders.spec.ts` after phase 2, then `pnpm seed`.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go. Leave the section's heading in place
  even if it stays empty.

## The decisions, as work

| decision                                                       | phase |
| -------------------------------------------------------------- | ----- |
| 1 Active / Inactive stored as `active` / `inactive`            | 1     |
| 2 "active" is a shop-work word; the reserved stem goes         | 1     |
| 3 Title-bar badge in the default tone                          | 2     |
| 4 Index badge success / default, unchanged                     | none  |
| 5 Title-bar switch "Turn on workflow" / "Turn off workflow"    | 2     |
| 6 A page-note part for the "Last updated" line                 | 3     |
| 7 Filter All / Active / Inactive, `?state=active` / `inactive` | 1     |

## Phase 1: the words

One change, because the literal is the word: the row, the DDL, the SQL, the predicate, the label
constant, the filter, the screens, the tests.

1. **The state table** in the vocabulary block of `src/lib/domain/ShopWork.ts` (the "Workflow
   states, shop work" table, around line 88). Replace the two rows:

   ```
   | active   | new items get runs from it             | `active`   | Active   |
   | inactive | it creates nothing; open runs carry on | `inactive` | Inactive |
   ```

   Rewrite the paragraph under it. It currently says the badge says On and Off where Flow says
   Active and Inactive because "active" is not a shop-work word. It should say: the switch's words
   are Shopify Flow's, verb and state alike (Turn on, Turn off; Active, Inactive;
   `refs/flow-manual/manage/manage.md`, "Deactivate a workflow"), because the state word has to
   serve as an adjective and a filter label ("an active workflow", "only inactive workflows can be
   deleted"), which On and Off cannot. Keep the sentence about a run never being called a run on a
   screen.

2. **The verbs table** rows `turn on` and `turn off`: the `meaning` cells read `off → on` and
   `on → off`; make them `inactive → active` and `active → inactive`. The screen cells stay
   `Turn on` and `Turn off` (phase 2 adds the title-bar form beside them, not here).

3. **The Shared words table** in the map at the top of `src/lib/Domain.ts`. Add a row:

   ```
   | active | shop work, billing | "active workflow" (`workflowIsActive`), the switch's state; "active subscription", Shopify's word for an app subscription that bills (billing, not exported) |
   ```

   Check the billing context's vocabulary in `src/lib/domain/Billing.ts` for how it names the
   subscription state today and match that cell to it.

4. **The reserved stems** in `scripts/lib/rules-lint.ts`: delete the `active` row from the table
   and `"active"` from `RESERVED_STEMS`. Keep `activated`; reword its row to "nothing; the switch
   is `state`, `active` / `inactive`". `activated` is still a substring hit for
   `setWorkflowActivatedAt` and the test at `test/integration/rules-lint.test.ts` ("an export
   named setWorkflowActivatedAt is refused", around line 343) still passes. The fixture in the
   first test of that describe (around line 303) expects `isActive` to be a hit; with `active`
   gone it would be a hit only through the `is<State>` rule, which is a different check, so
   change that fixture line to another reserved stem (for example `export const isTier`) and keep
   the expected list's shape. Also change the fixture's `workflowIsOn` line to
   `workflowIsActive`, which must not be a hit.

5. **The predicate, literals and label constant**, all in `src/lib/domain/ShopWork.ts`:
   - `WorkflowState = Schema.Literals(["active", "inactive"])`.
   - `WORKFLOW_STATE_LABEL = { active: "Active", inactive: "Inactive" }`.
   - `WorkflowsIndexState = Schema.Literals(["active", "inactive"])`; its JSDoc keeps "Keyed
     `?state=`".
   - `workflowIsOn` becomes `workflowIsActive`, body `workflow.state === "active"`, JSDoc
     "Active: `state` is `active`. The one read of the switch, so no caller compares the column on
     its own."
   - The `Workflow` JSDoc: "name, type, tag, tasks, On / Off" becomes "Active / Inactive";
     "**Turn on** / **Turn off** set `state` to `on` and `off`" becomes "to `active` and
     `inactive`"; every "a workflow that is on", "on implies", "on and off alike" becomes
     "active", "active implies", "active and inactive alike". Grep the file for ` on\b` and
     ` off\b` used as states and read each hit; the verbs (turn on, turn off, turn-on) stay.
   - `SetWorkflowOnInput { workflowId, on: boolean }` becomes `SetWorkflowStateInput
{ workflowId, state: WorkflowState }`. Grep `SwitchResult`'s JSDoc for "on".
   - The reconcile triggers table on `reconcileItem` (around line 2630): the `Turn on` and
     `Turn off` rows keep their trigger names; the `skipped when` cells `workflow off` become
     `workflow inactive`; the `pinned by` cell "a workflow that is on creates runs on every stored
     open paid order, however old it is" becomes "an active workflow creates runs on every stored
     open paid order, however old it is", and "retagging an on workflow reconciles stored orders
     against the new tag" becomes "retagging an active workflow …". Rename those tests in step 11.

6. **The DDL** in `src/lib/ShopAgentSchema.ts`:
   `state text not null check (state in ('active', 'inactive'))`. The comment above it stays. The
   data-model table rows that say "turning a workflow off" keep the verb; the draft row's "an edit
   after turn-on still starts the workflow's tasks; apply while on replaces them" has "while on"
   as a state: make it "while active" in the cell and in the test title it pins
   (`test/integration/run-repository.test.ts`, around line 3033). Same for "apply refuses an empty
   draft and an unassigned task, on and off alike" → "active and inactive alike" (cell and title,
   `workflow-repository.test.ts` around line 1699).

7. **The repository**, `src/lib/WorkflowRepository.ts`:
   - `where state = 'on'` (line 25 and around line 1008) → `'active'`; the insert literal `'off'`
     (around line 865) → `'inactive'`; `sql\`state = 'on'\``in`applyAndTurnOn`→`'active'`.
   - `setWorkflowOn({ workflowId, on, teams })` becomes
     `setWorkflowState({ workflowId, state, teams })`: eligibility is required when
     `state === "active"`; it is the one place beside the predicate that may compare the literal,
     so write it as `Domain.workflowIsActive({ state })` to keep the rule in one place. The
     interface JSDoc ("The on/off switch. On requires … writes `state = 'on'` … Off writes
     `state = 'off'`") is rewritten with the new literals; keep its reasoning about open runs.
   - `replaceWorkflows`' fixture shape has `on?: boolean` (around lines 1040 to 1132). Make it
     `state?: WorkflowState`, default `active`; the insert writes `workflow.state ?? "active"`.
     Its JSDoc and the checks around lines 1058 and 1069 ("on with zero tasks", "on with an
     unassigned task") read `workflowIsActive`.
   - `src/lib/OrderRepository.ts` line 175 `where w.state = 'on'` → `'active'`.
   - `src/lib/RunRepository.ts`: grep for "Turn on", "on workflow" in JSDoc and reword states only.

8. **The agent and the callable**:
   - `src/lib/agent/ShopWork.ts`: `setWorkflowOn` becomes `setWorkflowState`, taking
     `Domain.SetWorkflowStateInput`; the log line becomes
     `ShopAgent.setWorkflowState: shop=… workflowId=… state=${state}` with `{ shop, workflowId, state }`
     annotated; the `reconcileAllNow("setWorkflowOn", …)` reason string becomes
     `"setWorkflowState"`. `applyAndTurnOn` keeps its name (it is the verb). The guard at line 935
     reads `workflowIsActive`. The export list at the bottom (around line 2141) follows.
   - `src/lib/ShopAgent.ts`: the `@callable` `setWorkflowOn` becomes `setWorkflowState`, decoding
     `Domain.SetWorkflowStateInput`; the JSDoc "The on/off switch" becomes "The switch". Check
     the sites table on `ShopAgent.publish` for a row naming `setWorkflowOn` and rename it there;
     `pnpm spec check` parses that table.
   - Any `ShopAgentClient` or socket client type that lists the callables by name follows.

9. **The screens**, states only (labels in phase 2):
   - `src/components/WorkflowSwitch.tsx`: the mutation input becomes
     `{ state: Domain.WorkflowState }`; `stub.setWorkflowState({ workflowId, state })`;
     `appliesFirst` applies when `state === "active"` — write it as the predicate. The JSDoc's
     "on/off switch" becomes "switch"; "a workflow that is off has a draft" → "an inactive
     workflow has a draft".
   - `src/routes/app.workflows.$workflowId.tsx`: `const on = …` becomes `const active =
Domain.workflowIsActive(workflow)`; `WORKFLOW_STATE_LABEL.active` / `.inactive`; JSDoc
     "the on/off switch" → "the switch", "a workflow that is off" → "an inactive workflow".
   - `src/routes/app.workflows.$workflowId_.edit.tsx`: `workflowIsActive`; JSDoc "the plain
     on/off switch" → "the plain switch", "no on/off control" → "no switch".
   - `src/routes/app.workflows.index.tsx`: `stateBadges` reads `workflowIsActive` and the two
     labels; the filter buttons become
     `stateButton(Domain.WORKFLOW_STATE_LABEL.active, "active")` and `inactive`. The comment
     about "the Turn on / Turn off buttons" stays.
   - `src/routes/app.workflows.tsx` JSDoc: "On and Off are workflow states" → "Active and Inactive
     are workflow states".
   - `src/lib/workflowShared.ts`: `APPLY_BODY` "This workflow is on, so the changes take effect
     now." → "This workflow is active, so the changes take effect now."; the JSDoc "once the switch
     is on" → "once the workflow is active".
   - `src/routes/app.orders.$orderId.tsx` line 77: "That workflow can't start: it's off, has no
     steps, or has a task with no team." → "it's inactive, has no steps, …". If an e2e asserts
     this string, change it there too.
   - `src/lib/Screen.ts`, the tone list's contraction examples: "it's off" is given as an example
     of a contraction. Change it to "it's inactive" so the example is still a string a screen
     shows.

10. **The seed and the fixtures**: `e2e/fixture.ts` lines 261 and 354 (`on: false`, `on: true`)
    become `state: "inactive"` / `state: "active"`, and the comment "seeded off so the list has an
    'Off'" becomes "seeded inactive so the list has an Inactive". `src/routes/api.dev.seed.ts` and
    any test helper that builds `replaceWorkflows` input follow (`test/integration/
list-reads-rows.test.ts`, `list-memo.test.ts`, `run-repository.test.ts`,
    `workflow-repository.test.ts`).

11. **The tests**. Rename symbols mechanically (`workflowIsOn`, `setWorkflowOn`,
    `SetWorkflowOnInput`, `on:` fixture fields, `state: "on"` literals in `domain.test.ts` and
    `order-repository.test.ts`). Then the titles: where a title uses on / off as a state, use
    active / inactive; where it uses the verb, leave it. Every title the spec tables pin must
    change with its cell (steps 5 and 6). Titles seen in a grep on 2026-10-06 that carry the state
    word:
    - `workflow-repository.test.ts`: "creates … lands off with no draft" → "lands inactive";
      "createWorkflow refuses a tag another workflow holds, on or off" → "active or inactive";
      "Turn on and Apply ignore tags: two workflows that are on" → "two active workflows";
      "promotes the draft and turns the switch on; refuses an empty workflow and leaves it off" →
      "leaves it inactive" (also pinned on the reconcile table's Apply row and in
      `shop-agent-workflows.test.ts` line 314: change all three); "create → no tasks, its tag, no
      draft, off, …" → "inactive"; "apply while on replaces the tasks in place" → "while active";
      "turn on writes state on; off writes off" → "turn on writes active; turn off writes
      inactive"; "seed: on defaults, explicit off, …" → "active defaults, explicit inactive".
    - `run-repository.test.ts`: "a workflow that is on creates runs …" → "an active workflow
      creates runs …" (pinned); "an edit after turn-on still starts …; apply while on replaces
      them" → "while active" (pinned on the draft row).
    - `domain.test.ts`: "an off workflow or one with an unassigned task is not a match" → "an
      inactive workflow".
    - `rules-lint.test.ts`: step 4.
    - `instrumentation.test.ts` ("instrumentationIsOn is on") is not a workflow; leave it.

12. Run `pnpm vocab:audit` and confirm neither `on` nor `off` appears as a state word in an
    exported identifier; confirm `active` is now listed as a vocabulary word, not an audit hit.

Then `pnpm dev:reset`.

## Phase 2: the title bar

13. **The controls table** in the JSDoc on `Control` (`src/lib/Screen.ts`). Add a row after
    "More actions with one entry":

    ```
    | a verb in the title bar | the button names its noun: Turn off workflow, Create team, Add member; Edit alone, because the noun is the page; a menu entry and a modal primary are the verb alone (Rename, Delete; Turn off, Delete) | a verb-alone switch beside Edit; a noun on a menu entry |
    ```

    Check the existing "creating a thing" and "deleting a thing" rows agree with it: the create
    row already says "+ <noun> in the title bar"; the delete row puts Delete in the menu (the
    workflow page) or on the page, verb alone, with primary Delete. If a details page shows Delete
    as a title-bar button today, it is not this change's business; note it under Deviations and
    issues instead.

14. **The label.** In `src/lib/domain/ShopWork.ts`, give `VERB_LABEL`'s value type a third,
    optional field, `titleBar?: string`, and set it on the two rows:
    `turnOn: { member: null, merchant: "Turn on", titleBar: "Turn on workflow" }` and the same for
    `turnOff`. The `satisfies Record<Verb, …>` type gains the optional field. `scripts/lib/spec.ts`
    reads `member` and `merchant` only (`ScreenLabels.verbs`), so the verbs table's screen column
    still equals the constant; widen that interface's value type with the same optional field so
    `scripts/spec.ts` typechecks. Add a sentence under the verbs table: "A verb's title-bar form,
    when it differs, is `titleBar` on {@link VERB_LABEL}: the switch reads Turn on workflow and Turn
    off workflow in the title bar and Turn on, Turn off as the modal primary (the controls table in
    `Screen.ts`)." If the spec parser cannot be widened without touching its table-compare code,
    fall back to a separate constant `SWITCH_TITLE_LABEL = { turnOn: "Turn on workflow",
turnOff: "Turn off workflow" }` beside `VERB_LABEL`, with the same sentence, and record the
    fallback.

15. **The switch**, `src/components/WorkflowSwitch.tsx`: the two title-bar buttons read
    `Domain.VERB_LABEL.turnOff.titleBar` and `.turnOn.titleBar`; the modal primaries keep
    `.merchant`. The JSDoc names the controls-table row.

16. **The badge tone**, `src/routes/app.workflows.$workflowId.tsx`: the Active accessory badge
    drops `tone="success"`; both state badges are `<s-badge slot="accessory">`. Add to the route's
    header JSDoc: the title-bar badge carries no tone because the primary button beside it already
    carries the state's colour (critical Turn off workflow, primary Turn on workflow); the index
    badge is green because there it is the only signal. The Draft badge stays `info`. The index
    (`app.workflows.index.tsx`) is unchanged.

17. **e2e**, `e2e/workflows.spec.ts` and `e2e/orders.spec.ts`. Playwright's `getByRole("button",
{ name: "Turn on" })` matches by substring, so once the title bar says "Turn on workflow" and
    the open modal says "Turn on", the non-exact selector hits two buttons. Make every title-bar
    selector `{ name: "Turn on workflow", exact: true }` / `"Turn off workflow"` (lines 171, 195,
    202, 308, 313, 350, 352 on 2026-10-06) and leave the modal selectors, which already pass
    `exact: true` with the verb alone (199, 312, 351). Read the file's header comment (lines 38 to 61) and reword "Turn on", "Turn off" where it names the title-bar button. The `OFF` constant
    (line 542) is a workflow name and stays.

Run the admin e2e project: `npm run test:e2e -- e2e/workflows.spec.ts e2e/orders.spec.ts`, then
`pnpm seed`.

## Phase 3: the page note

18. **The parts table** on `ScreenPart` (`src/lib/Screen.ts`). Add a row after `page body`:

    ```
    | page note      | one subdued line between the title bar and the first card: Last updated on the workflow page | `PageNote`                          | `base` below it; the line's own column, lined up with the cards                                            | details                           | a second line; a sentence that belongs in a card    |
    ```

    Also add `pageNote` (or the table's naming convention for part keys) to the `ScreenPart`
    literals if the schema lists every row; `pnpm spec check` parses the table and will say.

19. **The part**, `src/components/screen/PageNote.tsx`: renders its children in an
    `s-paragraph color="subdued"` inside a box with `paddingBlockEnd={BETWEEN_THINGS}` from
    `./layout` (or a stack whose gap is `BETWEEN_THINGS`, whichever the sibling parts use for a
    single distance; look at `PageBody.tsx` and `Things.tsx` and copy their mechanism). JSDoc:
    names its row; the reasoning is that Polaris `s-page` leaves only its default distance between
    a paragraph and the first `s-section`, which reads as the line sitting on the card, and Flow's
    workflow page leaves a full distance there.

20. **The kit page**, `src/routes/dev.kit.tsx`: one `PageNote` with the seed's worst case, a
    "Last updated on" line with a `LocalDateTime`, above a details card, in the section where the
    other details parts are shown.

21. **The screen**, `src/routes/app.workflows.$workflowId.tsx`: replace the bare
    `<s-paragraph color="subdued">Last updated on …</s-paragraph>` with `<PageNote>Last updated on
<LocalDateTime value={workflow.updatedAt} /></PageNote>`. Nothing else moves: the line stays
    aligned with the card, the date format stays.

22. Look at the page on the dev store at the three widths the kit page uses (or the browser's
    phone emulation) and at `/dev/kit`, and confirm the distance below the line equals the
    distance between two cards.

## Checks

- `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`, `pnpm fmt`.
- `pnpm spec print`: the Workflow states rows read `active` / `inactive` with screen Active /
  Inactive; the Verbs rows `turn on` / `turn off` unchanged on screen.
- `grep -rn "workflowIsOn\|setWorkflowOn\|SetWorkflowOnInput\|'on'\|\"on\"" src test e2e scripts`
  returns nothing about a workflow (an `on` that is an event name or English is fine).
- `grep -rn "\bOn\b\|\bOff\b" src/routes src/components src/lib/workflowShared.ts` returns no
  badge or filter label.
- The dev store after `pnpm dev:reset`: the workflows index filter reads All, Active, Inactive;
  the Clock assembly page shows a grey Active badge, Edit, More actions and a red Turn off
  workflow; Turn off workflow opens "Turn off workflow?" with primary Turn off; after it, the badge
  reads Inactive and the primary reads Turn on workflow; the "Last updated" line has a card's
  distance below it.
- `pnpm vocab:audit` lists no `on` / `off` state word.

## Deviations and issues

Record here, as you go, every departure from the plan and every problem found, each with what was
done about it. Leave this heading in place even if nothing is recorded.

Implemented 2026-10-06. `pnpm typecheck`, `pnpm lint`, `pnpm test` (762) and the e2e
`workflows.spec.ts` + `orders.spec.ts` (27) pass; `pnpm dev:reset` after phase 1, `pnpm seed`
after the e2e runs.

1. **Step 3, the billing cell.** Billing's vocabulary has no "active" and no identifier carries
   Shopify's `ACTIVE`; its word is "app subscription". The Shared words row says so: "active app
   subscription", Shopify's word for one that bills, which billing calls the app subscription and
   no Baton identifier names.
2. **Step 5, the vocabulary paragraph** cites `refs/flow-manual/manage/manage.md`, "Deactivate a
   workflow", as the plan says; the old paragraph cited `manual.md`, which is about running a
   workflow by hand.
3. **More identifiers carried "on" as a state** than the plan listed, and step 12 asks for none:
   `ON_WORKFLOWS_BY_TAGS` → `ACTIVE_WORKFLOWS_BY_TAGS`, `listOnWorkflowsByTags` →
   `listActiveWorkflowsByTags`, `listOnWorkflowNames` → `listActiveWorkflowNames` (all in
   `WorkflowRepository.ts`), the local `reconcileAllIfOn` → `reconcileAllIfActive` in
   `agent/ShopWork.ts`, and the test helper `onWorkflows` → `activeWorkflows`.
4. **`e2e/seed.ts`** has its own `SeedWorkflow` type with `on?: boolean`; it is now
   `state?: Domain.WorkflowState`. Not in the plan's step 10 list.
5. **The seed-fixture names in `workflow-repository.test.ts`** ("On"/"Off", tags `on`/`off`)
   became "Active"/"Inactive", and the expected rows were reordered for the name sort.
6. **Step 11, the reconcile table's Apply row.** The plan said the title "promotes the draft and
   turns the switch on; refuses an empty workflow and leaves it off" is also pinned on the Apply
   row and in `shop-agent-workflows.test.ts`. It is not: those carry "applyAndTurnOn promotes the
   draft and turns the switch on in one call; an empty workflow is refused", which has no state
   word. Only the `workflow-repository.test.ts` title changed.
7. **Step 14 took the fallback.** `checkScreenColumns` compares every field of each
   `VERB_LABEL` entry with a table column, so a `titleBar` field would fail against the Verbs
   table without changing the compare code. The title-bar labels are
   `SWITCH_TITLE_LABEL = { turnOn: "Turn on workflow", turnOff: "Turn off workflow" }` beside
   `VERB_LABEL`, with the sentence under the Verbs table pointing to it.
8. **Step 13, two screens checked against the new "a verb in the title bar" row.**
   - The member page (`app.members.$memberId.tsx`) had Delete as a title-bar button, verb alone.
     Fixed: it reads Delete member; the modal's primary stays Delete. `e2e/members.spec.ts`
     selects it by the new name. The "deleting a thing" row now says Delete sits in More
     actions, or reads Delete <noun> in the title bar when it is the only entry.
   - The team page's Rename modal's primary reads Save, as the workflow page's Rename modal and
     the editor's three task and step forms do. Left as is: Save is Shopify's word for committing
     an edit, and the new row's first wording was loose rather than the screens wrong. The row now
     says a modal primary is the verb alone, or Save when the modal edits a field, and the
     "a field of the thing" row says primary Save.
     `pnpm test` (762) and the e2e `members.spec.ts` + `teams.spec.ts` (7) pass; `pnpm seed` after.
9. **The Checks' expectation for Clock assembly is wrong.** The seeded Clock assembly has a
   draft, so after Turn off the page hides Turn on (the switch is absent while an inactive
   workflow has a draft). The inactive state and Turn on workflow were checked on Signet ring
   instead. The Draft badge also does not show beside Active in the admin's title bar; App Bridge
   hoists accessory badges (the `workflows.spec.ts` header says so). Not this change's business.
10. **The workflows index filter wrapped.** `FilterRow` gave the main filter a fixed 10rem track,
    which held All / On / Off but not All / Active / Inactive: Inactive fell to a second line. The
    track is now `auto` and the main filter sits in an `s-box minInlineSize="160px"` (10rem), since
    a responsive track list carries no comma and `minmax` cannot be used. The parts-table row now
    reads "at least 10rem and its content". A select stays at 160px (measured on `/dev/kit` and the
    orders index); the button row takes 181px on one line. The kit page gained a "Workflows index"
    section with the button row as the main filter.
11. **Step 22, measured.** On `/dev/kit` at 1280, 768 and 375 the distance from the note to the
    card below is 16px, equal to card-to-card, and the note's left edge is the card's. Before the
    part the line sat on the card (0px): `s-page` spaces after a section, not after a paragraph.
12. `test/integration/search-params.test.ts` still uses `["on", "off"]` as a generic literal pair
    for `lenientSearchKey`; it is not a workflow state and was left alone.
