# Order detail: blocked state and Manage actions plan

Implementation plan for the decisions in `docs/order-detail-blocked-and-manage-research.md` (all accepted 2026-09-24). Written for an LLM agent to execute. Read the research first; it holds the reasoning that the JSDoc changes below have to carry inline.

Scope: the merchant order page `src/routes/app.orders.$orderId.tsx`, the shared `src/components/MemberRun.tsx`, the member run page `src/routes/shop.$shop.workflows.$runId.tsx`, and the e2e specs that assert on the old shapes. No schema, repository, or `ShopAgent` change. No behaviour change on the member pages beyond lifting one block into a shared component.

## Target render

A blocked, in-progress run's card on the order page, at rest:

```
[In progress] [Blocked]                        <- Blocked badge is red (critical)
┌ s-banner tone="critical" heading="Blocked" ─┐
│ WE are stuck                                 │  <- reason as typed, via Prose
│ Merchant · 11:30 AM                          │  <- no "Blocked by"
│ [Edit] [Unblock]                             │  <- the only Unblock on the page
└──────────────────────────────────────────────┘
Step 2 of 18 · Condition, burnish and inspect the edges against the customer
Note                                   [Edit]  <- always drawn on a live run; subdued "Note" when blank
```

The Manage disclosure's run-action row: `[Block] [Cancel run] [Change workflow]`, all plain secondary. While blocked, the Block slot is simply absent. `Change workflow` opens a modal holding the select and the warning sentence.

## Steps

Do them in order. Run `pnpm typecheck && pnpm lint` after each step that touches code; run `pnpm fmt` at the end and keep every file it touches.

### 1. Blocked badge tone

In `app.orders.$orderId.tsx`:

- Import `flagTone` from `@/components/MemberRun`.
- In `renderRun`, replace `<s-badge tone="warning">{flagLabel(run)}</s-badge>` with `<s-badge tone={flagTone(run) ?? "warning"}>`. (`flagTone` returns `null` only when `flag` is null, which `Domain.runIsFlagged` already excludes; the fallback is for the type.)
- JSDoc: on `flagLabel`, add one sentence that the tone comes from `flagTone` so the merchant and the worker see the same split (blocked and order-cancelled red, reconcile flags amber), and the label wording is this page's own on purpose. Do not restate the rule itself; `{@link flagTone}` it.

### 2. Replace `blockedStrip` with `FlagBanner`

In `app.orders.$orderId.tsx`:

- Import `FlagBanner` from `@/components/MemberRun`.
- Delete `blockedLine` and `blockedStrip` and their JSDoc.
- In `renderRun`, replace the `blockedStrip(detail, <>{editReasonButton(run)}{unblockButton(run)}</>)` call with `<FlagBanner run={run} actions={<>{editReasonButton(run)}{unblockButton(run)}</>} />`.
- `FlagBanner` renders `actions` as children of `s-banner`. Check in the browser that two `s-button`s render on one line inside the banner. If they stack, wrap them in `<s-stack direction="inline" gap="small-300">` inside the `actions` node on this page. The member page passes buttons with `slot="secondary-actions"`; on the order page the buttons are plain and sit in the banner body, which is fine, but confirm the look.

`FlagBanner` also renders for the reconcile flags (item removed, quantity changed, order cancelled, already shipped). On the order page only `Domain.runIsBlocked(run)` should show the banner, as today; keep the `Domain.runIsBlocked(run) &&` guard. The reconcile flags keep their badge only, as today.

Attribution: `FlagBanner` prints `Merchant · <relative time>` using `LocalDateTime format="relative"`. The old strip used `format="time"`. Accept the relative form; it matches the member page and the e2e fixture comment in `e2e/fixture.ts` ("Blocked by Merchant") is prose, not an assertion.

- JSDoc on `FlagBanner` in `MemberRun.tsx`: it currently describes itself for the member page. Add that the order page renders it for `blocked` only and passes Edit and Unblock as `actions`, so the merchant sees the same banner the worker sees.
- JSDoc on `unblockButton`: it says "rendered both in the blocked strip on the card and in the Manage disclosure". After step 4 it is rendered once, in the banner. Rewrite: one definition, one site, the banner; the reason it is still a function is that it needs `identified`, `busy` and `intervene`.
- JSDoc on `editReasonButton`: "the strip's Edit" becomes "the banner's Edit".

### 3. Now line while blocked

In `nowLine`, delete the early return `if (Domain.runIsBlocked(run)) return null;` and its comment. Update the JSDoc: the blocked run is the one card where "why it stopped" (the banner) and "where it is" (this line) are different questions, so both render. `Domain.readyTasks` already returns the lowest open step's tasks for a blocked run (`runIsOpen` is true while blocked), so no domain change.

Check: `nowLine` has a branch for a parallel step (several ready tasks). Confirm on the seeded 20-task order that the blocked run's line reads `Step 2 of 18 · <one name>` or whatever the parallel form is, and does not list three names.

### 4. Manage row: drop Unblock, drop red

In `manageRows`:

- Replace the ternary `Domain.runIsBlocked(run) ? unblockButton(run) : <Block button>` with `!Domain.runIsBlocked(run) && <Block button>`.
- Remove `tone="critical"` from the Block button and from the Cancel run button.
- Update the row comment ("Block (or Unblock while blocked) leads…") and the `manageRows` JSDoc paragraph beginning "No action here is primary". New rule to state there: nothing in this row is red because every action here is reversible in one tap (Block by Unblock, Cancel by Undo cancel) and red belongs to the submit that commits a loss, which on this page is the Change workflow modal's. Cite Polaris: critical tone marks the button that performs the destructive action, not the one that opens the question.
- Update the `manageRows` JSDoc list "Block or Unblock, Cancel run, Change workflow, Add note" to "Block, Cancel run, Change workflow".
- The divider condition `(open || Domain.runIsBlocked(run) || addNote)` and the row condition `(open || addNote)` simplify once `addNote` goes in step 5: divider and row render when `open`.

### 5. Note block: always present, one Edit

Create `RunNote` in `src/components/MemberRun.tsx`:

```tsx
/**
 * The run's note, always drawn while the run is live: the text as typed, or
 * the subdued word "Note" as the field's name when blank. One verb, Edit,
 * because the note is a column that is always there and may be blank
 * ({@link Domain.SetRunNoteCommand}: `null` clears); "Add" would promise a
 * "Remove" that does not exist. On a run that is not live a blank note draws
 * nothing and a written one is read-only. Both run pages render this so the
 * placeholder word and the verb cannot drift.
 */
export function RunNote({ note, canEdit, pending, onEdit }: {
  readonly note: string | null;
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onEdit: () => void;
}) { ... }
```

Body: the inline stack from `shop.$shop.workflows.$runId.tsx` (the `(hasNote || canNote)` branch), with `hasNote ? <Prose>{note}</Prose> : <s-text color="subdued">Note</s-text>`, and a secondary `Edit` when `canEdit`. Return `null` when `!hasNote && !canEdit`.

Member page: replace that inline branch with `<RunNote note={run.note} canEdit={canNote} pending={actions.pending} onEdit={() => showModal(NOTE_MODAL)} />`. Keep the `hasOrderNote` block under it unchanged. Keep the surrounding comment, trimmed of the sentences now on `RunNote`.

Order page:

- Delete `noteBlock` and its JSDoc.
- In `renderRun`, where `noteBlock(run)` was, render `<RunNote note={run.note} canEdit={Domain.runIsLive(run)} pending={!identified || busy} onEdit={() => openModal(NOTE_MODAL, run)} />`. The order page's old block wrapped the note in a subdued `s-box` with a bold "Note" heading; drop that and use the shared shape. If it reads as floating on the card, wrap `RunNote` on the order page only in the same `s-box background="subdued" borderRadius="base" padding="small-300"` and note in a comment that the card needs the box because it holds several runs' notes in one section, where the member page holds one.
- Delete `addNote` in `manageRows` and the `Add note` button.
- `manageRows` JSDoc: delete the paragraph "The note is the run's, not a task's: it shows on the card (`noteBlock`), and `Add note` joins the run-level row here while it is empty." Replace with one sentence: the note is on the card ({@link RunNote}) and has no button here.

Edge: `renderRun` currently calls `noteBlock` for cancelled runs too. `RunNote` with `canEdit=false` and a blank note returns null, so a cancelled run with no note draws nothing, matching the member page.

### 6. Change workflow modal

In `app.orders.$orderId.tsx`:

State:

- Delete `changeOpen`, `setChangeOpen`, `changingRun`, and every reference (the `onSuccess` handler in `attachMutation`, the button toggle, the picker Cancel).
- Extend `changing` to hold what the modal needs: `{ lineItemId, from: Domain.WorkflowName, options: readonly WorkflowOption[], tasks: readonly Domain.WorkflowRunTask[], workflowId: string | null }`. `workflowId` is the modal's own pick, starting `null`. Do not reuse `attachChoice` for it; that map belongs to the at-rest Start picker and the current code has to clear it by hand on Cancel to avoid a leaked preselect. Separate state removes that.
- `modalRunId` stays for the note and block modals.

Rendering:

- `workflowPicker(onCancel?)` loses its `onCancel` parameter and the tertiary Cancel; it is now only the at-rest Start / ambiguous picker. Update its JSDoc: "in two places" becomes one place, and the paragraph about sharing `attachChoice` goes.
- `change` becomes `{ button }` only: a plain secondary `Change workflow` whose click sets `changing` with the item's `live` run, its options, its tasks, and `workflowId: null`, then `showModal(CHANGE_WORKFLOW_MODAL)`. Delete `picker`. `manageRows`'s second parameter becomes `React.ReactNode | null` and `{open && change?.picker}` goes.
- The page-level `s-modal id={CHANGE_WORKFLOW_MODAL}` becomes:
  - `heading="Change workflow?"` (unchanged).
  - An `s-select` (label "Workflow", `labelAccessibilityVisibility` default so the label shows) with `changing.options`, value `changing.workflowId ?? ""`, placeholder "Choose workflow". `onChange` updates `changing.workflowId`.
  - An `s-paragraph` under it. Text: while no pick, `""`. Once picked, if the run is touched (`tasks.some(startedAt !== null || completedAt !== null)`), `changeWarning(from, toName, tasks)`; else nothing. Extend `changeWarning` to take `hasNote: boolean` and end with "That work and the note will not carry over." when true, "That work will not carry over." otherwise. Update its JSDoc with the note clause and why (the note is a run column; `insertRun` does not copy it; the merchant should hear that before Change, not after).
  - Secondary button: `Keep ${changing.from}` (unchanged), `command="--hide"`, `onClick` sets `changing` to null.
  - Primary: `variant="primary" tone="critical"`, label "Change workflow", `disabled` while `!identified || busy || changing === null || changing.workflowId === null`, `onClick` mutates `attachMutation` with `{ lineItemId, workflowId }`.
  - `onAfterHide` (or the pattern `RunTextModals.tsx` uses for its reset) clears `changing` so a backdrop dismiss does not leave state behind.
- `attachMutation.onSuccess`: remove the `setChangeOpen` block. Keep `setChanging(null)` and `hideModal(CHANGE_WORKFLOW_MODAL)`. Keep the `setAttachChoice` clear (the at-rest picker for this item may have a stale pick if the merchant started, then the run was cancelled elsewhere).
- Untouched run: the modal still shows, with the select and no warning paragraph. The research accepted one extra click here in exchange for one shape.

JSDoc to align:

- The `changing` state comment: it now describes the whole modal's content, not only the confirmation.
- `renderLineItem`'s JSDoc bullet "a live run — a change… lives inside Manage (`changeOpen`)": replace `changeOpen` with the modal, and add that the change is the one write on this page that cannot be undone (the replaced run stays cancelled and cannot be un-cancelled while the new one holds the item), which is why its submit is the page's one red button.
- The `CHANGE_WORKFLOW_MODAL` constant comment "The one confirmation on this page: replacing a live run that has work on it" becomes "The one modal that both asks and confirms: the select and, on a touched run, the warning."
- The `s-modal` comment "One modal for the page, driven by `changing`" stays true; extend it to say the select lives in the modal because an inline picker persisted per run and dangled across navigation.

### 7. Tests

`e2e/orders.spec.ts`, the test "the merchant blocks a run with a reason, edits it, notes the run, and unblocks it":

- `frame.getByText("Blocked · Cut", { exact: true })` → assert the banner: `frame.locator('s-banner[heading="Blocked"]')` visible, and `frame.getByText("Step 1 of 1 · Cut")` (or whatever `nowLine` prints for a one-task run; read `nowLine` and match) visible, proving the Now line renders while blocked.
- `frame.getByText("Blocked by Merchant")` (three occurrences) → `frame.locator('s-banner[heading="Blocked"]').getByText("Merchant", { exact: false })`, and the final hidden check on the banner locator.
- `Add note` click → the card's `Edit` for the note. There are now two `Edit` buttons on a blocked run's card (banner reason, note). Scope them: banner Edit via the banner locator, note Edit via a locator on the note block (e.g. `frame.locator("s-stack#note")` if the shared component keeps that id, or `getByRole("button", { name: "Edit" }).nth(1)` with a comment). Prefer giving `RunNote`'s root an `id="note"` only on the member page as today; on the order page several runs would collide, so use a `data-testid`-free approach: locate the note's placeholder text `getByText("Note", { exact: true })` and go to its sibling button.
- Assert the blank state first: subdued "Note" text visible before the edit, replaced by the note text after.
- Remove the `Add note` count-zero assertion; assert `Add note` never exists.
- `frame.getByRole("button", { name: "Unblock" }).first()` → drop `.first()` and add `toHaveCount(1)` before the click: one Unblock on the page is now the rule.
- Also assert the Manage row has no `tone="critical"` buttons: `frame.locator('s-button[tone="critical"]')` count 0 while no modal is open. Decide whether this is worth a line; it is the test whose title is the rule "no red in the Manage row".
- Update the test's JSDoc to the new shape.

`e2e/orders.spec.ts`, the change-workflow test (around line 595):

- After `change.click()`, the select is in the modal: `const changeModal = frame.locator("s-modal#change-workflow")`. Select via `changeModal.getByRole("combobox", { name: "Workflow" })`.
- The submit is `changeModal.getByRole("button", { name: "Change workflow", exact: true })`.
- For the untouched run in this test, assert the warning paragraph is empty or absent before submitting.
- The gate "picker going" becomes "modal hidden": wait for the modal to be hidden, then `manage` visible.
- Update the comment block that explains `managing` and `changeOpen`.

Add one e2e assertion for the touched-run path if a fixture already has a run with a started task and a note (check `e2e/fixture.ts` around the "four items in four states" seed): open Change workflow, pick, assert the paragraph ends "and the note will not carry over." If no such fixture is convenient, add the `hasNote` case to a unit test of `changeWarning` instead: export it from the route module is not possible cleanly, so move `changeWarning` to `src/lib/WorkflowLayout.ts` or a new `src/lib/changeWarning.ts` and unit-test it in `test/integration/`. Title the test with the rule: "the change warning names the note when the run has one".

Member specs: `e2e/member-runs.member.spec.ts` asserts `note.locator('s-text[color="subdued"]').getByText("Note")` and the modal. `RunNote` keeps that markup, so they should pass unchanged. Run the member project to confirm.

### 8. Verify in the browser

Use `pnpm app:dev` and either `pnpm playwright-cli` or the Chrome MCP tools. Seed with `pnpm seed`, or use the e2e fixture with the 20-task workflow. Check, on a blocked in-progress run:

- Red badge, red banner, "Merchant · <time>", Edit and Unblock on one line inside the banner.
- Now line present under the banner.
- Note block with subdued "Note" and Edit on an empty note; after saving, the text with line breaks preserved.
- Manage open: step cards, then `[Block]` absent while blocked, `[Cancel run] [Change workflow]` plain.
- Change workflow opens the modal; picking a workflow on a touched run shows the warning; Keep closes and clears; reopening shows no leftover pick.
- Two runs' Manage open at once: nothing dangles under either.
- Member run page unchanged: note block and Blocked banner look as before.

Take screenshots at desktop width and at phone width (the banner and its two buttons must not overflow).

### 9. Finish

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e -- e2e/orders.spec.ts`, then the member project.
- `pnpm fmt`, keep every file it touches.
- Do not commit.

## JSDoc alignment checklist

Every symbol below has a JSDoc that states a rule the change breaks. Each must be rewritten, not patched, so the reasoning is inline and no sentence describes the old behaviour.

| Symbol                              | File                                    | What changes                                                              |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `flagLabel`                         | `app.orders.$orderId.tsx`               | Tone comes from `flagTone`; reason the strip is gone.                     |
| `blockedLine`, `blockedStrip`       | `app.orders.$orderId.tsx`               | Deleted.                                                                  |
| `nowLine`                           | `app.orders.$orderId.tsx`               | Renders while blocked; why.                                               |
| `unblockButton`                     | `app.orders.$orderId.tsx`               | One site, the banner.                                                     |
| `editReasonButton`                  | `app.orders.$orderId.tsx`               | "banner" not "strip".                                                     |
| `noteBlock`                         | `app.orders.$orderId.tsx`               | Deleted; `RunNote` carries the rule.                                      |
| `manageRows`                        | `app.orders.$orderId.tsx`               | Row is Block, Cancel run, Change workflow; no red; no note; second param. |
| `renderRun`                         | `app.orders.$orderId.tsx`               | Mentions banner, Now line, `RunNote`.                                     |
| `changeOpen`, `changingRun`         | `app.orders.$orderId.tsx`               | Deleted.                                                                  |
| `changing`                          | `app.orders.$orderId.tsx`               | Holds the modal's select state.                                           |
| `CHANGE_WORKFLOW_MODAL`             | `app.orders.$orderId.tsx`               | Asks and confirms.                                                        |
| `changeWarning`                     | `app.orders.$orderId.tsx` or `src/lib/` | Note clause.                                                              |
| `workflowPicker`                    | `app.orders.$orderId.tsx`               | One place, at rest.                                                       |
| `renderLineItem`                    | `app.orders.$orderId.tsx`               | Live-run bullet names the modal and why its submit is red.                |
| `FlagBanner`                        | `MemberRun.tsx`                         | Both pages; order page passes actions.                                    |
| `RunNote`                           | `MemberRun.tsx`                         | New; the note rule lives here.                                            |
| Member note comment                 | `shop.$shop.workflows.$runId.tsx`       | Trimmed to what `RunNote` does not say.                                   |
| Block test JSDoc, change test JSDoc | `e2e/orders.spec.ts`                    | New shapes.                                                               |

`scripts/rules-lint.ts` refuses inline status predicates in routes; keep using `Domain.runIsBlocked`, `Domain.runIsLive`, `Domain.runIsOpen`.

## Deviations and issues

Record here anything done differently from the steps above, anything that did not work, and anything found along the way that is out of scope. One entry per item: what, why, and what was done instead.

- **Now line on a parallel step (step 3 check).** It listed every ready task's name, so a step of three 60-character tasks ran to four lines. The first attempt joined distinct names, which did nothing for the seeded run: its names carry position prefixes ("2. Condition…", "3. Condition…") and are all distinct. `nowLine` now prints the first ready task's name and a count: `Step 2 of 18 · 2. Condition… and 2 more`. Not blocked-specific: the unblocked card had the same problem.
- **Banner buttons (step 2 check).** Edit and Unblock rendered flush against each other in the banner body. Wrapped in `<s-stack direction="inline" gap="small-300">` on the order page, as the plan allowed.
- **Note block (step 5).** Rendered without the subdued `s-box`; at desktop and phone width the `Note [Edit]` row reads as a field on the card, so no box and no comment.
- **`changeWarning` (step 7).** Moved to `src/lib/changeWarning.ts` and unit-tested in `test/integration/change-warning.test.ts` instead of an e2e assertion: the e2e seed has no run-note option. The touched-run path with a note was checked in the browser (warning ends "That work and the note will not carry over.").
- **`changing` state (step 6).** Also holds `hasNote`, read from the live run when the modal opens, so the warning needs no second lookup. The `Change workflow` button in the Manage row gained `disabled={!identified || busy}`, like every other button there.
- **No red in the Manage row (step 7).** The assertion is scoped to the item's `s-section`, not the frame: the page-level modals (Block, Change workflow) carry red submits that are always in the DOM.
- **Member run page (step 8).** Not screenshotted; the member e2e project (29 tests, including the note block's markup) passed unchanged.
- **Review (2026-09-24).** The `manageRows` JSDoc had a duplicated, truncated first line from a bad edit; rewritten. The Keep button cleared `changing` on click while `onAfterHide` cleared it again, so the label flipped to "Cancel" during the close animation; `onAfterHide` is now the one reset. Browser check at desktop and phone width on the seeded order 1030 (blocked run, banner with Edit and Unblock on one line, Now line, blank Note with Edit, plain Manage row, change modal with warning, Keep leaves no pick): matches the target render.
