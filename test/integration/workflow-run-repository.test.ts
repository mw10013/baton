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
  type StartContext,
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
const tags = Schema.decodeUnknownSync(Domain.WorkflowTags);
const teamId = Schema.decodeUnknownSync(Domain.TeamId);
const teamName = Schema.decodeUnknownSync(Domain.TeamName);
const memberId = Schema.decodeUnknownSync(Domain.MemberId);
const emailOf = Schema.decodeUnknownSync(Domain.Email);

const memberActor = (id: string, email = `${id}@example.com`) =>
  ({
    role: "member",
    memberId: memberId(id),
    email: emailOf(email),
  }) satisfies Domain.MemberActor;

const MERCHANT = { role: "merchant" } satisfies Domain.Actor;

const TEAM_A = { id: teamId("team-a"), name: teamName("Team A") };
const TEAM_B = { id: teamId("team-b"), name: teamName("Team B") };
const TEAM_C = { id: teamId("team-c"), name: teamName("Team C") };
const TEAMS = [TEAM_A, TEAM_B, TEAM_C];
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

/** Apply the draft and switch the workflow on: what the ordinary path needs before anything starts. Returns the workflow row. */
const goLive = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.applyDraft({ workflowId, teams: TEAMS });
    return yield* workflows.setWorkflowActive({
      workflowId,
      active: true,
      teams: TEAMS,
    });
  });

/** Turn off: new runs stop, open runs keep going. */
const turnOff = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.setWorkflowActive({
      workflowId,
      active: false,
      teams: TEAMS,
    });
  });

const turnOn = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.setWorkflowActive({
      workflowId,
      active: true,
      teams: TEAMS,
    });
  });

/** The workflow with its own steps as the start shape, for manual attach. */
const savedDetail = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const { workflow, steps } = Option.getOrThrow(
      yield* workflows.getWorkflow({ workflowId }),
    );
    return { workflow, steps } satisfies Domain.WorkflowDetail;
  });

/**
 * Two workflows, tags `a` and `b`, two steps each (Team A then Team B),
 * applied and on, and an order with one line item per tag. `updatedAt`
 * advances on every upsert so the guard never refuses a rewrite.
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
      return yield* goLive(created.id);
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

/** Starts the staged workflow on one line item and returns its run; `PROCESSED_AT` is ahead of the clock so the age rule passes. */
const stagedRun = () =>
  Effect.gen(function* () {
    yield* upsertAndReconcile(order(), [lineItem(1, ["s"])]);
    const [detail] = yield* runsForOrder();
    if (detail === undefined) throw new Error("no run");
    return detail;
  });

const loadStartContext = Effect.gen(function* () {
  const workflows =
    yield* (yield* WorkflowRepository).listActiveWorkflowDetails();
  return { workflows, teams: TEAMS } satisfies StartContext;
});

const upsertAndReconcile = (
  shopOrder: Domain.ShopOrder,
  lineItems: readonly Domain.OrderLineItem[],
  teams: StartContext["teams"] = TEAMS,
) =>
  Effect.gen(function* () {
    const runs = yield* WorkflowRunRepository;
    const orders = yield* OrderRepository;
    const context = { ...(yield* loadStartContext), teams };
    const counts = yield* Ref.make<ReconcileCounts>({
      created: 0,
      cancelled: 0,
      flagged: 0,
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
        actor: memberActor("member-1"),
        teamIds,
      }),
    ),
  );

describe("WorkflowRunRepository.countWaitingOrders", () => {
  it("counts open orders that would match if the date allowed, paid or not, with the earliest placed date; Include them starts the paid ones", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const workflows = yield* WorkflowRepository;
        const orders = yield* OrderRepository;
        const detail = yield* savedDetail(a.id);
        const old = Date.now() - 60 * 60 * 1000;
        const older = old - 1000;
        // Two old orders (one unpaid), one fulfilled, one stock-only.
        const seedOrder = (
          id: string,
          overrides: Partial<Domain.ShopOrder>,
          items: readonly Domain.OrderLineItem[],
        ) =>
          orders.upsertOrder({
            order: order({ id, legacyId: id, name: id, ...overrides }),
            raw: "{}",
            lineItems: items.map((item) => ({
              ...item,
              id: `${id}/${item.id}`,
              orderId: id,
            })),
            afterWrite: Effect.void,
          });
        yield* seedOrder("o1", { processedAt: old }, [lineItem(1, ["a"])]);
        yield* seedOrder("o2", { processedAt: older, fullyPaid: false }, [
          lineItem(1, ["a"]),
        ]);
        yield* seedOrder(
          "o3",
          { processedAt: older - 1, fulfillmentStatus: "FULFILLED" },
          [lineItem(1, ["a"])],
        );
        yield* seedOrder("o4", { processedAt: older - 2 }, [lineItem(1, [])]);
        deepStrictEqual(yield* runs.countWaitingOrders({ workflow: detail }), {
          count: 2,
          earliestProcessedAt: older,
        });
        // Include them: the date moves back to the earliest and reconcile-all
        // starts the paid, unfulfilled one; the unpaid one waits to pay.
        yield* workflows.setWorkflowActive({
          workflowId: a.id,
          active: true,
          activatedAt: older,
          teams: TEAMS,
        });
        deepStrictEqual(yield* runs.reconcileAll(yield* loadStartContext), {
          orders: 2,
          created: 1,
        });
        deepStrictEqual(yield* runs.countWaitingOrders({ workflow: detail }), {
          count: 1,
          earliestProcessedAt: older,
        });
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

  it("waits for payment, then starts runs identically from any source", () =>
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

  it("skips orders placed before the workflow was turned on; manual attach still works", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const old = order({ processedAt: (a.activatedAt ?? 0) - 1 });
        const items = [lineItem(1, ["a"])];
        const counts = yield* upsertAndReconcile(old, items);
        strictEqual(counts.created, 0);
        const detail = yield* savedDetail(a.id);
        const attached = yield* runs.createRun({
          workflow: detail,
          teams: TEAMS,
          order: old,
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isSome(attached), true);
        strictEqual(Option.getOrThrow(attached).source, "manual");
        const duplicate = yield* runs.createRun({
          workflow: detail,
          teams: TEAMS,
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
        });
        strictEqual((yield* runsForOrder()).length, 2);
      }),
    ));

  describe("eligibility split", () => {
    it("unpaid after an edit keeps open runs, creates nothing, then starts the new line once paid", () =>
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

    it("inserts snapshot unfulfilledQuantity, not the ordered quantity", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"], {
              currentQuantity: 3,
              unfulfilledQuantity: 2,
              nonFulfillableQuantity: 1,
            }),
          ]);
          const [first] = yield* runsForOrder();
          strictEqual(first?.run.quantity, 2);
        }),
      ));
  });

  describe("fulfilled before done", () => {
    it("FULFILLED cancels pending runs, flags active ones, leaves done alone, creates nothing", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          const runs = yield* WorkflowRunRepository;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [doneRun, activeRun] = yield* runsForOrder();
          if (doneRun === undefined || activeRun === undefined)
            throw new Error("expected two runs");
          yield* complete(doneRun, 1, [TEAM_A.id]);
          yield* complete(doneRun, 2, [TEAM_B.id]);
          yield* runs.startStep({
            runStepId: activeRun.steps[0]?.id ?? "",
            actor: memberActor("member-1"),
            teamIds: [TEAM_A.id],
          });
          // A third, untouched run stays pending and is cancelled silently.
          const pendingRun = Option.getOrThrow(
            yield* runs.createRun({
              workflow: yield* savedDetail(activeRun.run.workflowId),
              teams: TEAMS,
              order: order(),
              lineItem: lineItem(3, []),
              source: "manual",
            }),
          );
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fulfillmentStatus: "FULFILLED",
            }),
            [
              lineItem(1, ["a"], { unfulfilledQuantity: 0 }),
              lineItem(2, ["b"], { unfulfilledQuantity: 0 }),
              lineItem(3, [], { unfulfilledQuantity: 0 }),
            ],
          );
          deepStrictEqual(counts, { created: 0, cancelled: 1, flagged: 1 });
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
            after.find((d) => d.run.id === doneRun.run.id)?.run.flag,
            null,
          );
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

  it("starts nothing for an off workflow, a never-applied one, or an unassigned step", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const workflows = yield* WorkflowRepository;
        yield* turnOff(a.id);
        // Draft only: has steps, never applied.
        const c = yield* workflows.createWorkflow({
          name: name("Drafted"),
          tags: tags(["c"]),
        });
        yield* workflows.addStep({
          workflowId: c.id,
          name: stepName("Cut"),
          teamId: TEAM_A.id,
        });
        const items = [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["c"]),
        ];
        const unassigned = yield* upsertAndReconcile(order(), items, [TEAM_A]);
        strictEqual(unassigned.created, 0);
        // b switched off: nothing starts even with every team active.
        yield* workflows.setWorkflowActive({
          workflowId: b.id,
          active: false,
          teams: TEAMS,
        });
        const off = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        strictEqual(off.created, 0);
        yield* workflows.setWorkflowActive({
          workflowId: b.id,
          active: true,
          teams: TEAMS,
        });
        yield* turnOn(a.id);
        const backOn = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          items,
        );
        strictEqual(backOn.created, 2);
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
        strictEqual(first.run.lineItemId < second.run.lineItemId, true);
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
            actor: memberActor("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        const notReady = yield* runs
          .startStep({
            runStepId: produce,
            actor: memberActor("m3"),
            teamIds: [TEAM_C.id],
          })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "StepNotReadyError");

        yield* runs.startStep({
          runStepId: artwork,
          actor: memberActor("m1"),
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
          actor: memberActor("m2"),
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

  it("uncompleteStep re-opens a step, keeps its starter, un-readies the next stage, and is refused once downstream started", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const materials = detail.steps[1]?.id ?? "";
        const produce = detail.steps[2]?.id ?? "";

        // Not yet done: nothing to undo.
        strictEqual(
          (yield* runs
            .uncompleteStep({
              runStepId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_A.id],
            })
            .pipe(Effect.flip))._tag,
          "StepNotReadyError",
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        // Stage 2 is ready now; Team C's queue has Produce.
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_C.id] })).length,
          1,
        );
        // Wrong team.
        strictEqual(
          (yield* runs
            .uncompleteStep({
              runStepId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_B.id],
            })
            .pipe(Effect.flip))._tag,
          "RunNotAllowedError",
        );
        // Anyone on the step's team may undo, not only who pressed Done.
        yield* runs.uncompleteStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const undone = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(undone.steps[0]?.completedAt, null);
        strictEqual(undone.steps[0]?.completedBy, null);
        strictEqual(undone.steps[0]?.startedBy, "member-1");
        strictEqual(undone.run.status, "active");
        // Produce left Team C's queue: stage 1 is open again.
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_C.id] })).length,
          0,
        );
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_A.id] }))[0]?.steps[0]?.id,
          artwork,
        );

        // Once downstream has started, undo is refused and names them.
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.startStep({
          runStepId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .uncompleteStep({
            runStepId: materials,
            actor: memberActor("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "StepUndoBlockedError");
        if (blocked._tag === "StepUndoBlockedError") {
          strictEqual(blocked.stepName, "Produce");
          strictEqual(blocked.teamName, "Team C");
        }

        // Undoing the last step turns a done run back to active.
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "done",
        );
        yield* runs.uncompleteStep({
          runStepId: detail.steps[3]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "active",
        );

        // A cancelled run is terminal for undo too.
        yield* runs.cancelRun({ runId: detail.run.id });
        strictEqual(
          (yield* runs
            .uncompleteStep({
              runStepId: produce,
              actor: memberActor("m1"),
              teamIds: [TEAM_C.id],
            })
            .pipe(Effect.flip))._tag,
          "RunTerminalError",
        );
      }),
    ));

  it("listDone lists the team's recent completions newest first with the undo verdict; getRunView decorates every step", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const since = Date.now() - 1000;
        strictEqual(
          (yield* runs.listDone({ teamIds: [TEAM_A.id], since, limit: 10 }))
            .length,
          0,
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamA = yield* runs.listDone({
          teamIds: [TEAM_A.id],
          since,
          limit: 10,
        });
        strictEqual(teamA.length, 1);
        strictEqual(teamA[0]?.step.name, "Artwork");
        strictEqual(teamA[0]?.run.id, detail.run.id);
        strictEqual(teamA[0]?.undoBlockedBy, null);
        // Outside the window: nothing.
        strictEqual(
          (yield* runs.listDone({
            teamIds: [TEAM_A.id, TEAM_B.id],
            since: Date.now() + 60_000,
            limit: 10,
          })).length,
          0,
        );
        yield* runs.startStep({
          runStepId: detail.steps[2]?.id ?? "",
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const both = yield* runs.listDone({
          teamIds: [TEAM_A.id, TEAM_B.id],
          since,
          limit: 10,
        });
        deepStrictEqual(
          both.map((entry) => [entry.step.name, entry.undoBlockedBy?.stepName]),
          [
            [stepName("Materials"), stepName("Produce")],
            [stepName("Artwork"), stepName("Produce")],
          ],
        );

        const view = Option.getOrThrow(
          yield* runs.getRunView({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        deepStrictEqual(
          view.steps.map((step) => [
            step.name,
            step.ready,
            step.undoBlockedBy?.teamName ?? null,
          ]),
          [
            ["Artwork", false, "Team C"],
            ["Materials", false, "Team C"],
            ["Produce", true, null],
            ["Inspect", false, null],
          ],
        );
        strictEqual(view.items.length, 1);
        // No step on the caller's teams, or no such run: the same None.
        strictEqual(
          Option.isNone(
            yield* runs.getRunView({
              runId: detail.run.id,
              teamIds: ["nobody"],
            }),
          ),
          true,
        );
        strictEqual(
          Option.isNone(
            yield* runs.getRunView({ runId: "missing", teamIds: [TEAM_A.id] }),
          ),
          true,
        );
        // The run carries the order's placed time.
        strictEqual(view.run.orderProcessedAt, PROCESSED_AT);
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
            actor: memberActor("m1"),
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
            actor: memberActor("m3"),
            teamIds: [TEAM_C.id],
            reason: null,
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: note("Out of chain"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(blocked.run.flag, "blocked");
        deepStrictEqual<unknown>(blocked.run.flagDetail, {
          reason: "Out of chain",
          by: { role: "member", memberId: "m1", email: "m1@example.com" },
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
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: null,
        });
        deepStrictEqual<unknown>(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .flagDetail,
          { by: { role: "member", memberId: "m1", email: "m1@example.com" } },
        );
        // Reconcile overwrites a person's block: a started run is active,
        // so the zeroed line item flags rather than cancels.
        yield* runs.startStep({
          runStepId: detail.steps[0]?.id ?? "",
          actor: memberActor("m1"),
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
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "item_removed");
      }),
    ));

  it("merchant completes an unassigned step: no team clause, and the merchant fills both actor slots", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const sql = yield* SqlClient.SqlClient;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        // The state a team delete leaves behind: in nobody's queue, which is
        // the very run the merchant is there to unstick.
        yield* sql`update WorkflowRunStep set teamId = null where id = ${artwork}`;
        const refused = yield* runs
          .completeStep({
            runStepId: artwork,
            actor: memberActor("m1"),
            teamIds: [TEAM_A.id],
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotAllowedError");
        yield* runs.completeStep({ runStepId: artwork, actor: MERCHANT });
        const step = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).steps[0];
        strictEqual(step?.completedByRole, "merchant");
        strictEqual(step?.completedBy, null);
        strictEqual(step?.completedByEmail, null);
        strictEqual(step?.startedByRole, "merchant");
        strictEqual(step?.startedBy, null);
        strictEqual(step?.startedByEmail, null);
        deepStrictEqual<unknown>(Domain.stepCompletedBy(step), {
          role: "merchant",
        });
      }),
    ));

  it("merchant completes over a member's start: the started slot keeps the member", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        yield* runs.startStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.completeStep({ runStepId: artwork, actor: MERCHANT });
        const step = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).steps[0];
        strictEqual(step?.startedByRole, "member");
        strictEqual(step?.startedByEmail, "m1@example.com");
        strictEqual(step?.completedByRole, "merchant");
        strictEqual(step?.completedByEmail, null);
      }),
    ));

  it("merchant undo of a merchant Done clears the backfilled start, so a member can Start; a member's start survives undo", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const stepNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [step] = Option.getOrThrow(run).steps;
            if (step === undefined) throw new Error("no step");
            return step;
          });
        yield* runs.completeStep({ runStepId: artwork, actor: MERCHANT });
        yield* runs.uncompleteStep({ runStepId: artwork, actor: MERCHANT });
        const reopened = yield* stepNow();
        strictEqual(reopened.startedAt, null);
        strictEqual(reopened.startedByRole, null);
        strictEqual(Domain.stepStartedBy(reopened), null);
        strictEqual(reopened.reopenedByRole, "merchant");

        yield* runs.startStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const started = yield* stepNow();
        strictEqual(started.startedByRole, "member");
        strictEqual(started.startedByEmail, "m1@example.com");

        yield* runs.completeStep({ runStepId: artwork, actor: MERCHANT });
        yield* runs.uncompleteStep({ runStepId: artwork, actor: MERCHANT });
        const backToMember = yield* stepNow();
        strictEqual(backToMember.startedByRole, "member");
        strictEqual(backToMember.startedByEmail, "m1@example.com");
        strictEqual(backToMember.completedAt, null);
      }),
    ));

  it("undo records the reopener and the next Done clears the slot, for a member and for the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const stepNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [step] = Option.getOrThrow(run).steps;
            if (step === undefined) throw new Error("no step");
            return step;
          });
        yield* runs.completeStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.uncompleteStep({
          runStepId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const byMember = yield* stepNow();
        strictEqual(byMember.reopenedByRole, "member");
        strictEqual(byMember.reopenedByEmail, "m2@example.com");
        strictEqual(typeof byMember.reopenedAt, "number");
        deepStrictEqual<unknown>(Domain.stepReopenedBy(byMember), {
          role: "member",
          email: "m2@example.com",
        });

        yield* runs.completeStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const redone = yield* stepNow();
        strictEqual(redone.reopenedAt, null);
        strictEqual(redone.reopenedByRole, null);
        strictEqual(redone.reopenedByEmail, null);
        strictEqual(Domain.stepReopenedBy(redone), null);

        yield* runs.uncompleteStep({ runStepId: artwork, actor: MERCHANT });
        const byMerchant = yield* stepNow();
        strictEqual(byMerchant.reopenedByRole, "merchant");
        strictEqual(byMerchant.reopenedByEmail, null);
        strictEqual(byMerchant.completedAt, null);
        strictEqual(byMerchant.completedByRole, null);
      }),
    ));

  it("the merchant is held to every rule but the team one: stage order, terminal runs, and the downstream undo guard", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const [artwork, materials, produce] = [
          detail.steps[0]?.id ?? "",
          detail.steps[1]?.id ?? "",
          detail.steps[2]?.id ?? "",
        ];
        // Stage 2 is not ready while stage 1 is open.
        const notReady = yield* runs
          .completeStep({ runStepId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "StepNotReadyError");

        yield* runs.completeStep({ runStepId: artwork, actor: MERCHANT });
        yield* runs.completeStep({ runStepId: materials, actor: MERCHANT });
        // A member downstream blocks the merchant's undo exactly as it would
        // block a teammate's.
        yield* runs.startStep({
          runStepId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .uncompleteStep({ runStepId: artwork, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "StepUndoBlockedError");
        strictEqual(
          blocked._tag === "StepUndoBlockedError" ? blocked.stepName : null,
          "Produce",
        );
        strictEqual(
          blocked._tag === "StepUndoBlockedError" ? blocked.teamName : null,
          TEAM_C.name,
        );

        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* runs
          .completeStep({ runStepId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("setStepNote records who wrote the note, and clearing it clears the attribution", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const stepNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [step] = Option.getOrThrow(run).steps;
            if (step === undefined) throw new Error("no step");
            return step;
          });
        yield* runs.setStepNote({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          note: note("scuffed"),
        });
        strictEqual((yield* stepNow()).noteByRole, "member");
        yield* runs.setStepNote({
          runStepId: artwork,
          actor: MERCHANT,
          note: note("customer approved"),
        });
        const merchantNote = yield* stepNow();
        strictEqual(merchantNote.noteByRole, "merchant");
        strictEqual(merchantNote.note, "customer approved");
        yield* runs.setStepNote({
          runStepId: artwork,
          actor: MERCHANT,
          note: null,
        });
        const cleared = yield* stepNow();
        strictEqual(cleared.note, null);
        strictEqual(cleared.noteByRole, null);
      }),
    ));

  it("blockRun and dismissFlag by the merchant: no ready-team requirement, and the flag records the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: MERCHANT,
          reason: note("waiting on the customer"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        deepStrictEqual<unknown>(blocked.run.flagDetail, {
          reason: "waiting on the customer",
          by: { role: "merchant" },
        });
        strictEqual(
          Domain.actorLabel(blocked.run.flagDetail?.by ?? { role: "merchant" }),
          "Merchant",
        );
        yield* runs.dismissFlag({ runId: detail.run.id });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .flag,
          null,
        );
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
          actor: memberActor("m1"),
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
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "item_removed");
      }),
    ));

  it("an edit after turn-on still starts the workflow's steps; apply while on replaces them and earlier runs keep their copies", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        deepStrictEqual(
          first.steps.map((s) => s.name),
          ["Cut", "Finish"],
        );

        // Edit, then a third step on the draft: the workflow is unchanged.
        yield* workflows.createDraft({ workflowId: a.id });
        yield* workflows.addStep({
          workflowId: a.id,
          name: stepName("Pack"),
          teamId: TEAM_C.id,
        });
        const edited = Option.getOrThrow(
          yield* workflows.getWorkflow({ workflowId: a.id }),
        );
        strictEqual(edited.steps.length, 2);
        strictEqual(edited.draft?.steps.length, 3);
        const second = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["a"])],
        );
        strictEqual(second.created, 1);
        const late = (yield* runsForOrder()).find(
          (d) => d.run.lineItemId === lineItem(2, []).id,
        );
        deepStrictEqual(
          late?.steps.map((s) => s.name),
          ["Cut", "Finish"],
        );

        // Apply while on: the next order gets three steps, the earlier runs
        // keep their copied steps.
        const applied = yield* workflows.applyDraft({
          workflowId: a.id,
          teams: TEAMS,
        });
        strictEqual(Domain.isActive(applied), true);
        const third = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [lineItem(1, ["a"]), lineItem(2, ["a"]), lineItem(3, ["a"])],
        );
        strictEqual(third.created, 1);
        const all = yield* runsForOrder();
        const newest = all.find((d) => d.run.lineItemId === lineItem(3, []).id);
        deepStrictEqual(
          newest?.steps.map((s) => s.name),
          ["Cut", "Finish", "Pack"],
        );
        const oldest = all.find((d) => d.run.id === first.run.id);
        strictEqual(oldest?.steps.length, 2);
      }),
    ));
  it("deleteWorkflow leaves its runs and run steps, open and finished; the queue, order view, start, complete, block, and cancel still work on them", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const workflows = yield* WorkflowRepository;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["a"]),
          lineItem(3, ["b"]),
        ]);
        const all = yield* runsForOrder();
        const aRuns = all.filter((d) => d.run.workflowId === a.id);
        const [finished, stillOpen] = aRuns;
        if (finished === undefined || stillOpen === undefined)
          throw new Error("no run");
        for (const step of finished.steps)
          yield* runs.completeStep({
            runStepId: step.id,
            actor: memberActor("m1"),
            teamIds: step.teamId === null ? [] : [step.teamId],
          });

        yield* workflows.deleteWorkflow({ workflowId: a.id });

        // Every run stays, and the order view still reads the snapshots.
        const remaining = yield* runsForOrder();
        deepStrictEqual(
          remaining.map((d) => d.run.id).toSorted(),
          all.map((d) => d.run.id).toSorted(),
        );
        const orphan = remaining.find((d) => d.run.id === stillOpen.run.id);
        strictEqual(orphan?.run.workflowName, a.name);
        deepStrictEqual(
          orphan?.steps.map((step) => [step.name, step.teamName]),
          [
            ["Cut", TEAM_A.name],
            ["Finish", TEAM_B.name],
          ],
        );
        const done = remaining.find((d) => d.run.id === finished.run.id);
        strictEqual(done?.run.status, "done");
        strictEqual(
          done?.steps.every((step) => step.completedAt !== null),
          true,
        );

        // The orphan is still queued, and every step write still lands.
        const [queued] = yield* runs.listQueue({ teamIds: [TEAM_A.id] });
        strictEqual(queued?.run.id, stillOpen.run.id);
        const [cut, finish] = stillOpen.steps;
        if (cut === undefined || finish === undefined)
          throw new Error("no steps");
        yield* runs.startStep({
          runStepId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.completeStep({
          runStepId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.assignRunStepTeam({
          runStepId: finish.id,
          team: TEAM_C,
        });
        const [reassigned] = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
        strictEqual(reassigned?.steps[0]?.id, finish.id);
        yield* runs.blockRun({
          runId: stillOpen.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_C.id],
          reason: note("waiting on stock"),
        });
        yield* runs.cancelRun({ runId: stillOpen.run.id });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: stillOpen.run.id })).run
            .status,
          "cancelled",
        );

        // Another workflow's runs are untouched, and the name is free at once.
        strictEqual(
          remaining.filter((d) => d.run.workflowId === b.id).length,
          1,
        );
        yield* workflows.createWorkflow({ name: a.name, tags: tags(["a"]) });
      }),
    ));

  it("a run of a deleted workflow sits alongside a new run on the same line item", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const workflows = yield* WorkflowRepository;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [orphaned] = yield* runsForOrder();
        if (orphaned === undefined) throw new Error("no run");
        yield* workflows.deleteWorkflow({ workflowId: a.id });

        // A fresh workflow on the same item: a different workflowId, so
        // `unique (lineItemId, workflowId)` lets both runs stand.
        const replacement = yield* workflows.createWorkflow({
          name: name("Workflow a2"),
          tags: tags(["a"]),
        });
        yield* workflows.addStep({
          workflowId: replacement.id,
          name: stepName("Cut"),
          teamId: TEAM_A.id,
        });
        yield* goLive(replacement.id);
        const attached = yield* runs.createRun({
          workflow: yield* savedDetail(replacement.id),
          teams: TEAMS,
          order: order(),
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isSome(attached), true);
        const both = yield* runsForOrder();
        deepStrictEqual(
          both.map((d) => d.run.workflowId).toSorted(),
          [a.id, replacement.id].toSorted(),
        );
        strictEqual(
          both.find((d) => d.run.id === orphaned.run.id)?.run.workflowName,
          a.name,
        );
      }),
    ));

  it("start, complete, and block snapshot the actor's email onto the row; listQueue reads it back with no roster", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const materials = detail.steps[1]?.id ?? "";
        yield* runs.startStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        // Done without Start backfills the starter's email too.
        yield* runs.completeStep({
          runStepId: materials,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        deepStrictEqual(
          after.steps
            .slice(0, 2)
            .map((s) => [s.startedByEmail, s.completedByEmail]),
          [
            ["m1@example.com", null],
            ["m2@example.com", "m2@example.com"],
          ],
        );
        const [queued] = yield* runs.listQueue({ teamIds: [TEAM_A.id] });
        strictEqual(queued?.steps[0]?.startedByEmail, "m1@example.com");
      }),
    ));

  it("unassignTeam nulls open run steps only; the step leaves every queue and cannot be worked; assignRunStepTeam brings it back", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("no run");
        const [cut, finish] = run.steps;
        if (cut === undefined || finish === undefined)
          throw new Error("no steps");
        // Finish Cut (Team A) so it is the finished step that keeps its pointer.
        yield* runs.completeStep({
          runStepId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* workflows.unassignTeam({ teamId: TEAM_A.id });
        yield* workflows.unassignTeam({ teamId: TEAM_B.id });
        const nulled = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        );
        deepStrictEqual(
          nulled.steps.map((s) => [s.teamId, s.teamName]),
          [
            [TEAM_A.id, "Team A"],
            [null, "Team B"],
          ],
        );
        strictEqual(
          (yield* runs.listQueue({ teamIds: [TEAM_B.id] })).length,
          0,
        );
        const refused = yield* runs
          .startStep({
            runStepId: finish.id,
            actor: memberActor("m2"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotAllowedError");
        // The definition is unassigned too; the workflow cannot start runs.
        strictEqual(
          (yield* workflows.listWorkflows({ teams: TEAMS })).find(
            (w) => w.id === a.id,
          )?.needsAttention,
          true,
        );
        const none = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["a"])],
        );
        strictEqual(none.created, 0);
        // Assign Team C: name snapshotted, step in C's queue, workable.
        yield* runs.assignRunStepTeam({ runStepId: finish.id, team: TEAM_C });
        const assigned = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        );
        deepStrictEqual(
          [assigned.steps[1]?.teamId, assigned.steps[1]?.teamName],
          [TEAM_C.id, "Team C"],
        );
        const [queued] = yield* runs.listQueue({ teamIds: [TEAM_C.id] });
        strictEqual(queued?.steps[0]?.id, finish.id);
        yield* runs.completeStep({
          runStepId: finish.id,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        // A finished step is never reassigned; a missing step is not found.
        strictEqual(
          (yield* runs
            .assignRunStepTeam({ runStepId: finish.id, team: TEAM_A })
            .pipe(Effect.flip))._tag,
          "StepFinishedError",
        );
        strictEqual(
          (yield* runs
            .assignRunStepTeam({ runStepId: "nope", team: TEAM_A })
            .pipe(Effect.flip))._tag,
          "RunNotFoundError",
        );
      }),
    ));
});
