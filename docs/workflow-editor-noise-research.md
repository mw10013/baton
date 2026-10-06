# Workflow editor: what earns its place on the page

Written 2026-10-05. Prompted by a screenshot of the editor with the New step form open: a warning
banner "Turn on is unavailable · Add a step to this workflow." above it, "A Team (no members)" in
the Team select, "20/500" inside the Instructions field, "Members see this at this step on every
item. Up to 500 characters." under it, and "✓ Saved · Last changed on Oct 5, 10:15 PM" at the foot.

Five things, one question: does each change what the merchant does next, or is it the page saying
something it already says? Underneath that, a rule for character counts, because the app has four
behaviours for one thing today.

Checked against the code on 2026-10-05 after commit 617307e. The editor is
`src/routes/app.workflows.$workflowId_.edit.tsx`; the merchant's workflow page is
`src/routes/app.workflows.$workflowId.tsx`; both read `Domain.WorkflowPageData`.

## Short answers

- **The blocker banner says what the page already says, twice over.** The canvas is empty, Turn on
  is disabled, and the New step form is open. For an unassigned task it is worse: the same page
  shows a second banner, "Needs a team · No team on Stamp. Assign one before you apply.", for the
  same fault. Cut it on both pages. Shopify Flow has no such banner: it validates when you press
  Turn on and marks the step.
- **"✓ Saved · Last changed on …" is a label that is always true.** The editor has no unsaved state.
  A failed write already goes to the critical banner. Every busy button already shows a spinner.
  The date is the merchant's own last keystroke. And "Saved" next to an Apply button invites the
  misreading that the draft is in force. Cut the line.
- **A character count is for a limit the person will reach writing normally, shown when they are
  near it.** That is already the rule for the run note and the block reason (`noteCountFrom`: the
  last 200 characters). Instructions should join it; the name fields should show nothing and refuse
  on submit. The Polaris `n/max` counter is a side effect of setting `maxLength` on the element, not
  a decision; stop setting it.
- **"Up to 500 characters." repeats the counter; "Members see this at this step on every item."
  repeats the Team field above it.** Cut the help line.
- **"(no members)" in the select changes no decision.** A step's team is chosen by what work it does.
  An empty team is allowed, and the moment it is chosen the page says "Team has no members" anyway.
  Cut the suffix on both selects (editor, order page). The read it costs is not the reason: the
  fault banner and the index badge need the same count, and it is a few rows against a primary key.
- **The empty-team fault is a badge by the app's own rule, not a banner.** The controls table says a
  banner is for "a fact about the page that disables things". An empty team disables nothing. The
  teams index already shows it as a badge, "No members". Put the same badge on the step card and
  drop the banner. "Needs a team" stays a banner: it disables Apply and Turn on.
- **It generalises, and the rules belong on the tables.** The same five patterns stand on other
  screens: an info banner framing a closed run, "Syncing…" on the orders index, explainer
  paragraphs above the members and teams tables, date columns nobody orders by, four counter
  behaviours. [Rules for the specs](#rules-for-the-specs) writes each as a row on the copy or
  controls table plus, where it has a syntactic shape, a `rules-lint` regex.

## What the page shows today

| element                                         | where                                   | shown when                                                | reads                                                                                 |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "Turn on is unavailable" / "Not ready to apply" | editor, warning banner, top of the card | `applyBlocker(tasks)` is `NoTasks` or `TaskUnassigned`    | `applyResultMessage`: "Add a step to this workflow." / "Assign a team to X."          |
| "Turn on is unavailable"                        | workflow page, info banner              | `turnOnBlocker(tasks)` and the switch is shown            | `switchResultMessage`, same strings                                                   |
| "Needs a team" / "Team has no members"          | both pages, critical banners            | any task has `teamName === null` / `memberCount === 0`    | `unassignedLine`, `emptyTeamLine`                                                     |
| Turn on (disabled)                              | both pages                              | `turnOnBlocker(tasks) !== null`                           | nothing                                                                               |
| "Saving…" / "✓ Saved · Last changed on …"       | editor foot, subdued text               | always; "Saving…" while any of eight mutations is pending | `workflow.updatedAt`, which every write moves, draft edits included                   |
| "Last updated on …"                             | workflow page                           | always                                                    | the same `updatedAt`                                                                  |
| `20/500` inside Instructions                    | editor, add form and task panel         | always, drawn by Polaris because `maxLength` is set       | `TASK_INSTRUCTIONS_MAX_LENGTH`                                                        |
| "Members see this … Up to 500 characters."      | under Instructions, both forms          | always                                                    | `INSTRUCTIONS_HELP`                                                                   |
| `12/64` under Rename                            | rename modals, hand-made subdued text   | always                                                    | `NAME_MAX_LENGTH`                                                                     |
| "N characters left"                             | run note and block reason modals        | only once length ≥ `noteCountFrom(max)`                   | `RUN_NOTE_MAX_LENGTH`, `BLOCK_REASON_MAX_LENGTH`; the element has no `maxLength`      |
| nothing                                         | team name (32), tag (255), email (254)  |                                                           | `maxLength` on the element for name and email; no counter visible on a one-line field |
| "A Team (no members)"                           | editor Team select, order page select   | `team.memberCount === 0`                                  | `listTeams`: a correlated `count(*)` over `TeamMember` per team row                   |
| "No members" badge and a count column           | teams index                             | `team.memberCount === 0`                                  | the same query                                                                        |

The blocker banner and the fault banners are decided from the same `tasks` array. `turnOnBlocker`
and `applyBlocker` run the same two checks; the JSDoc on them says "An empty team is not a
blocker: the run is created and waits for a member."

No unit test covers `turnOnBlocker`, `applyBlocker`, `switchResultMessage` or `emptyTeamLine`.
The strings are pinned by e2e titles only (listed under [What a plan touches](#what-a-plan-touches)).

## The test

Three questions, in order, for anything on a page that is not a field or a control:

1. **Does it change what the person does next?** If every merchant who reads it does what they
   were already going to do, it is decoration.
2. **Does the page already say it?** A disabled control, an empty canvas, a badge and an open form
   are each a statement. A sentence that restates one of them is the page talking to itself.
3. **What does cutting it remove?** Name the one thing lost. If that thing is also somewhere else,
   or nobody needs it, cut.

The copy table's tone list already has the principle: "A slot with nothing to say is empty.
Filling it is the failure mode." The findings below apply it element by element.

## Findings

### 1. The blocker banner

**What it says.** "Turn on is unavailable. Add a step to this workflow." (fresh workflow) or
"Not ready to apply. Assign a team to Stamp." (a draft with an unassigned task).

**What the page already says.** With no steps: the canvas is empty, Turn on is disabled, and in
the screenshot the New step form is open under the banner telling you to add a step. With an
unassigned task: "Needs a team · No team on Stamp. Assign one before you apply." is a critical
banner on the same page, from `TeamFaultBanners`. Two banners, one fault. Built for Shopify
requirement 4.3.4 lists exactly this as a rejection: "Two or more banners appear in close
proximity to one another. For example, at the top of a page or within a single card."

**What cutting it removes.** The heading, which names the consequence ("Turn on is unavailable").
For the unassigned case the fault banner's last sentence already names it ("before you apply").
For the empty case the consequence is a disabled Turn on next to an empty canvas, and nothing
else on the page could be the reason.

**What Shopify does.** Flow has no page-level banner for an incomplete workflow. A step missing
configuration gets a "Review" banner on the step itself; pressing Turn on with one unresolved
turns it into an error on the step and the workflow does not activate. The Polaris alerts
guidance says warning banners "can be stressful for merchants, so use them intentionally", and
"put error messages as close to the problem as possible". The banner component page says a
banner is for "missing configuration" but also to "focus on single actions" and "avoid persistent
banners that can't be closed". This one cannot be closed and repeats an action the page is
already offering.

**Note on the workflow page.** `showSwitch` is false while a workflow has no tasks, so the NoTasks
banner cannot appear there; only the editor shows it. The unassigned case on the workflow page
has the same double banner as the editor.

**Recommendation.** Delete the blocker banner on both pages. Keep `applyBlocker` and
`turnOnBlocker` for the disabled state and for refusing a press; keep `applyResultMessage` and
`switchResultMessage` for the result of a press (NotFound, NoDraft stay useful there). The copy
table's banner row changes its example (spec check refuses an example no screen shows) and gains
a "never": a banner never restates a disabled control or a fault banner on the same page.

### 2. "✓ Saved · Last changed on …"

**What it says.** Two states only: "Saving…" while any of eight mutations is in flight, else
"✓ Saved · Last changed on <updatedAt>". There is no unsaved state, because every edit is a server
write, and no error state, because errors go to the critical banner above.

**What the page already says.** Every button that writes carries Polaris `loading` while its
mutation is pending (Add step, Apply, Save, Remove), so "Saving…" doubles a spinner the merchant
is looking at. "Saved" is the resting state of the page: a label that is always true carries no
information. The date is the moment of the merchant's own last edit; they know when that was.

**What cutting it removes.** The one textual confirmation that a draft edit reached the server.
A failed write already shows as a critical banner, so the absence of a banner is the same
confirmation. Also removed: a date the workflow page prints anyway ("Last updated on …"), and
Flow keeps in its version history.

**A reason beyond clutter.** "Saved" sits a few lines under an Apply button. The draft model
means saved and in force are different things, and this line blurs them: a merchant who reads
"Saved" and closes the window may believe the change is live.

**What Shopify does.** The admin's model is the contextual save bar: unsaved changes are the
state worth announcing; saved is silence. The forms guidance says autosave "is incongruous with
the standard Shopify admin save UX". Baton's editor autosaves a draft on purpose, like Flow, which
logs draft changes "automatically … and require no additional steps from you" and shows no
"Saved" line. Google Docs' "All changes saved" is the counterexample, and it exists because a
document has neither an Apply step nor a per-action spinner.

**Recommendation.** Delete the line. No status or footer slot gets added to the copy table; the
rule is that a resting state is silent.

### 3. Character counts: one rule

**Today, four behaviours** for one concept: Polaris's `n/max` inside Instructions (because
`maxLength` is set), a hand-made `n/64` under Rename, "N characters left" on the note and reason
once within 200 of the cap, and nothing on team name, tag and email (whose `maxLength` stops
typing silently). `ListSearchField` deliberately sets no `maxLength` so that Polaris draws no
counter, which shows the counter is a side effect the code already works around.

**From first principles.** A count is useful under two conditions together: the limit is one the
person will reach writing normally, and reaching it silently would confuse them. A 64-character
name or a 32-character team name is rarely reached; when it is, a submit-time error under the
field ("Up to 32 characters") says so once, which is the controls table's rule for "a field that
refuses a value". A 500-character instruction or a 2,000-character note can be reached by someone
writing carefully, and stopping their keyboard at the cap with no warning is the confusing case.
Even then, a count on an empty field is, as the `noteCountFrom` JSDoc puts it, "a rule nobody
asked about".

**What Shopify does.** The product title has a 255 limit and no counter. The SEO page title and
meta description show "x of 70 characters used" / "x of 320 characters used" because those limits
come from search engines and merchants write to them. The Polaris web-components text-area page
says "when enforcing maximum length, show merchants how many characters they have remaining", and
its only example is a 160-character SEO description. So Shopify shows a count where the limit is
a real target, not everywhere a limit exists.

**Rule proposed**, as a row on the controls table:

> a text limit | a free text (note, reason, instructions) counts down in its details from
> `noteCountFrom(max)`: "N characters left"; a one-line field shows nothing and refuses on submit
> with its own error, "Up to N characters" | `maxLength` on the element (Polaris draws `n/max` on
> an empty field); a hand-made counter; a limit stated in help text

Instructions moves onto the note's countdown and loses `maxLength`; Rename loses its counter;
name, team name, tag and email lose `maxLength` and gain the submit error (the server already
refuses, so this is the message, not the rule). Pasted text past the cap is then refused on submit
rather than cut mid-paste, which the Polaris limitation note says `maxLength` does not reliably
prevent anyway.

**Trade-off.** A merchant pasting 600 characters of instructions learns at Add step rather than
while typing. The countdown at 300 characters catches the typing case; the paste case gets one
error and the text stays in the field.

### 4. The help line under Instructions

"Members see this at this step on every item. Up to 500 characters."

The second sentence states the number the counter shows, and under finding 3 the counter itself
only appears near the cap, so the number has no reason to be on the page at all. The first
sentence tells the merchant who reads the field. The Team select sits directly above it, so
"Instructions" after "Team" reads as instructions to that team without being told. The copy
table's help row says the slot "states a constraint or consequence the person can trip on" and is
empty "when there is none"; neither sentence is a trip hazard.

**What cutting it removes.** "on every item": that an instruction is written once per step and
shown on every item at it. A merchant could imagine they are writing a note for one order. The
editor is reached from the workflow page, not from an order, so the context already says
otherwise.

**Recommendation.** Delete `INSTRUCTIONS_HELP`. The e2e title "the editor stops instructions at
500 characters" changes to the countdown and the refusal.

### 5. "(no members)" in the Team select

**What it changes.** Nothing. A step's team is chosen by what the team does (Engraving goes to
the engravers). Whether that team has members today is a fact about the team, not about the
step, and the right fix is on the team page, not a different team on the step. An empty team is
allowed by design ("the run is created and waits for a member"). The moment the merchant picks
it, the page shows "Team has no members" and names it.

**The read.** `listTeams` runs `(select count(*) from TeamMember where teamId = t.id)` per team
against the `(teamId, memberId)` primary key: rows read ≈ teams + memberships, a few dozen per
page load at the target scale, against D1's per-million-rows pricing. It is not what the
workflow page costs. And cutting the suffix saves none of it, because `hasEmptyTeam` (the fault
banner, the index badge) reads the same count from the same query. The read goes only if the
fault goes from the workflow screens altogether.

**Recommendation.** Delete the suffix on both selects (the order page has the same code). The
Polaris select guidance says to put "enough context in each option label so merchants don't need
to open and read multiple options"; a member count is not context for this choice.

### 6. "Team has no members" is a badge, not a banner

The controls table, which is the app's own spec, says: "a fact about the page that disables
things | a banner above the content, warning or critical | a toast; a badge" and "a count of
items needing work | … a banner, unless the count disables something". An empty team disables
nothing. By the table it should not be a banner. The teams index already shows the same fact as
a warning badge, "No members", which is the vocabulary's word.

The JSDoc on `TeamLine` explains the current choice: one fault, one mark, so no badge on the step
because the banner already says it. Keep the principle and move the mark: a "No members" badge
on the step card under the team name, and no banner. The step is where the merchant looks, the
badge is what the teams index uses, and a critical banner is reserved for what actually stops
the workflow. "Needs a team" stays a critical banner because it disables Apply and Turn on.

This keeps the read in finding 5: the count is still needed for the badge. Finding 5's cut stands
on the clutter argument alone.

**What cutting the banner removes.** The sentence "That task will wait until a member joins." The
badge does not say what happens. The workflows index badge `emptyTeam` does not say it either, and
the merchant who created an empty team saw "Nobody is on this team" on the team page. If the
consequence needs stating, the team page is where a member gets added, so that is where it
belongs.

## After the cuts

The editor with the New step form open shows: the empty canvas, the form (Name, Team,
Instructions with no help line and no counter until 300 characters), Add step and Cancel, a
disabled Turn on. Nothing above, nothing below. With an unassigned task: one banner, "Needs a
team". With an empty team: a "No members" badge on that step and nothing else.

## Does it generalise

The user's concern is not this page. It is that each page was built alone, so a fix here leaves
the same thing standing elsewhere. This pass reads every merchant and member screen for the
same five patterns (`node scripts/copy-audit.ts`, 342 strings, and a grep of every `s-banner`
and `LocalDateTime` site on 2026-10-05).

### Pattern A: a banner that restates what the page already shows

| screen                 | banner                                                    | what already says it                                             | verdict                                                                                 |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| workflow editor        | "Turn on is unavailable" / "Not ready to apply" (warning) | empty canvas, disabled Turn on, open form; "Needs a team" banner | cut (finding 1)                                                                         |
| workflow page          | "Turn on is unavailable" (info)                           | "Needs a team" banner                                            | cut (finding 1)                                                                         |
| both workflow pages    | "Team has no members" (critical)                          | nothing on the page; the teams index badge                       | badge on the step (finding 6)                                                           |
| both workflow pages    | "Needs a team" (critical)                                 | "No team" under the step; it disables Apply and Turn on          | keep: it disables something                                                             |
| member's workflow page | "Closed" (info) with the closed reason                    | the Done badge on the item; `ClosedLine` is the reason           | keep the reason, drop the banner frame: the reason is a line under the item             |
| member's workflow page | "Blocked" (critical) with the reason and the actions      | the Blocked badge                                                | keep: it carries the actions                                                            |
| order page             | "Every item is done. Fulfill in Shopify." (success)       | each item's Done badge                                           | keep: it carries the one act left, off-screen (Polaris: success banner only with a CTA) |
| orders index           | "New orders stopped syncing at N open orders…" (critical) | nothing                                                          | keep: it disables sync and names what clears it                                         |
| orders index           | "Syncing… this page updates as orders arrive."            | the Sync button's spinner                                        | candidate: same shape as "Saving…"                                                      |
| every screen           | "Couldn't …" (critical)                                   | nothing                                                          | keep: a failed write                                                                    |
| team page              | delete refused (warning)                                  | nothing                                                          | keep: a press that did nothing, with the reason                                         |

Two of eleven kinds restate, and both are on the workflow pages. The closed-run frame and the
syncing line are the same shape as findings 1 and 2 on other pages. The rule holds app-wide
with three sites to change, and the banner row's "empty when" cell is where it goes.

Tone is the other half. Baton never dismisses a banner, and Polaris says an info banner is
"lower priority information that's always dismissible". So an undismissable info banner is a
contradiction: the two the app has (the workflow page's and the closed run's) are both cut
above. Rule: a merchant or member screen shows no info banner; an info fact is a line or a
badge. Admin screens are exempt (they are tables for one person).

### Pattern B: a line that announces the resting state

| screen          | line                                                                      | verdict                                                                 |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| workflow editor | "✓ Saved · Last changed on …" / "Saving…"                                 | cut (finding 2)                                                         |
| orders index    | "Syncing… this page updates as orders arrive." (and "Loading…" before it) | cut: the Sync button carries `loading`; the list fills as rows arrive   |
| workflow page   | "Last updated on …"                                                       | keep: a details page's one date, read-only, not the merchant's own edit |

The toast row already carries the principle for writes: a toast is empty "when the result is
visible where the person is looking". A page's resting state is the same case with no event.

### Pattern C: a date or count on an index row that nobody acts on

| index       | columns                               | the date or count | ordered by it | acted on                             |
| ----------- | ------------------------------------- | ----------------- | ------------- | ------------------------------------ |
| teams       | Team, Members, Workflows, Created     | Created           | no (by name)  | no                                   |
| members     | Email, Teams, Created                 | Created           | no            | no                                   |
| workflows   | Workflow, Status, Tag, Steps, Updated | Updated           | no            | no                                   |
| orders      | Order, Placed, …                      | Placed            | yes           | yes: the merchant works oldest first |
| team page   | Member, On team since                 | On team since     | no            | no                                   |
| member page | Team, On team since                   | On team since     | no            | no                                   |

Shopify's product and customer indexes carry no Created column by default; its orders index
carries Date because orders are worked in date order. Six Baton index tables show a date, one
of which anyone orders by. The Members, Workflows and Steps counts are the rows' content, not
chrome, and stay. This is a question, not a finding: a date column is cheap and some merchants
like one, but it is the same instinct as "Last changed on", and it reads the same way.

### Pattern D: a paragraph that explains the product on every visit

| screen          | paragraph                                                                               | shown when                                            |
| --------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| members index   | "Members sign in with their email. Put each one on a team, or they have nothing to do." | always, above the table; and again as the empty state |
| teams index     | "A team is who can work a task. Assign one to each task in a workflow."                 | always, above the table                               |
| home page       | "Members sign in with their email."                                                     | always                                                |
| home page       | "Each order counts once, when work starts on it."                                       | always, under the usage count                         |
| workflow editor | "Members see this at this step on every item. Up to 500 characters."                    | always, under the field (finding 4)                   |
| team page       | "Nobody is on this team, so its tasks wait until a member joins."                       | empty state only                                      |
| member page     | "A member with no team has nothing to do."                                              | empty state only                                      |
| workflow editor | "Create a team before adding steps."                                                    | only when there are no teams                          |

The last three are right: the explanation is in the empty state, where the person has nothing
else to read and the next act is the button beside it. The first five are the same sentence on
the hundredth visit as on the first. Shopify's indexes carry no intro paragraph; its empty
states do. Rule: a screen explains its concept in its empty state and nowhere else. The home
page's two lines are the same shape; the billing one ("Each order counts once") is the copy
table's own example for the body slot, so cutting it changes the row's example.

### Pattern E: a state or count in a select option, and counters on fields

Select options: the two "(no members)" sites are the only annotated options in the app
(the orders index "Any team" and "Deleted team" are values, not annotations). Finding 5 covers
both.

Counters: finding 3's table is already app-wide (ten fields across seven screens, four
behaviours). The rule covers every text field the app has.

## Rules for the specs

Each rule below is written as the cell it changes, the check that holds it, and the sites it
changes now. The tables are the spec; a rule that is not on a table is a preference.

| rule                                                                                                                                                                                                                            | where it lives                                                                                                                    | held by                                                                                                                                                                                 | sites now                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **One fact, one place.** A banner is empty when a disabled control, an empty canvas, an open form, a badge or another banner on the page already states the fact.                                                               | copy table, banner row, "empty when"; tone list gets the sentence                                                                 | `pnpm spec check` (example); a test per cut site; no lint can see redundancy                                                                                                            | editor and workflow page blocker banners; closed-run frame                      |
| **No info banner on a merchant or member screen.** An info fact is a line or a badge. Admin screens exempt.                                                                                                                     | controls table, banner row, tone column: "warning or critical"                                                                    | `scripts/rules-lint.ts` refuses `tone="info"` on `s-banner` under `src/routes/app.*`, `shop.*` and `src/components/`                                                                    | workflow page blocker; closed run                                               |
| **A fault that disables something is a banner; a fault that disables nothing is a badge on the thing.**                                                                                                                         | already the controls table's banner row; the empty-team row of `WORKFLOW_FAULT_LABEL` names its control                           | the e2e title for the two faults                                                                                                                                                        | "Team has no members"                                                           |
| **The resting state is silent.** A write in flight is `loading` on the pressed button; a page says nothing when nothing is happening.                                                                                           | controls table, new row: "a write in flight \| `loading` on the pressed button \| a status line; a 'Saved' or 'Syncing' sentence" | `scripts/rules-lint.ts` retires "Saved", "Saving", "Syncing" and "Loading" as screen copy (the `RETIRED` table)                                                                         | editor footer; orders index sync line                                           |
| **A text limit counts down on free text and refuses on submit elsewhere.** Free text (note, reason, instructions): "N characters left" from `noteCountFrom(max)`. One-line fields: no counter, the field's own error on submit. | controls table, new row (finding 3)                                                                                               | `scripts/rules-lint.ts` refuses `maxLength` on `s-text-field`, `s-text-area` and `s-email-field` in `src/routes/` and `src/components/` outside `screen/`; the countdown becomes a part | instructions, rename, name, team name, tag, email                               |
| **Help is empty when the field or its neighbours already say it.** Help never states a number the field enforces, and never names the reader when the form does.                                                                | copy table, help row, "empty when" and "never"                                                                                    | `pnpm spec check` (example)                                                                                                                                                             | `INSTRUCTIONS_HELP`                                                             |
| **A select option is a name.** No state or count in the option label.                                                                                                                                                           | controls table, new row: "a choice among records \| a select of names \| a count or state in the option"                          | `scripts/rules-lint.ts` refuses a parenthesis inside an `s-option` text                                                                                                                 | two selects                                                                     |
| **A screen explains itself in its empty state only.** No paragraph about the product above a list that has rows, or on a page that has content.                                                                                 | copy table, body row, "never": "explains the product beside content"; empty row unchanged                                         | `pnpm spec check` (example, if the home page line goes); a test per index that the paragraph is absent with rows                                                                        | members index, teams index, home page (question 8)                              |
| **A date column on an index is there only when the list is ordered by it or the person acts on it.**                                                                                                                            | parts table, paged table row, "never"                                                                                             | the Screens table lists each index's columns (question 9 decides whether that column is added)                                                                                          | Created on teams and members; Updated on workflows; On team since on both pages |

How each check works today: `pnpm spec check` parses the copy and controls tables and refuses
an example no screen shows, so a rule written as a row with an example is checked for free.
`scripts/rules-lint.ts` is a list of regexes over `src/routes/` and `src/components/`, so a
rule that has a syntactic shape (`tone="info"`, `maxLength=`, a parenthesis in an option, a
retired word) is a one-line addition with a test in `rules-lint.test.ts`. Redundancy between
two elements has no syntactic shape; that rule is held by the table's "empty when" cell, by the
JSDoc on the site that follows it, and by `node scripts/copy-audit.ts` run after the plan.

The order of work in the plan: the rows first, then the lint, then the sites the lint names,
then the sites the rows name, then the audit.

## What a plan touches

- `app.workflows.$workflowId_.edit.tsx`: the blocker banner, the footer line, `INSTRUCTIONS_HELP`,
  the select label, `maxLength` on Instructions, the Rename counter.
- `app.workflows.$workflowId.tsx`: the info banner, the Rename counter, Duplicate `maxLength`.
- `app.orders.$orderId.tsx`: the select label.
- `WorkflowSteps.tsx`: `TeamFaultBanners` loses `empty_team`; `TeamLine` or the step card gains
  the badge and its JSDoc is rewritten.
- `WorkflowSwitch.tsx`: `switchResultMessage` stays for the press result only.
- `RunTextModals.tsx`: `countdown` becomes the shared control (a part under
  `src/components/screen/`, since Instructions is a third site).
- Name fields across teams, workflows, members: drop `maxLength`, add the submit error.
- `Screen.ts`: the banner row's example and "never" cell; a new controls row for text limits; the
  copy table's help row unchanged.
- Tests to retitle or rewrite: "a fresh workflow turns on from the editor, then edits go through
  the draft" (asserts the banner text and "✓ Saved"); "the workflows index and the workflow page
  show Needs a team and Team has no members apart" (asserts two critical banners); "the editor
  stops instructions at 500 characters" (asserts the help text and the cap); the rules-lint
  retired-copy test if "Turn on is unavailable" is retired as a phrase.

## Decisions

Taken 2026-10-05 through Plannotator; every recommendation accepted.

1. **Blocker banner: cut on both pages.** No replacement. `applyBlocker` and `turnOnBlocker`
   keep the controls disabled and refuse a press; `applyResultMessage` and
   `switchResultMessage` serve the press result only.
2. **"✓ Saved · Last changed on" / "Saving…": cut.** Spinners on the busy button, a critical
   banner on failure, the date on the workflow page. No status slot is added.
3. **Character counts: the countdown rule.** Free text (note, reason, instructions) counts down
   from `noteCountFrom(max)` as "N characters left"; one-line fields show nothing and refuse on
   submit with the field's own error. No `maxLength` on any element.
4. **Help under Instructions: cut both sentences.** `INSTRUCTIONS_HELP` goes.
5. **"(no members)": cut** on the editor and the order page selects.
6. **"Team has no members": a "No members" badge on the step, no banner.** "Needs a team" stays
   a critical banner because it disables Apply and Turn on. The read stays.
7. **"Syncing… this page updates as orders arrive." and the closed run's info frame: cut.** The
   Sync button carries `loading`; the closed reason is a line under the item.
8. **Explainer paragraphs: cut all five.** Members index head, teams index head, both home page
   lines, and the Instructions help. Empty states keep theirs. The body row's example changes.
9. **Date columns: drop Created (teams, members) and On team since (team page, member page);
   keep Updated on workflows** and Placed on orders.
10. **The four lint rules are added:** no `tone="info"` banner on a merchant or member screen;
    no `maxLength` on a text, text-area or email field outside `src/components/screen/`; no
    parenthesis in an `s-option`; "Saved", "Saving", "Syncing" and "Loading" retired as screen
    copy.

## Status

Decided 2026-10-05, all ten accepted. `docs/workflow-editor-noise-plan.md` implemented 2026-10-06, all green, uncommitted; its Deviations and issues section records eight departures.
