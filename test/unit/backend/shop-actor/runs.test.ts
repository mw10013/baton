import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { fixtureRows } from "../../../../src/backend/fixture.ts";
import { MembershipRepository } from "../../../../src/backend/membership-repository.ts";
import { insertFixtureRows } from "../../../../src/backend/shop-actor.ts";
import {
  makeOrderRepository,
  type OrderFactsScope,
  type OrderRepository,
} from "../../../../src/backend/shop-actor/order-repository.ts";
import { OrderSyncResponse } from "../../../../src/backend/order-sync.ts";
import { makeMembership } from "../../../../src/backend/shop-actor/membership.ts";
import { makeOrders } from "../../../../src/backend/shop-actor/orders.ts";
import { runOrdersStream } from "../../../../src/backend/shop-actor/orders-stream.ts";
import { ShopifyAdmin } from "../../../../src/backend/shopify-admin.ts";
import {
  makeRunRepository,
  type RunRepository,
  RunRepositoryError,
} from "../../../../src/backend/shop-actor/run-repository.ts";
import { makeRuns, type RunMember } from "../../../../src/backend/shop-actor/runs.ts";
import {
  syncTransaction,
  type Transaction,
} from "../../../../src/backend/shop-actor/transaction.ts";
import {
  makeWorkflowRepository,
  type WorkflowRepository,
  WorkflowRepositoryError,
} from "../../../../src/backend/shop-actor/workflow-repository.ts";
import { makeWorkflows } from "../../../../src/backend/shop-actor/workflows.ts";
import { ShopFixtureData } from "../../../../src/contract/fixture.ts";
import { ORDERS_KEY } from "../../../../src/contract/shop-actor.ts";
import type { ShopOrder } from "../../../../src/domain/orders.ts";
import { Email, ShopKey } from "../../../../src/domain/platform.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import {
  ActorSqliteTest,
  makeD1Test,
  QuietLogs,
  seedD1,
  testOrdersSyncWorkflows,
  testShopifyAdmin,
} from "../layers.ts";

/**
 * The runs application service over the actor's real repositories on a fresh in-memory SQLite
 * and the real `MembershipRepository` on a fresh in-memory D1, with a recording `notify` and
 * `flushUsage`: result mapping, the gate before the write, notices on success only, the teams
 * read before any transaction, the billing seam's call sites, the memos (legacy
 * `list-memo.test.ts`) and the fixture's work on its runs (legacy's seed titles). Data is
 * arranged as the fixture arranges it: `fixtureRows`, the actor's insert, then `applyFixture`.
 */
const shop = Schema.decodeUnknownSync(ShopKey)("runs.myshopify.com");
const fixtureData = Schema.decodeUnknownSync(ShopFixtureData);
const email = Schema.decodeUnknownSync(Email);
const listOrdersInput = Schema.decodeUnknownSync(ShopWork.ListOrdersInput);
const runQuery = Schema.decodeUnknownSync(ShopWork.RunQuery);
const decodeMember = Schema.decodeUnknownSync(
  Schema.Struct({
    memberId: ShopWork.MemberId,
    email: Email,
    teamIds: Schema.Array(ShopWork.TeamId),
  }),
);

/** Every stored order, page one. */
const EVERY_ORDER = listOrdersInput({
  limit: 50,
  cursor: null,
  q: null,
  show: "all",
  team: null,
});

/** One event of a harness run, in the order it happened. */
type Event =
  | { readonly kind: "listTeams"; readonly inTransaction: boolean }
  | { readonly kind: "transaction" }
  | { readonly kind: "flush" }
  | { readonly kind: "notify"; readonly invalidated: ReadonlyArray<string> };

/** What a test may wrap: the repositories before `makeRuns` sees them. */
interface Wrap {
  readonly orders?: (real: OrderRepository) => OrderRepository;
  readonly runs?: (real: RunRepository) => RunRepository;
  readonly workflows?: (real: WorkflowRepository) => WorkflowRepository;
}

const harness = <A, E>(
  body: (context: {
    readonly runs: Effect.Success<ReturnType<typeof makeRuns<never>>>;
    readonly events: Array<Event>;
    readonly membership: MembershipRepository["Service"];
    readonly orderRepository: OrderRepository;
    readonly runRepository: RunRepository;
    readonly sql: SqlClient.SqlClient;
    readonly transaction: Transaction;
    /** Puts `data` in the shop as `Fixtures.load` does: D1 replaced, the actor's rows replaced, the work applied. */
    readonly load: (data: unknown) => Effect.Effect<FixtureLoaded>;
    /** Puts `data` beside the shop's rows as `Fixtures.add` does. */
    readonly add: (data: unknown) => Effect.Effect<FixtureLoaded>;
    /** Runs `effect` from inside the raw `notify`, the next time it is called. */
    readonly onNextNotify: (effect: Effect.Effect<void>) => void;
    /** Delivers an `orders/updated` webhook the actor's orders service fetches as `order`. */
    readonly webhook: (order: SyncedOrder) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
  wrap: Wrap = {},
) =>
  Effect.gen(function* () {
    const { db, raw } = yield* makeD1Test;
    seedD1(db, { shops: [shop] });
    const realMembership = yield* MembershipRepository.pipe(
      Effect.provide(MembershipRepository.layerWith(raw)),
    );
    const events: Array<Event> = [];
    let depth = 0;
    const sql = yield* SqlClient.SqlClient;
    const real = syncTransaction(sql);
    const transaction: Transaction = (effect) =>
      Effect.suspend(() => {
        events.push({ kind: "transaction" });
        depth += 1;
        return real(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              depth -= 1;
            }),
          ),
        );
      });
    const membership: MembershipRepository["Service"] = {
      ...realMembership,
      listTeamNames: (key) =>
        Effect.suspend(() => {
          events.push({ kind: "listTeams", inTransaction: depth > 0 });
          return realMembership.listTeamNames(key);
        }),
    };
    const orderRepository = (wrap.orders ?? ((r) => r))(makeOrderRepository(sql, transaction));
    const workflowRepository = (wrap.workflows ?? ((r) => r))(
      makeWorkflowRepository(sql, transaction),
    );
    const runRepository = (wrap.runs ?? ((r) => r))(
      makeRunRepository(sql, transaction, () => Effect.void),
    );
    let next: Effect.Effect<void> | null = null;
    const runs = yield* makeRuns({
      runRepository,
      orderRepository,
      workflowRepository,
      membershipRepository: membership,
      transaction,
      notify: (invalidated) =>
        Effect.gen(function* () {
          events.push({ kind: "notify", invalidated });
          const effect = next;
          next = null;
          if (effect !== null) yield* effect;
        }),
      flushUsage: Effect.sync(() => {
        events.push({ kind: "flush" });
      }),
      shop,
    });
    const adminReplies: Array<Effect.Effect<unknown>> = [];
    const orders = makeOrders({
      repository: orderRepository,
      transaction,
      admin: yield* ShopifyAdmin.pipe(Effect.provide(testShopifyAdmin(adminReplies, []))),
      ordersSync: testOrdersSyncWorkflows(),
      notify: runs.notify,
      notifyRuns: runs.notifyRuns,
      teamsOfOrder: runRepository.teamsOfOrder,
      reconciler: runs.reconciler(),
      flushUsage: Effect.void,
      shop,
    });
    const webhook = (order: SyncedOrder) =>
      Effect.gen(function* () {
        adminReplies.push(Effect.succeed(encodeOrderSync({ order })));
        yield* orders.syncOrderWebhook({
          orderId: order.id,
          topic: "orders/updated",
          updatedAt: null,
        });
      }).pipe(Effect.orDie);
    const put = (data: unknown, replace: boolean) =>
      Effect.gen(function* () {
        const rows = fixtureRows(fixtureData(data), Date.now(), () => crypto.randomUUID());
        if (replace) {
          yield* membership.replaceShop(shop, rows.identity);
          yield* sql`delete from RunTask`;
          yield* sql`delete from Run`;
          yield* sql`delete from OrderLineItem`;
          yield* sql`delete from ShopOrder`;
          yield* sql`delete from Workflow`;
          yield* insertFixtureRows(sql, rows.actor);
        } else {
          yield* insertFixtureRows(sql, rows.actor);
          yield* membership.addToShop(shop, rows.identity);
        }
        yield* runs.applyFixture(rows.actor, replace ? "loadFixture" : "addToFixture");
        return {
          workflowId: (name: string) =>
            rows.actor.workflows.find((workflow) => workflow.name === name)?.id ?? "",
          member: (address: string): RunMember => ({
            role: "member",
            ...decodeMember(
              rows.actor.members.find((member) => member.email === address) ?? {
                memberId: "",
                email: address,
                teamIds: [],
              },
            ),
          }),
          teamId: (name: string) =>
            rows.identity.teams.find((team) => team.name === name)?.id ?? "",
        };
      }).pipe(Effect.orDie);
    return yield* body({
      runs,
      events,
      membership,
      orderRepository,
      runRepository,
      sql,
      transaction,
      load: (data) => put(data, true),
      add: (data) => put(data, false),
      onNextNotify: (effect) => {
        next = effect;
      },
      webhook,
    });
  }).pipe(Effect.provide(ActorSqliteTest), Effect.provide(QuietLogs));

/** An order as Shopify's `OrderSync` answers it. */
type SyncedOrder = NonNullable<(typeof OrderSyncResponse)["Type"]["order"]>;
const encodeOrderSync = Schema.encodeSync(OrderSyncResponse);

/**
 * Order `n` as a webhook fetches it: one unfulfilled, paid item carrying `tags`, at version
 * `updatedAt`.
 */
const syncedOrder = (
  n: number,
  tags: ReadonlyArray<string>,
  updatedAt: number,
  overrides: Partial<SyncedOrder> = {},
): SyncedOrder => ({
  id: `gid://shopify/Order/${String(n)}`,
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: n,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  lineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        id: `gid://shopify/LineItem/${String(n)}`,
        title: `Item ${String(n)}`,
        variantTitle: null,
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        customAttributes: [],
        product: { tags },
      },
    ],
  },
  ...overrides,
});

/** What a loaded fixture lets a test look up: the ids it minted. */
interface FixtureLoaded {
  readonly workflowId: (name: string) => string;
  readonly member: (email: string) => RunMember;
  readonly teamId: (name: string) => string;
}

const ANA = "ana@example.com";
const BEN = "ben@example.com";

/** One team, `Bench`, with Ana and Ben on it. */
const bench = {
  members: [ANA, BEN],
  teams: [{ name: "Bench", members: [ANA, BEN] }],
};

/** A two-task workflow on `team`, steps 1 then 2. */
const twoTask = (name: string, tag: string, team = "Bench") => ({
  name,
  tag,
  tasks: [
    { name: "Cut", team },
    { name: "Finish", team },
  ],
});

const fixtureOrderId = (n: number) => `gid://shopify/Order/fixture-${String(n)}`;
const lineItemId = (n: number, position = 1) => `${fixtureOrderId(n)}/line-${String(position)}`;

/** The runs of fixture order `n`, with their tasks. */
const runsOf = (runRepository: RunRepository, n: number) =>
  runRepository.listRunsForOrder({ orderId: fixtureOrderId(n) }).pipe(Effect.orDie);

/** The one run of fixture order `n`; dies when there is none. */
const onlyRun = (runRepository: RunRepository, n: number) =>
  runsOf(runRepository, n).pipe(
    Effect.flatMap(([detail]) =>
      detail === undefined ? Effect.die(new Error("no run")) : Effect.succeed(detail),
    ),
  );

/** One order with one Board item, and Bench's two-task Board workflow. */
const oneBoard = {
  ...bench,
  workflows: [twoTask("Board", "board")],
  orders: [{ n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] }],
};

const notices = (events: ReadonlyArray<Event>) =>
  events.flatMap((event) => (event.kind === "notify" ? [event.invalidated] : []));
const flushes = (events: ReadonlyArray<Event>) =>
  events.filter((event) => event.kind === "flush").length;

describe("Runs result mapping", () => {
  it.effect("each merchant run verb answers Ok, NotFound or NotAllowed as its gate says", () =>
    harness(({ runs, load, runRepository }) =>
      Effect.gen(function* () {
        yield* load(oneBoard);
        const { run, tasks } = yield* onlyRun(runRepository, 1);
        const [cut, finish] = tasks;
        assert.isDefined(cut);
        assert.isDefined(finish);
        if (cut === undefined || finish === undefined) return;
        assert.strictEqual((yield* runs.merchantCancelRun({ runId: "nope" }))._tag, "NotFound");
        assert.strictEqual(
          (yield* runs.merchantMarkTaskDone({ runTaskId: "nope" }))._tag,
          "NotFound",
        );
        // Finish waits on Cut: not current, so Done is not offered.
        assert.strictEqual(
          (yield* runs.merchantMarkTaskDone({ runTaskId: finish.id }))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.merchantReopenTask({ runTaskId: cut.id }))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.merchantPutBackTask({ runTaskId: cut.id }))._tag,
          "NotAllowed",
        );
        assert.strictEqual((yield* runs.merchantUnblockRun({ runId: run.id }))._tag, "NotAllowed");
        assert.strictEqual((yield* runs.merchantMarkTaskDone({ runTaskId: cut.id }))._tag, "Ok");
        assert.strictEqual((yield* runs.merchantReopenTask({ runTaskId: cut.id }))._tag, "Ok");
        assert.strictEqual(
          (yield* runs.merchantSetRunNote({
            runId: run.id,
            note: Schema.decodeUnknownSync(ShopWork.RunNote)("Walnut"),
          }))._tag,
          "Ok",
        );
        assert.strictEqual(
          (yield* runs.merchantBlockRun({ runId: run.id, reason: null }))._tag,
          "Ok",
        );
        assert.strictEqual(
          (yield* runs.merchantBlockRun({ runId: run.id, reason: null }))._tag,
          "NotAllowed",
        );
        assert.strictEqual((yield* runs.merchantUnblockRun({ runId: run.id }))._tag, "Ok");
        assert.strictEqual((yield* runs.merchantCancelRun({ runId: run.id }))._tag, "Ok");
        assert.strictEqual((yield* runs.merchantCancelRun({ runId: run.id }))._tag, "NotAllowed");
      }),
    ),
  );

  it.effect("each member run verb answers Ok, NotFound or NotAllowed as its gate says", () =>
    harness(({ runs, load, runRepository }) =>
      Effect.gen(function* () {
        const loaded = yield* load({
          members: [ANA, BEN],
          teams: [
            { name: "Bench", members: [ANA] },
            { name: "Shop", members: [BEN] },
          ],
          workflows: [twoTask("Board", "board")],
          orders: [{ n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] }],
        });
        const ana = loaded.member(ANA);
        const ben = loaded.member(BEN);
        const { run, tasks } = yield* onlyRun(runRepository, 1);
        const [cut] = tasks;
        assert.isDefined(cut);
        if (cut === undefined) return;
        assert.strictEqual(
          (yield* runs.memberStartTask({ runTaskId: "nope" }, ana))._tag,
          "NotFound",
        );
        // Ben's teams hold no task of the run: every write is refused, the note included.
        assert.strictEqual(
          (yield* runs.memberStartTask({ runTaskId: cut.id }, ben))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.memberSetRunNote({ runId: run.id, note: null }, ben))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.memberBlockRun({ runId: run.id, reason: null }, ben))._tag,
          "NotAllowed",
        );
        assert.strictEqual((yield* runs.memberStartTask({ runTaskId: cut.id }, ana))._tag, "Ok");
        assert.strictEqual((yield* runs.memberPutBackTask({ runTaskId: cut.id }, ana))._tag, "Ok");
        assert.strictEqual((yield* runs.memberMarkTaskDone({ runTaskId: cut.id }, ana))._tag, "Ok");
        assert.strictEqual((yield* runs.memberReopenTask({ runTaskId: cut.id }, ana))._tag, "Ok");
        assert.strictEqual(
          (yield* runs.memberBlockRun({ runId: run.id, reason: null }, ana))._tag,
          "Ok",
        );
        assert.strictEqual(
          (yield* runs.memberStartTask({ runTaskId: cut.id }, ana))._tag,
          "NotAllowed",
        );
        assert.strictEqual((yield* runs.memberUnblockRun({ runId: run.id }, ana))._tag, "Ok");
        assert.strictEqual(
          (yield* runs.memberUnblockRun({ runId: run.id }, ana))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.memberSetRunNote({ runId: run.id, note: null }, ana))._tag,
          "Ok",
        );
      }),
    ),
  );

  it.effect("Attach answers each of its refusals, then Ok with what it replaced", () =>
    harness(({ runs, load, membership }) =>
      Effect.gen(function* () {
        const loaded = yield* load({
          ...bench,
          workflows: [
            twoTask("Board", "board"),
            twoTask("Ring", "ring"),
            { name: "Loose", tag: "loose", tasks: [{ name: "Do", team: null }] },
          ],
          orders: [
            {
              n: 1,
              lineItems: [
                { title: "Board", quantity: 1, tags: ["board"] },
                { title: "Gone", quantity: 1, currentQuantity: 0, tags: [] },
              ],
            },
            {
              n: 2,
              lineItems: [{ title: "Cancelled", quantity: 1, tags: [] }],
              after: { cancelled: true },
            },
          ],
        });
        const attach = (lineItem: string, workflow: string) =>
          runs.merchantAttachWorkflow({
            lineItemId: lineItem,
            workflowId: loaded.workflowId(workflow),
          });
        assert.strictEqual((yield* attach("nope", "Board"))._tag, "LineItemNotFound");
        assert.strictEqual((yield* attach(lineItemId(1), "Loose"))._tag, "WorkflowNotEligible");
        assert.strictEqual((yield* attach(lineItemId(2), "Board"))._tag, "OrderClosed");
        assert.strictEqual((yield* attach(lineItemId(1, 2), "Board"))._tag, "NothingToMake");
        assert.strictEqual((yield* attach(lineItemId(1), "Board"))._tag, "AlreadyExists");
        const replaced = yield* attach(lineItemId(1), "Ring");
        if (replaced._tag !== "Ok") throw new Error(replaced._tag);
        assert.strictEqual(replaced.run.workflowName, "Ring");
        assert.strictEqual(replaced.replaced?.workflowName, "Board");
        assert.isAbove((yield* membership.listTeams(shop)).length, 0);
      }),
    ),
  );

  it.effect("Assign answers TeamNotFound, TaskDone, RunNotOpen, NotFound and Assigned", () =>
    harness(({ runs, load, runRepository }) =>
      Effect.gen(function* () {
        const loaded = yield* load({
          members: [ANA],
          teams: [
            { name: "Bench", members: [ANA] },
            { name: "Shop", members: [] },
          ],
          workflows: [twoTask("Board", "board")],
          orders: [
            { n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
            {
              n: 2,
              lineItems: [
                { title: "Board", quantity: 1, tags: ["board"], progress: { done: true } },
              ],
            },
          ],
        });
        const shopTeam = loaded.teamId("Shop");
        const [cut] = (yield* onlyRun(runRepository, 1)).tasks;
        const [doneCut] = (yield* onlyRun(runRepository, 2)).tasks;
        assert.isDefined(cut);
        assert.isDefined(doneCut);
        if (cut === undefined || doneCut === undefined) return;
        const assign = (runTaskId: string, teamId: string) =>
          runs.merchantAssignRunTaskTeam({ runTaskId, teamId });
        assert.strictEqual((yield* assign("nope", shopTeam))._tag, "NotFound");
        assert.strictEqual((yield* assign(cut.id, "no-such-team"))._tag, "TeamNotFound");
        // A done run's task is offered no Assign: the gate answers before the repository.
        assert.strictEqual((yield* assign(doneCut.id, shopTeam))._tag, "NotAllowed");
        assert.strictEqual((yield* assign(cut.id, shopTeam))._tag, "Assigned");
        const [moved] = (yield* onlyRun(runRepository, 1)).tasks;
        assert.strictEqual(moved?.teamName, "Shop");
      }),
    ),
  );
});

describe("Runs gate and notices", () => {
  it.effect("a refused write touches no row and notifies nothing", () =>
    harness(({ runs, load, runRepository, events }) =>
      Effect.gen(function* () {
        const loaded = yield* load({
          members: [ANA, BEN],
          teams: [
            { name: "Bench", members: [ANA] },
            { name: "Shop", members: [BEN] },
          ],
          workflows: [twoTask("Board", "board")],
          orders: [{ n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] }],
        });
        const before = yield* onlyRun(runRepository, 1);
        const [cut] = before.tasks;
        if (cut === undefined) throw new Error("no task");
        events.length = 0;
        const ben = loaded.member(BEN);
        assert.strictEqual(
          (yield* runs.memberMarkTaskDone({ runTaskId: cut.id }, ben))._tag,
          "NotAllowed",
        );
        assert.strictEqual(
          (yield* runs.memberBlockRun({ runId: before.run.id, reason: null }, ben))._tag,
          "NotAllowed",
        );
        assert.deepStrictEqual(yield* onlyRun(runRepository, 1), before);
        assert.deepStrictEqual(notices(events), []);
      }),
    ),
  );

  it.effect("every run write notifies ORDERS_KEY once, on its success only", () =>
    harness(({ runs, load, runRepository, events }) =>
      Effect.gen(function* () {
        yield* load(oneBoard);
        const { run, tasks } = yield* onlyRun(runRepository, 1);
        const [cut] = tasks;
        if (cut === undefined) throw new Error("no task");
        events.length = 0;
        yield* runs.merchantMarkTaskDone({ runTaskId: cut.id });
        yield* runs.merchantBlockRun({ runId: run.id, reason: null });
        yield* runs.merchantBlockRun({ runId: run.id, reason: null });
        yield* runs.merchantCancelRun({ runId: "nope" });
        assert.deepStrictEqual(notices(events), [[ORDERS_KEY], [ORDERS_KEY]]);
      }),
    ),
  );
});

describe("Runs reads the teams before any transaction", () => {
  const noTeamsInTransaction = (events: ReadonlyArray<Event>) => {
    const reads = events.filter((event) => event.kind === "listTeams");
    assert.isAbove(reads.length, 0);
    assert.isTrue(events.some((event) => event.kind === "transaction"));
    assert.deepStrictEqual(
      reads.filter((event) => event.kind === "listTeams" && event.inTransaction),
      [],
    );
  };

  it.effect(
    "reconcile all, Attach, Assign and the reconciler read D1 outside every transaction",
    () =>
      harness(({ runs, load, runRepository, orderRepository, events }) =>
        Effect.gen(function* () {
          const loaded = yield* load({
            ...oneBoard,
            workflows: [twoTask("Board", "board"), twoTask("Ring", "ring")],
          });
          events.length = 0;
          yield* runs.reconcileAll("test", "all");
          noTeamsInTransaction(events);

          events.length = 0;
          yield* runs.merchantAttachWorkflow({
            lineItemId: lineItemId(1),
            workflowId: loaded.workflowId("Ring"),
          });
          noTeamsInTransaction(events);

          events.length = 0;
          const [cut] = (yield* onlyRun(runRepository, 1)).tasks;
          yield* runs.merchantAssignRunTaskTeam({
            runTaskId: cut?.id ?? "",
            teamId: loaded.teamId("Bench"),
          });
          noTeamsInTransaction(events);

          events.length = 0;
          const reconcile = yield* runs.reconciler();
          const stored = Option.getOrThrow(
            yield* orderRepository.getOrder(fixtureOrderId(1)).pipe(Effect.orDie),
          );
          yield* orderRepository
            .upsertOrder({
              order: stored.order,
              lineItems: stored.lineItems,
              afterWrite: reconcile(stored.order),
            })
            .pipe(Effect.orDie);
          noTeamsInTransaction(events);
        }),
      ),
  );
});

describe("Runs usage flush", () => {
  it.effect("reconcile all flushes after its pass, and even when the pass fails", () =>
    Effect.gen(function* () {
      yield* harness(({ runs, events, load }) =>
        Effect.gen(function* () {
          yield* load(oneBoard);
          events.length = 0;
          yield* runs.reconcileAll("test", "ok");
          assert.strictEqual(flushes(events), 1);
        }),
      );
      let failing = false;
      yield* harness(
        ({ runs, events, load }) =>
          Effect.gen(function* () {
            yield* load(oneBoard);
            events.length = 0;
            failing = true;
            const exit = yield* Effect.exit(runs.reconcileAll("test", "fails"));
            assert.isTrue(Exit.isFailure(exit));
            assert.strictEqual(flushes(events), 1);
          }),
        {
          workflows: (real) => ({
            ...real,
            listActiveWorkflowsByTags: (input) =>
              failing
                ? Effect.fail(new WorkflowRepositoryError({ message: "down", cause: null }))
                : real.listActiveWorkflowsByTags(input),
          }),
        },
      );
    }),
  );

  it.effect("Attach flushes after an attach and after a refused one", () =>
    harness(({ runs, events, load }) =>
      Effect.gen(function* () {
        const loaded = yield* load({
          ...oneBoard,
          workflows: [twoTask("Board", "board"), twoTask("Ring", "ring")],
        });
        events.length = 0;
        yield* runs.merchantAttachWorkflow({
          lineItemId: "nope",
          workflowId: loaded.workflowId("Ring"),
        });
        assert.strictEqual(flushes(events), 1);
        yield* runs.merchantAttachWorkflow({
          lineItemId: lineItemId(1),
          workflowId: loaded.workflowId("Ring"),
        });
        assert.strictEqual(flushes(events), 2);
      }),
    ),
  );
});

/**
 * A counting wrapper over the list reads the memos hold. `counts` counts the order facts' reads,
 * and `factScopes` records each one's scope.
 */
const counting = () => {
  const count = { orders: 0, counts: 0, runs: 0, recent: 0 };
  const factScopes: Array<OrderFactsScope["_tag"]> = [];
  const wrap: Wrap = {
    orders: (real) => ({
      ...real,
      listOrders: (input) =>
        Effect.suspend(() => {
          count.orders += 1;
          return real.listOrders(input);
        }),
      readOrderFacts: (scope) =>
        Effect.suspend(() => {
          count.counts += 1;
          factScopes.push(scope._tag);
          return real.readOrderFacts(scope);
        }),
    }),
    runs: (real) => ({
      ...real,
      runListItems: (teamIds) =>
        Effect.suspend(() => {
          count.runs += 1;
          return real.runListItems(teamIds);
        }),
      listRecent: (input) =>
        Effect.suspend(() => {
          count.recent += 1;
          return real.listRecent(input);
        }),
    }),
  };
  return { count, factScopes, wrap };
};

const READY = runQuery({ team: null, state: "ready", limit: 25, q: null });

describe("the list memo", () => {
  it.effect("a second read of the same key executes no list SQL", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load }) =>
        Effect.gen(function* () {
          const loaded = yield* load(oneBoard);
          const ana = loaded.member(ANA);
          const read = Effect.all([
            runs.listOrders(EVERY_ORDER),
            runs.listRuns({ teamIds: ana.teamIds, memberEmail: email(BEN), query: READY }),
          ]);
          yield* read;
          const before = { ...count };
          const [orders, list] = yield* read;
          assert.strictEqual(orders.page.orders.length, 1);
          assert.strictEqual(list.items.length, 1);
          assert.deepStrictEqual(count, before);
        }),
      wrap,
    );
  });

  it.effect("each memo read logs whether it ran the list read", () => {
    const logged: Array<string> = [];
    const capturing = Logger.layer([
      Logger.make(({ message, logLevel }) => {
        const line = String(Array.isArray(message) ? message[0] : message);
        if (logLevel === "Debug" && (line.includes("memo=") || line.includes("read=")))
          logged.push(line);
      }),
    ]);
    return harness(({ runs, load }) =>
      Effect.gen(function* () {
        const loaded = yield* load(oneBoard);
        const ana = loaded.member(ANA);
        const read = Effect.all([
          runs.listOrders(EVERY_ORDER),
          runs.listRuns({ teamIds: ana.teamIds, memberEmail: email(BEN), query: READY }),
        ]);
        yield* read;
        yield* read;
        yield* runs.notify([ORDERS_KEY]);
        yield* read;
        assert.deepStrictEqual(logged, [
          `OrderFacts.counts: shop=${shop} read=full reason=cold`,
          `Runs.listOrders: shop=${shop} memo=miss`,
          `Runs.listRuns: shop=${shop} memo=miss recent=miss`,
          `OrderFacts.counts: shop=${shop} read=hit`,
          `Runs.listOrders: shop=${shop} memo=hit`,
          `Runs.listRuns: shop=${shop} memo=hit recent=hit`,
          `OrderFacts.counts: shop=${shop} read=full reason=shop`,
          `Runs.listOrders: shop=${shop} memo=miss`,
          `Runs.listRuns: shop=${shop} memo=miss recent=miss`,
        ]);
      }).pipe(
        Effect.provide(capturing),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );
  });

  it.effect("a publish between two reads makes the second one recompute", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load, sql }) =>
        Effect.gen(function* () {
          const loaded = yield* load(oneBoard);
          const ana = loaded.member(ANA);
          const read = Effect.all([
            runs.listOrders(EVERY_ORDER),
            runs.listRuns({ teamIds: ana.teamIds, memberEmail: email(BEN), query: READY }),
          ]);
          const [orders] = yield* read;
          assert.strictEqual(orders.page.orders.length, 1);
          // A write the memo does not see until the notice that follows it.
          yield* sql`delete from Run`;
          yield* sql`delete from ShopOrder`;
          const [stale] = yield* read;
          assert.strictEqual(stale.page.orders.length, 1);
          yield* runs.notify([ORDERS_KEY]);
          const before = { ...count };
          const [fresh, list] = yield* read;
          assert.strictEqual(fresh.page.orders.length, 0);
          assert.strictEqual(fresh.page.openOrders, 0);
          assert.strictEqual(list.items.length, 0);
          assert.deepStrictEqual(count, {
            orders: before.orders + 1,
            counts: before.counts + 1,
            runs: before.runs + 1,
            recent: before.recent + 1,
          });
        }),
      wrap,
    );
  });

  it.effect("the class's publish clears the memo before its invalidations", () =>
    harness(({ runs, load, sql, onNextNotify }) =>
      Effect.gen(function* () {
        yield* load(oneBoard);
        assert.strictEqual((yield* runs.listOrders(EVERY_ORDER)).page.orders.length, 1);
        yield* sql`delete from ShopOrder`;
        assert.strictEqual((yield* runs.listOrders(EVERY_ORDER)).page.orders.length, 1);
        let seen = -1;
        onNextNotify(
          runs.listOrders(EVERY_ORDER).pipe(
            Effect.map(({ page }) => {
              seen = page.orders.length;
            }),
          ),
        );
        yield* runs.notify([ORDERS_KEY]);
        assert.strictEqual(seen, 0);
      }),
    ),
  );

  it.effect("members on the same teams share one computation", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load }) =>
        Effect.gen(function* () {
          const loaded = yield* load({
            members: [ANA, BEN],
            teams: [
              { name: "Bench", members: [ANA, BEN] },
              { name: "Shop", members: [ANA, BEN] },
            ],
            workflows: [twoTask("Board", "board")],
            orders: [
              {
                n: 1,
                lineItems: [
                  {
                    title: "Board",
                    quantity: 1,
                    tags: ["board"],
                    progress: { started: true, by: ANA },
                  },
                ],
              },
            ],
          });
          const ana = loaded.member(ANA);
          const before = count.runs;
          const query = runQuery({ team: null, state: "started_by_you", limit: 25, q: null });
          const mine = yield* runs.listRuns({
            teamIds: ana.teamIds,
            memberEmail: email(ANA),
            query,
          });
          // The same teams in another order are the same key.
          const theirs = yield* runs.listRuns({
            teamIds: ana.teamIds.toReversed(),
            memberEmail: email(BEN),
            query,
          });
          assert.strictEqual(count.runs - before, 1);
          assert.strictEqual(mine.counts.started_by_you, 1);
          assert.strictEqual(theirs.counts.started_by_you, 0);
        }),
      wrap,
    );
  });

  it.effect("every page, Show and search under one team share one count, until a write", () => {
    const { count, factScopes, wrap } = counting();
    return harness(
      ({ runs, load, runRepository }) =>
        Effect.gen(function* () {
          yield* load(oneBoard);
          const making = listOrdersInput({ ...EVERY_ORDER, show: "making" });
          const search = listOrdersInput({ ...EVERY_ORDER, q: "Board" });
          const first = yield* runs.listOrders(EVERY_ORDER);
          yield* runs.listOrders(making);
          const found = yield* runs.listOrders(search);
          assert.strictEqual(count.counts, 1);
          assert.strictEqual(count.orders, 3);
          assert.deepStrictEqual(found.page.counts, first.page.counts);
          assert.strictEqual(first.page.counts.not_started, 1);
          assert.strictEqual(first.page.counts.making, 0);
          const { tasks } = yield* onlyRun(runRepository, 1);
          const cut = tasks[0];
          if (cut === undefined) return yield* Effect.die(new Error("no Cut"));
          assert.strictEqual((yield* runs.merchantMarkTaskDone({ runTaskId: cut.id }))._tag, "Ok");
          const after = yield* runs.listOrders(making);
          // The write named its order: the second read is that order's alone.
          assert.deepStrictEqual(factScopes, ["Open", "Orders"]);
          assert.strictEqual(after.page.counts.not_started, 0);
          assert.strictEqual(after.page.counts.making, 1);
          assert.strictEqual(after.page.orders.length, 1);
        }),
      wrap,
    );
  });

  it.effect("a write to one run recomputes only the lists of teams it has a task on", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load, runRepository, events }) =>
        Effect.gen(function* () {
          const loaded = yield* load({
            members: [ANA, BEN],
            teams: [
              { name: "Bench", members: [ANA] },
              { name: "Shop", members: [BEN] },
            ],
            workflows: [twoTask("Board", "board"), twoTask("Ring", "ring", "Shop")],
            orders: [
              {
                n: 1,
                lineItems: [
                  { title: "Board", quantity: 1, tags: ["board"] },
                  { title: "Ring", quantity: 1, tags: ["ring"] },
                ],
              },
            ],
          });
          const ana = loaded.member(ANA);
          const ben = loaded.member(BEN);
          const read = (member: RunMember) =>
            runs.listRuns({ teamIds: member.teamIds, memberEmail: member.email, query: READY });
          yield* read(ana);
          const bensBefore = yield* read(ben);
          const before = { ...count };
          const board = (yield* runsOf(runRepository, 1)).find(
            ({ tasks }) => tasks[0]?.teamId === ana.teamIds[0],
          );
          const cut = board?.tasks[0];
          if (cut === undefined) return yield* Effect.die(new Error("no Board run"));
          events.length = 0;
          assert.strictEqual(
            (yield* runs.memberMarkTaskDone({ runTaskId: cut.id }, ana))._tag,
            "Ok",
          );
          assert.deepStrictEqual(notices(events), [[ORDERS_KEY]]);
          const anas = yield* read(ana);
          const bens = yield* read(ben);
          assert.strictEqual(count.runs, before.runs + 1);
          assert.strictEqual(count.recent, before.recent + 1);
          assert.strictEqual(anas.counts.done, 1);
          assert.strictEqual(anas.items[0]?.tasks[0]?.name, "Finish");
          assert.deepStrictEqual(bens, bensBefore);
        }),
      wrap,
    );
  });

  /** Ana on Bench, Ben on Shop, Bench's Board and Shop's Ring, and no orders. */
  const benchAndShop = {
    members: [ANA, BEN],
    teams: [
      { name: "Bench", members: [ANA] },
      { name: "Shop", members: [BEN] },
    ],
    workflows: [twoTask("Board", "board"), twoTask("Ring", "ring", "Shop")],
    orders: [],
  };

  it.effect("a webhook recomputes only the lists of teams its order's runs are on", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load, webhook, events }) =>
        Effect.gen(function* () {
          const loaded = yield* load(benchAndShop);
          const ana = loaded.member(ANA);
          const ben = loaded.member(BEN);
          const read = (member: RunMember) =>
            runs.listRuns({ teamIds: member.teamIds, memberEmail: member.email, query: READY });
          yield* webhook(syncedOrder(1, ["board"], 1));
          yield* webhook(syncedOrder(2, ["ring"], 1));
          assert.strictEqual((yield* read(ana)).items.length, 1);
          const bensBefore = yield* read(ben);
          assert.strictEqual(bensBefore.items.length, 1);
          const before = { ...count };
          events.length = 0;
          yield* webhook(syncedOrder(1, ["board"], 2, { displayFulfillmentStatus: "FULFILLED" }));
          assert.deepStrictEqual(notices(events), [[ORDERS_KEY]]);
          const anas = yield* read(ana);
          const bens = yield* read(ben);
          assert.strictEqual(anas.items.length, 0);
          assert.strictEqual(anas.counts.done, 1);
          assert.deepStrictEqual(bens, bensBefore);
          assert.strictEqual(count.runs, before.runs + 1);
          assert.strictEqual(count.recent, before.recent + 1);
        }),
      wrap,
    );
  });

  it.effect("a webhook whose reconcile starts a run recomputes the lists of its teams", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load, webhook }) =>
        Effect.gen(function* () {
          const loaded = yield* load(benchAndShop);
          const ana = loaded.member(ANA);
          const ben = loaded.member(BEN);
          const read = (member: RunMember) =>
            runs.listRuns({ teamIds: member.teamIds, memberEmail: member.email, query: READY });
          const anasBefore = yield* read(ana);
          assert.strictEqual((yield* read(ben)).items.length, 0);
          const before = { ...count };
          yield* webhook(syncedOrder(1, ["ring"], 1));
          assert.strictEqual((yield* read(ben)).items.length, 1);
          assert.deepStrictEqual(yield* read(ana), anasBefore);
          assert.strictEqual(count.runs, before.runs + 1);
        }),
      wrap,
    );
  });

  it.effect("a webhook that leaves its order no run recomputes the teams the runs were on", () => {
    const { count, wrap: counted } = counting();
    /** A reconcile that also deletes the order's runs, which today's reconcile never does. */
    let dropRuns: Effect.Effect<void> = Effect.void;
    const wrap: Wrap = {
      ...counted,
      runs: (real) => {
        const inner = counted.runs?.(real) ?? real;
        return {
          ...inner,
          reconcileOrder: (input) =>
            inner.reconcileOrder(input).pipe(Effect.tap(() => Effect.suspend(() => dropRuns))),
        };
      },
    };
    return harness(
      ({ runs, load, webhook, sql }) =>
        Effect.gen(function* () {
          const loaded = yield* load(benchAndShop);
          const ana = loaded.member(ANA);
          const read = runs.listRuns({
            teamIds: ana.teamIds,
            memberEmail: ana.email,
            query: READY,
          });
          const order = syncedOrder(1, ["board"], 1);
          yield* webhook(order);
          assert.strictEqual((yield* read).items.length, 1);
          const before = { ...count };
          dropRuns = Effect.orDie(
            Effect.gen(function* () {
              yield* sql`delete from RunTask where runId in (select id from Run where orderId = ${order.id})`;
              yield* sql`delete from Run where orderId = ${order.id}`;
            }),
          );
          yield* webhook({ ...order, updatedAt: 2 });
          assert.strictEqual((yield* read).items.length, 0);
          assert.strictEqual(count.runs, before.runs + 1);
        }),
      wrap,
    );
  });

  it.effect("the Done count drops when the window slides past its oldest task", () => {
    const { count, wrap } = counting();
    return harness(
      ({ runs, load, runRepository }) =>
        Effect.gen(function* () {
          const loaded = yield* load(oneBoard);
          const ana = loaded.member(ANA);
          const { tasks } = yield* onlyRun(runRepository, 1);
          const cut = tasks[0];
          if (cut === undefined) return yield* Effect.die(new Error("no Cut"));
          yield* runs.memberMarkTaskDone({ runTaskId: cut.id }, ana);
          const read = runs.listRuns({
            teamIds: ana.teamIds,
            memberEmail: ana.email,
            query: READY,
          });
          const readDone = runs.listRuns({
            teamIds: ana.teamIds,
            memberEmail: ana.email,
            query: runQuery({ team: null, state: "done", limit: 25, q: null }),
          });
          assert.strictEqual((yield* read).counts.done, 1);
          const done = yield* readDone;
          assert.strictEqual(done.counts.done, 1);
          assert.strictEqual(done.recent.length, 1);
          yield* TestClock.adjust(ShopWork.DONE_WINDOW_MS - 1);
          assert.strictEqual((yield* read).counts.done, 1);
          assert.strictEqual((yield* readDone).recent.length, 1);
          assert.strictEqual(count.recent, 2);
          yield* TestClock.adjust(2);
          assert.strictEqual((yield* read).counts.done, 0);
          const gone = yield* readDone;
          assert.strictEqual(gone.counts.done, 0);
          assert.strictEqual(gone.recent.length, 0);
          assert.strictEqual(count.recent, 4);
        }),
      wrap,
    );
  });

  it.effect("a failed lookup is not kept", () => {
    let failed = false;
    return harness(
      ({ runs, load }) =>
        Effect.gen(function* () {
          const loaded = yield* load(oneBoard);
          const ana = loaded.member(ANA);
          const read = runs.listRuns({
            teamIds: ana.teamIds,
            memberEmail: email(BEN),
            query: READY,
          });
          const first = yield* Effect.exit(read);
          assert.isTrue(Exit.isFailure(first));
          const second = yield* read;
          assert.strictEqual(second.items.length, 1);
        }),
      {
        runs: (real) => ({
          ...real,
          runListItems: (teamIds) =>
            Effect.suspend(() => {
              if (failed) return real.runListItems(teamIds);
              failed = true;
              return Effect.fail(
                new RunRepositoryError({ message: "once", cause: new Error("once") }),
              );
            }),
        }),
      },
    );
  });
});

describe("the Show counts' facts", () => {
  /**
   * The guard against a writer that forgets to name its orders: after every write, the counts a
   * warm activation serves from its patched facts equal those a cold activation reads in full,
   * for every team and for none. Each step moves some count, so a missed mark shows; the run
   * verbs and the webhooks must patch, the workflow edit and the team delete read in full.
   */
  it.effect("patched facts count what a full read counts, after every kind of write", () => {
    const { factScopes, wrap } = counting();
    return harness(
      ({ runs, load, webhook, membership, runRepository, sql, transaction }) =>
        Effect.gen(function* () {
          const loaded = yield* load({
            members: [ANA, BEN],
            teams: [
              { name: "Bench", members: [ANA] },
              { name: "Shop", members: [BEN] },
            ],
            workflows: [
              {
                name: "Board",
                tag: "board",
                tasks: [
                  { name: "Cut", team: "Bench" },
                  { name: "Finish", team: "Shop" },
                ],
              },
              twoTask("Ring", "ring", "Shop"),
              twoTask("Plank", "plank"),
            ],
            orders: [
              { n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
              { n: 2, lineItems: [{ title: "Ring", quantity: 1, tags: ["ring"] }] },
              { n: 3, lineItems: [{ title: "Board", quantity: 1, tags: ["board", "plank"] }] },
            ],
          });
          const ana = loaded.member(ANA);
          const ben = loaded.member(BEN);
          const bench = ShopWork.TeamId.make(loaded.teamId("Bench"));
          const shopTeam = ShopWork.TeamId.make(loaded.teamId("Shop"));
          const workflowRepository = makeWorkflowRepository(sql, transaction);
          const workflows = makeWorkflows({
            repository: workflowRepository,
            membershipRepository: membership,
            reconcileAll: runs.reconcileAll,
            notify: runs.notify,
            shop,
          });
          const members = makeMembership({
            membershipRepository: membership,
            workflowRepository,
            reconcileAll: runs.reconcileAll,
            notify: runs.notify,
            revoke: () => Effect.succeed(0),
            shop,
          });
          /** The counts under no team and under each team, from `service`. */
          const countsFrom = (service: typeof runs) =>
            Effect.forEach([null, bench, shopTeam], (team) =>
              service
                .listOrders({ ...EVERY_ORDER, team })
                .pipe(Effect.map(({ page }) => ({ counts: page.counts, open: page.openOrders }))),
            );
          /** The counts a cold activation reads: a runs service of its own over the same stores. */
          const fresh = Effect.gen(function* () {
            const cold = yield* makeRuns({
              runRepository,
              orderRepository: makeOrderRepository(sql, transaction),
              workflowRepository,
              membershipRepository: membership,
              transaction,
              notify: () => Effect.void,
              flushUsage: Effect.void,
              shop,
            });
            return yield* countsFrom(cold);
          });
          let previous = yield* countsFrom(runs);
          assert.deepStrictEqual(previous, yield* fresh);
          const step = (name: string, read: "Orders" | "Open", write: Effect.Effect<unknown>) =>
            Effect.gen(function* () {
              yield* write;
              factScopes.length = 0;
              const warm = yield* countsFrom(runs);
              assert.deepStrictEqual(warm, yield* fresh, `${name}: patched equals full`);
              assert.notDeepEqual(warm, previous, `${name}: moves a count`);
              assert.isTrue(
                factScopes.length > 0 && factScopes.every((scope) => scope === read),
                `${name}: reads ${read}, read ${factScopes.join(",")}`,
              );
              previous = warm;
            });
          const taskOf = (n: number, workflowName: string, index: number) =>
            Effect.gen(function* () {
              const detail = (yield* runsOf(runRepository, n)).find(
                ({ run }) => run.workflowName === workflowName,
              );
              const task = detail?.tasks[index];
              if (detail === undefined || task === undefined)
                return yield* Effect.die(new Error(`no ${workflowName} task on order ${n}`));
              return { run: detail.run, task };
            });
          const ok = (result: Effect.Effect<{ readonly _tag: string }>, expected = "Ok") =>
            Effect.map(result, ({ _tag }) => assert.strictEqual(_tag, expected));

          const cut = yield* taskOf(1, "Board", 0);
          yield* step("start", "Orders", ok(runs.memberStartTask({ runTaskId: cut.task.id }, ana)));
          yield* step(
            "done",
            "Orders",
            ok(runs.memberMarkTaskDone({ runTaskId: cut.task.id }, ana)),
          );
          const ring = yield* taskOf(2, "Ring", 0);
          yield* step(
            "block",
            "Orders",
            ok(
              runs.memberBlockRun(
                { runId: ring.run.id, reason: ShopWork.BlockReason.make("No stock") },
                ben,
              ),
            ),
          );
          yield* step("unblock", "Orders", ok(runs.merchantUnblockRun({ runId: ring.run.id })));
          yield* step(
            "assign",
            "Orders",
            ok(
              runs.merchantAssignRunTaskTeam({ runTaskId: ring.task.id, teamId: bench }),
              "Assigned",
            ),
          );
          yield* step("cancel", "Orders", ok(runs.merchantCancelRun({ runId: cut.run.id })));
          yield* step("webhook create", "Orders", webhook(syncedOrder(4, ["board"], 1)));
          yield* step(
            "webhook create, two matches",
            "Orders",
            webhook(syncedOrder(5, ["board", "ring"], 1)),
          );
          yield* step("webhook update", "Orders", webhook(syncedOrder(5, ["ring"], 2)));
          yield* step(
            "webhook fulfil",
            "Orders",
            webhook(syncedOrder(4, ["board"], 2, { displayFulfillmentStatus: "FULFILLED" })),
          );
          yield* step(
            "webhook cancel",
            "Orders",
            webhook(syncedOrder(5, ["ring"], 3, { cancelledAt: 3 })),
          );
          yield* step(
            "workflow off",
            "Open",
            ok(
              workflows.setWorkflowState(
                ShopWork.SetWorkflowStateInput.make({
                  workflowId: loaded.workflowId("Plank"),
                  state: "inactive",
                }),
              ),
            ),
          );
          yield* step(
            "team delete",
            "Open",
            ok(members.deleteTeam({ teamId: shopTeam }), "Deleted"),
          );
        }),
      wrap,
    );
  });
});

const BULK_URL = "https://storage.googleapis.test/bulk-orders.jsonl";

const orderLine = (n: number, processedAt: string, updatedAt: string) => ({
  __typename: "Order",
  id: `gid://shopify/Order/${String(n)}`,
  legacyResourceId: String(n),
  name: `#100${String(n)}`,
  processedAt,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
});

const lineItemLine = (n: number, parent: number) => ({
  __typename: "LineItem",
  id: `gid://shopify/LineItem/${String(n)}`,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: ["board"] },
  __parentId: `gid://shopify/Order/${String(parent)}`,
});

const bulkClient = (body: string) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
  );

describe("runOrdersStream with afterWrite", () => {
  it.effect(
    "creates runs on every streamed open order that matches, however old, and a re-stream creates none",
    () =>
      harness(({ runs, load, orderRepository, runRepository }) =>
        Effect.gen(function* () {
          yield* load({ ...bench, workflows: [twoTask("Board", "board")], orders: [] });
          const old = new Date(Date.now() - 300 * 86_400_000).toISOString();
          const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const body = [
            orderLine(1, old, old),
            lineItemLine(1, 1),
            orderLine(2, future, future),
            lineItemLine(2, 2),
          ]
            .map((line) => JSON.stringify(line))
            .join("\n");
          const stream = Effect.gen(function* () {
            yield* runOrdersStream({
              repository: orderRepository,
              shop,
              url: BULK_URL,
              afterWrite: yield* runs.reconciler(),
            });
          }).pipe(Effect.provideService(HttpClient.HttpClient, bulkClient(body)), Effect.orDie);
          yield* stream;
          const runsFor = (orderId: string) =>
            runRepository.listRunsForOrder({ orderId }).pipe(Effect.orDie);
          const first = yield* runsFor("gid://shopify/Order/1");
          const second = yield* runsFor("gid://shopify/Order/2");
          assert.strictEqual(first.length, 1);
          assert.strictEqual(second.length, 1);
          assert.strictEqual(second[0]?.tasks[0]?.teamName, "Bench");
          yield* stream;
          const secondPass = yield* runsFor("gid://shopify/Order/2");
          assert.strictEqual(secondPass.length, 1);
          assert.strictEqual(secondPass[0]?.run.id, second[0]?.run.id);
        }),
      ),
  );
});

/** The rows of the orders index for every stored order. */
const ordersPage = (runs: Effect.Success<ReturnType<typeof makeRuns<never>>>) =>
  runs.listOrders(EVERY_ORDER).pipe(Effect.map(({ page }) => page.orders));

describe("ShopAgent seed callables", () => {
  it.effect("seedOrders runs each item on its own progress and leaves its siblings alone", () =>
    harness(({ load, runRepository }) =>
      Effect.gen(function* () {
        yield* load({
          ...bench,
          workflows: [twoTask("Board", "board"), twoTask("Ring", "ring")],
          orders: [
            {
              n: 1,
              // The order's own keys, which the board overrides and the ring takes.
              advance: 1,
              lineItems: [
                { title: "Board", quantity: 1, tags: ["board"], progress: { done: true } },
                { title: "Ring", quantity: 1, tags: ["ring"] },
              ],
            },
          ],
        });
        const runs = yield* runsOf(runRepository, 1);
        assert.deepStrictEqual(
          runs
            .map(({ run, tasks }) => ({
              workflow: run.workflowName,
              state: run.state,
              done: tasks.filter((task) => task.doneAt !== null).length,
            }))
            .toSorted((a, b) => a.workflow.localeCompare(b.workflow)),
          [
            { workflow: "Board", state: "done", done: 2 },
            { workflow: "Ring", state: "open", done: 1 },
          ],
        );
      }),
    ),
  );

  it.effect("seedOrders chooses a workflow for an item two claim, and the order stops asking", () =>
    harness(({ runs, load, runRepository }) =>
      Effect.gen(function* () {
        const multiMatchItem = { title: "Board", quantity: 1, tags: ["board", "rush"] };
        const workflows = [twoTask("Board", "board"), twoTask("Rush order", "rush")];
        yield* load({ ...bench, workflows, orders: [{ n: 1, lineItems: [multiMatchItem] }] });
        assert.strictEqual((yield* runsOf(runRepository, 1)).length, 0);
        const [asking] = yield* ordersPage(runs);
        assert.deepStrictEqual(asking === undefined ? null : ShopWork.orderIssues(asking), [
          "multi_match",
        ]);

        yield* load({
          ...bench,
          workflows,
          orders: [{ n: 1, lineItems: [{ ...multiMatchItem, workflow: "Board" }] }],
        });
        assert.deepStrictEqual(
          (yield* runsOf(runRepository, 1)).map(({ run }) => run.workflowName),
          ["Board"],
        );
        const [chosen] = yield* ordersPage(runs);
        assert.strictEqual(
          chosen === undefined ? null : ShopWork.orderPosition(chosen),
          "not_started",
        );
        assert.isFalse(
          chosen === undefined || ShopWork.orderIssues(chosen).includes("multi_match"),
        );
      }),
    ),
  );

  it.effect(
    "seedOrders applies `after` once the work has started, so a cancel closes the run and a quantity change resizes it",
    () =>
      harness(({ load, runRepository }) =>
        Effect.gen(function* () {
          yield* load({
            ...bench,
            workflows: [twoTask("Board", "board")],
            orders: [
              {
                n: 1,
                advance: 1,
                after: { cancelled: true },
                lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }],
              },
              {
                n: 2,
                advance: 1,
                after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
                lineItems: [{ title: "Board", quantity: 2, tags: ["board"] }],
              },
            ],
          });
          const cancelled = (yield* onlyRun(runRepository, 1)).run;
          assert.strictEqual(cancelled.state, "closed");
          assert.strictEqual(cancelled.closedReason, "order_cancelled");
          assert.strictEqual((yield* onlyRun(runRepository, 2)).run.quantity, 1);
        }),
      ),
  );

  it.effect("a seeded run records its `by` member as the starter and the doer", () =>
    harness(({ load, runRepository }) =>
      Effect.gen(function* () {
        yield* load({
          ...bench,
          workflows: [twoTask("Board", "board")],
          orders: [
            {
              n: 1,
              lineItems: [
                {
                  title: "Board",
                  quantity: 1,
                  tags: ["board"],
                  progress: { advance: 1, started: true, by: ANA },
                },
                {
                  title: "Board",
                  quantity: 1,
                  tags: ["board"],
                  progress: { advance: 1, started: true },
                },
              ],
            },
          ],
        });
        const people = (yield* runsOf(runRepository, 1)).map(({ tasks }) =>
          tasks.map((task) => [task.doneByEmail, task.startedByEmail]),
        );
        // With no `by`, the Done is the merchant's (no email) and the Start the team's first
        // member's.
        assert.deepStrictEqual(people, [
          [
            [ANA, ANA],
            [null, ANA],
          ],
          [
            [null, null],
            [null, ANA],
          ],
        ]);
      }),
    ),
  );

  it.effect("a seeded Done on a team `by` is not on is recorded as that team's first member", () =>
    harness(({ load, runRepository }) =>
      Effect.gen(function* () {
        yield* load({
          members: [ANA, BEN],
          teams: [
            { name: "Woodshop", members: [BEN] },
            { name: "Engraving", members: [ANA] },
          ],
          workflows: [
            {
              name: "Board",
              tag: "board",
              tasks: [
                { name: "Cut", team: "Woodshop" },
                { name: "Engrave", team: "Engraving" },
              ],
            },
          ],
          orders: [
            {
              n: 1,
              lineItems: [
                {
                  title: "Board",
                  quantity: 1,
                  tags: ["board"],
                  progress: { advance: 1, started: true, by: ANA },
                },
              ],
            },
          ],
        });
        const people = (yield* runsOf(runRepository, 1)).map(({ tasks }) =>
          tasks.map((task) => [task.doneByEmail, task.startedByEmail]),
        );
        assert.deepStrictEqual(people, [
          [
            [BEN, BEN],
            [null, ANA],
          ],
        ]);
      }),
    ),
  );

  it.effect("a seeded run's note is written after its progress", () =>
    harness(({ load, runRepository }) =>
      Effect.gen(function* () {
        yield* load({
          ...bench,
          workflows: [twoTask("Board", "board")],
          orders: [
            {
              n: 1,
              note: "Gift for Sam",
              lineItems: [
                {
                  title: "Board",
                  quantity: 1,
                  tags: ["board"],
                  progress: { done: true, note: "Customer asked for walnut" },
                },
                { title: "Board", quantity: 1, tags: ["board"] },
              ],
            },
          ],
        });
        assert.deepStrictEqual(
          (yield* runsOf(runRepository, 1))
            .map(({ run }) => run.note ?? "")
            .toSorted((a, b) => a.localeCompare(b)),
          ["", "Customer asked for walnut"],
        );
      }),
    ),
  );

  it.effect("a seeded order is placed placedDaysAgo days before now, in the order given", () =>
    harness(({ load, sql }) =>
      Effect.gen(function* () {
        yield* load({
          members: [],
          teams: [],
          workflows: [],
          orders: [
            { n: 1, placedDaysAgo: 3, lineItems: [] },
            { n: 2, lineItems: [] },
          ],
        });
        const placed = (yield* sql<{ readonly processedAt: number }>`
          select processedAt from ShopOrder order by id
        `.pipe(Effect.orDie)).map(({ processedAt }) => processedAt);
        const [threeDaysAgo, today] = placed;
        const day = 86_400_000;
        assert.isBelow(Math.abs((today ?? 0) - (threeDaysAgo ?? 0) - 3 * day), 1000);
        assert.isBelow(Math.abs(Date.now() - (today ?? 0)), 60_000);
      }),
    ),
  );

  it.effect("a reseed reconciles the orders it did not replace", () =>
    harness(({ add, orderRepository, runs }) =>
      Effect.gen(function* () {
        const synced: ShopOrder = {
          id: "gid://shopify/Order/synced-1",
          legacyId: "synced-1",
          name: "#5001",
          processedAt: Date.now() - 86_400_000,
          updatedAt: 1,
          cancelledAt: null,
          fulfillmentStatus: "UNFULFILLED",
          fullyPaid: true,
          note: null,
          syncedAt: 1,
        };
        // A synced order, stored before any workflow could match it: the row a fixture leaves
        // alone. The fixture that follows only adds (`Fixtures.add`), so the order survives it.
        yield* orderRepository
          .upsertOrder({
            order: synced,
            lineItems: [
              {
                id: "gid://shopify/Order/synced-1/line-1",
                orderId: synced.id,
                title: "Board",
                variantTitle: null,
                sku: null,
                quantity: 1,
                currentQuantity: 1,
                productTags: ["board"],
                properties: [],
              },
            ],
          })
          .pipe(Effect.orDie);
        yield* add({ ...bench, workflows: [twoTask("Board", "board")], orders: [] });
        const detail = yield* runs.getOrderDetail({ legacyId: "synced-1" });
        // The new workflow, whose tag the item carries, is the one match, and the fixture's
        // reconcile all created its run.
        assert.deepStrictEqual(
          detail?.runs.map(({ run }) => run.workflowName),
          ["Board"],
        );
      }),
    ),
  );
});
