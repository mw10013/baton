# Order item workflow card: implementation plan

Status 2026-09-16: **done**, all six phases, with five deviations recorded under
"Deviations" at the foot of this document. The reasoning and every product decision are in
[`docs/order-item-workflow-ux-research.md`](./order-item-workflow-ux-research.md); its
Decisions list, "The card" section, and "Answered in review" section are binding. This
document is the order of work. It is disposable once the code is in and any deviations are
folded back into the research doc. Line cites are as of commit `e0502ae`; re-grep if they
have drifted. Mockups: `docs/order-item-workflow-ux/mockups.html`.

## What changes, in one paragraph

One file carries almost all of it: `src/routes/app.orders.$orderId.tsx`. The page stops
rendering the production state badge and the two `supplemental-start` paragraphs. Each line
item card gets a custom header row with the title and, when the item has a live run, a
secondary `Manage` button with a flipping chevron. The run row keeps the workflow name and
gets a merchant-word status badge. The inline step trail is deleted from the card and replaced
by one Now line that starts with `Step N of M`. The unassigned-step and empty-team attention
rows survive under the Now line. `Change workflow` moves into the Manage disclosure. An item
with no live run shows the select and a `Start` button at rest, with product tags as plain
text on that row and no "No workflow on this item." sentence. Every merchant-facing "attach"
becomes "start". No domain, SQL, or GraphQL change. Two e2e specs change with the copy.

## Ground rules for this work

- **Copy only for the verb.** `AttachResult`, `attachMutation`, `attachOpen`,
  `ShopAgent.attachWorkflow` and every identifier keep `attach`. Only strings the merchant
  reads change.
- **Vocabulary.** The workflow is _started on_ an item, never on an order. Status badges
  say `Not started`, `In progress`, `Done`, `Cancelled`. The Now line says `Step`, never
  `Stage`, even though the count is of stages: see 3.3.
- **Polaris web components only**, `s-*` tags as the file already uses. `s-section` has
  no header action slot; the header is built by hand (3.1). Buttons the merchant must find
  are `variant="secondary"`; `tertiary` stays only for `Cancel` beside a submit and for
  `Note` / `Edit note` inside Manage.
- **Effect v4 idioms, namespace imports, `@/*` aliases.** JSDoc carries its reasoning
  inline and never references `docs/`. Rewrite, do not append to, any JSDoc whose claim this
  work falsifies. Several are listed below by name.
- **After each phase:** `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (repo-wide; keep every
  file it touches), `pnpm test`. No `#graphql` strings change, so `pnpm graphql-codegen` is
  not needed. Phase 5 runs the two e2e specs.
- **Do not commit.** Commit only when the user says so, to `main`.

## Phase 1: Page shell

Goal: nothing above the first card except banners, and the card and aside start on the same
line.

### 1.1 Remove the state badge

- Delete the `s-badge slot="accessory"` block (`:1464-1468`) and `PRODUCTION_STATE_BADGE`
  (`:191-201`).
- `state` (computed via `Domain.productionState` somewhere near `:780`; grep
  `productionState(`) is still read by the `ready_to_ship` banner. Keep the computation; if
  after 1.2 only `ready_to_ship` reads it, keep it anyway rather than inlining, since the
  index shares the function.

### 1.2 Remove the two paragraphs

- Delete the `state === "no_workflow"` and `state === "multiple_workflows"` paragraphs
  (`:1498-1507`) and drop those two conditions from the enclosing `&&` chain (`:1489-1494`).
- The chain still gates `orderSummary`, `ready_to_ship`, `lineItemsComplete`, and `banner`.
  Those stay in `supplemental-start` for now: the alignment fault came from a paragraph
  rendering on every unrouted order, and the survivors render only on the orders that earn
  them. If the user later wants them moved into the main column, that is a separate ask.

### 1.3 Checkpoint

Typecheck will fail on unused `PRODUCTION_STATE_BADGE` imports only if something else
references it; it should not. Run the four commands.

## Phase 2: Copy and constants

Goal: every merchant-facing string is in the new vocabulary before layout moves.

### 2.1 Status badge labels

Replace `RUN_STATUS_TONE` (`:115-120`) with:

```ts
const RUN_STATUS_BADGE = {
  pending: { label: "Not started", tone: "neutral" },
  active: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "critical" },
} as const satisfies Record<Domain.RunStatus, { label: string; tone: string }>;
```

Update the one render site (`:1211`) to `{RUN_STATUS_BADGE[run.status].label}` with the
tone. Grep `RUN_STATUS_TONE` for any other reader; `app.orders.index.tsx` has its own badge
table and is untouched.

### 2.2 Attach → Start in copy

- `attachResultMessage` (`:41-50`): `AlreadyExists` becomes "That workflow is already
  running on this item." The other three are already fine.
- `ambiguitySentence` (`:164-167`): trailing `Choose one.` becomes `Choose one to start.`
- `actionLabel` (`:1305-1308`): `"Attach"` becomes `"Start"`. `"Choose"` and `"Change"`
  stay.
- The `s-select` `label` and `placeholder` (`:1400-1401`) read `${actionLabel} workflow`;
  they now say `Start workflow` / `Choose workflow` / `Change workflow`. Fine as is.
- The reveal button (`:1391`) is deleted in Phase 4, so do not edit it.
- `changeWarning` (`:176-190`) is unchanged.
- The `attachOpen` JSDoc (`:579-583`) says the picker "is not worth a permanent empty
  `s-select`". That claim is reversed by decision 6. Rewrite it in Phase 4 when the state's
  role changes.

### 2.3 Checkpoint

`pnpm test` (unit) should be unaffected. e2e breaks are expected until Phase 5.

## Phase 3: The run block

Goal: `renderRun` renders name, badge, flag, blocked strip, Now line, attention rows, and
the Manage disclosure. No trail, no Manage button, no Change button in the run block.

### 3.1 Card header with Manage

In `renderLineItem` (`:1330-1336`), the `s-section` currently takes `heading`. Change to:

```tsx
<s-section key={item.id} accessibilityLabel={lineItemTitle(item)}>
  <s-stack gap="base">
    <s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="base">
      <s-heading>{lineItemTitle(item)}</s-heading>
      {manageButton}
    </s-stack>
    ...
```

`manageButton` is `null` unless `live !== undefined && live.run.status !== "cancelled"`.
Otherwise:

```tsx
<s-button
  variant="secondary"
  icon={managingRun(live.run) ? "chevron-up" : "chevron-down"}
  accessibilityLabel={managingRun(live.run) ? "Manage, expanded" : "Manage, collapsed"}
  onClick={toggle managing for live.run.id}
>
  Manage
</s-button>
```

Check `s-button` in `refs/shopify-docs/docs/api/app-home/latest/web-components/actions/button.md`
for whether `icon` renders before or after the label and whether an `aria-expanded`
attribute passes through the custom element; if it does, set it and drop the
`accessibilityLabel` variants, keeping the visible label `Manage` in both states. The
`setup-guide.md` composition under `patterns/compositions/` uses `chevron-up` /
`chevron-down` on buttons and is the reference.

Keep `accessibilityLabel` on the section: `e2e/orders.spec.ts` and `e2e/workflows.spec.ts`
locate cards by `s-section[accessibilityLabel="..."]`. Confirm `s-section` still renders
the label without `heading`; if not, the e2e locators move to the heading text.

Move the `Manage` / `Hide` toggle and the `Undo cancel` button out of `renderRun`
(`:1215-1241`). `Undo cancel` stays in the run row beside the badge, unchanged, since a
cancelled run has no Manage.

Rewrite the `managing` state JSDoc (`:600-611`) only if its claims change; they do not.

### 3.2 Delete the trail from the card

- `renderRun` (`:1245`): remove `{stepTrail(detail, teams, assignTeam)}`.
- Split `stepTrail` (`:441-540`): the inline trail row (`:492-518`) and `progress`
  (`:453-462`) are deleted. The `unassigned` rows and the `emptyTeams` paragraph
  (`:519-538`) become a new `attentionRows(detail, teams, assign)` that returns the same
  `s-stack gap="small-500"` with only those two children, or `null` when both are empty.
  Rewrite the JSDoc: these are the two derived attention states, rendered outside Manage
  because a disclosure would hide the one thing that must be acted on.
- Delete `stepMark` (`:217-222`). Grep first; `manageRows` may use it.
- `lowestOpenStage`, `stageCount`, `readySteps` stay; the Now line uses them.

### 3.3 The Now line

Rewrite `nowLine` (`:385-423`):

- `cancelled` → `null`. `blocked` → `null` (the strip names the step). Unchanged.
- `done` → `Done · N steps` where N is `steps.length`. Was `N stages`.
- Otherwise: `Step ${lowest} of ${stageCount(steps)} · ${names} · ${teams}` followed by
  ` · since <time>` only when `since !== null`. `lowest` is `lowestOpenStage(steps)`.
  Two things to get right:
  - The count is of stages and the position is a stage number, but the word is `Step`.
    Merchants count steps; a parallel stage shows both names after the position, which is
    what `names` already does. Put this in the JSDoc.
  - `ready.length === 0` with an open run can only happen when every remaining step is
    unassigned or the run is inconsistent. Return `null` as today.
- Render it as `<s-text>` (default color), not `subdued`: it is the card's answer, not a
  footnote. The mockup shows it in ink.
- Rewrite the JSDoc. Drop the sentence about the trail printing the ready step in bold.

### 3.4 Assemble `renderRun`

Order inside the `s-stack`:

1. Inline row: `<s-text type="strong">{run.workflowName}</s-text>`, status badge, flag
   badge, `Undo cancel` when cancelled.
2. `blockedStrip` when blocked (unchanged).
3. Now line.
4. `attentionRows`.
5. `manageRows(detail)` when `!cancelled && managingRun(run)`.

Rewrite the `renderRun` inline comment about "its section is headed by the line item".
Still true; keep.

### 3.5 Checkpoint

Run the four commands. Open an order with a run in the browser (`pnpm app:dev`, seed, then
`playwright-cli` headed per `CLAUDE.md`) and confirm the header row does not wrap the button
under the title at the `base` page width.

## Phase 4: The item's workflow row

Goal: select + Start at rest on an unrouted item; Change workflow inside Manage.

### 4.1 Delete the reveal

- Delete the `attachOpen` state (`:579-586`) and its two setters (`:1387-1389`,
  `:1441-1447`). Delete the `!pickerOpen` button block (`:1383-1394`).
- `pickerOpen` (`:1303`) becomes: `live === undefined && !removed`. Ambiguity no longer
  needs to force it open, since it is always open on an unrouted item.
- The `s-grid` picker block (`:1395-1452`): drop the `Cancel` button entirely. There is
  nothing to dismiss when the picker is the row's resting state. Rewrite the grid's JSDoc
  (`:1396-1401`); the width reasoning still holds.
- Add a leading label cell: `<s-text color="subdued">Workflow</s-text>` as the first grid
  child and widen the template to `max-content minmax(0, 20rem) auto`. The `s-select` keeps
  `labelAccessibilityVisibility="exclusive"` so the visible word is the `s-text` and the
  accessible name stays `Start workflow` for the e2e `combobox` locator.
- When `options.length === 0` (no active, startable workflow): render instead one
  `<s-paragraph color="subdued">No workflows can start. <s-link href="/app/workflows">Create one.</s-link></s-paragraph>`.
  Confirm the workflows route path with `ls src/routes`.

### 4.2 Delete the empty sentence; show tags there

- Delete the `itemRuns.length === 0` paragraph branch (`:1369-1374`). Keep the ambiguity
  paragraph, rendered above the picker when `ambiguous`.
- Product tags (`:1348-1350`) move off the facts row. On an unrouted item they render as
  the tail of the facts line: `× 1 · SKU CC-01 · tags: workflow-02, gift`. Build the facts
  line as one `s-text color="subdued"` joined with `·` rather than an inline stack of
  badges: quantity, `SKU <sku>` when present, `tags: <list>` when `live === undefined` and
  the list is non-empty. `Removed` stays a badge beside it.
- The quantity string (`:1340-1344`) is unchanged.

### 4.3 Change workflow inside Manage

In `manageRows` (`:1004-1195`), the trailing `open &&` row holding `Cancel` (`:1178-1194`):

- Make it one inline `s-stack` holding, in order: `Block` is already above in its own
  block; leave it. This row holds `Cancel` (now `variant="secondary" tone="critical"`, label
  `Cancel run`) and `Change workflow` (`variant="secondary"`).
- `Change workflow` toggles a per-run `changeOpen` boolean (new state, `ReadonlySet<string>`
  keyed by run id, same shape as `managing`). When open, render the same `s-grid` picker as
  4.1 under the row, with `options` = every active workflow except the incumbent,
  `actionLabel` `Change`, and a tertiary `Cancel` that closes it. Submit goes through the
  existing `submit` closure: it already routes a touched run through `changeWarning` and the
  modal, and a pristine run straight to `attachMutation`.
- `changeable` (`:1290`) still gates it: a `done` run offers no Change. Since Manage is
  offered on done runs (notes, reopen), the button is simply absent there.
- The picker helper is now needed in two places. Lift it to a `workflowPicker({ item,
options, actionLabel, chosen, onChoose, onSubmit, onCancel? })` closure inside the
  component so 4.1 and 4.3 share it.
- Rewrite the `manageRows` JSDoc's second paragraph: "Every intervention lives here and
  nowhere else" is now fully true and should say Change workflow is among them.
- Rewrite the `renderLineItem` JSDoc (`:1252-1271`): the three cases still hold, but "a
  disclosure over every active workflow, as before" is wrong; it is the row's resting
  state now.

### 4.4 Checkpoint

Run the four commands. In the browser: an unrouted item shows the select at rest; choose and
Start creates the run and the card re-renders with the header Manage button; open Manage,
Change workflow, pick another, confirm the run swaps.

## Phase 5: Tests

### 5.1 `e2e/orders.spec.ts`

- `:269`, `:329`, `:374`: `getByRole("button", { name: "Manage" })` still matches if the
  accessible name starts with `Manage`. If 3.1 used `accessibilityLabel`, the name is
  `Manage, collapsed`; either switch to `{ name: /^Manage/ }` or keep the visible label as
  the name by using `aria-expanded` instead. Prefer the latter.
- `:465-470`: the ambiguity sentence now ends `Choose one to start.`
- `:486-489`: `Change workflow` is inside Manage. Insert
  `await item.getByRole("button", { name: "Manage" }).click();` before locating it, and
  after the change, expect the Manage button again rather than the Change button.
- `:500`: the `Change` submit and the picker locator are unchanged.
- Any assertion on the badge text `pending` / `active` / `done` (`:279` area, grep
  `"done"` and `"active"` in `getByText`) moves to `Done` / `In progress`.
- Any assertion on `Stage N of M` or the trail text (grep `Stage`, `·`) moves to the Now
  line form `Step N of M · ...`.

### 5.2 `e2e/workflows.spec.ts`

- `:319-321`: the negative assertion on "No workflow on this item." now proves nothing,
  since the sentence no longer exists in either state. Replace with
  `await expect(band.getByRole("combobox")).toHaveCount(0);` and keep the positive
  assertion on the workflow name. Update the comment above it.

### 5.3 `e2e/fixture.ts`

`:330` comments on the index badge, which is unchanged. No edit.

### 5.4 Run

```bash
npm run test:e2e -- e2e/orders.spec.ts e2e/workflows.spec.ts
```

Both must pass. If a Polaris custom element behaves differently from the plan (for example
`s-section` without `heading` dropping its `accessibilityLabel`), record it under Deviations
and pick the nearest working form.

## Phase 6: Docs

- Research doc: update "What this touches" if the file list changed, and fold every entry
  from Deviations below into the section it contradicts. Then set this plan's status line
  to **done**.
- `docs/order-item-workflow-ux/mockups.html`: no edit unless a deviation changes what the
  card looks like.

## Deviations

One bullet per deviation from the phases above: what the plan said, what was done instead,
and why.

1. **`aria-expanded` does not work on `s-button`; the chevron is the whole state.** Phase 3.1
   said to prefer it over the `accessibilityLabel` variants. Measured in the embedded admin
   (2026-09-16): React omits the attribute when it is false and writes it on the `s-button`
   host when true, but the host is not the element carrying the button role, so
   `getByRole("button", { expanded: true })` finds nothing. The remaining lever is
   `accessibilityLabel`, which _replaces_ the accessible name — the control every merchant
   and every spec addresses by its visible word would be renamed for a state a screen reader
   then hears as part of the name. The button keeps the plain name `Manage`, the three
   `getByRole("button", { name: "Manage" })` locators in `orders.spec.ts` are unchanged, and
   the JSDoc records the measurement so the next reader does not re-add the prop. Also worth
   knowing: `{ name: /^Manage/u }` does _not_ match — a regex is not whitespace-normalised
   and the icon puts a space before the label, so `exact: true` is the form that works.

2. **`workflowPicker` is a closure inside `renderLineItem`, taking only an optional
   `onCancel`.** Phase 4.3 specified seven parameters. All but `onCancel` — `item`,
   `options`, `actionLabel`, `chosen`, `onChoose`, `onSubmit` — are already in scope there,
   and an item is never in both picker states at once, so passing them would have restated
   the enclosing scope. `manageRows` and `renderRun` therefore take the `Change workflow`
   button and its picker as _nodes_, the shape `blockedStrip` already uses for its `Unblock`.

3. **`Change workflow` is absent, not idle, when there is nothing to change to.** Phase 4.1
   covered `options.length === 0` only for the at-rest picker. The same emptiness on a live
   run — a shop whose one active workflow is the one already running — would have opened a
   picker with no options, so `change` is null there and the button does not render.

4. **Changing a workflow closes Manage.** `managing` and `changeOpen` are both keyed by run
   id and a change mints a new run, so the disclosure the merchant had open does not carry
   over to its replacement. Left as is: the change is done, and what the merchant wants to
   see next is the new run's card.

5. **The ambiguity spec needed a new gate after the Change submit.** Phase 5.1 assumed the
   `Change workflow` button could be waited on. It cannot: it is now inside Manage, and
   `Manage` itself is on the card in every state, so waiting on either passes before the
   write lands and then reads the workflow's name off the still-open select (three matches —
   the `s-option`, the shadow `span.value`, and the native `option`). The gate is the
   picker's disappearance:
   `expect(item.getByRole("combobox", { name: "Change workflow" })).toHaveCount(0)`.

Three smaller notes that are not deviations but were left implicit by the plan:

- **The whole facts line is subdued**, quantity included. Phase 4.2 only said to join it with
  `·`; the quantity was the one unsubdued fact, and one ink-coloured fragment in a subdued
  line reads as an error rather than as emphasis.
- **`Undo cancel` is gated on `cancelled`, not paired with Manage.** Phase 3.1 said to leave
  it in the run row, which is what happened, but the `cancelled ? … : …` ternary it shared
  with the old Manage button is gone: an item can carry several cancelled runs and only one
  live one, so the two are no longer alternatives.
- **Four JSDoc comments that named the trail were rewritten**, not just the ones Phase 3
  listed: `readySteps`, `orderSummary`'s `waiting on` paragraph, `assignTeam`, and the
  `ambiguous` / `changeable` comments in `renderLineItem`, which cited the deleted page badge
  and "finished work with a trail".

Review on 2026-09-16 added three more, folded into the research doc's "Answered in review":
`Done · N steps` counts stages; the section drops `accessibilityLabel` (it rendered a
duplicate heading) and the e2e specs locate cards by heading text; the change picker's Cancel
clears the item's pending choice. It also brought the Manage panel to the research doc's
form: subdued background, and Block (or Unblock) in the one run-level action row with
Cancel run and Change workflow, and moved the banners out of `supplemental-start` into the
main column so the first card and the aside share a top edge.
