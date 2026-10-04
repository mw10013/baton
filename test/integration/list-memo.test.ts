import type { ShopAgent } from "@/lib/ShopAgent";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Ref, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, it } from "vitest";

import { BillingAgent } from "@/lib/agent/Billing";
import { ShopAgentHost } from "@/lib/agent/Host";
import { ShopWorkAgent } from "@/lib/agent/ShopWork";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { RunRepository, RunRepositoryError } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

import { reconcileContext } from "./reconcile-context.ts";
import { countingStorage, type Executed } from "./rows-read.ts";

/**
 * The list memo: the rule is on `ShopAgent.publish`. Shop work is built over
 * a counting storage so a test can see which statements a read executed; the
 * host's `publish` is a stub, and a test that needs a publish runs
 * `clearListMemo`, which is what the class's `publish` runs first.
 */

const teamId = Schema.decodeUnknownSync(Domain.TeamId);
const teamName = Schema.decodeUnknownSync(Domain.TeamName);
const email = Schema.decodeUnknownSync(Domain.Email);

const TEAMS = [
  { id: teamId("team-a"), name: teamName("Team A") },
  { id: teamId("team-b"), name: teamName("Team B") },
];
const TEAM_IDS = TEAMS.map(({ id }) => id);
const ORDERS_INPUT = {
  limit: 25,
  cursor: null,
  q: null,
  show: null,
  team: null,
} satisfies Domain.ListOrdersInput;
const READY_QUERY = {
  team: null,
  state: "ready",
  limit: Domain.RUN_PAGE,
  q: null,
} satisfies Domain.RunQuery;

const d1 = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

/** The orders index's counts statement: one per `listOrders` computation. */
const ordersComputations = (captured: readonly Executed[]) =>
  captured.filter(({ query }) => query.includes("run_summary")).length;
/** `runListItems`' first statement: one per workflows list computation. */
const runsComputations = (captured: readonly Executed[]) =>
  captured.filter(({ query }) => query.includes("cross join RunTask m")).length;

type Services =
  | ShopWorkAgent
  | OrderRepository
  | WorkflowRepository
  | RunRepository
  | Repository;

/**
 * Shop work over a fresh object's counting storage. `runRepository` replaces
 * the run repository when a test needs one that misbehaves.
 */
const runInShopWork = <A, E>(
  program: (captured: readonly Executed[]) => Effect.Effect<A, E, Services>,
  runRepository: (
    real: RunRepository["Service"],
  ) => Effect.Effect<RunRepository["Service"]> = Effect.succeed,
): Promise<A> =>
  runInDurableObject(
    env.TEST_SQL_DO.get(env.TEST_SQL_DO.idFromName(crypto.randomUUID())),
    (_instance, state) => {
      const { storage, captured } = countingStorage(state.storage);
      const sqlite = SqliteClient.layer({ storage });
      const repositories = Layer.mergeAll(
        WorkflowRepository.layer,
        Layer.effect(
          RunRepository,
          RunRepository.pipe(Effect.flatMap(runRepository)),
        ).pipe(Layer.provide(RunRepository.layer)),
      ).pipe(
        Layer.provideMerge(OrderRepository.layer),
        Layer.provideMerge(sqlite),
      );
      const host = Layer.succeed(ShopAgentHost, {
        shop: () => `memo-${crypto.randomUUID()}.myshopify.com`,
        publish: () => Effect.void,
        setSubscription: () => Effect.void,
        closeMemberConnections: () => Effect.void,
        databaseSize: Effect.succeed(0),
        syncInFlight: () => Effect.succeed(false),
      });
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations.pipe(Effect.provide(sqlite));
          return yield* program(captured);
        }).pipe(
          Effect.provide(
            ShopWorkAgent.layer.pipe(
              Layer.provideMerge(BillingAgent.layer),
              Layer.provideMerge(
                Layer.mergeAll(
                  host,
                  d1,
                  makeEnvLayer(env),
                  Layer.provide(
                    ShopifyAppEvents.layerNoDeps,
                    FetchHttpClient.layer,
                  ),
                  repositories,
                ),
              ),
            ),
          ),
        ),
      );
    },
  );

/**
 * One workflow on both teams and one order with an item tagged for it, so
 * the workflows list has a Ready row for either team; `startedBy` starts
 * its first task.
 */
const seedRun = (startedBy?: Domain.Email) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const orders = yield* OrderRepository;
    const runs = yield* RunRepository;
    yield* workflows.replaceWorkflows(
      Schema.decodeUnknownSync(Domain.SeedWorkflowsInput)({
        workflows: [
          {
            name: "Engraving",
            tag: "engraved",
            on: true,
            tasks: [
              { name: "Cut", teamId: "team-a", step: 1 },
              { name: "Polish", teamId: "team-b", step: 1 },
            ],
          },
        ],
      }),
    );
    const context = yield* reconcileContext(TEAMS);
    const orderId = "gid://shopify/Order/1";
    yield* orders.upsertOrder({
      order: {
        id: orderId,
        legacyId: "1",
        name: "#1001",
        processedAt: 1000,
        updatedAt: 1000,
        cancelledAt: null,
        fulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
        syncedAt: 1000,
      },
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          orderId,
          title: "Necklace",
          variantTitle: null,
          sku: null,
          quantity: 1,
          currentQuantity: 1,
          productTags: ["engraved"],
          properties: [],
        },
      ],
      afterWrite: runs.reconcileOrder({ ...context, orderId }),
    });
    const [detail] = yield* runs.listRunsForOrder({ orderId });
    const task = detail?.tasks[0];
    if (startedBy !== undefined && task !== undefined)
      yield* runs.startTask({
        runTaskId: task.id,
        actor: {
          role: "member",
          memberId: Schema.decodeUnknownSync(Domain.MemberId)("member-1"),
          email: startedBy,
        },
      });
  });

describe("the list memo", () => {
  it("a second read of the same key executes no list SQL", async () => {
    const { orders, runs } = await runInShopWork((captured) =>
      Effect.gen(function* () {
        yield* seedRun();
        const shopWork = yield* ShopWorkAgent;
        const read = () =>
          Effect.all([
            shopWork.listOrders(ORDERS_INPUT),
            shopWork.listRuns({
              teamIds: TEAM_IDS,
              memberEmail: email("viewer@example.com"),
              query: READY_QUERY,
            }),
          ]);
        yield* read();
        const from = captured.length;
        const [orders, runs] = yield* read();
        const since = captured.slice(from);
        strictEqual(orders.page.orders.length, 1);
        strictEqual(runs.items.length, 1);
        return {
          orders: ordersComputations(since),
          runs: runsComputations(since),
        };
      }),
    );
    strictEqual(orders, 0);
    strictEqual(runs, 0);
  });

  it("a publish between two reads makes the second one recompute", async () => {
    const { orders, runs } = await runInShopWork((captured) =>
      Effect.gen(function* () {
        const shopWork = yield* ShopWorkAgent;
        const read = () =>
          Effect.all([
            shopWork.listOrders(ORDERS_INPUT),
            shopWork.listRuns({
              teamIds: TEAM_IDS,
              memberEmail: email("viewer@example.com"),
              query: READY_QUERY,
            }),
          ]);
        const [emptyOrders, emptyRuns] = yield* read();
        strictEqual(emptyOrders.page.orders.length, 0);
        strictEqual(emptyRuns.items.length, 0);
        // A write the memo does not see until the publish that follows it.
        yield* seedRun();
        const [staleOrders] = yield* read();
        strictEqual(staleOrders.page.orders.length, 0);
        yield* shopWork.clearListMemo;
        const from = captured.length;
        const [freshOrders, freshRuns] = yield* read();
        strictEqual(freshOrders.page.orders.length, 1);
        strictEqual(freshRuns.items.length, 1);
        const since = captured.slice(from);
        return {
          orders: ordersComputations(since),
          runs: runsComputations(since),
        };
      }),
    );
    strictEqual(orders, 1);
    strictEqual(runs, 1);
  });

  it("the class's publish clears the memo before its frames", async () => {
    const shop = `memo-publish-${crypto.randomUUID()}.myshopify.com`;
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const stub = env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop));
    const count = async () => {
      const { page } = await agent.listOrders(ORDERS_INPUT);
      return page.orders.length;
    };
    strictEqual(await count(), 0);
    // Stored without a publish: the memo still answers the empty page.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `insert into ShopOrder (id, legacyId, name, processedAt, updatedAt,
          cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
         values ('gid://shopify/Order/1', '1', '#1001', 1000, 1000, null,
          'UNFULFILLED', 1, null, 1000)`,
      );
    });
    strictEqual(await count(), 0);
    // `publish` is private: the class's own fan-out, reached here as the
    // writes reach it.
    await runInDurableObject(stub, (instance: ShopAgent) =>
      Effect.runPromise(
        (
          instance as unknown as {
            readonly publish: (touched: "all") => Effect.Effect<void>;
          }
        ).publish("all"),
      ),
    );
    strictEqual(await count(), 1);
  });

  it("members on the same teams share one computation", async () => {
    const { computations, mine, theirs } = await runInShopWork((captured) =>
      Effect.gen(function* () {
        const me = email("me@example.com");
        yield* seedRun(me);
        const shopWork = yield* ShopWorkAgent;
        const from = captured.length;
        const read = (memberEmail: Domain.Email, teamIds: typeof TEAM_IDS) =>
          shopWork.listRuns({
            teamIds,
            memberEmail,
            query: { ...READY_QUERY, state: "started_by_you" },
          });
        const mine = yield* read(me, TEAM_IDS);
        // The same teams in another order are the same key.
        const theirs = yield* read(
          email("them@example.com"),
          TEAM_IDS.toReversed(),
        );
        return {
          computations: runsComputations(captured.slice(from)),
          mine: mine.counts.started_by_you,
          theirs: theirs.counts.started_by_you,
        };
      }),
    );
    strictEqual(computations, 1);
    strictEqual(mine, 1);
    strictEqual(theirs, 0);
  });

  it("a failed lookup is not kept", async () => {
    const { first, second } = await runInShopWork(
      () =>
        Effect.gen(function* () {
          yield* seedRun();
          const shopWork = yield* ShopWorkAgent;
          const read = () =>
            shopWork.listRuns({
              teamIds: TEAM_IDS,
              memberEmail: email("viewer@example.com"),
              query: READY_QUERY,
            });
          const first = yield* read().pipe(Effect.flip);
          const second = yield* read();
          return { first: first.message, second: second.items.length };
        }),
      (real) =>
        Effect.gen(function* () {
          const failed = yield* Ref.make(false);
          return {
            ...real,
            runListItems: (teamIds) =>
              Ref.getAndSet(failed, true).pipe(
                Effect.flatMap((already) =>
                  already
                    ? real.runListItems(teamIds)
                    : Effect.fail(
                        new RunRepositoryError({
                          message: "once",
                          cause: new Error("once"),
                        }),
                      ),
                ),
              ),
          };
        }),
    );
    strictEqual(first, "once");
    strictEqual(second, 1);
  });
});
