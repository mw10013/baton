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
            Layer.mergeAll(
              WorkflowRepository.layer,
              WorkflowRunRepository.layer,
            ).pipe(
              Layer.provideMerge(OrderRepository.layer),
              Layer.provideMerge(
                SqliteClient.layer({ storage: state.storage }),
              ),
            ),
          ),
        ),
      ),
  );

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const taskName = Schema.decodeUnknownSync(Domain.TaskName);
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
const instructions = Schema.decodeUnknownSync(Domain.TaskInstructions);
const note = Schema.decodeUnknownSync(Domain.RunNote);
const reason = Schema.decodeUnknownSync(Domain.BlockReason);

/** Nobody's list in particular: a reader who has started nothing, so `tierOf` never answers "mine". */
const VIEWER = emailOf("viewer@example.com");

/** The four tabs whose rows `listRuns` returns; "done" is `listDone`'s. */
const TIER_TABS = [
  "mine",
  "upNext",
  "inProgress",
  "attention",
] as const satisfies readonly Domain.RunTab[];

/**
 * The rows `listRuns` returns, flattened back into one list in strip order,
 * so a test that only cares about *which* runs are listed reads the same as it
 * did before the read became one tab at a time. `tab` names the single tab
 * where that is what the test is about; tests about the tiering itself call
 * `listRuns` directly.
 */
const runListRows = Effect.fn("runListRows")(function* ({
  teamIds,
  memberEmail = VIEWER,
  tab,
  team = null,
  limit = Domain.RUN_PAGE,
}: {
  readonly teamIds: readonly Domain.TeamId[];
  readonly memberEmail?: Domain.Email;
  readonly tab?: Domain.RunTab;
  readonly team?: Domain.TeamId | null;
  readonly limit?: number;
}) {
  const repository = yield* WorkflowRunRepository;
  const read = (wanted: Domain.RunTab) =>
    repository.listRuns({
      teamIds,
      memberEmail,
      query: { team, tab: wanted, limit },
    });
  if (tab !== undefined) return (yield* read(tab)).items;
  const rows: Domain.RunListItem[] = [];
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

/** The workflow with its own tasks as the start shape, for manual attach. */
const savedDetail = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const { workflow, tasks } = Option.getOrThrow(
      yield* workflows.getWorkflow({ workflowId }),
    );
    return { workflow, tasks } satisfies Domain.WorkflowDetail;
  });

/**
 * Two workflows, tags `a` and `b`, two tasks each (Team A then Team B),
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
        name: taskName("Cut"),
        teamId: TEAM_A.id,
      });
      yield* workflows.addStep({
        workflowId: created.id,
        name: taskName("Finish"),
        teamId: TEAM_B.id,
      });
      return yield* goLive(created.id);
    });
  const a = yield* createWorkflow("a");
  const b = yield* createWorkflow("b");
  return { a, b };
});

/**
 * One workflow, tag `s`, steps `1 1 2 3` owned by A, B, C, A — the parallel
 * fixture: two teams ready at once, a third waiting on both.
 */
const seedStepped = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  yield* workflows.replaceWorkflows({
    workflows: [
      {
        name: name("Stepped"),
        tag: workflowTag("s"),
        tasks: [
          {
            name: taskName("Artwork"),
            teamId: TEAM_A.id,
            step: 1,
            instructions: instructions("300 dpi"),
          },
          { name: taskName("Materials"), teamId: TEAM_B.id, step: 1 },
          { name: taskName("Produce"), teamId: TEAM_C.id, step: 2 },
          { name: taskName("Inspect"), teamId: TEAM_A.id, step: 3 },
        ],
      },
    ],
  });
});

/** Starts the stepped workflow on one line item and returns its run; `PROCESSED_AT` is ahead of the clock so the age rule passes. */
const steppedRun = () =>
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
      runs.completeTask({
        runTaskId: detail.tasks[position - 1]?.id ?? "",
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
        name: taskName("Rush"),
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

  it("setRun on a workflow whose earlier run was cancelled un-cancels it, tasks and all", () =>
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
        // The same row, back from cancelled with its finished task intact.
        strictEqual(set.run.id, first.run.id);
        strictEqual(set.replaced, null);
        strictEqual(set.run.status, "active");
        const [revived] = yield* runsForOrder();
        strictEqual(
          revived?.tasks.filter((task) => task.completedAt !== null).length,
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
  it("creates one run per matching line item with copied tasks and team names", () =>
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
          first?.tasks.map((s) => [s.position, s.name, s.teamName]),
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

  it("skips line items with no units to make", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"], { currentQuantity: 0 }),
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
            lineItem(1, ["a"], { currentQuantity: 0 }),
            lineItem(2, ["b"], { currentQuantity: 0 }),
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
        strictEqual(a?.tasks.length, 2);
        strictEqual(a?.tasks[0]?.completedAt !== null, true);

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
            lineItem(1, ["a"], { currentQuantity: 3 }),
            lineItem(2, ["b"], { currentQuantity: 3 }),
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
          [lineItem(1, ["a"], { currentQuantity: 5 })],
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
        strictEqual(flagged?.tasks.length, 2);

        // The units reaching zero is the ordinary end of a done run — the
        // line was edited away or refunded — so it is not a second change to
        // report.
        const zeroed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [lineItem(1, ["a"], { currentQuantity: 0 })],
        );
        deepStrictEqual(zeroed, {
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
        const changed = [lineItem(1, ["a"], { currentQuantity: 5 })];
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
              lineItem(1, ["a"], { currentQuantity: 0 }),
              lineItem(2, ["b"], { currentQuantity: 0 }),
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
    it("a refund that lowers currentQuantity alone updates pending silently and flags active", () =>
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
              lineItem(1, ["a"], { currentQuantity: 1 }),
              lineItem(2, ["b"], { currentQuantity: 1 }),
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

    it("a full refund cancels pending and flags active item_removed", () =>
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
              lineItem(1, ["a"], { currentQuantity: 0 }),
              lineItem(2, ["b"], { currentQuantity: 0 }),
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

    it("inserts snapshot currentQuantity, not the ordered quantity", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"], { quantity: 3, currentQuantity: 2 }),
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
          yield* runs.startTask({
            runTaskId: activeRun.tasks[0]?.id ?? "",
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
            [lineItem(1, ["a"]), lineItem(2, ["b"]), lineItem(3, [])],
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

    it("partial fulfillment changes no run", () =>
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
          // Shipping one line leaves every `currentQuantity` where it was,
          // which is the whole reason nothing here moves.
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fulfillmentStatus: "PARTIALLY_FULFILLED",
            }),
            [lineItem(1, ["a"]), lineItem(2, ["b"])],
          );
          deepStrictEqual(counts, {
            created: 0,
            cancelled: 0,
            flagged: 0,
            ambiguous: 0,
          });
          const after = yield* runsForOrder();
          const shipped = after.find((d) => d.run.id === shippedRun.run.id);
          strictEqual(shipped?.run.status, "active");
          strictEqual(shipped?.run.flag, null);
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

  it("starts nothing for an off workflow, a never-applied one, or an unassigned task", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const workflows = yield* WorkflowRepository;
        yield* turnOff(a.id);
        // Draft only: has tasks, never applied.
        const c = yield* workflows.createWorkflow({
          name: name("Drafted"),
          tag: workflowTag("c"),
        });
        yield* workflows.addStep({
          workflowId: c.id,
          name: taskName("Cut"),
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

describe("WorkflowRunRepository tasks, run list, flags, delete", () => {
  it("completeTask enforces team, order, and terminal state and records completedBy", () =>
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
        strictEqual(outOfOrder._tag, "TaskNotReadyError");

        yield* complete(detail, 1, [TEAM_A.id]);
        const active = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(active.run.status, "active");
        strictEqual(active.tasks[0]?.completedBy, "member-1");

        const repeat = yield* complete(detail, 1, [TEAM_A.id]).pipe(
          Effect.flip,
        );
        strictEqual(repeat._tag, "TaskNotReadyError");

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

  it("completeTask on a cancelled run is Terminal", () =>
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

  it("listRuns shows only current tasks for the given teams, flagged first", () =>
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

        const teamARows = yield* runListRows({ teamIds: [TEAM_A.id] });
        // Two runs of one order share `orderProcessedAt`, so the line item
        // orders them: the same order `listRunsForOrder` gave `first` and
        // `second`.
        deepStrictEqual(
          teamARows.map((item) => [item.run.id, item.tasks[0]?.name]),
          [
            [first.run.id, "Cut"],
            [second.run.id, "Cut"],
          ],
        );
        strictEqual(first.run.lineItemId < second.run.lineItemId, true);
        strictEqual((yield* runListRows({ teamIds: [TEAM_B.id] })).length, 0);
        strictEqual((yield* runListRows({ teamIds: [] })).length, 0);

        yield* complete(second, 1, [TEAM_A.id]);
        const teamBRows = yield* runListRows({ teamIds: [TEAM_B.id] });
        deepStrictEqual(
          teamBRows.map((item) => [item.run.id, item.tasks[0]?.name]),
          [[second.run.id, "Finish"]],
        );

        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"]),
        ]);
        // The flag decides the tab, not the position in one list: the
        // reconciled run leaves Up next for Blocked and the untouched one
        // stays.
        const blocked = yield* runListRows({
          teamIds: [TEAM_A.id, TEAM_B.id],
          tab: "attention",
        });
        deepStrictEqual(
          blocked.map((item) => [item.run.id, item.run.flag]),
          [[second.run.id, "item_removed"]],
        );
        /* The personalization is the work page's, not the row's, so it is
           read back off the run rather than off the list item. */
        const reconciled = yield* runsForOrder();
        strictEqual(
          reconciled.find((each) => each.run.id === second.run.id)?.run
            .customAttributes[0]?.value,
          "Hello 2",
        );
        deepStrictEqual(
          (yield* runListRows({
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

  it("copies step and instructions onto run tasks; ready rule gates completion across steps", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        deepStrictEqual(
          detail.tasks.map((s) => [s.name, s.step, s.instructions]),
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
        strictEqual(notReady._tag, "TaskNotReadyError");
        yield* complete(detail, 2, [TEAM_B.id]);
        const stillNotReady = yield* complete(detail, 3, [TEAM_C.id]).pipe(
          Effect.flip,
        );
        strictEqual(stillNotReady._tag, "TaskNotReadyError");
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        const done = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(done.run.status, "done");
      }),
    ));

  it("listRuns tiers by the reader: my started task is Mine, a teammate's is Teammates, a flag is Blocked for both", () =>
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
        yield* runs.startTask({
          runTaskId: mine.tasks[0]?.id ?? "",
          actor: maker,
          teamIds: [TEAM_A.id],
        });
        // A hold on the other run: the one flag a person sets, so the tier is
        // reached without disturbing either run's tasks.
        yield* runs.blockRun({
          runId: theirs.run.id,
          actor: maker,
          teamIds: [TEAM_A.id],
          reason: reason("Waiting on the customer"),
        });

        // The counts come back whatever tab is asked for, so one read per
        // reader says where every row landed for them.
        const countsFor = (memberEmail: Domain.Email) =>
          runs
            .listRuns({
              teamIds: [TEAM_A.id],
              memberEmail,
              query: { team: null, tab: "mine", limit: Domain.RUN_PAGE },
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
          (yield* runListRows({
            teamIds: [TEAM_A.id],
            memberEmail: VIEWER,
            tab: "inProgress",
          })).map((item) => item.run.id),
          [mine.run.id],
        );
        deepStrictEqual(
          (yield* runListRows({
            teamIds: [TEAM_A.id],
            memberEmail: maker.email,
            tab: "attention",
          })).map((item) => item.run.id),
          [theirs.run.id],
        );
      }),
    ));

  it("listRuns counts the whole tab and returns only the limit; the team counts ignore the narrowing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(
          order(),
          Array.from({ length: 12 }, (_, index) => lineItem(index + 1, ["a"])),
        );
        // An explicit limit rather than `RUN_PAGE`: what is on trial is that
        // the cut happens at the number asked for, not what that number is.
        const read = (limit: number) =>
          runs.listRuns({
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
            // Finish is step 2 and nothing is done, so B owns no ready task.
            [TEAM_B.id, 0],
          ],
        );

        const deeper = yield* read(20);
        strictEqual(deeper.items.length, 12);
        strictEqual(deeper.counts.upNext, 12);
      }),
    ));

  it("listRuns on the Done tab returns no items and counts the tiers all the same", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);

        const done = yield* runs.listRuns({
          teamIds: [TEAM_A.id],
          memberEmail: VIEWER,
          query: { team: null, tab: "done", limit: Domain.RUN_PAGE },
        });
        // The Done tab's rows are `listDone`'s; the strip above them is still
        // this read's, which is why the counts do not depend on the tab.
        strictEqual(done.items.length, 0);
        strictEqual(done.counts.upNext, 1);
        strictEqual(done.counts.total, 1);
      }),
    ));

  it("listRuns narrows rows and their tasks to one team, and a team the member is not on reads empty", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        yield* steppedRun();
        const teamIds = [TEAM_A.id, TEAM_B.id];

        const read = (team: Domain.TeamId | null) =>
          runs.listRuns({
            teamIds,
            memberEmail: VIEWER,
            query: { team, tab: "upNext", limit: Domain.RUN_PAGE },
          });

        const both = yield* read(null);
        deepStrictEqual(
          both.items.map((item) => item.tasks.map((task) => task.name)),
          [[taskName("Artwork"), taskName("Materials")]],
        );

        const onlyA = yield* read(TEAM_A.id);
        deepStrictEqual(
          onlyA.items.map((item) => item.tasks.map((task) => task.name)),
          [[taskName("Artwork")]],
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

  it("listRuns returns every ready task per run that the reader's teams own, with stepCount", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const detail = yield* steppedRun();

        const teamA = yield* runListRows({ teamIds: [TEAM_A.id] });
        strictEqual(teamA.length, 1);
        strictEqual(teamA[0]?.stepCount, 3);
        deepStrictEqual(
          teamA[0]?.tasks.map((s) => [s.name, s.step]),
          [["Artwork", 1]],
        );
        const both = yield* runListRows({ teamIds: [TEAM_A.id, TEAM_B.id] });
        strictEqual(both.length, 1);
        deepStrictEqual(
          both[0]?.tasks.map((s) => s.name),
          ["Artwork", "Materials"],
        );

        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 0);
        yield* complete(detail, 1, [TEAM_A.id]);
        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 0);
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamC = yield* runListRows({ teamIds: [TEAM_C.id] });
        deepStrictEqual(
          teamC[0]?.tasks.map((s) => [s.name, s.step]),
          [["Produce", 2]],
        );
      }),
    ));

  it("startTask marks the run active, never takes over, and respects readiness and team", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const produce = detail.tasks[2]?.id ?? "";

        const wrongTeam = yield* runs
          .startTask({
            runTaskId: artwork,
            actor: memberActor("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        const notReady = yield* runs
          .startTask({
            runTaskId: produce,
            actor: memberActor("m3"),
            teamIds: [TEAM_C.id],
          })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "TaskNotReadyError");

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const started = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(started.run.status, "active");
        strictEqual(started.tasks[0]?.startedBy, "m1");
        strictEqual(started.tasks[0]?.startedAt !== null, true);
        strictEqual(started.tasks[0]?.completedAt, null);

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const again = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(again.tasks[0]?.startedBy, "m1");

        // Done without Start backfills who started.
        yield* complete(detail, 2, [TEAM_B.id]);
        const materials = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[1];
        strictEqual(materials?.startedBy, "member-1");
        strictEqual(materials?.completedBy, "member-1");
        strictEqual(materials?.startedAt, materials?.completedAt);
      }),
    ));

  it("Undo returns a task to Ready, un-readies the next step, and is refused once downstream started", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        const produce = detail.tasks[2]?.id ?? "";

        // Not yet done: nothing to undo.
        strictEqual(
          (yield* runs
            .uncompleteTask({
              runTaskId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_A.id],
            })
            .pipe(Effect.flip))._tag,
          "TaskNotReadyError",
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        // Step 2 is ready now; Team C's list has Produce.
        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 1);
        // Wrong team.
        strictEqual(
          (yield* runs
            .uncompleteTask({
              runTaskId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_B.id],
            })
            .pipe(Effect.flip))._tag,
          "RunNotAllowedError",
        );
        // Anyone on the task's team may undo, not only who pressed Done.
        yield* runs.uncompleteTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const undone = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(undone.tasks[0]?.completedAt, null);
        strictEqual(undone.tasks[0]?.completedBy, null);
        strictEqual(undone.tasks[0]?.startedAt, null);
        strictEqual(undone.tasks[0]?.startedBy, null);
        strictEqual(undone.tasks[0]?.startedByEmail, null);
        strictEqual(undone.tasks[0]?.startedByRole, null);
        strictEqual(undone.run.status, "active");
        // Produce left Team C's list: step 1 is open again.
        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 0);
        strictEqual(
          (yield* runListRows({ teamIds: [TEAM_A.id] }))[0]?.tasks[0]?.id,
          artwork,
        );

        // Once downstream has started, undo is refused and names them.
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.startTask({
          runTaskId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .uncompleteTask({
            runTaskId: materials,
            actor: memberActor("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "TaskUndoBlockedError");
        if (blocked._tag === "TaskUndoBlockedError") {
          strictEqual(blocked.taskName, "Produce");
          strictEqual(blocked.teamName, "Team C");
        }

        // Undoing the last task turns a done run back to active.
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "done",
        );
        yield* runs.uncompleteTask({
          runTaskId: detail.tasks[3]?.id ?? "",
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
            .uncompleteTask({
              runTaskId: produce,
              actor: memberActor("m1"),
              teamIds: [TEAM_C.id],
            })
            .pipe(Effect.flip))._tag,
          "RunTerminalError",
        );
      }),
    ));

  it("Put back clears the Start record of an in-progress task", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "active",
        );
        // Anyone on the task's team, not only the starter.
        yield* runs.unstartTask({
          runTaskId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        const task = after.tasks[0];
        strictEqual(task?.startedAt, null);
        strictEqual(task?.startedBy, null);
        strictEqual(task?.startedByEmail, null);
        strictEqual(task?.startedByRole, null);
        strictEqual(task?.reopenedAt, null);
        // The only started task put back: the run is untouched again.
        strictEqual(after.run.status, "pending");
        // Ready again: it is on Team A's list as a Start.
        const view = Option.getOrThrow(
          yield* runs.getRunView({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        strictEqual(
          view.tasks.find((each) => each.id === artwork)?.ready,
          true,
        );
      }),
    ));

  it("Put back is refused on an unstarted task, a finished task, a flagged run, another team's task, and a cancelled run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        const unstart = (runTaskId: string, teamIds: readonly string[]) =>
          runs
            .unstartTask({ runTaskId, actor: memberActor("m1"), teamIds })
            .pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            );

        strictEqual(yield* unstart(artwork, [TEAM_A.id]), "TaskNotReadyError");

        yield* complete(detail, 2, [TEAM_B.id]);
        strictEqual(
          yield* unstart(materials, [TEAM_B.id]),
          "TaskNotReadyError",
        );

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(yield* unstart(artwork, [TEAM_B.id]), "RunNotAllowedError");

        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: null,
        });
        strictEqual(yield* unstart(artwork, [TEAM_A.id]), "RunFlaggedError");
        // The merchant is held by the flag too.
        strictEqual(
          (yield* runs
            .unstartTask({ runTaskId: artwork, actor: MERCHANT })
            .pipe(Effect.flip))._tag,
          "RunFlaggedError",
        );

        yield* runs.cancelRun({ runId: detail.run.id });
        strictEqual(yield* unstart(artwork, [TEAM_A.id]), "RunTerminalError");
      }),
    ));

  it("the merchant puts back a member's Start", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.unstartTask({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.startedAt, null);
        strictEqual(task?.startedByRole, null);
      }),
    ));

  it("listDone lists the team's recent completions newest first with the undo verdict; getRunView decorates every task", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
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
        strictEqual(teamA.items[0]?.task.name, "Artwork");
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
        yield* runs.startTask({
          runTaskId: detail.tasks[2]?.id ?? "",
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
            entry.task.name,
            entry.undoBlockedBy?.taskName,
          ]),
          [
            [taskName("Materials"), taskName("Produce")],
            [taskName("Artwork"), taskName("Produce")],
          ],
        );

        const view = Option.getOrThrow(
          yield* runs.getRunView({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        deepStrictEqual(
          view.tasks.map((task) => [
            task.name,
            task.ready,
            task.undoBlockedBy?.teamName ?? null,
          ]),
          [
            ["Artwork", false, "Team C"],
            ["Materials", false, "Team C"],
            ["Produce", true, null],
            ["Inspect", false, null],
          ],
        );
        // No task on the caller's teams, or no such run: the same None.
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

  it("setRunNote writes, overwrites, clears; allowed on a done run; refused on a cancelled run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const set = (value: Domain.RunNote | null, teamIds = [TEAM_A.id]) =>
          runs.setRunNote({ runId: detail.run.id, teamIds, note: value });
        const runNote = () =>
          Effect.map(
            runs.getRun({ runId: detail.run.id }),
            (run) => Option.getOrThrow(run).run.note,
          );
        yield* set(note("first"));
        strictEqual(yield* runNote(), "first");
        yield* set(note("second"));
        strictEqual(yield* runNote(), "second");
        yield* set(null);
        strictEqual(yield* runNote(), null);
        // The whole run done: a note is a record, not work, so it still lands.
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .status,
          "done",
        );
        yield* set(note("noticed after the last Done"));
        strictEqual(yield* runNote(), "noticed after the last Done");
        // A done run is not cancelled from here; undo the last task first.
        yield* runs.uncompleteTask({
          runTaskId: detail.tasks[3]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* set(note("nope")).pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("setRunNote admits a member whose team has any task of the run, ready or not, and refuses one whose team has none", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        // Team C's task is two steps out: nothing of theirs is ready.
        yield* runs.setRunNote({
          runId: detail.run.id,
          teamIds: [TEAM_C.id],
          note: note("heads up"),
        });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .note,
          "heads up",
        );
        const outsider = yield* runs
          .setRunNote({
            runId: detail.run.id,
            teamIds: [teamId("team-z")],
            note: note("x"),
          })
          .pipe(Effect.flip);
        strictEqual(outsider._tag, "RunNotAllowedError");
      }),
    ));

  it("a flag refuses Start and Done but not Undo or the note, and dismissing it lets work resume", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
          reason: null,
        });
        const start = yield* runs
          .startTask({
            runTaskId: materials,
            actor: memberActor("m2"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(start._tag, "RunFlaggedError");
        const done = yield* complete(detail, 2, [TEAM_B.id]).pipe(Effect.flip);
        strictEqual(done._tag, "RunFlaggedError");
        yield* runs.setRunNote({
          runId: detail.run.id,
          teamIds: [TEAM_B.id],
          note: note("waiting on stock"),
        });
        yield* runs.uncompleteTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.dismissFlag({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        yield* complete(detail, 2, [TEAM_B.id]);
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.tasks[0]?.completedAt, null);
        strictEqual(after.tasks[1]?.completedAt !== null, true);
      }),
    ));

  it("blockRun sets the flag with reason and by; dismiss clears; a later reconcile flag overwrites", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
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
          reason: reason("Out of chain"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(blocked.run.flag, "blocked");
        deepStrictEqual<unknown>(blocked.run.flagDetail, {
          reason: "Out of chain",
          by: { role: "member", memberId: "m1", email: "m1@example.com" },
        });
        const rows = yield* runListRows({ teamIds: [TEAM_B.id] });
        strictEqual(rows[0]?.run.flag, "blocked");

        yield* runs.dismissFlag({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(cleared.run.flag, null);

        // Started before the block, since a flag refuses Start: a started
        // run is active, so reconcile's zeroed line item flags rather than
        // cancels, and that reconcile flag overwrites the person's block.
        yield* runs.startTask({
          runTaskId: detail.tasks[0]?.id ?? "",
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
          [lineItem(1, ["s"], { currentQuantity: 0 })],
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
   * the merchant reading the run list is chasing the person who blocked it, not
   * whoever last fixed a typo.
   */
  it("setBlockReason rewrites the reason, keeps by, and refuses anything that is not a standing block", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const flagDetail = () =>
          runs
            .getRun({ runId: detail.run.id })
            .pipe(Effect.map((run) => Option.getOrThrow(run).run.flagDetail));

        const unflagged = yield* runs
          .setBlockReason({
            runId: detail.run.id,
            teamIds: [TEAM_B.id],
            reason: reason("too early"),
          })
          .pipe(Effect.flip);
        // Its own tag: the caller's teams were fine, the hold was the thing
        // missing, and the page says so rather than crying team.
        strictEqual(unflagged._tag, "RunNotBlockedError");

        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: reason("Waiting on stones"),
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
            reason: reason("nope"),
          })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");

        // A teammate, not the blocker, and the text keeps its line breaks.
        yield* runs.setBlockReason({
          runId: detail.run.id,
          teamIds: [TEAM_B.id],
          reason: reason("Waiting on stones\nCalled the supplier"),
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

  it("merchant completes an unassigned task: no team clause, and the merchant fills both actor slots", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const sql = yield* SqlClient.SqlClient;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        // The state a team delete leaves behind: on nobody's list, which is
        // the very run the merchant is there to unstick.
        yield* sql`update WorkflowRunTask set teamId = null where id = ${artwork}`;
        const refused = yield* runs
          .completeTask({
            runTaskId: artwork,
            actor: memberActor("m1"),
            teamIds: [TEAM_A.id],
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotAllowedError");
        yield* runs.completeTask({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.completedByRole, "merchant");
        strictEqual(task?.completedBy, null);
        strictEqual(task?.completedByEmail, null);
        strictEqual(task?.startedByRole, "merchant");
        strictEqual(task?.startedBy, null);
        strictEqual(task?.startedByEmail, null);
        deepStrictEqual<unknown>(Domain.taskCompletedBy(task), {
          role: "merchant",
        });
      }),
    ));

  it("merchant completes over a member's start: the started slot keeps the member", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.completeTask({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.startedByRole, "member");
        strictEqual(task?.startedByEmail, "m1@example.com");
        strictEqual(task?.completedByRole, "merchant");
        strictEqual(task?.completedByEmail, null);
      }),
    ));

  it("Undo returns a task to Ready whoever started it, member or merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const taskNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [task] = Option.getOrThrow(run).tasks;
            if (task === undefined) throw new Error("no task");
            return task;
          });
        yield* runs.completeTask({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.uncompleteTask({ runTaskId: artwork, actor: MERCHANT });
        const reopened = yield* taskNow();
        strictEqual(reopened.startedAt, null);
        strictEqual(reopened.startedByRole, null);
        strictEqual(Domain.taskStartedBy(reopened), null);
        strictEqual(reopened.reopenedByRole, "merchant");

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const started = yield* taskNow();
        strictEqual(started.startedByRole, "member");
        strictEqual(started.startedByEmail, "m1@example.com");

        yield* runs.completeTask({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.uncompleteTask({ runTaskId: artwork, actor: MERCHANT });
        const ready = yield* taskNow();
        strictEqual(ready.startedAt, null);
        strictEqual(ready.startedBy, null);
        strictEqual(ready.startedByEmail, null);
        strictEqual(ready.startedByRole, null);
        strictEqual(ready.completedAt, null);
        strictEqual(ready.reopenedByRole, "merchant");
      }),
    ));

  it("undo records the reopener and the next Done clears the slot, for a member and for the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const taskNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [task] = Option.getOrThrow(run).tasks;
            if (task === undefined) throw new Error("no task");
            return task;
          });
        yield* runs.completeTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.uncompleteTask({
          runTaskId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const byMember = yield* taskNow();
        strictEqual(byMember.reopenedByRole, "member");
        strictEqual(byMember.reopenedByEmail, "m2@example.com");
        strictEqual(typeof byMember.reopenedAt, "number");
        deepStrictEqual<unknown>(Domain.taskReopenedBy(byMember), {
          role: "member",
          email: "m2@example.com",
        });

        yield* runs.completeTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const redone = yield* taskNow();
        strictEqual(redone.reopenedAt, null);
        strictEqual(redone.reopenedByRole, null);
        strictEqual(redone.reopenedByEmail, null);
        strictEqual(Domain.taskReopenedBy(redone), null);

        yield* runs.uncompleteTask({ runTaskId: artwork, actor: MERCHANT });
        const byMerchant = yield* taskNow();
        strictEqual(byMerchant.reopenedByRole, "merchant");
        strictEqual(byMerchant.reopenedByEmail, null);
        strictEqual(byMerchant.completedAt, null);
        strictEqual(byMerchant.completedByRole, null);
      }),
    ));

  it("the merchant is held to every rule but the team one: step order, terminal runs, and the downstream undo guard", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const [artwork, materials, produce] = [
          detail.tasks[0]?.id ?? "",
          detail.tasks[1]?.id ?? "",
          detail.tasks[2]?.id ?? "",
        ];
        // Step 2 is not ready while step 1 is open.
        const notReady = yield* runs
          .completeTask({ runTaskId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "TaskNotReadyError");

        yield* runs.completeTask({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.completeTask({ runTaskId: materials, actor: MERCHANT });
        // A member downstream blocks the merchant's undo exactly as it would
        // block a teammate's.
        yield* runs.startTask({
          runTaskId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .uncompleteTask({ runTaskId: artwork, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "TaskUndoBlockedError");
        strictEqual(
          blocked._tag === "TaskUndoBlockedError" ? blocked.taskName : null,
          "Produce",
        );
        strictEqual(
          blocked._tag === "TaskUndoBlockedError" ? blocked.teamName : null,
          TEAM_C.name,
        );

        yield* runs.cancelRun({ runId: detail.run.id });
        const terminal = yield* runs
          .completeTask({ runTaskId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(terminal._tag, "RunTerminalError");
      }),
    ));

  it("setRunNote records no author: last write wins, the same rule as setBlockReason", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        yield* runs.setRunNote({
          runId: detail.run.id,
          teamIds: [TEAM_A.id],
          note: note("scuffed"),
        });
        yield* runs.setRunNote({
          runId: detail.run.id,
          note: note("customer approved"),
        });
        const { run } = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(run.note, "customer approved");
        deepStrictEqual(
          Object.keys(run).filter((key) => key.startsWith("note")),
          ["note"],
        );
      }),
    ));

  it("blockRun and dismissFlag by the merchant: no ready-team requirement, and the flag records the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: MERCHANT,
          reason: reason("waiting on the customer"),
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

  it("a started but uncompleted task protects the run from silent cancel on reconcile", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* WorkflowRunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        yield* runs.startTask({
          runTaskId: detail.tasks[0]?.id ?? "",
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

  it("an edit after turn-on still starts the workflow's tasks; apply while on replaces them and earlier runs keep their copies", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        deepStrictEqual(
          first.tasks.map((s) => s.name),
          ["Cut", "Finish"],
        );

        // Edit, then a third task on the draft: the workflow is unchanged.
        yield* workflows.createDraft({ workflowId: a.id });
        yield* workflows.addStep({
          workflowId: a.id,
          name: taskName("Pack"),
          teamId: TEAM_C.id,
        });
        const edited = Option.getOrThrow(
          yield* workflows.getWorkflow({ workflowId: a.id }),
        );
        strictEqual(edited.tasks.length, 2);
        strictEqual(edited.draft?.tasks.length, 3);
        const second = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["a"])],
        );
        strictEqual(second.created, 1);
        const late = (yield* runsForOrder()).find(
          (d) => d.run.lineItemId === lineItem(2, []).id,
        );
        deepStrictEqual(
          late?.tasks.map((s) => s.name),
          ["Cut", "Finish"],
        );

        // Apply while on: the next order gets three tasks, the earlier runs
        // keep their copied tasks.
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
          newest?.tasks.map((s) => s.name),
          ["Cut", "Finish", "Pack"],
        );
        const oldest = all.find((d) => d.run.id === first.run.id);
        strictEqual(oldest?.tasks.length, 2);
      }),
    ));
  it("deleteWorkflow leaves its runs and run tasks, open and finished; the run list, order view, start, complete, block, and cancel still work on them", () =>
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
        for (const task of finished.tasks)
          yield* runs.completeTask({
            runTaskId: task.id,
            actor: memberActor("m1"),
            teamIds: task.teamId === null ? [] : [task.teamId],
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
          orphan?.tasks.map((task) => [task.name, task.teamName]),
          [
            ["Cut", TEAM_A.name],
            ["Finish", TEAM_B.name],
          ],
        );
        const done = remaining.find((d) => d.run.id === finished.run.id);
        strictEqual(done?.run.status, "done");
        strictEqual(
          done?.tasks.every((task) => task.completedAt !== null),
          true,
        );

        // The orphan is still listed, and every task write still lands. Found
        // by id rather than by position: which run it is does not matter here.
        const listed = yield* runListRows({ teamIds: [TEAM_A.id] });
        strictEqual(
          listed.some((item) => item.run.id === stillOpen.run.id),
          true,
        );
        const [cut, finish] = stillOpen.tasks;
        if (cut === undefined || finish === undefined)
          throw new Error("no tasks");
        yield* runs.startTask({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.completeTask({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.assignRunTaskTeam({
          runTaskId: finish.id,
          team: TEAM_C,
        });
        const [reassigned] = yield* runListRows({ teamIds: [TEAM_C.id] });
        strictEqual(reassigned?.tasks[0]?.id, finish.id);
        yield* runs.blockRun({
          runId: stillOpen.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_C.id],
          reason: reason("waiting on stock"),
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
          name: taskName("Cut"),
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

  it("start, complete, and block snapshot the actor's email onto the row; listRuns reads it back with no roster", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* WorkflowRunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        // Done without Start backfills the starter's email too.
        yield* runs.completeTask({
          runTaskId: materials,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        deepStrictEqual(
          after.tasks
            .slice(0, 2)
            .map((s) => [s.startedByEmail, s.completedByEmail]),
          [
            ["m1@example.com", null],
            ["m2@example.com", "m2@example.com"],
          ],
        );
        const [listed] = yield* runListRows({ teamIds: [TEAM_A.id] });
        strictEqual(listed?.tasks[0]?.startedByEmail, "m1@example.com");
      }),
    ));

  it("unassignTeam nulls open run tasks only; the task leaves every list and cannot be worked; assignRunTaskTeam brings it back", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("no run");
        const [cut, finish] = run.tasks;
        if (cut === undefined || finish === undefined)
          throw new Error("no tasks");
        // Finish Cut (Team A) so it is the finished task that keeps its pointer.
        yield* runs.completeTask({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* workflows.unassignTeam({ teamId: TEAM_A.id });
        yield* workflows.unassignTeam({ teamId: TEAM_B.id });
        const nulled = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        );
        deepStrictEqual(
          nulled.tasks.map((s) => [s.teamId, s.teamName]),
          [
            [TEAM_A.id, "Team A"],
            [null, "Team B"],
          ],
        );
        strictEqual((yield* runListRows({ teamIds: [TEAM_B.id] })).length, 0);
        const refused = yield* runs
          .startTask({
            runTaskId: finish.id,
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
        // A task of a run that is not open keeps its pointer: cancelled here,
        // then un-cancelled so the assign below is on an open run again.
        yield* runs.cancelRun({ runId: run.run.id });
        const notOpen = yield* runs
          .assignRunTaskTeam({ runTaskId: finish.id, team: TEAM_C })
          .pipe(Effect.flip);
        strictEqual(notOpen._tag, "RunTerminalError");
        yield* runs.uncancelRun({ runId: run.run.id });
        // Assign Team C: name snapshotted, task on C's list, workable.
        yield* runs.assignRunTaskTeam({ runTaskId: finish.id, team: TEAM_C });
        const assigned = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        );
        deepStrictEqual(
          [assigned.tasks[1]?.teamId, assigned.tasks[1]?.teamName],
          [TEAM_C.id, "Team C"],
        );
        const [listed] = yield* runListRows({ teamIds: [TEAM_C.id] });
        strictEqual(listed?.tasks[0]?.id, finish.id);
        yield* runs.completeTask({
          runTaskId: finish.id,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        // A finished task is never reassigned; a missing task is not found.
        strictEqual(
          (yield* runs
            .assignRunTaskTeam({ runTaskId: finish.id, team: TEAM_A })
            .pipe(Effect.flip))._tag,
          "TaskFinishedError",
        );
        strictEqual(
          (yield* runs
            .assignRunTaskTeam({ runTaskId: "nope", team: TEAM_A })
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
          // Finish the one run: both tasks done takes it out of `pending`/
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

/** The outbox as the meter left it: one row per order billed, newest last. */
const usageEvents = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`select idempotencyKey, value from UsageEvent order by rowid`;
  });

const usage = () =>
  OrderRepository.pipe(Effect.flatMap((orders) => orders.getUsage()));

describe("WorkflowRunRepository metering", () => {
  it("an order is counted once, when its first run is created", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        // Two matched lines, so two runs are created in the one reconcile —
        // and the order is still one order.
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        strictEqual(counts.created, 2);
        strictEqual((yield* usage()).ordersThisCycle, 1);
        deepStrictEqual(yield* usageEvents(), [
          { idempotencyKey: `${ORDER_ID}#count`, value: 1 },
        ]);

        // A second knock re-reconciles and creates nothing; `countedAt` is
        // what keeps it from billing again.
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        strictEqual((yield* usage()).ordersThisCycle, 1);
        strictEqual((yield* usageEvents()).length, 1);
      }),
    ));

  it("a paid order with no matching line is not counted", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        // Paid, stored, displayed — and no tag any workflow claims, so Baton
        // never carried the work and the merchant is not billed for it.
        const counts = yield* upsertAndReconcile(order(), [lineItem(1, [])]);
        strictEqual(counts.created, 0);
        strictEqual((yield* usage()).ordersThisCycle, 0);
        deepStrictEqual(yield* usageEvents(), []);
      }),
    ));

  it("a manual run start counts the order if nothing has yet", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* WorkflowRunRepository;
        const orders = yield* OrderRepository;
        // Unpaid, so reconcile starts nothing and counts nothing; the
        // merchant attaches a workflow by hand.
        yield* upsertAndReconcile(order({ fullyPaid: false }), [
          lineItem(1, []),
        ]);
        strictEqual((yield* usage()).ordersThisCycle, 0);
        const stored = Option.getOrThrow(
          yield* orders.getLineItem("gid://shopify/LineItem/1"),
        );
        yield* runs.setRun({
          workflow: yield* savedDetail(a.id),
          teams: TEAMS,
          order: stored.order,
          lineItem: stored.lineItem,
          source: "manual",
        });
        strictEqual((yield* usage()).ordersThisCycle, 1);
        deepStrictEqual(yield* usageEvents(), [
          { idempotencyKey: `${ORDER_ID}#count`, value: 1 },
        ]);
      }),
    ));

  it("cancelling an order after its run was created queues nothing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        strictEqual((yield* usage()).ordersThisCycle, 1);
        const counts = yield* upsertAndReconcile(
          order({
            updatedAt: PROCESSED_AT + 1,
            cancelledAt: PROCESSED_AT + 1,
          }),
          [lineItem(1, ["a"])],
        );
        strictEqual(counts.cancelled, 1);
        // The count is never given back: the shop carried the work up to the
        // moment the merchant stopped it.
        strictEqual((yield* usage()).ordersThisCycle, 1);
        deepStrictEqual(yield* usageEvents(), [
          { idempotencyKey: `${ORDER_ID}#count`, value: 1 },
        ]);
      }),
    ));
});
