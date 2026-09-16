# Customer data and the order workflow: do we need either?

Research date: 2026-09-15. Scope: two linked product decisions for small and
medium made-to-order shops. (1) Should Baton show customer identity anywhere, and
let a merchant find an order by customer? (2) Should the shop-level **order
workflow** stay, given the concepts it forces on the merchant and the shipping and
packing steps it invites, which are the only place customer data would become
necessary? A third question falls out of the second: if Baton never fulfils, what
exactly does a merchant do once every item on an order is made?

Companion docs: `docs/orders-operational-surface-research.md` (the orders index as
the merchant's surface), `docs/order-detail-ux-research.md` §"Is the order workflow
'shipping'?", `docs/route-to-ship-departments-research.md` (the competitor's
production/fulfilment boundary), `docs/refs-competitors-research.md` (competitor
data-access declarations). The deleted order-workflow design docs are recoverable
with `git show 4941c53^:docs/order-workflow-singleton-and-route-research.md`.

## Decisions (2026-09-15)

Settled in review of this doc. Where a later section hedges, this list wins.

1. **No customer identity, ever.** Stay at protected-customer-data Level 1. A
   customer name on the merchant order page only is not worth Level 2. Members
   stay as they are.
2. **Remove the order workflow.** The tracked "pack" step it existed for was an
   assumption, not an observed need; assume a small shop does not need it. The
   "Packed" flag in Part 2 option C stays in reserve, unbuilt.
3. **Fulfilment is manual, in Shopify.** Baton does not create fulfilments, holds,
   or tags. Shops that fulfil outside Shopify are out of scope; "Shipped" means
   Shopify reported it.
4. **Defer every write to Shopify**, including the Ready to ship order tag. Not in
   the removal, not on the roadmap until a merchant asks.
5. **Build the two lookup fixes**: order-number search on the Orders page, and an
   admin link extension on the Shopify order page that opens Baton's order page.
   The extension is a TOML file, no code; see Part 1 §"The Shopify → Baton link".
6. **Rewrite `src/routes/privacy.tsx`** to match the Level 1 posture.

## Summary and recommendation

1. **Do not add customer identity.** Stay at Shopify protected-customer-data
   **Level 1**: orders and line items, no name, email, phone, or street address.
   Solve the "where is this customer's order" problem with (a) an order-number
   search on the Orders page, which is missing today and costs nothing in data
   access, and (b) a one-click jump from the Shopify order page into Baton, so the
   merchant does the customer lookup in the admin, which already has the best
   customer search there is, and lands on Baton's order page without copying an ID.
2. **Remove the order workflow.** It is the only feature that pulls Baton toward
   packing, shipping, and therefore addresses. Among the five competitor apps only
   the two enterprise-leaning boards attempt a post-production order stage, and
   neither documents how items rejoin. The three apps aimed at Baton's segment have
   no order-level stage at all and market **"Produced is not fulfilled"** as a
   virtue. Baton already computes the state that matters, **Ready to ship**, from
   item runs alone.
3. **Keep fulfilment manual, in Shopify.** Four of the five competitors, including
   Route to Ship despite its marketing, never create fulfilments. The merchant's
   flow after the last item is made is: Baton shows the order as Ready to ship, the
   merchant clicks "Fulfil in Shopify", packs and buys the label there. The one
   write that would be cheap later is an order **tag** when an order becomes
   ready (needs only the `write_orders` scope Baton already holds). **Deferred**
   by decision 4; recorded here so the option is not re-researched.

The rest of the doc is the evidence and the trade-offs behind each.

## Where Baton stands today

Facts verified against the code on 2026-09-15.

- **Scopes**: `write_orders,read_products` (`shopify.app.toml:9`). No customer
  scope anywhere. `write_orders` is never exercised; the only mutation in the
  repo is `bulkOperationRunQuery` (`src/lib/OrdersBulkRepository.ts:154`).
- **No customer field is fetched.** Both ingestion paths share one field set
  (`src/lib/OrderSync.ts:131-157`, `src/lib/OrdersBulkRepository.ts:25-65`): order
  id, name, dates, financial and fulfilment status, tags, note, custom attributes;
  line-item title, variant, SKU, quantities, product id and tags. No `customer`,
  `email`, `phone`, `shippingAddress`, `billingAddress`, no prices. The `ShopOrder`
  shape says so on purpose (`src/lib/Domain.ts:1173-1177`).
- **Members see less still.** The member run view is a snapshot of order name,
  line-item title, variant, SKU, quantity, custom attributes, plus the live order
  note (`src/lib/Domain.ts:2140-2166`, `2438-2443`). The only PII channel is
  merchant-authored or customer-typed free text in the note and attributes, which
  MakerBatch's privacy policy also calls out as the residual risk in this category.
- **Compliance webhooks** are subscribed and are no-ops by design
  (`src/routes/webhooks.compliance.ts`); the handler's JSDoc now names the one
  residual: order notes and custom attributes are free text erased only with the
  shop on `app/uninstalled`, never per customer.
- **Orders page has an order-number search** (`?q=`, decision 5, built
  2026-09-15): a prefix match on `ShopOrder.name` after `Domain.normaliseOrderSearch`,
  beside the four filters (stage strip, paid, attention, waiting-on team). No
  search by customer or product.
- **An admin link** `Open in Baton` (`extensions/baton-order-link`) on the
  Shopify order page lands on `/app/orders/from-shopify`, which redirects to
  `/app/orders/<legacyId>` (decision 5, built 2026-09-15).
- **Fulfilment is read-only.** `displayFulfillmentStatus` is stored and drives
  "Shipped" and the reconcile stop gate. "Ready to ship" is derived, never stored,
  and clears when Shopify reports the fulfilment (`app.orders.index.tsx`).
  The index row and the detail banner both link "Fulfil in Shopify" via
  `shopify://admin/orders/<legacyId>` (`src/lib/orderLinks.ts`).
- **The order workflow is gone** (decision 2, removed 2026-09-15): no `type`
  column, no singleton, no order runs, `readyWhere` is stage-order only. The
  §"The order workflow" section below describes what was removed and why.
- **`src/routes/privacy.tsx` was rewritten 2026-09-15** (decision 6) for the
  Level 1 posture: both scopes named, order fields listed, customer identity
  listed as not collected, the note/attributes free-text residual stated, and a
  Team Members section.

## Part 1: customer data

### The merchant need

The concrete scenario: a customer emails "where is my order?", and the merchant
wants to see which items are made and which are not. Today the path is Shopify
admin → search customer → open order → read the order number → Baton → scroll the
orders list, because Baton has no search. That is four hops and one of them is
"scroll", which fails at fifty open orders.

Two separate problems hide in that path, and only one of them needs customer data:

| Problem                                                 | Needs customer data? | Fix                                                        |
| ------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| Baton cannot find an order by its number                | No                   | Order-number search on the Orders page                     |
| The merchant must copy an order number between two apps | No                   | A link from the Shopify order page into Baton's order page |
| The merchant wants to type a customer's name into Baton | Yes, Level 2         | Not recommended                                            |

Small-shop reality: the merchant is usually the person answering the customer
email, and they are in the Shopify admin or their inbox when the question arrives,
not in Baton. The admin's default full-text search matches customer name across the
order document (`refs/shopify-docs/docs/api/usage/search-syntax.md`), which is
better than anything Baton would build with a copied `customer.displayName`. The
missing piece is the return trip, not the lookup.

### What the competitors do

From `refs/` (App Store listings, marketing, privacy pages, screenshots) and the
logged-in inspection in `docs/route-to-ship-departments-research.md`.

|                         | Route to Ship                                       | Kanbanify                   | Maker's Production View | MakerBatch              | BenchCue                        |
| ----------------------- | --------------------------------------------------- | --------------------------- | ----------------------- | ----------------------- | ------------------------------- |
| Customer name on board  | Yes                                                 | Yes                         | No                      | No                      | No                              |
| Free-text search        | order #, customer, pipeline                         | customer, product, vendor   | none; group by product  | none; group by property | none; it is an order-page block |
| Protected customer data | Level 2: name, email, phone, address                | Level 2: name, email        | Level 1, `read_orders`  | Level 1, `read_orders`  | Level 1                         |
| Target                  | 2–30 person teams, 10–500+ orders/mo, up to $499/mo | solo and small teams, $7/mo | hand makers, $15/mo     | solo bench, $0–$19/mo   | one-person shops, $7/mo         |
| Reviews                 | 1                                                   | 3                           | 0                       | 0                       | 0                               |

The split is by product shape, not merchant size. The two **boards of orders**
show the customer and sell search-by-customer. The three **run-sheet and viewer**
apps aimed squarely at Baton's segment request `read_orders` only and turn "no
customer PII, ever" into a headline bullet and a compliance advantage
(`refs/makers-production-view/index.md:22,68`, `refs/benchcue/index.md:57-63`,
`refs/makerbatch/privacy.md:16`).

One nuance worth copying from Route to Ship: it shows customer names on the
**manager** board and hides them on the **worker** "My Work" screen, whose search
is "order #, product, step" (`refs/route-to-ship/_assets/CN7m4-iSrJQDEAE=.png`).
Customer identity is a manager affordance there, never a shop-floor one. Baton's
member side already matches that boundary.

Caveat on the evidence: the two apps that show customers are also the only two
with any reviews. Nothing in the refs shows the PII-free posture losing, but
nothing shows it winning either. All three PII-free apps launched June–August 2026.

### What Shopify's rules actually cost

From `refs/shopify-docs/docs/apps/launch/protected-customer-data.md` and live
reference pages (the local mirror is missing `Order`, `Customer`, `orders`, and all
fulfilment reference docs; see the note at the end).

- **Protected customer data (PCD) is an app-level approval in the Partner
  Dashboard, separate from OAuth scopes.** `Order` is a protected _resource_, so
  reading orders at all puts Baton at **Level 1** and the app must request it
  before App Store submission. Level 1 obligations: data minimisation, a privacy
  policy that says what is processed and why, retention periods, encryption in
  transit and at rest. Baton's current posture already meets these in substance;
  the privacy page does not yet say so.
- **Level 2** is triggered by any of four field groups: name, email, phone, and
  address (lines 1 and 2, zip, geolocation). It adds encrypted backups, test/prod
  separation, a data-loss-prevention strategy, staff access limits, an access log
  to protected data, an incident-response policy, and participation in data
  protection reviews. Showing a customer name on the orders page is Level 2.
- **`city`, `province`, and `country` are not protected fields.** A Level 1 app
  may show "Toronto, ON". Not a reason to add them, but it means a country or
  region column is free if one is ever wanted for routing or lead-time reasons.
- **`read_customers` is a third, separate gate.** `Order.customer { ... }` needs
  the scope plus PCD. `Order.email` and `Order.shippingAddress` are fields on
  `Order` and need only the order scope plus PCD. Baton could show a name without
  ever requesting `read_customers`, but it cannot avoid Level 2.
- **The install screen already says "customers".** Any app with an order scope
  shows the "View personal data" group on install, whatever it queries. The user's
  intuition on this is correct and there is nothing to do about it short of not
  reading orders. Baton's privacy page is where to explain that the app fetches no
  identity fields.
- **Redaction is per field, with an `errors` entry.** An unapproved field comes
  back `null` alongside a 200 and an `errors` array. Baton never selects those
  fields, so this never fires, but any future query must decode tolerant of it.
- The 30-day sync window (`src/lib/orderSyncConstants.ts:6`) sits inside the
  ungated 60-day grant; `read_all_orders` is not needed.

### Options

**A. Stay Level 1, add order-number search, add a Shopify → Baton link.**
Recommended. Search over `ShopOrder.name` is a `like` clause and a text field on
the existing filter row; order names are already the row's identity. The return
trip is an **admin link extension** on the order page, which opens Baton at
`/app/orders/<legacyId>`. That is one click from the record the merchant found by
customer name. The member side is untouched. Cost: a small feature and one
extension. Data-access cost: none.

#### The Shopify → Baton link

Reviewed as "this sounds challenging". It is not. An admin link extension is a
`shopify.extension.toml` with no code and no UI
(`refs/shopify-docs/docs/apps/build/admin/admin-links/create-admin-links.md`):

```toml
[[extensions]]
name = "Open in Baton"
handle = "baton-order-link"
type = "admin_link"

[[extensions.targeting]]
target = "admin.order-details.action.link"
url = "/app/orders/from-shopify"
```

Shopify puts the link in the order page's "More actions" menu and, on click,
appends the shop and the displayed order's id as query parameters to the relative
URL ("Admin link extensions dynamically append generated URL parameters that
identify the store that launched the action and the resource IDs of the currently
selected or displayed resource", `.../admin/admin-links.md:22`). The target name
follows the CLI's own derivation for the `ORDERS#SHOW` context
(`refs/shopify-cli/packages/app/src/cli/services/admin-link/utils.ts`,
`contextToTarget`), and the Shopify Flow app ships exactly this shape of link on
the order page. Baton's side is one route that reads the id parameter and
redirects to `/app/orders/<legacyId>`, which already exists. Generate it with
`shopify app generate extension --template admin_link`, run `shopify app dev`, and
confirm the parameter names from the first request before hard-coding them; the
tutorial does not spell them out.

Two things it is not: it is not an admin **action** extension (those render a
Polaris modal inside the admin and need a build), and it does not need any new
scope.

**B. Level 2 for the merchant side only: name, maybe email, on the orders index
and detail; search by customer.** The Kanbanify shape. Requires PCD Level 2
approval, a privacy-policy rewrite, an access log, incident-response and DLP
documents, and data protection reviews once installs grow. The stored `raw` column
and the SQLite in the Durable Object would hold identity, so retention and
redaction become real: `customers/redact` would have to search and scrub, and
`customers/data_request` would have to report. Members must be walled off, which is
already true by construction but becomes a promise to audit. Gain: the merchant can
type a name into Baton instead of into the admin. For a solo or three-person shop,
that gain is the fourth hop of a path that option A cuts to one.

**C. Level 2 including address, to enable packing and label steps.** Only makes
sense if the order workflow stays and grows shipping duties. See Part 2; not
recommended.

### Recommendation

Option A. The customer's identity is a lookup key the admin already owns; Baton
needs to be reachable from that lookup, not to duplicate it. Baton should say what
the three small-shop competitors say, on the listing and on the privacy page: it
reads orders and line items to run production, never customer names, addresses,
emails, or phone numbers, and members see only what they need to make the item.

## Part 2: the order workflow

### What it is and why it is hard to explain

The implementation is careful and the conceptual load is real. What the merchant
has to learn, in the order they meet it:

1. There is a second kind of workflow, with its own nav entry, that runs once per
   order rather than once per item.
2. It always exists, cannot be renamed or deleted, and is off because it has no
   steps. "I don't want it" is Turn off, but it starts off, so the first encounter
   is an empty thing that is already off.
3. It cannot be turned on until it has steps and every step has a team.
4. It runs "after every item with a workflow is made", and an order with no
   matching items never starts it (`ORDER_WORKFLOW_TRIGGER`,
   `src/lib/workflowShared.ts:44-55`). That rule needed its own copy audit to get
   right (the deleted `order-workflow-trigger-truth-research.md` catalogued eight
   issues).
5. Orders placed before it was turned on are skipped, unless the merchant backdates
   "Applies since" in the Turn on dialog or attaches an item workflow by hand,
   which quietly opts the whole order in.
6. On the order page the section may show a run, or one of five one-line reasons
   why there is none (off, no steps, unassigned team, too old, no item runs, all
   cancelled), or nothing at all (`app.orders.$orderId.tsx:816-853`).
7. Undo on an item step is refused once the order run has started.

Each rule is defensible and each was chosen to close a hole. Together they are the
single largest concept in the app after "workflow" itself, and they exist to serve
a step the product refuses to name ("Starts when every item is made", never
"Shipping"; `docs/order-detail-ux-research.md:168-184`).

### The holes still open

From the deleted design doc and the current code:

- **On is not startable.** Deleting a team nulls `teamId` but leaves `activatedAt`
  set, so an "Active" workflow can silently create nothing; the order page reports
  it after the fact as `unassigned`.
- The Turn on dialog's count does not filter `fullyPaid` while the reconcile does
  (`src/lib/WorkflowRunRepository.ts:1229-1240` versus `:932-935`), so "Include 12
  orders" can start fewer than 12 runs.
- Editing the order workflow never touches orders already in progress, which is
  right for item workflows but surprising for a packing step added mid-week.
- Two near-identical editors must be kept in lockstep
  (`docs/workflow-editor-chrome-research.md:221-245`).

### What the competitors do about post-production

|                         | Post-production order stage                                                              | How items rejoin                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Route to Ship           | QC and Dispatch are ordinary departments with a `Complete once per order` switch         | **No documented join rule.** The UI ships copy for the friction: "{n} finished items are waiting for the rest of their orders" |
| Kanbanify               | Stages are columns and the card _is_ the order, so QA and Ready to ship are just columns | No item layer exists, so nothing rejoins                                                                                       |
| Maker's Production View | None; one binary `produced` per line item                                                | "Produced ≠ fulfilled"; ship in Shopify                                                                                        |
| MakerBatch              | None; batches dissolve orders into property groups                                       | Same                                                                                                                           |
| BenchCue                | None; it is a viewer and printer                                                         | Same                                                                                                                           |

Only Route to Ship faces the same problem Baton solved, and it did not solve it.
Baton's explicit wait-for-all-items rule is better engineering than the
competitor's undefined aggregation, and it is also solving a problem the small-shop
apps decided not to have. Route to Ship's two concurrency knobs (Sequential versus
Parallel pipelines, and a free-text Parallel Group ID on tasks) are what the user
found confusing, and they are the cost of trying to be a general graph. Baton's
stages-with-parallel-steps model is the simpler answer and does not need lanes;
the order workflow is the one place Baton reached past it.

### What the order workflow would be for, honestly

The step candidates are quality control, packing, and shipping. Take them in turn.

- **Quality control** of a single made item belongs at the end of that item's
  workflow, where the item's team already is. Order-level QC only means "check the
  whole order together", which for a two-item order is the same person at the same
  bench.
- **Packing** is the real order-level task: every item in one box. But packing
  ends at the shipping label, and the label needs the address. Either Baton shows
  the address (Part 1, option C) or the packer has to open Shopify anyway, and
  Shopify's fulfilment screen _is_ the packing screen: it lists the items, prints
  the packing slip, buys the label, and marks fulfilled in one place. A Baton
  "Pack" step becomes a checkbox the packer ticks after doing the work somewhere
  else.
- **Shipping** as a Baton step would mean either Baton fulfilling (Part 3) or a
  step whose completion duplicates a state Shopify already reports and Baton
  already reads.

So the order workflow's natural steps all end at the Shopify fulfilment screen,
which is exactly where Baton's "Fulfil in Shopify" link already sends the merchant.

### Options

**A. Remove it.** Recommended. Delete the singleton, its two routes, the order-run
branch of reconcile, the readiness gate's order half, and the member-side
`isOrderRun` branches. The estimate from the code audit: roughly 1,000 lines to
delete outright, 500–600 lines of surgical edits across about 18 files, and about
950 lines of tests, with no D1 migration because the row lives in the Durable
Object schema. The design docs stay in git history should it return. What the
merchant loses: a tracked, team-assigned "pack" step. What they keep: the Ready to
ship state, the fulfil link, and the item-level QC they can add to any item
workflow today.

**B. Keep it, but hide it until asked for.** Drop the nav entry and reach it from
a "Add steps after every item is made" affordance on the workflows page. Reduces
the first-run confusion, changes nothing else. The seven rules and the holes
remain, and the two editors still drift.

**C. Replace it with a single optional order-level flag.** A "Packed" checkbox on
the order page, no steps, no teams, no activation. This is Maker's Production
View's `produced` model applied to the order. It keeps a place to record that the
box is closed without any of the workflow machinery. Worth holding in reserve: it
is a one-day feature if merchants ask for it after A, and it needs no customer
data.

### Recommendation

Option A, with C as the answer if a merchant asks. Baton's promise is "know where
every made-to-order item is, and hand it to Shopify when it is done." The order
workflow blurs the hand-off line, and the line is the thing that keeps Baton at
Level 1. Removing it also removes the only reason Part 1 option C would ever come
up.

## Part 3: how an order gets to shipped

### The flow with no order workflow

1. Every item run on the order reaches done. The orders index computes **Ready to
   ship** from that alone (open, no open item run, at least one done,
   unfulfilled in Shopify).
2. The merchant filters the index to Ready to ship, or sees the count on the stage
   strip. That is the "how would a merchant know" answer: the stage strip is the
   pick list.
3. The row's link reads "Fulfil in Shopify" and opens the order in the admin. The
   merchant packs, prints the slip, buys the label, and marks fulfilled there.
4. Shopify's `orders/updated` webhook brings back `displayFulfillmentStatus`, the
   order moves to Shipped in Baton, and the runs are closed by the reconcile gate.

Every piece of this exists. It is also exactly what Route to Ship does in the live
app despite its homepage: Settings → Order Completion says "Route to Ship never
creates fulfilments" and asks whether the merchant records shipping in Shopify
(`docs/route-to-ship-departments-research.md:286-290`). Maker's Production View
and MakerBatch say the same in their FAQs. Only Kanbanify fulfils from inside the
app, and it does so because its card is the order and it has no item layer to
reconcile; none of the five prints a shipping label or buys postage.

### Should Baton ever write to Shopify?

Not to fulfil. The mechanics, verified against live reference pages: fulfilment is
`fulfillmentCreate` against fulfilment orders, scope
`write_merchant_managed_fulfillment_orders`, and it needs no address, so it is
technically Level-1 compatible. But it duplicates a screen the merchant already
uses for the label, and a fulfilment created without a tracking number is worse
than the one Shopify's screen creates. Kanbanify offers "mark fulfilled from the
card" for merchants who ship without tracking; that is a niche Baton does not need
to serve first.

Two lighter writes are worth knowing about, both under the `write_orders` scope
Baton already holds, both optional, and neither needed for launch:

- **Order tag on Ready to ship** (`tagsAdd`). The state becomes filterable in the
  admin orders list and in saved views, and becomes a condition for Shopify Flow
  without Baton shipping a Flow extension. Cost: a webhook-shaped write per
  transition and a tag the merchant must be told about. Route to Ship does this.
- **Fulfilment hold while in production** (`fulfillmentOrderHold`, reason `OTHER`,
  released by hold id when ready). This is the strongest native "still being
  made" signal: the admin shows On hold and blocks accidental fulfilment. It is also
  a behaviour change to the merchant's fulfilment pipeline, needs a fulfilment-order
  scope, and any other app or Flow can release it. If ever done, opt-in only.

A Baton-emitted **Flow trigger** ("Order ready to ship" with an `order_reference`)
is the general answer to "auto-tag, notify, print when production completes", but
it requires a public distribution to work on non-Plus stores and a lifecycle
callback endpoint. Defer until a merchant asks for automation.

### Recommendation

Manual, in Shopify, with the Ready to ship stage as the pick list. Consider the
Ready to ship tag as the first optional write if merchants say they lose track of
what is packable while they are in the admin and not in Baton.

## Consequences if all three recommendations are taken

- Baton's data story becomes a listing bullet and a privacy-page sentence: orders
  and line items only, Level 1, no customer identity, members see item and
  personalisation text only.
- The Orders page gains a search box for order number. The stage strip already
  answers "what can I ship".
- The Shopify order page gains a link into Baton, closing the customer-lookup loop
  in one click.
- The order workflow, its nav entry, its two routes, and its rules go. The
  workflows page has one kind of workflow again, and "stages with parallel steps"
  is the whole model.
- `src/routes/privacy.tsx` is rewritten to match.

## Questions that were open, and their answers (2026-09-15)

1. **Tracked "pack" step: observed need or assumption?** Assumption. Assume a
   small shop does not need it. Removal stands.
2. **Shops that do not fulfil in Shopify?** Out of scope. "Shipped" means Shopify
   reported the fulfilment, and Baton will not grow a setting for anything else.
3. **Customer name on the merchant order page only, at Level 2?** No.
4. **Ready to ship tag alongside the removal?** No. Every write to Shopify is
   deferred until a merchant asks.

## Note on the local docs mirror

`refs/shopify-docs/` was refetched on 2026-09-15 after `scripts/refs-shopify-docs.ts`
was fixed. The Admin GraphQL `Order`, `Customer`, `orders`, `fulfillmentCreate`,
`fulfillmentOrderHold`, and `FulfillmentOrder` pages are now present, so the
live-page checks in Part 3 can be re-grounded locally.

**What is still missing, for whoever fixes the script next:** the
`docs/api/admin-extensions` section is not fetched at all. The script's `api`
section table (`scripts/refs-shopify-docs.ts`, the `SOURCES.api` array, around
lines 69-99) lists `usage`, `app-home`, `polaris`, `shopify-cli`, `partner`, and
`webhooks`, and nothing else. The fix is one more `sitemap-prefix` entry:

```ts
{
  label: "api-admin-extensions",
  kind: "sitemap-prefix",
  prefix: `${ORIGIN}/docs/api/admin-extensions/latest`,
},
```

The sitemap (`https://shopify.dev/sitemap_standard.xml.gz`, gzipped) lists 81
pages under that prefix: `targets` and one page per resource under `targets/`
(`orders`, `draft-orders`, `customers`, `products`, ...), `target-apis/` (action,
block, print-action, standard, intents, picker, resource-picker, should-render),
and the web-components reference. It is the reference for admin action, block,
print, and link extensions, which this doc's admin-link recommendation relies on.

One caveat that will still be true after the fetch: the live `targets/orders`
page documents only the `*.render` and `*.should-render` targets
(`admin.order-details.action.render`, `admin.order-index.selection-action.render`,
`admin.order-fulfilled-card.action.render`, and so on). The `*.action.link`
targets that `admin_link` extensions use are not listed there. The authoritative
source for those names is the CLI's derivation in
`refs/shopify-cli/packages/app/src/cli/services/admin-link/utils.ts`
(`ORDERS#SHOW` → `admin.order-details.action.link`,
`ORDERS#INDEX` → `admin.order-index.action.link`,
`ORDERS#ACTION` → `admin.order-index.selection-action.link`).

Other `docs/api/` sections in the sitemap that the script skips and that this
project might want later, with page counts: `shopify-app-react-router` (29),
`app-home-ui-extension` (59), `admin-rest` (75). Everything else there
(storefront, liquid, hydrogen, checkout, POS, payments, shop minis) is out of
Baton's scope.
