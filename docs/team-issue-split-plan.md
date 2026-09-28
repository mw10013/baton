# Plan: split the team issue into Needs a team and Team has no members, retire "staff"

Written 2026-09-28 from `docs/team-issue-split-research.md`, whose Decisions section holds every choice this plan carries out. An agent should be able to follow this plan without further questions. Every fact below was checked against the code on 2026-09-28. If the code has moved since, follow the code and record what changed under Deviations and issues.

## Ground rules

- Follow `AGENTS.md`: glossary words only (the glossary at the top of `src/lib/Domain.ts`), `Domain` predicates rather than inline comparisons in routes or the object, and no JSDoc that cites `docs/`. Each rule has a test whose title is the rule. Do not commit.
- **Aligning JSDoc is part of each step, not a follow-up.** Every JSDoc and comment that states a rule this plan changes is listed under its step. A JSDoc that still describes the old behaviour is a defect. Once all steps are done, step 8 greps for leftovers.
- A rule is stated once, on the symbol that enforces it, and other sites `{@link}` it. Where this plan says "link", do not restate the rule.
- After each step, run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`) and `pnpm test`. After the last step, run `pnpm fmt` repo-wide and keep every file it touches, then the E2E suites in step 9.
- Words. The two faults are **unassigned** (an open task whose `teamId` is null or names no team on the roster) and **empty team** (a current task on a team with `memberCount === 0`). The issue literals are `team` and `empty_team`. The badges read **Needs a team** and **Team has no members**. Never write "staff", "staffed" or "unstaffed" in code, JSDoc, tests or comments. The one exception is the existing phrase "Shopify staff" in the connection-identity JSDoc (the one describing **merchants**), which names Shopify's own concept.

## Target behaviour

| issue             | rule                                                                       | badge               | tone     | remedy                              |
| ----------------- | -------------------------------------------------------------------------- | ------------------- | -------- | ----------------------------------- |
| `choose_workflow` | unchanged                                                                  | Choose a workflow   | warning  | choose a workflow on the order page |
| `team`            | an open run on the order has an open task, on any step, that is unassigned | Needs a team        | critical | Assign team on the order page       |
| `empty_team`      | an open run on the order has a current task on a team with no members      | Team has no members | warning  | add a member on the team page       |
| `blocked`         | unchanged                                                                  | Blocked             | critical | the order page                      |

- `team` counts any open task, including later steps, because an unassigned task cannot fix itself before it becomes current. `empty_team` counts only current tasks, because an empty team on a later step may have members by then. The SQL does this today. The new part is saying it in the issue table.
- Assign team on the order page also clears `empty_team`, and the order page keeps offering it ("… or you assign another team."). The Remedy cell names only adding a member, because that fixes the fault the issue names. Assign team routes the task around the empty team instead.
- The Issues view still holds every open order with any issue. The Issues banner is critical while any order has a `team` or `blocked` issue, and a warning otherwise.
- On the workflows index, an unassigned task shows **Needs attention** (critical) and an empty team shows **Team has no members** (warning). A workflow with both shows both badges.
- An order can carry both `team` and `empty_team` at once (two items, or two tasks on one step). Both badges render, in `OrderIssue` order.

## Step 1. The spec: glossary and `OrderIssue`, `src/lib/Domain.ts`

### 1a. Glossary, order issues table (top of file)

Replace the `team` row with two rows, in this order:

```
| team            | an open task unassigned                                | Needs a team        |
| empty team      | a current task on a team with no members               | Team has no members |
```

Pad the columns so the table stays aligned (`pnpm fmt` does not align JSDoc tables, so align them by hand; this is table layout, not formatting). `checkScreenColumns` maps the spaced word "empty team" to the key `empty_team` (the spec test "a spaced word finds its snake-case literal key" covers this). `checkGlossary` needs the words "empty team" to appear elsewhere in `Domain.ts`; the JSDoc changes below provide that.

### 1b. `OrderIssue` literals and JSDoc

- `OrderIssue`: `["choose_workflow", "team", "empty_team", "blocked"]`. The order is the badge order: the two team issues sit together, and choosing comes first as it does today.
- The issue table in the JSDoc gets a **Tone** column, so the tone is stated once and in one place. The header must be exactly `Issue | Rule | Tone | Remedy` (step 6 parses it). Rows:

```
| Issue             | Rule                                                                                  | Tone     | Remedy                              |
| ----------------- | ------------------------------------------------------------------------------------- | -------- | ----------------------------------- |
| `choose_workflow` | `ambiguousItems > 0` and the order can start runs ({@link canStartRuns})               | warning  | choose a workflow on the order page |
| `team`            | {@link OrderRow} `unassigned`                                                          | critical | Assign team on the order page       |
| `empty_team`      | {@link OrderRow} `emptyTeam`                                                           | warning  | add a member on the team page       |
| `blocked`         | `runs.blocked > 0`                                                                     | critical | the order page                      |
```

- Add a paragraph after the table stating the two rules, normatively:
  - **Each issue has one remedy: the action that fixes the fault the issue names.** A Remedy cell never says "or". An action that only routes around the fault (Assign team on an `empty_team`) may still be offered on the order page, but it is not the remedy. Add one sentence on why: a label that covers two fixes names neither, which is how Needs a team came to be shown for a team that was assigned but empty.
  - **Critical means a person cannot proceed without the merchant deciding something about this order**: the task has no team, or a person has put a hold on the run. An empty team is a warning because a team with no members is valid (Turn on allows it, {@link Workflow}), it is the ordinary state of a new team while the merchant is still adding members, and adding one member clears every order waiting on that team. Critical has to stay rare enough to mean something.
- Keep the other paragraphs. In the paragraph that begins "The word is issue", nothing changes.

### 1c. `orderIssueIsCritical`

Add `export const orderIssueIsCritical = (issue: OrderIssue): boolean` after `orderIssues`, backed by a `Record<OrderIssue, boolean>` (a record, so a new literal cannot be left out). Its JSDoc is one line: the Tone column of {@link OrderIssue}. It is the only reader of tone. Step 4 and step 3 use it or link it.

### 1d. `ORDER_ISSUE_LABEL`

Add `empty_team: "Team has no members"` between `team` and `blocked`. Its JSDoc says "all three"; change that to "all of them".

### 1e. `OrderRow`: `unstaffed` becomes `unassigned` and `emptyTeam`

- Replace `unstaffed: Schema.Boolean` with two fields, `unassigned: Schema.Boolean` and `emptyTeam: Schema.Boolean`, each with its own JSDoc:
  - `unassigned`: the `team` issue. An open run has an open task on any step whose `teamId` is null or not on the live roster. Derived at read time, never stored. Remedy: Assign team on the order page. State the scope ("on any step") and why (it cannot fix itself before it becomes current).
  - `emptyTeam`: the `empty_team` issue. An open run has a current task ({@link currentTasks}) on a roster team with no members. Derived at read time. Remedy: add a member, which clears it with no further write. State the scope ("current tasks only") and why.
  - Drop the sentence "The field says what the fact is (a task with nobody to do it), not what the badge asks for." It no longer applies.
- `waitingOn` JSDoc: rewrite the paragraph that says unassigned tasks and deleted teams "are both `unstaffed`" and that an empty team "is `unstaffed` too, but the badge names the team the merchant has to staff". New text: an unassigned task and a team that has left the roster contribute nothing, because both are `unassigned` and one fault shown in two cells looks like two alarms. A team on the roster with no members does contribute, because it is `emptyTeam` and the Waiting on cell names the team the merchant has to add a member to. Keep the conclusion: an order being made with an empty list is exactly an order whose every current task is unassigned, which is when the critical badge shows.
- `orderIssues`: take `unassigned` and `emptyTeam` in its `Pick`, and map `team: unassigned`, `empty_team: emptyTeam`.
- `OrdersIndexData` roster field JSDoc (near the line with "The live D1 roster the page was read against — the same list `unstaffed`"): change `unstaffed` to "`unassigned`, `emptyTeam`".

### 1f. `OrderCounts`

The `criticalIssues` paragraph says "a `team` or `blocked` {@link OrderIssue}". Change it to: the open orders with an issue {@link orderIssueIsCritical} holds. Keep the rest of the paragraph.

### 1g. `Workflow` JSDoc, attention paragraph

Rewrite the sentences from "**Needs attention** is the badge for a workflow, run, or team with an unassigned task or a team with no members …" through "an empty team is a warning only." New content:

- The workflows index shows **Needs attention** (critical) for a workflow with an unassigned task, and **Team has no members** (warning) for a workflow with a task on a team with no members. On the orders index they are the `team` and `empty_team` {@link OrderIssue}s.
- Both are derived on every read and never stored.
- Unassigned refuses Apply and Turn on. An empty team is a warning only, for the reason on {@link OrderIssue}.

Keep the sentences about Apply and the tag and name before and after.

### 1h. `WorkflowSummary`

Replace `needsAttention: Schema.Boolean` with `unassigned: Schema.Boolean` and `emptyTeam: Schema.Boolean`, the same names as on `OrderRow` for the same facts. The list-row JSDoc (the one beginning "List row. `tag` and `stepCount` describe the workflow. `needsAttention` is …") becomes: `unassigned` and `emptyTeam` are the derived badges from {@link Workflow}, computed against the live roster on every list read.

### 1i. Other `Domain.ts` text

- `hasEmptyTeam` JSDoc ("Assigned to a team nobody is on: a warning, never a blocker."): keep it, and add `{@link OrderIssue}` for why.
- `Team` JSDoc ("A team with nobody on it is valid and shows **No members** …"): leave it. It is the teams index's badge, and it stays.
- `SeedWorkflowTask` / `SeedWorkflowsInput` JSDoc: "so the needs-attention state is visible" becomes "so the Needs attention badge and the Needs a team issue are visible".

## Step 2. `OrderRepository.listOrders`, `src/lib/OrderRepository.ts`

- The block that builds `unassigned`, `emptyReady`, `unstaffedTask` and `unstaffedRun` (near line 985): split it into two run predicates, `unassignedRun` (an open task on an active run matching `unassigned`) and `emptyTeamRun` (an open task on an active run matching `emptyReady`). The inner fragments keep their names. Rewrite the JSDoc above them into two sentences, one per predicate, each linking `Domain.OrderRow.unassigned` / `Domain.OrderRow.emptyTeam` rather than restating the rule.
- Everywhere `unstaffedRun` or `unstaffedTask` is used (the Issues view filter near line 1046, the `unstaffedRows` query near line 1157, the per-row select `${unstaffedRun} as unstaffed` near line 1292, and the `unstaffed` set near line 1237), carry both predicates:
  - The Issues view: `unassignedRun or emptyTeamRun` alongside the existing choosing and blocked terms.
  - The facts select: two columns, `unassigned` and `emptyTeam`.
  - The page rows: two sets (`unassignedIds`, `emptyTeamIds`), and the row mapper sets `unassigned` and `emptyTeam` (near line 1325).
- `COUNT_FACT`:
  - `issues: "choosing or unassigned or emptyTeam or blockedRuns > 0"`
  - `criticalIssues: "unassigned or blockedRuns > 0"`
  - Its JSDoc: `issues` is the four `Domain.orderIssues` elements or'd. `criticalIssues` is the ones `Domain.orderIssueIsCritical` holds, restated in SQL, and it must move with it.
- The comment near line 1187 ("a task pointing at a deleted team is `unstaffed`") says `unassigned`. The comment near line 1260 ("`CHOOSING` and `unstaffedRun` stay correlated") names both new predicates.
- The `teams` input's JSDoc near line 378 ("The live D1 roster `unstaffed` and `waitingOn` are derived against"): `unassigned`, `emptyTeam` and `waitingOn`.

## Step 3. `ShopAgent`, `src/lib/ShopAgent.ts`

- The comment near line 1933 ("the repository derives `unstaffed` and `waitingOn` from it"): `unassigned`, `emptyTeam` and `waitingOn`.
- `getWorkflowDetail` JSDoc (near line 2012) describes both attention states. Check it still reads true, and change nothing unless it names `needsAttention`.

## Step 4. `WorkflowRepository.listWorkflows`, `src/lib/WorkflowRepository.ts`

- The row mapper near line 983: replace `needsAttention` with `unassigned: tasks.some((task) => task.workflowId === row.id && isUnassigned(task, teams))` and `emptyTeam: tasks.some((task) => task.workflowId === row.id && emptyTeam(task))`.
- The service JSDoc near line 144 ("`needsAttention` is derived per row …"): "`unassigned` and `emptyTeam` are derived per row …".
- The `Teams` type's one-line JSDoc near line 124 ("`memberCount` only matters to the list's attention badge"): "… only matters to `emptyTeam`".
- The comment inside the mapper ("the badge is computed from the workflow's tasks …"): "the badges are".

## Step 5. Screens

### 5a. Orders index, `src/routes/app.orders.index.tsx`

- `issueBadges` (near line 139): tone is `Domain.orderIssueIsCritical(issue) ? "critical" : "warning"`. Delete the `Match` chain. JSDoc: one badge per `Domain.orderIssues` element, labelled by `Domain.ORDER_ISSUE_LABEL`, with its tone from `Domain.orderIssueIsCritical`. Drop "Tone follows whether a person is stopped …", because the rule now lives on `OrderIssue`.
- The Issues banner comment (near line 711): "Critical while any order Needs a team or is Blocked, otherwise a warning, matching the Issues badges" becomes "Critical while `counts.criticalIssues` is above zero ({@link Domain.orderIssueIsCritical}), otherwise a warning, matching the Issues badges". Leave the rest of the comment.
- The Waiting on cell comment (near line 622): "empty means every ready step is unassigned or on a deleted team (an unstaffed team still shows, so the merchant knows whom to staff)" becomes "empty means every current task is unassigned (a team with no members still shows, so the merchant knows which team needs a member)". Keep the rest.
- `positionBadge` JSDoc: no change.

### 5b. Workflows index, `src/routes/app.workflows.index.tsx`

- `statusBadges`: replace the `needsAttention` badge with two:
  - `workflow.unassigned` → `<s-badge tone="critical">Needs attention</s-badge>`
  - `workflow.emptyTeam` → `<s-badge tone="warning">Team has no members</s-badge>`
- JSDoc: "Needs attention" is an unassigned task and "Team has no members" is a task on a team with no members, both derived by the object on every read. The tones are the ones on {@link Domain.OrderIssue}.

### 5c. Order page, `src/routes/app.orders.$orderId.tsx`

No behaviour change: the page already renders the two faults apart. Read the JSDoc and comments on the attention block (the component that renders "`<task>`: assign a team." and "No members on …") and change any sentence that says "unstaffed", "staff" or treats both faults as one.

## Step 6. The one-remedy rule as a spec check

### 6a. `scripts/lib/spec.ts`

Add and export `checkOrderIssues(source: string, literals: readonly string[]): readonly string[]`, modelled on `checkScreenColumns` (it returns problem strings, and an empty result means pass). It uses the file's private `firstTable(source, "OrderIssue", ["Issue", "Rule", "Tone", "Remedy"])` and reports:

- a parse error from `firstTable` (wrong header, missing separator);
- an Issue column that, with backticks stripped, is not exactly `literals` in order;
- a Tone cell other than `critical` or `warning`;
- a Remedy cell that matches `/\bor\b/iu`, with the message "OrderIssue `<issue>`: a remedy names one action; this one says or".

Give it a JSDoc stating what it checks and why (the Needs a team label covered two fixes and named neither), without citing `docs/`.

### 6b. `scripts/spec.ts`

Call `checkOrderIssues(domainSource, Domain.OrderIssue.literals)` in `check`, next to the screen-column check, and print its problems in the same format. Extend `print` only if it already prints the glossary tables. Otherwise leave it.

### 6c. `orderIssueIsCritical` agrees with the Tone column

The Tone column and `orderIssueIsCritical` are two statements of one rule. Have `checkOrderIssues` take a third argument, `critical: (issue) => boolean`, and report a row whose Tone cell disagrees with it. `scripts/spec.ts` passes `Domain.orderIssueIsCritical`. This way the table is the spec and the function cannot drift from it.

### 6d. Tests, `test/integration/spec.test.ts`

Add a `describe("the order issue table", …)` with:

- `it("Domain.ts passes", …)`: `checkOrderIssues` on the real source returns `[]`.
- `it("each order issue has one remedy", …)`: a doctored source whose Remedy cell says "assign a team, or add a member" is reported. This is the test whose title is the rule.
- `it("the Tone column is orderIssueIsCritical", …)`: a doctored Tone cell is reported.
- `it("the Issue column is the OrderIssue literals, in order", …)`: a doctored row order is reported.

Follow the existing screen-column tests in that file for how a doctored source is built.

## Step 7. Retire "staff"

### 7a. `scripts/lib/rules-lint.ts`

- Add `/\b(?:un)?staff(?:s|ed|ing)?\b/iu` to `RETIRED`.
- Add a row to the JSDoc table: `| staff, staffed, unstaffed | a team's people are members; Shopify's staff are the merchant side |`.
- This lint reads screen copy only (string literals and JSX text, with comments skipped), so the "Shopify staff" JSDoc is untouched. Check that no string literal anywhere holds "staff" (`grep -rn '"[^"]*staff' src`). There were none on 2026-09-28.

### 7b. `test/integration/rules-lint.test.ts`

Add `it("staff is a retired word in screen copy", …)` in the style of the existing retired-word tests: a literal with "Unstaffed" and a JSX text line with "staff the team" are both hits, and a comment with "Shopify staff" is not.

### 7c. Code, JSDoc and test text

The research doc's "`unstaffed` and 'staff'" table is the inventory. Everything except the "Shopify staff" JSDoc changes:

| where                                                                                                                                        | change                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Domain.ts` `OrderIssue` table                                                                                                               | done in 1b                                                                                                                        |
| `Domain.ts` `waitingOn`                                                                                                                      | done in 1e                                                                                                                        |
| `OrderRepository.ts`                                                                                                                         | done in step 2                                                                                                                    |
| `ShopAgent.ts`                                                                                                                               | done in step 3                                                                                                                    |
| `app.orders.index.tsx` Waiting on comment                                                                                                    | done in 5a                                                                                                                        |
| `e2e/orders.spec.ts` banner test JSDoc: "waits on a staffed team"                                                                            | "waits on a team with a member"                                                                                                   |
| `e2e/orders.spec.ts` workflow "E2E Banner Unstaffed"                                                                                         | "E2E Banner Empty team" (step 9 also changes this test)                                                                           |
| `e2e/teams.spec.ts` JSDoc "creating, staffing, renaming, and deleting" and title "teams screen creates, staffs, renames, and deletes a team" | "creating, adding members to, renaming, and deleting"; title "teams screen creates, adds members to, renames, and deletes a team" |
| `e2e/members.spec.ts` JSDoc "granting, staffing, and revoking" and title "members screen adds, staffs, normalizes, and removes a member"     | "granting, putting on teams, and revoking"; title "members screen adds, puts on teams, normalizes, and removes a member"          |
| `e2e/member-area.member.spec.ts` "staffed by someone else"                                                                                   | "whose team is someone else's" (read the sentence and keep its meaning)                                                           |

Before renaming a test title, check `pnpm spec check`: if a data-model row pins that title under `pinned by`, change the row in the same edit.

## Step 8. Unit and integration tests

### 8a. `test/integration/domain.test.ts`

- The row fixture near line 34: replace `unstaffed: false` with `unassigned: false, emptyTeam: false`.
- Replace `it("team: the order has an unstaffed task", …)` with:
  - `it("team: an open run has an unassigned open task", …)` → `["team"]`
  - `it("empty team: an open run has a current task on a team with no members", …)` → `["empty_team"]`
  - `it("an order with both team faults carries both issues, team first", …)` → `["team", "empty_team"]`
- The tests near lines 126 and 137 that set `unstaffed: true` to build a troubled order: use `unassigned: true`, and add `emptyTeam: true` where the test means "every issue", so a closed order still returns `[]` for all four.
- Add `describe("Domain.orderIssueIsCritical", …)` with `it("team and blocked are critical, choose workflow and empty team are warnings", …)`.

### 8b. `test/integration/order-repository.test.ts`

- `describe("OrderRepository.listOrders unstaffed", …)` becomes `describe("OrderRepository.listOrders team issues", …)`, and its JSDoc names the two fields. Split the test near line 772 into:
  - `it("an open task on a deleted team, on any step, makes the order unassigned, and the Issues view holds it", …)`: #3's task on `team-gone` is `unassigned`. Add a task on a later step (step 2) on `team-gone` behind a current task on `team-cut` to a healthy order, and assert it is `unassigned` too.
  - `it("a current task on a team with no members makes the order emptyTeam, and a later one does not", …)`: #4's current task on `team-empty` is `emptyTeam`. Add an order whose step 1 is current on `team-cut` and whose step 2 is on `team-empty`, and assert it is not `emptyTeam`.
  - Keep the assertions that a done run's stale pointer never counts (#1) and that #8 is healthy, on both fields.
- `it("leaves out a team that has left the roster, which is unstaffed instead", …)` near line 958 becomes "… which is unassigned instead", and `?.unstaffed` becomes `?.unassigned`.
- `seedIssues` (near line 396): its comment and the test near line 489 ("unstaffed `#1004`") say "unassigned". Add one order with a current task on an empty team to `seedIssues`'s roster and tasks, so the counts tests see all four issues.
- `it("criticalIssues counts the open orders with a team or blocked issue", …)` becomes `it("criticalIssues counts the open orders with a critical issue, and an empty team is not one", …)`. Its `critical` helper (near line 44) uses `Domain.orderIssueIsCritical` rather than naming literals. The added empty-team order is in `issues` and not in `criticalIssues`.
- The count expectations near lines 562, 571 and 1003 move by the added order. Recompute them from the seed rather than adjusting by one blindly.
- Line 297's describe JSDoc ("Every SQL fragment against `Domain.productionState` and `Domain.orderIssues`") stays. Check that its loop covers `empty_team` through `OrderIssue.literals`.

### 8c. `test/integration/workflow-repository.test.ts`, `run-repository.test.ts`, `shop-agent-workflows.test.ts`

Every `needsAttention` assertion becomes an assertion on `unassigned` or `emptyTeam`, whichever fault the test sets up. Read each test's setup to decide. Near `workflow-repository.test.ts` line 1573, a test that covers both (a deleted team, then an empty team) asserts each field in its own phase. Rename any title that says "needs attention" to name the fault: for example "a workflow with a task on a deleted team is unassigned", "a workflow with a task on a team with no members is emptyTeam".

## Step 9. E2E

### 9a. The Issues banner test, `e2e/orders.spec.ts`

The test "the Issues banner stands while any open order has an issue and goes with the Issues view" currently pins #9602 (empty team) as critical. After this change:

- #9602 (only task on `EMPTY_TEAM`) shows the **Team has no members** badge, and with the `EMPTY_TEAM` team selected the banner's tone is `warning`.
- For the critical case, add a third team `ORPHAN_TEAM = "E2E Banner Orphan"` with `MEMBER` on it, a workflow "E2E Banner Orphan" with tag `e2e-banner-orphan`, tasks `[{ name: "Cut", team: ORPHAN_TEAM, step: 1 }, { name: "Pack", team: null, step: 2 }]` and `active: true`, and an order 9603 with one item tagged `e2e-banner-orphan`. The unassigned task is on step 2, so the order is `unassigned` (any step) while its current task keeps it under the `ORPHAN_TEAM` team select. With that team selected, the banner's tone is `critical`, and the row shows **Needs a team**.
  - If the seed refuses `active: true` with an unassigned task (the default is off in that case, per `Domain.SeedWorkflowsInput`, and an explicit `true` may still be refused), fall back to seeding step 2 on a fourth team and deleting that team through the teams screen before loading the orders index. Record which path you took under Deviations.
- Rewrite the test's JSDoc: #9601 has a Choose a workflow issue (warning), #9602's task is on a team with no members (Team has no members, warning), and #9603 has an unassigned task on a later step (Needs a team, critical). The count honours the team select, so each team shows its own order's tone.
- The inline comment "The team with only a Needs a team order: the banner goes critical." is split per team.
- Assert the badge text in the Issues cell for #9602 and #9603. That is the check that would have caught this problem.

### 9b. `e2e/fixture.ts`

The pet tag comment near line 250 ("one unassigned task … and one on the empty team: "Needs a team" in the list, both banners on the detail page, Turn on refused until the task is assigned") becomes: "Needs attention" and "Team has no members" on the workflows index, both warnings on the detail page, Turn on refused until the unassigned task is assigned. Check the fixture's workflow is off (it has an unassigned task), so no order carries its issues. If an E2E test asserts on its badges, update the assertion.

### 9c. Workflows index

Search the E2E suites for assertions on "Needs attention" (`grep -rn "Needs attention" e2e`). There were none on 2026-09-28. If one appears, make it match 5b. Add one assertion to an existing workflows-index test that already loads the seeded fixture: the pet tag workflow shows both **Needs attention** and **Team has no members**.

### 9d. Run

`npm run test:e2e -- e2e/orders.spec.ts e2e/teams.spec.ts e2e/members.spec.ts`, then the full suite `npm run test:e2e --`. The dev server must be running (`pnpm dev:start`).

## Step 10. Leftovers sweep

Run these, and resolve every hit or record why it stays:

```bash
grep -rn -i "unstaff\|staffed\|staffs\b\|staff the\|staffing" src e2e test scripts
grep -rn "needsAttention" src e2e test scripts
grep -rn "Needs a team" src e2e test scripts
grep -rn '"team"' src/lib src/routes test | grep -i issue
```

- The only allowed "staff" hit is the "Shopify staff" phrase in the connection-identity JSDoc in `Domain.ts`.
- Every "Needs a team" hit should describe an unassigned task only.

Then `pnpm spec print` and read the order issue rows.

## Done when

- The orders index shows **Team has no members** (warning) for #9602 and **Needs a team** (critical) only for orders with an unassigned task. Check this in the running app on the `EMPTY_TEAM` and `ORPHAN_TEAM` team selects, and look at the screen.
- The workflows index shows **Needs attention** and **Team has no members** as separate badges.
- `pnpm typecheck`, `pnpm lint` (including `pnpm spec check` with the new order issue check) and `pnpm test` pass. The E2E suites in 9d pass.
- The sweep in step 10 is clean except for the recorded exceptions.
- `pnpm fmt` has been run repo-wide and every file it touched is kept.
- Nothing is committed.

## Deviations and issues

The implementer records here, as they go, every place the code differed from this plan, every decision they made that the plan did not cover, and every problem they could not resolve. Record each with the step, the file, what the plan said, what was done instead, and why.

| step | file                                        | plan said                                                                          | done instead                                                                                                                                                                                                              | why                                                                                                                     |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1b   | `src/lib/Domain.ts`                         | "A Remedy cell never says 'or'."                                                   | "A Remedy cell never names two actions."                                                                                                                                                                                  | Same rule; `checkOrderIssues` enforces the literal word.                                                                |
| 2    | `src/lib/OrderRepository.ts`                | Two run predicates with the inner fragments kept by name                           | `unassignedRun` and `emptyTeamRun` built by one local `runWithTask(task)`; `unassigned` and `emptyReady` kept. The page read is one query returning both flags (`teamIssueRows`) rather than two                          | Avoids two copies of the run/task `exists` and a second per-page read.                                                  |
| 5c   | `src/routes/app.orders.$orderId.tsx`        | Change sentences that treat both faults as one                                     | The `attentionRows` JSDoc said "the warning's remedy is either it or a new member"; it now names a new member as the remedy and Assign team as routing around the empty team                                              | The one-remedy rule.                                                                                                    |
| 6a   | `scripts/lib/spec.ts`                       | `checkOrderIssues(source, literals)` then a third argument in 6c                   | Generic `checkOrderIssues<Issue>(source, literals, critical)`                                                                                                                                                             | So `Domain.orderIssueIsCritical` type-checks as the argument.                                                           |
| 6b   | `scripts/spec.ts`                           | Extend `print` only if it prints glossary tables                                   | Not extended                                                                                                                                                                                                              | It does not print them.                                                                                                 |
| 8b   | `test/integration/order-repository.test.ts` | Add a later-step task to "a healthy order"                                         | Used `#1014` (unpaid, active run, no other issue) for both new tests                                                                                                                                                      | It is the one `seedStates` order with an active run and no issue.                                                       |
| 8b   | same                                        | `seedIssues` gains an empty-team order                                             | Added `#1015` (paid, one active run, current task on `team-empty`); the open counts move to open 12, issues 5, making 5, critical 2                                                                                       | Recomputed from the seed.                                                                                               |
| 9a   | `e2e/orders.spec.ts`                        | Seed "E2E Banner Orphan" with `Pack` unassigned and `active: true`                 | Fallback path: `Pack` seeded on a fourth team, "E2E Banner Gone", deleted on the teams screen before the orders index loads                                                                                               | `replaceWorkflows` refuses an active workflow with an unassigned task ("an active workflow needs every task assigned"). |
| 9c   | `e2e/workflows.spec.ts`                     | Add an assertion to an existing workflows-index test that loads the seeded fixture | New test "the workflows index shows Needs attention and Team has no members as separate badges", seeding an off workflow with one unassigned task and one on an empty team                                                | No E2E test loads `e2e/fixture.ts`; only `pnpm seed` does.                                                              |
| 10   | —                                           | Only "Shopify staff" may remain                                                    | Also remaining: the retired-word row in `scripts/lib/rules-lint.ts`, its test in `test/integration/rules-lint.test.ts`, and commented Shopify API names (`currentStaffMember`, `staff`) in `scripts/refs-shopify-docs.ts` | The lint must name the word it retires; the others are Shopify's API names.                                             |

Open issues (not resolved in this change):

- None.

Review on 2026-09-28 (a second agent, against this plan): every step is in place and the deviations above hold. The review also carried out GitHub issue mw10013/baton#1 in the same working tree, because the plan's decision 4 left the workflows index calling an unassigned task **Needs attention** while the orders index calls it **Needs a team**, and left "attention" in code, JSDoc and the workflow page's banner heading: the workflows index badges and the workflow page banners now read `team` and `empty_team` from `ORDER_ISSUE_LABEL` with `orderIssueTone`; the workflow page shows one banner per issue (**Needs a team** critical, **Team has no members** warning) instead of one **Needs attention** banner over both; `attentionRows`, `AttentionBanner` and `attentionLines` are split by fault (`unassignedRows`, `emptyTeamWarning`, `TeamIssueBanners`, `unassignedLine`, `emptyTeamLine`); and "attention" is a retired word in `scripts/lib/rules-lint.ts`. Still not one label: the task line on the workflow page (`TeamLine`) shows **Unassigned** and **No members** beside a task, the glossary's task and team state words rather than the issue labels.
