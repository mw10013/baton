import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { type ReconcileCounts, RunRepository } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

type Services =
  | OrderRepository
  | WorkflowRepository
  | RunRepository
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
            Layer.mergeAll(WorkflowRepository.layer, RunRepository.layer).pipe(
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

/** Nobody's list in particular: a reader who has started nothing, so `viewOf` never answers "mine". */
const VIEWER = emailOf("viewer@example.com");

/** The four views whose rows `listRuns` returns; "done" is `listRecent`'s. */
const RUN_VIEWS = [
  "mine",
  "upNext",
  "teammates",
  "blocked",
] as const satisfies readonly Domain.WorkflowsListView[];

/**
 * The rows `listRuns` returns, flattened back into one list in view-row order,
 * so a test that only cares about *which* runs are listed reads the same as it
 * did before the read became one view at a time. `view` names the single view
 * where that is what the test is about; tests about the views themselves call
 * `listRuns` directly.
 */
const runListRows = Effect.fn("runListRows")(function* ({
  teamIds,
  memberEmail = VIEWER,
  view,
  team = null,
  limit = Domain.RUN_PAGE,
}: {
  readonly teamIds: readonly Domain.TeamId[];
  readonly memberEmail?: Domain.Email;
  readonly view?: Domain.WorkflowsListView;
  readonly team?: Domain.TeamId | null;
  readonly limit?: number;
}) {
  const repository = yield* RunRepository;
  const read = (wanted: Domain.WorkflowsListView) =>
    repository.listRuns({
      teamIds,
      memberEmail,
      query: { team, view: wanted, limit },
    });
  if (view !== undefined) return (yield* read(view)).items;
  const rows: Domain.RunListItem[] = [];
  for (const wanted of RUN_VIEWS) rows.push(...(yield* read(wanted)).items);
  return rows;
});

const ORDER_ID = "gid://shopify/Order/1";
/** The fixtures' placed date; no rule compares it with a workflow. */
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
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: "Gift wrap please",
  lineItemsTruncated: false,
  syncedAt: PROCESSED_AT,
  ...overrides,
});

const lineItem = (
  n: number,
  productTags: readonly string[],
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: `gid://shopify/LineItem/${String(n)}`,
  orderId: ORDER_ID,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 2,
  currentQuantity: 2,
  productTags,
  properties: [{ key: "Engraving", value: `Hello ${String(n)}` }],
  ...overrides,
});

/** Apply the draft and switch the workflow on: what the ordinary path needs before anything starts. Returns the workflow row. */
const goLive = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.applyDraft({ workflowId, teams: TEAMS });
    return yield* workflows.setWorkflowOn({
      workflowId,
      on: true,
      teams: TEAMS,
    });
  });

/** Turn off: new runs stop, open runs keep going. */
const turnOff = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.setWorkflowOn({
      workflowId,
      on: false,
      teams: TEAMS,
    });
  });

const turnOn = (workflowId: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    yield* workflows.setWorkflowOn({
      workflowId,
      on: true,
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
 * applied and on, and an order with one item per tag. `updatedAt`
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
 * fixture: two teams current at once, a third waiting on both.
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

/** Starts the stepped workflow on one item and returns its run. */
const steppedRun = () =>
  Effect.gen(function* () {
    yield* upsertAndReconcile(order(), [lineItem(1, ["s"])]);
    const [detail] = yield* runsForOrder();
    if (detail === undefined) throw new Error("no run");
    return detail;
  });

const loadEligibleContext = Effect.gen(function* () {
  const workflows = yield* (yield* WorkflowRepository).listOnWorkflowDetails();
  return { workflows, teams: TEAMS } satisfies Domain.EligibleContext;
});

const upsertAndReconcile = (
  shopOrder: Domain.ShopOrder,
  lineItems: readonly Domain.OrderLineItem[],
  teams: Domain.EligibleContext["teams"] = TEAMS,
) =>
  Effect.gen(function* () {
    const runs = yield* RunRepository;
    const orders = yield* OrderRepository;
    const context = { ...(yield* loadEligibleContext), teams };
    const counts = yield* Ref.make<ReconcileCounts>({
      created: 0,
      resized: 0,
      closed: 0,
      multiMatch: 0,
      ceilingReleased: false,
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
  RunRepository.pipe(
    Effect.flatMap((runs) => runs.listRunsForOrder({ orderId: ORDER_ID })),
  );

const complete = (
  detail: Domain.RunDetail,
  position: number,
  teamIds: readonly string[],
) =>
  RunRepository.pipe(
    Effect.flatMap((runs) =>
      runs.markTaskDone({
        runTaskId: detail.tasks[position - 1]?.id ?? "",
        actor: memberActor("member-1"),
        teamIds,
      }),
    ),
  );

/** The `task` entries of a Done or closed read. */
const taskItems = (items: readonly Domain.RecentItem[]) =>
  items.flatMap((item) => (item.kind === "task" ? [item] : []));

/** A Done or closed read as one line per entry, "task <name>" or "closed <reason>". */
const shape = (items: readonly Domain.RecentItem[]) =>
  items.map((item) =>
    item.kind === "task"
      ? `task ${item.task.name}`
      : `closed ${item.run.closedReason ?? ""}`,
  );

/** The workflows that match the item now ({@link Domain.matchedWorkflows}), their ids sorted. */
const matchedIds = (item: Domain.OrderLineItem) =>
  loadEligibleContext.pipe(
    Effect.map(({ workflows, teams }) =>
      Domain.matchedWorkflows(item, workflows, teams)
        .map(({ workflow }) => workflow.id)
        .toSorted(),
    ),
  );

/**
 * One row per item, whatever its state, `closed` included. The invariant is
 * `unique (lineItemId)`, so these cover both halves: what the write paths do
 * about it, and that the index itself is really there.
 */
describe("RunRepository one row per item", () => {
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

  const ITEM_1 = lineItem(1, ["a", "rush"]);

  it("creates nothing when two workflows match", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const rival = yield* rivalOn("rush");
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a", "rush"]),
        ]);
        deepStrictEqual(counts, {
          created: 0,
          resized: 0,
          closed: 0,
          multiMatch: 1,
          ceilingReleased: false,
        });
        strictEqual((yield* runsForOrder()).length, 0);
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id, rival.id].toSorted());
      }),
    ));

  it("turning one of the two off resolves the multi-match and starts the survivor", () =>
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
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 1);
        strictEqual(runs[0]?.run.workflowId, a.id);
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id]);
      }),
    ));

  it("a live run wins: a second workflow turned on later creates nothing", () =>
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
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 1);
        strictEqual(runs[0]?.run.workflowId, a.id);
        // Both match even though only one ever created a run: the match is
        // not the run.
        deepStrictEqual(yield* matchedIds(ITEM_1), [a.id, rival.id].toSorted());
      }),
    ));

  it("setRun over an open run deletes it in the same transaction and reports it as replaced", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const runs = yield* RunRepository;
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
          }),
        );
        strictEqual(set.replaced?.id, before.run.id);
        strictEqual(set.run.workflowId, b.id);
        strictEqual(set.run.state, "open");
        const after = yield* runsForOrder();
        deepStrictEqual(
          after.map((d) => d.run.id),
          [set.run.id],
        );
      }),
    ));

  it("setRun over a done run is refused, naming the done workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const runs = yield* RunRepository;
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
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotOpenError");
        if (refused._tag === "RunNotOpenError")
          strictEqual(refused.workflowName, detail.run.workflowName);
        strictEqual((yield* runsForOrder()).length, 1);
      }),
    ));

  it("a closed run holds its item and a manual attach replaces it", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* RunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [first] = yield* runsForOrder();
        if (first === undefined) throw new Error("no run");
        yield* complete(first, 1, [TEAM_A.id]);
        yield* runs.cancelRun({ runId: first.run.id });
        // The tag still matches and the order is open and paid; the closed
        // row is what keeps reconcile from starting the item again.
        const again = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        strictEqual(again.created, 0);
        deepStrictEqual(
          (yield* runsForOrder()).map((d) => d.run.id),
          [first.run.id],
        );
        const set = Option.getOrThrow(
          yield* runs.setRun({
            workflow: yield* savedDetail(a.id),
            teams: TEAMS,
            order: order(),
            lineItem: items[0] ?? lineItem(1, ["a"]),
          }),
        );
        // A new row from the definition, even of the closed workflow:
        // nothing of the closed run comes back, and it was not open.
        strictEqual(set.replaced, null);
        strictEqual(set.run.state, "open");
        const [fresh, ...rest] = yield* runsForOrder();
        strictEqual(rest.length, 0);
        strictEqual(fresh?.run.id, set.run.id);
        strictEqual(fresh?.run.id === first.run.id, false);
        strictEqual(
          fresh?.tasks.filter((task) => task.doneAt !== null).length,
          0,
        );
      }),
    ));

  it("the unique index itself refuses a second row for an item, and a closed run still holds its item", () =>
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
          insert into Run (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity,
            lineItemProperties, state,
            createdAt, updatedAt
          ) values (
            'raw', ${b.id}, 'Workflow b', ${ORDER_ID}, '#1001', 0,
            ${live.run.lineItemId}, 'Item', null, null, 1,
            '[]', 'open', 0, 0
          )
        `);
        strictEqual(raw._tag, "SqlError");
        strictEqual((yield* runsForOrder()).length, 1);
        strictEqual(live.run.workflowId, a.id);
        // The closed run Cancel workflow leaves is the item's one row, not a row
        // beside it: the same insert is still refused.
        yield* (yield* RunRepository).cancelRun({
          runId: live.run.id,
        });
        const again = yield* Effect.flip(sql`
          insert into Run (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity,
            lineItemProperties, state,
            createdAt, updatedAt
          ) values (
            'raw', ${b.id}, 'Workflow b', ${ORDER_ID}, '#1001', 0,
            ${live.run.lineItemId}, 'Item', null, null, 1,
            '[]', 'open', 0, 0
          )
        `);
        strictEqual(again._tag, "SqlError");
        strictEqual((yield* runsForOrder()).length, 1);
      }),
    ));
});

describe("RunRepository.reconcileOrder", () => {
  it("creates one run per matching item with copied tasks and team names", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["A"]),
          lineItem(2, ["b", "other"]),
        ]);
        deepStrictEqual(counts, {
          created: 2,
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const runs = yield* runsForOrder();
        strictEqual(runs.length, 2);
        const [first] = runs;
        strictEqual(first?.run.state, "open");
        strictEqual(Domain.runIsUnstarted(first?.tasks ?? []), true);
        strictEqual(first?.run.quantity, 2);
        strictEqual(first?.run.lineItemProperties?.[0]?.value, "Hello 1");
        deepStrictEqual(
          first?.tasks.map((s) => [s.position, s.name, s.teamName]),
          [
            [1, "Cut", "Team A"],
            [2, "Finish", "Team B"],
          ],
        );
      }),
    ));

  it("every item property is kept, underscore-prefixed keys included", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const properties = [
          { key: "_ioid", value: "x" },
          { key: "Engraving", value: "Hi" },
        ];
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"], { properties }),
        ]);
        const [only] = yield* runsForOrder();
        deepStrictEqual(only?.run.lineItemProperties, properties);
      }),
    ));

  it("a second pass over the same stored order writes nothing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const items = [lineItem(1, ["a"]), lineItem(2, ["b"])];
        yield* upsertAndReconcile(order(), items);
        const again = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        deepStrictEqual(again, {
          created: 0,
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        strictEqual((yield* runsForOrder()).length, 2);
      }),
    ));

  it("a closed item creates nothing on reconcile", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        const items = [lineItem(1, ["a"]), lineItem(2, ["b"])];
        yield* upsertAndReconcile(order(), items);
        const [target] = yield* runsForOrder();
        if (target === undefined) throw new Error("no run");
        yield* complete(target, 1, [TEAM_A.id]);
        yield* runs.cancelRun({ runId: target.run.id });
        // The item still matches its tag and the order is open and paid; the
        // closed run is what keeps reconcile from starting it again.
        const afterCancel = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          items,
        );
        strictEqual(afterCancel.created, 0);
        const closed = Option.getOrThrow(
          yield* runs.getRun({ runId: target.run.id }),
        );
        strictEqual(closed.run.state, "closed");
        strictEqual(closed.run.closedReason, "merchant_cancelled");
        strictEqual(closed.run.closedAt !== null, true);
        strictEqual(closed.tasks.length, 2);
        strictEqual((yield* runsForOrder()).length, 2);
      }),
    ));

  it("waits for payment, then creates runs identically from any source", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const items = [lineItem(1, ["a"])];
        const unpaid = yield* upsertAndReconcile(
          order({ fullyPaid: false }),
          items,
        );
        strictEqual(unpaid.created, 0);
        strictEqual((yield* runsForOrder()).length, 0);
        const paid = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        strictEqual(paid.created, 1);
        const manual = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          items,
        );
        strictEqual(manual.created, 0);
        strictEqual((yield* runsForOrder()).length, 1);
      }),
    ));

  it("a workflow that is on creates runs on every stored open paid order, however old it is", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* RunRepository;
        yield* turnOff(a.id);
        const day = 24 * 60 * 60 * 1000;
        const old = order({
          processedAt:
            Date.now() - (Domain.ShopLimits.orderRetentionDays - 30) * day,
        });
        const counts = yield* upsertAndReconcile(old, [lineItem(1, ["a"])]);
        strictEqual(counts.created, 0);
        yield* turnOn(a.id);
        yield* runs.reconcileAll(yield* loadEligibleContext);
        const [run] = yield* runsForOrder();
        strictEqual(run?.run.workflowId, a.id);
      }),
    ));

  it("skips items with no units to make", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const counts = yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"], { currentQuantity: 0 }),
        ]);
        strictEqual(counts.created, 0);
      }),
    ));

  it("a line at zero units closes its run as item_removed", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const items = [lineItem(1, ["a"]), lineItem(2, ["b"])];
        yield* upsertAndReconcile(order(), items);
        const [unstartedRun, startedRun] = yield* runsForOrder();
        if (unstartedRun === undefined || startedRun === undefined)
          throw new Error("expected two runs");
        yield* complete(startedRun, 1, [TEAM_A.id]);

        const zeroed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [
            lineItem(1, ["a"], { currentQuantity: 0 }),
            lineItem(2, ["b"], { currentQuantity: 0 }),
          ],
        );
        deepStrictEqual(zeroed, {
          created: 0,
          resized: 0,
          closed: 2,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const after = yield* runsForOrder();
        const p = after.find((d) => d.run.id === unstartedRun.run.id);
        const a = after.find((d) => d.run.id === startedRun.run.id);
        // Started or not, one rule: both close, and both keep their tasks.
        strictEqual(p?.run.state, "closed");
        strictEqual(p?.run.closedReason, "item_removed");
        strictEqual(p?.tasks.length, 2);
        strictEqual(a?.run.state, "closed");
        strictEqual(a?.run.closedReason, "item_removed");
        strictEqual(a?.tasks.length, 2);
        strictEqual(a?.tasks[0]?.doneAt !== null, true);

        // The lines leaving the order closes nothing more: the runs are
        // over already, and they keep their snapshots.
        const removed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [],
        );
        deepStrictEqual(removed, {
          created: 0,
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const gone = yield* runsForOrder();
        strictEqual(gone.length, 2);
        strictEqual(
          gone.find((d) => d.run.id === startedRun.run.id)?.run
            .lineItemProperties?.[0]?.value,
          "Hello 2",
        );
      }),
    ));

  it("a line removed from the order closes its open run as item_removed", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [],
        );
        strictEqual(counts.closed, 1);
        const [only] = yield* runsForOrder();
        strictEqual(only?.run.closedReason, "item_removed");
      }),
    ));

  it("a pass reads the stored order, and a run whose item is gone closes as item removed", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [kept, orphaned] = yield* runsForOrder();
        if (kept === undefined || orphaned === undefined)
          throw new Error("expected two runs");
        // Stored without a pass, then reconciled by id alone: the pass has
        // no copy of the order but what is stored, and item 2 is not.
        yield* (yield* OrderRepository).upsertOrder({
          order: order({ updatedAt: PROCESSED_AT + 1 }),
          lineItems: [lineItem(1, ["a"])],
          afterWrite: Effect.void,
        });
        const counts = yield* (yield* RunRepository).reconcileOrder({
          ...(yield* loadEligibleContext),
          orderId: ORDER_ID,
        });
        strictEqual(counts.closed, 1);
        const after = yield* runsForOrder();
        const byId = (id: string) => after.find((d) => d.run.id === id)?.run;
        strictEqual(byId(kept.run.id)?.state, "open");
        strictEqual(byId(orphaned.run.id)?.state, "closed");
        strictEqual(byId(orphaned.run.id)?.closedReason, "item_removed");
      }),
    ));

  it("on a truncated order a run whose item is not stored is left alone", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        // Stored short: item 2 may still exist past the kept items, so its
        // run is not read as an item at zero units.
        yield* (yield* OrderRepository).upsertOrder({
          order: order({
            updatedAt: PROCESSED_AT + 1,
            lineItemsTruncated: true,
          }),
          lineItems: [lineItem(1, ["a"])],
          afterWrite: Effect.void,
        });
        const counts = yield* (yield* RunRepository).reconcileOrder({
          ...(yield* loadEligibleContext),
          orderId: ORDER_ID,
        });
        strictEqual(counts.closed, 0);
        deepStrictEqual(
          (yield* runsForOrder()).map(({ run }) => run.state),
          ["open", "open"],
        );
      }),
    ));

  it("a pass that fails leaves neither the order nor its runs", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const orders = yield* OrderRepository;
        const runs = yield* RunRepository;
        const context = yield* loadEligibleContext;
        // The pass creates its run, then fails: the store and the run are
        // one transaction, so neither survives.
        const failed = yield* orders
          .upsertOrder({
            order: order(),
            lineItems: [lineItem(1, ["a"])],
            afterWrite: runs
              .reconcileOrder({ ...context, orderId: ORDER_ID })
              .pipe(
                Effect.tap(({ created }) =>
                  Effect.sync(() => {
                    strictEqual(created, 1);
                  }),
                ),
                Effect.andThen(Effect.fail("pass failed" as const)),
              ),
          })
          .pipe(Effect.flip);
        strictEqual(failed, "pass failed");
        strictEqual(Option.isNone(yield* orders.getOrder(ORDER_ID)), true);
        strictEqual((yield* runsForOrder()).length, 0);
      }),
    ));

  it("an unstarted run is resized silently", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"], { currentQuantity: 3 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          resized: 1,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const [p] = yield* runsForOrder();
        strictEqual(p?.run.state, "open");
        strictEqual(Domain.runIsUnstarted(p?.tasks ?? []), true);
        strictEqual(p?.run.quantity, 3);
        strictEqual(p?.run.quantityChangedFrom, null);
      }),
    ));

  it("a quantity change resizes an open run and records the original quantity once; completing a task clears it", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("no run");
        yield* complete(run, 1, [TEAM_A.id]);
        const first = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"], { currentQuantity: 3 })],
        );
        strictEqual(first.resized, 1);
        const once = (yield* runsForOrder())[0];
        strictEqual(once?.run.state, "open");
        strictEqual(once?.run.quantity, 3);
        strictEqual(once?.run.quantityChangedFrom, 2);
        // A second change keeps the original "from": that is the number the
        // maker worked to.
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 2 }), [
          lineItem(1, ["a"], { currentQuantity: 4 }),
        ]);
        const twice = (yield* runsForOrder())[0];
        strictEqual(twice?.run.quantity, 4);
        strictEqual(twice?.run.quantityChangedFrom, 2);
        // It is never a gate: the next Done goes through, and clears it.
        yield* complete(run, 2, [TEAM_B.id]);
        const cleared = (yield* runsForOrder())[0];
        strictEqual(cleared?.run.state, "done");
        strictEqual(cleared?.run.quantity, 4);
        strictEqual(cleared?.run.quantityChangedFrom, null);
      }),
    ));

  it("a resize back to the original clears the badge, and a Done clears it", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("no run");
        yield* complete(run, 1, [TEAM_A.id]);
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"], { currentQuantity: 3 }),
        ]);
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 2 }), [
          lineItem(1, ["a"]),
        ]);
        const back = (yield* runsForOrder())[0];
        strictEqual(back?.run.quantity, 2);
        strictEqual(back?.run.quantityChangedFrom, null);
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 3 }), [
          lineItem(1, ["a"], { currentQuantity: 3 }),
        ]);
        strictEqual((yield* runsForOrder())[0]?.run.quantityChangedFrom, 2);
        yield* complete(run, 2, [TEAM_B.id]);
        strictEqual((yield* runsForOrder())[0]?.run.quantityChangedFrom, null);
      }),
    ));

  it("a resize on an unstarted run clears the quantity badge", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        const cut = run?.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: cut,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"], { currentQuantity: 3 }),
        ]);
        strictEqual((yield* runsForOrder())[0]?.run.quantityChangedFrom, 2);
        // Put back: nobody is working to the old number any more.
        yield* runs.putBackTask({
          runTaskId: cut,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const unstarted = (yield* runsForOrder())[0];
        strictEqual(Domain.runIsUnstarted(unstarted?.tasks ?? []), true);
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 2 }), [
          lineItem(1, ["a"], { currentQuantity: 4 }),
        ]);
        const resized = (yield* runsForOrder())[0];
        strictEqual(resized?.run.quantity, 4);
        strictEqual(resized?.run.quantityChangedFrom, null);
      }),
    ));

  /**
   * The case nobody is watching: the maker has put the work down, and the
   * merchant edits the order in Shopify. The run keeps its quantity — what
   * was made was made — and nothing else happens to it.
   */
  it("a done run is never resized", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("expected one run");
        yield* complete(run, 1, [TEAM_A.id]);
        yield* complete(run, 2, [TEAM_B.id]);
        strictEqual((yield* runsForOrder())[0]?.run.state, "done");

        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"], { currentQuantity: 5 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const unchanged = (yield* runsForOrder())[0];
        strictEqual(unchanged?.run.state, "done");
        strictEqual(unchanged?.run.quantity, 2);
        strictEqual(unchanged?.run.quantityChangedFrom, null);
        strictEqual(unchanged?.tasks.length, 2);

        // The units reaching zero is the ordinary end of a done run — the
        // line was edited away or refunded — so it is not closed either.
        const zeroed = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 2 }),
          [lineItem(1, ["a"], { currentQuantity: 0 })],
        );
        deepStrictEqual(zeroed, {
          created: 0,
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const after = (yield* runsForOrder())[0];
        strictEqual(after?.run.state, "done");
        strictEqual(after?.run.quantity, 2);
      }),
    ));

  it("creates a run only for an item added on a later upsert", () =>
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
          resized: 0,
          closed: 0,
          multiMatch: 0,
          ceilingReleased: false,
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
          const [unstartedRun, startedRun] = yield* runsForOrder();
          if (unstartedRun === undefined || startedRun === undefined)
            throw new Error("expected two runs");
          yield* complete(startedRun, 1, [TEAM_A.id]);
          const threeLines = [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
            lineItem(3, ["a"]),
          ];
          const unpaid = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fullyPaid: false,
            }),
            threeLines,
          );
          deepStrictEqual(unpaid, {
            created: 0,
            resized: 0,
            closed: 0,
            multiMatch: 0,
            ceilingReleased: false,
          });
          const during = yield* runsForOrder();
          strictEqual(during.length, 2);
          strictEqual(
            during.find((d) => d.run.id === unstartedRun.run.id)?.run.state,
            "open",
          );
          const active = during.find((d) => d.run.id === startedRun.run.id);
          strictEqual(active?.run.state, "open");
          strictEqual(active?.run.blockedAt, null);
          const paid = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 2 }),
            threeLines,
          );
          strictEqual(paid.created, 1);
          strictEqual((yield* runsForOrder()).length, 3);
        }),
      ));

    it("unpaid after an edit still closes the open runs of a zeroed line", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [unstartedRun, startedRun] = yield* runsForOrder();
          if (unstartedRun === undefined || startedRun === undefined)
            throw new Error("expected two runs");
          yield* complete(startedRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({
              updatedAt: PROCESSED_AT + 1,
              fullyPaid: false,
            }),
            [
              lineItem(1, ["a"], { currentQuantity: 0 }),
              lineItem(2, ["b"], { currentQuantity: 0 }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            resized: 0,
            closed: 2,
            multiMatch: 0,
            ceilingReleased: false,
          });
          const after = yield* runsForOrder();
          deepStrictEqual(
            after.map((d) => d.run.closedReason),
            ["item_removed", "item_removed"],
          );
        }),
      ));
  });

  describe("units to make", () => {
    it("a refund that lowers currentQuantity reads like an edit: unstarted resized silently, started resized with the badge", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [unstartedRun, startedRun] = yield* runsForOrder();
          if (unstartedRun === undefined || startedRun === undefined)
            throw new Error("expected two runs");
          strictEqual(unstartedRun.run.quantity, 2);
          yield* complete(startedRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [
              lineItem(1, ["a"], { currentQuantity: 1 }),
              lineItem(2, ["b"], { currentQuantity: 1 }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            resized: 2,
            closed: 0,
            multiMatch: 0,
            ceilingReleased: false,
          });
          const after = yield* runsForOrder();
          const p = after.find((d) => d.run.id === unstartedRun.run.id);
          const a = after.find((d) => d.run.id === startedRun.run.id);
          strictEqual(p?.run.quantity, 1);
          strictEqual(p?.run.quantityChangedFrom, null);
          strictEqual(a?.run.quantity, 1);
          strictEqual(a?.run.quantityChangedFrom, 2);
        }),
      ));

    it("a full refund closes the open runs as item_removed", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [, startedRun] = yield* runsForOrder();
          if (startedRun === undefined) throw new Error("expected two runs");
          yield* complete(startedRun, 1, [TEAM_A.id]);
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [
              lineItem(1, ["a"], { currentQuantity: 0 }),
              lineItem(2, ["b"], { currentQuantity: 0 }),
            ],
          );
          deepStrictEqual(counts, {
            created: 0,
            resized: 0,
            closed: 2,
            multiMatch: 0,
            ceilingReleased: false,
          });
          deepStrictEqual(
            (yield* runsForOrder()).map((d) => [
              d.run.state,
              d.run.closedReason,
            ]),
            [
              ["closed", "item_removed"],
              ["closed", "item_removed"],
            ],
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
    it("FULFILLED closes every open run, leaves done alone, creates nothing", () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          const runs = yield* RunRepository;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          const [doneRun, startedRun] = yield* runsForOrder();
          if (doneRun === undefined || startedRun === undefined)
            throw new Error("expected two runs");
          yield* complete(doneRun, 1, [TEAM_A.id]);
          yield* complete(doneRun, 2, [TEAM_B.id]);
          yield* runs.startTask({
            runTaskId: startedRun.tasks[0]?.id ?? "",
            actor: memberActor("member-1"),
            teamIds: [TEAM_A.id],
          });
          // A third, untouched run is unstarted, and closes all the same.
          const unstartedRun = Option.getOrThrow(
            yield* runs.setRun({
              workflow: yield* savedDetail(startedRun.run.workflowId),
              teams: TEAMS,
              order: order(),
              lineItem: lineItem(3, []),
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
            resized: 0,
            closed: 2,
            multiMatch: 0,
            ceilingReleased: false,
          });
          const after = yield* runsForOrder();
          strictEqual(after.length, 3);
          const unstarted = after.find((d) => d.run.id === unstartedRun.id);
          strictEqual(unstarted?.run.state, "closed");
          strictEqual(unstarted?.run.closedReason, "fulfilled");
          const active = after.find((d) => d.run.id === startedRun.run.id);
          strictEqual(active?.run.state, "closed");
          strictEqual(active?.run.closedReason, "fulfilled");
          strictEqual(active?.run.closedAt !== null, true);
          // The tasks stay as the record of who did what.
          strictEqual(active?.tasks[0]?.startedAt !== null, true);
          const done = after.find((d) => d.run.id === doneRun.run.id);
          strictEqual(done?.run.state, "done");
          strictEqual(done?.run.closedReason, null);
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
            resized: 0,
            closed: 0,
            multiMatch: 0,
            ceilingReleased: false,
          });
          const after = yield* runsForOrder();
          const shipped = after.find((d) => d.run.id === shippedRun.run.id);
          strictEqual(shipped?.run.state, "open");
          strictEqual(shipped?.run.quantityChangedFrom, null);
          const other = after.find((d) => d.run.id === otherRun.run.id);
          strictEqual(other?.run.state, "open");
          strictEqual(other?.run.quantityChangedFrom, null);
        }),
      ));
  });

  it("order cancel closes every open run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["a"]),
        ]);
        const before = yield* runsForOrder();
        const [unstartedRun, startedRun, doneRun] = before;
        if (
          unstartedRun === undefined ||
          startedRun === undefined ||
          doneRun === undefined
        )
          throw new Error("expected three runs");
        yield* complete(startedRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 1, [TEAM_A.id]);
        yield* complete(doneRun, 2, [TEAM_B.id]);
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1, cancelledAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["b"]), lineItem(3, ["a"])],
        );
        deepStrictEqual(counts, {
          created: 0,
          resized: 0,
          closed: 2,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const after = yield* runsForOrder();
        for (const open of [unstartedRun, startedRun]) {
          const closed = after.find((d) => d.run.id === open.run.id);
          strictEqual(closed?.run.state, "closed");
          strictEqual(closed?.run.closedReason, "order_cancelled");
        }
        const done = after.find((d) => d.run.id === doneRun.run.id);
        strictEqual(done?.run.state, "done");
        strictEqual(done?.run.closedReason, null);
      }),
    ));

  it("creates nothing for an off workflow, a never-applied one, or an unassigned task", () =>
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
        // b switched off: nothing starts even with every team present.
        yield* workflows.setWorkflowOn({
          workflowId: b.id,
          on: false,
          teams: TEAMS,
        });
        const off = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          items,
        );
        strictEqual(off.created, 0);
        yield* workflows.setWorkflowOn({
          workflowId: b.id,
          on: true,
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

describe("RunRepository tasks, workflows list, blocks, delete", () => {
  it("markTaskDone enforces team, order, and terminal state and records who did it", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
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
        strictEqual(active.run.state, "open");
        strictEqual(active.tasks[0]?.doneByEmail, "member-1@example.com");

        const repeat = yield* complete(detail, 1, [TEAM_A.id]).pipe(
          Effect.flip,
        );
        strictEqual(repeat._tag, "TaskNotReadyError");

        yield* complete(detail, 2, [TEAM_B.id]);
        const done = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(done.run.state, "done");

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

  it("cancelRun closes with merchant_cancelled and keeps the tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.setRunNote({ runId: detail.run.id, note: note("hi") });
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: MERCHANT,
          reason: null,
        });
        yield* runs.cancelRun({ runId: detail.run.id });
        const closed = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(closed.run.state, "closed");
        strictEqual(closed.run.closedReason, "merchant_cancelled");
        strictEqual(closed.run.closedAt !== null, true);
        // The note and the tasks are the record; the block is open state.
        strictEqual(closed.run.note, "hi");
        strictEqual(closed.run.blockedAt, null);
        strictEqual(closed.run.blockedBy, null);
        strictEqual(closed.tasks.length, 2);
        strictEqual(closed.tasks[0]?.doneAt !== null, true);
        const refused = yield* complete(detail, 2, [TEAM_B.id]).pipe(
          Effect.flip,
        );
        strictEqual(refused._tag, "RunTerminalError");
        const again = yield* runs
          .cancelRun({ runId: detail.run.id })
          .pipe(Effect.flip);
        strictEqual(again._tag, "RunTerminalError");
      }),
    ));

  it("cancelRun on a closed order is refused", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        const orders = yield* OrderRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        // Stored without reconcile, the race the error names: the order is
        // closed and the run has not been closed yet.
        yield* orders.upsertOrder({
          order: order({
            updatedAt: PROCESSED_AT + 1,
            cancelledAt: PROCESSED_AT + 1,
          }),
          lineItems: [lineItem(1, ["a"])],
          afterWrite: Effect.void,
        });
        const refused = yield* runs
          .cancelRun({ runId: detail.run.id })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunOrderClosedError");
      }),
    ));

  it("listRuns shows only current tasks for the given teams, and a blocked run on the Blocked view", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [first, second] = yield* runsForOrder();
        if (first === undefined || second === undefined)
          throw new Error("expected two runs");

        const teamARows = yield* runListRows({ teamIds: [TEAM_A.id] });
        // Two runs of one order share `orderProcessedAt`, so the item
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

        yield* runs.blockRun({
          runId: second.run.id,
          actor: MERCHANT,
          reason: reason("Out of thread"),
        });
        // The block decides the view, not the position in one list: the
        // held run leaves Ready for Blocked and the untouched one stays.
        const blocked = yield* runListRows({
          teamIds: [TEAM_A.id, TEAM_B.id],
          view: "blocked",
        });
        deepStrictEqual(
          blocked.map((item) => [
            String(item.run.id),
            item.run.blockReason ?? "",
          ]),
          [[second.run.id, "Out of thread"]],
        );
        deepStrictEqual(
          (yield* runListRows({
            teamIds: [TEAM_A.id, TEAM_B.id],
            view: "upNext",
          })).map((item) => [item.run.id, item.run.blockedAt]),
          [[first.run.id, null]],
        );

        const wrongTeam = yield* runs
          .unblockRun({ runId: second.run.id, teamIds: [TEAM_A.id] })
          .pipe(Effect.flip);
        strictEqual(wrongTeam._tag, "RunNotAllowedError");
        yield* runs.unblockRun({ runId: second.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: second.run.id }),
        );
        strictEqual(cleared.run.blockedAt, null);
        strictEqual(cleared.run.blockReason, null);
        strictEqual(cleared.run.blockedBy, null);
      }),
    ));

  it("listRuns never lists a closed run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
          lineItem(3, ["a"]),
        ]);
        const [cancelled, removed, kept] = yield* runsForOrder();
        if (
          cancelled === undefined ||
          removed === undefined ||
          kept === undefined
        )
          throw new Error("expected three runs");
        yield* runs.blockRun({
          runId: cancelled.run.id,
          actor: MERCHANT,
          reason: null,
        });
        yield* runs.cancelRun({ runId: cancelled.run.id });
        yield* upsertAndReconcile(order({ updatedAt: PROCESSED_AT + 1 }), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"], { currentQuantity: 0 }),
          lineItem(3, ["a"]),
        ]);
        const teams = [TEAM_A.id, TEAM_B.id, TEAM_C.id];
        deepStrictEqual(
          (yield* runListRows({ teamIds: teams })).map((item) => item.run.id),
          [kept.run.id],
        );
        const { counts } = yield* runs.listRuns({
          teamIds: teams,
          memberEmail: VIEWER,
          query: { team: null, view: "mine", limit: Domain.RUN_PAGE },
        });
        strictEqual(counts.total, 1);
        strictEqual(counts.blocked, 0);
        // The order closing takes the last one off too.
        yield* upsertAndReconcile(
          order({
            updatedAt: PROCESSED_AT + 2,
            fulfillmentStatus: "FULFILLED",
          }),
          [lineItem(1, ["a"]), lineItem(2, ["b"]), lineItem(3, ["a"])],
        );
        strictEqual((yield* runListRows({ teamIds: teams })).length, 0);
      }),
    ));

  it("unblockRun refuses a run that is not blocked", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        const refused = yield* runs
          .unblockRun({ runId: detail.run.id })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotBlockedError");
      }),
    ));

  it("copies step and instructions onto run tasks; current rule gates completion across steps", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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
        strictEqual(done.run.state, "done");
      }),
    ));

  it("listRuns sorts by the reader: my started task is Started by you, a teammate's is Started by others, a block is Blocked for both", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
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
        // A hold on the other run, so the view is reached without disturbing
        // either run's tasks.
        yield* runs.blockRun({
          runId: theirs.run.id,
          actor: maker,
          teamIds: [TEAM_A.id],
          reason: reason("Waiting on the customer"),
        });

        // The counts come back whatever view is asked for, so one read per
        // reader says where every row landed for them.
        const countsFor = (memberEmail: Domain.Email) =>
          runs
            .listRuns({
              teamIds: [TEAM_A.id],
              memberEmail,
              query: { team: null, view: "mine", limit: Domain.RUN_PAGE },
            })
            .pipe(
              Effect.map(({ counts, items }) => ({
                counts: [
                  counts.mine,
                  counts.upNext,
                  counts.teammates,
                  counts.blocked,
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
        // The blocked run is Blocked for both, and the started one is In
        // progress for the reader who did not start it.
        deepStrictEqual(
          (yield* runListRows({
            teamIds: [TEAM_A.id],
            memberEmail: VIEWER,
            view: "teammates",
          })).map((item) => item.run.id),
          [mine.run.id],
        );
        deepStrictEqual(
          (yield* runListRows({
            teamIds: [TEAM_A.id],
            memberEmail: maker.email,
            view: "blocked",
          })).map((item) => item.run.id),
          [theirs.run.id],
        );
      }),
    ));

  it("listRuns counts the whole view and returns only the limit; the team counts ignore the narrowing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
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
            query: { team: null, view: "upNext", limit },
          });

        const capped = yield* read(10);
        strictEqual(capped.items.length, 10);
        strictEqual(capped.counts.upNext, 12);
        strictEqual(capped.counts.total, 12);
        deepStrictEqual(
          capped.counts.teamCounts.map(({ teamId, count }) => [teamId, count]),
          [
            [TEAM_A.id, 12],
            // Finish is step 2 and nothing is done, so B owns no current task.
            [TEAM_B.id, 0],
          ],
        );

        const deeper = yield* read(20);
        strictEqual(deeper.items.length, 12);
        strictEqual(deeper.counts.upNext, 12);
      }),
    ));

  it("listRuns on the Done view returns no items and counts the other views all the same", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);

        const done = yield* runs.listRuns({
          teamIds: [TEAM_A.id],
          memberEmail: VIEWER,
          query: { team: null, view: "done", limit: Domain.RUN_PAGE },
        });
        // The Done or closed view's rows are `listRecent`'s; the view row above them is still
        // this read's, which is why the counts do not depend on the view.
        strictEqual(done.items.length, 0);
        strictEqual(done.counts.upNext, 1);
        strictEqual(done.counts.total, 1);
      }),
    ));

  it("listRuns narrows rows and their tasks to one team, and a team the member is not on reads empty", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        yield* steppedRun();
        const teamIds = [TEAM_A.id, TEAM_B.id];

        const read = (team: Domain.TeamId | null) =>
          runs.listRuns({
            teamIds,
            memberEmail: VIEWER,
            query: { team, view: "upNext", limit: Domain.RUN_PAGE },
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
        // The view counts are after the narrowing — they describe the lists the
        // member can switch to — while `total` and `teamCounts` are not.
        strictEqual(foreign.counts.upNext, 0);
        strictEqual(foreign.counts.total, 1);
        deepStrictEqual(
          foreign.counts.teamCounts.map(({ count }) => count),
          [1, 1],
        );
      }),
    ));

  it("listRuns returns every current task per run that the reader's teams own, with stepCount", () =>
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

  it("startTask keeps the run open, never takes over, and respects readiness and team", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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
        strictEqual(started.run.state, "open");
        strictEqual(started.tasks[0]?.startedByEmail, "m1@example.com");
        strictEqual(started.tasks[0]?.startedAt !== null, true);
        strictEqual(started.tasks[0]?.doneAt, null);

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const again = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(again.tasks[0]?.startedByEmail, "m1@example.com");

        // Done without Start backfills who started.
        yield* complete(detail, 2, [TEAM_B.id]);
        const materials = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[1];
        strictEqual(materials?.startedByEmail, "member-1@example.com");
        strictEqual(materials?.doneByEmail, "member-1@example.com");
        strictEqual(materials?.startedAt, materials?.doneAt);
      }),
    ));

  it("Undo returns a task to Ready, un-readies the next step, and is refused once downstream started", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        const produce = detail.tasks[2]?.id ?? "";

        // Not yet done: nothing to reopen.
        strictEqual(
          (yield* runs
            .reopenTask({
              runTaskId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_A.id],
            })
            .pipe(Effect.flip))._tag,
          "TaskNotReadyError",
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        // Step 2 is current now; Team C's list has Produce.
        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 1);
        // Wrong team.
        strictEqual(
          (yield* runs
            .reopenTask({
              runTaskId: artwork,
              actor: memberActor("m1"),
              teamIds: [TEAM_B.id],
            })
            .pipe(Effect.flip))._tag,
          "RunNotAllowedError",
        );
        // Anyone on the task's team may reopen, not only who pressed Done.
        yield* runs.reopenTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const undone = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(undone.tasks[0]?.doneAt, null);
        strictEqual(undone.tasks[0]?.doneByEmail, null);
        strictEqual(undone.tasks[0]?.startedAt, null);
        strictEqual(undone.tasks[0]?.startedByEmail, null);
        strictEqual(undone.tasks[0]?.startedByRole, null);
        strictEqual(undone.run.state, "open");
        // Produce left Team C's list: step 1 is open again.
        strictEqual((yield* runListRows({ teamIds: [TEAM_C.id] })).length, 0);
        strictEqual(
          (yield* runListRows({ teamIds: [TEAM_A.id] }))[0]?.tasks[0]?.id,
          artwork,
        );

        // Once downstream has started, reopen is refused and names them.
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.startTask({
          runTaskId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .reopenTask({
            runTaskId: materials,
            actor: memberActor("m1"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "TaskReopenBlockedError");
        if (blocked._tag === "TaskReopenBlockedError") {
          strictEqual(blocked.taskName, "Produce");
          strictEqual(blocked.teamName, "Team C");
        }

        // Reopening the last task turns a done run back to open.
        yield* complete(detail, 3, [TEAM_C.id]);
        yield* complete(detail, 4, [TEAM_A.id]);
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .state,
          "done",
        );
        yield* runs.reopenTask({
          runTaskId: detail.tasks[3]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .state,
          "open",
        );

        // A closed run is final: its done tasks are not reopened.
        yield* runs.cancelRun({ runId: detail.run.id });
        strictEqual(
          (yield* runs
            .reopenTask({
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
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .state,
          "open",
        );
        // Anyone on the task's team, not only the starter.
        yield* runs.putBackTask({
          runTaskId: artwork,
          actor: memberActor("m2"),
          teamIds: [TEAM_A.id],
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        const task = after.tasks[0];
        strictEqual(task?.startedAt, null);
        strictEqual(task?.startedByEmail, null);
        strictEqual(task?.startedByRole, null);
        strictEqual(task?.reopenedAt, null);
        // The only started task put back: the run is untouched again.
        strictEqual(after.run.state, "open");
        strictEqual(Domain.runIsUnstarted(after.tasks), true);
        // Ready again: it is on Team A's list as a Start.
        const view = Option.getOrThrow(
          yield* runs.getRunPage({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        strictEqual(
          view.tasks.find((each) => each.id === artwork)?.current,
          true,
        );
      }),
    ));

  it("Put back is refused on an unstarted task, a done task, a blocked run, another team's task, and a closed run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        const putBack = (runTaskId: string, teamIds: readonly string[]) =>
          runs
            .putBackTask({ runTaskId, actor: memberActor("m1"), teamIds })
            .pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            );

        strictEqual(yield* putBack(artwork, [TEAM_A.id]), "TaskNotReadyError");

        yield* complete(detail, 2, [TEAM_B.id]);
        strictEqual(
          yield* putBack(materials, [TEAM_B.id]),
          "TaskNotReadyError",
        );

        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        strictEqual(yield* putBack(artwork, [TEAM_B.id]), "RunNotAllowedError");

        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: null,
        });
        strictEqual(yield* putBack(artwork, [TEAM_A.id]), "RunBlockedError");
        // The merchant is held by the block too.
        strictEqual(
          (yield* runs
            .putBackTask({ runTaskId: artwork, actor: MERCHANT })
            .pipe(Effect.flip))._tag,
          "RunBlockedError",
        );

        yield* runs.cancelRun({ runId: detail.run.id });
        strictEqual(yield* putBack(artwork, [TEAM_A.id]), "RunTerminalError");
      }),
    ));

  it("the merchant puts back a member's Start", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.putBackTask({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.startedAt, null);
        strictEqual(task?.startedByRole, null);
      }),
    ));

  it("listRecent lists the team's recent completions newest first with the undo verdict; getRunPage decorates every task", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const since = Date.now() - 1000;
        strictEqual(
          (yield* runs.listRecent({ teamIds: [TEAM_A.id], since, limit: 10 }))
            .total,
          0,
        );
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* complete(detail, 2, [TEAM_B.id]);
        const teamA = yield* runs.listRecent({
          teamIds: [TEAM_A.id],
          since,
          limit: 10,
        });
        strictEqual(teamA.total, 1);
        strictEqual(teamA.items.length, 1);
        strictEqual(taskItems(teamA.items)[0]?.task.name, "Artwork");
        strictEqual(teamA.items[0]?.run.id, detail.run.id);
        strictEqual(taskItems(teamA.items)[0]?.reopenBlockedBy, null);
        // Collapsed: the count without the rows.
        const collapsed = yield* runs.listRecent({
          teamIds: [TEAM_A.id],
          since,
          limit: 0,
        });
        strictEqual(collapsed.total, 1);
        strictEqual(collapsed.items.length, 0);
        // Outside the window: nothing.
        strictEqual(
          (yield* runs.listRecent({
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
        const both = yield* runs.listRecent({
          teamIds: [TEAM_A.id, TEAM_B.id],
          since,
          limit: 10,
        });
        deepStrictEqual(
          taskItems(both.items).map((entry) => [
            entry.task.name,
            entry.reopenBlockedBy?.taskName,
          ]),
          [
            [taskName("Materials"), taskName("Produce")],
            [taskName("Artwork"), taskName("Produce")],
          ],
        );

        const view = Option.getOrThrow(
          yield* runs.getRunPage({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        deepStrictEqual(
          view.tasks.map((task) => [
            task.name,
            task.current,
            task.reopenBlockedBy?.teamName ?? null,
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
            yield* runs.getRunPage({
              runId: detail.run.id,
              teamIds: ["nobody"],
            }),
          ),
          true,
        );
        strictEqual(
          Option.isNone(
            yield* runs.getRunPage({ runId: "missing", teamIds: [TEAM_A.id] }),
          ),
          true,
        );
        // The run carries the order's placed time.
        strictEqual(view.run.orderProcessedAt, PROCESSED_AT);
      }),
    ));

  it("listRecent lists done tasks and closed runs in the window, newest first", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        const since = Date.now() - 1000;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["b"]),
        ]);
        const [made, cancelled] = yield* runsForOrder();
        if (made === undefined || cancelled === undefined)
          throw new Error("expected two runs");
        // Apart in time so newest first has one answer.
        yield* complete(made, 1, [TEAM_A.id]);
        yield* Effect.sleep("5 millis");
        yield* runs.cancelRun({ runId: cancelled.run.id });
        yield* Effect.sleep("5 millis");
        yield* complete(made, 2, [TEAM_B.id]);
        // Team A did Cut, and could see the run that closed (its Cut
        // task is on Team A), though none of it was done.
        const teamA = yield* runs.listRecent({
          teamIds: [TEAM_A.id],
          since,
          limit: 10,
        });
        strictEqual(teamA.total, 2);
        deepStrictEqual(shape(teamA.items), [
          "closed merchant_cancelled",
          "task Cut",
        ]);
        const both = yield* runs.listRecent({
          teamIds: [TEAM_A.id, TEAM_B.id],
          since,
          limit: 2,
        });
        strictEqual(both.total, 3);
        deepStrictEqual(shape(both.items), [
          "task Finish",
          "closed merchant_cancelled",
        ]);
        // Collapsed: the count and no rows.
        deepStrictEqual(
          yield* runs.listRecent({ teamIds: [TEAM_A.id], since, limit: 0 }),
          { items: [], total: 2 },
        );
        // A team with nothing on the run, and a window after it: nothing.
        strictEqual(
          (yield* runs.listRecent({ teamIds: [TEAM_C.id], since, limit: 10 }))
            .total,
          0,
        );
        strictEqual(
          (yield* runs.listRecent({
            teamIds: [TEAM_A.id, TEAM_B.id],
            since: Date.now() + 60_000,
            limit: 10,
          })).total,
          0,
        );
      }),
    ));

  it("a closed run is still read by its gate and its workflow page, and Reopen on it is refused", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [detail] = yield* runsForOrder();
        if (detail === undefined) throw new Error("no run");
        yield* complete(detail, 1, [TEAM_A.id]);
        yield* runs.cancelRun({ runId: detail.run.id });
        const gate = Option.getOrThrow(
          yield* runs.getRunGate({ runId: detail.run.id }),
        );
        strictEqual(gate.run.state, "closed");
        const view = Option.getOrThrow(
          yield* runs.getRunPage({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        strictEqual(view.run.closedReason, "merchant_cancelled");
        // Closed is final: nothing reads as current, and a done task stays
        // done.
        strictEqual(
          view.tasks.some((task) => task.current),
          false,
        );
        const reopen = yield* runs
          .reopenTask({
            runTaskId: detail.tasks[0]?.id ?? "",
            actor: memberActor("member-1"),
            teamIds: [TEAM_A.id],
          })
          .pipe(Effect.flip);
        strictEqual(reopen._tag, "RunTerminalError");
        const closed = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(closed.run.state, "closed");
        strictEqual(closed.tasks[0]?.doneAt !== null, true);
      }),
    ));

  it("a closed run's open tasks are never current on the workflow page", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        // Nothing done: step 1's two tasks were current a moment ago.
        yield* runs.cancelRun({ runId: detail.run.id });
        const view = Option.getOrThrow(
          yield* runs.getRunPage({
            runId: detail.run.id,
            teamIds: [TEAM_A.id],
          }),
        );
        deepStrictEqual(
          view.tasks.map((task) => [task.name, task.current]),
          [
            ["Artwork", false],
            ["Materials", false],
            ["Produce", false],
            ["Inspect", false],
          ],
        );
      }),
    ));

  it("setRunNote writes, overwrites, clears; allowed on a done run and on a closed run", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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
            .state,
          "done",
        );
        yield* set(note("noticed after the last Done"));
        strictEqual(yield* runNote(), "noticed after the last Done");
        // A done run is not cancelled from here; reopen the last task first.
        yield* runs.reopenTask({
          runTaskId: detail.tasks[3]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.cancelRun({ runId: detail.run.id });
        // A closed run keeps its record, and the note is part of it.
        yield* set(note("closed, and why"));
        strictEqual(yield* runNote(), "closed, and why");
      }),
    ));

  it("setRunNote admits a member whose team has any task of the run, current or not, and refuses one whose team has none", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        // Team C's task is two steps out: nothing of theirs is current.
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

  it("a block refuses Start, Done and Put back but not Undo or the note, and unblocking lets work resume", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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
        strictEqual(start._tag, "RunBlockedError");
        const done = yield* complete(detail, 2, [TEAM_B.id]).pipe(Effect.flip);
        strictEqual(done._tag, "RunBlockedError");
        yield* runs.setRunNote({
          runId: detail.run.id,
          teamIds: [TEAM_B.id],
          note: note("waiting on stock"),
        });
        yield* runs.reopenTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.unblockRun({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        yield* complete(detail, 2, [TEAM_B.id]);
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.tasks[0]?.doneAt, null);
        strictEqual(after.tasks[1]?.doneAt !== null, true);
      }),
    ));

  it("blockRun records the reason and who; unblockRun lifts it; closing the run clears it", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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
          actor: { ...memberActor("m1"), teamIds: [TEAM_A.id] },
          teamIds: [TEAM_A.id],
          reason: reason("Out of chain"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(Domain.runIsBlocked(blocked.run), true);
        strictEqual(blocked.run.blockReason, "Out of chain");
        // Role and email only: the gate's member id and team ids are not stored.
        deepStrictEqual<unknown>(blocked.run.blockedBy, {
          role: "member",
          email: "m1@example.com",
        });
        const rows = yield* runListRows({ teamIds: [TEAM_B.id] });
        strictEqual(rows[0]?.run.blockReason, "Out of chain");

        yield* runs.unblockRun({ runId: detail.run.id, teamIds: [TEAM_B.id] });
        const cleared = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(cleared.run.blockedAt, null);
        strictEqual(cleared.run.blockReason, null);
        strictEqual(cleared.run.blockedBy, null);

        // A Shopify change never touches a block; closing the run ends it
        // with the rest of the run's open state.
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
          reason: null,
        });
        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["s"], { currentQuantity: 0 })],
        );
        deepStrictEqual(counts, {
          created: 0,
          resized: 0,
          closed: 1,
          multiMatch: 0,
          ceilingReleased: false,
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(after.run.state, "closed");
        strictEqual(after.run.closedReason, "item_removed");
        strictEqual(after.run.blockedAt, null);
        const late = yield* runs
          .unblockRun({ runId: detail.run.id })
          .pipe(Effect.flip);
        strictEqual(late._tag, "RunTerminalError");
      }),
    ));

  /**
   * The edit is text and nothing else. `blockedBy` and `blockedAt` record who set the
   * hold and when, and a correction to its wording must not restate either —
   * the merchant reading the workflows list is chasing the person who blocked it, not
   * whoever last fixed a typo.
   */
  it("setBlockReason rewrites the reason, keeps by, and refuses anything that is not a standing block", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const blockOf = () =>
          runs.getRun({ runId: detail.run.id }).pipe(
            Effect.map((run) => {
              const { blockReason, blockedBy, blockedAt } =
                Option.getOrThrow(run).run;
              return { reason: blockReason, by: blockedBy, at: blockedAt };
            }),
          );

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
        const by = { role: "member", email: "m1@example.com" };
        const at = (yield* blockOf()).at;

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
        deepStrictEqual<unknown>(yield* blockOf(), {
          reason: "Waiting on stones\nCalled the supplier",
          by,
          at,
        });

        // The merchant passes no teams and is refused by nothing.
        yield* runs.setBlockReason({
          runId: detail.run.id,
          reason: null,
        });
        deepStrictEqual<unknown>(yield* blockOf(), { reason: null, by, at });
      }),
    ));

  it("merchant completes an unassigned task: no team clause, and the merchant fills both actors", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const sql = yield* SqlClient.SqlClient;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        // The state a team delete leaves behind: on nobody's list, which is
        // the very run the merchant is there to unstick.
        yield* sql`update RunTask set teamId = null where id = ${artwork}`;
        const refused = yield* runs
          .markTaskDone({
            runTaskId: artwork,
            actor: memberActor("m1"),
            teamIds: [TEAM_A.id],
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotAllowedError");
        yield* runs.markTaskDone({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.doneByRole, "merchant");
        strictEqual(task?.doneByEmail, null);
        strictEqual(task?.startedByRole, "merchant");
        strictEqual(task?.startedByEmail, null);
        deepStrictEqual<unknown>(Domain.taskDoneBy(task), {
          role: "merchant",
        });
      }),
    ));

  it("merchant completes over a member's start: the started columns keep the member", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.markTaskDone({ runTaskId: artwork, actor: MERCHANT });
        const task = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        ).tasks[0];
        strictEqual(task?.startedByRole, "member");
        strictEqual(task?.startedByEmail, "m1@example.com");
        strictEqual(task?.doneByRole, "merchant");
        strictEqual(task?.doneByEmail, null);
      }),
    ));

  it("Undo returns a task to Ready whoever started it, member or merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const taskNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [task] = Option.getOrThrow(run).tasks;
            if (task === undefined) throw new Error("no task");
            return task;
          });
        yield* runs.markTaskDone({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.reopenTask({ runTaskId: artwork, actor: MERCHANT });
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

        yield* runs.markTaskDone({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.reopenTask({ runTaskId: artwork, actor: MERCHANT });
        const ready = yield* taskNow();
        strictEqual(ready.startedAt, null);
        strictEqual(ready.startedByEmail, null);
        strictEqual(ready.startedByRole, null);
        strictEqual(ready.doneAt, null);
        strictEqual(ready.reopenedByRole, "merchant");
      }),
    ));

  it("undo records the reopener and the next Done clears it, for a member and for the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const taskNow = () =>
          Effect.map(runs.getRun({ runId: detail.run.id }), (run) => {
            const [task] = Option.getOrThrow(run).tasks;
            if (task === undefined) throw new Error("no task");
            return task;
          });
        yield* runs.markTaskDone({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.reopenTask({
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

        yield* runs.markTaskDone({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        const redone = yield* taskNow();
        strictEqual(redone.reopenedAt, null);
        strictEqual(redone.reopenedByRole, null);
        strictEqual(redone.reopenedByEmail, null);
        strictEqual(Domain.taskReopenedBy(redone), null);

        yield* runs.reopenTask({ runTaskId: artwork, actor: MERCHANT });
        const byMerchant = yield* taskNow();
        strictEqual(byMerchant.reopenedByRole, "merchant");
        strictEqual(byMerchant.reopenedByEmail, null);
        strictEqual(byMerchant.doneAt, null);
        strictEqual(byMerchant.doneByRole, null);
      }),
    ));

  it("the merchant is held to every rule but the team one: step order, terminal runs, and the downstream undo guard", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const [artwork, materials, produce] = [
          detail.tasks[0]?.id ?? "",
          detail.tasks[1]?.id ?? "",
          detail.tasks[2]?.id ?? "",
        ];
        // Step 2 is not current while step 1 is open.
        const notReady = yield* runs
          .markTaskDone({ runTaskId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(notReady._tag, "TaskNotReadyError");

        yield* runs.markTaskDone({ runTaskId: artwork, actor: MERCHANT });
        yield* runs.markTaskDone({ runTaskId: materials, actor: MERCHANT });
        // A member downstream blocks the merchant's reopen exactly as it would
        // block a teammate's.
        yield* runs.startTask({
          runTaskId: produce,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        const blocked = yield* runs
          .reopenTask({ runTaskId: artwork, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(blocked._tag, "TaskReopenBlockedError");
        strictEqual(
          blocked._tag === "TaskReopenBlockedError" ? blocked.taskName : null,
          "Produce",
        );
        strictEqual(
          blocked._tag === "TaskReopenBlockedError" ? blocked.teamName : null,
          TEAM_C.name,
        );

        // A closed run takes no more work, from the merchant either.
        yield* runs.cancelRun({ runId: detail.run.id });
        const closed = yield* runs
          .markTaskDone({ runTaskId: produce, actor: MERCHANT })
          .pipe(Effect.flip);
        strictEqual(closed._tag, "RunTerminalError");
      }),
    ));

  it("setRunNote records no author: last write wins, the same rule as setBlockReason", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
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

  it("blockRun and unblockRun by the merchant: no current-team requirement, and the block records the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        yield* runs.blockRun({
          runId: detail.run.id,
          actor: MERCHANT,
          reason: reason("waiting on the customer"),
        });
        const blocked = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        strictEqual(blocked.run.blockReason, "waiting on the customer");
        deepStrictEqual<unknown>(blocked.run.blockedBy, { role: "merchant" });
        strictEqual(
          Domain.actorLabel(blocked.run.blockedBy ?? { role: "merchant" }),
          "Merchant",
        );
        yield* runs.unblockRun({ runId: detail.run.id });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: detail.run.id })).run
            .blockedAt,
          null,
        );
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
        strictEqual(Domain.workflowIsOn(applied), true);
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
  it("deleteWorkflow leaves its runs and run tasks, open and done; the workflows list, order view, start, done, block, and cancel still work on them", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a, b } = yield* seed;
        const workflows = yield* WorkflowRepository;
        const runs = yield* RunRepository;
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
          yield* runs.markTaskDone({
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
        strictEqual(done?.run.state, "done");
        strictEqual(
          done?.tasks.every((task) => task.doneAt !== null),
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
        yield* runs.markTaskDone({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.assignRunTaskTeam({
          runTaskId: finish.id,
          team: TEAM_C,
        });
        const [moved] = yield* runListRows({ teamIds: [TEAM_C.id] });
        strictEqual(moved?.tasks[0]?.id, finish.id);
        yield* runs.blockRun({
          runId: stillOpen.run.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_C.id],
          reason: reason("waiting on stock"),
        });
        yield* runs.cancelRun({ runId: stillOpen.run.id });
        strictEqual(
          Option.getOrThrow(yield* runs.getRun({ runId: stillOpen.run.id })).run
            .state,
          "closed",
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

  it("a run of a deleted workflow is replaced, not joined, by a new run on the same item", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const workflows = yield* WorkflowRepository;
        const runs = yield* RunRepository;
        const items = [lineItem(1, ["a"])];
        yield* upsertAndReconcile(order(), items);
        const [orphaned] = yield* runsForOrder();
        if (orphaned === undefined) throw new Error("no run");
        yield* workflows.deleteWorkflow({ workflowId: a.id });

        // A fresh workflow on the same item. The orphaned run still holds
        // the item, and one row per item, so attaching deletes it rather than
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
        });
        strictEqual(Option.isSome(attached), true);
        strictEqual(Option.getOrThrow(attached).replaced?.id, orphaned.run.id);
        deepStrictEqual(
          (yield* runsForOrder()).map((d) => d.run.workflowId),
          [replacement.id],
        );
        // The toast names the orphan by its snapshotted name.
        strictEqual(Option.getOrThrow(attached).replaced?.workflowName, a.name);
      }),
    ));

  it("start, complete, and block snapshot the actor's email onto the row; listRuns reads it back with no team read", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seedStepped;
        const runs = yield* RunRepository;
        const detail = yield* steppedRun();
        const artwork = detail.tasks[0]?.id ?? "";
        const materials = detail.tasks[1]?.id ?? "";
        yield* runs.startTask({
          runTaskId: artwork,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        // Done without Start backfills the starter's email too.
        yield* runs.markTaskDone({
          runTaskId: materials,
          actor: memberActor("m2"),
          teamIds: [TEAM_B.id],
        });
        const after = Option.getOrThrow(
          yield* runs.getRun({ runId: detail.run.id }),
        );
        deepStrictEqual(
          after.tasks.slice(0, 2).map((s) => [s.startedByEmail, s.doneByEmail]),
          [
            ["m1@example.com", null],
            ["m2@example.com", "m2@example.com"],
          ],
        );
        const [listed] = yield* runListRows({ teamIds: [TEAM_A.id] });
        strictEqual(listed?.tasks[0]?.startedByEmail, "m1@example.com");
      }),
    ));

  it("a team delete nulls the team on every task; history keeps the name", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* RunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [
          lineItem(1, ["a"]),
          lineItem(2, ["a"]),
        ]);
        const [open, closed] = yield* runsForOrder();
        if (open === undefined || closed === undefined)
          throw new Error("no runs");
        // A done task on an open run, and a closed run with both tasks undone.
        yield* runs.markTaskDone({
          runTaskId: open.tasks[0]?.id ?? "",
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* runs.cancelRun({ runId: closed.run.id });
        yield* workflows.unassignTeam({ teamId: TEAM_A.id });
        yield* workflows.unassignTeam({ teamId: TEAM_B.id });
        for (const { run } of [open, closed])
          deepStrictEqual(
            Option.getOrThrow(yield* runs.getRun({ runId: run.id })).tasks.map(
              (task) => [task.teamId, task.teamName],
            ),
            [
              [null, "Team A"],
              [null, "Team B"],
            ],
          );
        strictEqual(
          (yield* workflows.listWorkflows({ teams: TEAMS })).find(
            (w) => w.id === a.id,
          )?.unassigned,
          true,
        );
      }),
    ));

  it("a reopened task whose team was deleted is unassigned", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const runs = yield* RunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        const cut = run?.tasks[0];
        if (run === undefined || cut === undefined) throw new Error("no run");
        yield* runs.markTaskDone({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* workflows.unassignTeam({ teamId: TEAM_A.id });
        yield* runs.reopenTask({ runTaskId: cut.id, actor: MERCHANT });
        const reopened = Option.getOrThrow(
          yield* runs.getRun({ runId: run.run.id }),
        ).tasks[0];
        deepStrictEqual(
          [reopened?.doneAt, reopened?.teamId, reopened?.teamName],
          [null, null, "Team A"],
        );
        strictEqual((yield* runListRows({ teamIds: [TEAM_A.id] })).length, 0);
      }),
    ));

  it("an unassigned task leaves every list and cannot be worked; assigning a team brings it back", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* RunRepository;
        const workflows = yield* WorkflowRepository;
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const [run] = yield* runsForOrder();
        if (run === undefined) throw new Error("no run");
        const [cut, finish] = run.tasks;
        if (cut === undefined || finish === undefined)
          throw new Error("no tasks");
        yield* runs.markTaskDone({
          runTaskId: cut.id,
          actor: memberActor("m1"),
          teamIds: [TEAM_A.id],
        });
        yield* workflows.unassignTeam({ teamId: TEAM_A.id });
        yield* workflows.unassignTeam({ teamId: TEAM_B.id });
        strictEqual((yield* runListRows({ teamIds: [TEAM_B.id] })).length, 0);
        const refused = yield* runs
          .startTask({
            runTaskId: finish.id,
            actor: memberActor("m2"),
            teamIds: [TEAM_B.id],
          })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "RunNotAllowedError");
        // The definition is unassigned too; the workflow cannot create runs.
        strictEqual(
          (yield* workflows.listWorkflows({ teams: TEAMS })).find(
            (w) => w.id === a.id,
          )?.unassigned,
          true,
        );
        const none = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"]), lineItem(2, ["a"])],
        );
        strictEqual(none.created, 0);
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
        yield* runs.markTaskDone({
          runTaskId: finish.id,
          actor: memberActor("m3"),
          teamIds: [TEAM_C.id],
        });
        // A done task is never assigned; a missing task is not found.
        strictEqual(
          (yield* runs
            .assignRunTaskTeam({ runTaskId: finish.id, team: TEAM_A })
            .pipe(Effect.flip))._tag,
          "TaskDoneError",
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

describe("RunRepository open-run ceiling", () => {
  it("the open-run ceiling is counted once per pass, each create spends one and a close refunds nothing", () =>
    withMaxOpenRuns(2, () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
          // One open run, room for one more. Item 1 drops to zero and two
          // single matches arrive: the close refunds nothing, item 2 spends
          // the one room, and item 3, after it in stored order, is declined.
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [
              lineItem(1, ["a"], { currentQuantity: 0 }),
              lineItem(2, ["a"]),
              lineItem(3, ["b"]),
            ],
          );
          strictEqual(counts.closed, 1);
          strictEqual(counts.created, 1);
          strictEqual(typeof (yield* usageRow()), "number");
          deepStrictEqual(
            (yield* runsForOrder()).map(({ run }) => [
              run.lineItemId,
              run.state,
            ]),
            [
              [lineItem(1, []).id, "closed"],
              [lineItem(2, []).id, "open"],
            ],
          );
        }),
      ),
    ));

  it("a declined run raises the open-run ceiling flag and the run's last Done clears it", () =>
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
          // Take the one run to done: both tasks done takes it out of
          // `open`, which is what releases the flag.
          const [detail] = yield* runsForOrder();
          if (detail === undefined) throw new Error("no run");
          yield* complete(detail, 1, [TEAM_A.id]);
          yield* complete(detail, 2, [TEAM_B.id]);
          strictEqual(yield* usageRow(), null);
        }),
      ),
    ));

  it("the write that releases the open-run ceiling creates the runs that were declined", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          const { b } = yield* seed;
          const runs = yield* RunRepository;
          const counts = yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          strictEqual(counts.created, 1);
          const [detail] = yield* runsForOrder();
          if (detail === undefined) throw new Error("no run");
          const first = yield* complete(detail, 1, [TEAM_A.id]);
          strictEqual(first.ceilingReleased, false);
          // The run's last Done takes it out of `open`: the write says the
          // ceiling released, and the reconcile all its caller runs creates
          // the run reconcile declined.
          const last = yield* complete(detail, 2, [TEAM_B.id]);
          strictEqual(last.ceilingReleased, true);
          yield* runs.reconcileAll(yield* loadEligibleContext);
          const after = yield* runsForOrder();
          deepStrictEqual(
            after.map(({ run }) => [run.workflowId, run.state]),
            [
              [detail.run.workflowId, "done"],
              [b.id, "open"],
            ],
          );
        }),
      ),
    ));

  it("Cancel workflow releases the ceiling", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          const runs = yield* RunRepository;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          strictEqual(typeof (yield* usageRow()), "number");
          const [detail] = yield* runsForOrder();
          if (detail === undefined) throw new Error("no run");
          const cancelled = yield* runs.cancelRun({ runId: detail.run.id });
          strictEqual(cancelled.ceilingReleased, true);
          strictEqual(yield* usageRow(), null);
        }),
      ),
    ));

  it("a close by reconcile releases the open-run ceiling and says so", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          strictEqual(typeof (yield* usageRow()), "number");
          // The order is cancelled: the pass closes its one run, which is
          // the write that brings the shop under the ceiling.
          const counts = yield* upsertAndReconcile(
            order({
              cancelledAt: PROCESSED_AT + 1,
              updatedAt: PROCESSED_AT + 1,
            }),
            [lineItem(1, ["a"]), lineItem(2, ["b"])],
          );
          strictEqual(counts.closed, 1);
          strictEqual(counts.ceilingReleased, true);
          strictEqual(yield* usageRow(), null);
          // A pass with nothing to close never says it released.
          const again = yield* upsertAndReconcile(
            order({
              cancelledAt: PROCESSED_AT + 1,
              updatedAt: PROCESSED_AT + 2,
            }),
            [lineItem(1, ["a"]), lineItem(2, ["b"])],
          );
          strictEqual(again.ceilingReleased, false);
        }),
      ),
    ));

  it("a pass that closes and declines reports released and raises the flag again", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          yield* seed;
          // Room for one run: item 1 gets it, item 2 is declined.
          yield* upsertAndReconcile(order(), [
            lineItem(1, ["a"]),
            lineItem(2, ["b"]),
          ]);
          strictEqual(typeof (yield* usageRow()), "number");
          // Item 1 drops to zero units: the pass closes its run, which
          // releases the ceiling, and still declines item 2, because the
          // budget was counted before the close.
          const counts = yield* upsertAndReconcile(
            order({ updatedAt: PROCESSED_AT + 1 }),
            [lineItem(1, ["a"], { currentQuantity: 0 }), lineItem(2, ["b"])],
          );
          strictEqual(counts.closed, 1);
          strictEqual(counts.created, 0);
          strictEqual(counts.ceilingReleased, true);
          strictEqual(typeof (yield* usageRow()), "number");
        }),
      ),
    ));

  it("manual attach fails at the ceiling rather than silently doing nothing", () =>
    withMaxOpenRuns(1, () =>
      runInRepository(
        Effect.gen(function* () {
          const { a, b } = yield* seed;
          const runs = yield* RunRepository;
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
            }),
          );
          strictEqual(refused._tag, "RunLimitError");
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

describe("RunRepository metering", () => {
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

  it("a resize rewrites the quantity and counts nothing", () =>
    runInRepository(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const countedAt = () =>
          sql`select countedAt from ShopOrder where id = ${ORDER_ID}`.values.pipe(
            Effect.map((rows) => rows[0]?.[0] ?? null),
          );
        yield* upsertAndReconcile(order(), [lineItem(1, ["a"])]);
        const counted = yield* countedAt();
        strictEqual(typeof counted, "number");
        const events = yield* usageEvents();
        strictEqual(events.length, 1);

        const counts = yield* upsertAndReconcile(
          order({ updatedAt: PROCESSED_AT + 1 }),
          [lineItem(1, ["a"], { currentQuantity: 3 })],
        );
        strictEqual(counts.resized, 1);
        const [detail] = yield* runsForOrder();
        strictEqual(detail?.run.quantity, 3);
        strictEqual(yield* countedAt(), counted);
        deepStrictEqual(yield* usageEvents(), events);
        strictEqual((yield* usage()).ordersThisCycle, 1);
        strictEqual((yield* usage()).openRunsLimitedAt, null);
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

  it("a manual attach counts the order if nothing has yet", () =>
    runInRepository(
      Effect.gen(function* () {
        const { a } = yield* seed;
        const runs = yield* RunRepository;
        const orders = yield* OrderRepository;
        // Unpaid, so reconcile creates nothing and counts nothing; the
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
        strictEqual(counts.closed, 1);
        // The count is never given back: the shop carried the work up to the
        // moment the merchant stopped it.
        strictEqual((yield* usage()).ordersThisCycle, 1);
        deepStrictEqual(yield* usageEvents(), [
          { idempotencyKey: `${ORDER_ID}#count`, value: 1 },
        ]);
      }),
    ));
});
