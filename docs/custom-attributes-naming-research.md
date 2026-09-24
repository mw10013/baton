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

A merchant who set these up in their theme knows them as cart attributes and line item properties. A merchant reading an order sees "Additional details" and the lines under each item. The API calls both `customAttributes`, and no merchant sees that name.

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

## Decisions (2026-09-24)

No open questions remain.

| #   | Decision                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Cut cart attributes: stop querying, storing and showing them. The aside's "Order attributes" row, the `ShopOrder` column and schema field, and the order-level `customAttributes { key value }` in both sync queries go. |
| Q2  | `Domain.OrderAttribute` becomes `Domain.LineItemProperty`, since after Q1 it describes only line item properties.                                                                                                        |
| Q3  | The `Personalization` component becomes `LineItemProperties`. The "Properties" heading on the card stays.                                                                                                                |
| Q4  | The column is `properties` on `OrderLineItem` and `lineItemProperties` on `WorkflowRun`, following the existing `title` / `lineItemTitle` pair. `customAttributes` stays only in `OrderSync`, where Baton reads the API. |
| Q5  | Seed workflow instructions say "in the properties", and the fixture's `item()` parameter becomes `properties`.                                                                                                           |
| Q6  | `privacy.tsx` keeps "personalization instructions": it is plain English for what the data is for, not the field's name.                                                                                                  |

Code-facing prose follows: the `Domain.ts` JSDocs and comments say "line item properties" where they mean that list. The `ShopOrder` JSDoc's reason for keeping `customAttributes` goes with the column.

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

The implementation covers the two `create table` blocks in `ShopAgent.ts`, the `OrderRepository` and `WorkflowRunRepository` SQL, the `Domain` structs and the ingest schema, `OrderSync`, `api.dev.seed.ts`, `e2e/seed.ts` and `e2e/fixture.ts`, and every `.customAttributes` read in the routes and components.
