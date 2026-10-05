# Plan: one create, edit, delete pattern for the merchant screens

Written 2026-10-05 from the decisions in `docs/crud-screens-research.md` (decisions 1 to 12 and the
re-check's questions 13 to 16, all accepted). It is for an agent that has not seen that research.
Read its "Short answers", "The pattern", "Decisions" and "Re-check after the parts refactor" first.
This plan does not repeat the reasoning. It says what to change, in what order, and how to check it.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, normatively, in the JSDoc on the symbol that enforces it. Other sites
    `{@link}` it, and the rule has a test whose title is the rule.
  - JSDoc never cites `docs/`.
  - Use the vocabulary's words, and name screens by the Screens table's spec names.
  - Routes compose parts from `src/components/screen/` and lay out nothing; `pnpm lint` refuses
    layout in a route.
  - A copy change starts at the copy table or controls table row in `src/lib/Screen.ts`; a
    structural change starts at the data-model row in `src/lib/D1Schema.ts`.
  - Run `pnpm fmt` and keep everything it touches. Do not commit unless told to.
- Start with `git merge --ff-only main` in the worktree.
- The D1 schema is edited in place in `migrations/0001_init.sql` (no new migrations while
  prototyping); after a schema edit run `pnpm dev:reset` yourself.
- Look at what you build. Every changed merchant screen is screenshotted inside the embedded admin
  before its phase is called done (`pnpm playwright-cli` headless, the admin session from
  `e2e/shopify-admin.setup.ts`; `pnpm seed` after any e2e run).
- Run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`) and `pnpm test` at the end of
  every phase, and the admin e2e project (`npm run test:e2e -- --project=admin`) at the end of
  phases 1 and 2.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go.

## The decisions, as work

| decision                                                 | lands in                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Delete a member, not Remove                           | the member page's Delete modal; `e2e/members.spec.ts`                                                         |
| 2. a member page                                         | `src/routes/app.members.$memberId.tsx`, `app.members.index.tsx`; the Screens table in `src/lib/Domain.ts`     |
| 3, 12. Create member asks for the email only             | `app.members.index.tsx`; `Repository.createMember` (renamed from `addMember`)                                 |
| 4. every delete confirm body is "This can't be undone."  | the copy table's confirm row; `src/lib/teams.ts`, `src/lib/workflowShared.ts`, the three delete modals        |
| 5. Remove from a set has no modal and no toast           | the controls table's "no undo" row; the team page, the member page                                            |
| 6. a related set on an index row is a count              | `app.teams.index.tsx` (Used by becomes Workflows), `app.members.index.tsx` (Teams count)                      |
| 7, Q14. merchant tables page from the server             | a new controls-table row; the team page, the member page, the teams index, the members index                  |
| 8. `Email` capped at 254                                 | `src/lib/domain/Platform.ts`, `migrations/0001_init.sql`, the D1 member row, `Repository` tests               |
| 9. `maxTeams` 50                                         | `src/lib/domain/Platform.ts`                                                                                  |
| 10. the pattern on the controls table; a verbs table     | `src/lib/Screen.ts`; the verbs table and `RECORD_VERB_LABEL` in `src/lib/domain/ShopWork.ts`; `rules-lint.ts` |
| 11. order of work                                        | this plan's phases                                                                                            |
| Q13. headings: Shopify's model                           | the parts table's token row, the copy table's heading row; the member page and its Delete modal               |
| Q15. the back-link row is for member pages               | the controls table's back row                                                                                 |
| Q16. every delete toasts "<Noun> deleted"                | the team page, the member page                                                                                |
| D1 wording: "only deletes them", "a delete and a create" | the two member rows on `D1_TABLES`                                                                            |

## Phase 1: members

### 1.1 Repository and domain

`src/lib/Repository.ts`:

- Rename `addMember` to `createMember`. Keep its idempotency on the row and its JSDoc; drop the
  "re-adding with teams checked replaces the set" behaviour from `addMemberFn` (the create takes no
  teams).
- Delete `setMemberTeams`. The member page adds with `addTeamMembers`'s mirror and removes with
  `setTeamMember({ inTeam: false })`, so both sides write the same two functions.
- Add `addMemberTeams({ shop, memberId, teamIds })`: the mirror of `addTeamMembers`, one D1 batch,
  the member checked up front (`MemberNotFoundError`). Same connection-revoke posture as
  `addTeamMembers`: the route revokes the member's connections after it.
- Add `findMemberDetail({ shop, id, teamsAfter, limit })`: the member row, or none; the first
  `limit` of its teams in name order after the cursor, each with `inTeamSince` and the team's
  `memberCount`; and `nextCursor`. Model it on `findTeamDetail` and the workflows index's cursor.
- `listMemberTeams` stays (the team page's Add members hint reads it). The members index no
  longer needs it: `listMembers` gains a `teamCount` per row (one left-join count), as `listTeams`
  carries `memberCount`.
- `test/integration/repository.test.ts`: rename the `addMember` tests, delete the `setMemberTeams`
  tests, add "a member's teams are added as a batch and removed one at a time from either side"
  and "findMemberDetail pages a member's teams by name".

`src/lib/domain/ShopWork.ts`: add `MemberDetail` (the member, its teams page, `nextCursor`) beside
`TeamDetail`, in the `Shape families` table's screen-data row. Add `teamCount` to the member
summary the index reads. Update the vocabulary where it names "the members page" to "the members
index" and add "the member page".

`src/lib/domain/Platform.ts`:

- `Email`: refuse an address over 254 characters with the field error "Enter an email of 254
  characters or fewer". Never truncate; the JSDoc says why (a cut address is a different address and
  sign-in would match nobody). `EMAIL_MAX_LENGTH = 254`, exported for the field's `maxLength`.
- `ShopLimits.maxTeams`: 50; the JSDoc keeps "provisional".

`migrations/0001_init.sql`: the `Member.email` check gains `and length(email) <= 254`.

`src/lib/D1Schema.ts`, the member rows on `D1_TABLES`: "a merchant pauses nobody, only deletes
them"; "a change is a delete and a create"; the email row gains "and at most 254 characters" with
`holds by` schema+app and `pinned by` a test titled "an email over 254 characters is refused and
never stored". Write that test.

### 1.2 The members index

`src/routes/app.members.tsx` becomes `src/routes/app.members.index.tsx`:

- Columns: Email (a link to the member page, as the teams index links the name), Teams (a count;
  the warning badge "No teams" at zero), Created. No buttons on a row.
- Title-bar primary action "Create member". The modal: heading "Create member", one email field
  (`maxLength={EMAIL_MAX_LENGTH}`, the existing `details` help text), primary "Create". On success
  navigate to the member page, as Create team does.
- Delete the Edit teams modal, the Remove modal, `MAX_CHIPS`, the chips cell, the emptied-teams
  computation, `MemberTeamsFields` (`src/components/MemberTeamsFields.tsx`), `setMemberTeamsFn`,
  `deleteMemberFn` (moves to the member page) and the sole-membership warning in the loader JSDoc.
- The description paragraph and the empty line keep their sentences ("Members sign in with their
  email. Put each one on a team, or they have nothing to do."), with "Add member" in the empty
  line's action becoming "Create member".
- Pagination: `s-table paginate`, 25 rows, `after` cursor in the URL, as the workflows index does.
  `listMembers` takes `limit` and `after`. The live search stays client-side over the loaded page
  (deviation 15 of the long-names plan), and the plan notes it searches one page only; see
  [issues](#issues).

### 1.3 The member page

New `src/routes/app.members.$memberId.tsx`, a `details` page:

- `s-page heading={member.email}` with `s-link slot="breadcrumb-actions" href="/app/members"`
  reading "Members". Polaris cuts the heading only if it overflows; the Details aside card's first
  row prints the email whole as a `Token` ("Email"), then "Created".
- Title bar: primary action "Add to teams"; secondary "Delete" (tone critical). No More actions
  menu: the controls table's "More actions with one entry" row says a single entry is a button.
- Main section "Teams": a `TableFrame` table with columns Team (a link to the team page), On team
  since, and an `End` Actions column holding a tertiary critical "Remove" per row. Remove writes
  `setTeamMember({ inTeam: false })` through a server function, revokes the member's connections,
  invalidates; no modal, no toast. Empty line when the member is on no team: heading "Not on a
  team yet", body "A member with no team has nothing to do.", action the Add to teams button.
  Empty line when the shop has no teams: "This store has no teams yet. Create one on Teams, then
  add this member." with a button to Teams.
- Pagination on the Teams table: `s-table paginate`, 10 rows, `teamsAfter` in the URL.
- The Add to teams modal mirrors the team page's Add members modal exactly: heading
  "Add to teams", candidates only (teams the member is not on), a search field from six candidates
  (`SEARCH_FROM`, moved to `src/lib/teams.ts` so both pages read one constant), ticks kept across
  searches (`changeSelected`), each candidate with "No members" as its `details` when its count is
  zero, primary "Add" or "Add N". Both nobody-to-add cases: "Everyone is already on this team"
  becomes "This member is on every team."
- The Delete modal: heading "Delete member?", body two sentences, the first naming the email as a
  `Token` ("Delete m3@m.com?") and the second "This can't be undone.", primary "Delete" (critical),
  dismiss Cancel. On success navigate to the members index and toast "Member deleted". The error
  fallback is "Couldn't delete the member."; `MEMBER_GONE` stays.
- The loader reads `findMemberDetail` and `listTeams` (for the candidates); `notFound()` when the
  member is gone, with the same not-found page shape as the workflow page.

### 1.4 Screens table and spec

`src/lib/Domain.ts`, the Screens table: the `app.members` row becomes `app.members.index`, Members,
"the members index", index; add `app.members.$memberId`, "the member's email", "the member page",
details. `test/integration/spec.test.ts` reads the members row by name; update it.

### 1.5 Tests

- `e2e/members.spec.ts`: rewrite as "the members index creates a member and the member page adds
  it to teams, removes it, and deletes it". It creates through the modal, lands on the member page,
  adds two teams through Add to teams, removes one from its row (no modal), reads the email from
  the Delete modal's body, deletes, and sees "Member deleted" and the index without the row. Add a
  long-email case: a 254-character address is created, heads the page, and prints whole in the
  Details card; a 255-character address gets the field error.
- `e2e/teams.spec.ts` still goes through the team page; untouched in this phase.
- Screenshots: the members index with rows and empty; the member page with teams, with none, with
  the 254-character email; the Create, Add to teams and Delete modals.

## Phase 2: teams and workflows

### 2.1 Delete confirms and toasts

- `src/lib/teams.ts`: `DELETE_TEAM_CONFIRM` becomes `DELETE_CONFIRM = "This can't be undone."`,
  with the JSDoc naming the copy table's confirm row, and a `deletedToast(noun)` helper or three
  constants ("Team deleted", "Workflow deleted", "Member deleted"), whichever keeps one pattern in
  one place. `src/lib/workflowShared.ts`: `DELETE_WORKFLOW_WARNING` goes; its two sites
  (`app.workflows.$workflowId.tsx`, `app.workflows.$workflowId_.edit.tsx`) read `DELETE_CONFIRM`.
  The editor's delete keeps its own flow; only the body sentence changes.
- The team page toasts "Team deleted" after navigating to the index.
- `e2e/teams.spec.ts` and `e2e/workflows.spec.ts`: the confirm-body assertions read the new
  sentence; the team test expects the toast.

### 2.2 Remove on the team page

- The Remove modal goes: the row button writes `setTeamMember({ inTeam: false })` at once,
  disabled while pending. No toast. Delete `REMOVE_MODAL` and `removing`.
- `e2e/teams.spec.ts`: the remove step clicks once and checks the row is gone.

### 2.3 The team page's lists

- Members table: `s-table paginate`, 10 rows, `membersAfter` in the URL; `findTeamDetail` takes
  `limit` and `after` for its members and returns `nextCursor`. The Details card's Members count
  comes from a count, not `current.length`.
- Used by moves from the aside (`UsedByCard`) to a main-column `details card` under Members, as a
  one-column table (Workflow, a link) in a `TableFrame`, `s-table paginate` at 10 rows,
  `workflowsAfter` in the URL. `ShopAgent.listTeamWorkflows` takes `limit` and `after` (workflow
  name order) and returns `nextCursor`. Empty: "Not used by any workflow yet." Delete
  `src/components/UsedByCard.tsx`.
- The Details aside keeps Members (count) and Created.

### 2.4 The teams index

- The Used by column becomes Workflows, a count per team. `listAllTeamWorkflows` returns counts
  per team instead of rows, or the loader reduces it; prefer the count read (the object has 1,000
  workflows at most, but a row per task-team pair is the larger join).
- `s-table paginate`, 25 rows, `after` in the URL; `listTeams` takes `limit` and `after`.
- `e2e/teams.spec.ts`: the Used by assertion reads the count.

### 2.5 Screenshots

The team page with members, with none, with eleven workflows (the pagination shows); the teams index.

## Phase 3: the spec rows and the lint

### 3.1 `src/lib/Screen.ts`

Controls table:

- "a verb with no undo (block, cancel, delete, discard)": drop "remove"; the control cell says the
  body is the confirm slot.
- New rows, one per job from the research's pattern table: a list of things the merchant creates;
  creating a thing; everything about one thing; a field of the thing; a set the thing holds; a
  related set on an index row; deleting a thing; taking a thing out of a set; More actions with
  one entry. Copy the research's cells, with the heading cells as question 13 decided (the name in
  the heading; "Delete <noun>?" with a token in the body when the name is a token).
- New row "a merchant table with more rows than its page": control `s-table paginate`, read from
  the server a page at a time, the page in the URL, 25 rows on an index and 10 on a details page,
  controls only when there is another page; never "Show more; loading every row and hiding some".
  The existing "a list cut at a depth" row's job cell becomes "a member list cut at a depth".
- The back row's job cell becomes "going back from a member page to the list that opened it".

Copy table:

- confirm: form "This can't be undone.", or two sentences when the first names the record; never
  "explains what the product does; "Are you sure"; restating the heading". Example "This can't be
  undone." (a screen shows it after phase 2).
- heading: add "a modal that asks names a capped name in its heading and puts a token in its body".

Parts table, the token row's "fixes" cell: "in a cutting control: the order number; a title bar,
when the same page prints the token whole in a field".

`pnpm spec check` parses these tables; run it after every edit and fix what it refuses.

### 3.2 The verbs table

`src/lib/domain/ShopWork.ts`: a table "Record verbs" beside the verbs table, one row per verb, with
`context` (shop work), a `merchant` screen column and what it is for: Create and Delete for a
thing; Add and Remove for a set; Rename for a name; Edit for a workflow's tasks; Duplicate for a
workflow. `RECORD_VERB_LABEL` holds the screen words; the screens read their button labels from it
(Create team, Create workflow, Create member, Add members, Add to teams, Add step stays as is).
`pnpm spec check` holds the column to the constant the way it holds `VERB_LABEL`.

### 3.3 `scripts/lib/rules-lint.ts`

- Retired copy: `Edit (teams|members|workflows)` and any `Remove .*\?` heading (Remove never has a
  modal). Add the rows to the retired-words table in the file's JSDoc.
- A test in `test/integration/spec.test.ts` for each: "Edit <noun>s is refused in screen copy",
  "a Remove heading that asks is refused".

### 3.4 `AGENTS.md`

One sentence in the screens bullet: the controls table holds the create, edit and delete pattern,
and a new merchant screen starts at its rows.

### 3.5 Final checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e` (all projects), `pnpm seed`, then
`node scripts/copy-audit.ts` to confirm no "Remove" sits on a delete and no "Edit <noun>s" remains.

## Deviations and issues

Record here, as you go:

- every place the implementation departs from this plan or from the research's decisions;
- every problem found, whether solved or left open.

One entry each: what, why, and what was done or is left for the user. Leave a subsection with "None"
rather than deleting it. An issue that needs the user's decision says so in bold.

### Deviations

Implemented 2026-10-05, all three phases. Uncommitted.

1. **Paged reads are new methods.** `listTeams` and `listMembers` keep their every-row signature
   (the object's team reads, the seed and many tests use them); the indexes read the new
   `Repository.listTeamsPage` and `Repository.listMembersPage`, which share `PageInput` and `Page`.
2. **`MemberDetail` is not on the Shape families screen-data row.** `Detail` is not a family
   suffix, and `OrderDetail`, `WorkflowDetail` and `RunDetail` are not screen data, so adding it
   would mis-file them. `MemberDetail` sits beside `TeamDetail` in `ShopWork.ts`, as planned.
3. **Candidates come with the detail read.** `findTeamDetail` and `findMemberDetail` return
   `candidates` (the members not on the team, the teams the member is not on) instead of the loader
   reading `listTeams`. `TeamDetail` no longer lists every shop member with an `inTeam` flag; it
   carries one page of members, `memberCount` and `nextCursor`.
4. **Keyset by the unique column.** The members index and the team page's Members table order by
   email (they ordered by created date, then email); the member page's Teams table and the teams
   index by name. The cursor is read as `coalesce(after, '')`, because `? is null or` turned the
   seek into a scan (found by the plan test, issue 4).
5. **The Used by reads.** `listAllTeamWorkflows` and `TeamWorkflowByTeam` are gone;
   `countTeamWorkflows` returns `TeamWorkflowCount` rows. `listTeamWorkflows` takes
   `TeamWorkflowsInput` (team, cursor, limit) and returns `TeamWorkflowsPage`; its SQL is the
   exported `TEAM_WORKFLOWS` so a test reads its plan.
6. **`MemberNotFoundError` carries `member`** (the id or email it was addressed by) instead of
   `email`, because `addMemberTeams` addresses the member by id. The member page's delete still
   calls `deleteMember` by email.
7. **The member page's not-found state** is the workflow page's shape (the loader returns `null`,
   the page renders "Member not found" with the breadcrumb), not `notFound()`, which lands on the
   root's bare "Not found".
8. **The copy table's confirm form keeps the consequence form for other verbs.** "This can't be
   undone." is the form for a delete; discard, turn off, block and cancel keep "what happens and
   what survives", or the row would contradict their bodies.
9. **The help row's example** was the deleted checklist's sentence; it is now "They sign in with
   this email. No Shopify account needed." (the Create member field).
10. **`src/lib/teams.ts` is a copy file.** It now holds `DELETE_CONFIRM` and `DELETED_TOAST`, and
    already held `NAME_TAKEN`, so `scripts/lib/copy-files.ts` lists it and the lint and the copy
    audit read it. `DELETED_TOAST` is one object (`team`, `workflow`, `member`); the workflow
    pages read it instead of `workflowShared.ts`'s string. `SEARCH_FROM`, `INDEX_PAGE_SIZE` and
    `DETAILS_PAGE_SIZE` live there too.
11. **The 255-character e2e case asserts the field.** The Create member field's `maxLength` stops
    typing at 254, so a 255-character address never reaches the form; the test asserts the field
    holds 254, and the schema's refusal is pinned by the integration test "an email over 254
    characters is refused and never stored".
12. **The two rules-lint tests are in `test/integration/rules-lint.test.ts`**, beside the other
    retired-word tests, not in `spec.test.ts`.
13. **`Token` takes `href`.** A link inside an `s-text` lost the link's colour, so the part renders
    the link inside its span; the members index's emails and the team page's member emails link to
    the member page (the pattern's "its name a link"). The parts table's token row and the kit page
    show it.
14. **Pagination controls only with another page, on every merchant table.** The new controls row
    says so; the orders and workflows indexes, which always drew an empty bar, follow it too.
15. **The team page's no-members-in-store line** reads "This store has no members yet. Create them
    on Members, then put them on teams." with "Go to Members": a member is created, not added.
16. **`RECORD_VERB_LABEL`** is read by the buttons on the two indexes and two pages of teams and
    members and on the workflows index and workflow page (Create, Add, Remove, Rename, Edit,
    Duplicate, Delete). The editor and `WorkflowTag` keep their literals, as "Add step stays as
    is" said. A spec test pins the column ("a record verb's screen cell is the label constant").
17. **Previous on a paged table** is the browser's Back when that table's Next pushed the entry,
    recorded per search key in `HistoryState.nextPageOf` (`src/lib/tablePages.ts`).

Found in review, 2026-10-05, and done:

18. **The members index is in email order**, not newest first (deviation 4), which the research
    never discussed. Kept: the teams index is in name order, and one order per side is the rule.
    With it, `Member_shop_createdAt_idx` served only `listMembers` (the seed and a test), so the
    index is gone and `listMembers` reads in email order too; the unique (shop, email) index
    answers every member read.
19. **The spec text the deviations left inconsistent** is fixed: the confirm row's `never` cell
    says "for a delete, explains what the product does", since the `form` cell keeps "what happens
    and what survives" for turn off, discard and block (deviation 8); the heading row exempts the
    order number, as the parts table's token row does; the paged-table row carries deviation 17
    (Previous is Back when that table's Next pushed the entry, else page one; never a Back that
    moves another table's page).
20. **The Used by table on the team page is a plain `s-section`**, not the plan's "details card";
    Polaris draws a section as a card, so the shape is the same.
21. **Every delete toasts before it navigates**, as the workflow page did; the team and member
    pages navigated first.
22. **The teams index had no assertion on the Workflows count** and `e2e/workflows.spec.ts` never
    asserted the delete body, so phase 2's "update the assertion" items were no-ops. The drill-in
    test now reads the count, and a new test, "the team page pages its members and its workflows
    independently", pins deviation 17's two-cursor case (eleven members, eleven workflows).
23. **The end-of-plan checks were not reported** by the implementer. Run in review: `pnpm typecheck`,
    `pnpm lint`, `pnpm test` (758), the admin e2e project (86, before the test above was added),
    `pnpm fmt` clean, `pnpm seed`, and the screenshots: the members index with four members (one
    of 254 characters, one with No teams), the Create member modal, the member page with five
    teams, with none, and with the 254-character email, its Add to teams and Delete modals (the
    long email whole in the body), the teams index with Workflows counts and No members badges,
    the team page with eleven workflows (the Used by controls show) and with no members. Looked at
    2026-10-05; nothing to change.

### Issues

Known before starting. Resolve each, or record what happened:

1. **Client-side search over one page.** Resolved: both indexes search in the loader (`?q=`),
   submitted on Enter through `ListSearchField`, matched anywhere in the email or name over every
   row, with the match count in the search line.
2. **Three cursors on one page.** Resolved: each Next keeps the other key (`search: prev`), and
   Previous steps back only when its own Next pushed the entry (deviation 17).
3. **The Used by card leaves the aside.** Resolved: the screenshot with eleven workflows reads as
   a plain list of links with the pagination under it; no change needed.
4. **`listTeamWorkflows` orders and pages in the object.** Resolved: the first form scanned the
   name index; with `coalesce` it searches it from the cursor with no sort, pinned by "the Used by
   read walks the name index from the cursor, with no sort".
5. **Deleting a member while its page is open in another tab.** That tab's next navigation reads
   `null` and shows "Member not found". Not covered by a test.
6. **The 254-character email fixture** is created in the spec and deleted at its end.
7. Search terms are `Domain.ListSearch`, capped at 64 characters, so a search cannot hold a whole
   address longer than that; a substring of it finds the member.
