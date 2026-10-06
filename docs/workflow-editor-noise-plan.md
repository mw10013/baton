# Plan: cut what the page already says

Written 2026-10-05 from the ten decisions in `docs/workflow-editor-noise-research.md`, all accepted.
It is for an agent that has not seen that research. Read its "Short answers", "Rules for the
specs" and "Decisions" first. This plan does not repeat the reasoning. It says what to change, in
what order, and how to check it.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, normatively, in the JSDoc on the symbol that enforces it. Other sites
    `{@link}` it, and the rule has a test whose title is the rule.
  - JSDoc never cites `docs/`.
  - A copy or control change starts at the row in `src/lib/Screen.ts`; `pnpm spec check` refuses
    a copy-row example no screen shows.
  - Routes compose parts from `src/components/screen/` and lay out nothing.
  - Run `pnpm fmt` and keep everything it touches. Do not commit unless told to.
- Look at what you build: screenshot the editor with the New step form open, the workflow page
  with both faults, the orders index mid-sync, the members and teams indexes, and the member's
  workflow page on a closed run, before the phase that changed them is called done.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` at the end of every phase; the admin and
  member e2e projects at the end of phase 4.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go.

## The decisions, as work

| decision                                                                     | phase |
| ---------------------------------------------------------------------------- | ----- |
| 10 lint rules; the table rows every cut hangs on                             | 1     |
| 1 blocker banner, 2 Saved line, 4 help, 5 "(no members)", 6 empty-team badge | 2     |
| 3 counters                                                                   | 3     |
| 7 Syncing line and closed frame, 8 explainer paragraphs, 9 date columns      | 4     |

## Phase 1: the rows and the lint

### 1.1 `src/lib/Screen.ts`, copy table (`CopySlot`)

- `help` row: "empty when" becomes "there is none; the field or its neighbours already say it";
  "never" adds "states a number the field enforces; names the reader when the form does".
- `banner` row: "empty when" becomes "a disabled control, an empty canvas, an open form, a badge
  or another banner on the page already states the fact"; "form" adds "warning or critical, never
  info"; "example" becomes "Needs a team" (the editor's "Turn on is unavailable" goes in phase 2).
- `body` row: "never" adds "explains the product beside content; the explanation is the empty
  state's"; "example" becomes a body string that stays, "Nobody is on this team, so its tasks
  wait until a member joins." (the home page's "Each order counts once" goes in phase 4).
- Tone list: add the sentence "One fact, one place: a disabled control, an empty canvas, an open
  form and a badge each state a fact, and nothing restates one of them."

### 1.2 `src/lib/Screen.ts`, controls table (`Control`)

- Banner row: control becomes "a banner above the content, warning or critical; info never: an
  undismissable info banner contradicts Polaris, so an info fact is a line or a badge".
- New rows:
  - "a write in flight | `loading` on the pressed button | a status line; a Saved, Saving,
    Syncing or Loading sentence"
  - "a text limit | free text (note, reason, instructions) counts down in its `details` from
    {@link Domain.noteCountFrom}: "N characters left"; a one-line field shows nothing; both
    refuse on submit with the field's own error "Up to N characters" | `maxLength` on the element
    (Polaris draws `n/max` on an empty field); a hand-made counter; a limit in help text"
  - "a choice among records | a select of names | a count or state in the option label"
  - "a date on a table row | only when the list is ordered by it (Placed) or a recent change is a
    reason to open the row (Updated on workflows) | Created; On team since"
- The "a count of items needing work" row's "never" already says a banner unless it disables
  something; add to the "a fact about the page that disables things" row's "never": "a banner for
  a fault that disables nothing (that is a badge on the thing)".

### 1.3 `scripts/lib/rules-lint.ts` and its test

Four exported pure functions, each a regex over the lines of one source, in the shape of
`textAreaPlaceholderHits`:

- `infoBannerHits(source)`: an `s-banner` opening tag (across lines) with `tone="info"`. Applied
  by `scripts/rules-lint.ts` to `COPY_FILES` minus `src/routes/admin.*`.
- `maxLengthHits(source)`: `maxLength=` inside an `s-text-field`, `s-text-area` or
  `s-email-field` opening tag. Applied to `src/routes/` and `src/components/` outside
  `src/components/screen/`.
- `optionAnnotationHits(source)`: an `s-option` whose text (JSX text or a template on the same
  line or the next) contains `(`. Applied to `COPY_FILES`.
- Retired words, in `RETIRED` and the JSDoc table: `/^\s*(?:✓\s*)?sav(?:ed|ing)\b/iu` (a
  sentence that starts with Saved or Saving; "Note saved" stays, the toast row owns it),
  `/\bsyncing\b/iu`, `/\bloading\b/iu`. Table rows say why: the controls row for a write in flight.

Tests in `test/integration/rules-lint.test.ts`, one `describe` per rule, titled with the rule:
"an info banner is refused on a merchant or member screen", "maxLength is refused on a field
outside src/components/screen/", "an s-option carries no parenthesis", "Saved, Saving, Syncing
and Loading are retired as screen copy". Each test shows a refused line and an allowed one
(`tone="warning"`; `maxLength` inside `screen/` is the caller's exemption, not the regex's; "Note
saved"; an option that is a name).

`scripts/rules-lint.ts`: wire the three functions and their directory filters; the error line
names the rule and the controls row.

### 1.4 Checks

`pnpm lint` now fails on the sites phases 2 to 4 fix. That is the order of work: the lint's
list is the to-do list. `pnpm test` passes (the rules-lint tests are pure).

## Phase 2: the workflow pages

### 2.1 Editor, `src/routes/app.workflows.$workflowId_.edit.tsx`

- Delete the blocker `s-banner` block and its comment. `blocker` stays: it disables Turn on
  through `WorkflowSwitch` and Apply. `applyResultMessage` keeps its JSDoc, reworded: it is the
  result of a press (toast or critical banner), never a standing banner.
- Delete the footer `s-text` ("Saving…" / "✓ Saved · Last changed on") and its comment. `busy`
  stays (it disables controls).
- Delete `INSTRUCTIONS_HELP` and both `details={INSTRUCTIONS_HELP}`.
- `teamSelect`: the option text is `team.name`.
- Both Instructions `s-text-area`: drop `maxLength`; spread the countdown (phase 3 makes it a
  part; until then import `countdown` from where phase 3 puts it, so do 3.1 before this line).
- Rename modal: drop `maxLength` and the hand-made counter `s-text` and its comment. The submit
  path sets `nameError` to "Up to 64 characters" when `name.length > Domain.NAME_MAX_LENGTH`
  before calling the mutation (the schema refuses anyway; this is the message).

### 2.2 Workflow page, `src/routes/app.workflows.$workflowId.tsx`

- Delete the info `s-banner` ("Turn on is unavailable") and its condition; `blocker` stays for
  the switch. `switchResultMessage` in `WorkflowSwitch.tsx` keeps NoTasks and TaskUnassigned for
  the press result.
- Rename modal: as 2.1. Duplicate modal: drop `maxLength` on Name and Tag; the submit path sets
  the field error.

### 2.3 The empty-team fault, `src/components/WorkflowSteps.tsx` and `src/lib/domain/ShopWork.ts`

- `TeamFaultBanners` renders only `unassigned`. Rename nothing; rewrite its JSDoc: one banner,
  for the fault that disables Apply and Turn on; the empty-team fault is a badge on the step
  ({@link TeamLine}).
- `TeamLine`: after the team name, when `Domain.hasEmptyTeam([task])` (or a per-task predicate if
  `hasEmptyTeam` takes a list), an `s-badge tone="warning"` reading "No members", the teams
  index's word. Rewrite its JSDoc: "No team" is a fact, "No members" is a badge, one mark per
  fault on the page.
- `emptyTeamLine` in `src/lib/workflowShared.ts` loses its last consumer: delete it and its
  "That task / Those tasks" helper if nothing else reads them.
- `WORKFLOW_FAULT_LABEL` JSDoc: "the workflows index's badges, the workflow page's banner
  (unassigned) and step badge (empty team)". The `empty_team` label stays "Team has no members"
  for the index badge; the step badge reads "No members" because it sits under the team's name.
  Check the vocabulary's workflow-faults row in `Domain.ts` / `ShopWork.ts` says the same and that
  `pnpm spec check` still matches the screen column to the constant.

### 2.4 Tests

- `e2e/workflows.spec.ts`:
  - "a fresh workflow turns on from the editor, then edits go through the draft": drop the
    "Add a step to this workflow." and "✓ Saved" assertions; assert Turn on is disabled before
    the first step and enabled after.
  - "the workflows index and the workflow page show Needs a team and Team has no members apart":
    the page shows one critical banner "Needs a team" and a "No members" badge on the Attach ring
    step; no banner headed "Team has no members".
  - "the editor stops instructions at 500 characters" becomes "the editor counts instructions
    down from 300 and refuses 501 on save": no help text; fill 300 characters, "200 characters
    left" is visible; fill 501, Save, the field error "Up to 500 characters" is visible and the
    value is unchanged.
- `test/integration/shop-agent-workflows.test.ts` and `workflow-repository.test.ts` pin
  `memberCount` and `emptyTeam`; unchanged.

### 2.5 Screenshots

Editor with New step open on a fresh workflow; workflow page with both faults.

## Phase 3: the text-limit part

### 3.1 `src/components/screen/TextLimit.ts` (a part, no JSX)

Move `countdown` out of `RunTextModals.tsx`: `textLimitProps(value, max)` returns `{}` below
`Domain.noteCountFrom(max)` and `{ details: "N characters left" }` from it; and
`textLimitError(value, max)` returns `"Up to N characters"` or `null`, for the submit path of
every field with a limit. JSDoc carries the rule from the controls row and links it. Add the
part to the parts table on `ScreenPart`: "text limit | the countdown and the submit error for a
field with a cap | `TextLimit` | nothing; props only | every form".

### 3.2 Sites

- `RunTextModals.tsx`: use the part; its submit path already shows the schema error, so switch
  it to `textLimitError` first.
- Editor Instructions (both): spread `textLimitProps`; Add step and Save set a field error from
  `textLimitError` before mutating (a new `instructionsError` state, cleared on input, as
  `nameError` is).
- Name fields: workflows index Create (Name, Tag), workflow page Duplicate (Name, Tag), Rename
  (both pages), teams index Create, team page Rename, members index email, `WorkflowTag.tsx` Edit
  tag: drop `maxLength`; the submit path sets the field error from `textLimitError`. Tag's cap
  gets a constant, `TAG_MAX_LENGTH = 255` in `ShopWork.ts`, so the error can name it.
- `ListSearchField.tsx`: its comment about Polaris's counter now links the controls row.

### 3.3 Tests

- `e2e/member-runs.member.spec.ts` "the run note opens in a modal …": unchanged ("200 characters
  left").
- `test/browser/`: one test, "a one-line field refuses 65 characters on submit with its own
  error", on the teams index Create modal (33 for a team name): the error reads "Up to 32
  characters" and no counter is shown.

## Phase 4: the other screens

### 4.1 Orders index, `src/routes/app.orders.index.tsx`

Delete `syncStatusText` and its render site. The Sync button is `disabled` while
`syncInFlight` and `loading` while the request is out; that is the status. "Couldn't read sync
status." was an error line on the same slot: the orders query's error already renders its
critical banner, so it goes too. `e2e/orders.spec.ts`: the completion signal becomes the Sync
button disabled then enabled (`hoistedEnabled(sync)` false, then true, with the same timeouts).

### 4.2 Member's workflow page, `src/routes/shop.$shop.workflows.$runId.tsx`

Replace the info `s-banner` around `ClosedLine` with `<ClosedLine run={run} viewer="member"
prefix />` in the `Lines` under the item heading (the `prefix` prop exists for "where no badge
beside the line already says Closed"). Rewrite the comment. `e2e/member-runs.member.spec.ts`: if
a test locates `s-banner[heading="Closed"]`, it locates the text "Closed · " instead.

### 4.3 Explainer paragraphs

- `app.members.index.tsx` head: delete the `s-paragraph`. The empty state keeps its sentence.
- `app.teams.index.tsx` head: delete the `s-paragraph`.
- `app.index.tsx`: `MeterTile` `detail` becomes optional in `MeterTile.tsx`; the orders tile
  passes `detail` only when over (the "N over" sentence) or when `ordersReset` exists ("Resets
  <date>."); the members tile passes it only when over. Check `pnpm spec check`: the body row's
  example moved in 1.1.
- `e2e/` and `test/browser/`: grep for the three sentences and drop the assertions.

### 4.4 Date columns

- `app.teams.index.tsx`: drop the Created header and cell.
- `app.members.index.tsx`: drop the Created header and cell.
- `app.teams.$teamId.tsx` members table and `app.members.$memberId.tsx` teams table: drop the On
  team since header and cell. `inTeamSince` stays in the data (the Details card may use it;
  if nothing reads it, leave the field: a data change is not this plan's).
- Workflows index keeps Updated; orders index keeps Placed.
- Tests: grep `e2e/` and `test/browser/` for "Created" and "On team since" and drop the
  assertions. The Screens table in the vocabulary does not list columns; nothing to change there.

### 4.5 Order page select

`app.orders.$orderId.tsx`: the option text is `team.name`.

### 4.6 Final checks

`pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e -- --project=admin
--project=member`, `pnpm seed`, then `node scripts/copy-audit.ts` and read the banner, help and
body sections: no banner that restates, no help that counts, no explainer beside content.
Screenshots of the six screens listed under "Before you start".

## Deviations and issues

Record each as it happens: what the plan said, what was done instead, and why.

### Deviations

1. **"Loading" is not retired, and "syncing" is retired only at a sentence's start.** The plan
   retired four words. `\bloading\b` hit the member's workflows list, whose rows read
   "Loading…" while a read for a new filter is out: that is the list's in-flight placeholder,
   not a resting state, and no regex tells the two apart. `\bsyncing\b` hit the quota banner's
   "New orders stopped syncing at N open orders", a fact. The regexes are
   `^\s*(?:✓\s*)?sav(?:ed|ing)\b` and `^\s*syncing\b`; the controls row says "a Saved, Saving
   or Syncing sentence".
2. **The text-limit part is `TextLimit.tsx`, not `.ts`.** `pnpm spec check` resolves a part's
   component as `<name>.tsx` under `src/components/screen/`. It holds no JSX.
3. **The banner row's example is "Every item is done.", not "Needs a team".** The spec check
   matches an example against the screen files' literals, and "Needs a team" reaches the screen
   through `WORKFLOW_FAULT_LABEL` in the domain. The order page's success banner is the one
   standing banner literal a merchant screen shows.
4. **The one-line field test is an e2e step, not a browser-project test.** `test/browser/` holds
   the socket tests only and has no admin frame. The check (33 characters, no counter, "Up to
   32 characters" on Create) is the first step of "teams screen creates, adds members to,
   renames, and deletes a team" in `e2e/teams.spec.ts`.
5. **The TanStack-form sites check the cap in one `submit` helper** used by both the `<form>`
   submit and the primary button, rather than in the form's `onSubmit` alone: the modal's Create
   button calls `form.handleSubmit` directly and would have bypassed a check on the form element.
   The members index gains an `emailError` state for it.
6. **The home page's orders tile keeps a line when the cycle end is known** ("Resets <date>."):
   that is a date the merchant acts on, not an explanation. Only the two explanations went.
7. **`switchResultMessage` is no longer exported.** The workflow page's banner was its only
   outside reader; `WorkflowSwitch` uses it for the press result.
8. **The members cap e2e test changed its claim.** "a 254-character email is created and
   printed whole, and the field takes no more" asserted `maxLength` truncation; it now asserts
   the 255-character value stays and Create shows "Up to 254 characters". The first run also
   found the members index missing its `React` import for the new state, fixed.

### Issues

0. **Status 2026-10-06: implemented, all green, uncommitted.** `pnpm typecheck`, `pnpm lint`,
   `pnpm test` (36 files, 762 tests), the admin and member e2e projects (87 tests), the copy
   audit (four banners left, none restating; three help lines, none counting; no explainer
   beside content). Screenshots taken: the editor with New step open on a fresh workflow (no
   banner, no footer, no help, no counter, Turn on and Add step disabled), the workflow page
   with an unassigned task (one critical banner) and with an empty team (a "No members" badge on
   the step), the teams, members, workflows and orders indexes, the home page, and, signed in
   as a member through the demo-mode magic link, the workflows list and a cancelled run's page
   ("Closed · Cancelled by the merchant · just now" as a line under the item, no banner).
1. **`inTeamSince` is gone from the data too.** The plan left it; after the columns went
   nothing read it, and a field nobody reads is not kept. Dropped from `TeamDetail`,
   `MemberDetail` and the two queries in `Repository.ts`. `createdAt` on a team and a member
   stays because each details card prints it (decision 9); `memberCount` on a task stays
   because the step badge reads it.
