# Plan: Add member, and the add row that covers it

Written 2026-10-06 from the four decisions in `docs/create-vs-add-research.md`, all accepted. It
is for an agent that has not seen that research. Read its "Short answers" and "Decisions" first.
This plan does not repeat the reasoning. It says what to change, in what order, and how to check
it.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, normatively, in the JSDoc on the symbol that enforces it. Other sites
    `{@link}` it.
  - A label change starts at the vocabulary row; a control change starts at the row in
    `src/lib/Screen.ts`.
  - A data-model row's `pinned by` cell names a test title; `pnpm spec check` refuses a title no
    test carries, so a renamed test and its cell change together.
  - JSDoc never cites `docs/`.
  - Run `pnpm fmt` and keep everything it touches. Do not commit unless told to.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` at the end of every phase; the admin e2e
  project's `e2e/members.spec.ts` at the end of phase 3, then `pnpm seed`.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go.

## The decisions, as work

| decision                                        | phase   |
| ----------------------------------------------- | ------- |
| 1 Team and workflow keep Create                 | none    |
| 2 Add member; Delete member stays               | 1, 2, 3 |
| 3 Add step and Add task fall under the add row  | 1, 3    |
| 4 The create modal's heading matches its button | 3       |

Decision 1 changes nothing on screen; phase 1 narrows the create row to say so.

## Phase 1: the rows

1. **The record verbs table** on `RECORD_VERB_LABEL` (`src/lib/domain/ShopWork.ts`, the JSDoc
   above `RecordVerb`). The labels do not change; the prose and two `for` cells do.
   - Replace "so a member is created, not added (re-creating a deleted email mints a new id)" with
     the rule as decided: Create is for a thing the merchant makes from nothing (a team, a
     workflow); Add is for a person brought into the shop (a member), a thing already in the shop
     put in a set, and a part made inside its parent's editor (a step in a workflow, a task in a
     step). Delete is the member's delete, as it is a team's; Remove still never names a delete.
     Say once why a member is added though its row is new: the merchant does not make the person,
     and the new row is a storage fact the screen never shows.
   - `create` row, `for` cell: "a team or a workflow begins to exist".
   - `add` row, `for` cell: "a member joins the shop; a member goes on a team, or a team into a
     member's teams; a step or a task is made in the editor".
   - `on a` cell for `add`: `set` no longer covers it; write `member, set or part`. Keep one row
     per word: `pnpm spec check` holds the table's screen column to `RECORD_VERB_LABEL`, a map with
     one key per word, so repeated `add` rows would not match it.
2. **The controls table** on `Control` (`src/lib/Screen.ts`).
   - Row "creating a thing": the right-hand cell becomes "the record verbs' create or add label +
     <noun> in the title bar (Create team, Add member); the modal's heading and primary button use
     the same words; ...". Keep the rest of the cell.
   - Row "a set the thing holds": no change.
   - If a row names "Create member", change it to "Add member".
3. `src/lib/domain/Platform.ts`, the JSDoc on the email length: "Create member field" becomes "Add
   member field".
4. `src/lib/domain/Billing.ts`, the JSDoc naming `Repository.createMember`: becomes
   `Repository.addMember` (done in phase 2 with the rename; listed here so it is not missed).

`pnpm spec check` must pass before phase 2.

## Phase 2: the repository

1. Rename `Repository.createMember` to `addMember` (`src/lib/Repository.ts`): the interface, the
   `Effect.fn` name (`"Repository.addMember"`), the export in the returned object, the die message
   "Member missing right after addMember", and the comments at the `listMembers` cache note and
   the team-create note that mention it.
2. Its JSDoc: "the ceiling is applied to _creations_ only: an email already a member is created
   again without consulting it ... re-run the same create" becomes "applied to _new_ members only:
   adding an email already a member does not consult it ... re-run the same add".
3. Call sites: `src/routes/api.dev.seed.ts` (call and JSDoc), `src/lib/domain/Billing.ts`,
   `test/integration/worker-agent-gate.test.ts`, `test/integration/member-runs-socket.test.ts`,
   `test/integration/auth.test.ts`, `test/integration/repository.test.ts`. Find them with
   `grep -rn createMember src test e2e scripts`; the grep must return nothing at the end.
4. Test titles in `test/integration/repository.test.ts`:
   - "createMember inserts idempotently; listMembers round-trips" → "addMember inserts
     idempotently; listMembers round-trips".
   - "createMember refuses at the ceiling and says so, and is a no-op for an existing email" →
     "addMember refuses ...".
   - "createMember after deleteMember mints a new id" → "addMember after deleteMember mints a new
     id", **and** the `pinned by` cell of the member row "no history: re-adding a deleted email
     mints a new id" on `D1_TABLES` (`src/lib/D1Schema.ts`) in the same edit.
5. Keep the `Member.createdAt` column and field. It is a storage name for when the row was written,
   the vocabulary's stored cells are checked against the DDL, and the project does not migrate
   while prototyping; renaming it buys nothing the screen needs.

## Phase 3: the screens

1. **Members index** (`src/routes/app.members.index.tsx`):
   - The title-bar and empty-state button: `` `${Domain.RECORD_VERB_LABEL.add} member` ``.
   - The modal `heading`: "Add member" (built from the label, as the button is).
   - The modal's primary button: `Domain.RECORD_VERB_LABEL.add`.
   - `CreateMemberInput` → `AddMemberInput`, `createMemberFn` → `addMemberFn`, the
     `useServerFn` binding and the mutation's `created` parameter → `added`. The JSDoc on the server
     fn: "Creating stays idempotent for the row" → "Adding stays idempotent for the row".
   - Rename `CREATE_MODAL` and `createButton` only if they are local to this file; the teams and
     workflows indexes keep theirs.
2. **Member page** (`src/routes/app.members.$memberId.tsx`): the Details card's "Created" label
   becomes "Added". The team page's "Created" stays.
3. **Teams index** (`src/routes/app.teams.index.tsx`): the comment that cites "the members index's
   Create member dialog" says "Add member".
4. **Workflow editor** (`src/routes/app.workflows.$workflowId_.edit.tsx`): "Add step" and "Add task" read their verb from
   `Domain.RECORD_VERB_LABEL.add`, as every other record-verb button does. The labels on screen do
   not change. Leave "Add a step to this workflow." alone; it is an empty-state sentence, not a
   button.
5. **e2e** (`e2e/members.spec.ts`): the three `name: "Create member"` lookups become
   `"Add member"`. Grep `e2e/` and `test/browser/` for "Created" on the member page and update it.
6. Look at what you built: screenshot the members index with no members (empty-state button), the
   Add member modal open, and a member page's Details card. Run `pnpm seed` after the e2e run and
   before the screenshots.

## Checks

- `grep -rn "createMember\|Create member\|CreateMember" src test e2e scripts` returns nothing.
- `grep -rn '"Add step"\|"Add task"\|>Add step<\|>Add task<' src` returns nothing (both read the
  label).
- `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`), `pnpm test`, and
  `npm run test:e2e -- e2e/members.spec.ts` pass; then `pnpm seed`.
- `pnpm fmt`, keeping every file it touches.

## Deviations and issues

Recorded while writing the plan:

1. **The research put the Created → Added change on the members index; there is no date column
   there.** The members index shows no date. The only member "Created" on screen is the member
   page's Details card, so phase 3 changes that one. The team page's "Created" stays: a team is
   created.
2. **`docs/crud-screens-research.md` decision 12 now reads against the code.** It is not edited
   (docs are the user's to change); `docs/create-vs-add-research.md` records the reversal.
3. **The `on a` column of the record verbs table assumed one kind per verb.** Add now spans
   three (a member to the shop, a set, a part in the editor). Phase 1 widens the one `add` row
   rather than repeating it, because the screen column is checked against a one-key-per-word map.

Recorded during implementation:

1. **The copy table's button example was "Add step", which `pnpm spec check` requires verbatim in a
   screen source.** Once the editor reads the verb from `RECORD_VERB_LABEL`, no screen carries the
   literal, and every other verb + noun record button is built the same way. The `button` row's
   form and example cells now cite "Clear search" (`SearchLine`), a literal verb + noun button.
2. **The controls row says the modal's primary button is "the verb alone", not "the same words".**
   Every create modal's primary button is the bare label (Create, Add); the plan's phrase "the
   modal's heading and primary button use the same words" would have described Add member as the
   primary, which phase 3 does not do.
3. **`e2e/members.spec.ts` also looked up the modal's primary button by `name: "Create"`.** The plan
   listed only the three "Create member" lookups. The three primary lookups became `"Add"`, and the
   test titles and comments that said "create" for a member now say "add" (no title is pinned by a
   spec table).
4. **Members index, beyond the plan:** the failed-write banner "Couldn't create the member." became
   "Couldn't add the member."; the modal id `create-member` became `add-member` (local to the file,
   as `CREATE_MODAL` → `ADD_MODAL`, `createButton` → `addButton`, `createMutation` → `addMutation`);
   two comments now say Add. The member page's Details row key `created` became `added` with its
   label; `Member.createdAt` stays, as phase 2 says.
5. **The first e2e run failed in setup** because the dev server's tunnel never answered; `pnpm
dev:reset` fixed it. Not a code problem.
