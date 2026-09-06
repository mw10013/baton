# Workflow tables: one table with `scope`, or separate tables? — research

Research date: 2026-09-06. Follows `order-workflow-research.md` (Decisions 2026-09-04) and `order-workflow-spec.md`, which introduced `Workflow.scope` and left the storage shape unexamined. The question here is narrower: should the singleton order workflow keep living in the `Workflow` table next to line-item workflows, or move to its own table(s)?

## Short answer

Keep one table. The two kinds differ in **one column** (`tags`) and **one cardinality rule** (at most one active order workflow). Everything else — steps, stages, drafts, draft steps, team pointers, `active`, rename, delete, Apply/Discard, the team page's owned-steps list, the seed's `replaceWorkflows`, and the run instantiation that copies steps — is identical and would have to be duplicated across four new tables and every query that touches them. The split buys a schema that says "order workflows have no tags" instead of a two-line repository check, and costs roughly a second copy of the draft/step machinery. That is a bad trade at every scale this app will reach.

What _is_ worth doing is small: make the discrepancy legible in the type system (a `WorkflowSummary` / `WorkflowDetail` whose order variant has no `tags` field), and move the one-active-order-workflow rule from a `select` in the repository into a partial unique index so it holds under every write path, not only the ones that remember to call `requireOrderWorkflowSlot`.

## What is actually shared today

From `initializeSchema` (`src/lib/ShopAgent.ts`) and `WorkflowRepository`:

| Table               | Columns that differ by scope   | Everything else                                                              |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `Workflow`          | `tags` (always `[]` for order) | `id`, `name` (unique nocase), `scope`, `active`, `createdAt`, `updatedAt`    |
| `WorkflowStep`      | none                           | position, stage, name, teamId, instructions, `unique (workflowId, position)` |
| `WorkflowDraft`     | `tags` (always `[]` for order) | `workflowId` pk, timestamps                                                  |
| `WorkflowDraftStep` | none                           | same as `WorkflowStep`                                                       |

Behaviour that reads `scope` (the whole list; everything not here is scope-blind):

| Site                                                                           | What it does with scope                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `WorkflowRepository.createWorkflow`, `setTags`, draft Apply                    | refuse tags when `scope = 'order'` (`requireNoTagsForOrderScope`)    |
| `createWorkflow`, `setActive`                                                  | refuse a second (active) order workflow (`requireOrderWorkflowSlot`) |
| `replaceWorkflows` (seed)                                                      | same two invariants, checked on the fixture                          |
| `listOwnedSteps` (team page)                                                   | picks the detail route (`/app/workflows` vs `/app/order-workflow`)   |
| `WorkflowRunRepository` trigger, `ShopAgent.readOrderDetail`, `attachWorkflow` | `workflows.find(scope === 'order')` / `filter(scope === 'item')`     |
| `app.workflows.index`, `app.workflows.$workflowId`, `app.teams.$teamId`        | hide the tags field / trigger copy / route                           |

Eleven touch points, all of them "branch on a field". None of them is a query that would get simpler with a second table; several (`listActiveWorkflowDetails`, the run trigger's `RoutingContext`, `listOwnedSteps`) would become a `union all` or two round trips.

## Option A — keep one `Workflow` table with `scope` (status quo)

**Pros**

- Steps, drafts, draft steps, layout writes (`writeLayout`'s scratch-position dance), team unassignment, delete cascade, and the owned-steps union are written once. `WorkflowRepository` is already 1,416 lines; the draft machinery is the bulk of it.
- One `WorkflowId` namespace. `WorkflowRun.workflowId`, `WorkflowRunStep`, `SyncState.workflowId`, `OwnedStep.workflowId`, and every route param stay a single type. Runs are scope-blind by design (they snapshot steps and names), so nothing on the instance side wants to know which table the definition came from.
- The name uniqueness index (`Workflow_name_uidx`) spans both kinds for free. A merchant cannot have an item workflow and the order workflow both called "Packing", which is what the UI wants since both appear on the team page and in run cards by name.
- Seed, fixtures, and `replaceWorkflows` stay one shape.
- Every future scope (`order`-at-paid, per-unit, a second order workflow per channel — all listed in `order-workflow-research.md` Part 5) is a new literal in `WorkflowScope`, not a fifth and sixth table.

**Cons**

- `tags` is a column that is semantically absent for one row. The schema cannot say so; `requireNoTagsForOrderScope` says it in three places and `replaceWorkflows` in a fourth.
- `Domain.Workflow` carries `tags: ProductTags` for the order workflow too, so UI code has to remember to hide the field (`app.workflows.index.tsx:391`, `app.workflows.$workflowId.tsx:517`) rather than being unable to render it.
- The one-active-order-workflow rule lives in the repository as a `select … limit 1` and is only as good as the call sites that invoke it. Today `createWorkflow` and `setActive` do; a future write path (import, duplicate, un-delete) could forget.
- A reader of the DDL has to read the JSDoc to learn that `scope = 'order'` is a singleton.

## Option B — separate tables (`OrderWorkflow`, `OrderWorkflowStep`, `OrderWorkflowDraft`, `OrderWorkflowDraftStep`)

**Pros**

- Schema states the discrepancy: `OrderWorkflow` has no `tags` column. `id integer primary key check (id = 1)` (the `SyncState` pattern) states the singleton, and `active` becomes a plain column with no cross-row rule.
- `Domain.OrderWorkflow` naturally has no `tags`; the order-workflow routes and forms cannot show a tags field by construction.
- Queries scoped to one kind never need `where scope = …`.

**Cons**

- Four new tables that are column-for-column copies of the existing four minus `tags`. `WorkflowStep` and `WorkflowDraftStep` are already duplicated once (for the step-id-cannot-be-ambiguous reason in the schema JSDoc); this doubles that again.
- `WorkflowRepository` splits or gains a table-name parameter for: `createWorkflow`, `rename`, `delete`, `setActive`, `startDraft`, `applyDraft`, `discardDraft`, `addStep`, `updateStep`, `removeStep`, `writeLayout`, `unassignTeam`, `listOwnedSteps`, `listActiveWorkflowDetails`, `replaceWorkflows`, plus the decoders. SQL template literals cannot parameterize table names, so this is either two copies of each query or a code-generation helper that builds SQL fragments per side — the exact thing the codebase avoids.
- `WorkflowRun.workflowId` now points into one of two tables. Nothing joins through it today (runs are self-sufficient), but `SyncState.workflowId`, `OwnedStep`, the team page, and the queue's "workflow name" all currently share one id type; they would need a discriminated pair or a convention like a scope prefix in the id.
- Name uniqueness across the two kinds needs an application check (or a shared name table), replacing one repository rule with another.
- `unassignTeam` on team delete runs against six step tables instead of four; every future step-shaped concern (per-step SLA, step colour, whatever) lands in four places.
- Seed fixtures, `replaceWorkflows`, Playwright helpers, and tests fork.
- The singleton `check (id = 1)` trick fixes `id`, so the order workflow's id is no longer a `WorkflowId` and every consumer of run rows (`workflowId text not null`) needs a sentinel or a nullable column.
- Rough size, going by the draft spec's line counts: 300–500 lines of duplicated SQL and repository code plus a second set of route files or a table-name switch inside the existing ones. Every future draft/step change costs double, permanently.

## Option C — one table, plus schema-level enforcement (recommended refinement)

Keep Option A's shape and close its two real gaps in SQL:

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  scope text not null default 'item' check (scope in ('item', 'order')),
  active integer not null default 0 check (active in (0, 1)),
  tags text not null default '[]'
    check (scope = 'item' or tags = '[]'),
  createdAt integer not null,
  updatedAt integer not null
);
-- at most one order workflow (any state); the slot is freed by delete
create unique index if not exists Workflow_order_uidx
  on Workflow (scope) where scope = 'order';
```

Two notes on the index:

- `order-workflow-research.md` chose a repository `select` over a partial unique index because "the error is unfriendly". That is true of the raw SQLite error, but `requireOrderWorkflowSlot` can stay as the pre-check that produces `OrderWorkflowExistsError`, with the index as the backstop for any path that skips it. Same pattern as `unique (lineItemId, workflowId)` on runs, where `on conflict do nothing` is the idempotency and the repository still reports a typed result.
- The spec's rule is "at most one **active** order workflow", so a second inactive one is allowed today. If that leniency is wanted, the index becomes `on Workflow (scope) where scope = 'order' and active = 1` and `createWorkflow` stops refusing a second inactive one. There is no product reason for two order workflows to exist inactive at once (the page is `/app/order-workflow`, singular), so the simpler "at most one, any state" index is the recommendation — and matches the working-tree routes that treat it as a singleton page.

`WorkflowDraft.tags` gets the same check via a join-free rule in the repository (`requireNoTagsForOrderScope` on draft Apply, already present) — SQLite `check` cannot reference another table, and the draft's tags only matter at Apply, which is where the `Workflow` check fires.

On the TypeScript side, make the shape honest without touching storage:

```ts
export const ItemWorkflow = Schema.Struct({
  ...common,
  scope: Schema.Literal("item"),
  tags: Schema.fromJsonString(ProductTags),
});
export const OrderWorkflow = Schema.Struct({
  ...common,
  scope: Schema.Literal("order"),
});
export const Workflow = Schema.Union([ItemWorkflow, OrderWorkflow]);
```

decoded from the same row (the decoder drops `tags` for order scope). Then `workflow.tags` is a type error on the order branch, the index and detail pages narrow on `scope`, and the three `requireNoTagsForOrderScope` calls shrink to the create path only (the update/Apply paths cannot be handed tags for an order workflow because the input type has none). This is the change that addresses the "biggest discrepancy" the question is about, and it costs a union and a decoder branch rather than four tables.

## Trade-off summary

| Concern                                    | A: one table + `scope` | B: separate tables               | C: A + check/index + TS union                                |
| ------------------------------------------ | ---------------------- | -------------------------------- | ------------------------------------------------------------ |
| "Order workflow has no tags" stated in     | repository (×3)        | schema                           | schema + types                                               |
| "At most one order workflow" stated in     | repository (×2)        | schema (`check (id = 1)`)        | schema (partial unique index)                                |
| Step/draft machinery                       | once                   | twice                            | once                                                         |
| `WorkflowId` / `WorkflowRun.workflowId`    | one type               | two tables, needs discrimination | one type                                                     |
| Name uniqueness across kinds               | free (index)           | application rule                 | free (index)                                                 |
| Cost of a future step/draft feature        | 1×                     | 2×                               | 1×                                                           |
| Cost of a future scope (Part 5 expansions) | one literal            | two–four more tables             | one literal                                                  |
| UI can accidentally render tags for order  | yes                    | no                               | no (type error)                                              |
| Migration                                  | none                   | data move + id decision          | none (prototype: edit `initializeSchema`, reset local state) |

## When separate tables _would_ be right

For completeness, the split earns its keep if the order workflow diverges in **structure**, not just in one column:

- order-workflow steps get fields item steps never have (e.g. a carrier, a packing-slip template, a shipment-level SLA), **and**
- item workflows stop sharing the draft/Apply model, **or**
- the order workflow stops being a singleton and starts being selected by something other than "every paid order" (channel, market, tag) — at which point it is just another `scope` anyway.

None of those is on the Part 5 list. If the first one arrives, the cheaper move is still a nullable column or a 1:1 side table keyed by `workflowId`, not a parallel definition tree.

## Recommendation

1. **Do not split.** Keep `Workflow`/`WorkflowStep`/`WorkflowDraft`/`WorkflowDraftStep` shared, `scope` as the discriminator.
2. **Add the two SQL rules** from Option C to `initializeSchema`: `check (scope = 'item' or tags = '[]')` and `Workflow_order_uidx`. Keep `requireNoTagsForOrderScope` / `requireOrderWorkflowSlot` as the typed-error pre-checks; the SQL is the backstop.
3. **Make `Domain.Workflow` a union** on `scope` so the order variant has no `tags`; narrow `WorkflowSummary` / `WorkflowDetail` / `CreateWorkflowInput` the same way. This removes the UI's "remember to hide tags" branches and two of the three repository tag checks.
4. **Decide singleton strictness** while doing (2): recommend "at most one order workflow in any state", matching the singular `/app/order-workflow` route in the working tree, and amend the spec's "one **active**" wording.
5. Update the `initializeSchema` JSDoc's `Workflow` paragraph to say why the rows share a table (one column and one cardinality rule differ; steps and drafts are identical), so the next reader does not reopen this.

Estimated size: ~60 lines (schema check + index + union + decoder + narrowing), no new files, no data migration in the prototype.

## Decisions (2026-09-06, mw)

Option C, implemented the same day:

- `Workflow.tags` carries `check (scope = 'item' or tags = '[]')`; `Workflow_order_uidx` is a partial unique index on `scope where scope = 'order'`. Prototype rule: edited in place in `initializeSchema`, local Durable Object state wiped.
- Singleton strictness: **at most one order workflow in any state**. `setWorkflowActive` no longer checks a slot and `ActivateResult` lost its `OrderWorkflowExists` member. (`order-workflow-spec.md` said "one active"; that doc has since been removed from `docs/`, so the schema JSDoc is the record.)
- `Domain.Workflow` is `Schema.Union([ItemWorkflow, OrderWorkflow])`; the order variant has no `tags` field. `WorkflowSummary` and `CreateWorkflowInput` are unions the same way, and `Domain.isItemWorkflow` narrows any workflow-shaped value. The item index and the run matcher narrow on it; the order route no longer sends `tags: []`.
- `requireNoTagsForOrderScope` survives only in `updateWorkflowTags`, the one write that takes tags for a workflow whose scope the input cannot know. Create is typed; Apply copies a vetted draft; SQL backstops all three.
- `SeedWorkflowsInput` keeps its flat shape with `tags` required and the repository's fixture checks, since a fixture is untyped merchant-facing data by design.
