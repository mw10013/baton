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
  type RunItemBusyError,
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
const workflowTag = Schema.decodeUnknownSync(Domain.WorkflowTag);
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

/** Nobody's queue in particular: a reader who has started nothing, so `tierOf` never answers "mine". */
const VIEWER = emailOf("viewer@example.com");

/** The four tabs whose rows `listQueue` returns; "done" is `listDone`'s. */
const TIER_TABS = [
  "mine",
  "upNext",
  "inProgress",
  "attention",
] as const satisfies readonly Domain.QueueTab[];

/**
 * The rows `listQueue` returns, flattened back into one list in strip order,
 * so a test that only cares about *which* runs are queued reads the same as it
 * did before the read became one tab at a time. `tab` names the single tab
 * where that is what the test is about; tests about the tiering itself call
 * `listQueue` directly.
 */
const queueRows = Effect.fn("queueRows")(function* ({
  teamIds,
  memberEmail = VIEWER,
  tab,
  team = null,
  limit = Domain.QUEUE_PAGE,
}: {
  readonly teamIds: readonly Domain.TeamId[];
  readonly memberEmail?: Domain.Email;
  readonly tab?: Domain.QueueTab;
  readonly team?: Domain.TeamId | null;
  readonly limit?: number;
}) {
  const repository = yield* WorkflowRunRepository;
  const read = (wanted: Domain.QueueTab) =>
    repository.listQueue({
      teamIds,
      memberEmail,
      query: { team, tab: wanted, limit },
    });
  if (tab !== undefined) return (yield* read(tab)).items;
  const rows: Domain.QueueItem[] = [];
  for (const wanted of TIER_TABS) rows.push(...(yield* read(wanted)).items);
  return rows;
});

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
  note: "Gift wrap please",
  customAttributes: [],
  lineItemsTruncated: false,
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
  matchedWorkflowIds: [],
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
        tag: workflowTag(tag),
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
        tag: workflowTag("s"),
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
      ambiguous: 0,
    });
    yield* orders.upsertOrder({
      order: shopOrder,
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
        deepStrictEqual(
          yield* runs.countWaitingOrders({
            ...(yield* loadStartContext),
            workflow: detail,
          }),
          { count: 2, earliestProcessedAt: older },
        );
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
          ambiguous: 0,
        });
        deepStrictEqual(
          yield* runs.countWaitingOrders({
            ...(yield* loadStartContext),
            workflow: detail,
          }),
          { count: 1, earliestProcessedAt: older },
        );
      }),
    ));
});

/** What reconcile wrote on the item, sorted, read straight out of the column. */
const matchedIds = (lineItemId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`select matchedWorkflowIds from OrderLineItem where id = ${lineItemId}`,
    ),
    Effect.map(([row]) =>
      Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Array(Schema.String)),
      )(row?.matchedWorkflowIds).toSorted(),
    ),
  );

/**
 * One live run per line item. The invariant is a partial unique index
 * (`WorkflowRun_live_item_uidx`), so these cover both halves: what the write
 * paths do about it, and that the index itself is really there.
 */
describe("WorkflowRunRepository one live run per item", () => {
  /** A second workflow whose tag also lands on item 1, so the item matches two. */
  const rivalOn = (tag: string) =>
    Effect.gen(function* () {
      const workflows = yield* WorkflowRepository;
      const created = yield* workflows.createWorkflow({
        name: name(`Rival ${tag}`),
        tag: workflowTag(tag),
      });
      yield* workflows.addStep({
        workflowId: created.id,
        name: stepName("Rush"),
        teamId: TEAM_C.id,
      });
      return yield* goLive(created.id);
    });

  const ITEM_1 = lineItem(1, ["a", "rush"]).id;

  it("starts nothing when two workflows match, and records both", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const rival = yield* rivalOn("rush");
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a", "rush"]),
        ]);
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 0,
          ambiguous: 1,
        });
        strictEqual((yield* runsForOrder()).length, 0);
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id, rival.id].toSorted());
      }),
    ));

  it("turning one of the two off resolves the ambiguity and starts the survivor", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const rival = yield* rivalOn("rush");
        const items = [lineItem(1, ["a", "rush"])];
        yield* upsertAndReconcile(order(), items);
        yield* turnOff(rival.id);
        const after = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        deepStrictEqual(after, {
          created: 1,
          cancelled: 0,
          flagged: 0,
          ambiguous: 0,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 1);
        strictEqual(runs[0]?.run.workflowId, a.id);
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id]);
      }),
    ));

  it("a live run wins: a second workflow turned on later is recorded but starts nothing", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const items = [lineItem(1, ["a", "rush"])];
        yield* upsertAndReconcile(order(), items);
        strictEqual((yield* runsForOrder()).length, 1);
        const rival = yield* rivalOn("rush");
        const after = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        deepStrictEqual(after, {
          created: 0,
          cancelled: 0,
          flagged: 0,
          ambiguous: 0,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 1);
        strictEqual(runs[0]?.run.workflowId, a.id);
        // Both are recorded even though only one ever started: the column is
        // the match, not the outcome.
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id, rival.id].toSorted());
      }),
    ));

  it("setRun over a live run cancels it in the same transaction and reports it as replaced", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [before] = yield* runsForOrder();
        if (before === undefined) throw new Error("no run");
        strictEqual(before.run.workflowId, a.id);
        const set = Option.getOrThrow(
          yield* runs.setRun({
            workflow: yield* savedDetail(b.id),
            teams: TEAMS,
            order: order(),
            lineItem: items[0] ?? lineItem(1, ["a"]),
            source: "manual",
          }),
        );
        strictEqual(set.replaced?.id, before.run.id);
        strictEqual(set.run.workflowId, b.id);
        strictEqual(set.run.status, "pending");
        const after = yield* runsForOrder();
        strictEqual(after.length, 2);
        strictEqual(
          after.find((d) => d.run.id === before.run.id)?.run.status,
          "cancelled",
        );
      }),
    ));

  it("setRun over a done run is refused, naming the finished workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        strictEqual(detail.run.workflowId, a.id);
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        const refused = yield* runs
          .setRun({
            workflow: yield* savedDetail(b.id),
            teams: TEAMS,
            order: order(),
            lineItem: items[0] ?? lineItem(1, ["a"]),
            source: "manual",
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunFinishedError");
        if (refused._tag === "RunFinishedError")
          strictEqual(refused.workflowName, detail.run.workflowName);
        strictEqual((yield* runsForOrder()).length, 1);
      }),
    ));

  it("setRun on a workflow whose earlier run was cancelled un-cancels it, steps and all", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        yield* complete(first, 1, [TEAM_A.id]);
        yield* runs.cancelRun({ runId: first.run.id });
        const set = Option.getOrThrow(
          yield* runs.setRun({
            workflow: yield* savedDetail(a.id),
            teams: TEAMS,
            order: order(),
            lineItem: items[0] ?? lineItem(1, ["a"]),
            source: "manual",
          }),
        );
        // The same row, back from cancelled with its finished step intact.
        strictEqual(set.run.id, first.run.id);
        strictEqual(set.replaced, null);
        strictEqual(set.run.status, "active");
        const [revived] = yield* runsForOrder();
        strictEqual(
          revived?.steps.filter((step) => step.completedAt !== null).length,
          1,
        );
      }),
    ));

  it("un-cancel is refused while another live run occupies the item", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        strictEqual(first.run.workflowId, a.id);
        yield* runs.setRun({
          workflow: yield* savedDetail(b.id),
          teams: TEAMS,
          order: order(),
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        const refused = yield* Effect.flip(
          runs.uncancelRun({ runId: first.run.id }),
        );
        strictEqual(refused._tag, "RunItemBusyError");
        strictEqual((refused as RunItemBusyError).workflowName, b.name);
      }),
    ));

  it("the partial index itself refuses a second live run", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [live] = yield* runsForOrder();
        if (live === undefined) throw new Error("no run");
        // Raw insert, bypassing every write path: the database itself refuses.
        const raw = yield* Effect.flip(sql`
          insert into WorkflowRun (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity,
            customAttributes, source, status, flag, flagAt, flagDetail,
            createdAt, updatedAt, cancelledAt
          ) values (
            'raw', ${b.id}, 'Workflow b', ${ORDER_ID}, '#1001', 0,
            ${live.run.lineItemId}, 'Item', null, null, 1,
            '[]', 'manual', 'pending', null, null, null, 0, 0, null
          )
        `);
        strictEqual(raw._tag, "SqlError");
        strictEqual((yield* runsForOrder()).length, 1);
        strictEqual(live.run.workflowId, a.id);
        // Cancelling frees the item, so the same insert then lands: the index
        // is partial over `status <> 'cancelled'`, not over the item.
        yield* (yield* WorkflowRunRepository).cancelRun({
          runId: live.run.id,
        });
        yield* sql`
          insert into WorkflowRun (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity,
            customAttributes, source, status, flag, flagAt, flagDetail,
            createdAt, updatedAt, cancelledAt
          ) values (
            'raw', ${b.id}, 'Workflow b', ${ORDER_ID}, '#1001', 0,
            ${live.run.lineItemId}, 'Item', null, null, 1,
            '[]', 'manual', 'pending', null, null, null, 0, 0, null
          )
        `;
        strictEqual((yield* runsForOrder()).length, 2);
      }),
    ));

  it("countWaitingOrders counts only what Include them would actually start", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const orders = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* rivalOn("rush");
        // Placed before every workflow was turned on, which is exactly what
        // the dialog is about: they match by tag, the date is what stops them.
        const old = Date.now() - 60 * 60 * 1000;
        const seedOrder = (id: string, itemTags: readonly string[]) =>
          orders.upsertOrder({
            order: order({ id, legacyId: id, name: id, processedAt: old }),
            lineItems: [
              { ...lineItem(1, itemTags), id: `${id}/li`, orderId: id },
            ],
            afterWrite: Effect.void,
          });
        yield* seedOrder("o1", ["a"]);
        yield* seedOrder("o2", ["a"]);
        yield* seedOrder("o3", ["a", "rush"]);
        // o2's item is already routed — by whom does not matter, one live run
        // per item means Include them would not start a second.
        yield* sql`
          insert into WorkflowRun (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity,
            customAttributes, source, status, flag, flagAt, flagDetail,
            createdAt, updatedAt, cancelledAt
          ) values (
            'busy', 'other', 'Other', 'o2', 'o2', 0,
            'o2/li', 'Item', null, null, 1,
            '[]', 'manual', 'pending', null, null, null, 0, 0, null
          )
        `;
        // o3 would come out ambiguous — the rival's tag is on it too — and
        // ambiguity starts nothing. Only o1 is left.
        deepStrictEqual(
          yield* runs.countWaitingOrders({
            ...(yield* loadStartContext),
            workflow: yield* savedDetail(a.id),
          }),
          { count: 1, earliestProcessedAt: old },
        );
      }),
    ));
});

describe("WorkflowRunRepository.reconcileOrder", () => {
  it("creates one run per matching line item with copied steps and team names", () =>
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
          ambiguous: 0,
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
          ambiguous: 0,
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
        const attached = yield* runs.setRun({
          workflow: detail,
          teams: TEAMS,
          order: old,
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isSome(attached), true);
        strictEqual(Option.getOrThrow(attached).run.source, "manual");
        strictEqual(Option.getOrThrow(attached).replaced, null);
        const duplicate = yield* runs.setRun({
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
          ambiguous: 0,
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
          ambiguous: 0,
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
          ambiguous: 0,
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

  /**
   * The case nobody is watching: the maker has put the work down, and the
   * merchant edits the order in Shopify. The run keeps its quantity — what
   * was made was made — and the flag is how the merchant learns of it.
   */
  it("a quantity change on a done line flags the run and changes nothing else", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("expected one run");
        yield* complete(run, 1, [TEAM_A.id]);
        yield* complete(run, 2, [TEAM_B.id]);
        strictEqual((yield* runsForOrder())[0]?.run.status, "done");

        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"], { currentQuantity: 5, unfulfilledQuantity: 5 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          ambiguous: 0,
        });
        const flagged = (yield* runsForOrder())[0];
        strictEqual(flagged?.run.status, "done");
        strictEqual(flagged?.run.quantity, 2);
        strictEqual(flagged?.run.flag, "quantity_changed");
        deepStrictEqual(flagged?.run.flagDetail, { from: 2, to: 5 });
        strictEqual(flagged?.steps.length, 2);

        // The units reaching zero is the ordinary end of a done run — the
        // work shipped — so it is not a second change to report.
        const shipped = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [lineItem(1, ["a"], { currentQuantity: 5, unfulfilledQuantity: 0 })],
        );
        deepStrictEqual(shipped, {
          created: 0,
          cancelled: 0,
          flagged: 0,
          ambiguous: 0,
        });
        const after = (yield* runsForOrder())[0];
        strictEqual(after?.run.status, "done");
        strictEqual(after?.run.quantity, 2);
      }),
    ));

  it("a dismissed quantity flag on a done run does not return on the next reconcile", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("expected one run");
        yield* complete(run, 1, [TEAM_A.id]);
        yield* complete(run, 2, [TEAM_B.id]);
        const changed = [
          lineItem(1, ["a"], { currentQuantity: 5, unfulfilledQuantity: 5 }),
        ];
        yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          changed,
        );
        const flagged = (yield* runsForOrder())[0];
        strictEqual(flagged?.run.flag, "quantity_changed");
        // A webhook that changed nothing about the line does not restamp it.
        const again = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          changed,
        );
        strictEqual(again.flagged, 0);
        strictEqual(
          (yield* runsForOrder())[0]?.run.flagAt,
          flagged?.run.flagAt,
        );

        const runs = yield* WorkflowRunRepository;
        yield* runs.dismissFlag({ runId: run.run.id });
        const accepted = (yield* runsForOrder())[0];
        strictEqual(accepted?.run.flag, null);
        strictEqual(accepted?.run.quantity, 5);
        strictEqual(accepted?.run.status, "done");

        const after = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 3 }),
          changed,
        );
        strictEqual(after.flagged, 0);
        strictEqual((yield* runsForOrder())[0]?.run.flag, null);
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
          ambiguous: 0,
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
            ambiguous: 0,
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
            ambiguous: 0,
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
            ambiguous: 0,
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
            ambiguous: 0,
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
            yield* runs.setRun({
              workflow: yield* savedDetail(activeRun.run.workflowId),
              teams: TEAMS,
              order: order(),
              lineItem: lineItem(3, []),
              source: "manual",
            }),
          ).run;
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
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 1,
            flagged: 1,
            ambiguous: 0,
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
            ambiguous: 0,
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
          ambiguous: 0,
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
          tag: workflowTag("c"),
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

        const teamAQueue = yield* queueRows({ teamIds: [TEAM_A.id] });
        // Two runs of one order share `orderProcessedAt`, so the line item
        // orders them: the same order `listRunsForOrder` gave `first` and
        // `second`.
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
        strictEqual((yield* queueRows({ teamIds: [TEAM_B.id] })).length, 0);
        strictEqual((yield* queueRows({ teamIds: [] })).length, 0);

        yield* complete(second, 1, [TEAM_A.id]);
        const teamBQueue = yield* queueRows({ teamIds: [TEAM_B.id] });
        deepStrictEqual(
          teamBQueue.map((item) => [item.run.id, item.steps[0]?.name]),
          [[second.run.id, "Finish"]],
        );

        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"]),
        ]);
        // The flag decides the tab, not the position in one list: the
        // reconciled run leaves Up next for Blocked and the untouched one
        // stays.
        const blocked = yield* queueRows({
          teamIds: [TEAM_A.id, TEAM_B.id],
          tab: "attention",
        });
        deepStrictEqual(
          blocked.map((item) => [item.run.id, item.run.flag]),
          [[second.run.id, "item_removed"]],
        );
        strictEqual(blocked[0]?.run.customAttributes?.[0]?.value, "Hello 2");
        deepStrictEqual(
          (yield* queueRows({
            teamIds: [TEAM_A.id, TEAM_B.id],
            tab: "upNext",
          })).map((item) => [item.run.id, item.run.flag]),
          [[first.run.id, null]],
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
        yield* orders.deleteOrder({ orderId: ORDER_ID, now: 0 });
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

        const queue = yield* queueRows({ teamIds: [TEAM_B.id] });
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

  it("listQueue tiers by the reader: my started step is Mine, a teammate's is In progress, a flag is Blocked for both", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [mine, theirs] = yield* runsForOrder();
        if (mine === undefined || theirs === undefined)
          throw new Error("expected two runs");
        const maker = memberActor("m1", "maker@example.com");
        yield* runs.startStep({
          runStepId: mine.steps[0]?.id ?? "",
          actor: maker,
          teamIds: [TEAM_A.id],
        });
        // A hold on the other run: the one flag a person sets, so the tier is
        // reached without disturbing either run's steps.
        yield* runs.blockRun({
          runId: theirs.run.id,
          actor: maker,
          teamIds: [TEAM_A.id],
          reason: note("Waiting on the customer"),
        });

        // The counts come back whatever tab is asked for, so one read per
        // reader says where every row landed for them.
        const countsFor = (memberEmail: Domain.Email) =>
          runs
            .listQueue({
              teamIds: [TEAM_A.id],
              memberEmail,
              query: { team: null, tab: "mine", limit: Domain.QUEUE_PAGE },
            })
            .pipe(
              Effect.map(({ counts, items }) => ({
                counts: [
                  counts.mine,
                  counts.upNext,
                  counts.inProgress,
                  counts.attention,
                ],
                mine: items.map((item) => item.run.id),
              })),
            );

        deepStrictEqual(yield* countsFor(maker.email), {
          counts: [1, 0, 0, 1],
          mine: [mine.run.id],
        });
        deepStrictEqual(yield* countsFor(VIEWER), {
          counts: [0, 0, 1, 1],
          mine: [],
        });
        // The flagged run is Blocked for both, and the started one is In
        // progress for the reader who did not start it.
        deepStrictEqual(
          (yield* queueRows({
            teamIds: [TEAM_A.id],
            memberEmail: VIEWER,
            tab: "inProgress",
          })).map((item) => item.run.id),
          [mine.run.id],
        );
        deepStrictEqual(
          (yield* queueRows({
            teamIds: [TEAM_A.id],
            memberEmail: maker.email,
            tab: "attention",
          })).map((item) => item.run.id),
          [theirs.run.id],
        );
      }),
    ));

  it("listQueue counts the whole tab and returns only the limit; the team counts ignore the narrowing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(
          order(),
          Array.from({ length: 12 }, (_, index) => lineItem(index + 1, ["a"])),
        );
        // An explicit limit rather than `QUEUE_PAGE`: what is on trial is that
        // the cut happens at the number asked for, not what that number is.
        const read = (limit: number) =>
          runs.listQueue({
            teamIds: [TEAM_A.id, TEAM_B.id],
            memberEmail: VIEWER,
            query: { team: null, tab: "upNext", limit },
          });

        const capped = yield* read(10);
        strictEqual(capped.items.length, 10);
        strictEqual(capped.counts.upNext, 12);
        strictEqual(capped.counts.total, 12);
        deepStrictEqual(
          capped.counts.teamCounts.map(({ teamId, count }) => [teamId, count]),
          [
            [TEAM_A.id, 12],
            // Finish is stage 2 and nothing is done, so B owns no ready step.
            [TEAM_B.id, 0],
          ],
        );

        const deeper = yield* read(20);
        strictEqual(deeper.items.length, 12);
        strictEqual(deeper.counts.upNext, 12);
      }),
    ));

  it("listQueue on the Done tab returns no items and counts the tiers all the same", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);

        const done = yield* runs.listQueue({
          teamIds: [TEAM_A.id],
          memberEmail: VIEWER,
          query: { team: null, tab: "done", limit: Domain.QUEUE_PAGE },
        });
        // The Done tab's rows are `listDone`'s; the strip above them is still
        // this read's, which is why the counts do not depend on the tab.
        strictEqual(done.items.length, 0);
        strictEqual(done.counts.upNext, 1);
        strictEqual(done.counts.total, 1);
      }),
    ));

  it("listQueue narrows rows and their steps to one team, and a team the member is not on reads empty", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        yield* stagedRun();
        const teamIds = [TEAM_A.id, TEAM_B.id];

        const read = (team: Domain.TeamId | null) =>
          runs.listQueue({
            teamIds,
            memberEmail: VIEWER,
            query: { team, tab: "upNext", limit: Domain.QUEUE_PAGE },
          });

        const both = yield* read(null);
        deepStrictEqual(
          both.items.map((item) => item.steps.map((step) => step.name)),
          [[stepName("Artwork"), stepName("Materials")]],
        );

        const onlyA = yield* read(TEAM_A.id);
        deepStrictEqual(
          onlyA.items.map((item) => item.steps.map((step) => step.name)),
          [[stepName("Artwork")]],
        );
        // The team counts are over every team on the connection, so choosing
        // one does not move the numbers in the select beside it.
        deepStrictEqual(
          onlyA.counts.teamCounts.map(({ teamId, count }) => [teamId, count]),
          [
            [TEAM_A.id, 1],
            [TEAM_B.id, 1],
          ],
        );
        strictEqual(onlyA.counts.total, 1);
        strictEqual(onlyA.counts.upNext, 1);

        const foreign = yield* read(TEAM_C.id);
        strictEqual(foreign.items.length, 0);
        // The tab counts are after the narrowing — they describe the lists the
        // member can switch to — while `total` and `teamCounts` are not.
        strictEqual(foreign.counts.upNext, 0);
        strictEqual(foreign.counts.total, 1);
        deepStrictEqual(
          foreign.counts.teamCounts.map(({ count }) => count),
          [1, 1],
        );
      }),
    ));

  it("listQueue returns every ready step per run with stageCount and cross-team siblings", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const detail = yield* stagedRun();

        const teamA = yield* queueRows({ teamIds: [TEAM_A.id] });
        strictEqual(teamA.length, 1);
        strictEqual(teamA[0]?.stageCount, 3);
        deepStrictEqual(
          teamA[0]?.steps.map((s) => [s.name, s.stage]),
          [["Artwork", 1]],
        );
        deepStrictEqual<unknown>(teamA[0]?.steps[0]?.siblings, [
          { name: "Materials", teamName: "Team B" },
        ]);

        const both = yield* queueRows({ teamIds: [TEAM_A.id, TEAM_B.id] });
        strictEqual(both.length, 1);
        deepStrictEqual(
          both[0]?.steps.map((s) => s.name),
          ["Artwork", "Materials"],
        );
        deepStrictEqual(both[0]?.steps[0]?.siblings, []);

        strictEqual((yield* queueRows({ teamIds: [TEAM_C.id] })).length, 0);
        yield* complete(detail, 1, [TEAM_A.id]);
        strictEqual((yield* queueRows({ teamIds: [TEAM_C.id] })).length, 0);
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamC = yield* queueRows({ teamIds: [TEAM_C.id] });
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
        strictEqual((yield* queueRows({ teamIds: [TEAM_C.id] })).length, 1);
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
        strictEqual((yield* queueRows({ teamIds: [TEAM_C.id] })).length, 0);
        strictEqual(
          (yield* queueRows({ teamIds: [TEAM_A.id] }))[0]?.steps[0]?.id,
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
            .total,
          0,
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamA = yield* runs.listDone({
          teamIds: [TEAM_A.id],
          since,
          limit: 10,
        });
        strictEqual(teamA.total, 1);
        strictEqual(teamA.items.length, 1);
        strictEqual(teamA.items[0]?.step.name, "Artwork");
        strictEqual(teamA.items[0]?.run.id, detail.run.id);
        strictEqual(teamA.items[0]?.undoBlockedBy, null);
        // The collapsed tier: the count without the rows.
        const collapsed = yield* runs.listDone({
          teamIds: [TEAM_A.id],
          since,
          limit: 0,
        });
        strictEqual(collapsed.total, 1);
        strictEqual(collapsed.items.length, 0);
        // Outside the window: nothing.
        strictEqual(
          (yield* runs.listDone({
            teamIds: [TEAM_A.id, TEAM_B.id],
            since: Date.now() + 60_000,
            limit: 10,
          })).total,
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
          both.items.map((entry) => [
            entry.step.name,
            entry.undoBlockedBy?.stepName,
          ]),
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

  it("setStepNote writes, overwrites, clears; allowed on a done step and on a done run; refused on a cancelled run", () =>
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
        // The whole run done: a note is a record, not work, so it still lands.
        yield* complete(detail, 2, [TEAM_B.id]);
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "done",
        );
        yield* set(note("noticed after the last Done"));
        strictEqual(yield* stepNote(), "noticed after the last Done");
        // A done run is not cancelled from here; undo the last step first.
        yield* runs.uncompleteStep({
          runStepId: detail.steps[3]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* set(note("nope")).pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("a flag refuses Start and Done but not Undo or the note, and dismissing it lets work resume", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const artwork = detail.steps[0]?.id ?? "";
        const materials = detail.steps[1]?.id ?? "";
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
          reason: null,
        });
        const start = yield* runs
          .startStep({
            runStepId: materials,
            actor: memberActor("m2"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(start._tag, "RunFlaggedError");
        const done = yield* complete(detail, 2, [TEAM_B.id]).pipe(Effect.flip);
        strictEqual(done._tag, "RunFlaggedError");
        yield* runs.setStepNote({
          runStepId: materials,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
          note: note("waiting on stock"),
        });
        yield* runs.uncompleteStep({
          runStepId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.dismissFlag({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        yield* complete(detail, 2, [TEAM_B.id]);
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.steps[0]?.completedAt, null);
        strictEqual(after.steps[1]?.completedAt !== null, true);
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
        const queue = yield* queueRows({ teamIds: [TEAM_B.id] });
        strictEqual(queue[0]?.run.flag, "blocked");

        yield* runs.dismissFlag({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(cleared.run.flag, null);

        // Started before the block, since a flag refuses Start: a started
        // run is active, so reconcile's zeroed line item flags rather than
        // cancels, and that reconcile flag overwrites the person's block.
        yield* runs.startStep({
          runStepId: detail.steps[0]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
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
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["s"], { currentQuantity: 0, unfulfilledQuantity: 0 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          cancelled: 0,
          flagged: 1,
          ambiguous: 0,
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.status, "active");
        strictEqual(after.run.flag, "item_removed");
      }),
    ));

  /**
   * The edit is text and nothing else. `by` and `flagAt` record who set the
   * hold and when, and a correction to its wording must not restate either —
   * the merchant reading the queue is chasing the person who blocked it, not
   * whoever last fixed a typo.
   */
  it("setBlockReason rewrites the reason, keeps by, and refuses anything that is not a standing block", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStaged;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* stagedRun();
        const flagDetail = () =>
          runs
            .getRun({ runId: detail.run.id })
            .pipe(Effect.map((run) => Option.getOrThrow(run).run.flagDetail));

        const unflagged = yield* runs
          .setBlockReason({
            runId: detail.run.id,
            teamIds: [TEAM_B.id],
            reason: note("too early"),
          })
          .pipe(Effect.flip);
        // Its own tag: the caller's teams were fine, the hold was the thing
        // missing, and the page says so rather than crying team.
        strictEqual(unflagged._tag, "RunNotBlockedError");

        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: note("Waiting on stones"),
        });
        const by = {
          role: "member",
          memberId: "m1",
          email: "m1@example.com",
        };

        const wrongTeam = yield* runs
          .setBlockReason({
            runId: detail.run.id,
            teamIds: [TEAM_C.id],
            reason: note("nope"),
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");

        // A teammate, not the blocker, and the text keeps its line breaks.
        yield* runs.setBlockReason({
          runId: detail.run.id,
          teamIds: [TEAM_B.id],
          reason: note("Waiting on stones\nCalled the supplier"),
        });
        deepStrictEqual<unknown>(yield* flagDetail(), {
          reason: "Waiting on stones\nCalled the supplier",
          by,
        });

        // The merchant passes no teams and is refused by nothing.
        yield* runs.setBlockReason({
          runId: detail.run.id,
          reason: null,
        });
        deepStrictEqual<unknown>(yield* flagDetail(), { by });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .flag,
          "blocked",
        );
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
          ambiguous: 0,
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

        // The orphan is still queued, and every step write still lands. Found
        // by id rather than by position: which run it is does not matter here.
        const queued = yield* queueRows({ teamIds: [TEAM_A.id] });
        strictEqual(
          queued.some((item) => item.run.id === stillOpen.run.id),
          true,
        );
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
        const [reassigned] = yield* queueRows({ teamIds: [TEAM_C.id] });
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
        yield* workflows.createWorkflow({
          name: a.name,
          tag: workflowTag("a"),
        });
      }),
    ));

  it("a run of a deleted workflow is replaced, not joined, by a new run on the same line item", () =>
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

        // A fresh workflow on the same item. The orphaned run is still live,
        // and one live run per item, so attaching cancels it rather than
        // standing beside it — the deleted definition does not make its run
        // any less the item's current route.
        const replacement = yield* workflows.createWorkflow({
          name: name("Workflow a2"),
          tag: workflowTag("a"),
        });
        yield* workflows.addStep({
          workflowId: replacement.id,
          name: stepName("Cut"),
          teamId: TEAM_A.id,
        });
        yield* goLive(replacement.id);
        const attached = yield* runs.setRun({
          workflow: yield* savedDetail(replacement.id),
          teams: TEAMS,
          order: order(),
          lineItem: items[0] ?? lineItem(1, ["a"]),
          source: "manual",
        });
        strictEqual(Option.isSome(attached), true);
        strictEqual(Option.getOrThrow(attached).replaced?.id, orphaned.run.id);
        const both = yield* runsForOrder();
        deepStrictEqual(
          both.map((d) => d.run.workflowId).toSorted(),
          [a.id, replacement.id].toSorted(),
        );
        // The orphan keeps its snapshotted name, cancelled.
        strictEqual(
          both.find((d) => d.run.id === orphaned.run.id)?.run.workflowName,
          a.name,
        );
        strictEqual(
          both.find((d) => d.run.id === orphaned.run.id)?.run.status,
          "cancelled",
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
        const [queued] = yield* queueRows({ teamIds: [TEAM_A.id] });
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
        strictEqual((yield* queueRows({ teamIds: [TEAM_B.id] })).length, 0);
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
        // A step of a run that is not open keeps its pointer: cancelled here,
        // then un-cancelled so the assign below is on an open run again.
        yield* runs.cancelRun({ runId: run.run.id });
        const notOpen = yield* runs
          .assignRunStepTeam({ runStepId: finish.id, team: TEAM_C })
          .pipe(Effect.flip);
        strictEqual(notOpen._tag, "RunTerminalError");
        yield* runs.uncancelRun({ runId: run.run.id });
        // Assign Team C: name snapshotted, step in C's queue, workable.
        yield* runs.assignRunStepTeam({ runStepId: finish.id, team: TEAM_C });
        const assigned = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        );
        deepStrictEqual(
          [assigned.steps[1]?.teamId, assigned.steps[1]?.teamName],
          [TEAM_C.id, "Team C"],
        );
        const [queued] = yield* queueRows({ teamIds: [TEAM_C.id] });
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

/**
 * The ceiling is 5,000 open runs, which no test can reach by creating runs, so
 * these lower the constant for the duration. It is a plain object behind a
 * `readonly` type, and the alternative — threading a limit through
 * `reconcileOrder` and `setRun` for nobody but this file — would put a test
 * seam in the production signature.
 */
const withMaxOpenRuns = <A>(limit: number, body: () => Promise<A>) => {
  const limits = Domain.ShopLimits as { maxOpenRuns: number };
  const original = limits.maxOpenRuns;
  limits.maxOpenRuns = limit;
  return body().finally(() => {
    limits.maxOpenRuns = original;
  });
};

const usageRow = () =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`select openRunsLimitedAt from ShopUsage where id = 1`.values,
    ),
    Effect.map((rows) => rows[0]?.[0] ?? null),
  );

describe("WorkflowRunRepository open-run ceiling", () => {
  it("auto-start yields to the ceiling and records it; finishing the run clears the flag", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          // Two matching items, room for one run.
          const counts = yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          strictEqual(counts.created, 1);
          const limitedAt = yield* usageRow();
          strictEqual(typeof limitedAt, "number");
          // The order itself is stored either way: failing here would fail the
          // webhook, and Shopify would retry it for four hours.
          const stored = yield* (yield* OrderRepository).getOrder(ORDER_ID);
          strictEqual(Option.isSome(stored), true);
          // Finish the one run: both steps done takes it out of `pending`/
          // `active`, which is what releases the flag.
          const [detail] = yield* runsForOrder();
          if (detail === undefined) throw new Error("no run");
          yield* complete(detail, 1, [TEAM_A.id]);
          yield* complete(detail, 2, [TEAM_B.id]);
          strictEqual(yield* usageRow(), null);
        }),
      ),
    ));

  it("manual attach fails at the ceiling rather than silently doing nothing", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          const { a, b } = yield* seed;
          const runs = yield* WorkflowRunRepository;
          const orders = yield* OrderRepository;
          yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
          const target = Option.getOrThrow(
            yield* orders.getLineItem("gid://shopify/LineItem/1"),
          );
          // Attaching a *different* workflow to an item that already has a run
          // cancels the incumbent first, so it still fits under the ceiling.
          const replaced = yield* runs.setRun({
            workflow: yield* savedDetail(b.id),
            teams: TEAMS,
            order: target.order,
            lineItem: target.lineItem,
            source: "manual",
          });
          strictEqual(Option.isSome(replaced), true);
          // A second item has nowhere to go.
          yield* orders.upsertOrder({
            order: order({ updatedAt: PROCESSED_AT + 1 }),
            lineItems: [lineItem(1, ["a"]), lineItem(2, [])],
            afterWrite: Effect.void,
          });
          const second = Option.getOrThrow(
            yield* orders.getLineItem("gid://shopify/LineItem/2"),
          );
          const refused = yield* Effect.flip(
            runs.setRun({
              workflow: yield* savedDetail(a.id),
              teams: TEAMS,
              order: second.order,
              lineItem: second.lineItem,
              source: "manual",
            }),
          );
          strictEqual(refused._tag, "WorkflowRunLimitError");
        }),
      ),
    ));
});
