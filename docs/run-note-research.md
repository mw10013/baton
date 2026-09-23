# Run note research

Whether the free-text note belongs on the workflow run or on each step, and how the note and the block should be edited on the member run page (`/shop/$shop/workflows/$runId`) and the merchant order page (`/app/orders/$orderId`).

Written 2026-09-23.

## What exists today

| Thing        | Scope | Stored as                                                                                 | Who writes                                     | Where shown                                                                                          |
| ------------ | ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Step note    | step  | `WorkflowRunStep.note` + `noteByRole`, one text field up to `STEP_NOTE_MAX_LENGTH` (1000) | any member with access, the merchant           | Under the step on the run page; the run list row (`shop.$shop.index.tsx`); the order page Manage row |
| Block reason | run   | `WorkflowRun.flagDetail.reason` + `by`, same cap, overwritten by each block               | the member who blocks; anyone may edit after   | The blocked banner on the run page; `blockedStrip` on the order page                                 |
| Order note   | order | Shopify's order note, read-only in Baton                                                  | the merchant in Shopify admin, or the customer | "Order note" section on the run page                                                                 |

Both editors are inline text areas that open in place. On the run page the same `editor` component serves the step note, the Block reason, and the edit of an existing reason. The step's own buttons (Done, Put back, Undo, Add note) unmount while its note editor is open. The Block editor sits in the item card at the top of the page.

The `noteByRole` column exists only to print "Note (Merchant):" so a worker is not surprised by prose from someone they did not expect. There is no author id, no timestamp, and no history. The last write wins, and `SetBlockReasonCommand` says so deliberately: "Recording the editor would be an attribution the UI never shows."

## Question 1: run note or step note

### What a note is for

Watching what people actually type into a note on a made-to-order job, three uses recur:

1. **A message about this job for whoever touches it next.** "Customer emailed, initials are M.E.B. not M.B.E." or "Fragile, box separately." This is about the item. It has no natural step. Today it lands on whichever step the writer happens to be on, and the next team has to notice it under a step that is already done.
2. **A record of what happened at this step.** "Cut from the second hide, first had a scar." Genuinely step-scoped, but rare for a shop with three to six steps, and mostly interesting after the fact.
3. **A running conversation.** "Waiting on gold foil. — J" then "Foil arrived, stamping now. — K". This is the audit-trail use the user describes. It is one thread per job, not per step.

Uses 1 and 3 are run-scoped. Use 2 is step-scoped but is the least common and the least urgent, and it degrades gracefully into a run note ("Step 1: cut from the second hide").

### Step notes: pros and cons

Pros:

- The note sits next to the work it describes. On the order page the merchant sees exactly which step the comment belongs to.
- Each team's note is separate, so two teams cannot overwrite each other.
- Already built and tested.

Cons:

- **Buried.** A note on step 1 is below the fold once step 1 is done and collapsed in the reader's attention. A note that says "hold everything" has no place to go except the block.
- **Ambiguous destination.** A worker on step 2 who wants to warn step 3 has to decide whether to write on 2 (where it stays behind them) or on 3 (a step that is not theirs). Neither is obviously right.
- **N places to look.** On a six-step run a merchant who asks "is there anything I should know about this job" has six note slots and a block reason to scan.
- **Clutter in every step card.** Every step needs an Add note button, so the button appears five or six times per page, mostly unused.
- **Parallel steps double it.** Two "2 ·" steps in the screenshot each carry their own note; a note about the personalization is relevant to both.
- **The run list already flattens it.** `shop.$shop.index.tsx` prints the step's note after the step name in the row, which is a run-level surface pretending each row is one step.

### Run note: pros and cons

Pros:

- **One place.** "Anything I should know?" has one answer, at the top of the run, on every screen that shows the run.
- **Matches the mental model.** Small shops think in jobs, not steps. A job ticket has one notes box on it.
- **The board and list can show it.** A single note per run fits in a list row or a card footer. Per-step notes cannot be summarized without picking one.
- **Fewer buttons.** One Note action per run instead of one per step.
- **Consistent with the block.** The block reason is already run-level. Note and block reason become two texts on the same object, edited the same way.
- **Simpler schema.** `note`, `noteByRole` (or nothing) move to `WorkflowRun`. The step row loses two columns.

Cons:

- **Loses step attribution.** A reader cannot tell which step a sentence refers to unless the writer says so. In practice writers do say so ("stitching:"), and the run's step list is right there.
- **Shared field, last write wins.** Two people editing at once will clobber each other. See the audit trail section below for why that is acceptable for now.
- **Long notes get long.** An appended conversation over a two-week job can reach the 1000-character cap. Raise the cap for the run note or accept that old lines get pruned by the person editing.
- **Migration.** Existing step notes need to be concatenated into the run note or dropped. The project's no-migrations-while-prototyping rule means this is a schema edit and a reset, which is cheap now and expensive later, which argues for deciding now.

### Audit trail

The user's proposal: one text field, anyone with access may edit, convention is to append and leave earlier text. Assessment:

- **It is enough for the target shop.** Under ten people, everyone knows each other, and a note says who wrote it because they signed it or because there are only two people it could be. Enterprise audit (immutable, timestamped, attributed entries) protects against disputes that do not happen at this size.
- **It fails in two ways, both tolerable.** Someone deletes an earlier line by accident, or two people save at once and one loses. Neither loses work, only commentary, and the person who noticed can retype it.
- **Two cheap helps without an entry model.** Prefill the editor with the existing text plus a blank line and the cursor at the end, so appending is the path of least resistance. Optionally prefix the new line with the writer's short name and a date when the editor opens; the writer can delete it. Both are UI conventions, not schema.
- **Do not build entries now.** A `run_note_entries` table with author and timestamp is the natural v2, and the run-level text field is the right v1 because it can be converted into entries later by splitting on lines. The reverse (entries back to a text field) is also trivial, so nothing is locked in.
- **What the last-write-wins rule already says.** `SetBlockReasonCommand` records no editor on purpose. The same reasoning applies to the run note. Keep it explicit in the JSDoc so a later reader does not add attribution columns that nothing displays.

### Recommendation

Move the note to the run. One text field on `WorkflowRun`, editable by any member with access to the run and by the merchant, appended to by convention. Drop `WorkflowRunStep.note` and `noteByRole`. The "Note (Merchant):" prefix goes: the note is not attributed to a step actor, and signed lines cover who wrote what. The cap is 2000 for the run note, since it accumulates.

Keep the block reason as its own field. It is not a note. It is the answer to "why is this stuck" and it disappears when the block lifts. Folding it into the note would leave stale "blocked because" lines in the note after unblock and would make "is there a reason on this block" a parse of free text.

## Question 2: the editing UI

### Why the current UI feels cluttered

Both screenshots show the same three problems:

1. **Inline editors compete.** The note editor opens inside a step card, the Block editor opens inside the item card, and both can be open at once. Each brings a label, a three-row text area, and a Save/Cancel row. The page grows by two panels and the step's own buttons vanish under the editor.
2. **Buttons everywhere.** Add note appears on every step, including a done step and a step that has not started, next to Done and Put back on the current step. The screenshot has four Add note buttons and one Block button for one job.
3. **Two "2 ·" steps** share a stage label and each has its own note. The eye has to work out that these are parallel and that the note under the first one does not apply to the second.

A second cause: the run page was designed for the phone-in-hand worker, where inline is right for Done and Put back because those are one tap. Typing prose is not one tap, and inline typing on a phone pushes half the page under the keyboard.

### Options for editing

**A. Inline, as now.** Cheap, no modal machinery, keeps the reader's place. Costs the clutter above and gets worse when two editors are open. Fine for a single field per page. Wrong once there are two or more fields that can open.

**B. Modal for both note and block.** `s-modal` already exists in the app (team pages, workflow pages) with `useModalBackdropDismissGuard` covering the Polaris backdrop bug. A modal gives the text area the whole viewport on a phone, guarantees only one editor is open, and leaves the page unchanged behind it. Cost: the reader cannot see the steps while typing, which matters for a note that references them. Mitigation: the modal heading names the run and item ("Note · #1015 Leather journal"), which is what a note needs, not the step list.

**C. Modal for block, inline for note.** Block is a decision with a consequence (the bench stops); a modal frames it as one. The note is casual and inline suits it. But this keeps the per-step Add note buttons unless the note moves to the run, and mixing two patterns for two text fields on one page is more to learn.

**D. A single "Notes and holds" modal.** One dialog with the run note text area and, below it, the block state: a Block button with a reason field, or the current reason with Edit and Unblock. The whole "what should people know about this job" story is in one place. Risk: the block's consequence is buried under a notes label, and Unblock, which is a one-tap action, is put behind a modal open.

Recommendation: **B**, two modals, one per field, once the note is run-level. With a run-level note there is exactly one Note action and one Block action per page, so the "where do the buttons go" question answers itself and the modals do not compete.

### Where the actions go

The proposed three-dot menu near the top of the card is the standard Polaris "secondary actions" pattern (`s-page` secondary actions, or an `s-button` with a popover on a card). Assessment:

- **Block belongs in the page header**, as it is today. It is the page's one run-level action and it is rare. Overflow is fine for it, but a visible Block reads as a promise that the worker can stop the line, which is a product message worth keeping visible. On the merchant order page the run card's row of run-level actions (Block, Cancel run, Change workflow) already exists and is the right place.
- **Note should be visible, not in overflow.** The note is the thing the user wants to be central. Hiding "Add note" behind three dots makes it less likely to be written and the note's presence less obvious. Render the note itself as a section under the item, with an "Add note" button when empty and an "Edit" button beside the text when not. That is the Polaris section-with-action pattern, and it makes the note the second thing on the page after the item.
- **Overflow is for Cancel run and Change workflow** on the merchant page, which are destructive or rare. Those already live at the foot of the run card. Moving them to a menu in the card header is a reasonable tidy but separate from this decision.

Proposed run page layout, top to bottom:

```
#1015                                             [Block]   ← page header
┌ Leather journal ×1 ──────────────────────────┐
│ Initials  M.E.B.                              │
│ Leather journal · ordered 13m ago             │
└───────────────────────────────────────────────┘
┌ Blocked · Stamp monogram ─────────────────────┐  ← only while blocked
│ Waiting on gold foil.                         │
│ Blocked by j@m.com · 2:03 AM   [Edit] [Unblock]│
└───────────────────────────────────────────────┘
┌ Note ──────────────────────────────── [Edit] ─┐  ← run note; "Add note" button when empty
│ Customer emailed: initials M.E.B. not M.B.E.  │
│ 09-22 J: foil on order.                       │
└───────────────────────────────────────────────┘
┌ Order note ───────────────────────────────────┐  ← Shopify's, read-only, as now
Steps
  1 · Cut leather   Done       Leather · lead@m.com · Sep 23
  2 · Stamp monogram  In progress   [Done] [Put back]
  2 · Stitch spine    In progress   [Done] [Put back]
  3 · Condition and inspect        waiting on step 2
```

Step cards lose their note line and Add note button. They become one line for the finished and waiting steps, and one line plus two buttons for the current step. That alone removes most of the clutter in the screenshots.

### The block flow

Today: Block opens an inline reason editor with a critical Block submit. While blocked, a banner shows the reason with Edit reason and Unblock. Editing opens the same inline editor in the banner with Save reason. Three states, one component, three sets of buttons.

Streamlined:

- **Block** opens a modal: heading "Block #1015?", one Reason text area (optional, placeholder as now), primary critical Block, secondary Cancel. Same modal serves the merchant page.
- **Blocked banner** shows the stuck step, the reason, who and when, and two buttons: Edit and Unblock. Unblock stays a one-tap page action, no confirm, because it is reversible (Block again) and the current code already treats it that way.
- **Edit** opens the same modal with heading "Block reason", the reason prefilled, primary Save. No "Block" button in this state because the run is already blocked. This is one modal with two headings and two primary labels, driven by `runIsBlocked`.

This drops the "edit reason inline inside the banner" state, which is where the screenshot's second image gets confusing: a text area in the item card, another in a step card, and the page's Block button gone.

An alternative that removes the edit-reason state entirely: make the reason immutable per block. To change it, Unblock and Block again with the new reason. Simpler code, one fewer button, and the reason genuinely describes the block that was set. The cost is that a typo in a reason costs two taps and re-notifies whoever watches the blocked count. The current code went out of its way to allow editing, so the simpler rule needs the user's call. Recommendation: keep Edit but through the shared modal. It is one extra heading string, not a new state machine.

### Merchant order page

The same shape applies. The run card on `app.orders.$orderId.tsx` today has a Reason text area permanently mounted at the foot of every open run card, above the Block button, so a merchant with four runs sees four empty Reason boxes. Replacing that with a Block button that opens the modal removes four text areas per page. The step Manage rows lose their note button and note line; the run card gains a Note section with Edit, same as the run page.

## Costs and sequence

1. **Schema.** `WorkflowRun.note` (text, nullable, cap 2000). Drop `WorkflowRunStep.note` and `noteByRole`. Edit the initial schema in place per the prototyping rule; the user resets local state.
2. **Domain.** `RunNote` text schema; `setRunNote` commands for member and merchant; delete `SetStepNoteInput`, `stepNoteLine`; the actions table on the run page and the flag rule table lose their "note on a step" rows and gain "note on the run: `runIsLive`". Tests titled by rule.
3. **ShopAgent.** `setRunNote` and `merchantSetRunNote` replacing the step variants, same logging shape (the note never reaches the log line).
4. **UI.** A shared `RunNoteModal` and `BlockModal` in `src/components/`, both on `s-modal` with the backdrop guard. Run page and order page drop the inline editors and per-step note buttons. Run list row prints the run note instead of a step's.
5. **E2E.** The fixtures that set step notes move to the run note.

## Decisions

Reviewed 2026-09-23.

- **Note moves to the run.** Accepted.
- **Two modals, Note and Block.** Accepted, with the layout above.
- **Block reason stays editable**, through the Block modal under a "Block reason" heading.
- **Run note cap is 2000.** The block reason keeps 1000.
- **No "Note (Merchant):" prefix.** `noteByRole` is dropped and nothing replaces it.
- **No prefilled signature line.** The editor opens with the current text and the cursor at the end. Signing is the shop's convention.
- **No SQL migration.** Schema changes go in line in `initializeSchema`; the user resets local state.

## Implementation plan

For the implementing agent. Read the whole plan first, then work section by section in this order. Every section ends with `pnpm typecheck && pnpm lint`; the last section runs tests and `pnpm fmt`.

### 0. Ground rules

- No migration. Edit `initializeSchema` in `src/lib/ShopAgent.ts` in place. The `WorkflowRunStep` and `WorkflowRun` tables live in the Durable Object's private SQLite, which `pnpm d1:reset` wipes along with D1 (it deletes `.wrangler`). **Tell the user to run `pnpm d1:reset`, restart `pnpm app:dev`, and `pnpm seed` once the schema edit lands**, and again whenever a later section changes the schema. Say it in the message where the schema changes, not at the end.
- JSDoc is the spec (`AGENTS.md`). Every rule moved or removed below has a JSDoc that states it and a test titled by it. Move both. When a rule's home changes, the old site gets a `{@link}` to the new one or is deleted; nothing restates.
- Status and flag predicates stay `Domain` functions. `pnpm lint` runs `scripts/rules-lint.ts` and refuses inline comparisons.
- Chrome MCP (`mcp__chrome-devtools__*`) is available for looking at the pages once the dev server is up. Use it to verify section 6 visually. Baton pages need `data-hydrated` before interaction.
- `pnpm fmt` at the end, keep every file it touches.

### 1. Schema (`src/lib/ShopAgent.ts`, `initializeSchema`)

- `WorkflowRun`: add `note text` after `flagDetail text`.
- `WorkflowRunStep`: remove `note text` and `noteByRole text check (...)`.
- `createRun` in `src/lib/WorkflowRunRepository.ts` inserts `note` into `WorkflowRunStep` with a null; drop the column from that insert. Search for every `select` that names `note` or `noteByRole` on run step rows and the `WorkflowRun` row decoders that need the new column (`WorkflowRun` is decoded from `select *` style rows in several places; grep `flagDetail` in the repository to find them).
- Tell the user to reset and restart now.

### 2. Domain (`src/lib/Domain.ts`)

- Add `RUN_NOTE_MAX_LENGTH = 2000` and `RunNote = trimmedText("RunNote", RUN_NOTE_MAX_LENGTH)`. Keep `StepNote` for the block reason but rename it `BlockReason` with `BLOCK_REASON_MAX_LENGTH = 1000`, since after this change nothing else uses it and a symbol named for a step note that no longer exists is a trap. Update `NOTE_COUNT_FROM`'s JSDoc: it is where the countdown starts for both fields, at 200 below each cap, so express it as a function `noteCountFrom(max)` returning `max - 200`, or keep two constants. Pick the function; one number rule, stated once.
- `WorkflowRun`: add `note: Schema.NullOr(RunNote)`.
- `WorkflowRunStep`: remove `note` and `noteByRole`. `RunListStep` omits both today; remove them from its omit list.
- Delete `stepNoteLine`. Nothing prefixes the run note.
- Replace `SetStepNoteInput` with `SetRunNoteInput = { runId: BoundedId, note: NullOr(RunNote) }`, `null` clears. Replace `SetStepNoteCommand` with `SetRunNoteCommand { runId, teamIds?, note }`. No `actor`: same rule and same JSDoc reasoning as `SetBlockReasonCommand` (one field anyone with access may write, last write wins, no attribution the UI shows). State the rule once on `SetRunNoteCommand` and have `SetBlockReasonCommand` `{@link}` it.
- The run page action table (the JSDoc near `runIsLive` listing "note on a step | runIsLive") becomes "note on the run | runIsLive: a note is a record, not work". The `RunFlag` rule table row "Start, Done and Put back are refused; Undo and the note are not" stays true and its wording can stay.
- `BlockRunInput.reason` and `SetBlockReasonInput.reason` become `NullOr(BlockReason)`.

### 3. Repository (`src/lib/WorkflowRunRepository.ts`)

- Replace `setStepNote` with `setRunNote({ runId, teamIds, note })`: `requireRun`, gate `Domain.runIsLive` (refuse on a cancelled run, allow on a done run, as `setStepNote` does today), `requireReadyTeam(runId, teamIds)` for members (the merchant passes no `teamIds`, as `setBlockReason` does), then `update WorkflowRun set note = ?, updatedAt = ? where id = ?`. Check how `requireActionable` and `requireReadyTeam` differ and use the one `setBlockReason` uses, since the two writes now share a shape.
- Every place a `WorkflowRun` row is decoded must select `note`. Every place a `WorkflowRunStep` is decoded must stop selecting `note` and `noteByRole`.
- `listRuns` rows: `RunListRun` should carry `note` if the run list will print it (section 6 says it does). Add it to `RunListRun`'s field list rather than the omit list in `Domain`.
- Tests in `test/integration/workflow-run-repository.test.ts`:
  - Rename "setStepNote writes, overwrites, clears; allowed on a done step and on a done run; refused on a cancelled run" to "setRunNote writes, overwrites, clears; allowed on a done run; refused on a cancelled run" and retarget it to the run.
  - Delete "setStepNote records who wrote the note, and clearing it clears the attribution". The rule is gone.
  - "a flag refuses Start and Done but not Undo or the note, and dismissing it lets work resume": the note half now calls `setRunNote`.
  - Add "setRunNote records no author: last write wins, the same rule as setBlockReason" if `setBlockReason`'s test does not already cover the shared rule by name. One test per rule; if the rule is stated once on `SetRunNoteCommand`, one test titled by it covering both writes is right.
  - Grep the file for `note:` in fixtures and `.note` in assertions; the copy test (`deleteWorkflow leaves its runs and run steps…`) and the actor-snapshot test may touch step notes.

### 4. ShopAgent (`src/lib/ShopAgent.ts`)

- Replace `setStepNote` (member, `memberCallableEffect`) with `setRunNote`, input `Domain.SetRunNoteInput`, log line `ShopAgent.setRunNote: shop=… runId=… memberId=…`, note never in the log line (keep the existing JSDoc sentence).
- Replace `merchantSetStepNote` with `merchantSetRunNote`, same shape as `merchantSetBlockReason`.
- Check the socket message or invalidation path that follows a note write so the run page and order page refetch (look at what `setBlockReason` broadcasts and mirror it).
- `test/integration/member-runs-socket.test.ts` and `worker-agent-gate.test.ts`: grep for `setStepNote` and retarget.

### 5. Client hooks (`src/lib/useMemberRunActions.ts`)

- `note` mutation takes `{ runId, note }` and calls `stub.setRunNote`. Keep `textOrNull`.
- The merchant page's `stub.merchantSetStepNote` call in `app.orders.$orderId.tsx` becomes `merchantSetRunNote({ runId, note })`; its `Change` union member `kind: "note"` carries `runId` instead of `runStepId`.

### 6. UI

Two new components in `src/components/`, each an `s-modal` with the `useModalBackdropDismissGuard` from `src/lib/polarisModal.ts`, opened with `showModal` and closed with `hideModal` (see `CHANGE_WORKFLOW_MODAL` in `app.orders.$orderId.tsx` and the rename modal in `app.teams.$teamId.tsx` for the pattern, including `onAfterHide` resetting the draft on the way out, not in).

**`RunNoteModal`** props: `id`, `runId`, `note: string | null`, `pending`, `onSave(note: string)`. One `s-text-area` labelled "Note", `rows={6}`, prefilled with the current note; countdown below it from `noteCountFrom(RUN_NOTE_MAX_LENGTH)`; secondary Cancel (`commandFor` / `--hide`), primary "Save". Heading "Note". Set `setModalDirty` when the draft differs from the saved text so a backdrop click does not lose typing. Cursor at the end on open: focus the text area in an effect after show and set `selectionStart` to the length, since Polaris does not place it there.

**`BlockModal`** props: `id`, `run`, `pending`, `onBlock(reason)`, `onSaveReason(reason)`. One `s-text-area` labelled "Reason", placeholder "What is stopping this? Who needs to know?", countdown from `noteCountFrom(BLOCK_REASON_MAX_LENGTH)`. Driven by `Domain.runIsBlocked(run)`: not blocked → heading `Block #1015?` (order name and item as the page already formats them), primary critical "Block", empty draft; blocked → heading "Block reason", primary "Save", draft prefilled with `run.flagDetail?.reason ?? ""`. Cancel on both.

**Member run page (`src/routes/shop.$shop.workflows.$runId.tsx`)**:

- Remove `noteDraft`, `blockDraft`, `reasonDraft`, `editingReason`, the shared `editor`, and `NoteCountdown` (moves into the modals or a shared tiny component both import).
- Page header: Block button (shown under the same `canBlock` rule) opens `BlockModal`.
- Blocked banner: keep stuck step, reason, who and when; buttons Edit (opens `BlockModal`) and Unblock (as now, one tap).
- New `s-section heading="Note"` between the item card and the Shopify "Order note" section. Empty: one "Add note" button. Present: the text as a wrapping `Prose`, and an "Edit" button in the section's action slot. Shown while `Domain.runIsLive(run)` allows the write; on a cancelled run show the text with no button.
- Step cards: remove the note line and the Add note / Edit note button. `can.note` on the per-step permissions object goes; move the "may write the note" boolean to the run level.
- The JSDoc on the page that explains why the editor unmounted the step buttons goes with the editor.

**Merchant order page (`src/routes/app.orders.$orderId.tsx`)**:

- Remove the always-mounted Reason `s-text-area` at the foot of each run card, `blockReason` state, `noteDraft` state, and `noteEditor`.
- Run-level action row: Block opens `BlockModal`; Unblock stays; Cancel run and Change workflow unchanged.
- `blockedStrip`: add an Edit button beside Unblock that opens `BlockModal`. The comment on `SetBlockReasonCommand` says the merchant has no reason-setting button yet ("No merchant button sets a block reason yet"); this adds it, so delete that comment and the `NotBlocked` error copy stays.
- Add a Note section in the run card above the step Manage rows, same shape as the member page.
- Manage rows: remove `noteButton`, the note paragraph, and `noteEditor`. The long JSDoc on the manage-row builder that lists "notes" among the interventions needs its wording updated.
- One modal instance per page, keyed by the run it is about (the pages already do this for `CHANGE_WORKFLOW_MODAL` with a "which run" state; follow that).

**Run list (`src/routes/shop.$shop.index.tsx`)**: the done-today entry prints `stepNoteLine(entry.step)`. Print `entry.run.note` after the item title instead, truncated with the same rule the row uses for other prose, or drop it from the row if the row's shape does not carry the run. Decide by reading the entry type; prefer printing it.

### 7. E2E (`e2e/`)

- `member-runs.member.spec.ts`: "a step card says its state once and its note editor replaces the card's buttons" is about the removed editor; replace with "the run note opens in a modal and the step cards carry no note button" asserting: no "Add note" inside any step card; one "Add note" in the Note section; clicking it opens a dialog with a "Note" text area; saving shows the text in the Note section; the countdown appears at 1800 and reads "200 characters left" at 1800 (`noteCountFrom(2000)`).
- "the work page shows the step history and takes a note, a block, and Done": retarget the note steps to the modal, and the Block steps to the modal (button "Block" in the dialog, then the banner shows the reason; "Edit" reopens the dialog with heading "Block reason"; Save rewrites it).
- Any fixture in `e2e/fixture.ts` that seeds step notes moves to `note` on the run. Grep `note` there.
- Merchant spec files that click "Note" or fill "Reason" on the order page: grep `Reason` and `Save note` under `e2e/`.
- Run `npm run test:e2e --` headless.

### 8. Docs alignment

- Grep `src/` for `stepNoteLine`, `StepNote`, `SetStepNote`, `setStepNote`, `noteByRole`, `NOTE_COUNT_FROM`, `STEP_NOTE_MAX_LENGTH`, `Note (Merchant)`, `Note about this step`, `Save note`, `Edit reason`, `Save reason`. Each hit is either deleted or its JSDoc rewritten to the run-level rule.
- The `RunFlag` rule table, the run page action table near `runIsLive`, `SetBlockReasonCommand`'s JSDoc, and the ShopAgent JSDoc "The note itself never reaches the log line" are the four JSDocs that state rules touched here. Make sure each still reads true and the tests named in section 3 match their titles.

### 9. Verification

1. `pnpm typecheck && pnpm lint`.
2. `pnpm test` (integration suite).
3. `pnpm fmt`, keep everything it touches.
4. Dev server up, seeded. With Chrome MCP or `pnpm playwright-cli`, open a run page as a member: add a note, edit it, block with a reason, edit the reason, unblock. Open the same order as the merchant: the note shows, edit it, block from the run card, edit the reason from the strip, unblock. Take screenshots of the run page in each state and compare against the layout sketch above.
5. `npm run test:e2e --`.

### 10. Deviations and issues

Fill in as you go. Record anything the plan got wrong, any rule you found that the plan did not name, any choice you made that the user should know about, and anything left undone.

| #   | Section | What the plan said                                                               | What was done instead and why                                                                                                                                                                                                                                                                                                                                   |
| --- | ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 3       | Gate member note writes with `requireReadyTeam`, as `setBlockReason` does.       | Added `requireRunTeam`: any step of the run on one of the member's teams, the same access `getRunView` grants. `requireReadyTeam` would refuse every member on a done run (no ready step), contradicting "allowed on a done run". Tested as "setRunNote admits a member whose team has any step of the run, ready or not, and refuses one whose team has none". |
| 2   | 2       | Not mentioned.                                                                   | Renamed `RunView.note` (Shopify's order note) to `orderNote`, so it does not sit beside the new `run.note`.                                                                                                                                                                                                                                                     |
| 3   | 6       | Two components, `RunNoteModal` and `BlockModal`.                                 | Both live in `src/components/RunTextModals.tsx` on a shared private `TextModal`. The countdown is the text area's `details` line rather than a separate text. The save callback returns an error message (or `null`), shown under the field, so a refused write is visible while the modal is open.                                                             |
| 4   | 6       | Merchant order page: a Note section in the run card, with "Add note" when empty. | The card shows the note (with Edit) only when there is one. "Add note" sits in Manage's run-level action row, since the card stays read-only at rest. The row now also renders on a done run so the note can be added there.                                                                                                                                    |
| 5   | 6       | Member run page layout sketch.                                                   | Followed the sketch: item card (with the blocked banner), Note, Order note, then Steps. Order note moved above Steps.                                                                                                                                                                                                                                           |
| 6   | 6       | Run list prints the run note.                                                    | Printed on the Done-tier row only, where the step note was. The open-tier rows do not print it.                                                                                                                                                                                                                                                                 |
| 7   | 7       | Replace the step note editor test.                                               | Also deleted "an open editor takes its container's buttons with it": the editor it tested is gone. Its Block and Edit coverage moved into the work page test.                                                                                                                                                                                                   |
| 8   | 6       | Not mentioned.                                                                   | The note modal hides its "Note" label visually because the heading already says it. Screen readers still get the label.                                                                                                                                                                                                                                         |

Left undone:

- Nothing. The E2E suite passes (53/53) after the reset. The run page (empty, note modal, block modal, blocked, edit reason) and the merchant card were checked in screenshots.
- At phone width the page header's Block collapses into the ⋯ overflow menu. That is `s-page`'s `secondary-actions` slot and predates this change.

Questions for the user:

- None.

### 11. Review

Reviewed 2026-09-23 against the plan and the deviations above. Deviations 1 to 8 are sound and kept. Two issues fixed:

| #   | Issue                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | On the member run page a refused note, block or reason write showed twice: under the modal's field and in `actions.banner` behind it, where it stayed after the modal closed.                                                   | `useMemberRunActions` feeds `banner` from the one-tap actions only; the JSDoc on `banner` states why.                                                                                                                                                                                                                                       |
| 2   | Deviation 1's access rule ("any step of the run on one of the member's teams") was stated twice, as a JS predicate in `getRunView` and as SQL in `requireRunTeam`, with the "step is on my teams" clause inlined at five sites. | `Domain.runIsVisibleTo` (the rule, with its JSDoc) and `Domain.stepIsOnTeams`; `getRunView`, `requireRunTeam`, `requireReadyTeam`, `requireActionable`, the run list filter and `stepActions` all call them. Test: "a member's access to a run is any step of it on one of their teams, ready or not" in `test/integration/domain.test.ts`. |

Also: the order page now imports `errorMessage` from `useMemberRunActions` instead of restating it.

Out of scope, noted for the user: the working tree also carries changes not in this plan and not in the page-banners plan. On `app.orders.$orderId.tsx`: the order summary line and its `WAITING_ON_LIMIT` are removed, "View in Shopify" became the primary action, the "Last synced" and "Items" facts are gone, and payment and fulfillment statuses go through a new `formatStatus`. `OrdersIndexLoaderData.ordersPerCycle` is removed. They typecheck, lint and pass the tests, and were left as found.
