# Customer data and the order workflow: implementation plan

Status 2026-09-15: **implemented**; deviations recorded below and the research doc's "Where Baton stands today" updated. The reasoning and every product decision are in
`docs/customer-data-and-order-workflow-research.md`; its "Decisions (2026-09-15)"
list is binding, and where the body of that doc hedges, the decisions win. This
document is the order of work. Like the earlier plans in `docs/`, it is disposable
once the code is in and any deviations are folded back into the research doc.

The four deliverables, in the order they are built:

| #   | Deliverable                                                               | Decision |
| --- | ------------------------------------------------------------------------- | -------- |
| 1   | Remove the order workflow: singleton, routes, nav, run branches, tests    | 2        |
| 2   | Order-number search on `/app/orders`                                      | 5        |
| 3   | Admin link extension on the Shopify order page → `/app/orders/<legacyId>` | 5        |
| 4   | Rewrite `src/routes/privacy.tsx` for protected-customer-data Level 1      | 6        |

Decisions 1, 3, and 4 are "do nothing" decisions: no customer fields, no
fulfilment writes, no tags. They constrain this work (nothing here adds a scope,
a Shopify mutation, or a customer field) but need no code.

Vocabulary is the research doc's and `Domain.Workflow`'s JSDoc: a _workflow_ is
chosen by its tag and runs once per matching line item; a _run_ is
`Domain.WorkflowRun`; _Ready to ship_ is the derived index stage (open, at least
one done run, no open run, unfulfilled in Shopify); _legacy id_ is
`ShopOrder.legacyId`, the REST id the admin routes on and the `$orderId` param of
`/app/orders/$orderId`.

## Ground rules for this work

- **Four deliverables, in this order.** Deliverable 1 is the large one and lands
  first so that everything after it is written against one kind of workflow. Each
  deliverable ends green on `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the
  `orders`, `workflows`, `teams`, and member e2e specs before the next begins.
  Do not commit; the user commits.
- **No customer data, no new scope, no Shopify write.** `shopify.app.toml`
  `scopes` stays `write_orders,read_products`. No query gains `customer`, `email`,
  `phone`, or any address field. No mutation is added. If a step seems to need
  one, stop and record it under Deviations.
- **`activatedAt` stays.** It is the on/off switch and coverage date of _every_
  workflow (`src/lib/Domain.ts:577-598`), and `WorkflowSwitch.tsx` serves the
  item-workflow page (`app.workflows.$workflowId.tsx:318`). Removing the order
  workflow removes the `type` column and the singleton, not the switch, the
  Turn on dialog, "Applies to orders placed since", `countWaitingOrders`,
  `setWorkflowActive`, or `setWorkflowActivatedAt`.
- **No migration; edit the schema inline.** Baton is still prototyping and every
  database is reset from scratch (the user stops dev, wipes local D1 and the
  Durable Objects). The Durable Object schema is the single `"1_initialize schema"`
  entry in `SqliteMigrator` (`src/lib/ShopAgent.ts:587-599`); edit
  `initializeSchema` directly and add no second entry. There is no D1 change;
  nothing in `migrations/` changes. The `type` column on `Workflow` is removed,
  not left in place.
- **Existing comments are edited, not silently dropped.** `CLAUDE.md` forbids
  removing comments unless instructed. This plan is that instruction, scoped: a
  JSDoc sentence or paragraph that describes the order workflow, the `type`
  column, the singleton, order runs, or `isOrderRun` is to be rewritten so it is
  true afterwards, or deleted when nothing true remains. Every such edit is listed
  in the phases below; if you meet one that is not, edit it and record it under
  Deviations. Comments about anything else are untouched.
- **Copy is fixed.** Search field placeholder `Order number`; search chip
  `Order #1001` (the typed value, `#` added if the merchant omitted it);
  extension name `Open in Baton`; privacy page headings as in Phase 4. Do not
  invent variants.
- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, JSDoc carrying its
  reasoning inline and never pointing at `docs/`, lowercase SQL with positional
  parameters, `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep everything it
  touches). `pnpm graphql-codegen` is not needed unless a `#graphql` string
  changes, and none should.

## Phase 0: read before editing

Read these in full before touching anything in Phase 1. They carry the model the
removal has to leave intact.

- `src/lib/Domain.ts:495-640` (the `Workflow` vocabulary JSDoc and the two
  variants) and `:2120-2175` (`WorkflowRun` and `isOrderRun`).
- `src/lib/ShopAgent.ts:298-415` (the schema JSDoc) and `:413-600`
  (`initializeSchema` and the migrator).
- `src/lib/readyWhere.ts` (whole file, 49 lines).
- `src/lib/WorkflowRunRepository.ts:130-230` (`canStart`, `placedSince`,
  `matchesTags`, `undoVerdict`, the empty `ReconcileResult`) and `:1040-1200`
  (`reconcileOrder`).
- `docs/customer-data-and-order-workflow-research.md` §"Part 2" and §"Part 3".

Then run the baseline so a later failure can be attributed:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Record any pre-existing failure under Deviations before continuing.

## Phase 1: remove the order workflow

Files: `src/lib/Domain.ts`, `src/lib/ShopAgent.ts`, `src/lib/ShopAgentClient.ts`,
`src/lib/WorkflowRepository.ts`, `src/lib/WorkflowRunRepository.ts`,
`src/lib/readyWhere.ts`, `src/lib/workflowShared.ts`, `src/lib/usedBy.ts`,
`src/components/MemberRun.tsx`, `src/components/WorkflowSwitch.tsx` (JSDoc only),
`src/routes/app.tsx`, `src/routes/app.order-workflow.index.tsx` (delete),
`src/routes/app.order-workflow.edit.tsx` (delete), `src/routes/app.orders.$orderId.tsx`,
`src/routes/app.workflows.index.tsx`, `src/routes/app.workflows.$workflowId.tsx`,
`src/routes/app.workflows.$workflowId_.edit.tsx`, `src/routes/shop.$shop.index.tsx`,
`src/routes/shop.$shop.work.$runId.tsx`, `src/routes/api.dev.seed.ts`,
`e2e/fixture.ts`, `e2e/orders.spec.ts`, and the four integration test files named in
1.7. `src/routeTree.gen.ts` regenerates itself on the next `pnpm typecheck` or dev
run; do not hand-edit it.

Work bottom-up: Domain first, then the schema, then the repositories, then the
object, then routes and components, then tests. Typecheck after each sub-phase;
the compiler is the checklist for the sites this plan does not enumerate.

### 1.1 Domain

1. **Delete** `WorkflowType` (`Domain.ts:511-512`) and its JSDoc (`:500-510`),
   `ORDER_WORKFLOW_ID` and `ORDER_WORKFLOW_NAME` (`:518-526`) and their JSDoc,
   `OrderWorkflow` (`:619-629`) and its JSDoc, and `isItemWorkflow` (`:634-638`).
2. **Collapse** `Workflow` to one struct: `WorkflowFields` plus `tags`. Rename
   `ItemWorkflow` to `Workflow`, delete the `Schema.Union`. Do the same for
   `WorkflowSummaryRow` (one struct, not a union), `WorkflowSummary` (delete the
   union, rename `ItemWorkflowSummary` to `WorkflowSummary`). Keep the exported
   names `Workflow`, `WorkflowSummary`, `WorkflowSummaryRow`, `WorkflowDetail`
   because routes and the client type against them; drop the `Item*` names once
   nothing references them.
3. **Rewrite the `Workflow` vocabulary JSDoc** (`:528-598`). Remove the three
   bullets and sentences that mention the order workflow ("the order workflow
   starts for every paid order with an item run", "the order workflow is never
   deleted, only turned off", "delete an item workflow" becomes "delete a
   workflow"). Everything about tags, drafts, Apply, `activatedAt`, unassigned,
   and Needs attention stays word for word.
4. **`WorkflowRun`** (`:2140-2168`): `lineItemId`, `lineItemTitle`, `variantTitle`,
   `sku`, `quantity`, and `customAttributes` lose `Schema.NullOr`. Delete
   `isOrderRun` (`:2170`). Rewrite the struct JSDoc paragraph "One struct with
   nullable fields rather than a union ... `isOrderRun` is the only branch"
   (`:2136-2138`) and the sentence about the partial unique index on
   `(orderId, workflowId)` (`:2131-2134`); both describe what Phase 1.8 removes.
5. **`undoBlockedBy`** (`:2366-2379`): drop the third parameter `orderRunSteps`
   and the `?? firstStarted(orderRunSteps)` fallback. The JSDoc above it still
   describes the item-run rule correctly; delete only any clause about the order
   run.
6. **`OrderDetailView`** (`:2459-2489`): delete `orderWorkflow` and
   `orderWorkflowBlocker` with their JSDoc. `itemWorkflows` keeps its name (the
   picker is still "attach a workflow to this item") but its JSDoc drops "item".
7. **`CreateWorkflowInput`** JSDoc (`:790`) and `UpdateWorkflowInput` stay; delete
   the "Item workflows only" sentence. `SeedWorkflowsInput` (`:880-900`): delete
   the `type` field and the JSDoc paragraph about "at most one `type: "order"`
   entry". `OwnedStep` JSDoc (`:1090`): delete the parenthetical about
   `/app/order-workflow`. Route data types (`:1770-1776`): delete the two
   "order workflow" clauses.
8. **`ShopOrder.processedAt`** JSDoc (`:1196`) mentions `Workflow.activatedAt`;
   still true, leave it.
9. Grep `Domain.ts` for `order workflow`, `order run`, `ORDER_WORKFLOW`,
   `isOrderRun`, `OrderWorkflow`, `type: "order"`. Zero hits before moving on.

### 1.2 `readyWhere`

Replace the predicate with its first two conjuncts only:

```ts
export const readyWhere = (alias: string): string => `(
  ${alias}.completedAt is null
  and not exists (
    select 1 from WorkflowRunStep p
    where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage
  )
)`;
```

Rewrite the JSDoc: delete the first paragraph's sentences from "For an order run
the item runs are stage zero" through "makes the order run wait longer" and the
`WorkflowRun_order_items_idx` sentence. Keep the "module of its own" paragraph
and the alias-shadowing warning; the aliases it warns about are now `p` only,
so say `p`.

### 1.3 `WorkflowRepository`

1. Delete `getOrderWorkflow` (`:225`, `:997-1010`) from the interface and the
   implementation, `requireNoTagsForOrderWorkflow` (`:648`), and every
   `workflowId === Domain.ORDER_WORKFLOW_ID` branch (`:60`, `:638`, `:1308`).
   Delete the `Singleton` outcome from `Domain.DeleteWorkflowResult` and the
   duplicate/rename refusals that exist only for the singleton.
2. `replaceWorkflows` (`:1093-1160`): delete the "at most one order workflow"
   check, the singleton reset branch, and the `type` column from every
   `insert into Workflow` (`:1155`, `:1199`, `:1241`). Reads that filter
   `type = 'item'` drop the filter.
3. `activate` / `setWorkflowActive` / `setWorkflowActivatedAt`
   (`:312-390`, `:1334-1390`) stay as they are. Their JSDoc is about the switch,
   not the singleton; read it once to confirm.
4. Rewrite the file-head JSDoc (`:55-70`) where it mentions the singleton.

### 1.4 `WorkflowRunRepository`

1. `ReconcileResult` (`:85-95`, `:220-228`): delete `orderRuns`. The log line in
   `ShopAgent.reconcileOrder` (`ShopAgent.ts:2399-2412`) drops `orderRuns=` from
   the message and the annotation.
2. Delete `orderRunStepsFor` (`:746`), `flagOpenOrderRuns` (`:826`),
   `cancelOrphanedOrderRun` (`:915`), and every call site (`:999`, `:1170`,
   `:1176`, `:1294`, `:1385`, `:1506-1525`, `:1564`, `:1609-1622`).
3. `reconcileOrder` (`:1040-1200`): delete the order-run creation block
   (`:1055-1090`), `openOrderRuns` and `orderRunFlag` (`:1091-1175`). What
   remains is the item-run reconcile: create, flag, cancel. `matchesTags`
   (`:155-165`) drops `workflow.type === "item" &&`.
4. `attachWorkflow` (`:276-290`, `:1283-1310`): delete the `orderWorkflow`
   parameter and the branch that creates an order run on attach. The JSDoc
   sentence about "open order run of the order `item_added`" goes.
5. `undoVerdict` (`:205-220`): delete the `Domain.isOrderRun(run)` branch and the
   `orderRunSteps` parameter; call `Domain.undoBlockedBy(step, steps)`.
6. Grep the file for `isOrderRun`, `lineItemId is null`, `lineItemId === null`,
   `orderRun`, `orderWorkflow`. Zero hits.

### 1.5 `ShopAgent`

1. **`initializeSchema`** (`:413-585`) is edited in place; no new migration entry.
   - `Workflow` (`:474-484`): delete the `type` column, the
     `check (type = 'item' or tags = '[]')` on `tags`, and the table-level
     `check (type <> 'order' or ...)`. Delete `Workflow_order_uidx` (`:487-488`).
     Delete the `insert or ignore into Workflow ... 'order'` singleton seed
     (`:582-583`).
   - `WorkflowRun` (`:517-548`): `lineItemId`, `lineItemTitle`, `quantity`, and
     `customAttributes` become `not null` (`variantTitle` and `sku` stay
     nullable if the line-item source can be null; check `OrderLineItem` in
     Domain and match it). Delete the `check ((lineItemId is null) = ...)` block
     (`:538-541`). Replace the partial unique index `WorkflowRun_order_uidx`
     (`:543-544`) with nothing: `unique (lineItemId, workflowId)` already covers
     every run. Delete `WorkflowRun_order_items_idx` (`:547-548`) unless a query
     surviving 1.4 still uses it (grep for `orderId` probes in the run repository;
     record the outcome under Deviations).
   - The schema JSDoc (`:298-415`): delete the paragraph "Item and order
     workflows (`type`) share these four tables ..." through "... for one
     missing column" (`:342-353`), and the sentences at `:382` and `:390` about
     `WorkflowRun_order_items_idx` and `WorkflowRun_order_uidx`. The
     `activatedAt` paragraph (`:333-341`) stays.
2. `seedReadySteps` (`:1072-1090`): delete `itemRuns`, `orderRunReady`, and the
   `isOrderRun` guard. The function becomes "open run → steps with no open
   earlier stage".
3. `getOrderDetail` (`:2435-2460`): delete `orderWorkflow`, `orderWorkflowBlocker`,
   and the blocker IIFE. The `canStart(orderWorkflow, roster)` read in the attach
   path (`:2570-2582`) goes with 1.4.4.
4. `listWorkflows` (`:1911`) returns `Domain.WorkflowSummary[]` (renamed in 1.1.2).
   The `ShopAgentClient` JSDoc "Item workflows only; the order workflow is read by
   `getWorkflowDetail` with `Domain.ORDER_WORKFLOW_ID`" (`ShopAgentClient.ts:115`)
   is deleted.
5. The JSDoc at `:1358` ("which the order page's `orderWorkflow` / `itemWorkflows`")
   is rewritten to name only `itemWorkflows`.

### 1.6 Routes and components

1. **Delete** `src/routes/app.order-workflow.index.tsx` and
   `src/routes/app.order-workflow.edit.tsx`.
2. `src/routes/app.tsx:280`: delete the `Order workflow` nav link.
3. `src/routes/app.workflows.$workflowId.tsx:84-90` and
   `app.workflows.$workflowId_.edit.tsx:115-120`: delete the redirect to
   `/app/order-workflow`. Rewrite the JSDoc at `$workflowId.tsx:103` and
   `app.workflows.index.tsx:96-100` so neither mentions the order workflow.
4. `src/lib/usedBy.ts`: `workflowHref` becomes `/app/workflows/${workflowId}`
   unconditionally; delete the JSDoc clause about the order workflow.
5. `src/lib/workflowShared.ts`: delete `ORDER_WORKFLOW_TRIGGER` and its JSDoc
   (`:44-55`), the `Singleton` arm and `SINGLETON_MESSAGE`. `itemTriggerLine`
   keeps its name.
6. `src/routes/app.orders.$orderId.tsx`: this is the largest edit. Delete
   `orderRuns`, `itemRunCount`, `orderRunReady`, `orderWorkflowLine`,
   `orderWorkflowNote`, `orderWorkflowShows`, and the whole "order workflow"
   section (`:1470-1490`). Delete every `Domain.isOrderRun` branch (`:225`, `:275`,
   `:351`, `:721-790`, `:1017-1029`, `:1229`). The "too old" line (`:727-730`)
   compared `order.processedAt` against the _order_ workflow's `activatedAt`;
   delete it. Read the JSDoc on each deleted helper first: several explain
   item-run behaviour too, and those sentences move to the surviving helper.
7. `src/components/MemberRun.tsx:21`, `src/routes/shop.$shop.index.tsx:224,269`,
   `src/routes/shop.$shop.work.$runId.tsx:98,294,327-335`: delete the order-run
   branch of each conditional and keep the item-run rendering. On the work page
   the heading is always `This item` and "Items on this order" goes.
8. `src/components/WorkflowSwitch.tsx`: no behaviour change. Its JSDoc (`:20-40`)
   says "the two pages are copies that must not drift"; there is now one page.
   Rewrite that sentence to say the component owns the dialogs so the workflow
   page cannot restate the rule.
9. `src/routes/api.dev.seed.ts:40,196-252`: delete the `type` field on the seed
   input and the branch that passes it through.

### 1.7 Tests and fixtures

1. `test/integration/workflow-run-repository.test.ts`: delete `seedOrderWorkflow`
   (`:284-330`), `orderRuns()`, `orderWorkflowDetail()`, and every `it` block that
   asserts on an order run (roughly `:370-660`; the block titles name "order run",
   "pack", or `orderRuns`). Item-run assertions that share a block with an
   order-run assertion keep the item half. `orderRuns: 0` (`:250`) leaves the
   empty-result fixture.
2. `test/integration/workflow-repository.test.ts`: delete the singleton blocks
   (`:455-495`, `:650-730`). The `activatedAt` block at `:1267-1330` uses
   `Domain.ORDER_WORKFLOW_ID` as a convenient id; rewrite it against a created
   item workflow rather than deleting it, because the switch behaviour it tests
   survives.
3. `test/integration/shop-agent-workflows.test.ts:660-830`: delete the two
   order-workflow blocks (refuse delete/duplicate of the singleton; the
   Turn-on-then-run block).
4. `test/integration/domain.test.ts:160-175`: drop the `ORDER_WORKFLOW_ID` owned
   step from the `groupUsedBy` fixture and the `/app/order-workflow` href from
   the expected string.
5. `e2e/orders.spec.ts:99-140`: delete the test "the order page's order-workflow
   link lands on the order workflow page".
6. `e2e/fixture.ts`: delete the `type: "order"` workflow entry and the fixture
   JSDoc bullets about packers and the order-workflow step (`:37-39`, `:55`).
   Then grep `e2e/` and `test/` for `packer(`, `PACKING`, `QC`, `p1@m.com` through
   `p4@m.com`. Keep a team or member only if a surviving spec signs in as it or
   asserts on it; otherwise delete it with its JSDoc bullet. Record what you kept
   under Deviations.
7. Run `pnpm test`. Then `npm run test:e2e -- orders workflows teams` and the
   member spec(s). All green before Phase 1.8.

### 1.8 Reset and smoke test

No migration. The user resets the local databases; do not run the reset
yourself unless told to. Once reset:

1. Start dev (`pnpm app:dev`) and confirm the object's schema log shows no
   error.
2. `pnpm seed`, then open `/app/orders`, an order page, `/app/workflows`, a
   workflow page with the Turn on dialog, and a member queue. Confirm the order
   page shows item runs only and no "order workflow" section, and that nav has
   no `Order workflow` entry.
3. If the seed fixture still references anything removed in 1.7, fix the fixture
   rather than the seed route.

### 1.9 Gate

`pnpm typecheck && pnpm lint && pnpm test`, then `pnpm fmt`. Grep the whole of
`src/`, `test/`, `e2e/` for `order-workflow`, `orderWorkflow`, `OrderWorkflow`,
`ORDER_WORKFLOW`, `isOrderRun`, `orderRun`, `type = 'order'`, `'order'`. The only
acceptable hits are unrelated uses of the word (an `order by`, an order page).

## Phase 2: order-number search

Files: `src/lib/Domain.ts`, `src/lib/OrderRepository.ts`,
`src/routes/app.orders.index.tsx`, `test/integration/order-repository.test.ts`,
`e2e/orders.spec.ts`.

1. **`Domain.ListOrdersInput`** (`Domain.ts:1397-1410`) gains

   ```ts
   /** Order-number search, matched against `ShopOrder.name` after normalising: `null` is no search. */
   q: Schema.NullOr(OrderSearch),
   ```

   where `OrderSearch` is `Schema.String` trimmed, non-empty, at most 32
   characters. Define it next to `OrdersCursor`.

2. **Normalisation lives in Domain** so the route chip and the SQL agree:

   ```ts
   /** `1001`, `#1001`, ` #1001 ` all mean the order named `#1001`: strip, then prefix `#` once. */
   export const normaliseOrderSearch = (q: string): string => { ... };
   ```

   Returns `#` + the trimmed input with any leading `#` characters removed.

3. **`OrderRepository.listOrders`** (`:436-560`): add a `q` input and a
   `searchFilter`. Prefix match, case-insensitive, escaped:

   ```ts
   const searchFilter =
     q === null
       ? sql.literal("1 = 1")
       : sql`name like ${escapeLike(Domain.normaliseOrderSearch(q)) + "%"} escape '\\'`;
   ```

   `escapeLike` escapes `\`, `%`, `_`. Put it beside `decodeCursor`. Prefix, not
   substring: order names are `#` plus digits, the merchant types the digits they
   read off the admin, and a prefix match on `#10` listing `#1001` … `#1099` is
   the useful behaviour; `%10%` would also match `#2100`. Add `q` to the
   `sql.and([...])`.

   Stage counts: read how `openCounts` is computed in the same function. If it
   already ignores `paid` and `team`, it ignores `q` too (the strip is the shop's
   pick list, not the search's). If it honours them, honour `q` the same way.
   Record which under Deviations.

4. **Route** (`app.orders.index.tsx`): `OrdersSearch` (`:47-52`) and
   `OrdersLoaderInput` (`:225-230`) gain `q`; `loaderDeps`, `ordersQueryKey`
   (`:33-38`), the `navigate` helper (`:305-320`), and the `client.listOrders`
   call (`:243-250`) thread it. UI: an `s-text-field` with placeholder
   `Order number` in the existing filter row, submitted on Enter or after a
   300 ms debounce, whichever the row's other controls already do (match the
   existing pattern; if none debounce, submit on Enter and on blur). A set `q`
   renders as a removable chip `Order #1001` next to the existing chips. Clearing
   the field removes `q` from the URL.

5. **Empty state**: when `q` is set and the page is empty, the copy is
   `No order matches "#1001".` with a link that clears the search. Reuse
   `stageText`'s slot if it exists; otherwise a paragraph below the filters.

6. **Tests**: in `order-repository.test.ts`, three cases: `q: "1001"` finds
   `#1001` only; `q: "#10"` finds `#1001` and `#1002` and not `#2100`; a `q`
   containing `%` finds nothing rather than everything. One e2e case in
   `orders.spec.ts`: type a seeded number, assert the row, clear, assert the
   list is back.

## Phase 3: admin link extension

Files: `extensions/baton-order-link/shopify.extension.toml` (new),
`extensions/baton-order-link/locales/en.default.json` (new, if the CLI generates
one), `src/routes/app.orders.from-shopify.tsx` (new), `shopify.app.toml` (only
if step 1 shows it needs `extension_directories`).

1. **Generate**, do not hand-write, so the `uid` is minted by the CLI:

   ```bash
   shopify app generate extension --template admin_link --name baton-order-link
   ```

   Then edit the TOML to exactly:

   ```toml
   [[extensions]]
   name = "Open in Baton"
   description = "Open this order's production runs in Baton"
   handle = "baton-order-link"
   type = "admin_link"
   uid = "<keep the generated value>"

   [[extensions.targeting]]
   target = "admin.order-details.action.link"
   url = "/app/orders/from-shopify"
   ```

   The target name is the CLI's own derivation for `ORDERS#SHOW`
   (`refs/shopify-cli/packages/app/src/cli/services/admin-link/utils.ts`,
   `contextToTarget`: `admin` + `order-details` + `action` + `link`). The
   `extensions/` directory already exists and is empty; the CLI's default
   `extension_directories` glob finds it. `shopify.app.staging.toml` narrows
   `web_directories` for a documented reason; if `shopify app dev` fails to see
   the extension, add `extension_directories = ["extensions/*"]` to
   `shopify.app.toml` and record it.

2. **The landing route** `src/routes/app.orders.from-shopify.tsx`. A static
   segment beats `$orderId`, so the path does not collide. It has no component
   worth rendering: `beforeLoad` reads the search params, derives the legacy id,
   and throws `redirect({ to: "/app/orders/$orderId", params: { orderId } })`.
   Because it is under `app.tsx`, the parent `beforeLoad` runs first and the
   session guard applies.

   The search schema accepts what Shopify sends. Shopify documents only that it
   "appends generated URL parameters that identify the store ... and the resource
   IDs" (`refs/shopify-docs/docs/apps/build/admin/admin-links.md:22`), not the
   names. So:

   - Run `shopify app dev`, open a dev-store order, click **More actions → Open
     in Baton**, and read the first request's query string from
     `logs/server.log` (add a temporary `Effect.logInfo` in `beforeLoad` with the
     raw search object annotated; remove it before finishing).
   - Write the schema for exactly those names. Expect an `id` and a `shop`; the
     id may arrive as a bare number or as a `gid://shopify/Order/<n>` string.
     Accept both: strip everything up to the last `/`.
   - If `id` is missing, redirect to `/app/orders` rather than 404.

   Record the observed parameter names under Deviations; they are the one fact
   this plan could not verify from the refs.

3. **Embedded context.** App Bridge needs `host` and `shop` on an embedded app
   URL. Admin links open inside the app's admin frame, so these should be present
   as they are for any nav click. Confirm in the same dev-store test that the
   redirect target renders inside the admin without a second OAuth bounce. If it
   bounces, land the fix in `app.tsx`'s existing param handling, not in the new
   route, and record it.

4. **Deploy** is the user's step (`shopify app deploy` publishes the extension
   to every install). Do not run it. Say in the handoff that the link does not
   exist on the production store until they do.

5. **Test**: none automated; the extension has no code. The manual check in
   step 2 is the test, and its outcome is recorded under Deviations.

## Phase 4: privacy page

File: `src/routes/privacy.tsx`.

The page currently says Baton requests no scopes and stores no order history and
describes a Flow app. Rewrite the four item arrays and the affected paragraphs;
keep the `PolicySection` / `PolicyList` components and the page chrome.

- **Last updated**: the date of the rewrite.
- **Information We Collect**: shop domain and identifier; Shopify session and
  granted permissions; orders and line items needed to run production, listed
  as: order number, order dates, payment and fulfilment status, order tags, order
  note, custom attributes, line-item title, variant, SKU, quantities, product id
  and product tags; team member accounts (name, email, sign-in details) created
  by the merchant; technical logs; support correspondence. Delete both Flow
  bullets. Replace "Baton currently requests no Shopify Admin API access scopes"
  with a paragraph naming the two scopes and what each is for (`write_orders` is
  held for order access; Baton does not currently write to orders).
- **Information We Do Not Collect**: keep the seven bullets except "Order
  history", which becomes "Customer accounts or customer profiles". Add a
  sentence: order notes and custom attributes are free text a customer or
  merchant may have typed personal details into; Baton stores them as Shopify
  provides them and shows them to the merchant and to team members working the
  order.
- **How We Use Information**: replace the Flow bullet with "Create and track
  production runs for order line items and show team members the items they are
  making." Keep the rest.
- **Sharing**: unchanged.
- **Retention And Deletion**: replace "Baton does not store any of your
  customers' data ... has no customer data to return or delete" with: Baton
  stores order data for the shop's own use; on `shop/redact` Baton deletes the
  shop's data; on `customers/data_request` and `customers/redact` Baton holds
  no customer identity fields and so has nothing to return or redact beyond
  what is already covered by the order records the merchant controls. Check
  `src/routes/webhooks.compliance.ts` and `app/uninstalled` handling first and
  describe what they actually do, not what this paragraph assumes; record any
  gap under Deviations rather than papering over it in the copy.
- **Team members**: add a short section. Team members see order number,
  item title, variant, SKU, quantity, custom attributes, and the order note.
  They never see customer names, contact details, addresses, or prices.

No behaviour change. `pnpm typecheck` and `pnpm lint` still run.

## Phase 5: final gate and handoff

1. `pnpm typecheck && pnpm lint && pnpm test`.
2. `npm run test:e2e -- orders workflows teams` plus the member specs.
3. `pnpm fmt`; keep every file it touches.
4. `git status` and list every file changed, added, and deleted in the handoff
   note. Do not commit.
5. Fill in Deviations below. Then update the research doc's "Decisions" list
   only if a deviation changed a decision; otherwise leave it.

## Deviations

For the implementing LLM. One bullet per deviation, appended as they happen, not
at the end. A deviation is anything this plan said to do that you did differently,
anything it did not anticipate that you had to decide, and any fact it asked you
to observe. Each bullet says what the plan said, what you did, and why. If there
were none for a phase, write "none".

### Phase 0 baseline

- None. `pnpm typecheck`, `pnpm lint`, and `pnpm test` (20 files, 292 tests) were
  all green on `main` before the first edit.

### Phase 1: order workflow removal

- Pre-existing test failures on `main` before any edit: none (292 passed).
- `RunFlag` lost the `item_added` literal, beyond the plan. It was set only on
  an order run (`Domain.RunFlag` JSDoc said so), so after 1.4 nothing could
  write it. Removed from `Domain.RunFlag`, the `WorkflowRun.flag` check in
  `initializeSchema`, `MemberRun.flagMessage`, and `RUN_FLAG_LABEL` on the
  order page. `RunFlagDetail.item` stays: `item_removed` still carries it.
- `QueueItem.items` / `QueueRow.items` removed, beyond the plan. They were
  populated only for order runs (`Domain.QueueItem` JSDoc), so every queue card
  now renders `RunItem`. `RunView.items` stays — the work page's "Also on this
  order" still uses it.
- `WorkflowRepository.listWorkflows` lost its `type?` parameter, and
  `Domain.WorkflowType` went with `type`. `ShopAgent.listWorkflows` no longer
  filters.
- `useWorkflowEditorWindow` lost its `editorPath` override: only the deleted
  `/app/order-workflow` page passed one. `itemEditorPath` is now `editorPath`.
- `undoVerdict` in `WorkflowRunRepository` was deleted rather than trimmed; the
  three call sites call `Domain.undoBlockedBy(step, steps)` directly.
- JSDoc edits beyond those enumerated: `src/components/WorkflowStages.tsx:15`
  and `src/components/UsedByCard.tsx:14` each had one sentence naming the order
  workflow; `src/lib/WorkflowRunRepository.ts` `listOrderTeamIds` justified its
  order-wide scope by "readiness crosses runs", which is no longer true, so the
  reason is now the merchant's order page showing every run of the order.
  `src/lib/usedBy.ts:1` became `import type` (oxlint) once `Domain` was only a
  type there.
- Fixture teams and members kept from `e2e/fixture.ts`: the six maker teams and
  `lead@m.com` / `m1@m.com` … `m8@m.com`. Deleted: `Quality check`, `Packing`,
  `Shipping`, and `p1@m.com` … `p4@m.com` — no surviving spec signs in as a
  packer or asserts on those teams (only a comment in
  `member-queue.member.spec.ts:453` mentions the word), and they existed solely
  to own order-workflow steps.
- `WorkflowRun_order_items_idx` was **not** kept: no surviving query probes
  `(orderId, lineItemId, status)`. `WorkflowRun_order_uidx` went with it;
  `unique (lineItemId, workflowId)` covers every run now.
- `WorkflowRun` columns that became `not null`: `lineItemId`, `lineItemTitle`,
  `quantity`, `customAttributes`. `variantTitle` and `sku` stay nullable —
  `OrderLineItem` has them nullable.
- Tests beyond the deletions the plan listed:
  - `test/integration/order-repository.test.ts` lost two blocks the plan did not
    name ("holds an unstaffed order-run step back until the item runs are done"
    and "waits on the makers until the items are made, then on the packers");
    both assert the stage-zero gate that `readyWhere` no longer has.
  - `workflow-run-repository.test.ts`: the whole `describe("WorkflowRunRepository
order runs")` went, but three of its blocks were rewritten against an item
    workflow rather than dropped, because they were the only coverage of their
    subject: `countWaitingOrders` + `reconcileAll` (now its own describe), the
    `unfulfilledQuantity` snapshot, and the `FULFILLED` reconcile.
  - `workflow-repository.test.ts`: the workflow-limit block seeded
    `maxWorkflows - 1` because the singleton occupied a slot; it now seeds
    `maxWorkflows`.
  - `e2e/orders.spec.ts`: rather than deleting the named test outright, its
    order-workflow half was cut and the rest kept as "the orders index names the
    team an open order is waiting on" — the waiting-on column assertions are not
    covered elsewhere.
- Smoke test after the reset: the user reset and restarted; `initializeSchema`
  logged `Migrations complete` with no error and `pnpm seed` reconciled all ten
  seed orders (`created=… cancelled=… flagged=…`, no `orderRuns=`). The whole
  e2e suite then passed headed against the live server — 24 tests across
  `home`, `orders`, `teams`, `workflows`, `members`, `member-area`,
  `member-queue` — which opens the orders index, an order page, the workflows
  list, a workflow page with the Turn on dialog, and a member queue. Nothing
  failed to render.
- One **pre-existing** e2e failure, not caused by this work, blocked the gate:
  `e2e/workflows.spec.ts` asserted `"<Workflow> started for 1 item"` on the
  order page. That line was deleted by commit 732986e and no source file on
  `main` renders the string (verified by grepping a stashed tree), so the spec
  had been failing before Phase 0. Rewritten to assert what the page does
  render: the line item's section carries a run card naming the workflow, and
  not "No workflow on this item." Phase 0's baseline did not run e2e, which is
  why it was not recorded there.

### Phase 2: order-number search

- Stage counts do **not** honour `q`. `openCounts` is one pass over every open
  order and already ignores `state`, `paid`, `attention` and `team` — the strip
  is the shop's, not the filter's — so `q` is ignored the same way. A test was
  added for it (`listOrders q` > "leaves the open-stage counts alone"), and the
  `listOrders` JSDoc now says so rather than leaving it to be rediscovered.
- Submit on Enter and on blur; no debounce. Nothing in the filter row debounces
  — every control there (`s-press-button` stage and payment toggles, the
  "Waiting on" `s-select`) navigates on the merchant's own click or change — so
  a timer that navigated mid-number would page the table under the typing.
  Enter is caught with a `keydown` listener on the custom element, the pattern
  `WorkflowTag` already uses: the field's shadow input does not submit a
  surrounding form. The listener reads the submit through a latest-ref written
  in an effect (not during render — oxlint's `react(refs)` forbids that), so it
  attaches once instead of on every keystroke.
- Placement: the plan said "in the existing filter row" and "a removable chip
  next to the existing chips". The field went **above** the facet grid, capped
  at `16rem` like the team select, because a search is not a facet crossed with
  the others and the placeholder is its own label; the chip went **inside** the
  cross-cutting row beside "Needs attention" and "Clear filters", which is
  where the page's other non-stage filters render.
- The chip carries no `accessibilityLabel`. It had one at first
  ("Clear the order number search") and that overrode the accessible name, so
  the plan's fixed copy `Order #1001` was visible but unreachable by role —
  the e2e caught it. The visible text is now the accessible name, matching the
  sibling "Clear filters".
- `Clear the search` in the empty state is an `s-link` with no `href`, which
  exposes `role=button`, so the e2e locates it as a button. Kept as a link for
  the visual treatment the plan asked for.
- `escapeLike` escapes `\`, `%`, `_` and every `like` declares `escape '\'`.
  The match also carries `collate nocase`: `ShopOrder.name` is `text` under the
  default `binary` collation, and an order name is not always digits.
- Four repository tests rather than the plan's three: the extra one is the
  open-counts check above. The `%` case is joined by `100_`, since `_` is the
  other `like` metacharacter and escaping one without the other is the bug this
  guards.

### Phase 3: admin link extension

- Query parameter names Shopify actually sent, on
  `admin.order-details.action.link`: `admin_theme`, `embedded`, `hmac`, `host`,
  `id`, `id_token`, `locale`, `session`, `shop`, `timestamp`. `id` is the bare
  REST/legacy id as a number (`7489880523072`), not a gid — which is exactly
  what `/app/orders/$orderId` takes. The route still strips to the last `/`
  segment, since the same parameter is a gid on some other targets.
- **The first dev-store click rendered a blank frame**, and the fix is the one
  thing about this route worth knowing. `redirect({ to, params })` carries no
  search, so the other nine parameters were dropped; App Bridge then had no
  `shop` or `host` to boot from and the Worker logged
  `render-app-bridge-missing-shop-host` with `hasShop: false, hasHost: false`
  against `pathname: /app/orders/7489880523072`. The redirect now spreads the
  whole search minus `id`. Forwarding everything rather than an allow-list of
  `shop`/`host`/`embedded`: they are Shopify's parameters, and an allow-list
  would silently drop whatever it adds next.
- `shopify.app.toml` did **not** need `extension_directories`: the CLI's
  default glob found the empty `extensions/` directory and generated into it.
- The redirect lands embedded with no second OAuth bounce. Verified in the live
  admin after the user's deploy and dev restart: **More actions → Open in
  Baton** on order #1563 landed on `/app/orders/7489880523072` with the app
  frame rendering the order, and the iframe URL carrying `shop`, `host`,
  `embedded`, and `id_token`. The temporary `Effect.logInfo` was removed once
  the names were in hand.
- `shopify app generate extension --template admin_link --name baton-order-link`
  ran non-interactively and minted `uid`
  `445a9561-6758-c8d6-c5e1-edbe263840a9403af10f`. Its template confirmed the
  plan's target name: `admin.order-details.action.link` is listed in the
  generated comment block under "Order Index, Detail Pages".
- The generator wrote `name = "t:name"` with `locales/en.default.json` and
  `locales/fr.json`, plus a `README.md`. All three were deleted and `name` set
  to the literal `Open in Baton` the plan fixes: the link text is one English
  string, the locale files existed only to hold it, and the generated `fr.json`
  would otherwise have shipped "Texte du lien d'extension" as the French label.
- Extension deployed by the user: **yes**. The Shopify CLI's Dev Console lists
  `baton-order-link` as an Admin Link, and the item appears under More actions
  on an order's detail page.

### Phase 4: privacy page

- What `webhooks.compliance.ts` and the uninstall path actually do: all three
  compliance topics are verified no-ops that return 200 (401 on a bad HMAC).
  Teardown is `app/uninstalled` alone, which deletes every `ShopSession` row for
  the shop and destroys the `ShopAgent` Durable Object — that is what actually
  erases the stored orders, workflows, and runs. `shop/redact` deliberately does
  nothing, to avoid resurrecting an already-destroyed object.
- The gap, and it is real: the handler's JSDoc claimed "This app stores no
  customer-scoped data", which was true before Baton stored orders. Baton still
  stores no customer _identity_ fields — no name, email, phone, address, and no
  `customer` selection in any query — so `customers/redact` and
  `customers/data_request` genuinely have no record to key on. But
  `ShopOrder.note` and the `customAttributes` on an order and its line items are
  free text a buyer may have typed personal details into, and those are erased
  only with the shop on uninstall, never per customer. The JSDoc was rewritten
  to say that precisely, and the privacy page's Retention section and its new
  paragraph under "Information We Do Not Collect" say the same thing in
  merchant language. No behaviour changed; nothing was papered over.
- The privacy page gained the "Team Members" section the plan asked for and a
  paragraph naming both scopes and what each is for. "Order history" left the
  do-not-collect list for "Customer accounts or customer profiles", and the two
  Flow bullets are gone from collection and usage.

### Other

- Review after the fact found three JSDoc sentences the removal left stale
  (`WorkflowSwitch.tsx` head, `MemberRun.OrderItems`, `Domain.QueueOrderItem`)
  and dead `??` fallbacks on the now non-null run fields; all fixed.
- `Domain.OrderSearch` refuses `#` alone: it normalised to `#` and matched
  every order under a chip reading `Order #`.
