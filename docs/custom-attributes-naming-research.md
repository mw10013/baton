# Custom attributes naming research

Shopify attaches two key/value lists to an order: one on the order as a whole, one on each line item. Baton stores both, shows the order-level list in one place and uses it nowhere, and names them inconsistently (`Domain.OrderAttribute`, the `Personalization` component, the labels "Order attributes" and "Properties"). This doc settles what to keep and what to call it. It came out of the review of the order card layout change (`docs/order-detail-card-layout-research.md`), which shipped as is. Nothing here is implemented yet.

## What the merchant sees

Two different things get called a "name" below, so they get separate columns. **On screen** is the text in the Shopify admin's order page. **Help Center term** is what Shopify's merchant documentation calls the feature that collects the data. They differ: the admin never prints the words "cart attributes" or "line item properties".

| List              | On screen in the Shopify admin order page                                  | Help Center term     | Collected by                            | Admin GraphQL               |
| ----------------- | -------------------------------------------------------------------------- | -------------------- | --------------------------------------- | --------------------------- |
| One per order     | A card headed **Additional details**, listing each `key` and `value`       | cart attributes      | Form fields on the storefront cart page | `Order.customAttributes`    |
| One per line item | `key: value` lines under that product in the order's item list, no heading | line item properties | Form fields on the product page         | `LineItem.customAttributes` |

Sources:

- The "Additional details" card: `refs/shopify-docs/docs/api/admin-graphql/latest/input-objects/OrderCreateOrderInput.md`, field `customAttributes`: "Appears in the **Additional details** section of an order details page."
- The line item lines: `docs/order-detail-clarity-research.md` §4: "No label at all is what the admin order page does: the properties print as `Key: Value` lines under the variant title inside the line item row". I have not seen this on a live order with properties. The sandbox store's orders have none.
- The Help Center terms, from [Add order notes on your cart page](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/common-customizations/add-order-notes): "Cart attributes are custom form fields that you can use to collect additional information from your customers on the cart page." "Line item properties are used to record customization information about specific products in an order. […] Line item properties are specified directly on the product page."

A merchant who set these up in their theme knows them as cart attributes and line item properties. A merchant reading an order sees "Additional details" and the lines under each item. The Admin GraphQL API calls both `customAttributes`, and no merchant sees that name.

GraphQL is the only Shopify surface that gives the two lists one name. Everywhere else they differ:

| Surface             | Order-level list                                                      | Line item list                                |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Admin GraphQL       | `Order.customAttributes`                                              | `LineItem.customAttributes`                   |
| Admin REST          | `Order.note_attributes` ("Appears in the Additional details section") | `line_items[].properties`                     |
| Liquid              | `checkout.attributes` / `cart.attributes`                             | `line_item.properties`                        |
| Shopify Flow manual | "cart attributes" (the Set Cart Attributes action)                    | "customAttributes (aka line item properties)" |
| Help Center         | cart attributes                                                       | line item properties                          |

Sources: `refs/shopify-docs/docs/api/admin-rest/latest/resources/order.md`, fields `note_attributes` and `properties`; `refs/flow-manual/reference/triggers/order-created.md`, heading "Using customAttributes (aka line item properties)". This is the strongest reason `customAttributes` is the wrong domain name: Shopify itself only uses it where the schema forces one name on two things.

## What Baton does with each

**Line item properties** are the maker's input, such as the engraving text or the initials:

- **Stored:** on `OrderLineItem`, and copied onto `WorkflowRun` when a run starts.
- **Shown:** on the merchant's line item card under "Properties", and to members on the run list and the work page through `RunItem`.

**Cart attributes** are stored and shown in one place, and used by nothing:

- **Stored:** on `ShopOrder`, by both sync paths.
- **Shown:** only in the order page aside, as the row "Order attributes".
- **Not used:** no workflow, run or member screen reads them. They describe the whole order, so they cannot belong to a line item or a workflow.

### Would a merchant expect to see cart attributes in Baton?

No. They read them in their Shopify admin's "Additional details" card, one click away through "View in Shopify". Baton is the production floor, not a second order page. Showing them in the aside duplicates the admin, and storing them for nothing else is data kept without a use.

The case for keeping them would be a production-relevant cart field, for example a delivery date picked at the cart. That is a feature of its own (which key, where the maker sees it), designed when a shop needs it, not a reason to store every cart field now.

**Counter-argument, considered and not taken.** Cart attributes are the list that checkout UI extensions and apps write to: a checkout extension's `applyAttributeChange`, Flow's "Set Cart Attributes" action, and gift-message and delivery-date apps all land there, because a line item's properties are fixed once it is in the cart and the order level is the only place left. A made-to-order shop's gift message or requested ship date is therefore likely to arrive as a cart attribute, and that is production-relevant. This does not change Q1: Baton has no place to show an order-level field to a maker (runs are per line item), so storing the list today serves nothing, and re-adding one line to each sync query when that feature is designed costs nothing while the schema is still editable in place.

## Verification (2026-09-24)

The claims in "What Baton does with each" were checked against the code and hold:

- Cart attributes: written by `OrderRepository.upsertOrder` from both `OrderSync` and `OrdersBulkRepository`; read only by the "Order attributes" fact in the order page aside. The seed input has no order-level list, so `ShopAgent.seedOrders` writes `[]` and that is the only other write.
- Line item properties: `OrderLineItem.customAttributes`, copied into `WorkflowRun.customAttributes` by `WorkflowRunRepository`; rendered by the `Personalization` component from the merchant's line item card and the member's `RunItem`.

The "Additional details" wording appears on both the GraphQL `OrderCreateOrderInput.customAttributes` and the REST `note_attributes` field. The claim that line item properties print as `Key: Value` lines under the item in the admin order page is not in `refs/` and remains unverified against a live order.

## Decisions (2026-09-24)

No open questions remain. Q7 and Q8 were decided on 2026-09-24 (see their sections). The implementation plan is `docs/line-item-properties-rename-plan.md`.

| #   | Decision                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Cut cart attributes: stop querying, storing and showing them. The aside's "Order attributes" row, the `ShopOrder` column and schema field, and the order-level `customAttributes { key value }` in both sync queries go. |
| Q2  | `Domain.OrderAttribute` becomes `Domain.LineItemProperty`, since after Q1 it describes only line item properties.                                                                                                        |
| Q3  | The `Personalization` component becomes `LineItemProperties`. The "Properties" heading on the card stays.                                                                                                                |
| Q4  | The column is `properties` on `OrderLineItem` and `lineItemProperties` on `WorkflowRun`, following the existing `title` / `lineItemTitle` pair. `customAttributes` stays only in `OrderSync`, where Baton reads the API. |
| Q5  | Seed workflow instructions say "in the properties", and the fixture's `item()` parameter becomes `properties`.                                                                                                           |
| Q6  | `privacy.tsx` keeps "personalization instructions": it is plain English for what the data is for, not the field's name.                                                                                                  |

Code-facing prose follows: the `Domain.ts` JSDocs and comments say "line item properties" where they mean that list. The `ShopOrder` JSDoc's reason for keeping `customAttributes` goes with the column.

Corrections to the decisions from checking the code:

- **Q3 also renames the prop.** `Personalization` takes `attributes`; as `LineItemProperties` it should take `properties`, or the component name and its prop disagree. The `RunItem` and order page call sites change with it.
- **Q4 touches `RunListRun`.** Its `Struct.omit` list names `customAttributes` and its JSDoc explains why that field is dropped from the run list. Both move to `lineItemProperties`. The doc's implementation list below did not include it.
- **Q4 touches two comments that use the field as an example.** `ShopAgentClient.ts` and `app.orders.index.tsx` cite `customAttributes` as the example of a decoded array field. The point stands for `properties`; the word changes.
- **Q6 is consistent with the fixture.** `e2e/fixture.ts` workflow instructions say "in the personalization" (seven sites) and the `WorkflowRun` JSDoc says "the line item's title and personalization". Q5 already renames the instructions; the JSDoc goes with the Q4 prose pass. `privacy.tsx` keeps its wording per Q6.

## Q7 and Q8 (decided 2026-09-24)

### Q7: hidden properties (keys starting with `_`)

Shopify's storefront convention hides a line item property from the cart, checkout and notifications when its key starts with an underscore. Product-option and customizer apps rely on it and store their own state there, for example a configuration id or a price adjustment. Those keys arrive in `LineItem.customAttributes` like any other and Baton prints every one to the maker. I could not confirm from `refs/` whether the admin order page shows or hides them.

**Decision: show every property, `_` keys included.** Baton is a back-office view. The merchant already sees everything on the order, and a member seeing an app's internal key is harmless. No filtering anywhere, no setting, nothing to design. The `LineItemProperties` JSDoc states this rule so nobody adds a filter later without a reason.

### Q8: `Domain.LineItemProperty` vs Shopify's `Attribute`

Q2 names the pair struct `LineItemProperty`. Shopify's GraphQL type is `Attribute` and is shared with the order-level list. After Q1 nothing in the domain is order-level, so the specific name is right, and `OrderSync` decodes the query result into it directly.

**Decision: `LineItemProperty`.** If order-level attributes ever come back (see the counter-argument above), add a separate `OrderAttribute` then.

## Q4: the stored column and field name

You asked for the name from first principles, since columns can be renamed in the initial schema now and the databases reset.

After Q1 the data exists in two places, and the column name should say what the data is in each:

- **`OrderLineItem`:** the line item's own properties. **`properties`** is Shopify's term for exactly this: the Help Center's "line item properties", REST's `line_items[].properties`, and Liquid's `line_item.properties`. On a line item row it cannot mean anything else, and it matches the type (`properties: Schema.Array(LineItemProperty)`) and the card heading.
- **`WorkflowRun`:** a copy of the line item's properties. The run already prefixes what it copies from the line item where the bare word would be ambiguous (`lineItemId`, `lineItemTitle`), and "properties" on a run could mean the run's own. **`lineItemProperties`** follows that precedent.

`customAttributes` is the Admin GraphQL name. It only matters where Baton reads Shopify, and that boundary is one place: `OrderSync`'s `LineItemNode`, which decodes the query result. The mapping `customAttributes` → `properties` happens there, as it already does for other fields the domain names differently.

Options:

1. **`properties` on `OrderLineItem`, `lineItemProperties` on `WorkflowRun`** (chosen). Each column says what it holds in its own table, using the merchant's term, and the API name stays at the one boundary that reads the API.
2. **`properties` in both.** Shorter, but on a run it reads as the run's own properties.
3. **`customAttributes` in both** (today). Matches the API, but a name no merchant knows, and it no longer says which list after Q1 leaves only one.

**Why not `lineItemProperties` on `OrderLineItem` too?**

- For: one name everywhere. A grep finds every site, the copy in `WorkflowRunRepository` reads `lineItemProperties` → `lineItemProperties`, and nobody has to learn that two names mean one thing. It is also the full Shopify term.
- Against: it stutters at every read, `item.lineItemProperties` and `lineItem.lineItemProperties`. It breaks the table's own convention: `OrderLineItem`'s columns are unprefixed (`title`, `sku`, `quantity`), because the table already says "line item".
- The deciding precedent: the codebase already names this exact pair. The line item's `title` becomes the run's `lineItemTitle`. The rule in use is "unprefixed on the line item, prefixed on the run where the bare word would be ambiguous", which is why `sku` and `variantTitle` stay bare on the run. `properties` / `lineItemProperties` is that rule applied again. Using `lineItemProperties` on both would make properties the one field that breaks it.

Option 1 was chosen for that reason. No better third name came up. `properties` is the only word Shopify, the card heading and the type (`LineItemProperty`) all agree on.

The implementation covers the three `create table` blocks in `ShopAgent.ts` (`ShopOrder` loses the column, `OrderLineItem` and `WorkflowRun` rename theirs), the `OrderRepository` and `WorkflowRunRepository` SQL including the select column lists, the `Domain` structs, `RunListRun`'s omit list, and the seed input schema, `OrderSync` and `OrdersBulkRepository` queries and decoders, `ShopAgent.seedOrders`, `api.dev.seed.ts`, `e2e/seed.ts` and `e2e/fixture.ts`, and every `.customAttributes` read in the routes and components.
