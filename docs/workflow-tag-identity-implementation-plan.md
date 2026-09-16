# One tag per workflow: implementation plan

Status 2026-09-16: **done.** The reasoning and every product decision are in
[`docs/workflow-tag-identity-research.md`](./workflow-tag-identity-research.md); its
Conclusion list and "Two schema questions from review" section are binding. This
document is the order of work. Like the other implementation plans in `docs/`, it is
disposable once the code is in and any deviations are folded back into the research
doc. Line cites are as of commit `8204eee`; re-grep if they have drifted.

## What changes, in one paragraph

Today a workflow carries a JSON array of tags (`Workflow.tags`, up to 20, may be empty),
the draft carries its own copy (`WorkflowDraft.tags`) which Apply publishes, and
uniqueness is checked in application code at Apply and Turn on against _active_
workflows only. After this work a workflow carries exactly one tag in a `tag text not
null unique` column, the draft carries none, the tag is edited from the detail page in
its own dialog with the write landing immediately (like Rename), and a collision is
reported under the field the merchant typed in, at Create, Duplicate, and Edit tag.
Duplicate becomes a dialog that asks for the copy's name and tag. Turn on and Apply
stop knowing tags exist. Matching becomes `productTags.includes(workflow.tag)`.

## Ground rules for this work

- **Schema goes into the initial schema, not a migration.** Every column change is
  made in place inside `"1_initialize schema"` in `src/lib/ShopAgent.ts`; there are
  zero `alter table` statements in the repo. **Consequence:** once Phase 1 lands, every
  local Durable Object has a stale schema. The dev server must be stopped, `.wrangler`
  state wiped (`pnpm d1:reset`), the server restarted, and `pnpm seed` re-run before
  any browser check. Tell the user at the Phase 1 checkpoint; do not do it unannounced.
- **The invariant is in the database.** `unique` on `Workflow.tag`, not only
  application logic. The pre-selects exist to say _which_ field collided; the constraint
  is what guarantees it.
- **Pre-select, do not parse errors.** `insert or ignore ... returning` cannot tell a
  name collision from a tag collision. Every write that can hit either runs a `select`
  for each inside the same `sql.withTransaction` and returns the specific error. The
  repository runs inside a Durable Object where SQLite is synchronous, so the select
  and the write cannot interleave with another request. Do not parse
  `UNIQUE constraint failed` text anywhere.
- **Vocabulary.** The workflow **has a tag**; the product **carries product tags**; a
  **match** is one of the product's tags equalling the workflow's tag. Never "product
  tag" for the workflow's field, never "handle", "slug", "route", "trigger" in merchant
  copy. Curly quotes around a tag in copy, as `itemTriggerLine` does today.
- **Effect v4 idioms, namespace imports, `@/*` aliases.** JSDoc carries its reasoning
  inline and never references `docs/`.
- **After each phase:** `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (repo-wide; keep
  every file it touches), `pnpm test`. No `#graphql` strings change, so
  `pnpm graphql-codegen` is not needed.
- **Do not commit.** Commit only when the user says so, to `main`.

## Phase 1: Domain and schema

Goal: the type system and the database say one tag. Nothing compiles until Phase 2 is
also done; that is expected. Do Phases 1 and 2 as one unit before running typecheck.

### 1.1 `src/lib/Domain.ts`

- **`WorkflowLimits`** (`:390-400`): remove `maxTags`. Update the JSDoc if it lists the
  three bounds.
- **`WorkflowTag`** (`:455-476`): keep as is. Rewrite the JSDoc: the workflow's one
  tag, its identity in a form a product can carry; Baton mints it, the merchant puts it
  on products in Shopify; folded (trim + lowercase) at the boundary so storage is
  canonical and matching is plain equality; 255 is Shopify's tag limit; no character
  rules of Baton's own beyond what Shopify allows.
- **`WorkflowTags`** (`:478-498`): delete, with its JSDoc.
- **Vocabulary block** (`:500-570`): rewrite the Draft bullet to "a private copy of the
  workflow's **steps**". Replace "The workflow has a tag (one in practice; `tags`
  allows more as an escape hatch…)" with: every workflow has exactly one tag, no two
  workflows share one, and the tag is edited like the name, immediately, never through
  the draft. Replace "`tags` and steps change only through Apply" (`:564-570`) with
  "steps change only through Apply; the tag and the name are immediate because runs
  snapshot both at start". Keep the "starts when / contains / tagged with / match / No
  workflow / placed since" list, changing "one of its tags" to "its tag".
- **`Workflow`** (`:581-585`): `tags: Schema.fromJsonString(WorkflowTags)` becomes
  `tag: WorkflowTag`.
- **`WorkflowDraft`** (`:587-600`): remove `tags`. JSDoc: "at most one per workflow,
  holding the steps being edited; the tag is not drafted".
- **`WorkflowSummaryRow` / `WorkflowSummary`** (`:637-660`): inherit `tag` from
  `Workflow.fields`; JSDoc "`tags` and `stepCount`" becomes "`tag` and `stepCount`".
- **`CreateWorkflowInput`** (`:728-731`): `tags: WorkflowTags` becomes
  `tag: WorkflowTag`.
- **`UpdateWorkflowInput`** JSDoc (`:734`): "Name only: a rename is immediate. The tag
  has its own input ({@link UpdateWorkflowTagInput}) and is also immediate."
- **`UpdateWorkflowTagsInput`** (`:741-746`): rename to `UpdateWorkflowTagInput`,
  fields `{ workflowId: BoundedId, tag: WorkflowTag }`. JSDoc: lands on the workflow
  row, never the draft; runs snapshot the tag so work in flight is untouched; the next
  order to arrive matches the new tag.
- **`DuplicateWorkflowInput`** (`:748-750`): becomes
  `Schema.Struct({ workflowId: BoundedId, name: WorkflowName, tag: WorkflowTag })`.
  JSDoc: the copy's name and tag are the merchant's, prefilled by the dialog; the
  repository copies steps and stages, leaves the copy off with no draft.
- **`SeedWorkflowsInput`** (`:818-850`): workflow `tags: WorkflowTags` becomes
  `tag: WorkflowTag`; remove `tags` from the `draft` struct. JSDoc: drop "(its own tags,
  defaulting to the workflow's, and steps)" → "(steps)".
- **`WorkflowResult`**: add a `TagTaken` member alongside `NameTaken`:
  `Schema.Struct({ _tag: Schema.Literal("TagTaken"), tag: WorkflowTag, workflowName: WorkflowName })`.
  Find the union by grepping `_tag: Schema.Literal("NameTaken")`. This is the result
  type Create, Duplicate, and Rename already return, and it is what Edit tag will
  return too.
- **`ApplyResult`** (`:895-921`): remove the `TagTaken` member and the `TagTaken`
  paragraph of the JSDoc.
- **`ActivateResult`** (`:935-961`): remove the `TagTaken` member and the "`TagTaken`:
  see ApplyResult" sentence.
- Grep `Domain.ts` for any remaining `tags` that refers to a workflow (not `ShopOrder.tags`,
  not `OrderLineItem.productTags`, not the seed order's line item `tags` at `:1293`,
  which are product tags). `ItemWorkflow` and the run-side structs at `:1187` mention
  "workflows whose tags matched"; make it "whose tag matched".

### 1.2 `src/lib/ShopAgent.ts` schema (`:462-499`)

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  tag text not null unique check (tag = trim(tag) and length(tag) > 0),
  activatedAt integer,
  createdAt integer not null,
  updatedAt integer not null
);
create unique index if not exists Workflow_name_uidx
  on Workflow (name collate nocase);
```

`WorkflowDraft` loses `tags text not null default '[]'`. No other table changes.

Update the JSDoc block above the schema that describes drafts (`:324-326`: "Edit copies
the workflow's tags and steps into the draft… Apply replaces the workflow's tags and
steps") to say steps only.

## Phase 2: Repository

`src/lib/WorkflowRepository.ts`. The interface (`:225-420`) and the implementation
(`:600-1450`) both change.

### 2.1 Errors

- `WorkflowTagTakenError` (`:42-55`): keep the class. Rewrite the JSDoc: a tag another
  workflow already carries, on or off; the tag is the workflow's key and the unique
  index on `Workflow.tag` is the rule; this error exists so the merchant is told which
  field to change. Fields stay `{ tag, workflowName }`.
- `copyName` (`:109-135`): keep the function and its tests; it moves from being called
  by `duplicateWorkflow` to being exported for the Duplicate dialog's prefill (Phase 4).
  Update its JSDoc: "the name the Duplicate dialog offers".

### 2.2 Collision pre-selects

Replace `requireTagsFree` (`:860-897`) with two small helpers used by every write that
can collide. Both run inside the caller's transaction.

```ts
/**
 * Which workflow, if any, already carries `tag`, excluding `workflowId` so a
 * workflow may keep its own tag on an update. The unique index on
 * `Workflow.tag` is the guarantee; this select exists so the refusal can name
 * the holder and the merchant knows which field to change. Runs inside the
 * caller's transaction on the Durable Object's synchronous SQLite, so it
 * cannot race the write that follows it.
 */
const requireTagFree = (tag: Domain.WorkflowTag, workflowId: string | null) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      select name from Workflow
      where tag = ${tag} and (${workflowId} is null or id <> ${workflowId})
    `;
    const holder = rows[0];
    if (holder !== undefined)
      return yield* new WorkflowTagTakenError({
        tag,
        workflowName: String(holder.name) as Domain.WorkflowName,
      });
  });
```

Decode `name` through `Domain.WorkflowName` rather than casting; the snippet is the
shape, not the code. Add the symmetric `requireNameFree(name, workflowId | null)`
returning `WorkflowNameTakenError`, with `where name = ${name} collate nocase`. Then
`createWorkflow`, `duplicateWorkflow`, `updateWorkflow` (rename), and `updateWorkflowTag`
call the relevant helper(s) first and use plain `insert` / `update` (not `or ignore`).
Keep the returning-row-undefined fallback as a `WorkflowRepositoryError`, since after
the pre-select it is unreachable rather than a collision.

### 2.3 `createWorkflow` (`:1116-1135`)

Input `{ name, tag }`. Inside a transaction: limit check, `requireNameFree(name, null)`,
`requireTagFree(tag, null)`, insert `(id, name, tag, activatedAt, createdAt, updatedAt)`.
Error channel adds `WorkflowTagTakenError`. Interface JSDoc (`:233-247`): "carrying its
tag" instead of "carrying `tags`".

### 2.4 `duplicateWorkflow` (`:1137-1200`)

Input `{ workflowId, name, tag }`. Remove the `taken` names query and the `copyName`
call. Inside the transaction: `requireWorkflow(workflowId)`, limit check,
`requireNameFree(name, null)`, `requireTagFree(tag, null)`, insert the copy with the
given name and tag, copy steps as today. Error channel adds `WorkflowTagTakenError`.
Replace the interface JSDoc at `:249-262` ("Tags are deliberately not copied…") with: a
copy of the steps under a name and tag the merchant chose in the dialog; off, no draft;
both keys checked before the insert so the dialog can say which one to change.

### 2.5 `updateWorkflow` (rename, `:1201-1221`)

Switch from `update or ignore` to `requireNameFree(name, workflowId)` then a plain
`update`. Behaviour is unchanged; this is so all four key writes share one pattern.

### 2.6 `updateWorkflowTag` (replaces `updateWorkflowTags`, `:1223-1250`)

```ts
readonly updateWorkflowTag: (input: {
  readonly workflowId: string;
  readonly tag: Domain.WorkflowTag;
}) => Effect.Effect<
  Domain.Workflow,
  SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError | WorkflowTagTakenError
>;
```

Inside a transaction: `requireWorkflow`, `requireTagFree(tag, workflowId)`,
`update Workflow set tag = ${tag}, updatedAt = ${now} where id = ${workflowId} returning *`.
Does **not** call `ensureDraft`. JSDoc: immediate, like rename; runs snapshot the tag at
start so nothing in flight moves; the next order to arrive is matched against the new
tag and the current live steps, which is the re-pointing the merchant asked for.

### 2.7 Draft plumbing

- The draft insert helper (`:620-640`) drops the `tags` parameter and column.
- `ensureDraft` (`:698-720`) stops passing `tags: workflow.tags`.
- `applyDraft` (`:1330-1370`): remove the `Domain.isActive(current)` / `requireTagsFree`
  block and the `update Workflow set tags = ...` statement. Apply now touches
  `WorkflowStep` rows and deletes the draft; it should still bump `Workflow.updatedAt`
  so the detail page's "Last updated on" moves. Interface JSDoc (`:346-370`): steps
  only; remove `WorkflowTagTakenError` from the error channel.
- `setActive` (`:1256-1290`): remove the `requireTagsFree` call and its comment.
  Interface JSDoc (`:290-315`): remove the `WorkflowTagTakenError` paragraph and the
  error from the channel.
- `replaceWorkflows` (seed, `:985-1110`): insert `tag` instead of `json(workflow.tags)`;
  the draft seed stops carrying tags (`:1027`, `:1095`). Seeds are trusted fixtures, so
  a duplicate tag in a fixture should fail loudly with a `WorkflowRepositoryError`
  naming the workflow, not be silently skipped; the unique index will throw a
  `SqlError` otherwise, which is acceptable but less readable. Either is fine; say
  which in Deviations.
- Every `decodeWorkflows` / row schema that mentioned `tags` reads `tag`.

### 2.8 `src/lib/WorkflowRunRepository.ts`

- `matchesTags` (`:172-180`): rename to `matchesTag`;
  `workflow.tags.some((candidate) => candidate === folded)` becomes
  `workflow.tag === folded`. Update the two call sites at `:163` and `:1146-1147` and
  the JSDoc at `:256-258` ("another active workflow's tags also" → "tag also").
- The comment at `:1111-1112` ("the tag test runs here because tags are JSON text") is
  no longer true. The tag is now a plain column, so `countWaitingOrders` **could** push
  the match into SQL. Do not do that in this change; update the comment to say the test
  stays in TypeScript so the count and reconcile share one predicate.

### 2.9 `src/lib/ShopAgent.ts` callables and result mappers

- `workflowResult` (`:636-662`): add
  `WorkflowTagTakenError: ({ tag, workflowName }) => Effect.succeed({ _tag: "TagTaken", tag, workflowName })`
  and the error to the input channel.
- `applyResult` (`:664-712`) and `activateResult` (`:752-800`): remove the
  `WorkflowTagTakenError` branch and the error from the input channel.
- `createWorkflow` callable (`:1961-1976`): unchanged apart from the input type.
- `duplicateWorkflow` callable (`:1978-2003`): destructure `{ workflowId, name, tag }`
  and pass all three. JSDoc: "the copy is off, keeps the steps, and takes the name and
  tag the dialog collected".
- `updateWorkflowTags` callable (`:2025-2046`): rename to `updateWorkflowTag`, input
  `Domain.UpdateWorkflowTagInput`, return `Promise<Domain.WorkflowResult>` via
  `workflowResult`, not `stepResult`. JSDoc: immediate, like `updateWorkflow`.
- The JSDoc at `:2079` ("against the new steps and tags") → "against the new steps".
- Remove the now-unused `WorkflowTagTakenError` type import at `:65` if nothing else
  uses it.
- `test/integration/shop-agent-callables.test.ts:44`: `updateWorkflowTags` →
  `updateWorkflowTag` in the role table.

### 2.10 `src/lib/workflowShared.ts`

- `splitTags` (`:6-10`): delete if no caller remains (grep first).
- `workflowResultMessage` (`:12-22`): add
  `TagTaken: tagTakenMessage`.
- `itemTriggerLine` (`:46-56`): signature `(tag: string)`. Remove the empty branch and
  the list join. Body: `Starts when an order contains a product tagged “${tag}”. Orders placed before this workflow was turned on are skipped.`
  Drop "Each tag starts one workflow." (it was explaining the array).
- `tagTakenMessage` (`:62-69`): `“${tag}” is already ${workflowName}'s tag. Choose another.`
  Rewrite the JSDoc: reported under the tag field at Create, Duplicate, and Edit tag;
  names the holder so the merchant can decide whether to change this tag or go retag
  the other workflow.

### 2.11 `src/routes/api.dev.seed.ts` (`:40-50`, `:195-255`)

`tags: Domain.WorkflowTags` → `tag: Domain.WorkflowTag` on the workflow fixture; remove
`tags` from the draft fixture shape (`:44-47`, `:200-202`, `:241-243`, `:251`).

### Phase 1+2 checkpoint

`pnpm typecheck` clean except for routes, components, and tests (Phases 3 to 5).
Tell the user the schema changed and local DO state must be reset before browser
checks.

## Phase 3: Integration tests

Do this before the UI so the repository is proven.

### `test/integration/workflow-repository.test.ts`

- `tagsOf` helper (`:34-36`) → `tagOf` returning `string | null`.
- `tags` decoder (`:40`) → `tag = Schema.decodeUnknownSync(Domain.WorkflowTag)`.
- Delete "WorkflowTags trims, lowercases, dedupes, and drops blanks" (`:56-62`) and
  "WorkflowTags rejects more than the tag limit" (`:63-70`). Add "WorkflowTag trims and
  lowercases" and "WorkflowTag rejects blank and over 255".
- Every `createWorkflow({ name, tags: tags([...]) })` → `{ name, tag: tag("...") }`.
- New tests:
  - `createWorkflow` refuses a tag another workflow holds, on or off, with
    `WorkflowTagTakenError` naming the holder; the same tag in different case is the
    same tag.
  - `createWorkflow` refuses a taken name and a taken tag independently (two workflows:
    same name different tag → `NameTaken`; different name same tag → `TagTaken`).
  - `duplicateWorkflow({ workflowId, name, tag })` copies steps and stages, is off, has
    no draft, carries the given tag; refuses a taken name; refuses a taken tag.
  - `updateWorkflowTag` writes immediately, creates no draft, keeps the workflow's own
    tag allowed (updating to the current value is `Ok`), refuses another workflow's tag.
  - `setActive(true)` succeeds regardless of any other workflow's tag (there is no
    other workflow with the same tag; assert the error channel no longer includes
    `WorkflowTagTakenError` by type, and behaviourally that two active workflows with
    different tags coexist).
  - `applyDraft` on an active workflow no longer touches the tag: set a tag, edit a
    step, apply, tag unchanged.

### `test/integration/shop-agent-workflows.test.ts`

- `tagsOf` (`:28-30`) → `tagOf`.
- Every `createWorkflow({ name: "W", tags: [] })` needs a tag now; use a per-test
  distinct tag (`"w"`, `"engrave"`, etc.). There are many (`:152, :160, :244, :260, :282,
:290, :354, :528, :608, :655-658, :707, :754, :827, :910`). Where two workflows are
  created in one test, give them different tags.
- The test at `:349-440` ("createDraft / applyDraft / … / updateWorkflowTags map
  failures to results"): replace the `updateWorkflowTags` sections with
  `updateWorkflowTag` returning `WorkflowResult`; drop the assertions that the draft
  carries the tag (`:420-424`); assert the workflow carries it immediately.
- The test at `:655-710` (TagTaken at Turn on and Apply): rewrite as "createWorkflow
  and updateWorkflowTag refuse a tag another workflow holds and name it", and add
  "setWorkflowActive never returns TagTaken".
- `:438`: `updateWorkflowTag({ workflowId: "nope", tag: "x" })` → `NotFound`.
- `:445`: excess-property check keeps working with `{ name, tag, extra }`.

### `test/integration/workflow-run-repository.test.ts`

- `tags` decoder (`:53`) → `tag`. Every `tags: tags([x])` → `tag: tag(x)` (`:178, :207,
:379, :1258, :2388, :2410`). The fixture at `:92` (`tags: []`) needs a real tag.
- `matchesTags` → `matchesTag` where imported.
- The ambiguity tests (two workflows matching one item) still work: they use two
  different tags on one product, which is the only way ambiguity can now arise.

### Other tests

`domain.test.ts:22`, `member-queue-socket.test.ts:67,152`,
`shop-agent-orders-stream.test.ts:186,273`, `shopify-webhook.test.ts:375`: `tags: []` /
`tags: [...]` on a workflow → `tag: "..."`. `order-repository.test.ts:63` and
`shop-agent-orders-stream.test.ts:76` are `ShopOrder.tags`; leave them.

### Phase 3 checkpoint

`pnpm test` green for `test/integration`. Routes still fail typecheck.

## Phase 4: Detail page, index, and the tag dialog

### 4.1 `src/components/WorkflowTag.tsx`

Rewrite around one field, immediate save, `WorkflowResult`. Keep
`PolarisModal.useModalBackdropDismissGuard(MODAL)` and the "working value survives an
unexpected dismissal" behaviour. Remove `expanded`, `selection`, `input`, `add`, the
Enter listener, `defaultOpen`, `onClose`, and the expanded-state JSX.

```ts
export function WorkflowTag({
  tag,
  disabled,
  onSave,
}: {
  readonly tag: string;
  readonly disabled: boolean;
  /** Resolves with the result; `TagTaken` and others render under the field. */
  readonly onSave: (tag: string) => Promise<Domain.WorkflowResult>;
});
```

- Renders: an `s-chip` with the tag, an `Edit tag` `s-button` opening the modal.
- Modal heading `Edit tag`. Body paragraph: "Put this tag on the products this workflow
  should build, in Shopify. Changing it here changes nothing on your products." One
  `s-text-field` labelled `Tag`, `maxLength={255}`, value is the working text,
  `error` set from the last failed save. Footer: Cancel; Save (primary), disabled when
  `disabled`, saving, blank after fold, or unchanged after fold.
- Save: fold `trim().toLowerCase()`, `Schema.decodeUnknownSync(Domain.WorkflowTag)`,
  call `onSave`, then `workflowResultMessage(result)`; null closes the modal and resets,
  a string becomes the field error. Keep the `try/catch` for thrown transport errors.
- JSDoc: one field because a workflow has one tag; immediate because runs snapshot the
  tag and the unique index reports collisions at the write; the message is placed under
  the field so the merchant knows which of the two keys to change.

### 4.2 `src/routes/app.workflows.$workflowId.tsx`

- Remove `shownTags` (`:212`); the tag is never drafted, so both tabs show
  `workflow.tag`.
- Header accessory badge (`:238-240`): `<s-badge slot="accessory">{workflow.tag}</s-badge>`,
  unconditional.
- Trigger card (`:326-353`): keep the `Tag` strong text and the chip. Replace the
  `Edit tag` button that calls `editor.open(workflowId, "&tag=edit")` with the
  `WorkflowTag` component:

  ```tsx
  <WorkflowTag.WorkflowTag
    tag={workflow.tag}
    disabled={!identified}
    onSave={(tag) =>
      call((stub) => stub.updateWorkflowTag({ workflowId, tag }))
        .then(decodeWorkflowResult)
        .then(async (result) => {
          if (result._tag === "Ok") await invalidate();
          return result;
        })
    }
  />
  ```

  The chip inside the component replaces the chip in the card; do not render two.
  `itemTriggerLine(workflow.tag)`.

- `turnOnBody` (`:57-63`): `workflow.tags.length === 0` branch goes; the sentence uses
  `“${workflow.tag}”`.
- **Duplicate becomes a dialog.** Add `DUPLICATE_MODAL = "duplicate-workflow"`, state
  `copyName`, `copyTag`, `copyTagDirty`, `copyNameError`, `copyTagError`. The More
  actions `Duplicate` button (`:264-273`) becomes `commandFor={DUPLICATE_MODAL} command="--show"`.
  On show, seed `copyName` from `copyName(workflow.name, [])` (import from
  `@/lib/WorkflowRepository`; if that import drags server code into the client bundle,
  move `copyName` to `src/lib/workflowShared.ts` and note it in Deviations) and
  `copyTag` from the folded copy name; mirror name → tag until the tag is touched, the
  same rule as the create dialog (`app.workflows.index.tsx:172-184`; extract the mirror
  into a small hook in `workflowShared.ts` or duplicate the four lines, your call, say
  which). Modal heading `Duplicate workflow`, fields `Name` (maxLength 64) and `Tag`
  (maxLength 255, details "Put this tag on the products the copy should build."),
  Cancel, `Duplicate` primary disabled when either is blank. `duplicateMutation` sends
  `{ workflowId, name, tag }`; on `NameTaken` set `copyNameError`, on `TagTaken` set
  `copyTagError`, otherwise existing behaviour (toast "Copied to …", navigate to the
  copy's editor).
- Remove `import * as WorkflowTag` from the editor route once 4.3 is done and add it
  here.

### 4.3 `src/routes/app.workflows.$workflowId_.edit.tsx`

- Remove the `tag` search param from `validateSearch` (`:98-112`) and its JSDoc; keep
  `chrome`. Remove `tagSearch` from `Route.useSearch()` (`:142`).
- Remove `tagsMutation` (`:264-273`), the `tags` derivation (`:454`), the
  `tagsMutation.isPending` term in `busy` (`:465`), and the `WorkflowTag` element in the
  trigger card (`:728-746`). The trigger card keeps the `Tag` strong text, adds an
  `s-chip` with `workflow.tag`, and `itemTriggerLine(workflow.tag)`. No edit affordance
  in the editor; the editor is about steps.
- `applyResultMessage` (`:61-69`): remove `TagTaken`.
- The Duplicate button in the editor's actions (`:676-686`): the editor runs inside an
  `s-app-window` where a second modal is awkward. Simplest: remove Duplicate from the
  editor's menu; the detail page has it. Note in Deviations if you keep it.
- `src/lib/workflowEditorWindow.ts:40-50`: the JSDoc sentence about `tag=edit` goes;
  if `open(workflowId, extraSearch)` has no other caller passing search, simplify its
  signature.

### 4.4 `src/routes/app.workflows.index.tsx`

- Create dialog: `createWorkflow({ name, tag })` (`:144`). The `Create` primary button
  is disabled when `tag.trim().length === 0` as well as when the name is blank. Add
  `tagError` state, rendered as the tag field's `error`; on `TagTaken` set it, on
  `NameTaken` set `nameError` (today `workflowResultMessage` goes to a banner; route
  by `_tag` instead). Field `details` stays.
- Table cell (`:278-286`): `<s-badge>{workflow.tag}</s-badge>`, no empty branch, no
  `+N`.
- JSDoc at `:24-31` and `:98-104`: still accurate; reread and trim any mention of
  "tags".

### 4.5 `src/components/WorkflowSwitch.tsx`

`activateResultMessage` (`:50-60`): remove `TagTaken: tagTakenMessage` and the import
if unused. The JSDoc at `:22-30` does not mention tags; leave it.

### 4.6 `src/routes/app.orders.$orderId.tsx`

The ambiguity sentence (`:150-160`) names workflows: "Two workflows match this item:
Engraving and Rush. Choose one." Extend it to name the tags, since the research doc
promises it and the data is now one string per workflow:
`Two workflows match this item: Engraving (“engraving”) and Rush (“rush”). Choose one.`
Requires the matched workflows' tags at that call site; if only names are available
there, leave the sentence and record it in Deviations.

`:1494` "No workflow's product tags match the items in this order." is from the
order's side and stays.

### Phase 4 checkpoint

`pnpm typecheck`, `pnpm lint`, `pnpm fmt`, `pnpm test` all clean. Then, with the user
told and local state reset (`pnpm d1:reset`, restart, `pnpm seed`), a headed
`pnpm playwright-cli` pass, waiting for `data-hydrated` / `data-app-interactive`:

1. Create "Engraved ring": tag mirrors to `engraved ring`; clear it, Create is disabled;
   type `engraving`, Create; detail page shows the `engraving` badge and chip.
2. Create another workflow with tag `engraving`: error under the Tag field names
   "Engraved ring". Change the tag, Create succeeds.
3. Detail page Edit tag: set to `engrave`, Save; badge, chip, and trigger line update;
   no Draft tab appears. Set it to the other workflow's tag: error under the field,
   modal stays open.
4. Duplicate from More actions: dialog prefilled "Engraved ring copy" / `engraved ring
copy`; change the tag to a taken one: error under the Tag field; fix it; lands in the
   copy's editor; the copy is Off.
5. Turn on both workflows; both go Active; no tag message anywhere.
6. Editor trigger card shows the chip and no Edit tag button.

## Phase 5: End-to-end tests

- `e2e/fixture.ts`: workflow entries `tags: [TAG.x]` → `tag: TAG.x` (`:113, :129, :143,
:160, :182, :195, :201`); the helper at `:217` (`tags: tag === null ? [] : [tag]`)
  takes a required tag. `e2e/seed.ts` likewise if it shapes workflow fixtures.
- `e2e/workflows.spec.ts`:
  - `:78`, `:268`, `:335`, `:341`: `tags: [...]` → `tag: "..."`.
  - `:92-104` (create dialog tag mirror) stays.
  - `:116-125` (Edit tag from the editor's trigger card): move to the detail page.
    After Create the test lands where? Follow the current flow: if it lands in the
    editor, close the window first, then `Edit tag` on the detail page, fill, Save,
    assert the chip and that no Draft tab appears.
  - The test at `:312-360` ("turning on a workflow whose tag another active workflow
    holds is refused"): delete. Its premise (two workflows sharing a tag while one is
    off) is no longer representable. Replace with "creating a workflow with a taken tag
    is refused under the field and names the holder", seeded with one workflow.
  - Add "duplicate asks for a name and a tag, and the copy is off with the given tag".
- `e2e/orders.spec.ts`, `e2e/member-queue.member.spec.ts`, `e2e/teams.spec.ts`: grep
  `tags:` on workflow fixtures and convert; line-item `tags` are product tags and stay.

Run `npm run test:e2e --` against a seeded local shop.

## Phase 6: Docs and JSDoc sweep

- `docs/workflow-tag-identity-research.md`: set the status line to done and fold the
  Deviations section below into it as a short "Decisions from implementation" list.
- Grep `src/` for `product tag` in JSDoc referring to the workflow's field, `tags` on a
  workflow, `TagTaken` in Apply/Turn on comments, `Manage tags`, `Edit tag` in the
  editor, and `maxTags`. Fix each.
- `docs/workflow-tags-concept-and-ux-research.md` and
  `docs/workflow-per-item-cardinality-research.md`: add a one-line note at the top
  pointing at the identity research doc as the superseding source for tags. Do not
  rewrite them.

## Not in scope

- Dropping `WorkflowDraft.updatedAt` and `WorkflowRun.updatedAt` (research doc says
  separate cleanup).
- Pushing the tag match into SQL in `countWaitingOrders`.
- A product metafield alternative.
- Any change to `multiple_workflows` handling beyond the copy in 4.6.
- Any change to `OrderLineItem.productTags`, `ShopOrder.tags`, or `OrderSync`.

## Deviations

To be filled in by the implementing agent. One bullet per departure from this plan,
with the file, what the plan said, what was done instead, and why. Include "none" for a
section only if you checked. Reviewed before the research doc is updated.

- Phase 1: none.
- Phase 2: `copyName` and `MAX_NAME_LENGTH` moved from `WorkflowRepository` to
  `workflowShared.ts` so the Duplicate dialog can import the prefill without pulling the
  Effect SQL layer into the client bundle; the repository no longer mints copy names.
  `replaceWorkflows` refuses a fixture whose two workflows claim one tag with a
  `WorkflowRepositoryError` naming both, rather than letting the unique index throw.
- Phase 3: none beyond the plan's list; the tests that only asserted the draft carried a
  tag were dropped rather than rewritten, since the draft has no tag to assert.
- Phase 4: the Duplicate dialog's name → tag mirror is written inline in the detail page
  (three pieces of state in one object) rather than extracted into a hook. The ambiguity
  sentence in `app.orders.$orderId.tsx` names the tags, as the research doc promised —
  `itemWorkflows` is `Workflow[]`, so the tags were already at the call site.
  `useWorkflowEditorWindow.open` lost its `search` parameter with the `?tag=edit` link.
- Phase 5: `e2e/workflows.spec.ts` gained three tests rather than two — the Create
  refusal, Duplicate, and Edit tag from the detail page — because Edit tag moved pages
  and needed its own case. The old Turn-on refusal test is deleted.
- Phase 6: none.
- Review (after implementation): `ShopAgent.updateWorkflowTag` now calls
  `reconcileAllIfActive` and publishes, as Apply and the coverage-date change do; the plan
  had it as a bare write. `workflowResult` carries the reconcile faults so the type
  lines up with `applyResult`. Test: "retagging an on workflow reconciles stored orders
  against the new tag" in `test/integration/shop-agent-workflows.test.ts`.
