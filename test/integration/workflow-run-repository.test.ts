import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";
import { WorkflowRepository } from "@/lib/WorkflowRepository";
import {
  type ReconcileCounts,
  type RoutingContext,
  WorkflowRunRepository,
} from "@/lib/WorkflowRunRepository";

type Services =
  | OrderRepository
  | WorkflowRepository
  | WorkflowRunRepository
  | SqlClient.SqlClient;

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, Services>,
): Promise<A> =>
  runInDurableObject(
    env.TEST_SQL_DO.get(env.TEST_SQL_DO.idFromName(crypto.randomUUID())),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          return yield* program;
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              Layer.mergeAll(
                OrderRepository.layer,
                WorkflowRepository.layer,
                WorkflowRunRepository.layer,
              ),
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const stepName = Schema.decodeUnknownSync(Domain.StepName);
const tags = Schema.decodeUnknownSync(Domain.ProductTags);
const teamId = Schema.decodeUnknownSync(Domain.TeamId);
const teamName = Schema.decodeUnknownSync(Domain.TeamName);
const memberId = Schema.decodeUnknownSync(Domain.MemberId);

const TEAM_A = { id: teamId("team-a"), name: teamName("Team A") };
const TEAM_B = { id: teamId("team-b"), name: teamName("Team B") };
const TEAM_C = { id: teamId("team-c"), name: teamName("Team C") };
const ACTIVE_TEAMS = [TEAM_A, TEAM_B, TEAM_C];
const instructions = Schema.decodeUnknownSync(Domain.StepInstructions);
const note = Schema.decodeUnknownSync(Domain.StepNote);

const ORDER_ID = "gid://shopify/Order/1";
/** Ahead of the wall clock so the age rule sees an order placed after the workflows the tests create. */
const PROCESSED_AT = Date.now() + 60 * 60 * 1000;

const order = (
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.ShopOrder => ({
  id: ORDER_ID,
  legacyId: "1",
  name: "#1001",
  createdAt: PROCESSED_AT,
  processedAt: PROCESSED_AT,
  updatedAt: PROCESSED_AT,
  cancelledAt: null,
  closedAt: null,
  financialStatus: "PAID",
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  tags: [],
  note: "Gift wrap please",
  customAttributes: [],
  lineItemsComplete: true,
  syncedAt: PROCESSED_AT,
  syncSource: "webhook",
  ...overrides,
});

const lineItem = (
  n: number,
  productTags: readonly string[],
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: `gid://shopify/LineItem/${String(n)}`,
  orderId: ORDER_ID,
  productId: null,
  variantId: null,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 2,
  currentQuantity: 2,
  unfulfilledQuantity: 2,
  nonFulfillableQuantity: 0,
  productTags,
  customAttributes: [{ key: "Engraving", value: `Hello ${String(n)}` }],
  requiresShipping: true,
  ...overrides,
});

/**
 * Two workflows, tags `a` and `b`, two steps each (Team A then Team B), and
 * an order with one line item per tag. `updatedAt` advances on every upsert
 * so the guard never refuses a rewrite.
 */
const seed = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const createWorkflow = (tag: string) =>
    Effect.gen(function* () {
      const created = yield* workflows.createWorkflow({
        name: name(`Workflow ${tag}`),
        tags: tags([tag]),
      });
      yield* workflows.addStep({
        workflowId: created.id,
        name: stepName("Cut"),
        teamId: TEAM_A.id,
      });
      yield* workflows.addStep({
        workflowId: created.id,
        name: stepName("Finish"),
        teamId: TEAM_B.id,
      });
      return created;
    });
  const a = yield* createWorkflow("a");
  const b = yield* createWorkflow("b");
  return { a, b };
});

/**
 * One workflow, tag `s`, stages `1 1 2 3` owned by A, B, C, A — the parallel
 * fixture: two teams ready at once, a third waiting on both.
 */
const seedStaged = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  yield* workflows.replaceWorkflows({
    workflows: [
      {
        name: name("Staged"),
        tags: tags(["s"]),
        steps: [
          {
            name: stepName("Artwork"),
            teamId: TEAM_A.id,
            stage: 1,
            instructions: instructions("300 dpi"),
          },
          { name: stepName("Materials"), teamId: TEAM_B.id, stage: 1 },
          { name: stepName("Produce"), teamId: TEAM_C.id, stage: 2 },
          { name: stepName("Inspect"), teamId: TEAM_A.id, stage: 3 },
        ],
      },
    ],
  });
});

/** Routes the staged workflow onto one line item and returns its run; `PROCESSED_AT` is ahead of the clock so the age rule passes. */
const stagedRun = () =>
  Effect.gen(function* () {
    yield* upsertAndReconcile(order(), [lineItem(1, ["s"])]);
    const [detail] = yield* runsForOrder();
    if (detail === undefined) throw new Error("no run");
    return detail;
  });

const routing = Effect.gen(function* () {
  const workflows =
    yield* (yield* WorkflowRepository).listActiveWorkflowDetails();
  return { workflows, activeTeams: ACTIVE_TEAMS } satisfies RoutingContext;
});

const upsertAndReconcile = (
  shopOrder: Domain.ShopOrder,
  lineItems: readonly Domain.OrderLineItem[],
  activeTeams: RoutingContext["activeTeams"] = ACTIVE_TEAMS,
) =>
  Effect.gen(function* () {
    const runs = yield* WorkflowRunRepository;
    const orders = yield* OrderRepository;
    const context = { ...(yield* routing), activeTeams };
    const counts = yield* Ref.make<ReconcileCounts>({
      created: 0,
      cancelled: 0,
      flagged: 0,
      orderRuns: 0,
    });
    yield* orders.upsertOrder({
      order: shopOrder,
      raw: "{}",
      lineItems,
      afterWrite: runs
        .reconcileOrder({ ...context, orderId: shopOrder.id })
        .pipe(Effect.flatMap((result) => Ref.set(counts, result))),
    });
    return yield* Ref.get(counts);
  });

const runsForOrder = () =>
  WorkflowRunRepository.pipe(
    Effect.flatMap((runs) => runs.listRunsForOrder({ orderId: ORDER_ID })),
  );

const complete = (
  detail: Domain.WorkflowRunDetail,
  position: number,
  teamIds: readonly string[],
) =>
  WorkflowRunRepository.pipe(
    Effect.flatMap((runs) =>
      runs.completeStep({
        runStepId: detail.steps[position - 1]?.id ?? "",
        memberId: memberId("member-1"),
        teamIds,
      }),
    ),
  );

/**
 * The order-workflow fixture: `Necklace` (tag `necklace`, Cut by A then
 * Finish by B) and the order workflow `Pack` (QC then Pack, both Team C).
 * Orders carry two tagged items and one untagged.
 */
const seedOrderWorkflow = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const necklace = yield* workflows.createWorkflow({
    name: name("Necklace"),
    tags: tags(["necklace"]),
  });
  yield* workflows.addStep({
    workflowId: necklace.id,
    name: stepName("Cut"),
    teamId: TEAM_A.id,
  });
  yield* workflows.addStep({
    workflowId: necklace.id,
    name: stepName("Finish"),
    teamId: TEAM_B.id,
  });
  const pack = yield* workflows.createWorkflow({
    name: name("Pack"),
    scope: "order",
    tags: tags([]),
  });
  yield* workflows.addStep({
    workflowId: pack.id,
    name: stepName("QC"),
    teamId: TEAM_C.id,
  });
  yield* workflows.addStep({
    workflowId: pack.id,
    name: stepName("Pack"),
    teamId: TEAM_C.id,
  });
  return { necklace, pack };
});

const ORDER_ITEMS = [
  lineItem(1, ["necklace"]),
  lineItem(2, ["necklace"]),
  lineItem(3, []),
];

const itemRuns = () =>
  runsForOrder().pipe(
    Effect.map((runs) => runs.filter(({ run }) => !Domain.isOrderRun(run))),
  );

const orderRuns = () =>
  runsForOrder().pipe(
    Effect.map((runs) => runs.filter(({ run }) => Domain.isOrderRun(run))),
  );

/** Finishes both steps of every item run, passing the routing context so the last completion can start the order run. */
const finishItemRuns = () =>
  Effect.gen(function* () {
    const runs = yield* WorkflowRunRepository;
    const routing = yield* routingContext();
    const open = (yield* itemRuns()).filter(
      (detail) =>
        detail.run.status !== "cancelled" && detail.run.status !== "done",
    );
    for (const detail of open)
      for (const [index, team] of [TEAM_A, TEAM_B].entries())
        yield* runs.completeStep({
          runStepId: detail.steps[index]?.id ?? "",
          memberId: memberId("member-1"),
          teamIds: [team.id],
          routing,
        });
  });

const routingContext = () => routing;

describe("WorkflowRunRepository order runs", () => {
  it("starts one pending order run with copied steps once every item run is done; never twice", () =>
    runInRepository(
      Effect.gen(function* () {
        const { pack } = yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        const counts = yield* upsertAndReconcile(order(), ORDER_ITEMS);
        deepStrictEqual(counts, {
          created: 2,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        strictEqual((yield* orderRuns()).length, 0);
        yield* finishItemRuns();
        const [orderRun] = yield* orderRuns();
        if (orderRun === undefined) throw new Error("no order run");
        strictEqual(orderRun.run.workflowId, pack.id);
        strictEqual(orderRun.run.status, "pending");
        strictEqual(orderRun.run.lineItemId, null);
        strictEqual(orderRun.run.quantity, null);
        strictEqual(orderRun.run.customAttributes, null);
        strictEqual(orderRun.run.orderName, "#1001");
        deepStrictEqual(
          orderRun.steps.map((s) => [s.stage, s.name, s.teamName]),
          [
            [1, "QC", "Team C"],
            [2, "Pack", "Team C"],
          ],
        );
        // Order runs come last in the order listing.
        const all = yield* runsForOrder();
        strictEqual(all.at(-1)?.run.id, orderRun.run.id);

        // A later reconcile (same order, nothing changed) does not start a second.
        const again = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          ORDER_ITEMS,
        );
        strictEqual(again.orderRuns, 0);
        strictEqual((yield* orderRuns()).length, 1);

        // Cancelling the order run does not re-trigger either; un-cancel is the way back.
        yield* runs.cancelRun({
          runId: orderRun.run.id,
          routing: yield* routingContext(),
        });
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          ORDER_ITEMS,
        );
        strictEqual((yield* orderRuns()).length, 1);
        strictEqual((yield* orderRuns())[0]?.run.status, "cancelled");
      }),
    ));

  it("one done plus one cancelled triggers; all cancelled, untagged-only, and reconcile-only paths do not", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        const [first, second] = yield* itemRuns();
        if (first === undefined || second === undefined)
          throw new Error("expected two item runs");
        const routing = yield* routingContext();
        // Cancel one while the other is still open: nothing yet.
        yield* runs.cancelRun({ runId: first.run.id, routing });
        strictEqual((yield* orderRuns()).length, 0);
        // Finish the other: done + cancelled → trigger.
        for (const [index, team] of [TEAM_A, TEAM_B].entries())
          yield* runs.completeStep({
            runStepId: second.steps[index]?.id ?? "",
            memberId: memberId("member-1"),
            teamIds: [team.id],
            routing,
          });
        strictEqual((yield* orderRuns()).length, 1);
      }),
    ));

  it("cancel of the last open item run triggers when another is done; all cancelled never triggers", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        const [first, second] = yield* itemRuns();
        if (first === undefined || second === undefined)
          throw new Error("expected two item runs");
        const routing = yield* routingContext();
        for (const [index, team] of [TEAM_A, TEAM_B].entries())
          yield* runs.completeStep({
            runStepId: first.steps[index]?.id ?? "",
            memberId: memberId("member-1"),
            teamIds: [team.id],
            routing,
          });
        strictEqual((yield* orderRuns()).length, 0);
        yield* runs.cancelRun({ runId: second.run.id, routing });
        strictEqual((yield* orderRuns()).length, 1);
      }),
    ));

  it("never triggers for a stock-only order, an all-cancelled order, or without a routing context", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        // Stock-only: no item runs at all.
        yield* upsertAndReconcile(order(), [lineItem(3, [])]);
        strictEqual((yield* runsForOrder()).length, 0);

        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          ORDER_ITEMS,
        );
        const routing = yield* routingContext();
        for (const detail of yield* itemRuns())
          yield* runs.cancelRun({ runId: detail.run.id, routing });
        strictEqual((yield* orderRuns()).length, 0);
        // Reconcile after all-cancelled: still nothing (no item run done).
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          ORDER_ITEMS,
        );
        strictEqual((yield* orderRuns()).length, 0);

        // Without routing, completion never evaluates the trigger; the next reconcile does.
        for (const detail of yield* itemRuns())
          yield* runs.uncancelRun({ runId: detail.run.id });
        for (const detail of yield* itemRuns())
          for (const [index, team] of [TEAM_A, TEAM_B].entries())
            yield* runs.completeStep({
              runStepId: detail.steps[index]?.id ?? "",
              memberId: memberId("member-1"),
              teamIds: [team.id],
            });
        strictEqual((yield* orderRuns()).length, 0);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 3 }),
          ORDER_ITEMS,
        );
        strictEqual(counts.orderRuns, 1);
        strictEqual((yield* orderRuns()).length, 1);
      }),
    ));

  it("does not start when the order workflow is archived, not routable, or newer than the order", () =>
    runInRepository(
      Effect.gen(function* () {
        const { pack } = yield* seedOrderWorkflow;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        yield* workflows.setWorkflowArchived({
          workflowId: pack.id,
          archived: true,
        });
        yield* finishItemRuns();
        strictEqual((yield* orderRuns()).length, 0);
        yield* workflows.setWorkflowArchived({
          workflowId: pack.id,
          archived: false,
        });
        // Team C inactive: not routable.
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          ORDER_ITEMS,
          [TEAM_A, TEAM_B],
        );
        strictEqual((yield* orderRuns()).length, 0);
        // Routable again: reconcile starts it.
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          ORDER_ITEMS,
        );
        strictEqual(counts.orderRuns, 1);
      }),
    ));

  it("age rule: an order older than the order workflow gets no order run from tag routing, but a manual attach opts it in", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        const sql = yield* SqlClient.SqlClient;
        const old = order({ processedAt: Date.now() - 60 * 60 * 1000 });
        yield* upsertAndReconcile(old, ORDER_ITEMS);
        // Tag routing skips old orders too, so plant a tag-sourced done run to
        // isolate the order-level age rule from the item-level one.
        yield* upsertAndReconcile(
          order({ updatedAt: old.updatedAt + 1 }),
          ORDER_ITEMS,
        );
        yield* sql`update ShopOrder set processedAt = ${old.processedAt} where id = ${ORDER_ID}`;
        yield* finishItemRuns();
        strictEqual((yield* orderRuns()).length, 0);

        // A manual attach on the same order is the opt-in.
        const { workflows } = yield* routingContext();
        const necklace = workflows.find((w) => w.workflow.scope === "item");
        if (necklace === undefined) throw new Error("no item workflow");
        const manual = Option.getOrThrow(
          yield* runs.createRun({
            workflow: necklace,
            activeTeams: ACTIVE_TEAMS,
            order: old,
            lineItem: lineItem(3, []),
            source: "manual",
          }),
        );
        strictEqual(manual.source, "manual");
        yield* finishItemRuns();
        const [orderRun] = yield* orderRuns();
        strictEqual(orderRun?.run.status, "pending");
      }),
    ));

  it("flags an open order run item_added on a new item, attach, or un-cancel; leaves a done one alone", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        yield* finishItemRuns();
        const [orderRun] = yield* orderRuns();
        if (orderRun === undefined) throw new Error("no order run");
        strictEqual(orderRun.run.status, "pending");

        // A new tagged item arrives: pending order run is flagged.
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [...ORDER_ITEMS, lineItem(4, ["necklace"], { title: "Gift box" })],
        );
        deepStrictEqual(counts, {
          created: 1,
          cancelled: 0,
          flagged: 1,
          orderRuns: 0,
        });
        const flagged = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(flagged.run.flag, "item_added");
        deepStrictEqual(flagged.run.flagDetail, { item: "Gift box" });

        yield* runs.dismissFlag({
          runId: orderRun.run.id,
          teamIds: [TEAM_C.id],
        });
        // Start the order run so it is active; manual attach of the untagged item flags it.
        yield* runs.startStep({
          runStepId: orderRun.steps[0]?.id ?? "",
          memberId: memberId("member-1"),
          teamIds: [TEAM_C.id],
        });
        const { workflows } = yield* routingContext();
        const necklace = workflows.find((w) => w.workflow.scope === "item");
        if (necklace === undefined) throw new Error("no item workflow");
        const attached = Option.getOrThrow(
          yield* runs.createRun({
            workflow: necklace,
            activeTeams: ACTIVE_TEAMS,
            order: order(),
            lineItem: lineItem(3, []),
            source: "manual",
          }),
        );
        const afterAttach = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(afterAttach.run.status, "active");
        strictEqual(afterAttach.run.flag, "item_added");
        strictEqual(afterAttach.run.flagDetail?.item, "Item 3");

        // Cancel that pending item run (no flag), then un-cancel it (flag again).
        yield* runs.dismissFlag({
          runId: orderRun.run.id,
          teamIds: [TEAM_C.id],
        });
        yield* runs.cancelRun({ runId: attached.id });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: orderRun.run.id })).run
            .flag,
          null,
        );
        yield* runs.uncancelRun({ runId: attached.id });
        const afterUncancel = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(afterUncancel.run.flag, "item_added");
        strictEqual(afterUncancel.run.flagDetail?.item, "Item 3");
        // Finish the late item so the order run can be completed below without it lingering.
        const lateDetail = Option.getOrThrow(
          yield* runs.getRun({ runId: attached.id }),
        );
        for (const [index, team] of [TEAM_A, TEAM_B].entries())
          yield* runs.completeStep({
            runStepId: lateDetail.steps[index]?.id ?? "",
            memberId: memberId("member-1"),
            teamIds: [team.id],
          });

        // Finish the order run; a further new item leaves it untouched.
        yield* runs.dismissFlag({
          runId: orderRun.run.id,
          teamIds: [TEAM_C.id],
        });
        for (const step of orderRun.steps)
          yield* runs.completeStep({
            runStepId: step.id,
            memberId: memberId("member-1"),
            teamIds: [TEAM_C.id],
          });
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 2 }), [
          ...ORDER_ITEMS,
          lineItem(4, ["necklace"], { title: "Gift box" }),
          lineItem(5, ["necklace"], { title: "Late" }),
        ]);
        const done = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(done.run.status, "done");
        strictEqual(done.run.flag, null);
      }),
    ));

  it("item removed after the order run flags both runs; order cancel cancels pending and flags active", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        // Leave item 2 started (active) so removal flags rather than cancels it;
        // finish item 1 and cancel item 2 later would end the order. Instead:
        // finish both, start the order run, then remove item 1.
        yield* finishItemRuns();
        const [orderRun] = yield* orderRuns();
        if (orderRun === undefined) throw new Error("no order run");
        const removed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [
            lineItem(1, ["necklace"], {
              currentQuantity: 0,
              unfulfilledQuantity: 0,
            }),
            ...ORDER_ITEMS.slice(1),
          ],
        );
        // Item 1's run is done, so it is not adjusted; only the order run is flagged.
        deepStrictEqual(removed, {
          created: 0,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        const untouched = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(untouched.run.flag, null);

        // An *active* item run removed in the same pass does flag the order run.
        const { workflows } = yield* routingContext();
        const necklace = workflows.find((w) => w.workflow.scope === "item");
        if (necklace === undefined) throw new Error("no item workflow");
        const late = Option.getOrThrow(
          yield* runs.createRun({
            workflow: necklace,
            activeTeams: ACTIVE_TEAMS,
            order: order(),
            lineItem: lineItem(3, []),
            source: "manual",
          }),
        );
        const lateDetail = Option.getOrThrow(
          yield* runs.getRun({ runId: late.id }),
        );
        yield* runs.startStep({
          runStepId: lateDetail.steps[0]?.id ?? "",
          memberId: memberId("member-1"),
          teamIds: [TEAM_A.id],
        });
        const gone = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [
            ORDER_ITEMS[0] ?? lineItem(1, []),
            ORDER_ITEMS[1] ?? lineItem(2, []),
          ],
        );
        deepStrictEqual(gone, {
          created: 0,
          cancelled: 0,
          flagged: 2,
          orderRuns: 0,
        });
        const both = yield* runsForOrder();
        strictEqual(
          both.find((d) => d.run.id === late.id)?.run.flag,
          "item_removed",
        );
        const flaggedOrder = both.find((d) => d.run.id === orderRun.run.id);
        strictEqual(flaggedOrder?.run.flag, "item_removed");
        deepStrictEqual(flaggedOrder?.run.flagDetail, { item: "Item 3" });

        // Order cancelled: pending order run is cancelled.
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 3, cancelledAt: PROCESSED_AT + 3 }),
          ORDER_ITEMS,
        );
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: orderRun.run.id })).run
            .status,
          "cancelled",
        );
      }),
    ));

  it("order cancel flags an active order run order_cancelled", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        yield* finishItemRuns();
        const [orderRun] = yield* orderRuns();
        if (orderRun === undefined) throw new Error("no order run");
        yield* runs.startStep({
          runStepId: orderRun.steps[0]?.id ?? "",
          memberId: memberId("member-1"),
          teamIds: [TEAM_C.id],
        });
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1, cancelledAt: PROCESSED_AT + 1 }),
          ORDER_ITEMS,
        );
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: orderRun.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "order_cancelled");
      }),
    ));

  it("listQueue returns the order run with live items and statuses; item runs carry no items", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), ORDER_ITEMS);
        const [teamAItem] = yield* runs.listQueue({ teamIds: [TEAM_A.id] });
        deepStrictEqual(teamAItem?.items, []);
        yield* finishItemRuns();
        const [packing] = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
        if (packing === undefined) throw new Error("no packing item");
        strictEqual(Domain.isOrderRun(packing.run), true);
        strictEqual(packing.steps[0]?.name, "QC");
        strictEqual(packing.stageCount, 2);
        strictEqual(packing.note, "Gift wrap please");
        deepStrictEqual(
          packing.items.map((item) => [
            item.title,
            item.quantity,
            item.runStatus,
          ]),
          [
            ["Item 1", 2, "done"],
            ["Item 2", 2, "done"],
            ["Item 3", 2, null],
          ],
        );
        deepStrictEqual(packing.items[0]?.customAttributes, [
          { key: "Engraving", value: "Hello 1" },
        ]);
        // A late item arriving shows immediately with its own status.
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          ...ORDER_ITEMS,
          lineItem(4, ["necklace"], { title: "Late" }),
        ]);
        const [again] = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
        deepStrictEqual(
          again?.items.map((item) => [item.title, item.runStatus]),
          [
            ["Item 1", "done"],
            ["Item 2", "done"],
            ["Item 3", null],
            ["Late", "pending"],
          ],
        );
        strictEqual(again?.run.flag, "item_added");
      }),
    ));

  it("item-run reconcile behaviour is unchanged with the order workflow present", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedOrderWorkflow;
        const runs = yield* WorkflowRunRepository;
        const counts = yield* upsertAndReconcile(order(), ORDER_ITEMS);
        deepStrictEqual(counts, {
          created: 2,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        const [first, second] = yield* itemRuns();
        if (first === undefined || second === undefined)
          throw new Error("expected two item runs");
        yield* runs.startStep({
          runStepId: second.steps[0]?.id ?? "",
          memberId: memberId("member-1"),
          teamIds: [TEAM_A.id],
        });
        const zeroed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [
            lineItem(1, ["necklace"], {
              currentQuantity: 0,
              unfulfilledQuantity: 0,
            }),
            lineItem(2, ["necklace"], {
              currentQuantity: 1,
              unfulfilledQuantity: 1,
            }),
            lineItem(3, []),
          ],
        );
        deepStrictEqual(zeroed, {
          created: 0,
          cancelled: 1,
          flagged: 1,
          orderRuns: 0,
        });
        const after = yield* itemRuns();
        strictEqual(
          after.find((d) => d.run.id === first.run.id)?.run.status,
          "cancelled",
        );
        const changed = after.find((d) => d.run.id === second.run.id);
        strictEqual(changed?.run.flag, "quantity_changed");
        strictEqual(changed?.run.quantity, 1);
        strictEqual((yield* orderRuns()).length, 0);
      }),
    ));
});

describe("WorkflowRunRepository.reconcileOrder", () => {
  it("creates one run per matching workflow with copied steps and team names", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["A"]),
          lineItem(2, ["b", "other"]),
        ]);
        deepStrictEqual(counts, {
          created: 2,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 2);
        const [first] = runs;
        strictEqual(first?.run.source, "tag");
        strictEqual(first?.run.status, "pending");
        strictEqual(first?.run.quantity, 2);
        strictEqual(first?.run.customAttributes?.[0]?.value, "Hello 1");
        deepStrictEqual(
          first?.steps.map((s) => [s.position, s.name, s.teamName]),
          [
            [1, "Cut", "Team A"],
            [2, "Finish", "Team B"],
          ],
        );
      }),
    ));

  it("is idempotent, keeps a cancelled run cancelled, and un-cancel recomputes status", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"]), lineItem(2, ["b"])];
        yield* upsertAndReconcile(order(), items);
        const again = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        deepStrictEqual(again, {
          created: 0,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        strictEqual((yield* runsForOrder()).length, 2);

        const [target] = yield* runsForOrder();
        if (target === undefined) throw new Error("no run");
        yield* complete(target, 1, [TEAM_A.id]);
        yield* runs.cancelRun({ runId: target.run.id });
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          items,
        );
        const afterCancel = Option.getOrThrow(
          yield* runs.getRun({ runId: target.run.id }),
        );
        strictEqual(afterCancel.run.status, "cancelled");
        strictEqual((yield* runsForOrder()).length, 2);

        yield* runs.uncancelRun({ runId: target.run.id });
        const restored = Option.getOrThrow(
          yield* runs.getRun({ runId: target.run.id }),
        );
        strictEqual(restored.run.status, "active");
        strictEqual(restored.run.cancelledAt, null);
        const notCancelled = yield* runs
          .uncancelRun({ runId: target.run.id })
          .pipe(Effect.flip);
        strictEqual(notCancelled._tag, "RunTerminalError");
      }),
    ));

  it("waits for payment, then routes identically from any source", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const items = [lineItem(1, ["a"])];
        const unpaid = yield* upsertAndReconcile(
          order({ fullyPaid: false, financialStatus: "PENDING" }),
          items,
        );
        strictEqual(unpaid.created, 0);
        strictEqual((yield* runsForOrder()).length, 0);
        const paid = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1, syncSource: "bulk" }),
          items,
        );
        strictEqual(paid.created, 1);
        const manual = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2, syncSource: "manual" }),
          items,
        );
        strictEqual(manual.created, 0);
        strictEqual((yield* runsForOrder()).length, 1);
      }),
    ));

  it("skips orders processed before the workflow existed; manual attach still works", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const workflows = yield* WorkflowRepository;
        const old = order({ processedAt: a.createdAt - 1 });
        const items = [lineItem(1, ["a"])];
        const counts = yield* upsertAndReconcile(old, items);
        strictEqual(counts.created, 0);
        const detail = Option.getOrThrow(
          yield* workflows.getWorkflow({ workflowId: a.id }),
        );
        const attached = yield* runs.createRun({
          workflow: detail,
          activeTeams: ACTIVE_TEAMS,
          order: old,
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isSome(attached), true);
        strictEqual(Option.getOrThrow(attached).source, "manual");
        const duplicate = yield* runs.createRun({
          workflow: detail,
          activeTeams: ACTIVE_TEAMS,
          order: old,
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isNone(duplicate), true);
      }),
    ));

  it("skips fully fulfilled line items", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"], { unfulfilledQuantity: 0 }),
        ]);
        strictEqual(counts.created, 0);
      }),
    ));

  it("cancels a pending run and flags an active one when the line item goes to zero or disappears", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const items = [lineItem(1, ["a"]), lineItem(2, ["b"])];
        yield* upsertAndReconcile(order(), items);
        const [pendingRun, activeRun] = yield* runsForOrder();
        if (pendingRun === undefined || activeRun === undefined)
          throw new Error("expected two runs");
        yield* complete(activeRun, 1, [TEAM_A.id]);

        const zeroed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [
            lineItem(1, ["a"], { currentQuantity: 0, unfulfilledQuantity: 0 }),
            lineItem(2, ["b"], { currentQuantity: 0, unfulfilledQuantity: 0 }),
          ],
        );
        deepStrictEqual(zeroed, {
          created: 0,
          cancelled: 1,
          flagged: 1,
          orderRuns: 0,
        });
        const after = yield* runsForOrder();
        const p = after.find((d) => d.run.id === pendingRun.run.id);
        const a = after.find((d) => d.run.id === activeRun.run.id);
        strictEqual(p?.run.status, "cancelled");
        strictEqual(a?.run.status, "active");
        strictEqual(a?.run.flag, "item_removed");
        strictEqual(a?.steps.length, 2);
        strictEqual(a?.steps[0]?.completedAt !== null, true);

        const removed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [],
        );
        deepStrictEqual(removed, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          orderRuns: 0,
        });
        const gone = yield* runsForOrder();
        strictEqual(gone.length, 2);
        strictEqual(
          gone.find((d) => d.run.id === activeRun.run.id)?.run
            .customAttributes?.[0]?.value,
          "Hello 2",
        );
      }),
    ));

  it("updates quantity silently on a pending run and flags an active one", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [pendingRun, activeRun] = yield* runsForOrder();
        if (pendingRun === undefined || activeRun === undefined)
          throw new Error("expected two runs");
        yield* complete(activeRun, 1, [TEAM_A.id]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [
            lineItem(1, ["a"], { currentQuantity: 3, unfulfilledQuantity: 3 }),
            lineItem(2, ["b"], { currentQuantity: 3, unfulfilledQuantity: 3 }),
          ],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          orderRuns: 0,
        });
        const after = yield* runsForOrder();
        const p = after.find((d) => d.run.id === pendingRun.run.id);
        const a = after.find((d) => d.run.id === activeRun.run.id);
        strictEqual(p?.run.quantity, 3);
        strictEqual(p?.run.flag, null);
        strictEqual(a?.run.quantity, 3);
        strictEqual(a?.run.flag, "quantity_changed");
        deepStrictEqual(a?.run.flagDetail, { from: 2, to: 3 });
      }),
    ));

  it("creates a run only for a line item added on a later upsert", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["b"])],
        );
        deepStrictEqual(counts, {
          created: 1,
          cancelled: 0,
          flagged: 0,
          orderRuns: 0,
        });
        strictEqual((yield* runsForOrder()).length, 2);
      }),
    ));

  describe("eligibility split", () => {
    it("unpaid after an edit keeps open runs, creates nothing, then routes the new line once paid", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [pendingRun, activeRun] = yield* runsForOrder();
          if (pendingRun === undefined || activeRun === undefined)
            throw new Error("expected two runs");
          yield* complete(activeRun, 1, [TEAM_A.id]);
          const threeLines = [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
            lineItem(3, ["a"]),
          ];
          const unpaid = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fullyPaid: false,
              financialStatus: "PENDING",
            }),
            threeLines,
          );
          deepStrictEqual(unpaid, {
            created: 0,
            cancelled: 0,
            flagged: 0,
            orderRuns: 0,
          });
          const during = yield* runsForOrder();
          strictEqual(during.length, 2);
          strictEqual(
            during.find((d) => d.run.id === pendingRun.run.id)?.run.status,
            "pending",
          );
          const active = during.find((d) => d.run.id === activeRun.run.id);
          strictEqual(active?.run.status, "active");
          strictEqual(active?.run.flag, null);
          const paid = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 2 }),
            threeLines,
          );
          strictEqual(paid.created, 1);
          strictEqual((yield* runsForOrder()).length, 3);
        }),
      ));

    it("unpaid after an edit still cancels a pending run and flags an active one for a zeroed line", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [pendingRun, activeRun] = yield* runsForOrder();
          if (pendingRun === undefined || activeRun === undefined)
            throw new Error("expected two runs");
          yield* complete(activeRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fullyPaid: false,
              financialStatus: "PARTIALLY_REFUNDED",
            }),
            [
              lineItem(1, ["a"], {
                currentQuantity: 0,
                unfulfilledQuantity: 0,
              }),
              lineItem(2, ["b"], {
                currentQuantity: 0,
                unfulfilledQuantity: 0,
              }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 1,
            flagged: 1,
            orderRuns: 0,
          });
          const after = yield* runsForOrder();
          strictEqual(
            after.find((d) => d.run.id === pendingRun.run.id)?.run.status,
            "cancelled",
          );
          strictEqual(
            after.find((d) => d.run.id === activeRun.run.id)?.run.flag,
            "item_removed",
          );
        }),
      ));

    it("a paid re-read after going unpaid flags an open order run item_added for the late line", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seedOrderWorkflow;
          yield* upsertAndReconcile(order(), ORDER_ITEMS);
          yield* finishItemRuns();
          const [orderRun] = yield* orderRuns();
          if (orderRun === undefined) throw new Error("no order run");
          const withLate = [...ORDER_ITEMS, lineItem(4, ["necklace"])];
          const unpaid = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fullyPaid: false,
              financialStatus: "PENDING",
            }),
            withLate,
          );
          strictEqual(unpaid.created, 0);
          strictEqual((yield* orderRuns())[0]?.run.flag, null);
          const paid = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 2 }),
            withLate,
          );
          strictEqual(paid.created, 1);
          const flagged = (yield* orderRuns())[0];
          strictEqual(flagged?.run.flag, "item_added");
          deepStrictEqual(flagged?.run.flagDetail, { item: "Item 4" });
        }),
      ));
  });

  describe("units to make", () => {
    it("a refund that lowers unfulfilledQuantity alone updates pending silently and flags active", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [pendingRun, activeRun] = yield* runsForOrder();
          if (pendingRun === undefined || activeRun === undefined)
            throw new Error("expected two runs");
          strictEqual(pendingRun.run.quantity, 2);
          yield* complete(activeRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [
              lineItem(1, ["a"], {
                unfulfilledQuantity: 1,
                nonFulfillableQuantity: 1,
              }),
              lineItem(2, ["b"], {
                unfulfilledQuantity: 1,
                nonFulfillableQuantity: 1,
              }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 0,
            flagged: 1,
            orderRuns: 0,
          });
          const after = yield* runsForOrder();
          const p = after.find((d) => d.run.id === pendingRun.run.id);
          const a = after.find((d) => d.run.id === activeRun.run.id);
          strictEqual(p?.run.quantity, 1);
          strictEqual(p?.run.flag, null);
          strictEqual(a?.run.quantity, 1);
          strictEqual(a?.run.flag, "quantity_changed");
          deepStrictEqual(a?.run.flagDetail, { from: 2, to: 1 });
        }),
      ));

    it("a full refund with currentQuantity intact cancels pending and flags active item_removed", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [pendingRun, activeRun] = yield* runsForOrder();
          if (pendingRun === undefined || activeRun === undefined)
            throw new Error("expected two runs");
          yield* complete(activeRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [
              lineItem(1, ["a"], {
                unfulfilledQuantity: 0,
                nonFulfillableQuantity: 2,
              }),
              lineItem(2, ["b"], {
                unfulfilledQuantity: 0,
                nonFulfillableQuantity: 2,
              }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 1,
            flagged: 1,
            orderRuns: 0,
          });
          const after = yield* runsForOrder();
          strictEqual(
            after.find((d) => d.run.id === pendingRun.run.id)?.run.status,
            "cancelled",
          );
          strictEqual(
            after.find((d) => d.run.id === activeRun.run.id)?.run.flag,
            "item_removed",
          );
        }),
      ));

    it("inserts snapshot unfulfilledQuantity, and the order run's items omit a fully refunded line", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seedOrderWorkflow;
          const runs = yield* WorkflowRunRepository;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["necklace"], {
              currentQuantity: 3,
              unfulfilledQuantity: 2,
              nonFulfillableQuantity: 1,
            }),
            lineItem(2, ["necklace"]),
            lineItem(3, []),
          ]);
          const [first] = yield* itemRuns();
          strictEqual(first?.run.quantity, 2);
          yield* finishItemRuns();
          yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
            lineItem(1, ["necklace"], {
              currentQuantity: 3,
              unfulfilledQuantity: 2,
              nonFulfillableQuantity: 1,
            }),
            lineItem(2, ["necklace"]),
            lineItem(3, [], {
              unfulfilledQuantity: 0,
              nonFulfillableQuantity: 2,
            }),
          ]);
          const [packing] = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
          deepStrictEqual(
            packing?.items.map((item) => [item.title, item.quantity]),
            [
              ["Item 1", 2],
              ["Item 2", 2],
            ],
          );
        }),
      ));
  });

  describe("fulfilled before done", () => {
    it("FULFILLED cancels pending item runs, flags active item and open order runs, creates nothing", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seedOrderWorkflow;
          const runs = yield* WorkflowRunRepository;
          const { workflows } = yield* routingContext();
          const necklace = workflows.find((w) => w.workflow.scope === "item");
          if (necklace === undefined) throw new Error("no item workflow");
          yield* upsertAndReconcile(order(), ORDER_ITEMS);
          yield* finishItemRuns();
          const [orderRun] = yield* orderRuns();
          if (orderRun === undefined) throw new Error("no order run");
          yield* runs.startStep({
            runStepId: orderRun.steps[0]?.id ?? "",
            memberId: memberId("member-1"),
            teamIds: [TEAM_C.id],
          });
          // A pending and an active item run alongside the two done ones.
          const pendingRun = Option.getOrThrow(
            yield* runs.createRun({
              workflow: necklace,
              activeTeams: ACTIVE_TEAMS,
              order: order(),
              lineItem: lineItem(3, []),
              source: "manual",
            }),
          );
          const late = lineItem(4, ["necklace"]);
          yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
            ...ORDER_ITEMS,
            late,
          ]);
          const activeRun = (yield* itemRuns()).find(
            (d) => d.run.lineItemId === late.id,
          );
          if (activeRun === undefined) throw new Error("no late run");
          yield* runs.startStep({
            runStepId: activeRun.steps[0]?.id ?? "",
            memberId: memberId("member-1"),
            teamIds: [TEAM_A.id],
          });
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 2,
              fulfillmentStatus: "FULFILLED",
            }),
            [
              ...ORDER_ITEMS.map((item) =>
                lineItem(Number(item.id.split("/").at(-1)), item.productTags, {
                  unfulfilledQuantity: 0,
                }),
              ),
              lineItem(4, ["necklace"], { unfulfilledQuantity: 0 }),
              lineItem(5, ["necklace"]),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 1,
            flagged: 2,
            orderRuns: 0,
          });
          const after = yield* runsForOrder();
          strictEqual(
            after.find((d) => d.run.id === pendingRun.id)?.run.status,
            "cancelled",
          );
          strictEqual(
            after.find((d) => d.run.id === activeRun.run.id)?.run.flag,
            "order_fulfilled",
          );
          strictEqual(
            after.find((d) => d.run.id === orderRun.run.id)?.run.flag,
            "order_fulfilled",
          );
          for (const done of after.filter((d) => d.run.status === "done"))
            strictEqual(done.run.flag, null);
          strictEqual(after.length, 5);
        }),
      ));

    it("PARTIALLY_FULFILLED touches only the shipped line, via item_removed", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [shippedRun, otherRun] = yield* runsForOrder();
          if (shippedRun === undefined || otherRun === undefined)
            throw new Error("expected two runs");
          yield* complete(shippedRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fulfillmentStatus: "PARTIALLY_FULFILLED",
            }),
            [
              lineItem(1, ["a"], { unfulfilledQuantity: 0 }),
              lineItem(2, ["b"]),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 0,
            flagged: 1,
            orderRuns: 0,
          });
          const after = yield* runsForOrder();
          strictEqual(
            after.find((d) => d.run.id === shippedRun.run.id)?.run.flag,
            "item_removed",
          );
          const other = after.find((d) => d.run.id === otherRun.run.id);
          strictEqual(other?.run.status, "pending");
          strictEqual(other?.run.flag, null);
        }),
      ));
  });

  it("on order cancel: pending cancelled, active flagged, done untouched", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["a"]),
        ]);
        const before = yield* runsForOrder();
        const [pendingRun, activeRun, doneRun] = before;
        if (
          pendingRun === undefined ||
          activeRun === undefined ||
          doneRun === undefined
        )
          throw new Error("expected three runs");
        yield* complete(activeRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 2, [TEAM_B.id]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1, cancelledAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["b"]), lineItem(3, ["a"])],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 1,
          flagged: 1,
          orderRuns: 0,
        });
        const after = yield* runsForOrder();
        strictEqual(
          after.find((d) => d.run.id === pendingRun.run.id)?.run.status,
          "cancelled",
        );
        strictEqual(
          after.find((d) => d.run.id === activeRun.run.id)?.run.flag,
          "order_cancelled",
        );
        const done = after.find((d) => d.run.id === doneRun.run.id);
        strictEqual(done?.run.status, "done");
        strictEqual(done?.run.flag, null);
      }),
    ));

  it("routes nothing for an archived workflow, zero steps, or an inactive team", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const workflows = yield* WorkflowRepository;
        yield* workflows.setWorkflowArchived({
          workflowId: a.id,
          archived: true,
        });
        const c = yield* workflows.createWorkflow({
          name: name("Empty"),
          tags: tags(["c"]),
        });
        const items = [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["c"]),
        ];
        const inactiveTeam = yield* upsertAndReconcile(order(), items, [
          TEAM_A,
        ]);
        strictEqual(inactiveTeam.created, 0);
        yield* workflows.setWorkflowArchived({
          workflowId: a.id,
          archived: false,
        });
        const restored = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        strictEqual(restored.created, 2);
        const all = yield* runsForOrder();
        deepStrictEqual(
          all.map((d) => d.run.workflowId).toSorted(),
          [a.id, b.id].toSorted(),
        );
        strictEqual(
          all.some((d) => d.run.workflowId === c.id),
          false,
        );
      }),
    ));
});

describe("WorkflowRunRepository steps, queue, flags, delete", () => {
  it("completeStep enforces team, order, and terminal state and records completedBy", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");

        const wrongTeam = yield* complete(detail, 1, [TEAM_B.id]).pipe(
          Effect.flip,
        );
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        const outOfOrder = yield* complete(detail, 2, [TEAM_B.id]).pipe(
          Effect.flip,
        );
        strictEqual(outOfOrder._tag, "StepNotReadyError");

        yield* complete(detail, 1, [TEAM_A.id]);
        const active = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(active.run.status, "active");
        strictEqual(active.steps[0]?.completedBy, "member-1");

        const repeat = yield* complete(detail, 1, [TEAM_A.id]).pipe(
          Effect.flip,
        );
        strictEqual(repeat._tag, "StepNotReadyError");

        yield* complete(detail, 2, [TEAM_B.id]);
        const done = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(done.run.status, "done");

        const terminal = yield* runs
          .cancelRun({ runId: detail.run.id })
          .pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
        const missing = yield* runs
          .cancelRun({ runId: "nope" })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "RunNotFoundError");
      }),
    ));

  it("completeStep on a cancelled run is Terminal", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* complete(detail, 1, [TEAM_A.id]).pipe(
          Effect.flip,
        );
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("listQueue shows only current steps for the given teams, flagged first, with the run's own personalization", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [first, second] = yield* runsForOrder();
        if (first === undefined || second === undefined)
          throw new Error("expected two runs");

        const teamAQueue = yield* runs.listQueue({ teamIds: [TEAM_A.id] });
        deepStrictEqual(
          teamAQueue.map((item) => [
            item.run.id,
            item.steps[0]?.name,
            item.note,
          ]),
          [
            [first.run.id, "Cut", "Gift wrap please"],
            [second.run.id, "Cut", "Gift wrap please"],
          ],
        );
        strictEqual(
          (first.run.lineItemId ?? "") < (second.run.lineItemId ?? ""),
          true,
        );
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_B.id] })).length,
          0,
        );
        strictEqual((yield* runs.listQueue({ teamIds: [] })).length, 0);

        yield* complete(second, 1, [TEAM_A.id]);
        const teamBQueue = yield* runs.listQueue({ teamIds: [TEAM_B.id] });
        deepStrictEqual(
          teamBQueue.map((item) => [item.run.id, item.steps[0]?.name]),
          [[second.run.id, "Finish"]],
        );

        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"]),
        ]);
        const flaggedFirst = yield* runs.listQueue({
          teamIds: [TEAM_A.id, TEAM_B.id],
        });
        deepStrictEqual(
          flaggedFirst.map((item) => [item.run.id, item.run.flag]),
          [
            [second.run.id, "item_removed"],
            [first.run.id, null],
          ],
        );
        strictEqual(
          flaggedFirst[0]?.run.customAttributes?.[0]?.value,
          "Hello 2",
        );

        const wrongTeam = yield* runs
          .dismissFlag({ runId: second.run.id, teamIds: [TEAM_A.id] })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        yield* runs.dismissFlag({ runId: second.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: second.run.id }),
        );
        strictEqual(cleared.run.flag, null);
        strictEqual(cleared.run.flagDetail, null);
      }),
    ));

  it("markOrderDeleted cancels pending, flags active, leaves done; runs survive deleteOrder", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        const orders = yield* OrderRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["a"]),
        ]);
        const [pendingRun, activeRun, doneRun] = yield* runsForOrder();
        if (
          pendingRun === undefined ||
          activeRun === undefined ||
          doneRun === undefined
        )
          throw new Error("expected three runs");
        yield* complete(activeRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 2, [TEAM_B.id]);

        yield* runs.markOrderDeleted({ orderId: ORDER_ID });
        yield* orders.deleteOrder(ORDER_ID);
        strictEqual(Option.isNone(yield* orders.getOrder(ORDER_ID)), true);

        const after = yield* runsForOrder();
        strictEqual(after.length, 3);
        strictEqual(
          after.find((d) => d.run.id === pendingRun.run.id)?.run.status,
          "cancelled",
        );
        strictEqual(
          after.find((d) => d.run.id === activeRun.run.id)?.run.flag,
          "order_deleted",
        );
        const done = after.find((d) => d.run.id === doneRun.run.id);
        strictEqual(done?.run.status, "done");
        strictEqual(done?.run.flag, null);

        const queue = yield* runs.listQueue({ teamIds: [TEAM_B.id] });
        deepStrictEqual(
          queue.map((item) => [item.run.id, item.note]),
          [[activeRun.run.id, null]],
        );
      }),
    ));

  it("copies stage and instructions onto run steps; ready rule gates completion across stages", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        deepStrictEqual(
          detail.steps.map((s) => [s.name, s.stage, s.instructions]),
          [
            ["Artwork", 1, "300 dpi"],
            ["Materials", 1, null],
            ["Produce", 2, null],
            ["Inspect", 3, null],
          ],
        );
        const notReady = yield* complete(detail, 3, [TEAM_C.id]).pipe(
          Effect.flip,
        );
        strictEqual(notReady._tag, "StepNotReadyError");
        yield* complete(detail, 2, [TEAM_B.id]);
        const stillNotReady = yield* complete(detail, 3, [TEAM_C.id]).pipe(
          Effect.flip,
        );
        strictEqual(stillNotReady._tag, "StepNotReadyError");
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        const done = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(done.run.status, "done");
      }),
    ));

  it("listQueue returns every ready step per run with stageCount and cross-team siblings", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();

        const teamA = yield* runs.listQueue({ teamIds: [TEAM_A.id] });
        strictEqual(teamA.length, 1);
        strictEqual(teamA[0]?.stageCount, 3);
        deepStrictEqual(
          teamA[0]?.steps.map((s) => [s.name, s.stage]),
          [["Artwork", 1]],
        );
        deepStrictEqual<unknown>(teamA[0]?.steps[0]?.siblings, [
          { name: "Materials", teamName: "Team B" },
        ]);

        const both = yield* runs.listQueue({ teamIds: [TEAM_A.id, TEAM_B.id] });
        strictEqual(both.length, 1);
        deepStrictEqual(
          both[0]?.steps.map((s) => s.name),
          ["Artwork", "Materials"],
        );
        deepStrictEqual(both[0]?.steps[0]?.siblings, []);

        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_C.id] })).length,
          0,
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_C.id] })).length,
          0,
        );
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamC = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
        deepStrictEqual(
          teamC[0]?.steps.map((s) => [s.name, s.stage]),
          [["Produce", 2]],
        );
      }),
    ));

  it("startStep marks the run active, never takes over, and respects readiness and team", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const produce = detail.steps[2]?.id ?? "";

        const wrongTeam = yield* runs
          .startStep({
            runStepId: artwork,
            memberId: memberId("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        const notReady = yield* runs
          .startStep({
            runStepId: produce,
            memberId: memberId("m3"),
            teamIds: [TEAM_C.id],
          })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "StepNotReadyError");

        yield* runs.startStep({
          runStepId: artwork,
          memberId: memberId("m1"),
          teamIds: [TEAM_A.id],
        });
        const started = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(started.run.status, "active");
        strictEqual(started.steps[0]?.startedBy, "m1");
        strictEqual(started.steps[0]?.startedAt !== null, true);
        strictEqual(started.steps[0]?.completedAt, null);

        yield* runs.startStep({
          runStepId: artwork,
          memberId: memberId("m2"),
          teamIds: [TEAM_A.id],
        });
        const again = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(again.steps[0]?.startedBy, "m1");

        // Done without Start backfills who started.
        yield* complete(detail, 2, [TEAM_B.id]);
        const materials = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).steps[1];
        strictEqual(materials?.startedBy, "member-1");
        strictEqual(materials?.completedBy, "member-1");
        strictEqual(materials?.startedAt, materials?.completedAt);
      }),
    ));

  it("setStepNote writes, overwrites, clears; allowed on a done step; refused on a cancelled run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const set = (value: Domain.StepNote | null, teamIds = [TEAM_A.id]) =>
          runs.setStepNote({
            runStepId: artwork,
            memberId: memberId("m1"),
            teamIds,
            note: value,
          });
        const stepNote = () =>
          Effect.map(
            runs.getRun({ runId: detail.run.id }),
            (run) => Option.getOrThrow(run).steps[0]?.note,
          );
        const wrongTeam = yield* set(note("x"), [TEAM_B.id]).pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        yield* set(note("first"));
        strictEqual(yield* stepNote(), "first");
        yield* set(note("second"));
        strictEqual(yield* stepNote(), "second");
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* set(note("after done"));
        strictEqual(yield* stepNote(), "after done");
        yield* set(null);
        strictEqual(yield* stepNote(), null);
        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* set(note("nope")).pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("blockRun sets the flag with reason and by; dismiss clears; a later reconcile flag overwrites", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const wrongTeam = yield* runs
          .blockRun({
            runId: detail.run.id,
            memberId: memberId("m3"),
            teamIds: [TEAM_C.id],
            reason: null,
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        yield* runs.blockRun({
          runId: detail.run.id,
          memberId: memberId("m1"),
          teamIds: [TEAM_A.id],
          reason: note("Out of chain"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(blocked.run.flag, "blocked");
        deepStrictEqual<unknown>(blocked.run.flagDetail, {
          reason: "Out of chain",
          by: "m1",
        });
        const queue = yield* runs.listQueue({ teamIds: [TEAM_B.id] });
        strictEqual(queue[0]?.run.flag, "blocked");

        yield* runs.dismissFlag({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(cleared.run.flag, null);

        yield* runs.blockRun({
          runId: detail.run.id,
          memberId: memberId("m1"),
          teamIds: [TEAM_A.id],
          reason: null,
        });
        deepStrictEqual<unknown>(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .flagDetail,
          { by: "m1" },
        );
        // Reconcile overwrites a person's block: a started run is active,
        // so the zeroed line item flags rather than cancels.
        yield* runs.startStep({
          runStepId: detail.steps[0]?.id ?? "",
          memberId: memberId("m1"),
          teamIds: [TEAM_A.id],
        });
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["s"], { currentQuantity: 0, unfulfilledQuantity: 0 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          orderRuns: 0,
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "item_removed");
      }),
    ));

  it("a started but uncompleted step protects the run from silent cancel on reconcile", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        yield* runs.startStep({
          runStepId: detail.steps[0]?.id ?? "",
          memberId: memberId("m1"),
          teamIds: [TEAM_A.id],
        });
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          orderRuns: 0,
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "item_removed");
      }),
    ));

  it("listWorkflows reports activeRunCount over pending and active runs only", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["a"]),
        ]);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        yield* runs.cancelRun({ runId: first.run.id });
        const summaries = yield* workflows.listWorkflows({
          includeArchived: false,
        });
        strictEqual(summaries.find((w) => w.id === a.id)?.activeRunCount, 1);
      }),
    ));
});
