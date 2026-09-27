# Column audit: every column, the reader that needs it, or delete it

## What was asked

Follow-up 2 of `docs/data-model-spec-research.md`: now that the two
data-model tables say what each table is for, ask of every column whether a
row needs it. The test is the one that document set: for each column, name
the reader that needs it, or delete it. The audit is cheap now because the
schema is a single migration on both stores and local state is reset freely
(no migrations while prototyping).

## Method

For every column in `initializeSchema` (`src/lib/ShopAgentSchema.ts`) and
`migrations/0001_init.sql`, grep for the identifier across `src/`, then read
each hit and sort it into one of four kinds of reader:

- **screen**: a route or component renders it;
- **rule**: a `Domain` predicate, a `where` clause, an `order by`, or a
  derivation reads it;
- **plumbing**: a write path reads it back to decide what to write (the
  `updatedAt` version guard, the billing marker, a sweep timestamp);
- **none**: it is written on insert or upsert and nothing ever selects it
  for a purpose. The sync query fetches it from Shopify, the upsert stores
  it, `select *` carries it into a decoded struct, and no line of code then
  looks at the field.

Counts of test files were also taken, so the cost of a delete is known: a
column with no reader still appears in every fixture that builds a row.

Better-auth's five tables are left out. Their shape is better-auth's and
pinned by the drift test; a column there is not Baton's to audit.

## Findings

### Columns with no reader (recommend delete)

| table           | column             | who writes it                           | test files carrying it | note                                                                                                                                                                                              |
| --------------- | ------------------ | --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OrderLineItem   | `productId`        | sync upsert                             | 7                      | Fetched as `product { id }`. Never selected. Nothing links to the product.                                                                                                                        |
| OrderLineItem   | `variantId`        | sync upsert                             | 7                      | Fetched as `variant { id }`. Never selected.                                                                                                                                                      |
| OrderLineItem   | `requiresShipping` | sync upsert                             | 8                      | Fetched, stored, never read. No rule says a digital item skips the workflow; if one ever does, it starts at a spec row.                                                                           |
| ShopOrder       | `syncSource`       | sync upsert (`"manual"`, webhook, bulk) | 9                      | Written, never read. Not on any screen, not in a rule. Its only job was debugging the sync; the logs carry `source` already.                                                                      |
| Run             | `source`           | `setRun` (`"tag"` or `"manual"`)        | 13                     | `RunSource` is a `Domain` literal with a JSDoc, but nothing reads the column: no badge, no gate, no rule in the action matrices. The spec table has no row that mentions how a run came to exist. |
| Run             | `updatedAt`        | every task and run write                | 11 (shared name)       | Bumped on every write, read nowhere. `createdAt` is read once as an ordering tiebreak; `updatedAt` is not read even there.                                                                        |
| Workflow        | `createdAt`        | insert                                  | 9 (shared name)        | `updatedAt` is shown on three screens; `createdAt` is shown nowhere and orders nothing.                                                                                                           |
| WorkflowDraft   | `createdAt`        | insert                                  | 9 (shared name)        | Same. The editor shows the draft's `updatedAt`.                                                                                                                                                   |
| WebhookDelivery | `topic`            | `recordWebhookDelivery`                 | 3                      | The table is the dedupe record; the only reads are `webhookId` (insert or ignore) and `receivedAt` (sweep). The JSDoc on the sweep already says "a table nothing else reads".                     |
| WebhookDelivery | `orderId`          | `recordWebhookDelivery`                 | (shared name)          | Same.                                                                                                                                                                                             |
| WebhookDelivery | `triggeredAt`      | `recordWebhookDelivery`                 | 2                      | Same. Shopify's trigger time is parsed in `Shopify.ts` for the row and for nothing else.                                                                                                          |
| ShopSession     | `planCycleStartAt` | `updateShopSessionPlan`                 | 5                      | Part of the plan cache; written by revalidation, selected by the two `ShopSession` reads, consumed by nothing. `planBoundaryAt` is the one the home page and the subscribed state read.           |

Twelve columns. Deleting them touches the DDL, the `Domain` struct, the
sync query and its `Schema`, the upsert, and the fixtures; no screen and no
rule changes. That is the signature of a column that was there because the
sync had it.

### Columns read only by a screen, as a displayed fact (ask)

These have a reader, so the audit's rule keeps them. They are listed
because the reader is a single line of display, and you may decide the
fact does not earn a column.

| table         | column                             | the one reader                                                                                                         | recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OrderLineItem | `sku`                              | the order page's item line ("× 3 · SKU ABC") and the member run page                                                   | **Keep.** You asked whether SKU is used: it is, on two screens, and it is copied onto the run for the member. Makers identify a variant by SKU more reliably than by variant title, and it costs one nullable text column. If you drop it, drop `Run.sku` with it and the two lines of display.                                                                                                                                                                                                                                            |
| Run           | `sku`                              | the member run page                                                                                                    | Goes with `OrderLineItem.sku`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ShopOrder     | `closedAt`                         | the order page's "Closed" fact                                                                                         | **Delete.** Shopify's `closedAt` is archive time, not fulfilment; Baton's state model runs on `fulfillmentStatus` and `cancelledAt`, and neither the glossary nor a spec row mentions archived. A merchant sees archive state in Shopify admin, one click away via the order link. Note the name collides with `Run.closedAt`, which is a Baton concept; removing the Shopify one ends that.                                                                                                                                               |
| ShopOrder     | `financialStatus`                  | badge text on the orders index and order page ("Paid", "Partially refunded"), beside a tone driven by `fullyPaid`      | **Delete.** No rule reads it. The badge becomes two states from `fullyPaid`. What is lost is the text of Shopify's eight-value enum, and the audit below says what each value would have told a merchant.                                                                                                                                                                                                                                                                                                                                  |
| ShopOrder     | `note`                             | the order page shows Shopify's order note                                                                              | **Keep.** A maker-facing note from the buyer is production-relevant. Distinct from `Run.note`, which is Baton's.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RunTask       | `startedBy`, `doneBy` (member ids) | `taskStartedBy` and `taskDoneBy` rebuild an `Actor` with `memberId`; every consumer then reads only `role` and `email` | **Delete both, and `memberId` inside `Run.blockedBy` with them.** The spec row says "who did what is a snapshot; history never resolves through `Member`", and `actorIsMember` matches by email for exactly that reason. The `reopened*` slot already has no id and works. After the pass every stored actor is `{role, email}` (`ActorDisplay`), `actorFrom` loses its id argument, `attribution` in `RunRepository` goes, and `Actor` with `memberId` survives only as the live caller identity the gate checks against team membership. |
| UsageEvent    | `lastError`                        | none renders it; the flush writes it and logs the same text                                                            | **Keep.** The JSDoc is explicit that no surface renders it and that it exists so a stuck meter is diagnosable. The admin shop screen could render the outbox; that is a screen to add, not a column to drop. Same for `attempts`, which is read by the flush.                                                                                                                                                                                                                                                                              |

### Columns read only by the admin screens

`ShopUsage.ordersLimitedAt`, `openRunsLimitedAt`, `lastSweepAt`,
`membersHighWater`, `lastReconciledOrders`, `lastReconciledMembers`, and
`ShopSession.scope`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`,
`planHandleExpiresAt` are each rendered on the admin shop page or the admin
shops list, and most are also read by a rule (`lastSweepAt` gates the sweep,
`membersHighWater` seeds the seat meter, the two `*LimitedAt` drive the quota
banners). All keep. `lastReconciledOrders` and `lastReconciledMembers` are
admin-only diagnostics with no rule behind them; they stay because the
divergence check they exist for is described on `ShopUsage` and the admin
screen is its reader.

### Everything else has a rule or a plumbing reader

Named so the audit is complete and a later reader does not redo it:

- `ShopOrder`: `legacyId` addresses the order page and the admin link;
  `processedAt` is the keyset and "Placed"; `updatedAt` is the upsert's
  version guard and the retention cut; `cancelledAt` and
  `fulfillmentStatus` are `isCancelled`, `isFulfilled` and the open index;
  `fullyPaid` is `isBillable`; `lineItemsTruncated` is the banner;
  `syncedAt` attributes the order to a billing cycle in `countOrder`;
  `countedAt` is the billing marker.
- `OrderLineItem`: `title`, `variantTitle`, `quantity`, `properties` are
  displayed; `currentQuantity` is `unitsToMake` and the match predicate;
  `productTags` is the match; `matchedWorkflowIds` derives "ambiguous".
- `Run`: `workflowId` excludes the current workflow from the Change picker;
  `orderProcessedAt` and `lineItemId` are `byAge`; `createdAt` is a
  tiebreak; every snapshot column and the block, quantity, note and closed
  columns are displayed or gated.
- `RunTask`: the role and email columns build the actor labels;
  `teamName` is the history snapshot; `startedAt`, `doneAt`, `reopenedAt`
  are displayed and `doneAt` is the open-task filter.
- `WorkflowTask`, `WorkflowDraftTask`: every column is layout, display or
  the team pointer.
- `SyncState`: both columns are the orders index banner and "Last imported".
- `UsageEvent`: `idempotencyKey`, `eventHandle`, `orderId`, `value`,
  `occurredAt`, `attempts` are all read by the flush, the cycle roll or the
  seed cleanup.
- D1 `Member`, `Team`, `TeamMember`: `createdAt` orders the member list and
  is shown on the members, teams and team pages; the membership
  `createdAt` is "in team since".

## Decisions (2026-09-27)

Annotated in Plannotator; every recommendation accepted, the
`financialStatus` one after the trade-off below was written out.

1. `sku` stays on `OrderLineItem` and `Run`.
2. `ShopOrder.closedAt` is deleted with its "Closed" fact.
3. `ShopOrder.financialStatus` is deleted. The badge runs on `fullyPaid`.
   Refunds are not something Baton responds to, so the refunded text is
   not information the app should show; the trade-off is kept below as the
   record.
4. `Run.source` is deleted; no spec row, no badge.
5. `RunTask.startedBy` and `doneBy` are deleted, and `Run.blockedBy` stops
   storing `memberId`. Every stored actor is `{role, email}`. Nothing half
   done: `actorFrom` drops its id argument, `attribution` in
   `RunRepository` goes, `Actor.memberId` remains only on the live caller.
6. `Run.updatedAt`, `Workflow.createdAt`, `WorkflowDraft.createdAt` are
   deleted. A future screen that wants one adds it then.
7. `WebhookDelivery` is reduced to `webhookId` and `receivedAt`.
8. `ShopSession.planCycleStartAt` is deleted.
9. `UsageEvent.lastError` stays; the admin shop page is the surface that
   should eventually render the outbox.

## The `financialStatus` trade-off (decided: delete)

You asked what is lost if the column goes and the badge runs on
`fullyPaid` alone.

What `fullyPaid` says: whether the order has been paid in full. It is the
only payment fact any rule reads (`canStartRuns`, and the "No workflow" and
"Choosing" order states). It does not go back to false when money is
refunded: Shopify documents it as "whether the order has been paid in
full", and a refund does not create an outstanding balance. The `true`
column below for the two refund values follows from that and should be
confirmed against a dev store during the pass; if it turns out false, the
argument gets stronger, not weaker, because then the boolean already
distinguishes refunded from paid. The JSDoc on `canStartRuns` already
treats the boolean as a creation gate only.

What `financialStatus` says: one of Shopify's eight display values.
Grouped by what the boolean beside it reads:

| `financialStatus`    | `fullyPaid` | what the text adds over the boolean                                                                     |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `PAID`               | true        | nothing                                                                                                 |
| `PARTIALLY_REFUNDED` | true        | some money went back; the items may still be wanted, or one was refunded and its `currentQuantity` is 0 |
| `REFUNDED`           | true        | all money went back; a merchant would not want this made, but no rule stops it today either way         |
| `PENDING`            | false       | manual payment or slow provider; will probably become paid                                              |
| `AUTHORIZED`         | false       | manual capture shop; will become paid when captured                                                     |
| `PARTIALLY_PAID`     | false       | manual partial capture                                                                                  |
| `EXPIRED`, `VOIDED`  | false       | payment failed; will not become paid                                                                    |
| null                 | true        | a $0 or untransacted order; the badge cell is blank today                                               |

So the boolean already carries everything the rules use, and the string
carries two things a merchant might read off the badge: on the true side,
"refunded" versus "paid"; on the false side, "will be paid" versus "will
not be". Neither drives anything in Baton. A merchant looking at either
question has the order open in Shopify admin one click away, where the
same badge is authoritative.

The refund case is the one with a plausible future rule ("a fully refunded
order closes its runs"). If that rule ever comes, it needs
`financialStatus = 'REFUNDED'` or a refund webhook, and it starts at a spec
row; the column comes back with the row. Adding it back is one column in
the query, the struct and the upsert, the same size as removing it now.

Recommendation: delete `financialStatus`. The badge becomes "Paid" or
"Unpaid" from `fullyPaid`, and the null case (a $0 order) shows "Paid",
which is true. The two lines of display change; no rule changes. The
question is only whether you want the refunded text on the orders index
without a rule behind it. Recommendation is no: a badge that says
"Refunded" while the runs keep going is a screen making a promise the
model does not keep.

## Recommendations, summarised

Delete twelve columns outright: `OrderLineItem.productId`, `variantId`,
`requiresShipping`; `ShopOrder.syncSource`; `Run.source`, `Run.updatedAt`;
`Workflow.createdAt`; `WorkflowDraft.createdAt`; `WebhookDelivery.topic`,
`orderId`, `triggeredAt`; `ShopSession.planCycleStartAt`.

Delete three more, accepted above: `ShopOrder.closedAt`,
`RunTask.startedBy`, `RunTask.doneBy`, and `memberId` inside
`Run.blockedBy`. Delete `ShopOrder.financialStatus`, accepted after the trade-off.

Keep `sku`, `note`, `lastError`, and everything with a rule behind it.

The change is one pass: DDL on both stores, the `Domain` structs, the two
sync queries and `OrderSync`'s schemas, the upserts, the fixtures, and
`pnpm graphql-codegen`. No spec row changes, because no deleted column
carries a rule; that is the point. Each delete removes the column from the
Shopify query too, which is a smaller payload per order on every sync.

## Status

Research. Nothing in `src/` depends on this file. It is deleted once the
decisions are recorded and the column pass lands.
