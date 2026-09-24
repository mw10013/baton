# Line item properties rename: implementation plan

Hand-off plan for the decisions in `docs/custom-attributes-naming-research.md` (Q1 to Q8, decided 2026-09-24). Read that doc's "Decisions" table first. This plan is self-contained otherwise.

The change: drop order-level cart attributes entirely, and rename the line item list from `customAttributes` to `properties` on `OrderLineItem` and `lineItemProperties` on `WorkflowRun`. `Domain.OrderAttribute` becomes `Domain.LineItemProperty`, the `Personalization` component becomes `LineItemProperties`. `customAttributes` survives only in the two GraphQL queries and the `OrderSync` decoders that read Shopify.

**No migration.** The project is prototyping and every Durable Object and local D1 is reset from scratch. Edit the `create table` statements in `src/lib/ShopAgent.ts` in place. Do not add a `migrations/` file, an `alter table`, a version bump, or a compatibility read of the old column.

**The user resets local state, not the agent.** Do not run `pnpm d1:reset`, delete `.wrangler/state`, or stop or start the dev server yourself. When phases 1 to 7's static checks pass (typecheck, lint, unit tests, fmt), stop and tell the user: "Code change complete. Please stop the dev server, run `pnpm d1:reset`, clear `.wrangler/state`, restart `pnpm app:dev`, run `pnpm seed`, and tell me when it is up." Wait for that reply before phase 8.

The implementing agent may use the Chrome DevTools MCP (`mcp__chrome-devtools__*`) to look at the pages against local dev after the rename, in the way `docs/order-detail-clarity-plan.md` describes. It is optional here: the render does not change except that one aside row disappears.

## Rules

- No behaviour change beyond the removal of the "Order attributes" aside row. Every other screen renders exactly what it did.
- Every property is shown, including keys starting with `_` (Q7). Do not add filtering.
- The "Properties" heading on the merchant's line item card stays (Q3). `privacy.tsx` keeps "personalization instructions" (Q6).
- `customAttributes` stays only where Baton reads the Admin GraphQL API: the `#graphql` strings in `OrderSync.ts` and `OrdersBulkRepository.ts`, and `OrderSync.LineItemNode`. The mapping to `properties` happens in `OrderSync.toOrderLineItem`.
- After the code change, run `pnpm graphql-codegen` (the queries change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm fmt` repo-wide, keeping every file `fmt` touches.

## Phase 1: Domain

`src/lib/Domain.ts`:

1. Rename `OrderAttribute` to `LineItemProperty` (const and type). JSDoc: "One line item property: Shopify's `Attribute` as it appears in `LineItem.customAttributes`. The Help Center calls these line item properties, REST and Liquid call them `properties`, and the merchant's line item card is headed Properties. Order-level attributes are not stored (see `ShopOrder`)." Keep it in `Domain`'s prose style, no file references.
2. `ShopOrder`: remove `customAttributes`. Rewrite the JSDoc sentence "`note` and `customAttributes` stay because they carry the personalization text a maker works from" to: "`note` stays because it can carry instructions a maker works from. Order-level `customAttributes` (the cart attributes the admin shows under Additional details) are not stored: no run or screen reads an order-level field, and the merchant reads them in the admin one click away."
3. `OrderLineItem`: rename `customAttributes` to `properties`, type `Schema.fromJsonString(Schema.Array(LineItemProperty))`. Add to the struct JSDoc: "`properties` is the line item's own list, every key stored and shown as Shopify sends it, underscore-prefixed app keys included; Baton is a back-office view and hides nothing the merchant can already see in the admin."
4. `WorkflowRun`: rename `customAttributes` to `lineItemProperties`. JSDoc sentence "the line item's title and personalization" becomes "the line item's title and properties". Add a note beside the field: "The line item's `properties` at creation. Prefixed like `lineItemTitle` because on a run the bare word would read as the run's own."
5. `RunListRun`: the `Struct.omit` list entry `"customAttributes"` becomes `"lineItemProperties"`. Its JSDoc's "and `customAttributes`, which is the one that matters" becomes "and `lineItemProperties`, which is the one that matters".
6. `SeedOrdersInput.orders[].lineItems[]`: rename `customAttributes` to `properties`, type `Schema.optionalKey(Schema.Array(LineItemProperty))`.
7. Grep `Domain.ts` for "personalization" and "customAttributes" afterwards. Any remaining mention that means the line item list says "line item properties" or "properties".

## Phase 2: Storage

`src/lib/ShopAgent.ts`, the `create table` block:

- `ShopOrder`: delete the line `customAttributes text not null,`.
- `OrderLineItem`: `customAttributes text not null,` becomes `properties text not null,`.
- `WorkflowRun`: `customAttributes text not null,` becomes `lineItemProperties text not null,`.

`src/lib/OrderRepository.ts`:

- `orderColumns`: remove `customAttributes` from the literal.
- `upsertOrder`'s `insert into ShopOrder`: remove the column from the column list, the values (`${json(order.customAttributes)}`), and the `on conflict` set.
- The `insert into OrderLineItem`: `customAttributes` becomes `properties` in the column list, values (`${json(item.properties)}`) and the `on conflict` set.

`src/lib/WorkflowRunRepository.ts`:

- Its own `orderColumns` literal: remove `customAttributes`.
- `insert into WorkflowRun`: `customAttributes` becomes `lineItemProperties` in the column list and the value becomes `${json(lineItem.properties)}`.
- Grep the file for `customAttributes`; the JSDocs that mention the copied fields should say "properties".

`src/lib/ShopAgent.ts`, `seedOrders`: delete `customAttributes: [],` from the `ShopOrder` literal; in the line item literal `customAttributes: item.customAttributes ?? []` becomes `properties: item.properties ?? []`.

## Phase 3: Sync boundary

`src/lib/OrderSync.ts`:

- `OrderNode`: remove `customAttributes`.
- `LineItemNode`: keep the field name `customAttributes` (it decodes the API response) but type it `Schema.Array(Domain.LineItemProperty)`.
- `toShopOrder`: remove the `customAttributes` line.
- `toOrderLineItem`: `customAttributes: node.customAttributes` becomes `properties: node.customAttributes`, with a one-line comment: `Shopify's name for the list; the domain calls it properties (see Domain.LineItemProperty).`
- The single-order `#graphql` query: delete the order-level `customAttributes { key value }` line. Keep the one under `nodes`.

`src/lib/OrdersBulkRepository.ts`: delete the order-level `customAttributes { key value }` line from the bulk query. Keep the one under `lineItems.edges.node`.

`src/lib/ShopAgentOrdersStream.ts`: the JSDoc at the top mentions "silently discarding personalization"; change to "silently discarding line item properties".

Run `pnpm graphql-codegen` after this phase.

## Phase 4: Components and routes

`src/components/MemberRun.tsx`:

- Rename `Personalization` to `LineItemProperties`, prop `attributes` to `properties`, type `readonly Domain.LineItemProperty[]`.
- JSDoc: replace the first sentence with "A line item's properties as label / value rows rather than one joined string:". Keep the rest. Add the Q7 rule as its own sentence: "Every property is drawn, underscore-prefixed app keys included: Baton is a back-office view and the merchant sees the same keys in the admin, so there is nothing to hide from either screen." Add: "The merchant's order page renders this too under a Properties heading, so both screens show a line item's properties alike."
- `RunItem`: `<LineItemProperties properties={run.lineItemProperties} />`.

`src/routes/app.orders.$orderId.tsx`:

- Import `LineItemProperties` instead of `Personalization`.
- The line item card: `item.customAttributes` becomes `item.properties` (two sites); the component call becomes `<LineItemProperties properties={item.properties} />`. Rewrite the JSX comment: `"Properties" is Shopify's merchant-facing name for the list: the Help Center says "line item properties", REST and Liquid say properties, only the GraphQL API says customAttributes. Shortened because the heading already sits inside the line item's card. The rows are the work page's ({@link LineItemProperties}).`
- The aside: delete the `fact("Order attributes", ...)` call entirely. Nothing replaces it.
- The route JSDoc "every line item with its properties and workflow runs" already uses the right word.

`src/routes/app.orders.index.tsx` JSDoc on `decodeOrdersView`: "`customAttributes` an array" becomes "`properties` an array" (the example is about line items; any decoded array field works, keep it accurate).

`src/lib/ShopAgentClient.ts` JSDoc near `runListView`: "`customAttributes` an array, not JSON text" becomes "`lineItemProperties` an array, not JSON text".

`src/routes/webhooks.compliance.ts` JSDoc: "`ShopOrder.note` and the `customAttributes` on an order and its line items are free text" becomes "`ShopOrder.note` and a line item's `properties` are free text". The rest of the paragraph stands.

`src/routes/privacy.tsx`: no change (Q6).

`src/routes/api.dev.seed.ts`: the line item schema field `customAttributes` becomes `properties`, typed with `Domain.LineItemProperty`. The handler spreads each item (`...rest`) into `Domain.SeedOrdersInput`, so nothing else in the file changes.

## Phase 5: E2E seed and fixture

`e2e/seed.ts`: `SeedLineItem.customAttributes` becomes `properties`, same shape.

`e2e/fixture.ts`:

- `item()`'s fourth parameter `personalization` becomes `properties`, and the returned key becomes `properties: Object.entries(properties).map(...)`.
- Every workflow `instructions` string that says "in the personalization" (seven sites, lines around 173 to 314) says "in the properties" instead: "Engraving text is in the properties. Confirm spelling against the order before running the laser.", "Initials in the properties; centre on the cover.", and so on. Keep everything else in each string.
- Comments near lines 599, 694 and 763 that say "personalized" describe boards with different properties; leave "personalized" where it is plain English about the product, change it only where it names the field.

`e2e/orders.spec.ts`: line 85's comment "personalization (`customAttributes`)" becomes "properties"; line 561's `customAttributes:` key becomes `properties:`. Grep the spec for "Order attributes"; if any assertion expects that aside row, delete the assertion.

## Phase 6: Tests

Rename by hand in `test/integration/`; the exact sites from a grep of `customAttributes`:

- `domain.test.ts` (3 fixtures), `member-runs-socket.test.ts` (2), `shop-agent-orders-stream.test.ts` (4, including the assertion on `lineItems[0]?.customAttributes[0]?.value`), `shop-agent-workflows.test.ts` (2 fixtures plus two raw `insert` column lists at lines 1371 and 1379), `shopify-webhook.test.ts` (1), `order-repository.test.ts` (fixtures at 63 and 85, assertion at 177, raw `WorkflowRun` column lists at 374, 925, 1839), `workflow-run-repository.test.ts` (fixtures at 139 and 162, raw column lists at 633, 653, 693, assertions at 735, 906, 1560).

For each site decide which table it belongs to: a `ShopOrder` fixture drops the key; an `OrderLineItem` fixture or raw insert uses `properties`; a `WorkflowRun` fixture, raw insert or assertion uses `lineItemProperties`. The order-repository assertion at line 177 (`order.customAttributes[0]?.value === "yes"`) tests the order-level list and is deleted with the feature; if the surrounding test only exists to check that field, delete the test.

Add one test whose title is the Q7 rule, in `test/integration/domain.test.ts` or wherever `RunItem`/`LineItemProperties` rendering is already covered: "every line item property is kept, underscore-prefixed keys included" — seed a line item with `[{ key: "_ioid", value: "x" }, { key: "Engraving", value: "Hi" }]`, start a run, and assert the run's `lineItemProperties` has both entries in order. If no rendering test exists, a repository-level test on the copied run is enough.

## Phase 7: Verify

```bash
pnpm graphql-codegen
pnpm typecheck
pnpm lint
pnpm test
pnpm fmt
git status --short
```

Then `grep -rn "customAttributes\|OrderAttribute\|Personalization" src e2e test` must list only: the two `#graphql` strings, `OrderSync.LineItemNode` and `toOrderLineItem`, and the two JSX/JSDoc sentences that explain that Shopify's API name is `customAttributes`. `grep -rn "Order attributes" src e2e test` must return nothing.

When all of the above passes, stop and ask the user to reset local state (see "The user resets local state" at the top). Do not proceed to phase 8 until they confirm the dev server is back up and seeded.

## Phase 8: E2E and a look (after the user's reset)

Run `npm run test:e2e --`. If the Chrome DevTools MCP is used, open a seeded order and confirm the line item card still shows the "Properties" heading with its rows and the aside no longer has an "Order attributes" row. Report the e2e output as it is, including any failures.

Do not commit.

## Deviations and issues

For the implementing agent. Record here anything that did not go as the plan says: a site the plan missed, a step that was wrong or unnecessary, a test that failed and why, a name or JSDoc changed differently and the reason. One bullet per item, in the order found, with the file and phase. Leave the section in place if empty and write "None." so the reader knows it was checked.

- Phase 4, `src/routes/app.orders.index.tsx`: the route JSDoc also said "line items, personalization, workflows"; now "line items, their properties, workflows".
- Phase 5, `e2e/fixture.ts`: the comment near line 694 said "a personalization with no value", naming the field; now "a property with no value". Lines 377, 599 and 763 keep "personalized" (plain English).
- Phase 6, `test/integration/shop-agent-orders-stream.test.ts`: `lineItemLine` keeps `customAttributes` because it is a Shopify bulk NDJSON line decoded by `OrderSync.LineItemNode`; `orderLine` drops it because the bulk query no longer selects it. So the phase 7 grep also lists this one test site.
- Phase 6, `test/integration/shop-agent-workflows.test.ts`: the raw `ShopOrder` insert dropped both the column and its `'[]'` value.
- Phase 6, `test/integration/order-repository.test.ts`: the assertion at line 177 was one line of a broader `getOrder` test, so only that line was deleted.
- Phase 6: the Q7 test is in `workflow-run-repository.test.ts` under `reconcileOrder`, at repository level (no rendering test exists).
