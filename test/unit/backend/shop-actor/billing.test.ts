import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import { MembershipRepository } from "../../../../src/backend/membership-repository.ts";
import { makeBilling } from "../../../../src/backend/shop-actor/billing.ts";
import { makeOrderFactStore } from "../../../../src/backend/shop-actor/order-facts.ts";
import { makeOrderRepository } from "../../../../src/backend/shop-actor/order-repository.ts";
import { makeOrders } from "../../../../src/backend/shop-actor/orders.ts";
import { makeRunRepository } from "../../../../src/backend/shop-actor/run-repository.ts";
import { makeRuns } from "../../../../src/backend/shop-actor/runs.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import { makeUsageRepository } from "../../../../src/backend/shop-actor/usage-repository.ts";
import { makeWorkflowRepository } from "../../../../src/backend/shop-actor/workflow-repository.ts";
import { makeWorkflows } from "../../../../src/backend/shop-actor/workflows.ts";
import { ReauthorizationRequired } from "../../../../src/backend/shopify.ts";
import { ShopifyAdmin } from "../../../../src/backend/shopify-admin.ts";
import { ShopifyAppEvents } from "../../../../src/backend/shopify-app-events.ts";
import { USAGE_METER_ORDER } from "../../../../src/domain/billing.ts";
import { ShopGid, ShopKey } from "../../../../src/domain/platform.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import {
  ActorSqliteTest,
  makeD1Test,
  QuietLogs,
  seedD1,
  testOrdersSyncWorkflows,
  testShopifyAdmin,
} from "../layers.ts";
import { type AtCurrentRevision, atCurrentRevision } from "./current-revision.ts";

/**
 * Every path that creates a run sends the queue after its write commits: the rule on
 * `makeBilling`'s `flushUsageEvents`, which names these tests. The actor's services are wired as
 * the actor wires them: the real meter in the run repository, the billing service's flush as the runs and
 * orders services' `flushUsage`, over a fresh in-memory SQLite and D1, with App Events recorded
 * instead of sent.
 */
const DAY = 86_400_000;
const ORDER_ID = "gid://shopify/Order/1";
const countKey = `${ORDER_ID}#count`;
const shop = Schema.decodeUnknownSync(ShopKey)("flush.myshopify.com");
const shopGid = Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1");

/** Each warning logged. */
const capturing = (logged: Array<string>) =>
  Logger.layer([
    Logger.make(({ message, logLevel }) => {
      if (logLevel !== "Warn") return;
      logged.push(String(Array.isArray(message) ? message[0] : message));
    }),
  ]);

const harness = <A, E>(
  body: (context: {
    readonly sent: Array<{ readonly idempotencyKey: string; readonly value: number }>;
    readonly logged: Array<string>;
    readonly billing: Effect.Success<ReturnType<typeof makeBilling<never>>>;
    readonly runs: Effect.Success<ReturnType<typeof makeRuns<never>>>;
    readonly workflows: AtCurrentRevision<ReturnType<typeof makeWorkflows<never>>>;
    readonly orders: ReturnType<typeof makeOrders<never>>;
    readonly sql: SqlClient.SqlClient;
    readonly teamId: string;
  }) => Effect.Effect<A, E>,
) => {
  const sent: Array<{ readonly idempotencyKey: string; readonly value: number }> = [];
  const logged: Array<string> = [];
  return Effect.gen(function* () {
    const { db, raw } = yield* makeD1Test;
    seedD1(db, { shops: [shop] });
    const membership = yield* MembershipRepository.pipe(
      Effect.provide(MembershipRepository.layerWith(raw)),
    );
    const team = yield* membership
      .createTeam({ shop, name: Schema.decodeUnknownSync(ShopWork.TeamName)("Bench") })
      .pipe(Effect.orDie);
    const sql = yield* SqlClient.SqlClient;
    const transaction = syncTransaction(sql);
    const usageRepository = makeUsageRepository(sql, transaction);
    const orderRepository = makeOrderRepository(sql, transaction);
    const workflowRepository = makeWorkflowRepository(sql, transaction);
    const runRepository = makeRunRepository(sql, transaction, usageRepository.countOrder);
    const billing = yield* makeBilling({
      usageRepository,
      notify: () => Effect.void,
      shop,
      databaseSize: Effect.succeed(0),
    }).pipe(
      Effect.provide(
        Layer.succeed(
          ShopifyAppEvents,
          ShopifyAppEvents.of({
            send: ({ idempotencyKey, value }) =>
              Effect.sync(() => {
                sent.push({ idempotencyKey, value });
              }),
          }),
        ),
      ),
    );
    const flushUsage = Effect.asVoid(billing.flushUsageEvents);
    const runs = yield* makeRuns({
      runRepository,
      orderRepository,
      orderFactStore: makeOrderFactStore(sql, transaction),
      workflowRepository,
      membershipRepository: membership,
      transaction,
      notify: () => Effect.void,
      flushUsage,
      shop,
    });
    const editorWrites = makeWorkflows({
      repository: workflowRepository,
      membershipRepository: membership,
      reconcileAll: runs.reconcileAll,
      notify: () => Effect.void,
      shop,
    });
    const workflows = atCurrentRevision(editorWrites, workflowRepository);
    const orders = makeOrders({
      repository: orderRepository,
      transaction,
      admin: yield* ShopifyAdmin,
      ordersSync: testOrdersSyncWorkflows(),
      notify: () => Effect.void,
      notifyRuns: () => Effect.void,
      teamsOfOrder: runRepository.teamsOfOrder,
      reconciler: runs.reconciler(),
      flushUsage,
      shop,
    });
    return yield* body({ sent, logged, billing, runs, workflows, orders, sql, teamId: team.id });
  }).pipe(
    Effect.provide(
      testShopifyAdmin(
        [
          Effect.fail(
            new ReauthorizationRequired({
              shop,
              reason: "refresh-token-rejected",
              refreshTokenExpiresAt: null,
            }),
          ),
        ],
        [],
      ),
    ),
    Effect.provide(ActorSqliteTest),
    Effect.provide(Layer.merge(QuietLogs, capturing(logged))),
  );
};

/** A billing cycle around now, so the flush has a shop to address and every event is live. */
const openCycle = (billing: Effect.Success<ReturnType<typeof makeBilling<never>>>) =>
  Effect.gen(function* () {
    yield* billing.setBillingCycle({
      shopGid,
      cycleStartAt: Date.now() - 2 * DAY,
      cycleEndAt: Date.now() + 28 * DAY,
      memberCount: 0,
    });
  });

/** One paid order with one item tagged `tag`, written through the orders repository. */
const seedOrder = (sql: SqlClient.SqlClient, processedAt: number, tag: string) =>
  makeOrderRepository(sql, syncTransaction(sql))
    .upsertOrder({
      order: {
        id: ORDER_ID,
        legacyId: "1",
        name: "#1001",
        processedAt,
        updatedAt: processedAt,
        cancelledAt: null,
        fulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
        syncedAt: processedAt,
      },
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          orderId: ORDER_ID,
          title: "Necklace",
          variantTitle: null,
          sku: null,
          quantity: 1,
          currentQuantity: 1,
          productTags: [tag],
          properties: [],
        },
      ],
    })
    .pipe(Effect.orDie);

/** An applied, inactive workflow matching `tag`, with one task on `teamId`. */
const offWorkflow = (
  workflows: AtCurrentRevision<ReturnType<typeof makeWorkflows<never>>>,
  tag: string,
  teamId: string,
) =>
  Effect.gen(function* () {
    const created = yield* workflows.createWorkflow(
      Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput)({ name: "Engrave", tag }),
    );
    if (created._tag !== "Ok") return yield* Effect.die(new Error(created._tag));
    const workflowId = created.workflow.id;
    yield* workflows.addStep(
      Schema.decodeUnknownSync(ShopWork.AddStepInput.mapFields(Struct.omit(["tasksRevision"])))({
        workflowId,
        name: "Engrave",
        teamId,
      }),
    );
    const applied = yield* workflows.applyDraft({ workflowId });
    if (applied._tag !== "Ok") return yield* Effect.die(new Error(applied._tag));
    return workflowId;
  });

const turnOn = (
  workflows: AtCurrentRevision<ReturnType<typeof makeWorkflows<never>>>,
  workflowId: string,
) =>
  workflows.setWorkflowState(
    Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput)({ workflowId, state: "active" }),
  );

/** Queues one order event directly, as a count whose flush failed leaves one. */
const queueEvent = (sql: SqlClient.SqlClient, idempotencyKey: string, occurredAt = Date.now()) =>
  sql`
    insert into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt)
    values (${idempotencyKey}, ${USAGE_METER_ORDER}, ${ORDER_ID}, 1, ${occurredAt})
  `.pipe(Effect.orDie);

describe("Billing usage flush", () => {
  it.live("the flush deletes an event dated before the current cycle and logs it", () =>
    harness(({ billing, sql, sent, logged }) =>
      Effect.gen(function* () {
        yield* openCycle(billing);
        const expiredKey = `${ORDER_ID}#expired`;
        yield* queueEvent(sql, expiredKey, Date.now() - 10 * DAY);
        assert.strictEqual((yield* billing.flushUsageEvents).remaining, 0);
        assert.deepStrictEqual(sent, []);
        const [left] = yield* sql<{ readonly n: number }>`select count(*) as n from UsageEvent`;
        assert.strictEqual(left?.n, 0);
        assert.strictEqual(
          logged.some(
            (line) =>
              line.includes(`idempotencyKey=${expiredKey}`) &&
              line.includes("expired before it was sent"),
          ),
          true,
        );
      }),
    ),
  );

  it.live("a cycle push sends the seat event it queued", () =>
    harness(({ billing, sent }) =>
      Effect.gen(function* () {
        const cycleStartAt = Date.now() - 2 * DAY;
        yield* billing.setBillingCycle({
          shopGid,
          cycleStartAt,
          cycleEndAt: Date.now() + 28 * DAY,
          memberCount: 3,
        });
        assert.deepStrictEqual(sent, [
          { idempotencyKey: `seat#${String(cycleStartAt)}#3`, value: 3 },
        ]);
        const usage = yield* billing.getUsage();
        assert.strictEqual(usage.pendingUsageEvents, 0);
        assert.strictEqual(usage.seatsThisCycle, 3);
      }),
    ),
  );

  it.live("attaching a workflow sends the usage event it queued", () =>
    harness(({ billing, runs, workflows, sql, sent, teamId }) =>
      Effect.gen(function* () {
        yield* openCycle(billing);
        // Tagged for no workflow, so nothing creates its run but the attach.
        yield* seedOrder(sql, Date.now() - DAY, "untagged");
        const workflowId = yield* offWorkflow(workflows, "engrave", teamId);
        yield* turnOn(workflows, workflowId);
        assert.strictEqual(sent.length, 0);

        const attached = yield* runs.merchantAttachWorkflow(
          Schema.decodeUnknownSync(ShopWork.AttachWorkflowInput)({
            lineItemId: "gid://shopify/LineItem/1",
            workflowId,
          }),
        );
        assert.strictEqual(attached._tag, "Ok");
        assert.deepStrictEqual(sent, [{ idempotencyKey: countKey, value: 1 }]);
        assert.strictEqual((yield* billing.getUsage()).pendingUsageEvents, 0);
      }),
    ),
  );

  it.live("turning a workflow on sends the usage events for the orders it counted", () =>
    harness(({ billing, workflows, sql, sent, teamId }) =>
      Effect.gen(function* () {
        yield* openCycle(billing);
        const workflowId = yield* offWorkflow(workflows, "engrave", teamId);
        yield* seedOrder(sql, Date.now(), "engrave");

        const on = yield* turnOn(workflows, workflowId);
        assert.strictEqual(on._tag, "Ok");
        assert.deepStrictEqual(sent, [{ idempotencyKey: countKey, value: 1 }]);
        assert.strictEqual((yield* billing.getUsage()).pendingUsageEvents, 0);
      }),
    ),
  );

  it.live("a reconcile all sends the usage queue even when it fails", () =>
    harness(({ billing, workflows, sql, sent, teamId }) =>
      Effect.gen(function* () {
        yield* openCycle(billing);
        const workflowId = yield* offWorkflow(workflows, "engrave", teamId);
        yield* seedOrder(sql, Date.now(), "engrave");
        yield* queueEvent(sql, countKey);
        // A stored order the pass cannot decode: its reconcile fails, and so
        // does the reconcile all that walks it.
        yield* sql`update ShopOrder set processedAt = 'not a time' where id = ${ORDER_ID}`.pipe(
          Effect.orDie,
        );

        const turnedOn = yield* Effect.exit(turnOn(workflows, workflowId));
        assert.strictEqual(Exit.isFailure(turnedOn), true);
        assert.deepStrictEqual(sent, [{ idempotencyKey: countKey, value: 1 }]);
        assert.strictEqual((yield* billing.getUsage()).pendingUsageEvents, 0);
      }),
    ),
  );

  it.live("syncing one order sends the usage queue, even when the sync fails", () =>
    harness(({ billing, orders, sql, sent }) =>
      Effect.gen(function* () {
        yield* openCycle(billing);
        // An event already queued, as a count whose flush failed leaves one.
        yield* queueEvent(sql, countKey);

        // The shop must reauthorize, so the fetch fails; the queue is
        // still sent.
        const synced = yield* Effect.exit(orders.syncOrder({ orderId: ORDER_ID }));
        assert.strictEqual(Exit.isFailure(synced), true);
        assert.deepStrictEqual(sent, [{ idempotencyKey: countKey, value: 1 }]);
        assert.strictEqual((yield* billing.getUsage()).pendingUsageEvents, 0);
      }),
    ),
  );
});
