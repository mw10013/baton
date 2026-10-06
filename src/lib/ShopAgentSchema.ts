import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { causeToErrorMessage } from "@/lib/LayerEx";

/**
 * The data model of one shop's Durable Object, as rules. The table is the
 * spec: it says what is true of the data, never which index makes it true;
 * the DDL below conforms to it. `about` is a vocabulary noun (`Domain`) or a
 * table name: a definition task's rule is about `workflow`, a draft's about
 * `draft`, the layout's about `step`, and `task` is a run task. `holds by`
 * is the implementer's report of who guarantees the rule: `schema` when the
 * database refuses a violating row, `app` when a write path or transaction
 * does, `schema+app` when both are needed. `pinned by` is the title of the
 * test that asserts the rule, or several titles joined with `; `.
 * `pnpm spec check` parses the table, refuses an unknown word, and refuses a
 * title no test carries.
 *
 * A structural change starts at the row: change the sentence, then the DDL
 * and the write paths, then the pinned test. A failing pinned test says the
 * row and the code disagree, not which is wrong; the fix is to one of them,
 * never to the test. Behavioural rules (what a state permits) are not here;
 * they live on the `Domain` symbol that is the concept, `Domain.RunState`
 * and the action matrices.
 *
 * Which test pins which `holds by`: a `schema` row is pinned by a test that
 * writes a violating row straight to the store and expects the refusal; an
 * `app` row by a test through the write path; a `schema+app` row by one test
 * with both halves, or by two titles joined with `; `. A test that goes
 * through the write path alone passes with the constraint dropped, so it
 * does not pin a `schema` row. "(none yet)" is a row with no test, and
 * `pnpm spec check` refuses it in this table and in {@link D1_TABLES}.
 *
 * Three product choices the rows are read against. A run is for an item on
 * an order, never for stock, and for the whole item: five chairs on one line
 * are one run with quantity 5, and the unique item on `Run` is that choice,
 * not an accident of the index. Every history fact is a snapshot on the row
 * it belongs to, and there is no history table: what is replaced or deleted
 * is gone, and "no history" on a workflow, a member and a run means this.
 * Identity lives in D1 and work lives here; work points into D1 by id and D1
 * never points back.
 *
 * Vocabulary, so the same fact is always said the same way: cardinality is
 * "exactly one", "at most one", "one or more", "zero or more"; a reference
 * "snapshots" (copied at write, never re-read), "points to" (live; follows a
 * rename) or "references none"; a pointer into D1 "points to a D1 row;
 * dangling reads as null", since no foreign key can cross stores, and its
 * counterpart, a delete that cannot share the object's transaction, "deletes
 * here first, then nulls every object pointer", stated on the D1 side
 * ({@link D1_TABLES}); lifetime is "goes with" (cascades), "survives", "only
 * X deletes"; history is "no history", "latest only", "one row per event";
 * derivation is "stored, never derived", "derived and stored", "derived,
 * never stored"; a rule names a column when the column is a vocabulary
 * `stored` cell or the subject of a consistency word, and never names an
 * index; consistency is "set together", "cleared together", "implies"; a
 * one-row table has "exactly one row"; a duration names its `ShopLimits`
 * symbol and the window the number must exceed, never the number. A JSON
 * column holds a document its `Schema` decodes on every read and write
 * (`Domain.WorkflowTasks`); a rule the document's shape makes impossible to
 * break (an array has no gaps) is still stated, marked `app`, and pinned by a
 * test through the write path.
 *
 * | about        | rule                                                                                                                                                                                                                                                                                                                                     | holds by   | pinned by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
 * | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | order        | an order is Shopify's record, mirrored; which orders are stored is the rule on `syncOrder`; each sync overwrites the order whole except `countedAt`                                                                                                                                                                                      | app        | a sync rewrites every column but countedAt                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
 * | order        | an order's counted mark is set at most once, when its first run is created, and survives every sync; only deleting the order removes it                                                                                                                                                                                                  | app        | an order is counted once, when its first run is created                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
 * | order        | an order whose `processedAt` is past `orderRetentionDays` is deleted, open runs included; its items and its runs go with it, and it is never stored again                                                                                                                                                                                | schema+app | an order older than retention is never stored again; the retention sweep deletes an order with its open runs and records no close                                                                                                                                                                                                                                                                                                                                                                              |
 * | item         | an item has exactly one order and goes with it                                                                                                                                                                                                                                                                                           | schema     | an item has exactly one order and goes with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
 * | item         | a sync replaces the order's items whole; an item Shopify no longer lists is deleted, and reconcile closes its open run as `item_removed`                                                                                                                                                                                                 | app        | replaces the line-item set on every accepted write; a line removed from the order closes its open run as item_removed                                                                                                                                                                                                                                                                                                                                                                                          |
 * | item         | an item's product tags snapshot the product at sync; the next sync overwrites them; a run created from them is not revisited                                                                                                                                                                                                             | app        | a product retagged in Shopify changes nothing until its order syncs again; an item's product tags are rewritten by the next sync and a run created from the old tags is not revisited                                                                                                                                                                                                                                                                                                                          |
 * | item         | an item has at most one run, in every state, and a run is for the whole item, never per unit; a person replaces a run in any state                                                                                                                                                                                                       | schema+app | the unique index itself refuses a second row for an item, and a closed run still holds its item; setRun over an open run deletes it in the same transaction and reports it as replaced; a closed run holds its item and a manual attach replaces it; setRun over a done run replaces it and reports it as replaced                                                                                                                                                                                             |
 * | workflow     | a workflow is identified by its tag and by its name; no two workflows share either; both are compared exactly, as Shopify stores a tag                                                                                                                                                                                                   | schema+app | a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly                                                                                                                                                                                                                                                                                                                                                                                               |
 * | step         | a workflow has zero or more steps, numbered from 1 with no gap; a step has one or more tasks, done in parallel; a task is in exactly one step; position is the task's place in its list, never stored; the draft obeys the same rule at every write                                                                                      | app        | step is dense from 1 and non-decreasing along position, a step of one task being the linear case; layoutIsValid rejects gaps, decreases, duplicate positions, duplicate ids and a list out of position order; add/move/remove keep positions dense and unique; edges are no-ops; a stored list that violates the step rule is refused on decode                                                                                                                                                                                                            |
 * | draft        | a workflow has at most one draft, the same shape as its tasks; Apply replaces the workflow's tasks with the draft's, whole, in one statement, and removes the draft; a run starting between two edits sees one definition; Apply refuses a draft with no tasks or an unassigned task, and the workflow keeps its tasks                   | app        | a draft is the draftTasks column: null until the first edit, a copy of the tasks at the first edit, null again after Apply and after Discard; apply replaces the workflow's tasks with the draft's, carries task ids over, and deletes the draft; an edit after turn-on still starts the workflow's tasks; apply while active replaces them and earlier runs keep their copies; apply refuses an empty draft and an unassigned task, active and inactive alike; an empty team does not refuse; the workflow keeps its tasks |
 * | workflow     | no history: a delete removes the workflow, its tasks and its draft, and nothing else                                                                                                                                                                                                                                                     | app        | deleteWorkflow removes the workflow with its tasks and its draft                                                                                                                                                                                                                                                                                                                                                                                                                                               |
 * | workflow     | turning a workflow off deletes nothing and closes nothing; its open runs carry on                                                                                                                                                                                                                                                        | app        | turning a workflow off leaves its open runs open and deletes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                           |
 * | workflow     | a definition task's team points to a D1 row; dangling reads as null, which means unassigned; a team delete nulls it on every definition task, draft task and run task                                                                                                                                                                    | app        | a team delete nulls the team on every task; history keeps the name                                                                                                                                                                                                                                                                                                                                                                                                                                             |
 * | run          | a run snapshots its workflow's id and name, its order's id, name and processed date, and its item's id, title, variant, SKU and properties; it references none of them and survives a workflow delete                                                                                                                                    | schema+app | a run snapshots its workflow, order and item and references none of them                                                                                                                                                                                                                                                                                                                                                                                                                                       |
 * | run          | an open run's quantity follows its item's units to make on every reconcile; a done or closed run's quantity is frozen                                                                                                                                                                                                                    | app        | an open run's quantity follows its item, and a done or closed run's quantity is frozen                                                                                                                                                                                                                                                                                                                                                                                                                         |
 * | run          | a run is deleted by its order's retention and by a person replacing it, and by nothing else; a replaced run leaves no history                                                                                                                                                                                                            | app        | a run is deleted only by its order's retention or by a person replacing it, and a replaced run leaves no history                                                                                                                                                                                                                                                                                                                                                                                               |
 * | run          | a run's tasks go with it; only deleting the run deletes tasks                                                                                                                                                                                                                                                                            | schema     | a run's tasks go with it; only deleting the run deletes tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
 * | run          | a run's tasks and steps are a snapshot of the definition's at creation                                                                                                                                                                                                                                                                   | app        | creates one run per matching item with copied tasks and team names                                                                                                                                                                                                                                                                                                                                                                                                                                             |
 * | task         | a run task snapshots its team's name when its team is set, at creation or by assign a team; a rename never reaches it; history shows the name and never resolves the team                                                                                                                                                                | app        | creates one run per matching item with copied tasks and team names                                                                                                                                                                                                                                                                                                                                                                                                                                             |
 * | run          | `state` is derived from the tasks and stored, recomputed by every task write in the same transaction; `closed` is the exception, written never derived                                                                                                                                                                                   | app        | a run's state is recomputed by every task write in the same transaction, and closed is written, never derived                                                                                                                                                                                                                                                                                                                                                                                                  |
 * | run          | `closedAt` and `closedReason` are set together, once, and only on a closed run; nothing leaves closed                                                                                                                                                                                                                                    | schema+app | `closedAt` and `closedReason` are set together, once, and only on a closed run                                                                                                                                                                                                                                                                                                                                                                                                                                 |
 * | run          | only an open run can be blocked; a run that is done or closed carries no block                                                                                                                                                                                                                                                           | schema+app | only an open run can be blocked; a run that is done or closed carries no block                                                                                                                                                                                                                                                                                                                                                                                                                                 |
 * | task         | `startedAt` and `startedByRole` are set together and cleared together, by Put back and by Reopen; `doneAt` and `doneByRole` are set together and cleared together by Reopen; a `member` role has its email beside it and a `merchant` role has null; done implies started, since a Done without a Start records its actor as the starter | schema+app | a run task's started and done times move with their roles, a member's email beside the role, and done implies started                                                                                                                                                                                                                                                                                                                                                                                          |
 * | `SyncState`  | exactly one row                                                                                                                                                                                                                                                                                                                          | schema     | `SyncState` and `ShopUsage` have exactly one row each                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
 * | `ShopUsage`  | exactly one row                                                                                                                                                                                                                                                                                                                          | schema     | `SyncState` and `ShopUsage` have exactly one row each                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
 * | `ShopUsage`  | `ordersThisCycle` is derived from the counted orders in the cycle and stored; it is recounted when the cycle moves                                                                                                                                                                                                                       | app        | rolls the cycle forward on the first order past its end                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
 * | `ShopUsage`  | `seatsThisCycle` is stored, never derived: the cycle's highest member count, raised by the revalidation alone; a new cycle resets it to the member count                                                                                                                                                                                 | app        | a new cycle resets the mark to the member count and queues it as the cycle's first seat event                                                                                                                                                                                                                                                                                                                                                                                                                  |
 * | `ShopUsage`  | a provisional cycle has a start and no end; a billing cycle has both, set together                                                                                                                                                                                                                                                       | app        | opens a provisional cycle before a billing cycle is known                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
 * | `UsageEvent` | one row per idempotency key, kept until Shopify accepts it or its cycle ends, whichever is first; a refused event is retried on every flush until then                                                                                                                                                                                   | schema+app | a usage event is one row per idempotency key, kept until Shopify accepts it                                                                                                                                                                                                                                                                                                                                                                                                                                    |
 *
 * The other half of each cross-store row is on {@link D1_TABLES}.
 *
 * The object never runs `analyze`, so the planner works without
 * `sqlite_stat1`, and the query plans the tests pin are the no-statistics
 * plans. Statistics would change them: with `analyze` run, `ITEM_MATCHES` on
 * `OrderRepository` reverses its join and scans every workflow per item
 * instead of probing `Workflow.tag` with the item's tags. A plan test that
 * fails after a schema change says the planner chose differently, not that
 * statistics are needed.
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
      syncedAt integer not null,
      -- Null until Baton first creates a run for the order; the billing
      -- meter's per-order marker, owned by OrderRepository.countOrder.
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
      lastSweepAt integer,
      seatsThisCycle integer not null default 0
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
    -- Workflow is the definition a merchant configures. Its tasks are a
    -- document, not rows: the JSON array of Domain.WorkflowTasks, decoded on
    -- every read and write. A task list is read whole by every reader (the
    -- editor, the workflow page, run creation), written whole by every
    -- editor write (WorkflowLayout recomputes the whole layout), and at most
    -- WorkflowLimits.maxTasks long, so a row per task bought nothing but a
    -- scratch-position dance on every reorder. position is the element's
    -- index, never stored. The draft is a second value of the same type that
    -- exists or not, so it is a nullable column beside the first, not a row
    -- of its own: draftTasks is null until the first edit and null again
    -- after Apply or Discard. A task's teamId is a D1 Team.id with no foreign
    -- key, since SQLite foreign keys do not cross databases: addStep /
    -- addTask / updateTask verify the team before writing, and deleteTeam
    -- nulls every pointer after the D1 row goes (unassignTeam), so the
    -- cross-store window between the two writes reads as unassigned.
    create table if not exists Workflow (
      id text primary key,
      name text not null unique check (name = trim(name) and length(name) > 0),
      tag text not null unique check (tag = trim(tag) and length(tag) > 0),
      -- state is the switch, the vocabulary's word, stored and never derived.
      state text not null check (state in ('active', 'inactive')),
      updatedAt integer not null,
      tasks text not null default '[]',
      draftTasks text
    );
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
    -- Every per-order run predicate on the orders index (open run, done run,
    -- blocked run, unassigned run, the team filter) has two equality terms,
    -- orderId and state. With no sqlite_stat1 a single-column index on each
    -- looks equally good, and the planner took the one on state: every open
    -- run read per open order, quadratic in open orders. The composite serves
    -- both terms and every orderId-only probe as its prefix.
    create index if not exists Run_orderId_state_idx on Run (orderId, state);
    create index if not exists Run_open_age_idx
      on Run (orderProcessedAt, lineItemId, id) where state = 'open';
    create index if not exists Run_closed_idx
      on Run (closedAt) where state = 'closed';
    -- *ByRole is the actor discriminator (Domain.ActorDisplay): a 'member'
    -- role has its email beside it, and a 'merchant' role, who acts from the
    -- order page and has no Member row, has null. No actor has an id column:
    -- who did what is a snapshot, never resolved through Member. The checks
    -- are the consistency-pairs rows of the table on initializeSchema: each
    -- time and its role are one fact, each role's email follows the role, and
    -- a done task has a start.
    -- "is 'member'" rather than "= 'member'", so a null role compares false
    -- and an email without a role is refused too.
    create table if not exists RunTask (
      id text primary key,
      runId text not null references Run (id) on delete cascade,
      position integer not null check (position >= 1),
      step integer not null check (step >= 1),
      name text not null,
      -- A D1 Team.id with no foreign key, since SQLite foreign keys do not
      -- cross databases; deleteTeam nulls it after the D1 row goes.
      teamId text,
      teamName text not null,
      instructions text,
      startedAt integer,
      startedByEmail text,
      doneAt integer,
      doneByEmail text,
      startedByRole text check (startedByRole in ('merchant', 'member')),
      doneByRole text check (doneByRole in ('merchant', 'member')),
      unique (runId, position),
      check ((startedAt is null) = (startedByRole is null)),
      check ((doneAt is null) = (doneByRole is null)),
      check ((startedByRole is 'member') = (startedByEmail is not null)),
      check ((doneByRole is 'member') = (doneByEmail is not null)),
      check (doneAt is null or startedAt is not null)
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
