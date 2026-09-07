# `scope` → `type`, and the Workflows page — implementation plan

Plan date: 2026-09-06. Implements the settled decisions in `workflow-naming-research.md` (Questions 3, 5 and 7) and the placement decision recorded in its companion mockup artifact. Assumes `7b7ab34`, which shipped the order-run trigger copy and the stranded-order sweep, is already in.

## What this plan implements

| Decision                                                   | Source                       | Shape                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow.scope` becomes `Workflow.type`                   | naming research §5           | Field, schema, SQL column, and every read site. Literal values `"item"` / `"order"` are unchanged.                               |
| One `Workflows` nav entry, two stacked sections            | naming research §3, option B | The order workflow gets a compact section **above** the item-workflow list. They share no table, no filter and no create button. |
| The item list gains the heading **Item workflows**         | naming research §2, §3       | The only place in the app the qualifier appears.                                                                                 |
| The order workflow adopts the item-workflow detail pattern | naming research §3, piece 3  | Read-only detail page plus a separate editor route. `WorkflowDetail.tsx` is retired.                                             |
| The queue's **No workflow** badge becomes **No steps**     | naming research §7           | One string. No definition word on the worker's surface.                                                                          |

Settled in review, and not to be relitigated during implementation:

- **Create**: a second modal, matching `Create workflow`. Never one button that asks which kind — that ambiguity is what made the earlier combined page confusing.
- **Delete**: on the detail page only, matching item workflows. The index gets no destructive control.
- **Schema**: edit migration `1_initialize schema` in place. No second migration. This requires a wipe — see Preconditions.

## Preconditions

The `Workflow` table is created by `SqliteMigrator` in `ShopAgent.initializeSchema` under the key `"1_initialize schema"` (`src/lib/ShopAgent.ts:210`, `:367`). A Durable Object that has already applied migration 1 records it as done, so **editing migration 1 does not re-run it** — that object keeps a `Workflow` table with a `scope` column, and every query naming `type` fails at runtime.

- **Local**: `pnpm d1:reset` removes `.wrangler` recursively (`scripts/d1-reset.ts:130`), which takes local Durable Object storage with it. Then `pnpm seed`. This is the whole story locally.
- **Deployed**: settled 2026-09-07 — nothing is deployed, this is a prototype, and every ShopAgent starts from scratch. There is no migration 2 and no further discussion of one.

## Stage 1 — `scope` → `type`

Mechanical, self-verifying through `pnpm typecheck`, and worth its own commit so the UI stages review cleanly.

### The trap: three unrelated meanings of "scope"

`scope` appears about 180 times across `src`, `test`, `e2e` and `scripts`, and most of them are **not** this field. Do not blanket-replace.

| Meaning                   | Where                                                                                                                                                                                                                        | Action           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Shopify OAuth scopes      | `Domain.ShopSession.scope` (`Domain.ts:139`), `src/lib/Shopify.ts`, `webhooks.app.scopes_update.ts`, `privacy.tsx`, `admin.shop.$shop.tsx`, and the auth / offline-refresh / webhook / subscription-plan / member-area tests | **Leave alone.** |
| Ordinary English          | `Domain.ts:298` "shop-scoped", `:348` "Teams are what scope work", `app.teams.index.tsx:225` "scoped to them", `shop.$shop.queue.tsx:51` "scope is enforced"                                                                 | **Leave alone.** |
| The workflow discriminant | everything below                                                                                                                                                                                                             | Rename.          |

**The rule that separates them:** rename only where the value domain is `"item" | "order"`. Every site that fails that test is one of the other two meanings.

### Sites

| File                                | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/Domain.ts`                 | `WorkflowScope` → `WorkflowType` (const and type). The `scope` field on `ItemWorkflow`, `OrderWorkflow`, `CreateWorkflowInput` (both union members), `SeedWorkflowsInput.workflows[]`, and `OwnedStep`. The `isItemWorkflow` constraint and its `Extract`. `ItemWorkflowSummary`'s `Extract<…, { scope: "item" }>`. `WorkflowSummaryRow` / `WorkflowSummary` inherit through `.fields` and need no edit. The `WorkflowScope` JSDoc — now the authority on the whole order-run trigger rule — moves with the rename. |
| `src/lib/ShopAgent.ts`              | The column in `create table Workflow`, the check constraint `check (scope = 'item' or tags = '[]')` (`:277`), the partial unique index predicate `on Workflow (scope) where scope = 'order'` (`:284`, index name `Workflow_order_uidx` stays), `sweepOrderRuns`'s guard, `:1865`, and the JSDoc at `:183`.                                                                                                                                                                                                          |
| `src/lib/WorkflowRepository.ts`     | ~25 sites: `requireOrderWorkflowSlot`'s `where scope = 'order'` (`:604`), `requireNoTagsForOrderScope` (`:632` — rename the function too), `getOrderWorkflow` (`:972`), `replaceWorkflows` (`:1046`, `:1056`), `createWorkflow` / `duplicateWorkflow` (`:1131-1158`), `listOwnedSteps`.                                                                                                                                                                                                                             |
| `src/lib/WorkflowRunRepository.ts`  | `workflows.find(({ workflow }) => workflow.scope === "order")` in `startOrderRunIfReady` and `startReadyOrderRuns`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/routes/api.dev.seed.ts`        | The optional key and its two pass-throughs (`:40`, `:171`, `:221-223`).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Routes                              | `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`, `app.workflows.$workflowId_.edit.tsx`, `app.order-workflow.index.tsx`, `app.order-workflow.$workflowId.tsx`, `app.teams.$teamId.tsx:206`. Several of these files are deleted or rewritten in Stages 2–3; rename them anyway so Stage 1 stands alone and typechecks.                                                                                                                                                                                     |
| `src/lib/Domain.ts` loader-data     | The JSDoc on `WorkflowsIndexLoaderData` and `WorkflowLoaderData` says "item scope only" and points at `/app/order-workflow`; rewrite to the merchant nouns now. `OrderWorkflowIndexLoaderData` and `OrderWorkflowLoaderData` are deleted in Stages 2–3 with their routes.                                                                                                                                                                                                                                           |
| `src/components/WorkflowDetail.tsx` | 4 sites. Deleted in Stage 2; rename for the same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tests                               | `workflow-repository.test.ts` (~20), `workflow-run-repository.test.ts` (~7), `shop-agent-workflows.test.ts` (~6), `orders-sync-workflow.test.ts` (1).                                                                                                                                                                                                                                                                                                                                                               |
| `e2e/seed.ts`                       | The `scope?: "item" \| "order"` field and its JSDoc (`:73-76`).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Naming inside the rename

- `WorkflowScope` → `WorkflowType`. Nothing else in `Domain.ts` is called `WorkflowType`, so there is no collision.
- `requireNoTagsForOrderScope` → `requireNoTagsForOrderType` (or `…ForOrderWorkflow`, which reads better and is what it actually checks).
- Comments and JSDoc that say "item scope" / "order scope" become "item workflow" / "the order workflow" — the merchant nouns, per the naming research. That is the point of the rename, not a side effect of it.

### Verify

`pnpm typecheck && pnpm lint && pnpm test`, then `pnpm d1:reset && pnpm seed` and load `/app/workflows`. `pnpm graphql-codegen` is not needed — no `#graphql` literal is touched.

## Stage 2 — one detail route pair for both kinds

### Where things stand

`d13f89a` gave item workflows a read-only detail page plus a separate editor and left the order workflow behind:

|                          | Route                             | Component                                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| Item workflow, read      | `/app/workflows/$workflowId`      | `WorkflowStages.tsx` (`StageFlow`, `AttentionBanner`, `TeamLine`)             |
| Item workflow, edit      | `/app/workflows/$workflowId/edit` | same                                                                          |
| The order workflow, both | `/app/order-workflow/$workflowId` | `WorkflowDetail.tsx` — read and edit on one surface, imported by nothing else |

### Approach: unify, do not duplicate

Both server reads are already type-blind: `ShopAgent.listWorkflows` (`:1418`) and `ShopAgent.getWorkflowDetail` (`:1445`) neither filter nor branch, and `Domain.WorkflowDetailView` is one shape for both kinds. So `/app/workflows/$workflowId` and `/app/workflows/$workflowId/edit` can serve the order workflow as-is, with two branches:

1. **The trigger box.** `StageFlow` already takes a `trigger` node; the detail page passes a dashed box headed "Product tag" with `itemTriggerLine(tags)`. For the order workflow it passes `ORDER_WORKFLOW_TRIGGER` under a different heading — "Trigger", or "When it runs". One ternary on `workflow.type`.
2. **The tags editor.** Renders only for `type === "item"`. The type already guarantees this: `OrderWorkflow` has no `tags` key at all, so the branch is a narrowing, not a runtime check.

Then delete `app.order-workflow.$workflowId.tsx`, `src/components/WorkflowDetail.tsx` and `Domain.OrderWorkflowLoaderData`. No redirect from the old URL: nothing is deployed, so there is no old URL anyone holds.

**The two guards that bounce the order workflow away must go.** Both item routes currently render a stub — "This is an order workflow. Open in Order workflow" — when the loaded workflow is the order one (`app.workflows.$workflowId.tsx:214-226`, `app.workflows.$workflowId_.edit.tsx:370-380`). Delete both guards along with the JSDoc that explains them.

**Update the shipped links.** `7b7ab34` put three merchant-facing messages on the order detail page that link to `/app/order-workflow/${workflow.id}` — the "is off", "no steps" and "step with no team" blockers (`app.orders.$orderId.tsx:477`, `:487`). Point them at `/app/workflows/${workflow.id}`.

**What this also removes:** `OwnedStep.type` exists only so the team page can pick between two detail routes (`app.teams.$teamId.tsx:206`). With one route it has no readers, so drop the field in this stage — from the `Domain.OwnedStep` schema and its JSDoc, the `select` in `listOwnedSteps`, and the assertions in `workflow-repository.test.ts`. A renamed field with zero readers is worse than no field.

**Alternative considered:** keep `/app/order-workflow/$workflowId` and add a sibling `/edit` route. Rejected — it duplicates two loaders and two page shells to express a difference that is one ternary, and it leaves the nav-level split this whole effort is removing.

### Verify

The order workflow's detail page shows: name heading, Active/Off accessory badge, Edit primary action, Turn off / Turn on, More actions (Rename, Duplicate, Delete), the trigger box, and the stage flow — the same furniture as an item workflow, with no tags row. Draft, Apply changes and Discard changes work from the editor route.

Note that **Duplicate** on the order workflow must still be refused by `requireOrderWorkflowSlot` (`WorkflowRepository.ts:1158`) — the shop already has one. Check the button either hides or surfaces `OrderWorkflowExists` as copy rather than a raw error.

## Stage 3 — the Workflows index

### Delete

`src/routes/app.order-workflow.index.tsx` in full — the standing create form, the five-column one-row table, the inline delete confirm row, and both explanatory paragraphs — and `Domain.OrderWorkflowIndexLoaderData`. No redirect.

### `/app/workflows`, restructured

The loader needs no change: `listWorkflows` already returns both kinds and the page already filters with `isItemWorkflow` (`app.workflows.index.tsx:144`). Stop discarding the order one.

```
s-page heading="Workflows"           primary action: Create workflow
├─ Order workflow                    one compact row
│    name link · Active/Off · "3 steps" · [One per shop] · Open
│    ORDER_WORKFLOW_TRIGGER
│    empty state: prose + [Create order workflow] → modal
└─ Item workflows                    heading + count
     status filters, search, product-tag chips   (unchanged)
     the existing five-column table              (unchanged)
```

Rules that keep this from becoming the earlier combined page:

- The order workflow is **never a table row**. No Product tags column to leave blank, no filter that applies to it, no search that includes it.
- **Two create paths.** `Create workflow` in the page header creates an item workflow via the existing `CREATE_MODAL`. The order workflow is created only from its own section's empty state, via a second modal. Neither button ever asks which kind.
- **No delete on this page**, either kind. Delete lives on the detail page.
- The order-workflow section is **one row, not a card with paragraphs**. Above the list is where discovery works; compact is what stops a shop-wide singleton reading as more important than the merchant's daily work.

### Nav

`src/routes/app.tsx:300-301`: drop the `Order workflow` entry. `Workflows` remains.

### Copy

| Where                               | String                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order-workflow section heading      | `Order workflow`                                                                                                                                                                                                |
| Its cardinality badge               | `One per shop`                                                                                                                                                                                                  |
| Its trigger line                    | `ORDER_WORKFLOW_TRIGGER`, unmodified — it is already the shared three-sentence rule                                                                                                                             |
| Its empty state                     | `No order workflow yet. Add one for the steps that happen once per order after every item is made — packing, a final check, the invoice.`                                                                       |
| Its create button and modal heading | `Create order workflow`                                                                                                                                                                                         |
| Item-workflow section heading       | `Item workflows`                                                                                                                                                                                                |
| Item-workflow section intro         | today's line, minus the sentence that now belongs to the page: `Each one is the ordered list of steps a line item passes through, chosen by product tag. Turn one off to stop new runs while open runs finish.` |

`ORDER_WORKFLOW_TRIGGER` is three sentences and roughly 250 characters. It is correct and shared by design, but it now lands in a compact row. If it reads as a wall there, the fix is the row's layout — not a second, shorter, divergent string. That divergence is precisely the defect `7b7ab34` removed.

## Stage 4 — the queue badge

`src/routes/shop.$shop.queue.tsx:456`: `<s-badge>No workflow</s-badge>` → `<s-badge>No steps</s-badge>`, on the line items of an order run that have no item run.

The reasoning belongs in a comment on the badge: a worker has no access to definitions, so an absence reported in definition terms is unactionable; what the packer needs to know is that nothing was made for that item. The workflow-name badge on the card (`:440`) **stays** — it is a proper noun the worker hears out loud, not a concept they have to understand.

## Tests

- **Integration**: the renames in Stage 1. No behavioural test should need new assertions — if one does, the rename changed behaviour and something is wrong.
- **e2e**: `e2e/workflows.spec.ts` currently has no coverage of the order workflow at all (no match for `order-workflow` in it). Stage 3 is the moment to add it: create the order workflow from the section's empty state, see it appear as a row above the item list, open it, confirm the detail page has no tags row, and confirm `Create workflow` still creates an item workflow.
- `e2e/seed.ts` and `api.dev.seed.ts` carry the field rename; check the seeded fixture still produces an order workflow with a draft, since that is what the UI states are exercised against.

## Verification checklist

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm fmt                     # repo-wide; keep every file it touches
pnpm d1:reset && pnpm seed   # mandatory after Stage 1 — wipes local DO storage
npm run test:e2e --
```

Manual, in the embedded admin:

1. `/app/workflows` shows one nav entry, the order workflow above, the item list below with its heading and filters intact.
2. `Create workflow` makes an item workflow; the section's own button makes the order workflow; neither asks which kind.
3. With no order workflow, the section shows its empty state; with one, no create control is offered anywhere.
4. On an order whose order workflow is off, the blocker link on the order detail page still opens the workflow.
5. The order workflow's detail page mirrors an item workflow's, minus the tags row, and Edit opens the editor route.
6. A worker's queue shows `No steps`, not `No workflow`, on an unmade line item of an order run.

## Risks

| Risk                                              | Mitigation                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A blanket `scope` → `type` replace breaks OAuth   | The rule: rename only where the value domain is `"item" \| "order"`. The trap table above lists every other meaning. |
| The three shipped blocker links break             | Update them and keep a redirect. Item 5 of the manual checklist exists for this.                                     |
| Stage 3 recreates the old combined page           | The four rules in Stage 3 are what prevent it; each maps to a specific defect of the page that was split apart.      |
| Deleting `WorkflowDetail.tsx` orphans an importer | `grep -rn "WorkflowDetailPage" src/` — as of `7b7ab34` the only importer is the route deleted in the same stage.     |
| A stale `/app/order-workflow` pointer survives    | `grep -rn "order-workflow" src/` must return only the two redirect routes when Stage 3 is done.                      |
