# Plan: the Teams and members help pages

The next row on the roadmap in `docs/help-research.md`, written 2026-10-08 after 037b72d. Three
page bodies under the Teams and members section (the hub stays as the skeleton renders it), eight
merchant pictures, and two pictures placed again from Getting started. Run the way
`docs/help-workflows-plan.md` was: two builders split by file, then the orchestrator's pass and
review.

The plan was not reviewed before implementation; its decisions are at the end, and the review
comes after, on the Deviations section.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type", "Tone and naming rules for help",
  "Screenshots", "Decisions", "How a content cycle runs". Read `docs/help-workflows-plan.md` whole:
  this plan has the same shape, and its Deviations, Review and Follow-ups record what the admin
  forced on the script and what the review changed.
- The code this extends: `scripts/help-screenshots.ts` (`MERCHANT_SHOTS`, the four shapes, the
  overlap check, `openScreen`, `clickHoisted`, `cancelModal`, `clickMenuItem`, `openWorkflow`,
  `--section`), `src/lib/helpPictures.ts` (the eight `teams-and-members/*` entries are already
  in, with provisional `aspectRatio` and alt text, marked "Provisional until shot" in their
  comments), `src/components/help/bodies.tsx`, the bodies under
  `src/components/help/getting-started/first-team.tsx` and `src/components/help/workflows/managing.tsx`,
  `test/integration/help-pages.test.ts`, `e2e/help.public.spec.ts`.
- The admin drivers: `e2e/app.ts` (`gotoApp`, `appFrame`, `openScreen`, `clickHoisted`,
  `hoistedEnabled`), `e2e/hydration.ts`, and the locators in `e2e/teams.spec.ts` and
  `e2e/members.spec.ts` (the team page's More actions is `s-menu#team-actions`; the member page's
  Delete member is a hoisted secondary button, no menu; the modal ids are `create-team`,
  `rename-team`, `delete-team`, `add-team-members`, `add-member`, `add-member-teams`,
  `delete-member`). Copy a locator into the script; do not import a spec.
- The merchant screens the pages describe: `src/routes/app.teams.index.tsx` (the Teams page: Create
  team and its modal, the Team and Members columns, the No members badge, search by name, "No teams
  yet"), `app.teams.$teamId.tsx` (the team page: Add members and its modal with its search field
  from `SEARCH_FROM` candidates, "Everyone is already on this team", the Members table with Remove
  per row and no modal, More actions with Rename and Delete, the Rename team modal with Name and
  Save, the Delete modal whose body is `DELETE_CONFIRM` and whose Delete waits on the socket,
  "Nobody on this team yet", the Details aside), `app.members.index.tsx` (the Members page: Add
  member and its modal with the Email field and its details line, the Email and Teams columns, the
  No teams badge, search by email), `app.members.$memberId.tsx` (the member page: Add to teams and
  its modal, "This member is on every team", the Teams table with Remove per row, Delete member and
  its modal, "Not on a team yet"), `src/lib/teams.ts` (`NAME_TAKEN`, `DELETE_CONFIRM`,
  `DELETED_TOAST`, `SEARCH_FROM`); the rules in `src/lib/domain/ShopWork.ts` (the JSDoc on `Team`,
  `Member`, `MemberId`, `TeamName`, `TEAM_NAME_MAX_LENGTH`, the `teamId` of a workflow task, the
  `teamName` snapshot on `RunTask`, `WORKFLOW_FAULT_LABEL`, the record verbs table, the Delete team
  row of the triggers table on `reconcileItem`), `ShopLimits` and `EMAIL_MAX_LENGTH` in
  `src/lib/domain/Platform.ts`, `deleteTeam` and `assignRunTaskTeam` in `src/lib/agent/ShopWork.ts`,
  `deleteMemberFn` in the member route, the member rows of `D1_TABLES` in `src/lib/D1Schema.ts`,
  and the member's empty list in `src/routes/shop.$shop.workflows.index.tsx` ("You're not on a team
  yet"). Every claim a page makes is checked against the route or the Domain symbol, never written
  from this plan.
- The copy lint reads `src/components/`: a body may not say "run", "in progress", "finish",
  "finished", "view" (except "View in Shopify"), "tab", "import", "resync", "picker", "staff",
  "attention", start a sentence with "Saved" or "Syncing", or join two ideas with a semicolon. The
  text of an `s-link` whose href is under `/help/` is held to the unanchored patterns only. "No
  Shopify account" is live copy and passes.
- The dev server must be healthy (`pnpm dev:status`). Do not run the whole e2e suite. Every run of
  the script ends with `pnpm seed`.
- Do not run `pnpm fmt` and do not commit. Record every departure from this plan, every problem,
  and every sentence you could not verify, under your own heading in
  [Deviations and issues](#deviations-and-issues).

## The pictures

Eight merchant pictures, all on the showcase shop, none of which writes anything: every modal is
cancelled. `firstTeam1` (the team page after Create team) and `firstTeam2` (the Add members
modal) are placed again on Creating a team.

| name                 | file                                            | shape | screen and state                                                                                                                                           |
| -------------------- | ----------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| creatingATeam1       | `teams-and-members/creating-a-team-1.png`       | page  | the Teams page: Create team, the search field, the eight showcase teams with their member counts, Weekend crew with No members                             |
| creatingATeam2       | `teams-and-members/creating-a-team-2.png`       | page  | Engraving's page: Add members, More actions, the Members table with ana, ben and carmen and a Remove on each row, the Details aside                        |
| addingAMember1       | `teams-and-members/adding-a-member-1.png`       | page  | the Members page: Add member, the search field, the seven showcase members with their team counts                                                          |
| addingAMember2       | `teams-and-members/adding-a-member-2.png`       | modal | the Add member modal, the Email field empty, its details line                                                                                              |
| addingAMember4       | `teams-and-members/adding-a-member-4.png`       | page  | ana@example.com's page: Add to teams, Delete member, the Teams table with Engraving and Finishing and a Remove on each row, the Details aside              |
| addingAMember3       | `teams-and-members/adding-a-member-3.png`       | modal | the Add to teams modal on ana@example.com's page: the search field (six candidates), the six teams she is not on, none ticked, Add greyed                  |
| removingAndDeleting1 | `teams-and-members/removing-and-deleting-1.png` | modal | the Delete member modal on ana@example.com's page: "Delete member?", the sentence naming the email, Cancel, Delete                                         |
| removingAndDeleting2 | `teams-and-members/removing-and-deleting-2.png` | modal | the Delete modal on Packing's page: "Delete Packing?", `DELETE_CONFIRM`, Cancel, Delete enabled (it waits on the socket, so the shot waits for it enabled) |

The rows are the shooting order. The Teams and members block goes **after** the Workflows block
and **before** the Getting started sub-block that begins with `firstWorkflow1`, because that
sub-block creates Assembly and leaves the Add members modal open, and the Teams page must show the
eight showcase teams alone. The block starts with `openScreen(page, "Teams")` and ends with the
Delete modal cancelled, so nothing is open for `firstWorkflow1`.

## Phase 1: the script (builder A)

Owns `scripts/help-screenshots.ts`, the eight PNGs, and the `aspectRatio`, alt text and comment
of the eight `teams-and-members/*` entries in `src/lib/helpPictures.ts`. Does not touch bodies,
the bodies map or the tests.

1. **A menu helper for the team page.** `clickMenuItem` hardcodes `s-menu#workflow-actions`. Give
   it a menu id parameter (or add a sibling that takes one) so the Workflows block's calls are
   unchanged and the team page's `s-menu#team-actions` is reached the same way. The locator is in
   `e2e/teams.spec.ts`.
2. **The eight shots**, as `take` functions, in the order of the table:
   - `creatingATeam1`: `openScreen(page, "Teams")`; wait for the row link "Woodshop" (the last
     row in name order); shape page.
   - `creatingATeam2`: press the row link "Engraving" in the frame; wait for
     `s-page[heading="Engraving"]` and `awaitNavigated`; wait for the cell text
     "carmen@example.com"; shape page.
   - `addingAMember1`: `openScreen(page, "Members")`; wait for the row link "gus@example.com";
     shape page.
   - `addingAMember2`: `clickHoisted` Add member; wait for the modal `s-modal#add-member`'s
     textbox "Email"; shape modal.
   - `addingAMember3`: `cancelModal(appFrame(page))`; press the row link "ana@example.com"; wait
     for `s-page[heading="ana@example.com"]` and `awaitNavigated`; wait for the link "Finishing"
     in the Teams table; shape page.
   - `addingAMember4`: `clickHoisted` Add to teams; wait for the modal `s-modal#add-member-teams`'s
     searchbox "Search teams by name" (she is on two of eight teams, so six candidates, which is
     `SEARCH_FROM`); shape modal.
   - `removingAndDeleting1`: `cancelModal`; `clickHoisted` Delete member (a page-scoped locator,
     as in `e2e/members.spec.ts`); wait for `s-modal#delete-member` and its text "This can't be
     undone."; shape modal.
   - `removingAndDeleting2`: `cancelModal`; `openScreen(page, "Teams")`; press "Packing"; wait for
     its heading and `awaitNavigated`; `clickMenuItem(frame, "team-actions", "Delete")`; wait for
     `s-modal#delete-team`'s text "This can't be undone." and for its Delete button to be enabled
     (`hoistedEnabled` or `toBeEnabled` in the frame); shape modal. Then `cancelModal`, in this
     shot's own `take` after the shape, or at the start of `firstWorkflow1`'s `take` as the
     Workflows block did; say which in Deviations. The block must leave nothing open for a
     `--section teams-and-members` run as well as a full one.
3. **Run it** with `--section teams-and-members`, set the eight `aspectRatio` values from the
   printed sizes, drop "Provisional until shot" from the comments, run again and confirm the sizes
   hold. Then run it once with no flag to confirm the whole set still passes in one page. Restore
   the other sections' pictures a full run re-shoots with
   `git checkout -- public/assets/help/members public/assets/help/getting-started public/assets/help/workflows`
   (only the seed's clock differs).
4. **Look at each picture** and rewrite its entry comment and alt text (30 to 60 words, the
   screen's words, what matters named) from what is there, not from this plan.
5. Report in Deviations: what each picture shows, anything that reads wrong, every overlay stem the
   check met that the last two plans' tables do not list, and how long the pass took.

## Phase 2: the three pages (builder B)

Owns `src/components/help/teams-and-members/*.tsx`, `src/components/help/bodies.tsx`,
`test/integration/help-pages.test.ts` and `e2e/help.public.spec.ts`. Does not touch the script, the
inventory or the PNGs.

Each body is a component under `src/components/help/teams-and-members/<slug>.tsx`, registered in
`HELP_BODIES` as `"teams-and-members/<slug>"`, in the Workflows bodies' shape: `s-section` per
sub-topic, `Things`, `s-paragraph`, `NumberedList`, `HelpPicture`, `s-link` by the target page's
title; a JSDoc naming the routes and Domain symbols the page was checked against. Two to four
sections a page; a control's label and a badge's label bold and exact; a screen sentence that is
not a control or badge reported in plain words, not quoted; a member spelled as their email. Links
to pages with no body yet (Fixing an issue, Reading an order, Limits) are still links.

1. **Creating a team** (`creating-a-team`), task. Sections: the Teams page (each row is the
   team's name and how many members it has; **No members** beside a team nobody is on; search by
   name; picture `creatingATeam1`); create a team (the numbered list as on Creating a team and
   adding members, then `firstTeam1`; no two teams share a name, compared exactly, so a capital
   makes a different name, and the screen says so under the field when it is taken; the length and
   the number of teams a shop can have are on Limits, link it; the new team's page opens, where
   nobody is on it yet and its tasks wait); add members (the numbered list, `firstTeam2`; the
   modal lists the members already added to Baton, with a search field when the list is long; a
   member can be on several teams; when everyone is on the team the modal says so; to add someone
   new, link Adding a member; picture `creatingATeam2` for the team's page with members); rename a
   team (**More actions**, **Rename**, **Name**, **Save**; the workflow pages show the new name on
   every task the team has; an item already on a workflow keeps the team name its tasks started
   with, from the `teamName` snapshot on `RunTask`, so a member's list may show both for a while).
2. **Adding a member** (`adding-a-member`), task. Sections: the Members page (each row is an
   email and how many teams they are on; **No teams** when none; search by email; picture
   `addingAMember1`); add a member (**Add member**, **Email**, **Add**; picture `addingAMember2`;
   they sign in with this email and need no Shopify account; the email is kept lowercase and
   trimmed, and an email already added opens that member's page rather than adding twice; the
   number of members a shop can have is on Limits, link it; the member's page opens, where they are
   not on a team yet); put them on teams (**Add to teams**, tick teams, **Add**; pictures
   `addingAMember3` and `addingAMember4`; a member can be on several teams and sees the tasks of
   all of them; the other way round is Add members on a team's page, link Creating a team; when
   they are on every team the modal says so); what the member sees next (Baton sends no email when
   you add a member, tell them yourself; they sign in on Baton's Sign in page with that email and
   get a link; one store opens its Workflows list, more open Your stores; a member on no team sees
   a line saying so and has nothing to do; their side is in Signing in, link it).
3. **Removing and deleting** (`removing-and-deleting`), task. Sections: remove a member from a
   team (**Remove** at the end of the row, on the team's page or on the member's page; no modal,
   since Add puts them back; both still exist; their list changes at once; a task they started
   stays started under their email and the team's other members see it, verify against the member
   list's Started by others and `startedByEmail`; place `creatingATeam2` or `addingAMember3` again
   only if the page needs a picture here, else none); delete a member (**Delete member** on their
   page, the modal names the email and says it can't be undone, **Delete**; picture
   `removingAndDeleting1`; they leave their teams and can no longer sign in, at once even if they
   are signed in; tasks they started or did keep their email in the history; adding the same email
   again is a new member on no team; the Members page opens and a toast says the member was
   deleted); delete a team (**More actions**, **Delete** on the team's page, the modal says it can't
   be undone, **Delete**; picture `removingAndDeleting2`; nothing stops you deleting a team in
   use, so check the workflows first; every task on the team, in every workflow, loses its team and
   reads **Needs a team**, and a workflow with such a task stops starting on new orders until you
   assign a team in the editor; an open task on an order already in Baton reads **Needs a team**
   too, and the merchant assigns a team on the order page, link Fixing an issue; a done task keeps
   the team's name; if the team's loss leaves one of two matching workflows eligible, the other
   starts, link Matching items by product tag; the Teams page opens and a toast says the team was
   deleted; its members still exist).

Check every sentence against the screen and the Domain symbol. Where a sentence and the screen
disagree, the screen wins and Deviations records it.

### Tests

The existing tests cover the new entries and bodies (inventory equals files, every picture placed,
alt length, aspect ratio, the e2e walk over `HELP_BODIES`). Add nothing unless a body needs it;
run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm exec playwright test --project=public`
and record the result. Until builder A's pictures exist, three tests fail on the missing files;
say so rather than skipping.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `pnpm exec playwright test --project=public`
  green; the dev store ends on the dev fixture.
- `pnpm help:screenshots --section teams-and-members` run twice leaves the same sizes; a run with
  no flag passes.
- `pnpm fmt` repo-wide at the end, by the orchestrator.

## Decisions

Taken 2026-10-08 while writing the plan, without review; the review is on the result.

1. **The hub has no body.** As in the last two cycles.
2. **Eight pictures, none of which writes.** A team delete to show Needs a team would change the
   showcase for every later block and the picture it earns is on the order page and the workflow
   page, which belong to Fixing an issue in the Orders cycle. Removing and deleting says what a
   team delete does in prose.
3. **`firstTeam1` and `firstTeam2` are placed again on Creating a team**, as `firstWorkflow1` was
   on Creating a workflow.
4. **The Teams and members block goes between the Workflows block and the Getting started
   sub-block that creates Assembly**, so the Teams and Members pages show the showcase alone.
5. **Packing is the team the Delete modal is shot on**, since the fixture names it as the team to
   delete for Needs a team; the modal is cancelled, so nothing is deleted.
6. **ana@example.com is the member pictured**, as on the member pages, so the one email the help
   uses is the one on every picture.
7. **Remove has no picture of its own.** The Remove buttons are in `creatingATeam2` and
   `addingAMember3`; the builder may place one again.
8. **Limits keeps the numbers** (32 characters, 50 teams, 12 members, 254 characters): no number
   on these pages, the same rule as follow-up 5 of the Workflows cycle.

## Deviations and issues

(filled in by the builders, one heading each)

### Script and pictures

Phase 1, builder A. Files touched: `scripts/help-screenshots.ts`, the eight
`public/assets/help/teams-and-members/*.png` (new), the eight `teams-and-members/*` entries in
`src/lib/helpPictures.ts`. Nothing else.

**The script**

- **The menu helper is a sibling.** `clickMenuItemIn(frame, menu, name)` takes the menu id;
  `clickMenuItem(frame, name)` stays as the workflow page's (`workflow-actions`), so the Workflows
  block's calls are unchanged. The team page's call is `clickMenuItemIn(frame, "team-actions",
"Delete")`, the locator copied from `e2e/teams.spec.ts`.
- **`openRow(page, name)`** presses a row link in the frame, waits for `s-page[heading=name]` and
  `awaitNavigated`, then parks the pointer. Used for Engraving, ana@example.com and Packing.
- **The pointer is parked inside the frame after a row click (`parkPointer`).** Not in the plan.
  The first run's `addingAMember1` showed ana@example.com underlined: the Engraving click left the
  pointer where ana's row then rendered on the Members page. A probe confirmed `:hover` on that
  `s-link`, not focus. Moving the pointer to the admin's (0, 0) did not clear the frame's hover
  (second run, still underlined); moving it to 4 px inside the frame's top left corner did.
- **The Delete modal is cancelled at the start of `firstWorkflow1`**, as the Workflows block did,
  but only when a modal is open (`s-modal dialog[open]` count), so a run whose Teams and members
  block is filtered out still works. In a `--section teams-and-members` run nothing follows the
  Delete modal: the run ends with it open and the context closes, nothing written (it is Cancel,
  not Delete). A `take` cannot cancel its own modal, since the shape shoots after the `take`.
- `removingAndDeleting2` waits for the modal's Delete with `toBeEnabled()` inside
  `s-modal#delete-team` (the in-frame button, not hoisted; the route disables it on
  `!identified || deleteMutation.isPending`).
- Waits as the plan says, with these specifics: `creatingATeam2` waits for the text
  "carmen@example.com" (`getByText`, first); `addingAMember3` waits for the link "Finishing"
  inside an `s-table-cell`; Add member, Add to teams and Delete member are pressed with
  `clickHoisted` and page-scoped `getByRole("button", { exact: true })`.
- Facts rechecked in the code: `s-menu#team-actions` (`app.teams.$teamId.tsx`), the modal ids
  `add-member`, `add-member-teams`, `delete-member`, `delete-team`, `SEARCH_FROM = 6`
  (`src/lib/teams.ts`), and `openScreen` going through Orders when already under the section.

**What each picture shows**

- `creatingATeam1` (1056 × 490, page): Teams, Create team and `…`; Search by name; columns Team
  and Members; Engraving 3, Finishing 2, Jewelry 1, Leather 2, Packing 1, Textiles 1, Weekend crew
  with an orange **No members** badge and 0, Woodshop 2. About 30 px of white under the card (the
  20 px margin plus the card's shadow).
- `creatingATeam2` (1056 × 355, page): Teams / Engraving, More actions (with a chevron), Add
  members, `…`; the Members card with a table Member / Actions, ana, ben, carmen, a red Remove on
  each row; Details: Members 3, Created with the seed's time.
- `addingAMember1` (1056 × 453, page): Members, Add member, `…`; Search by email; columns Email
  and Teams; ana, ben, carmen, dana, eli 2 each, farah and gus 1 each. No No teams badge.
- `addingAMember2` (620 × 214, modal): "Add member", Email with a red required asterisk, empty,
  "They sign in with this email. No Shopify account needed.", Cancel, Add (enabled, dark).
- `addingAMember3` (1056 × 310, page): Members / ana@example.com, Delete member (red text), Add to
  teams, `…`; the Teams card, Team / Actions, Engraving and Finishing with Remove; Details: Email,
  Added with the seed's time.
- `addingAMember4` (620 × 358, modal): "Add to teams", Search by name, unticked checkboxes
  Jewelry, Leather, Packing, Textiles, Weekend crew, Woodshop; Cancel and Add greyed. The heading
  does not name the member.
- `removingAndDeleting1` (620 × 158, modal): "Delete member?", "Delete ana@example.com? This
  can't be undone.", Cancel, red Delete.
- `removingAndDeleting2` (620 × 158, modal): "Delete Packing?", "This can't be undone.", Cancel,
  red Delete, enabled.

**Reads wrong or slightly off**

- The plan's `addingAMember3` says "the Details aside" shows the email and when added: it does
  (Email, Added); the team page's Details shows Members and Created. Both as the alt says.
- The modals' top right corner is rounded and the top left is square with a soft white fringe:
  the same as every existing modal picture (`managing-1.png` checked), so not new. The top 1 px
  row of `addingAMember2` carries a faint blue tint at the left, the Members table's link under
  the modal's translucent edge; invisible at display size. Not fixed (it is the shared modal
  shape).
- The "Provisional" alt for `creatingATeam1` said "from Engraving with three members to Woodshop
  with two" and `addingAMember1` "Every member here is on at least one team": both held. The
  provisional aspect ratios were all off (e.g. 1056/518 against 1056/490); set from the runs.

**Overlay stems**

None. The overlap check refused nothing in any run; no `_glow_` either.

**Runs and timing**

- `--section teams-and-members`: four runs, all passed, the same eight sizes each time. First run
  (hover in `addingAMember1`) merchant pass 14 s, command 24 s; the second, pointer moved to
  `(0, 0)` (hover still there), 11 s and 17 s; the third with a temporary probe that logged the
  hover (removed); the fourth with `parkPointer`, clean.
- Full run (no flag): passed, 32 pictures, merchant pass 37 s, command 51 s. Every Getting started
  and Workflows size equal to the inventory's. The re-shot members, getting-started and workflows
  pictures were restored with `git checkout --` as the plan says.
- Every run ended with the script's own `pnpm seed`; `pnpm dev:status` healthy after.

**Checks**

`pnpm typecheck` and `pnpm lint` green (with builder B's files in the tree as they stood).
`pnpm test` and the public e2e project not run (builder B's). `pnpm fmt` not run.

**Unverified**

- That a `--section teams-and-members` run leaving the Delete modal open at the end is harmless
  beyond this script: the context closes without pressing anything, and the reseed follows.

### Pages and tests

Phase 2, builder B. Files touched: `src/components/help/teams-and-members/creating-a-team.tsx`,
`adding-a-member.tsx`, `removing-and-deleting.tsx` (new), `src/components/help/bodies.tsx` (three
entries and imports). The tests needed no change. Every sentence was checked against the route,
component or Domain symbol named in its body's JSDoc, not against this plan, and the prose was read
against `creatingATeam1`, `addingAMember3` and `removingAndDeleting2` once builder A had written
them.

**Departures from the plan, each from the code**

- **Creating a team, the Teams page section** also says a team with no members still has its tasks
  start on new items, and nobody can work them until someone joins (the JSDoc on `Team`). The
  section has no search-scope sentence. `TeamsSearch` reads every team, but no page has said that
  about the Teams page, and one picture already shows the field.
- **The Add members list holds members not yet on the team.** The plan said it lists "the members
  already added to Baton". The modal's `candidates` leave out the team's own members, so the page
  says both. The same applies to Add to teams: it lists teams the member is not on yet. Adding a
  member also says that, when the shop has no team, the Add to teams modal points to the Teams page
  (the `teamCount === 0` branch).
- **Rename says where the old name stays.** Run tasks keep the `teamName` snapshot, which
  `RunSteps` prints on the order page and the member screens. The member's Team filter reads live
  team names (`MemberAccess.teams` in `shop.$shop.workflows.index.tsx`), so "the members may see
  both names" holds only for a member on two or more teams, since the filter shows only then. The
  page does not narrow it that far.
- **`creatingATeam2` is placed on Creating a team**, in the add-members section, after a sentence
  on what the team's page lists (Remove per row, the Details section). **`addingAMember3` is placed
  after the Add to teams steps**, with a sentence on the member's page with teams. It is not placed
  beside "the member's page opens", because the picture shows ana@example.com on two teams, not
  the empty state. Removing and deleting places no picture for Remove (decision 7).
- **Remove adds Put back.** A task the removed member had started stays under their email, the
  team's other members find it under Started by others (`listStateOf`), and any of them can press
  **Put back** (`taskActions`: `putBack` is `workable && startedAt !== null`, with no check on
  the starter). The page does not mention the exception: under a block, Put back is not offered.
- **Delete member says "can no longer sign in to this store"**, not "can no longer sign in". A
  member row is per shop (`findMemberAccess` is none for this shop only), and the same email may be
  a member elsewhere. "Lose access at once" rests on `deleteMemberFn` revoking the member's
  connections (3401) and the shell invalidating the router, which reruns the guards (the
  connection table on `ConnectionRole`).
- **Delete team names the greyed Delete.** The modal's Delete is disabled until the socket has
  identified (`!identified`). The page says it is greyed for a moment while the page connects.
- **Delete team: what an open task looks like.** The order page shows no **Needs a team** badge on
  the task. It shows a line naming the task with "assign a team" and an **Assign team** select with
  an **Assign** button (`unassignedRows`). The badge is on the Orders page (`ORDER_ISSUE_LABEL`) and
  on the Workflows page (`WORKFLOW_FAULT_LABEL`). The page says so and links Fixing an issue. A
  workflow's task is fixed "in the editor and apply the changes", linking Editing steps and tasks.
  The plan said only "in the editor", but an edit lands on the draft until Apply.
- **"Marked done" is retired** (`/\bmark(?:ed)? done\b/`). The history sentence reads "The history
  keeps their email on every task they started or did."

**Found in the code, outside my files**

- The JSDoc on `deleteTeam` in `src/lib/agent/ShopWork.ts` says "Nothing is refused for being in
  use: the confirm dialog states the counts and the merchant decides." The dialog states no counts:
  its body is `DELETE_CONFIRM` alone (`app.teams.$teamId.tsx`, and `removingAndDeleting2`). The
  JSDoc is stale. The page follows the screen.

**Screen sentences reported, not quoted:** the Teams empty state, "Nobody on this team yet" and its
sentence, "Everyone is already on this team.", "This member is on every team.", "No teams yet.
Create one on Teams.", the Email field's details line, the "Not on a team yet" sentence, the member
list's "You're not on a team yet…", `DELETE_CONFIRM` and the member modal's first sentence (named
as "the modal names the email and says this can't be undone"), `NAME_TAKEN`, and the two
`DELETED_TOAST` toasts (as "a message says the member was deleted"). Bold is kept for controls and
badges: Create team, Name, Create, Add members, Add, Remove, More actions, Rename, Save, Add member,
Email, Add to teams, Sign in, Your stores, Delete member, Delete, Put back, Assign, No members, No
teams, Needs a team.

**Unverified:** nothing the pages say. A member's list changing "at once" after Remove rests on the
3401 close and the router invalidation in the code, not on a run against a signed-in member.

**Checks.** `pnpm typecheck` green. `pnpm lint` green after the "marked done" fix. `pnpm test`: the
first run had 780 passed and 1 failed ("a merchant picture's aspect ratio is its file's"). Builder
A's aspect ratios were still provisional at that point. A rerun after builder A's pass had 781
passed. `pnpm exec playwright test --project=public`: 6 passed, which includes the walk that loads
every picture on the three new pages. `pnpm fmt` not run. `pnpm seed` not run: the public project
writes nothing to the store.

## Review (2026-10-08)

Read both Deviations sections, the eight pictures, the three bodies and the diffs outside the
plan's file lists; ran `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (781) and the
`public` e2e project (6), all green; the store is on the dev fixture. The pictures are clean: no
overlay, toast, hover, black corner or cut control. Every sentence checked against its screen
holds, and the pages read right at 1280 and at 390. Seven findings, each with a recommendation.

1. **The `deleteTeam` JSDoc is stale.** It says "the confirm dialog states the counts and the
   merchant decides"; the dialog says only that it can't be undone (`DELETE_CONFIRM`). Recommend
   one line: nothing is refused for being in use, and the dialog says only that it can't be undone.
2. **Rename's last sentence is vaguer than its fact.** "For a while, the members may see both
   names" holds only for a member on two or more teams, since only they see the Team select. The
   sentence before it already says where the old name stays. Recommend cutting the sentence.
3. **Remove is one eight-sentence paragraph.** Recommend splitting it in two: the action and what
   still exists, then what happens to a task the removed member had started.
4. **Adding a member shows picture 4 before picture 3.** The inventory's JSDoc says `<n>` is the
   picture's order on the page, and the body places the Add to teams modal before the member's
   page. Recommend swapping the two numbers (the files, the entries, the script's names and the
   body), no reshoot.
5. **The breadcrumb cuts the section's title at desktop** ("Teams a…", and "Getting s…" on
   Getting started): Polaris shortens the middle crumb at every width, and the foot list carries
   the section's full name. Pre-existing and outside this cycle. Recommend leaving it and noting it
   on the research's navigation table.
6. **Accept the builders' departures**: `clickMenuItemIn` as a sibling, `openRow` and the parked
   pointer (a hover showed in the first run), the Delete modal cancelled at the start of
   `firstWorkflow1` behind a guard, a section run ending on its open Cancel-able modal, and the
   `--section` flag untouched. All forced by the admin or the code.
7. **Accept the content departures**: both modals list only the members or teams not yet linked;
   the order page shows an Assign team select and no badge; "sign in to this store"; Put back after
   Remove; Delete greyed while the page connects; "apply the changes" after the editor. Each was
   checked against the code.

Nothing else is open.

## Follow-ups (2026-10-08)

All seven recommendations accepted; the follow-ups are in, uncommitted.

1. The `deleteTeam` JSDoc says the dialog says only that it can't be undone.
2. Rename's last sentence is cut.
3. Remove is two paragraphs.
4. The Add to teams modal is `addingAMember3` and the member's page `addingAMember4`: files,
   entries, the script's shot names and the body swapped, no reshoot. The plan's table above
   reads the new numbers.
5. The breadcrumb truncation is noted on the research's navigation table.
   6, 7. Accepted as built; nothing changed.
