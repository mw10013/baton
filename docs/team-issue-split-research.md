# The Needs a team issue: one label, two faults

## What the merchant saw

Order #9602 on the orders index shows the red badge **Needs a team**. Its order page shows the item's only task, Wait, already assigned to the team E2E Banner Empty. The page's warning reads "No members on E2E Banner Empty. Nobody can work this until someone joins, or you assign another team." The task has a team. The team has no members. The badge says the order needs a team, which is not what the order page says.

#9602 is a fixture of the Issues banner E2E test (`e2e/orders.spec.ts`, "the Issues banner stands while any open order has an issue and goes with the Issues view"). That test uses it to pin down that an empty team is a Needs a team issue with the critical tone.

## What the code does

The badge is the `team` element of `Domain.orderIssues`, which reads `OrderRow.unstaffed`. `unstaffed` is true when an open run on the order has either of these:

| fault      | rule                                                                                           | fix                                              | where the fix is              |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| unassigned | an open task whose `teamId` is null or names no team on the roster (what a team delete leaves) | assign a team                                    | Assign team on the order page |
| empty team | a current task on a team with `memberCount === 0`                                              | add a member to the team, or assign another team | the team page, or Assign team |

The SQL restatement is in `OrderRepository.listOrders` (`unstaffedTask`, `unstaffedRun`), and the banner's count is `COUNT_FACT.criticalIssues`, `"unstaffed or blockedRuns > 0"`.

The two faults also have different scopes. Unassigned counts any open task on the run, including tasks on later steps. Empty team counts only current tasks. That is defensible: an unassigned later task will stall once it becomes current and cannot fix itself, while an empty team on a later step may have members by then. But no JSDoc says so. The rule is only visible in the SQL.

## Nothing slipped past the spec. The spec merged the faults.

The glossary row says it outright (`src/lib/Domain.ts`, order issues table):

> `team` | an open task unassigned, or on a deleted or empty team | Needs a team

`OrderRow.unstaffed`'s JSDoc even acknowledges the mismatch: "The field says what the fact is (a task with nobody to do it), not what the badge asks for." So the gap was written down and left there.

None of our checks look at whether a label is accurate:

- `pnpm spec check` checks that the glossary's screen column equals `ORDER_ISSUE_LABEL`. It checks that the strings match, not that the label is true of every case in the row's meaning.
- Tests assert that the badge appears, not that its words describe the fault.
- No rule says an issue has one fix. The issue table on `OrderIssue` has a Remedy column, and the `team` cell holds two fixes joined by "or": "assign a team on the order page, or staff the team". That "or" is the signal, and nothing reads it.

## The screens disagree on how serious an empty team is

| screen or symbol                  | unassigned                              | empty team                                   |
| --------------------------------- | --------------------------------------- | -------------------------------------------- |
| `Workflow` JSDoc                  | "refuses Apply and Turn on"             | "a warning only"                             |
| `Domain.hasEmptyTeam`             | —                                       | "a warning, never a blocker"                 |
| the teams index                   | —                                       | **No members**, warning tone                 |
| the workflow editor's team picker | —                                       | "`<team>` (no members)"                      |
| the order page                    | strong text: "`<task>`: assign a team." | subdued paragraph: "No members on `<team>`…" |
| the workflows index               | **Needs attention**, critical           | **Needs attention**, critical                |
| the orders index badge            | **Needs a team**, critical              | **Needs a team**, critical                   |
| the orders index Issues banner    | critical                                | critical                                     |

Four places treat an empty team as a warning. The two index badges and the banner treat it as critical, and both index badges merge it with unassigned.

## Can one label cover both?

A merged label cannot name the fix, because the faults have different fixes. So it has to describe the state, like **Blocked**, rather than say what to do, like **Choose a workflow**. The order page would then give the specific fix.

| label             | covers both? | problem                                                                                                   |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| No members        | literally    | Leaves out the team. For an unassigned task the fix is Assign team, which the label doesn't point toward. |
| Unstaffed         | yes          | Outside the glossary. See the next section.                                                               |
| Needs members     | mostly       | Wrong fix for an unassigned task.                                                                         |
| Needs people      | yes          | "People" is not a glossary word. It reads casual next to Blocked.                                         |
| Nobody assigned   | no           | "Assign" means team assignment in the glossary, and an empty team is assigned.                            |
| Can't start       | yes          | "Start" is a task verb in the glossary, and the label is wrong for a task that has already started.       |
| Nobody to work it | yes          | Vague and flat.                                                                                           |

Even a good merged label leaves one tone for two severities. The faults differ in severity and in fix, so the case for splitting them is stronger than the case for any single label.

## Split into two issues

| issue        | rule                                                       | badge               | tone     | remedy                        |
| ------------ | ---------------------------------------------------------- | ------------------- | -------- | ----------------------------- |
| `team`       | an open task on an open run is unassigned                  | Needs a team        | critical | Assign team on the order page |
| `empty_team` | a current task on an open run is on a team with no members | Team has no members | warning  | add a member on the team page |

What changes, starting at the spec:

1. The glossary's order issues table: split the `team` row into two rows.
2. `OrderIssue`, `ORDER_ISSUE_LABEL`, and the issue table on `OrderIssue` (one remedy per row).
3. `OrderRow.unstaffed` becomes two booleans. Their names depend on question 5.
4. `orderIssues` and the `issueBadges` tones on the orders index.
5. `OrderRepository.listOrders`: split `unstaffedTask` into its two predicates, and add them to `COUNT_FACT.issues` and `COUNT_FACT.criticalIssues`, where the empty-team fact drops out of critical if the tone is warning.
6. The banner comment on the orders index ("Critical while any order Needs a team or is Blocked").
7. `OrderRow.waitingOn`'s JSDoc and the Waiting on cell's comment both explain their empty cell in terms of `unstaffed`.
8. The E2E banner test: #9602 then shows a warning banner, not a critical one, and the fixture comment in `e2e/fixture.ts` ("Needs a team" in the list) needs to say which badge each task shows.

The Issues view still holds every order with any issue, so it needs no change beyond the new predicate.

## `unstaffed` and "staff"

`unstaffed` came in with commit 19e105c ("orders operational surface with waiting-on, team filter, and alarm split") and was not revisited. The word is accurate, but it is outside the glossary. The glossary's nouns are member and team, and nothing in the glossary is "staff".

It also collides with a meaning the codebase already uses. `Domain.ts`'s JSDoc on the connection identity describes **merchants** as "Shopify staff inside the embedded admin". In Shopify, staff are the admin accounts, which in Baton are the merchant side, not members. A merchant reading "unstaffed" could reasonably think it's about their Shopify staff accounts.

Where "staff" appears today:

| place                                     | text                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Domain.OrderRow.unstaffed` and its JSDoc | the field                                                                                           |
| `Domain.OrderIssue` issue table           | "or staff the team"                                                                                 |
| `Domain.OrderRow.waitingOn` JSDoc         | "the team the merchant has to staff"                                                                |
| `Domain.orderIssues`                      | reads `unstaffed`                                                                                   |
| `OrderRepository.listOrders`              | `unstaffedTask`, `unstaffedRun`, `unstaffedRows`, the `unstaffed` column, `COUNT_FACT`              |
| `ShopAgent.ts`                            | a comment on the orders index read                                                                  |
| `app.orders.index.tsx`                    | the Waiting on cell's comment: "an unstaffed team still shows, so the merchant knows whom to staff" |
| `e2e/orders.spec.ts`                      | "a staffed team", the workflow "E2E Banner Unstaffed"                                               |
| `e2e/teams.spec.ts`                       | test title "teams screen creates, staffs, renames, and deletes a team"                              |
| `e2e/members.spec.ts`                     | test title "members screen adds, staffs, normalizes, and removes a member"                          |
| `e2e/member-area.member.spec.ts`          | "staffed by someone else"                                                                           |

No screen string says "staff". It is all code, JSDoc and test titles, so renaming it changes no screen.

If the issues split, the field splits too, and the glossary's words name each half: `unassigned` (already the glossary's word, `Domain.isUnassigned`) and `emptyTeam` (matching `Domain.hasEmptyTeam`). "Staff the team" becomes "add a member to the team". The test titles' "staffs" becomes what the test does: "adds members to" a team, or "puts on a team" for a member.

## A rule that would have caught this

The fault was a label covering two fixes. One sentence on `OrderIssue` would make that a rule: **each issue has one remedy, and an issue whose label is an instruction names that remedy.** Its test could read the issue table out of the source, the way the action matrices are read, and refuse a Remedy cell with "or" in it. That is a narrow check, but it is the exact shape of this mistake.

## Decisions

1. Split the `team` issue into two.
2. The new issue's literal is `empty_team` and its badge reads **Team has no members**.
3. The empty-team issue is a warning on both indexes. The reasoning is kept below.
4. Split the workflows index's Needs attention badge in this change. An unassigned task shows **Needs attention** (critical), and an empty team shows **Team has no members** (warning), the orders index's label for the same fact. (The research first proposed the teams index's **No members**, but beside a workflow's name it reads as "this workflow has no members"; workflows have no members, teams do.)
5. Retire "staff" and `unstaffed`. The fields become `unassigned` and `emptyTeam`, "staff the team" becomes "add a member to the team", test titles say what the test does, and `scripts/rules-lint.ts` refuses "staff" in screen copy.
6. Keep the asymmetry (unassigned counts any open task, empty team only the current one) and state each issue's scope in its row of the issue table.
7. Add the one-remedy rule to `OrderIssue`, with a test that reads the issue table and refuses a Remedy cell with "or" in it. The remedy is the action that fixes the fault the issue names: for `empty_team` that is adding a member. Assign team also clears the issue, but it moves the task around the empty team rather than fixing it, so the order page may still offer it as an alternative without the Remedy cell naming it.

## Why an empty team is a warning (decision 3)

Where the fix happens is not the difference. Assign team on the order page fixes either fault. The order page can't add a member, but it links to the team page, which can, so both faults are one click from a fix.

The two faults differ in these ways:

|                           | unassigned                                              | empty team                                                                       |
| ------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| is the definition valid?  | no: Apply and Turn on refuse it                         | yes: Turn on allows it                                                           |
| how it arises             | a team was deleted under a task                         | a team was created before anyone joined, or its last member left                 |
| whose list the task is on | nobody's, and it stays that way until the merchant acts | the team's, and anyone who joins sees it at once                                 |
| what one fix clears       | this task (Assign team is per task)                     | every order waiting on that team (one member added)                              |
| in the middle of setup    | rare                                                    | normal: a merchant building teams before inviting members hits it on every order |

The case for **critical**: the orders index's tone answers "is this order stuck?", not "is the setup valid?". An order waiting on an empty team is stuck exactly as much as an unassigned one, since nobody can work it either way. On this view, the workflow rule's "warning only" belongs to a different question (may the merchant Turn on?), and the two screens may reasonably disagree.

The case for **warning**: the empty-team state is valid, expected during setup,. A critical banner on every order while the merchant is still inviting members is an alarm with no new information. It teaches the merchant to ignore the tone, and then the tone stops meaning anything for Blocked and Needs a team. Keeping critical for faults that only a merchant decision about this order can clear keeps it rare and worth reading.

Decided: warning. The setup case decides it. An empty team is the ordinary state of a new team, and critical is kept for a broken definition or a blocked order. After the split, making it critical on the orders index alone would be a one-cell change.

No open questions remain.
