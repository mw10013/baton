# Implementation plan: Flow lifecycle patterns in Baton, and non-unique workflow names

Date: 2026-09-17. Source: `shopify-flow-patterns-for-baton-research.md` (accepted). This plan is
written for an implementing LLM. It names files, functions and copy exactly; where it says
"decide", the choice is yours and goes in the Deviations section at the end.

Ground rules from `CLAUDE.md` apply: Effect idioms, JSDoc for reasoning the code cannot show and
never a reference to `docs/`, `pnpm typecheck` + `pnpm lint` + `pnpm fmt` after code, keep every
file `fmt` touches, no commits unless told.

---

## 0. Scope and order

Two independent changes. Do them as two passes in this order, running the test suite between:

- **Pass A — names are labels.** Drop name uniqueness end to end.
- **Pass B — Flow chrome.** Badge-as-state, button sets, activation from the editor, tab labels,
  dialog copy, `Inactive`, autosave line, never-applied state.

Out of scope: version history, Add note, Export/Import/Manage tags, moving the editor panel to
the left, AI create, templates.

Vocabulary rules that already exist in the JSDoc on `Domain.Workflow` (`src/lib/Domain.ts`)
still hold: never use "version", "live", "saved" (as a state noun), "published", "route",
"pause", "product tag" for the workflow's field. Flow's `Active workflow` / `Saved workflow`
tab naming is not adopted at all: the detail page has no tabs (B4). "Saved" appears only in the
editor's autosave footer (B6).

Decided 2026-09-17: no text that restates what a badge or button already shows (B4a).

---

## Pass A — Names are labels

### A1. Schema: drop the unique index

File: `src/lib/ShopAgent.ts`, `initializeSchema`.

Delete the two lines

```sql
create unique index if not exists Workflow_name_uidx
  on Workflow (name collate nocase);
```

inline. No second migration: the app is still prototyping and every database is reset from
scratch on the next dev restart. Keep the `Workflow` `create table` otherwise unchanged,
including the `check` on a trimmed non-empty name. Add no replacement index: the list sorts by
name over at most `WorkflowLimits.maxWorkflows` rows.

### A2. Repository: remove the name check

File: `src/lib/WorkflowRepository.ts`.

- Delete `WorkflowNameTakenError` (class near line 32) and every `| WorkflowNameTakenError` in the
  service interface (`createWorkflow`, `duplicateWorkflow`, `updateWorkflow` around lines
  215–250).
- Delete `requireNameFree` (around line 836) and its three call sites in `createWorkflow`,
  `duplicateWorkflow`, `updateWorkflow`. Keep `requireTagFree` and `decodeHolders` (the latter is
  still used by `requireTagFree`; if it becomes unused, delete it).
- Rewrite the JSDoc on `createWorkflow` ("The name and the tag are each asked about…") to say the
  tag is the one key that is checked, and why the check exists in addition to the `unique`
  constraint (so the refusal names the holder).
- Rewrite the JSDoc on `updateWorkflow` ("The rename excludes the workflow's own row…") to say a
  rename is unconditional.
- Leave `order by w.name collate nocase` / `order by name collate nocase` in the list queries;
  that is sort collation, not uniqueness.

### A3. ShopAgent: remove the result mapping

File: `src/lib/ShopAgent.ts`, the `workflowResult` helper around line 640.

- Remove `WorkflowNameTakenError` from the error union and from `Effect.catchTags`.
- The import of `WorkflowNameTakenError` from `WorkflowRepository` goes.

### A4. Domain

File: `src/lib/Domain.ts`.

- `WorkflowResult`: remove the `NameTaken` member.
- Rewrite the JSDoc on `WorkflowResult` ("…loses the tag the page needs to put "name taken" on the
  field…") so the example is the tag, not the name.
- In the big `Workflow` JSDoc, replace the sentence _"The name is freed at once, so uniqueness is
  among existing rows only."_ with a sentence stating the model: the id is identity, the tag is
  the one unique key, the name is a label two workflows may share, and everything that shows a
  workflow to the merchant outside its own page shows the tag beside the name.
- `WorkflowName` stays: trimmed, non-empty, max 64. Keep the `"Same shape and reasoning as
TeamName"` JSDoc, but note there that unlike `TeamName` it is not unique.
- `CreateWorkflowInput`: `name` stays required (see A6 for why the modal still has the field).

### A5. Shared copy

File: `src/lib/workflowShared.ts`.

- Delete `copyName` and `MAX_NAME_LENGTH` and the JSDoc on the collation.
- Add a replacement that needs no taken list:

```ts
/**
 * The Duplicate dialog's prefilled name. Names may repeat, so there is no
 * search for a free one: `<name> copy`, trimmed so the result fits
 * `Domain.WorkflowName`.
 */
export const copyName = (name: string): string => {
  const suffix = " copy";
  return `${name.slice(0, 64 - suffix.length).trimEnd()}${suffix}`;
};
```

Use the same 64 the schema uses; if there is a constant for it in `Domain`, use that instead of
the literal.

- `workflowResultMessage`: remove the `NameTaken` branch.
- `tagTakenMessage`: keep the shape, but since the holder's name is no longer unique, the
  message must let the merchant find the holder. Change the `WorkflowResult.TagTaken` member to
  carry `workflowId` as well (`Domain`, the repository's `WorkflowTagTakenError`, and the
  `workflowResult` mapping in `ShopAgent`), and render the message with a link where it is
  shown under a text field. Polaris text fields take `error` as a string, so a link cannot go in
  the field error. Decide between: (a) keep the string message and add a second element under
  the field (`<s-link href={`/app/workflows/${workflowId}`}>Open <name></s-link>`) when
  `TagTaken` is the result; (b) leave the message text-only. Prefer (a). Record the choice.

### A6. Routes

`src/routes/app.workflows.index.tsx` (Create modal):

- `createMutation.onSuccess`: the `result._tag !== "Ok"` branch that called `setNameError` now
  covers only `Limit` and `NotFound`; route those to `setBanner`. Remove `nameError` state and
  the `error` prop on the Name field if nothing else sets it.
- Keep the Name field required and prefilled-empty. Rationale for keeping it, to put in the
  component JSDoc: the tag mirrors the name as the merchant types, so the name field is how most
  merchants will produce the tag; dropping it would make the tag field the only field and lose
  the mirror. This deviates from Flow's no-name create on purpose.
- Delete the comment "A workflow has two unique keys, so the refusal goes under the field the
  merchant typed…" and replace with one that says only the tag can collide.

`src/routes/app.workflows.$workflowId.tsx` (Rename, Duplicate):

- `renameMutation.onSuccess`: `workflowResultMessage` can now only return `Limit`/`NotFound`
  text, which do not belong under the field. Route non-`Ok` to `setBanner`; remove `nameError`.
- `duplicateMutation.onSuccess`: remove the `NameTaken` branch and `copyNameError`.
- `seedDuplicateForm`: `copyName(detail.workflow.name)` with the new signature.
- Remove the comment "Routed by `_tag` rather than into the banner: the copy has two keys…" and
  say only the tag can collide.

`src/routes/app.workflows.$workflowId_.edit.tsx` (Rename):

- Same treatment as the detail page's rename.

### A7. Places that show a name as an identifier

Add the tag beside the name where a workflow is named outside its own page and a merchant could
be looking at two with the same name:

- `src/components/UsedByCard.tsx` line ~39 (`{workflow.workflowName}` link): append a
  `<s-badge>{tag}</s-badge>` if the row has a tag; if the row type lacks it, add `workflowTag`
  to the query that produces it (`WorkflowRepository` `usedBy`-style queries around lines
  1600–1650 select `workflowName`; add `w.tag as workflowTag`). Same for
  `src/routes/app.teams.index.tsx` line ~203.
- Runs snapshot `workflowName` only (`WorkflowRun` has no tag column; verified 2026-09-17). Do
  **not** add one in this pass. A run's page already links to its order, and the order page
  lists the run under its line item, so the ambiguity is bounded. Record in Deviations as a
  follow-up: snapshot `workflowTag` on `WorkflowRun` and show it in
  `app.orders.$orderId.tsx` (~1237) and `shop.$shop.work.$runId.tsx` (~465).

### A8. Tests

- `test/integration/shop-agent-workflows.test.ts` ~line 261: the `NameTaken` assertion becomes:
  creating `{ name: "w", tag: "dupe" }` succeeds (`_tag: "Ok"`), and `listWorkflows()` returns
  two rows. Adjust the `list.map(...)` expectation accordingly. Keep the `TagTaken` assertion.
- `test/integration/workflow-repository.test.ts`: lines ~104, ~161, ~696, ~769 assert
  `WorkflowNameTakenError`; each becomes a success assertion, or is deleted where the test's
  only point was the name collision. The `describe("copyName")` block (~816) shrinks to: plain
  suffix; long-name truncation still fits 64.
- Add one repository test: two workflows with the same name and different tags coexist, rename
  to an existing name succeeds, duplicate with the same name succeeds.
- `e2e/workflows.spec.ts` ~406: the prefilled Duplicate name is still `${SOURCE} copy`; no change
  unless the spec relied on collision.

### A9. Seed

`src/routes/api.dev.seed.ts`: if the seed asserts unique names, relax it. Read it.

---

## Pass B — Flow chrome

### B1. Derived state helpers

File: `src/lib/workflowShared.ts`. Add:

```ts
/**
 * A workflow that has never been applied has no steps of its own: Apply is
 * the only writer of `WorkflowStep`, and a fresh workflow starts with none
 * (the JSDoc on `Domain.Workflow`). Zero steps after the first Apply is
 * impossible, since Apply refuses an empty draft.
 */
export const neverApplied = (detail: { readonly steps: readonly unknown[] }) =>
  detail.steps.length === 0;
```

Verify the claim against `WorkflowRepository.applyDraft` (`NoStepsError`) before writing it.

### B2. Editor header (`app.workflows.$workflowId_.edit.tsx`)

Replace the fixed `Draft` badge and the disabled Apply with the state matrix:

| Condition                      | Accessory badge | Header controls, left → right                                                     |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------- |
| `neverApplied`                 | `Draft` (info)  | More actions · **Turn on** (primary)                                              |
| applied, active, `!hasDraft`   | none            | More actions · **Turn off** (primary, `tone="critical"`)                          |
| applied, inactive, `!hasDraft` | none            | More actions · **Turn on** (primary)                                              |
| `hasDraft` (and applied)       | `Draft` (info)  | More actions · Discard changes (secondary, no tone) · **Apply changes** (primary) |

Implementation notes:

- `hasDraft` already exists. For the never-applied row, the editor writes into a draft that
  always exists once a step is added, so `hasDraft` will be true there too; the `neverApplied`
  check must come first.
- **Turn on in the never-applied state applies and activates in one step.** Add a `ShopAgent`
  RPC `applyAndActivate({ workflowId, activatedAt? })` that runs `applyDraft` then
  `setWorkflowActive({ active: true })` inside one transaction path, returning
  `Domain.ActivateResult` (extend the union with `NoDraft` if needed, or reuse `ApplyResult`'s
  failures; decide and record). Alternatively call the two existing RPCs in sequence from the
  client; that leaves a window where the workflow is applied but off if the second call fails.
  Prefer the server-side composite.
- Move `WorkflowSwitch` into the editor as well. It renders into `slot="secondary-actions"`
  today; add a `slot` prop (`"primary-action" | "secondary-actions"`) and a `tone` for Turn off.
  The editor passes `slot="primary-action"`. On the detail page it also becomes the primary (B3).
- The Turn on dialog in the editor is the same `WorkflowSwitch` dialog (tag rule + Include them).
  For the never-applied case, pass a prop `appliesFirst: true` so the mutation calls
  `applyAndActivate` and the dialog body gets a second sentence: _"Your steps are applied at
  the same time."_
- Modals in the editor must hide via `hideModal`, not `shopify.modal.hide` (existing JSDoc on the
  component explains why). `WorkflowSwitch` currently uses `shopify.modal.hide`; add an
  `onHideModal` injection or detect `inWindow`. Decide; record.
- Remove the pre-emptive blocker banner? **No.** Keep `applyBlocker` and `turnOnBlocker` (the
  research keeps pre-emptive validation). Change the banner body to imperative bullets:
  `NoSteps` → _"Add a step to this workflow."_; `StepUnassigned` → _"Assign a team to <names>."_.
  Update `applyResultMessage` and `activateResultMessage` accordingly. When a blocker exists the
  primary button stays disabled, as today.
- Discard changes loses `tone="critical"` in the header; the dialog's confirm keeps it.
- Delete the comment _"Always "Draft": the editor only ever writes to the draft…"_.

Dialog copy in the editor:

- Apply (only when active; unchanged rule):
  heading `Apply changes?`, body **`This workflow is turned on. Once you apply changes, they'll
take effect immediately. Runs already open keep the steps they started with.`**, buttons
  `Cancel` · `Apply`. The third sentence is Baton's and stays; it is true and Flow's body has no
  equivalent.
- Discard: heading `Discard changes?`, body **`Are you sure you want to discard these changes?`**,
  buttons `Cancel` · `Discard` (critical). Drop the current body's "This can't be undone."
- Rename: heading `Rename workflow`, field label **`New name`**, add a live counter. Polaris
  `s-text-field` has no built-in counter; render `<s-text color="subdued">{n}/64</s-text>` under
  the field. Toast on success **`Workflow renamed`** (there is none today).
- Delete: heading `Delete <name>?` (unchanged), body **`This workflow will be permanently deleted.
Runs already on orders are kept.`** Put it in `DELETE_WORKFLOW_WARNING` and update its JSDoc.
  Toast **`Workflow deleted`** on the page that survives (the list, or the detail page's
  `onDeleted`).

More actions order in the editor: Rename · Delete (unchanged). Delete stays critical and last.

### B3. Detail header (`app.workflows.$workflowId.tsx`)

- Order: `Edit` (secondary, icon edit) · `More actions` · **Turn on / Turn off** (primary).
  `Edit` moves from `slot="primary-action"` to `slot="secondary-actions"`; `WorkflowSwitch` takes
  `slot="primary-action"`.
- Turn off: `variant="primary" tone="critical"`, and it now **confirms**. Add a `TURN_OFF_MODAL`
  to `WorkflowSwitch`: heading `Turn off workflow?`, body **`New orders won't start this workflow.
Runs already in progress keep going.`**, buttons `Cancel` · `Turn off` (primary, no tone).
  Keep the existing toast logic after success.
- Never-applied workflow on the detail page: no activation button at all (there is nothing to
  turn on; Flow's overview shows `Turn on` here because Flow's Turn on applies too — Baton's
  editor is where the composite lives). Show the `Draft` accessory badge in place of
  `Active`/`Inactive`, and change the "No steps yet. Edit to add some." footer to _"No steps
  yet. Edit to add some, then turn it on from the editor."_
- Inactive + draft: hide the Turn on button (Flow's asymmetry). Active + draft: keep Turn off.
- Status accessory: `Active` (success) / **`Inactive`** (default), plus `Draft` (info) whenever
  `draft !== null` or the workflow is never-applied. The `Draft` badge is the only signal that
  unapplied changes exist; there is no banner or sentence saying so (Flow's overview has none
  either). Tag badge stays.
- More actions order: Rename · Duplicate · Delete (unchanged; also make the editor's match by
  adding nothing — the editor has no Duplicate).
- Rename and Delete dialogs: same copy as B2. Duplicate dialog: leave, except the prefilled name
  comes from the new `copyName`.

### B4. Detail body: no tabs

Remove the Live/Draft tab pair and everything that supported it:

- `validateSearch` and the `tab` search param; `showingDraft`, `shownSteps`, `tabButton`.
- The Draft-tab info banner (_"Not running yet…"_).
- The `StageFlow` always renders `steps` (the workflow's own). The draft is read only in the
  editor.
- Rewrite the component JSDoc: the page shows what is in force; a `Draft` badge says the editor
  holds unapplied changes; the editor, one click away, is where they are read, applied or
  discarded.
- Move `Last updated on …` out of the card: a subdued paragraph directly under the header,
  before the `<s-section>`. Keep `AppliesSince` inside the card.
- `WorkflowDetailView` / `getWorkflowDetail` still return `draft` (the editor needs it and
  `hasDraft` drives the badge); do not change the RPC.

### B4a. Remove explanatory prose

Text that echoes what a control or badge already shows comes out. Flow has none of it.

| Surface                           | Remove                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index (`app.workflows.index.tsx`) | The intro paragraph above the table (_"Each one is the ordered list of steps…"_). In the empty state keep the heading and Create button, drop the paragraph.                                                                                                                                                |
| Detail                            | The _"No steps yet…"_ footer; the Draft-tab banner (gone with B4).                                                                                                                                                                                                                                          |
| Editor aside                      | The two placeholder paragraphs when no step is selected. Render the `slot="aside"` section only when `selected !== null`. Check that `s-page` lays out correctly without the aside; if the canvas width jumps when a step is selected, keep an empty aside section with no text instead. Record the choice. |

Keep: Turn on dialog body (tag rule, waiting-orders line), blocker banners (which steps lack a
team, imperative form per B2), Delete body, `AttentionBanner`, result-message banners.

### B5. Index (`app.workflows.index.tsx`)

- `statusBadges`: `Off` → **`Inactive`**. Keep `Draft`, `No steps`, `Needs attention`. For a
  never-applied workflow (`stepCount === 0`), show `Draft` and `No steps` as today; do not add a
  fourth state.
- Filter pills: `All` / `Active` / **`Inactive`**. The search param value `off` may stay as the
  URL token or become `inactive`; if changed, `validateSearch` must still accept nothing else.
  Prefer `inactive` and record.
- e2e `e2e/workflows.spec.ts` ~432 asserts `Off`; update to `Inactive`.

### B6. Autosave line in the editor

Add a footer under the canvas: **`✓ Saved · Last changed on <LocalDateTime value={draft?.updatedAt ?? workflow.updatedAt} />`**, and while any step mutation `isPending`, **`Saving…`**
instead. `busy` already aggregates the pending flags. Use `<s-text color="subdued">`.

### B7. Copy table (single source)

Put every dialog string below in `src/lib/workflowShared.ts` as exported constants so the two
surfaces cannot drift (the research notes Flow's own copy drifts between surfaces):

| Constant                  | Value                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `APPLY_HEADING`           | `Apply changes?`                                                                                                                           |
| `APPLY_BODY`              | `This workflow is turned on. Once you apply changes, they'll take effect immediately. Runs already open keep the steps they started with.` |
| `DISCARD_HEADING`         | `Discard changes?`                                                                                                                         |
| `DISCARD_BODY`            | `Are you sure you want to discard these changes?`                                                                                          |
| `TURN_OFF_HEADING`        | `Turn off workflow?`                                                                                                                       |
| `TURN_OFF_BODY`           | `New orders won't start this workflow. Runs already in progress keep going.`                                                               |
| `RENAME_HEADING`          | `Rename workflow`                                                                                                                          |
| `RENAME_FIELD_LABEL`      | `New name`                                                                                                                                 |
| `RENAMED_TOAST`           | `Workflow renamed`                                                                                                                         |
| `DELETE_WORKFLOW_WARNING` | `This workflow will be permanently deleted. Runs already on orders are kept.`                                                              |
| `DELETED_TOAST`           | `Workflow deleted`                                                                                                                         |
| `STATUS_ACTIVE`           | `Active`                                                                                                                                   |
| `STATUS_INACTIVE`         | `Inactive`                                                                                                                                 |

Dismiss verb is `Cancel` everywhere. Sentence case everywhere.

### B8. Tests for Pass B

- `e2e/workflows.spec.ts`: the lifecycle test (~lines 140–260) asserts the `Draft` tab button
  and `Live workflow`; replace with assertions on the `Draft` accessory badge appearing and
  disappearing. Add: a fresh workflow's editor shows `Turn
on` and no `Apply changes`; after adding a step and clicking Turn on (confirm), the detail
  page shows `Active` and the `Draft` badge is gone. Add: Turn off now confirms.
- `test/integration/shop-agent-workflows.test.ts`: add a test for `applyAndActivate` covering
  the happy path and `NoSteps`.
- Update any assertion on `Off`.

### B9. Order of work inside Pass B

1. B7 constants and B1 helper.
2. `WorkflowSwitch` changes (slot/tone props, Turn off modal, `appliesFirst`, hide-modal
   injection) plus the `applyAndActivate` RPC and its test.
3. B3, B4, B5 (detail and index).
4. B2 (editor) and B6.
5. B8 e2e, then `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt`.

---

## Acceptance checklist

- [ ] Two workflows with the same name and different tags can be created, renamed to each
      other's name, and duplicated with the source's name. No `NameTaken` anywhere in `src/`.
- [ ] `Workflow_name_uidx` no longer appears in `initializeSchema`.
- [ ] Clean editor: no `Draft` badge, no `Apply changes`, `Turn on`/`Turn off` present.
- [ ] Dirty editor: `Draft` badge, `Discard changes` (plain) · `Apply changes`, no activation
      control.
- [ ] Never-applied editor: `Draft` badge, `Turn on` applies and activates in one confirmed step.
- [ ] Detail: `Edit · More actions · Turn on/off`, Turn off is red and confirms.
- [ ] Inactive + draft on detail: no Turn on button.
- [ ] Detail page has no tabs; a `Draft` badge is the only draft signal. No intro or empty-state
      prose on index, detail, or the editor aside.
- [ ] Index and detail say `Inactive`, never `Off`.
- [ ] Rename shows `New name`, a counter, and toasts `Workflow renamed`.
- [ ] Delete body names what survives and toasts `Workflow deleted`.
- [ ] Editor footer shows `Saved · Last changed on …` and `Saving…` mid-write.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e --` pass; `pnpm fmt` run.

---

## Deviations

Implemented 2026-09-17. `pnpm typecheck`, `pnpm lint`, `pnpm test` (309 passing) and `pnpm fmt`
all run clean, and `npm run test:e2e --` passes (31 tests).

- **A5 `TagTaken` presentation (link vs text): (a), the link.** `WorkflowResult.TagTaken`,
  `WorkflowTagTakenError` and `requireTagFree` all carry `workflowId` now, and a shared
  `WorkflowTag.TagTakenLink` renders `Open <name>` under the field on all three surfaces
  (Create, Duplicate, Edit tag). The message text is unchanged.
- **A7 run snapshot of the tag: follow-up, not done.** `WorkflowRun` still snapshots
  `workflowName` only. Follow-up: add a `workflowTag` column, snapshot it at run start, and show
  it in `app.orders.$orderId.tsx` and `shop.$shop.work.$runId.tsx`. Done in this pass:
  `Domain.OwnedStep` gained `workflowTag`, both owned-step queries select `w.tag`, and
  `UsedByCard` and the teams index show it beside the name.
- **B2 `applyAndActivate` result type and composite vs sequential: server-side composite,
  returning `Domain.ActivateResult` unchanged.** No `NoDraft` member was needed: the repository
  method promotes a draft _if one exists_ and then applies the ordinary startable check, so a
  workflow with no draft and no steps comes back `NoSteps`, which is the true answer. The Apply
  write itself moved into a shared `promoteDraft` helper that `applyDraft` and `applyAndActivate`
  both call inside their own transaction.
- **B2 modal hiding inside the window: `hideModal` unconditionally.** No prop injection and no
  `inWindow` detection — `hideModal` goes through the element's own `hideOverlay`, which works on
  both surfaces (its JSDoc says so), so `WorkflowSwitch` simply never calls `shopify.modal.hide`.
- **B4a editor aside when no step is selected: an empty `s-box`, not hidden.** Hiding it was tried
  first and measured in the browser (2026-09-17): `s-page` gives the aside a column only while the
  slot is filled, so the canvas reflowed 934px → 606px on every card click. Keeping an empty
  `s-section` holds the column but draws a card with nothing in it, so the placeholder is a bare
  `<s-box slot="aside" />`; the canvas stays 606px in both states and nothing is drawn. The
  explanatory paragraphs are gone either way.
- **B5 URL token for the inactive filter: `inactive`.** `validateSearch` accepts `active` and
  `inactive` and nothing else.
- **B3 vs B4a, the detail page's "No steps yet" footer: removed.** B3 asked for it to be reworded
  ("…then turn it on from the editor"), B4a's table and the acceptance checklist ask for it to go.
  The checklist wins, so a never-applied workflow's detail page carries no footer prose; the
  `Draft` badge and the `Edit` button are the whole signal.
- **`turnOnBody` moved into `workflowShared.ts`.** The editor needs the same sentence the detail
  page had inline, and the plan's own rule is that neither surface restates the rule in its own
  words.
- **`Domain.NAME_MAX_LENGTH` added.** The plan asked `copyName` to use a constant if one existed;
  none did, so the 64 in `trimmedName`, every name field's `maxLength`, the rename counter and
  `copyName` now read one exported constant.
- **Editor blocker banner heading forks.** `applyBlocker` still drives one banner, but its heading
  is "Turn on is unavailable" while the header offers Turn on and "Not ready to apply" while it
  offers Apply, so the banner never names a button that is not on screen.
- **e2e asserts the button set, not the `Draft` badge (B8).** App Bridge hoists accessory badges
  into admin chrome, which is not ours to locate; the presence of `Discard changes` /
  `Apply changes` versus `Turn on` / `Turn off` is the same fact and is what the merchant acts on.
  The lifecycle spec was also stale against commit `a1cfce1` (it still looked for
  "Nothing is saved yet.", "Save step", "Remove step" and "Stage 1 · at the same time"), so it was
  rewritten against the current editor rather than patched.
- **Blocker banner bodies wrapped in `s-paragraph`.** Both blocker banners passed a bare string as
  the `s-banner` child, and the banner renders its body from elements — the text never reached the
  page. This was pre-existing on the detail page and invisible because nothing asserted it; the
  editor's e2e assertion caught it. `AttentionBanner` already wrapped its lines, which is what the
  two now match.
- **A9 seed: no change needed.** `api.dev.seed.ts` never asserted unique names;
  `replaceWorkflows` bypassed the name check already and its JSDoc now says "limit and team
  checks".
- **Editor blocker banner hidden for an active workflow with no draft** (review, 2026-09-17). The
  banner was gated on `blocker !== null` alone, so an active workflow whose step lost its team
  showed "Turn on is unavailable" beside a Turn off button. It now also requires that the header
  offer Turn on or Apply; on the active-no-draft path `AttentionBanner` already reports the
  unassigned steps.
- **`applyAndActivate` checks startability twice when a draft exists: left as is.** The check
  inside `promoteDraft` is what keeps the helper safe for `applyDraft` on its own, and the check
  after it is the one that decides on the no-draft path. Removing either makes the two callers
  diverge, which the shared helper exists to prevent; the cost is one query per Turn on.
