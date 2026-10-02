import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { causeToErrorMessage } from "@/lib/LayerEx";

/**
 * The data model of one shop's Durable Object, as rules. The table is the
 * spec: it says what is true of the data, never which column or index makes
 * it true; the DDL below conforms to it. `about` is a vocabulary noun
 * (`Domain`) or a table name. `holds by` is the implementer's report of who
 * guarantees the rule: `schema` when the database refuses a violating row,
 * `app` when a write path or transaction does, `schema+app` when both are
 * needed. `pinned by` is the title of the test that asserts the rule.
 * `pnpm spec check` parses the table, refuses an unknown word, and
 * refuses a title no test carries.
 *
 * A structural change starts at the row: change the sentence, then the DDL
 * and the write paths, then the pinned test. A failing pinned test says the
 * row and the code disagree, not which is wrong; the fix is to one of them,
 * never to the test. Behavioural rules (what a state permits) are not here;
 * they live on the `Domain` symbol that is the concept, `Domain.RunState`
 * and the action matrices.
 *
 * Vocabulary, so the same fact is always said the same way: cardinality is
 * "exactly one", "at most one", "one or more", "zero or more"; a reference
 * "snapshots" (copied at write, never re-read), "points to" (live; follows a
 * rename) or "references none"; a pointer into D1 "points to a D1 row;
 * dangling reads as null", since no foreign key can cross stores, and its
 * counterpart, a delete that cannot share the object's transaction, "deletes
 * here first, then nulls every object pointer", stated on the D1 side
 * ({@link D1_TABLES}); lifetime
 * is "goes with" (cascades), "survives", "only X deletes"; history is "no
 * history", "latest only", "one row per event"; derivation is "stored, never
 * derived", "derived and stored", "derived, never stored"; consistency is
 * "set together", "cleared together", "implies"; a one-row table has
 * "exactly one row".
 *
 * | about             | rule                                                                                                                                                         | holds by   | pinned by                                                                                                        |
 * | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
 * | order             | an order is Shopify's record, mirrored; each sync overwrites it whole except `countedAt`                                                                     | app        | a sync rewrites every column but countedAt                                                                       |
 * | order             | an order's counted mark is set at most once, by its first run or, for a seed order, by the seed, and survives every sync; only deleting the order removes it | app        | an order is counted once, when its first run is created                                                          |
 * | order             | an order older than retention is deleted, its items and its runs go with it, and it is never stored again                                                    | schema+app | an order older than retention is never stored again                                                              |
 * | item              | an item has exactly one order and goes with it                                                                                                               | schema     | an item has exactly one order and goes with it                                                                   |
 * | item              | an item has at most one run, in every state; a closed run holds its item until a person replaces it                                                          | schema     | the unique index itself refuses a second row for an item, and a closed run still holds its item                  |
 * | workflow          | a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly                                             | schema     | a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly |
 * | workflow          | a workflow has zero or more steps in order; a step has one or more tasks, done in parallel; a task is in exactly one step                                    | app        | (none yet)                                                                                                       |
 * | workflow          | a workflow has at most one draft; the draft holds tasks only                                                                                                 | schema     | a workflow has at most one draft; the draft holds tasks only                                                     |
 * | workflow          | definition tasks change only by Apply, whole, in one transaction; a run starting between two edits sees one definition                                       | app        | (none yet)                                                                                                       |
 * | workflow          | no history: a delete removes the workflow, its tasks and its draft, and nothing else                                                                         | schema+app | deleteWorkflow cascades its draft and tasks                                                                      |
 * | workflow          | `state` is stored, never derived: `on` or `off`                                                                                                              | schema     | a workflow that is on creates runs on every stored open paid order, however old it is                            |
 * | task              | a task's team points to a D1 row; dangling reads as null, which means unassigned; a team delete nulls it on every task, definition, draft and run            | app        | a team delete nulls the team on every task; history keeps the name                                               |
 * | run               | a run snapshots its workflow, order and item and references none of them; it survives a workflow delete and every edit to the three                          | schema+app | a run snapshots its workflow, order and item and references none of them                                         |
 * | run               | a run's tasks go with it; only deleting the run deletes tasks                                                                                                | schema     | a run's tasks go with it; only deleting the run deletes tasks                                                    |
 * | run               | a run's tasks and steps are a snapshot of the definition's at creation                                                                                       | app        | creates one run per matching item with copied tasks and team names                                               |
 * | task              | a run task also snapshots its team's name; history shows the name and never resolves the team                                                                | app        | creates one run per matching item with copied tasks and team names                                               |
 * | run               | `state` is derived from the tasks and stored, recomputed by every task write in the same transaction; `closed` is the exception, written never derived       | app        | (none yet)                                                                                                       |
 * | run               | `closedAt` and `closedReason` are set together, once, and only on a closed run; nothing leaves closed                                                        | schema+app | `closedAt` and `closedReason` are set together, once, and only on a closed run                                   |
 * | run               | only an open run can be blocked; a run that is done or closed carries no block                                                                               | schema+app | only an open run can be blocked; a run that is done or closed carries no block                                   |
 * | run               | who did what is a snapshot (`*ByEmail`, `teamName`); history never resolves through `Member` or `Team`                                                       | app        | (none yet)                                                                                                       |
 * | run               | reopen is latest only; a later Done clears it                                                                                                                | app        | (none yet)                                                                                                       |
 * | `SyncState`       | exactly one row                                                                                                                                              | schema     | `SyncState` and `ShopUsage` have exactly one row each                                                            |
 * | `ShopUsage`       | exactly one row                                                                                                                                              | schema     | `SyncState` and `ShopUsage` have exactly one row each                                                            |
 * | `WebhookDelivery` | one row per Shopify delivery id, kept for a while and swept by age                                                                                           | schema+app | (none yet)                                                                                                       |
 * | `UsageEvent`      | one row per idempotency key, kept until Shopify accepts it                                                                                                   | schema+app | a usage event is one row per idempotency key, kept until Shopify accepts it                                      |
 * | `UsageEvent`      | an expired usage event is kept until 60 days after it was dated, then deleted                                                                                | app        | the retention sweep deletes expired usage events older than 60 days and keeps younger ones                       |
 *
 * The other half of each cross-store row is on {@link D1_TABLES}.
 *
 * Versioned through `SqliteMigrator` rather than a bare `create table if not
 * exists` block, so the next migration has somewhere to go.
 */
export const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    -- Times are epoch-ms integers: the rule on EpochMillis (src/lib/domain/Platform.ts).
    --
    -- ShopOrder, not Order: see the exceptions on the vocabulary in Domain.ts.
    -- Shopify's numeric ids are text: they exceed the 52-bit integers
    -- SqlStorage.exec round-trips losslessly, and a truncated legacy id would
    -- silently mismatch the webhook payload it is meant to correlate with.
    create table if not exists ShopOrder (
      id text primary key,
      legacyId text not null,
      name text not null,
      processedAt integer not null,
      updatedAt integer not null,
      cancelledAt integer,
      fulfillmentStatus text not null,
      fullyPaid integer not null,
      note text,
      lineItemsTruncated integer not null default 0,
      syncedAt integer not null,
      -- Null until Baton first creates a run for the order, and always null
      -- on a seeded one; the billing meter's per-order marker, owned by
      -- OrderRepository.countOrder.
      countedAt integer
    );
    -- The keyset the orders page pages on; id desc is in it so the tiebreak
    -- is index-ordered too, since a shop can place several orders in the same
    -- millisecond. The retention sweep reads the same index as a range scan;
    -- a descending index reads a range as readily as an ascending one, so the
    -- sweep needs no index of its own.
    create index if not exists ShopOrder_processedAt
      on ShopOrder (processedAt desc, id desc);
    create index if not exists ShopOrder_open_idx
      on ShopOrder (processedAt desc, id desc)
      where fulfillmentStatus <> 'FULFILLED' and cancelledAt is null;
    create table if not exists OrderLineItem (
      id text primary key,
      orderId text not null references ShopOrder(id) on delete cascade,
      title text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      currentQuantity integer not null,
      productTags text not null,
      properties text not null
    );
    create index if not exists OrderLineItem_orderId on OrderLineItem (orderId);
    -- Shopify's webhook retry dedupe; protocol on
    -- OrderRepository.recordWebhookDelivery.
    create table if not exists WebhookDelivery (
      webhookId text primary key,
      receivedAt integer not null
    );
    -- So the retention sweep walks the oldest rows instead of the table.
    create index if not exists WebhookDelivery_receivedAt_idx
      on WebhookDelivery (receivedAt);
    -- The last sync's error, if any; owned by OrderRepository.getSyncState.
    -- Seeded here so every read is a select and every write an update.
    create table if not exists SyncState (
      id integer primary key check (id = 1),
      lastError text
    );
    insert or ignore into SyncState (id) values (1);
    -- The plan-free usage counters; described on OrderRepository's
    -- ShopUsageRow, cycle seeding on OrderRepository.setBillingCycle.
    create table if not exists ShopUsage (
      id integer primary key check (id = 1),
      shopGid text,
      cycleStartAt integer,
      cycleEndAt integer,
      ordersThisCycle integer not null default 0,
      ordersLimitedAt integer,
      openRunsLimitedAt integer,
      lastSweepAt integer,
      seatsThisCycle integer not null default 0,
      meterQuantityOrders integer,
      meterQuantityMembers integer
    );
    insert or ignore into ShopUsage (id) values (1);
    -- The App Events outbox; protocol on OrderRepository.flushUsageEvents.
    create table if not exists UsageEvent (
      idempotencyKey text primary key,
      eventHandle text not null,
      orderId text,
      value integer not null,
      occurredAt integer not null,
      attempts integer not null default 0,
      lastError text
    );
    -- Workflow / WorkflowTask are the definitions a merchant configures;
    -- WorkflowDraft / WorkflowDraftTask are the private copy under edit.
    -- Tasks live in two tables rather than one with a flag so a task-id write
    -- can never be ambiguous about its side, and unique (workflowId, position)
    -- holds on each side independently.
    create table if not exists Workflow (
      id text primary key,
      name text not null unique check (name = trim(name) and length(name) > 0),
      tag text not null unique check (tag = trim(tag) and length(tag) > 0),
      -- state is the switch, the vocabulary's word, stored and never derived.
      state text not null check (state in ('on', 'off')),
      updatedAt integer not null
    );
    -- step is the layout, kept dense from 1 by the pure WorkflowLayout
    -- module rather than by SQL. position has no check (position >= 1), unlike
    -- RunTask: unique (workflowId, position) forces every layout edit through
    -- a scratch position, and WorkflowRepository.writeLayout parks each task
    -- at -position before assigning final ones, which an immediate check would
    -- refuse. instructions is merchant text copied onto each run.
    create table if not exists WorkflowTask (
      id text primary key,
      workflowId text not null references Workflow (id) on delete cascade,
      position integer not null,
      step integer not null check (step >= 1),
      name text not null check (name = trim(name) and length(name) > 0),
      -- A D1 Team.id with no foreign key because SQLite foreign keys do not
      -- cross databases. addStep / addTask / updateTask verify the team
      -- before writing, and deleteTeam nulls every pointer after the D1 row
      -- goes (unassignTeam, served by the teamId index), so the cross-store
      -- window between the two writes reads as unassigned.
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowTask_teamId_idx on WorkflowTask (teamId);
    create table if not exists WorkflowDraft (
      workflowId text primary key references Workflow (id) on delete cascade,
      updatedAt integer not null
    );
    -- Same shape and same position caveat as WorkflowTask.
    create table if not exists WorkflowDraftTask (
      id text primary key,
      workflowId text not null references WorkflowDraft (workflowId) on delete cascade,
      position integer not null,
      step integer not null check (step >= 1),
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowDraftTask_teamId_idx on WorkflowDraftTask (teamId);
    -- Run / RunTask are the instances: one workflow applied to one item, with
    -- the definition's tasks copied in. No foreign key to ShopOrder,
    -- OrderLineItem or Workflow. lineItemId is unique over every state, not
    -- partial, so reconcile, manual attach and replace all have to be correct
    -- under it.
    create table if not exists Run (
      id text primary key,
      workflowId text not null,
      workflowName text not null,
      orderId text not null,
      orderName text not null,
      orderProcessedAt integer not null,
      lineItemId text not null unique,
      lineItemTitle text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      lineItemProperties text not null,
      -- Denormalized from the tasks for the workflows list and the
      -- definitions badge (RunRepository's recomputeState).
      state text not null check (state in ('open', 'done', 'closed')),
      -- The one hold a person sets; blockedBy is the JSON
      -- Domain.ActorDisplay (role and email, no id).
      -- blockReason is optional text, so only blockedAt and blockedBy move
      -- as one.
      blockedAt integer,
      blockReason text,
      blockedBy text,
      quantityChangedFrom integer,
      note text,
      createdAt integer not null,
      updatedAt integer not null,
      closedAt integer,
      closedReason text check (closedReason in ('fulfilled', 'order_cancelled', 'item_removed', 'merchant_cancelled')),
      -- Each check is one statement's worth: the close sets state, closedAt
      -- and closedReason and clears the block in a single update, since SQLite
      -- checks every statement, not the transaction.
      check ((state = 'closed') = (closedAt is not null)),
      check ((closedAt is null) = (closedReason is null)),
      check (blockedAt is null or state = 'open'),
      check ((blockedAt is null) = (blockedBy is null))
    );
    create index if not exists Run_orderId_idx on Run (orderId);
    create index if not exists Run_state_idx on Run (state);
    create index if not exists Run_open_age_idx
      on Run (orderProcessedAt, lineItemId, id) where state = 'open';
    create index if not exists Run_closed_idx
      on Run (closedAt) where state = 'closed';
    -- *ByRole is the actor discriminator (Domain.ActorDisplay): a 'member'
    -- role has its email beside it, and a 'merchant' role, who acts from the
    -- order page and has no Member row, has null. No actor has an id column:
    -- who did what is a snapshot, never resolved through Member. reopened*
    -- hold the most recent reopen only; the check keeps reopenedAt and
    -- reopenedByRole one fact.
    create table if not exists RunTask (
      id text primary key,
      runId text not null references Run (id) on delete cascade,
      position integer not null check (position >= 1),
      step integer not null check (step >= 1),
      name text not null,
      -- Nullable for the same reason as WorkflowTask.teamId.
      teamId text,
      teamName text not null,
      instructions text,
      startedAt integer,
      startedByEmail text,
      doneAt integer,
      doneByEmail text,
      startedByRole text check (startedByRole in ('merchant', 'member')),
      doneByRole text check (doneByRole in ('merchant', 'member')),
      reopenedAt integer,
      reopenedByRole text check (reopenedByRole in ('merchant', 'member')),
      reopenedByEmail text,
      unique (runId, position),
      check ((reopenedAt is null) = (reopenedByRole is null))
    );
    -- Serves the member's workflows list, which asks for open tasks by team.
    create index if not exists RunTask_teamId_idx
      on RunTask (teamId, doneAt);
  `;
});

export const runShopAgentMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "1_initialize schema": initializeSchema,
  }),
}).pipe(
  Effect.tapCause((cause) =>
    Effect.logError(
      `ShopAgent migrations failed: ${causeToErrorMessage(cause)}`,
    ),
  ),
  Effect.asVoid,
);
