# Create, edit, delete: one pattern for every merchant screen

Written 2026-10-05. Prompted by the members page (screenshot: the Teams column with `+4`, the row
buttons Edit teams and Remove, and the modal "Remove m3@m.com? They leave their teams and can no
longer sign in. Their past work stays on the record.").

Three questions:

1. Is "Remove" the right word for what the members page does? Is "Edit teams" how Baton edits
   things?
2. What should a delete's confirm modal say?
3. Does the members page scale: many teams in the Edit teams modal, many teams in the Teams column,
   long names?

Underneath them: the merchant screens create, edit and delete three things (teams, workflows,
members), and each was built on its own. This doc lists what each does, finds where they disagree,
and proposes one pattern, written as rows on the controls table in `Screen.ts`, so the next screen
follows it instead of inventing a fourth.

Related: `docs/long-names-research.md` and `docs/long-names-plan.md` (merged 2026-10-05, all
decisions taken and implemented) set the rule for names a screen cannot print whole, as the parts
table on `ScreenPart` in `Screen.ts`. This doc applies that rule and does not repeat it. The
[re-check](#re-check-after-the-parts-refactor) at the end says where the refactor changed what this
doc proposes.

## Short answers

- **Remove is the wrong word.** The members page deletes the `Member` row. The vocabulary already
  says so: the JSDoc on `Member` reads "delete a member and they leave their teams", and the server
  function is `deleteMemberFn`. Remove is the right word for one thing only: taking a member off a
  team, where both still exist afterwards. That is how the team page uses it, and how Shopify's
  details template uses it ("Remove 16-Pieces Puzzle template" for a related row, "Delete" for the
  resource).
- **"Edit teams" is a one-off.** No other screen edits a set by replacing it from a checklist. The
  team page edits the same set from the other side with Add members and a Remove per row. Rename is
  the verb for a name, Edit is the verb for a workflow's tasks. Edit teams is a third way.
- **The confirm should not explain the product.** The current body describes sign-in and history,
  says "they" of one person, and goes stale the day either changes. The proposal is a fixed sentence.
- **It does not scale, and the fix is the same pattern the team page already has.** A member gets
  their own page, like a team and a workflow. Their teams are a list on it, added through a modal
  that searches, removed one row at a time. The members index shows a count, not the names.

## What the screens do today

| thing    | index                                      | row on the index                                                                                          | create                                                    | detail page                  | edit                                                                                                       | delete                                          |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| team     | the teams index                            | name (link), No members badge, member count, Used by: every workflow name, Created                        | Create team: name; then the team page                     | the team page                | Rename (More actions); members: Add members modal, Remove per row                                          | Delete (More actions), modal, then index        |
| workflow | the workflows index                        | name (link), state badges, tag as a token, steps, Updated                                                 | Create workflow: name, tag; then the workflow page        | the merchant's workflow page | Rename, Duplicate (More actions); tasks: Edit opens the editor                                             | Delete (More actions), modal, then index, toast |
| member   | the members page (there is no member page) | email as a token (not a link), up to four team chips then `+N`, No teams badge, Added, Edit teams, Remove | Add member: email and a team checklist; stays on the page | none                         | Edit teams: a modal headed "Teams", the email in its body, every team as a checkbox, Save replaces the set | Remove (row button), modal                      |

Checked against the code on 2026-10-05 after the parts refactor (commit e782ba5 and e4fe0a2). The
refactor moved every screen onto the parts and changed three cells: the workflow tag is a token, not
a badge; emails are tokens that wrap anywhere; and the Edit teams modal is headed "Teams" with the
email in its body, because a modal heading cuts to one line and an email can be any length (the
long-names plan's deviation 19 records the change). The verbs, the modals and the row buttons are as the table says.

Teams and workflows follow one pattern: an index, a create modal that asks for what identifies the
thing and then opens its page, and a detail page that holds every edit and the delete. Members are
the exception on every column.

## Findings

**1. Delete is called Remove.** The button, the modal heading, the primary button and the error
("Couldn't remove the member.") say Remove. The vocabulary, the server function and the repository
say delete. The row is deleted from D1 and the member's open connections are closed
(`deleteMemberFn`). Nothing of the member is kept: run tasks keep the email they snapshot when the
task was done, which is a copy, not the member. So "remove" suggests the member is still somewhere,
and they are not. Shopify's guidance asks for one verb per identical action ("Delete product",
"Delete collection": `refs/shopify-docs/docs/apps/design/content/voice-and-tone.md`), and the teams
and workflows already say Delete.

**2. Remove means two things in one app.** On the team page, Remove takes a member off the team;
they keep the shop and their other teams. On the members page, Remove deletes them. The same red
button word does a small reversible thing on one screen and an irreversible one on the next.

**3. Edit teams is a third editing pattern.** Today:

- Rename: one field, in a modal, from More actions (teams, workflows).
- Edit: the workflow's tasks, in the editor.
- Add + Remove: a set, as a list with Add and a Remove per row (a team's members).
- Edit teams: a set, as a checklist of everything, saved whole (a member's teams; also inside Add
  member).

The last two edit the same table (`TeamMember`) from opposite ends and look nothing alike.

**4. The checklist does not scale.** Edit teams lists every team in the shop as a checkbox, with no
search. `ShopLimits.maxTeams` is 25 today (provisional, like every ceiling there), so the worst case
is 25 rows in a modal that scrolls. If the cap rises, as it should, the modal becomes a long scroll
of checkboxes to find the one to change. The team page's Add members modal already solved this for
the other direction: it lists only the candidates (members not on the team), shows a search field
from six candidates (`SEARCH_FROM`), and keeps ticks across searches.

**5. The Teams column does not scale.** Four chips, then `+N`. The parts table allows a team name in
a chip (a capped name in a cutting control), so the cut is not the fault. The count is: four
32-character team names do not fit the column at any width, so the row wraps to several lines, and
`+N` hides which teams. The comment on `MAX_CHIPS` says "the full list is one click away in Edit
teams", which is a modal for changing the set, not for reading it.

The same problem, larger, is on the teams index: the Used by column prints every workflow that uses
the team. `WorkflowLimits.maxWorkflows` is 1000. The team page's Used by card does the same, with no
cut.

**6. The confirm copy explains the product.** "They leave their teams and can no longer sign in.
Their past work stays on the record." Three problems:

- It describes how sign-in and history work. If either changes, the sentence is wrong and nothing
  checks it.
- "They" for one person, beside a heading that names one email, reads as plural.
- A variant adds "This will leave Engraving, Rush with no members." It is computed, so it is true,
  but it is the third sentence in a modal whose only job is to stop a mis-press.

The team page's Remove modal restates its heading in its body ("Remove m1@m.com from Engraving?"),
which the copy table's confirm row forbids.

**7. The spec contradicts itself on Remove.** The controls table lists remove among the verbs "with
no undo" that get a modal. Its first row says a verb reversible on the same screen gets a button and
no modal. Taking a member off a team is reversible on the same screen: Add members puts them back
(the only loss is the "On team since" date). So by the first row, the team page's Remove should have
no modal.

**8. Emails have no cap.** `Email` in Platform has no length check. Every other name a merchant types
is capped (team 32, task and workflow 64). An email is the member's name on every screen, including
the heading this doc proposes for the member page.

## The pattern

One row per job. These go on the controls table in `Screen.ts` (the "a verb with no undo" and
"confirm" rows change; the rest are new). "Thing" means a team, a workflow or a member: something
the merchant creates and deletes.

| job                                                        | control                                                                                                                                                                                                                                                                                             | never                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| a list of things the merchant creates                      | an index page: a table, one row per thing, the thing's name a link to its page; no buttons on a row                                                                                                                                                                                                 | row buttons that edit or delete                            |
| creating a thing                                           | Create in the title bar; a modal that asks only for what identifies the thing; on success, the thing's page                                                                                                                                                                                         | asking for its relations in the create modal               |
| everything about one thing                                 | its detail page: heading is its name, printed whole again in its Details card when it is a token (question 13); edits and the delete are here and nowhere else                                                                                                                                      | a second place that edits it                               |
| a field of the thing (its name)                            | Rename in More actions; a modal with one field                                                                                                                                                                                                                                                      | inline editing                                             |
| a set the thing holds (a team's members, a member's teams) | a section on the detail page: one row per related thing, its name a link; an Add button (Add members on a team, Add to teams on a member) opens a modal of candidates only, searchable from six; Remove on each row, no modal                                                                       | a checklist of everything, saved whole                     |
| a related set on an index row                              | a count; a badge when it is zero and that is a fault (No members, No teams)                                                                                                                                                                                                                         | the names, chips, `+N`                                     |
| a related set on a detail page                             | the list, cut at a depth with "Show <n> more of <m>" (the existing "a list cut at a depth" row)                                                                                                                                                                                                     | every row, uncut                                           |
| deleting a thing                                           | Delete in More actions on its page; the modal: heading "Delete <name>?" for a capped name, "Delete <noun>?" with the name in the body when it is a token (question 13); body "This can't be undone.", primary Delete (critical), dismiss Cancel; on success, the index and a toast "<Noun> deleted" | a delete on an index row; a body that explains the product |
| taking a thing out of a set                                | Remove, on the row in the set; no modal, because Add puts it back on the same screen                                                                                                                                                                                                                | "Remove" for a delete                                      |
| More actions with one entry                                | the entry as a secondary button in the title bar                                                                                                                                                                                                                                                    | a menu with one item                                       |

The verbs, as screen labels: **Create**, **Add** (a member to the shop, or a related thing to a
set), **Rename**, **Edit** (a workflow's tasks only), **Duplicate**, **Delete**, **Remove** (from a
set only). "Edit <noun>s" for a set is retired.

## The members page, proposed

The members index:

```
Members                                                   [Create member]

Search by email
Email                          Teams      Created
lead@m.com                     8          Oct 5, 1:05 PM
m1@m.com                       3          Oct 5, 1:05 PM
m2@m.com                       1          Oct 5, 1:05 PM
m3@m.com                       No teams   Oct 5, 1:06 PM
```

The member page (new route). The sketch below is the one the decisions were taken on. Its heading
needs a second look: Polaris cuts a page heading to one line, and the long-names rule says an email
never goes where it can be cut. Question 13 in the re-check recommends Shopify's model: keep the
email as the heading and print it whole in the Details card.

```
< Members
m3@m.com                                                     [Delete]

Teams                                                  [Add to teams]
  This member isn't on a team yet.

                                              Details
                                              Created  Oct 5, 1:06 PM
```

With teams, the section is a table: team name (link to the team page), On team since, Remove.

Create member asks for the email only. On success the merchant lands on the member page, where the
empty Teams section and its Add to teams button are the next step. That is how Create team and
Create workflow already work.

The delete modal, as decided. The heading has the same fault as the page heading (question 13):

```
Delete m3@m.com?

This can't be undone.

                                              [Cancel]  [Delete]
```

What this deletes from today's code:

- the Edit teams modal, its state, and `setMemberTeamsFn`'s set-replace (adding and removing one
  edge are the team page's writes, from the other side);
- `MemberTeamsFields` (the checklist, shared by Add member and Edit teams);
- `MAX_CHIPS` and the chip cell;
- the emptied-teams computation and both confirm sentences;
- the Remove modal on the team page.

What it adds: one route (the member page), an Add to teams modal that mirrors Add members, and a row
on the Screens table ("the member page"). The members page becomes "the members index".

## Decisions

Answered 2026-10-05 in Plannotator.

1. **Delete a member, not remove.** The button, heading, primary button and error say Delete.
   Remove is kept only for taking a thing out of a set (a member off a team).
2. **A member gets a detail page.** The members page becomes the members index, and a new member
   page holds the member's teams (Add to teams with a searchable candidate list, Remove per row)
   and the delete.
3. **The create modal for a member asks for the email only**, then opens the member page. The team
   checklist leaves the modal. Its button is Create member (decision 12).
4. **Every delete confirm body is "This can't be undone."** for members, teams and workflows.
   `DELETE_TEAM_CONFIRM`, `DELETE_WORKFLOW_WARNING` and the member sentences go. The copy table's
   confirm row is rewritten: form "This can't be undone."; never explains what the product does.
5. **Remove from a set has no modal and no toast.** The controls table's "no undo" row drops
   "remove".
6. **A related set on an index row is a count**, with a No teams or No members badge at zero. The
   teams index Used by column becomes a Workflows count.
7. **A related set on a detail page is cut at 25 rows** with "Show <n> more of <m>": the team page's
   members and Used by card, and the member page's teams.
8. **`Email` is capped at 254 characters.** Today nothing limits it: the `Email` schema trims and
   lowercases only, and the D1 `Member.email` check enforces lowercase and trim only. The schema
   refuses a longer address with a field error ("Enter an email of 254 characters or fewer"); it
   never truncates, because a cut address is a different address and sign-in would match nobody.
   The D1 check gains `length(email) <= 254` (edited in the initial migration, per the no-migrations
   rule while prototyping).
9. **`ShopLimits.maxTeams` rises to 50**, still provisional; its JSDoc says so.
10. **The pattern lives on the controls table in `Screen.ts`**, and the verbs as a table in the
    shop-work vocabulary with a screen-label constant the screens read, and `scripts/rules-lint.ts`
    refusing "Edit <noun>s" and "Remove" on a delete.
11. **Order of the work:** members first, then teams and workflows, then the spec rows and the lint.

12. **Create member, Delete member, and a Created column.** Create and Delete are for a thing that
    begins or stops existing in Baton; Add and Remove are for a set, where both sides already exist.
    A member begins to exist when the merchant enters the email (there is no `Member` row before,
    and re-creating a deleted email mints a new id), so the members index's button is Create
    member and its column is Created, as on the teams index. Add stays for Add members on a team
    and Add to teams on a member. The verbs table (decision 10) reads: Create and Delete for a
    thing, Add and Remove for a set, Rename for a name, Edit for a workflow's tasks, Duplicate for
    a workflow. `Repository.addMember` is renamed `createMember` in the same change.

Found while answering: the data-model rows on `D1_TABLES` say "a merchant pauses nobody, only
removes them" and "a change is a delete and an add". They become "only deletes them" and "a delete
and a create".

Questions 13 to 16 in the re-check below were answered 2026-10-05.

## Re-check after the parts refactor

The parts refactor (`docs/long-names-plan.md`, merged 2026-10-05) landed after the decisions above.
It gave every screen a fixed set of parts, and it wrote down, as the parts table on `ScreenPart` in
`Screen.ts`, how each kind of text is shown when it is long. Checked here: which of the twelve
decisions it changes. Decisions 1, 2, 3, 5, 6, 9, 10, 11 and 12 stand. The findings stand.

### Long emails: is "print it whole everywhere" a good rule?

The long-names work sorted every printed value into four kinds. An email is in the "token" kind,
with SKUs, tags, order numbers and shop domains: strings Baton did not choose and cannot cap at a
useful length. The rule for a token is: on a list and on its own page, print it whole and let it
break anywhere; in a control that cuts text to one line with no way to read the rest (a page title
bar, a modal heading, a badge, a chip, a toast), never put it there, except the order number.

Does that hold up for an email? Three facts:

- **Real emails are short.** Almost every address is under 40 characters. 254 is the ceiling the
  mail standard sets (RFC 5321, a path is 256 octets with its angle brackets), and nobody signs up
  with one. So "print it whole" costs one line in practice and, in the worst case nobody will hit,
  five lines at phone width, once, on the page about that one member.
- **A cut email is a wrong email.** The part an ellipsis takes is the domain, which is the part that
  tells `j.smith@acme.com` from `j.smith@acme.co.uk`. On the one screen where the merchant is about
  to delete someone, that is the part they need.
- **Shopify does the same.** Its details template (`refs/shopify-docs/docs/api/app-home/latest/
patterns/templates/details.md`) heads the page with the record's name and heads the delete modal
  "Delete product?", with the name in the body. Its grammar guide writes the confirm as "Are you
  sure you want to delete **Sunset T-shirt**?", the name bold in a sentence, not in the heading.
  Polaris cuts a page heading to one line on its own; Shopify's admin accepts that cut because the
  name is also whole in the body (a customer page: the name in the title bar, the name and email in
  the first card).

So the rule is right where it matters, on lists and in bodies, and it is cheap. Where it is
awkward is the title bar: the rule as written says an email never goes there, which leaves the
member page headed "Member". Shopify's model is looser and better: the title bar carries the name,
cut by Polaris only if it does not fit, and a labeled field in the body prints it whole. For an
email that is one line of a Details card ("Email m3@m.com"), not a repeat of the heading, which is
what the long-names follow-up F1 objected to for a 255-character item title.

The email cap at 254 is a separate thing and stands: it is the schema refusing an address the mail
standard would refuse, so the database never holds one. Nothing in the refactor touched `Email`;
the mistake was in decision 8 of this doc, which said the cap was for the heading. It is not.

### Open questions

13. **What heads the member page, and what heads the Delete member modal?**

    Options:

    1. **Shopify's model.** The page is headed by the email; Polaris cuts it only if it does not
       fit the title bar, and the Details card prints it whole as its first row. The modal is headed
       "Delete member?" and its body names the email whole: "Delete m3@m.com? This can't be undone."
       The parts table's token row changes one cell: a title bar may carry a token when the same
       page prints it whole in a field. The copy table's heading row says a modal that asks names a
       capped name in its heading and puts a token in the body.
    2. **The rule as written.** The page is headed "Member", the email whole on the body's first
       line; the modal is headed "Delete member?" with the email in its body.
    3. **No change.** Email in both headings, cut if long, printed nowhere else whole.

    **Accepted 2026-10-05: option 1.** It is what Shopify's own admin does, it keeps the identity whole
    where the decision is made (the modal body, the Details card), and the heading reads as a page
    about a person rather than a page called "Member". Option 2 is correct and dull. Option 3 cuts
    the one string the merchant must read before pressing Delete. Shopify puts the noun in a delete
    heading even for products, so "Delete member?" with the name in the body is the pattern, not a
    workaround.

    The teams and workflows modals already say "Delete Engraving?", a capped name in the heading.
    They stay: a capped name fits, and the heading row allows it. The two forms differ only in
    whether the name is one Baton capped.

14. **Decision 7 said: cut three lists at 25 rows with a "Show 25 more" button. Does any of them
    need it, and what is the one rule?**

    The three lists: the members on a team page, the workflows that use a team (the Used by card
    on the team page), and the teams on the new member page. Their ceilings today are 12, 1,000 and
    25 (50 after decision 9), all provisional, so a rule that depends on them breaks the day one
    moves.

    **What Shopify does.** Its templates are explicit. The details template says: "If more than 10
    rows are needed, details page tables should use the paginate, hasPreviousPage, hasNextPage,
    onPreviousPage, and onNextPage attributes" (`refs/shopify-docs/docs/api/app-home/latest/
patterns/templates/details.md`). The resource-index template says the same at 100 rows. So a
    related table on a details page shows ten rows and then Shopify's own previous and next
    controls on `s-table`, read a page at a time from the server. The table docs add: "Use
    pagination for datasets with more than 50-100 rows" (`web-components/layout-and-structure/
table.md`, best practices).

    **What Baton does.** The merchant side already follows Shopify: the orders index and the
    workflows index are `s-table paginate`, read a page at a time, the page in the URL. The teams
    index and the members page load everything. The member side uses "Show 25 more" (a deeper read,
    not Shopify's control), because a member reads on a phone where previous and next is the wrong
    shape; that was decided in the workflows list work and stands.

    **Accepted 2026-10-05: one rule per side, and it is already half written.**

    - A merchant table is `s-table paginate`, read from the server a page at a time, with the page
      in the URL: 25 rows on an index (the orders index's `ORDERS_PAGE_SIZE`), 10 on a details page
      (Shopify's number). The controls appear only when there is another page. This covers the
      three lists here, the teams index and the members index, and every table to come, with no
      ceiling in the rule.
    - A member list is cut at 25 with "Show 25 more" (the existing controls-table row).

    The controls table's "a list cut at a depth" row gains a sibling, "a merchant table with more
    rows than its page", whose control is `s-table paginate`, and whose never cell is "Show more;
    loading every row and hiding some". Decision 7 is replaced by that row. The index table part
    in the parts table already names pagination as something it fixes.

15. **The controls table has a row for "going back from a page to the list that opened it". It
    says: a "← Workflows" link above the heading, never the admin's breadcrumb. Does that apply to
    merchant pages?**

    The row was written for the member's workflow page (commit e4fe0a2), which has no admin chrome.
    Every merchant details page (order, workflow, team) uses the admin's breadcrumb through
    `s-link slot="breadcrumb-actions"`, and that is where a merchant expects it.

    **Accepted 2026-10-05: member pages only.** The row's job cell says "a member page". The new
    member page gets a breadcrumb to Members like the team page's to Teams.

16. **Should the team page and the member page toast "<Noun> deleted" after a delete, as the
    workflow page toasts "Workflow deleted"?**

    **Accepted 2026-10-05.** Every delete lands on the index and toasts "<Noun> deleted". The plan
    adds the toast to the team page and the member page.

### Other things the plan has to know

- The Screens table now has a `template` column that `pnpm spec check` reads. The member page's row
  is a `details` page headed by the member's email; the members page becomes the members index.
- The lint refuses layout in a route. The member page is built from the parts the team page already
  uses (`TableFrame`, `End`, `Pairs`, `Things`, `Token`), so it needs no new part.
  `MemberTeamsFields` goes. The Add to teams modal is the Add members modal mirrored: a search
  field from six candidates and a choice list.

## Status

Re-checked 2026-10-05 against the merged parts refactor. The inventory and findings are current.
Questions 13 to 16 are accepted. No open questions remain; the plan is `docs/crud-screens-plan.md`. When they are answered, write the plan.
