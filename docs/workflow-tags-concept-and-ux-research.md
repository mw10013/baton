# Workflow tags: concept, UX, and implementation spec

Research date: 2026-09-12. Scope: what a workflow tag _is_ in Baton, how the three
comparable products treat theirs, where tag editing should live, and a handoff spec.
No application code changed. Supersedes the interaction half of
[workflow product tag editor research](./workflow-product-tags-research.md), which
designed the Manage tags modal without questioning the concept behind it.

## Conclusion

Baton calls this a **product tag**, following Route to Ship. That is the wrong name and
it is the source of most of the confusion. Baton mints the string, the workflow owns it,
and the merchant carries it out to Shopify and puts it on products. The label points the
wrong way down the arrow.

Rename it to the workflow's **tag**, and:

1. **Ask for it at creation**, next to the name, prefilled from the name.
2. **Show it wherever the workflow is identified**, and keep **one** place to edit it —
   the editor, reached by an **Edit tag** button on the detail page.
3. **Design the UI for one tag**, keeping the array as an escape hatch.
4. **Add nothing else.** No suggestions, no uniqueness constraint, no duplicate warning.
   Drop the index tag filter.

## The naming problem

### One phrase, two opposite jobs

`Workflow.tags` and `OrderLineItem.productTags` are both called "product tags," in code
and in copy, and they are opposite ends of the same arrow. The line item's field
genuinely _is_ the product's tags — a snapshot of whatever the merchant keeps in Shopify,
mostly merchandising facets Baton never cares about. The workflow's field is a string
Baton invented, which the merchant then applies to products.

Rename the workflow's side and the sentence resolves: **the workflow has a tag; the
product carries product tags; a match is when one of the product's tags is the workflow's
tag.** The line item's field keeps its name — it is already telling the truth.

### Why "product tag" misleads at the create dialog

A field labelled _Product tag_ asks the merchant to **supply** something, so the natural
reaction is "I don't have such a tag — do I need to go make one first?" Neither is true.
A field labelled _Tag_, under the workflow's name in a **Create workflow** dialog, reads
as something Baton is **giving** them, which is the truth of the mechanism.

Assume the merchant arrives with **no usable tag vocabulary**. Someone adopting a
made-to-order production app is not bringing a curated set of routing tags; if they had
one, they would already have a system. That assumption is also what kills suggestions:
there is nothing to suggest from, in either direction.

### It is a handle. Do not say "handle."

One per workflow, stable, lowercase-folded, and it survives a rename precisely because
products already carry it. Merchants should never meet the word; possessive framing
carries the meaning without it — _"Engraving's tag is `engraving`"_. Shopify's own product
handles work on merchants who have never heard the term, by the same trick.

### Accepted trade-off

Shopify Flow also says "workflow tag" and means an organisational label for filtering a
list ([`refs/flow-manual/manage/organize-workflows.md`](../refs/flow-manual/manage/organize-workflows.md)).
A merchant fluent in Flow could carry that expectation over. Accepted: different app,
different surface, and nothing in Baton's copy uses the tag for grouping — especially once
the index filter goes, which is currently the one piece of Baton UI that makes tags look
like a grouping dimension.

Rejected alternatives: **"trigger tag"** (jargon; Baton's vocabulary says _starts when_,
not _trigger_ — `src/lib/Domain.ts:511`) and **"routing tag"** (`Domain.ts:524` bans
_route / routing / routable_ from code and copy).

## The concept

### Three different things are called tags

|                         | What it is                                             | Per object       | Shared between objects?                                | So its UI is…                                           |
| ----------------------- | ------------------------------------------------------ | ---------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| **Shopify product tag** | A merchandising facet — colour, season, vendor, sale   | Many             | Yes, by design; that is what a facet is                | A combobox over the shop's whole vocabulary             |
| **Flow workflow tag**   | An organisational label on an automation               | Many             | Yes, deliberately — one `BFCM` across twelve workflows | Selected / Available checkbox lists, plus a list filter |
| **Baton workflow tag**  | The workflow's own name, in a form a product can carry | One, in practice | Not by design, but harmless when it happens            | Neither of the above                                    |

Baton's is the third, stored using the first's mechanism, and until now dressed in a
little of the second's UI. Flow tags change nothing about what a workflow does; Baton's
tag is the only thing deciding whether a workflow does anything at all.

### The fan-out belongs to the product

The genuine many-to-many is on the **product** side. A product tagged both `engraved` and
`giftwrap` legitimately enters two production streams in parallel, and Baton already
models that: two runs, each with its own steps and teams. Route to Ship documents the same
behaviour and calls it intentional
([`docs/route-to-ship-tag-routing-research.md`](./route-to-ship-tag-routing-research.md)).

Nothing symmetric exists on the **workflow** side. A workflow needing two tags means "two
strings mean the same process" — a naming accident, not a production fact. The real cases
are all transitional: renaming a tag across the catalogue, merging two product families
onto one line, inheriting a vocabulary from a previous app. All real, none everyday, all
served by an escape hatch.

Hence **design for one, allow many**: the array stays (max 20,
`Domain.WorkflowLimits.maxTags`), the UI stops presenting a set as the default shape.
The `e2e/fixture.ts` workflows already carry exactly one tag each, which is independent
evidence for the model.

### Duplicate tags across workflows are fine

Two workflows carrying the same tag start two runs on the same line item, because
`matchesLineItem` evaluates each workflow independently
(`src/lib/WorkflowRunRepository.ts:905-913`).

An earlier draft called that a hazard and proposed a warning. **That was wrong.** It is
the same fan-out that is correct on the product side, and there is no principled reason it
becomes a defect when the two tags happen to match — a merchant who does that has said
"this family goes through both," which is coherent. The one real accident vector is
already closed: `duplicateWorkflow` deliberately copies everything _except_ the tags, and
says why (`src/lib/WorkflowRepository.ts:268-277`).

**Do not warn, do not enforce uniqueness.** Enforcement stays available — workflow _names_
are already unique (`WorkflowNameTakenError`) — but it buys nothing and costs an error path
at the create dialog, exactly where the merchant is still learning the field.

## What the comparable products do

Inspected live in the sandbox store on 2026-09-12 via Chrome DevTools.

**Shopify product admin.** Right sidebar, card _Product organization_, Tags last, below
Type / Vendor / Collections. Always visible, no edit mode. Chips with inline ×; the field
opens into a combobox with placeholder _"Search or add tags"_ and a checkbox list grouped
_Frequently used_ / _Other tags_; unmatched text offers `+ Add "<text>"`. Typing
`alpha, beta` offers _"Add 2 tags"_ — splits correctly. Persistence is the page-level
unsaved-changes bar, not per tag. The products index has no Tags column but has a **Tag**
filter facet. This is the surface the merchant visits _after_ Baton gives them a tag — the
destination, not the model.

**Shopify Flow.** Tags live on the workflow **overview** page, not the canvas. _More
actions_ → _Manage tags_. Once a workflow has a tag, a `Tags: [chip] ✏️` row appears under
the timestamp; with zero tags **the row vanishes entirely** — no empty state at all. Dialog
titled `Manage tags for "<name>"`, **no footer**, saves **immediately per action**. Body:
_Add tags_ (text input, placeholder `inventory, fulfillment, loyalty`, `0/100` counter,
_Add_ button), then _Selected_ and _Available_ checkbox lists.

**The comma bug is confirmed.** `alpha, beta` + Add creates one literal tag named
`alpha, beta`, comma and space included. The placeholder promises parsing the control does
not do. Shopify's product combobox and Route to Ship both split correctly.

**Route to Ship.** Tags live **only** inside the full-page Pipeline Builder, under
_Pipeline Details_. Despite the label _"Shopify Tags (comma-separated)"_ it is a chip
combobox; the dropdown lists shop tags with a usage count (`pipeline-01 (3)`), descending.
`alpha, beta` + Enter commits two chips. Persistence is _Cancel_ / _Update Pipeline_. The
pipelines list shows **no routing tags at all** — only a grey slug chip (`pipeline-01`)
that looks exactly like a tag chip and is not one. Lesson: a chip on a list that is not the
matching key is worse than no chip.

Route to Ship is also where Baton's "product tag" vocabulary came from — its Help centre
says "Each pipeline is linked to Shopify product tags," which describes the storage
mechanism rather than the merchant's task, and Baton inherited the framing unexamined.

### Reading across

|                 | Where tags live                | Control                            | Comma splits       | Save model                |
| --------------- | ------------------------------ | ---------------------------------- | ------------------ | ------------------------- |
| Product admin   | Sidebar card, always visible   | Chip combobox over shop vocabulary | Yes                | Page-level Save / Discard |
| Flow            | Overview page, More actions    | Text input + Add, checkbox lists   | **No (bug)**       | Immediate, per action     |
| Route to Ship   | Inside the full edit form only | Chip combobox, frequency-ranked    | Yes (on Enter)     | Explicit Update Pipeline  |
| **Baton today** | Inside `/edit` only            | Text field + Add, removable chips  | No (one at a time) | Save to draft, then Apply |

The save-model column rules Flow's placement out regardless of taste. Flow can save
instantly because a Flow tag changes nothing. A Baton tag _is_ the trigger, and `Domain.ts`
states the invariant: "`tags` and steps change only through Apply, so an order arriving
between two edits sees a whole definition, never a half one" (`src/lib/Domain.ts:568-570`).
A dialog writing straight through would re-route a live workflow mid-flight.

## Baton today

- **Create dialog** (`app.workflows.index.tsx:341-350`) asks for a name only, hinting
  "You'll add the product tags and steps next." The merchant leaves with a workflow that
  can never start, and nothing says so.
- **Index** has a _Product tags_ badge column, and one toggle button per distinct tag
  across all workflows (`app.workflows.index.tsx:303-327`).
- **Detail page** shows a dashed trigger card headed _Product tag_ containing only the
  `itemTriggerLine` sentence — **no chips, no way to edit**
  (`app.workflows.$workflowId.tsx:320-333`).
- **Editor** shows the same card plus chips plus _Manage tags_, opening the modal
  (`app.workflows.$workflowId_.edit.tsx:683-698`, `components/WorkflowProductTags.tsx`).
  Saves to the draft; Apply publishes.
- **The wire-up check already exists**: `countWaitingOrders` counts open orders whose items
  match, and the Turn on dialog shows the count (`components/WorkflowSwitch.tsx:144-167`).
  The orders index badges unmatched paid orders _"No workflow"_
  (`app.orders.$orderId.tsx:767`). The loop the merchant needs — _did my tag catch
  anything?_ — is already built and paid for. It is just downstream of where the tag is
  typed.

## Placement: the four options

The failure that matters is not that editing is slow — the tag is set once and essentially
never touched. It is that a merchant can create a workflow, add steps, turn it on, and
never pass the field that makes any of it work.

**A. Editor only (status quo).** One edit surface, automatic draft boundary, and the tag
sits where the trigger is. But the object's most important field is behind a mode.

**B. Flow's pattern — detail page, More actions, immediate save.** Familiar, no draft
ceremony. Rejected on three counts: it buries the field _deeper_ than today (an overflow
menu is where Delete goes); immediate save breaks the Apply invariant; and Flow's own
version has no empty state, which is exactly the case Baton must handle loudly.

**C. Detail-page aside card, edits through the draft.** Mirrors the Shopify product admin's
sidebar idiom, visible without a mode, keeps the Apply boundary. But the editor's aside is
already the step inspector (`app.workflows.$workflowId_.edit.tsx:707`), so the card would
exist on the detail page and vanish in the editor — the same field in two places depending
on which view of the same object you are in. And a sidebar button that silently creates a
draft explains itself only after the fact.

**D. Recommended — ask at creation, display as identity, edit in one place.**

Fixes discoverability at the moment the model is formed; single edit surface and single
draft entry point; no placement differing between detail page and editor; no invariant
broken. Editing costs a navigation, which is the right thing to trade: optimising the edit
path optimises the rare case, while optimising the _first_ encounter optimises the one that
decides whether the merchant understands the product at all.

### On prefilling from the name

The prefill is `trim().toLowerCase()` of the name — exactly what `Domain.ProductTag` already
does at the schema boundary (`src/lib/Domain.ts:431-441`). No slug logic to invent, no edge
cases: Shopify tags allow spaces, so `Engraved ring` → `engraved ring` is valid.

An earlier draft argued against prefilling because it implies a rename should re-tag
products. Wrong: the coupling exists either way — a merchant who types `engraving` under a
workflow named "Engraving" holds the same expectation. Prefill does not create it; it stops
pretending the two strings are unrelated when the merchant plainly means them to be. What it
buys is the concept teaching itself.

**Decided: prefill ships in the first cut.** Editable, clearable, and a later rename never
touches it.

---

# Implementation spec

Handoff-ready. Everything below is decided; do not relitigate the concept. Read the sections
above for the _why_ — this section is the _what_.

## Ground rules

- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, `@/*` aliases, JSDoc carrying
  reasoning inline and never referencing `docs/`.
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm fmt` (repo-wide, keep every file it touches).
- No `#graphql` strings change, so `pnpm graphql-codegen` is not needed.
- Commit to `main`, no branches, and only when explicitly told to commit.

## Change 1 — Rename the identifiers

`Domain.ProductTag` → `Domain.WorkflowTag`, `Domain.ProductTags` → `Domain.WorkflowTags`.
Six source files and four test files:

- `src/lib/Domain.ts` (declaration ~431-464, plus `CreateWorkflowInput`,
  `UpdateWorkflowTagsInput`, `ItemWorkflow`, `WorkflowDraft`, the seed input struct)
- `src/lib/WorkflowRepository.ts`, `src/routes/api.dev.seed.ts`,
  `src/routes/app.workflows.$workflowId_.edit.tsx`, `src/components/WorkflowProductTags.tsx`
- `test/integration/workflow-repository.test.ts` (also the two `it(...)` titles naming
  `ProductTags`), `workflow-run-repository.test.ts`, `shop-agent-orders-stream.test.ts`

Rename `src/components/WorkflowProductTags.tsx` → `src/components/WorkflowTag.tsx` and the
exported component `WorkflowProductTags` → `WorkflowTag`.

**Do not rename:** `OrderLineItem.productTags` (it really is the product's tags), the
`Workflow.tags` / `WorkflowDraft.tags` DB columns, `updateWorkflowTags`, or
`WorkflowLimits.maxTags`. No migration.

Update the `ProductTag` JSDoc to say the tag is the workflow's own name in a form a product
can carry, that Baton authors it and the merchant applies it to products in Shopify, and
keep the existing reasoning about folding and the 255 limit.

Add the distinction to the `Domain.ts` vocabulary block (~`:498-570`): the workflow **has a
tag**; the product **carries product tags**; a match is one of the product's tags equalling
the workflow's tag. Add _product tag_ (for the workflow's field) to the not-used list
alongside `route` / `routing`.

## Change 2 — Create dialog gains a prefilled Tag field

File: `src/routes/app.workflows.index.tsx` (modal at ~341-350).

`Domain.CreateWorkflowInput` **already carries `tags: ProductTags`** (`Domain.ts:751-755`),
so there is no schema or repository change — the route currently passes `tags: []`
(line 124) and will pass a real value.

State: `name`, `tag`, and `tagDirty: boolean`.

- On name input: set `name`; if `!tagDirty`, set `tag` to `name.trim().toLowerCase()`.
- On tag input: set `tag`, set `tagDirty = true`.
- Reset all three when the modal opens.
- Submit: `createWorkflow({ name, tags: tag.trim() === "" ? [] : [tag] })`. Do not normalise
  in the component beyond the mirror — `WorkflowTags` folds, dedupes and validates.

Field: `label="Tag"`, `maxLength={255}`, optional (a blank tag must not block Create),
`details="Add this tag to your products in Shopify. Their items will follow this workflow."`
Replace the name field's `details` ("You'll add the product tags and steps next.") with
`"You'll add the steps next."`

Add a JSDoc on the mirroring explaining that the transform is the same folding
`WorkflowTag` applies at the schema boundary, that the mirror stops at the merchant's first
keystroke in the tag field, and that a later rename never touches the tag because products
already carry the old string.

## Change 3 — Detail page shows the tag and links to editing

File: `src/routes/app.workflows.$workflowId.tsx`.

- Header: add the tag as a second `slot="accessory"` badge next to Active / Off (~240-248).
  Verify `s-page` renders two accessory children; if not, put it in the trigger card only.
- Trigger card (~320-333): keep the `itemTriggerLine` sentence, add `s-chip` per tag above
  it, and add an **Edit tag** `s-button` with
  `href={`/app/workflows/${workflowId}/edit?tag=edit`}`.
- Render `shownTags` (already computed at line 214) so the Draft tab shows draft tags.
- Empty-state string at line 58-59 → see the copy table.

Navigating does **not** create a draft; only saving in the modal does. That is existing
behaviour and must not change.

## Change 4 — Editor: singular framing and the deep link

Files: `src/routes/app.workflows.$workflowId_.edit.tsx`, `src/components/WorkflowTag.tsx`.

**Deep link.** The edit route has no `validateSearch` today. Add one hand-written like the
detail route's (`app.workflows.$workflowId.tsx:41-50`), so an unknown value reads as absent
rather than failing the route:

```ts
interface EditSearch {
  readonly tag?: "edit";
}
```

Pass `defaultOpen={search.tag === "edit"}` to `WorkflowTag`; the component opens the overlay
once on mount when set. Clear the param when the modal closes so a refresh does not reopen
it.

**Component UI.** Restructure `WorkflowTag` around one tag, keeping every existing safeguard
(`PolarisModal.useModalBackdropDismissGuard`, the working-selection-survives-dismissal
comment and behaviour, the Enter-key listener and its JSDoc, schema validation on save,
Cancel / Save to draft footer).

_Primary state_ — 0 or 1 tag, not expanded: a single `s-text-field` labelled **Tag** whose
value **is** the tag, edited in place (not an add-field), plus a `+ Add another tag` button.
Save writes `[value]`, or `[]` when blank.

_Expanded state_ — more than one tag, or after `+ Add another tag`: today's add-field plus
removable `s-clickable-chip` list. Entering this state must be sticky for the session so the
merchant can get back to one tag without the UI collapsing under them.

Card heading and button in the editor (~683-698): _Product tags_ → **Tag**, _Manage tags_ →
**Edit tag**.

## Change 5 — Index: rename the column, drop the tag filter

File: `src/routes/app.workflows.index.tsx`.

- Column header (line 227): _Product tags_ → **Tag**. Cell (241-249): render the first tag as
  an `s-badge`; if more, append a subdued `+N`; empty stays `—`.
- Remove the tag filter block (303-327), the `tags` set computation (145-147), the `tag`
  predicate (158), `tag` from `filtered` (164) and from every `setFilters` spread, `tag` from
  `WorkflowsSearch` and `validateSearch` (34-45), and the `tag` mention in the JSDoc at 24-31.
- Empty state (198) and the section footer (275) → see the copy table.

## Copy changes

Copy describing the match **from the order's side** already says "product tagged X" and is
correct. Only copy naming the **workflow's own field** changes.

| Where                                      | Today                                                                                                | Proposed                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Index column                               | `Product tags`                                                                                       | `Tag`                                                                                                                                                  |
| Index empty state                          | "…Product tags decide which items follow it."                                                        | "…Each workflow has a tag; products carrying it follow that workflow."                                                                                 |
| Index footer                               | "chosen by product tag"                                                                              | "chosen by its tag"                                                                                                                                    |
| Create name hint                           | "You'll add the product tags and steps next."                                                        | "You'll add the steps next."                                                                                                                           |
| Create tag hint                            | —                                                                                                    | "Add this tag to your products in Shopify. Their items will follow this workflow."                                                                     |
| Detail / editor card heading               | `Product tag` / `Product tags`                                                                       | `Tag`                                                                                                                                                  |
| Detail empty state                         | "This workflow has no product tags, so nothing will match it until you add some."                    | "This workflow has no tag, so nothing can reach it. Add one, then put it on your products."                                                            |
| `itemTriggerLine` empty                    | "No product tags yet, so this never starts. Add one to say which items follow it."                   | "No tag yet, so nothing reaches this workflow. Add one, then put it on your products in Shopify."                                                      |
| Editor button                              | `Manage tags`                                                                                        | `Edit tag`                                                                                                                                             |
| Modal heading                              | `Manage product tags`                                                                                | `Edit tag`                                                                                                                                             |
| Modal body                                 | "Choose which product tags match this workflow. This does not change tags on your Shopify products." | "This workflow's tag. Add it to your products in Shopify — items on those products follow this workflow. Editing it here does not change any product." |
| Modal field label                          | `Add a product tag`                                                                                  | `Tag` (primary state) / `Add a tag` (expanded)                                                                                                         |
| Modal selected heading                     | `Selected product tags`                                                                              | `Tags` (expanded state only)                                                                                                                           |
| Modal empty                                | "No product tags selected. This workflow won't start."                                               | "No tag yet. Nothing reaches this workflow."                                                                                                           |
| Modal limit error                          | "Choose at most 20 product tags."                                                                    | "Choose at most 20 tags."                                                                                                                              |
| Modal save error                           | "Couldn't save product tags."                                                                        | "Couldn't save the tag."                                                                                                                               |
| `itemTriggerLine` match sentence           | "Starts when an order contains a product tagged “engraved”."                                         | **unchanged** — correct from the order's side                                                                                                          |
| Order page (`app.orders.$orderId.tsx:767`) | "No workflow's product tags match the items in this order."                                          | **unchanged** — correct from the order's side                                                                                                          |

Also update the JSDoc prose in `workflowShared.ts:59`, `app.workflows.index.tsx:98,104`, and
`app.order-workflow.index.tsx:57` to the new vocabulary.

## Out of scope

Do not implement, and do not add TODOs for: tag suggestions or autocomplete of any kind; any
Admin API tag fetch; a uniqueness constraint or duplicate warning; a "N products carry this
tag" indicator or any new scan; comma-splitting on entry; narrowing `WorkflowTags` to a
single value in the schema; any change to `matchesLineItem` or run creation.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm fmt` clean.
- `pnpm test` green. Update the four integration tests naming `ProductTags`; add coverage for
  create-with-a-tag and for the name→tag mirror stopping once the tag is edited.
- `e2e/workflows.spec.ts` needs updating at lines 81, 87, 89, 260 — the strings
  "No product tags yet…", the `Manage tags` button, and the `Add a product tag` textbox all
  change. Assertions on "Starts when an order contains a product tagged" (line 94) stay.
- `e2e/fixture.ts` already gives each workflow exactly one tag; leave it.
- Manually, via `pnpm playwright-cli` (headed, session `$(pnpm port)-localdev`), waiting for
  `data-hydrated` / `data-app-interactive` before interacting:
  1. Create a workflow named `Engraved ring`; the tag field shows `engraved ring` as you
     type. Edit the tag, then keep typing the name — the tag stops following.
  2. Clear the tag and Create; the detail page shows the empty state and Edit tag works.
  3. Edit tag from the detail page opens the editor with the modal open; Cancel creates no
     draft; Save to draft does, and the Draft tab shows the new tag while Live shows the old.
  4. `+ Add another tag`, add a second, save, reopen — the expanded state persists and both
     chips render; the index cell shows `first +1`.
  5. Turn on and confirm the waiting-order count still reflects the tag.
  </content>
