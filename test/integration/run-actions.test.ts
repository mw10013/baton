import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Match, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import ordersSource from "@/lib/domain/Orders.ts?raw";
import source from "@/lib/domain/ShopWork.ts?raw";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";

import * as ActionTable from "../../scripts/lib/spec.ts";
import { openMemberSocket, openMerchantSocket } from "./agent-socket";

/**
 * The action matrices on `Domain.runActions` and `Domain.taskActions`, read
 * out of their JSDoc in `domain/ShopWork.ts` rather than copied here, one test per
 * row, titled with the row rendered back so a failing test names the cell.
 * The second half drives every `ShopAgent` callable into every row's state
 * and asserts it answers as the cell says: the page and the server read one
 * function, and these are the proof that the server does.
 */

const RUN_ROWS = Result.getOrThrow(ActionTable.parse(source, "runActions"));
const TASK_ROWS = Result.getOrThrow(ActionTable.parse(source, "taskActions"));

const T = Schema.decodeUnknownSync(Domain.TeamId)("t");
/** A team the member is not on, holding the run's current task in a "v" fixture. */
const OTHER = Schema.decodeUnknownSync(Domain.TeamId)("other");
const MERCHANT: Domain.Actor = { role: "merchant" };
const MEMBER: Domain.Actor = {
  role: "member",
  memberId: Schema.decodeUnknownSync(Domain.MemberId)("m"),
  email: Schema.decodeUnknownSync(Domain.Email)("m@example.com"),
  teamIds: [T],
};
/** A member on none of the run's teams: every "m" cell is blank for them. */
const OUTSIDER: Domain.Actor = { ...MEMBER, teamIds: [] };

const OPEN_ORDER: Domain.OrderState = {
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
};

const run = (state: Domain.RunState, blocked = false) => ({
  state,
  blockedAt: blocked ? 1 : null,
});

/** Whether a cell offers the action to "M", "m" or "v". */
const offered = (cell: ActionTable.Cell | undefined, who: "M" | "m" | "v") =>
  (cell ?? "").split(" ").includes(who);

/** The result object a row's cells say `who` gets. */
const expectedOf = (row: ActionTable.Row, who: "M" | "m" | "v") =>
  Object.fromEntries(
    Object.entries(row.cells).map(([field, cell]) => [
      field,
      offered(cell, who),
    ]),
  );

const CONTEXT = { teamId: T };

describe("Domain.runActions matrix", () => {
  for (const row of RUN_ROWS)
    it(ActionTable.renderRow("runActions", row), () => {
      for (const fixture of ActionTable.expand("runActions", row, CONTEXT)) {
        const { order, run: state, tasks = [], item } = fixture;
        deepStrictEqual(
          Domain.runActions(MERCHANT, order, state, tasks, item),
          expectedOf(row, "M"),
        );
        deepStrictEqual(
          Domain.runActions(MEMBER, order, state, tasks, item),
          expectedOf(row, "m"),
        );
        // "v": the member's task is not current; on an open run another
        // team's is. On a done or closed run neither is, and "v" and "m"
        // coincide there, as the cells do.
        const visibleTasks = [
          { teamId: T, current: false },
          { teamId: OTHER, current: Domain.runIsOpen(state) },
        ];
        deepStrictEqual(
          Domain.runActions(MEMBER, order, state, visibleTasks, item),
          expectedOf(row, "v"),
        );
      }
    });

  it("without the item, Change workflow is not offered", () => {
    strictEqual(
      Domain.runActions(MERCHANT, OPEN_ORDER, run("open"), [
        { teamId: T, current: true },
      ]).changeWorkflow,
      false,
    );
  });
});

/** The task set that offers nothing. */
const NOTHING: Domain.TaskActions = {
  start: false,
  done: false,
  putBack: false,
  reopen: false,
  assign: false,
};

/** The one row of `rows` whose state words are `state`. */
const rowWhere = (
  rows: readonly ActionTable.Row[],
  state: Readonly<Record<string, string>>,
) => {
  const found = rows.find((row) =>
    Object.entries(state).every(([column, word]) => row.state[column] === word),
  );
  if (found === undefined) throw new Error(JSON.stringify(state));
  return found;
};

const task = (
  overrides: Partial<
    Pick<
      Domain.RunTaskRow,
      "current" | "startedAt" | "doneAt" | "laterStepStarted"
    >
  > = {},
) => ({
  teamId: T,
  current: true,
  startedAt: null,
  doneAt: null,
  laterStepStarted: false,
  ...overrides,
});

describe("Domain.taskActions matrix", () => {
  for (const row of TASK_ROWS)
    it(ActionTable.renderRow("taskActions", row), () => {
      for (const fixture of ActionTable.expand("taskActions", row, CONTEXT)) {
        const { order, run: state, task: view } = fixture;
        deepStrictEqual(
          Domain.taskActions(MERCHANT, order, state, view),
          expectedOf(row, "M"),
        );
        deepStrictEqual(
          Domain.taskActions(MEMBER, order, state, view),
          expectedOf(row, "m"),
        );
      }
    });

  it("a task on no team is nobody's: every member cell is blank and every merchant cell holds", () => {
    const ready = rowWhere(TASK_ROWS, {
      order: "open",
      run: "open",
      blocked: "no",
      task: "ready",
    });
    // No team, and a team that no longer exists: one answer for both.
    for (const teamId of [
      null,
      Schema.decodeUnknownSync(Domain.TeamId)("gone"),
    ]) {
      const view = { ...task(), teamId };
      deepStrictEqual(
        Domain.taskActions(MEMBER, OPEN_ORDER, run("open"), view),
        NOTHING,
      );
      deepStrictEqual(
        Domain.taskActions(MERCHANT, OPEN_ORDER, run("open"), view),
        expectedOf(ready, "M"),
      );
    }
  });
});

const workflowOf = (id: string, name: string): Domain.Workflow => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  name: Schema.decodeUnknownSync(Domain.WorkflowName)(name),
  tag: Schema.decodeUnknownSync(Domain.WorkflowTag)(name.toLowerCase()),
  state: "on",
  updatedAt: 0,
});

const lineItemOf = (
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: "li",
  orderId: "o",
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  productTags: [],
  properties: [],
  ...overrides,
});

const detailOf = (
  state: Domain.RunState,
  lineItemId = "li",
): Domain.RunDetail => ({
  run: {
    id: Schema.decodeUnknownSync(Domain.RunId)("r"),
    workflowId: Schema.decodeUnknownSync(Domain.WorkflowId)("w1"),
    workflowName: Schema.decodeUnknownSync(Domain.WorkflowName)("Engrave"),
    orderId: "o",
    orderName: "#1",
    orderProcessedAt: 0,
    lineItemId,
    lineItemTitle: "Ring",
    variantTitle: null,
    sku: null,
    quantity: 1,
    lineItemProperties: [],
    state,
    blockedAt: null,
    blockReason: null,
    blockedBy: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    closedAt: state === "closed" ? 1 : null,
    closedReason: state === "closed" ? "merchant_cancelled" : null,
  },
  tasks: [],
});

const TEAMS = [{ id: Schema.decodeUnknownSync(Domain.TeamId)("t") }];

/** `workflow` with one task on team `t`: eligible when on. */
const withTask = (workflow: Domain.Workflow): Domain.WorkflowDetail => ({
  workflow,
  tasks: [
    {
      id: Schema.decodeUnknownSync(Domain.WorkflowTaskId)(`${workflow.id}-t`),
      position: 1,
      step: 1,
      name: Schema.decodeUnknownSync(Domain.TaskName)("Task"),
      teamId: TEAMS[0]?.id ?? null,
      instructions: null,
    },
  ],
});

const stateOf = (
  item: Domain.OrderLineItem,
  runs: readonly Domain.RunDetail[],
  offered: readonly Domain.Workflow[],
) => Domain.lineItemState(item, runs, offered.map(withTask), [], TEAMS);

const kindOf = (
  item: Domain.OrderLineItem,
  runs: readonly Domain.RunDetail[],
  offered: readonly Domain.Workflow[],
) => stateOf(item, runs, offered).kind;

/**
 * The actions table on `Domain.reconcileItem`, read out of its JSDoc: one
 * test per row, titled with the row, each fixture the row stands for
 * (`expandReconcileAction`) asserted against the action cell.
 */
describe("Domain.reconcileItem actions", () => {
  const ACTION_ROWS = Result.getOrThrow(
    ActionTable.parseReconcileActions(source),
  );
  const MATCHED = ["w1", "w2"].map((id) =>
    Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  );
  for (const row of ACTION_ROWS)
    it(row.text, () => {
      for (const fixture of ActionTable.expandReconcileAction(row)) {
        const action = Domain.reconcileItem({
          order: fixture.order,
          item: { currentQuantity: fixture.units },
          run:
            fixture.run === null
              ? null
              : {
                  run: {
                    state: fixture.run.state,
                    quantity: fixture.run.quantity,
                  },
                },
          matched: MATCHED.slice(0, fixture.matched),
        });
        const where = JSON.stringify(fixture);
        strictEqual(action._tag, row.action.tag, where);
        if (action._tag === "close" && row.action.tag === "close")
          strictEqual(action.reason, row.action.reason, where);
        if (action._tag === "resize")
          strictEqual(action.units, fixture.units, where);
        if (action._tag === "create")
          strictEqual(action.workflowId, MATCHED[0], where);
      }
    });
});

type PostFixture = ActionTable.ReconcileFixture;
type FixtureRun = ActionTable.ReconcileFixtureRun | null;

const POST_MATCHED = ["w1", "w2"].map((id) =>
  Schema.decodeUnknownSync(Domain.WorkflowId)(id),
);

const plan = (fixture: PostFixture, run: FixtureRun, units: number) =>
  Domain.reconcileItem({
    order: fixture.order,
    item: { currentQuantity: units },
    run:
      run === null
        ? null
        : { run: { state: run.state, quantity: run.quantity } },
    matched: POST_MATCHED.slice(0, fixture.matched),
  });

/** The run an action leaves on the item; `units` is what a create copies. */
const apply = (
  run: FixtureRun,
  action: Domain.ReconcileAction,
  units: number,
): FixtureRun =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      create: (): FixtureRun => ({ state: "open", quantity: units }),
      close: (): FixtureRun =>
        run === null ? null : { ...run, state: "closed" },
      resize: ({ units: resized }): FixtureRun =>
        run === null ? null : { ...run, quantity: resized },
      nothing: (): FixtureRun => run,
    }),
  );

const stopped = (fixture: PostFixture) =>
  Domain.orderIsCancelled(fixture.order) ||
  Domain.orderIsFulfilled(fixture.order);

const same = (a: FixtureRun, b: FixtureRun) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The five clauses of the post-condition, each over the fixture (before) and the run a pass left. */
const CLAUSES = {
  stop: (fixture: PostFixture, after: FixtureRun) =>
    !stopped(fixture) || after === null || after.state !== "open",
  fit: (fixture: PostFixture, after: FixtureRun) =>
    stopped(fixture) ||
    fixture.run?.state !== "open" ||
    (fixture.units === 0
      ? after?.state === "closed"
      : after?.state === "open" && after.quantity === fixture.units),
  record: (fixture: PostFixture, after: FixtureRun) =>
    fixture.run === null ||
    fixture.run.state === "open" ||
    same(after, fixture.run),
  create: (fixture: PostFixture, after: FixtureRun) =>
    stopped(fixture) ||
    fixture.run !== null ||
    (after !== null) ===
      (Domain.orderCanCreateRuns(fixture.order) &&
        fixture.units > 0 &&
        fixture.matched === 1),
};

/**
 * A pass over a stored run whose item is not stored: read as an item at
 * zero units with no match (`RunRepository.reconcileOrder`).
 */
const orphanPass = (
  fixture: PostFixture,
  run: FixtureRun,
): Domain.ReconcileAction => plan({ ...fixture, matched: 0 }, run, 0);

const orphan = (before: FixtureRun, after: FixtureRun) =>
  before?.state !== "open" || after?.state === "closed";

/**
 * The post-condition on `Domain.reconcileItem` ("What a pass guarantees"),
 * checked on every fixture the actions table can name rather than on the
 * rows: each clause is a predicate over the state before and after one
 * pass, so a failure names the clause, and a second pass over the state the
 * first left must write nothing.
 */
describe("Domain.reconcileItem post-condition", () => {
  it("a pass guarantees stop, fit, record, create and orphan, and a second pass writes nothing", () => {
    const universe = ActionTable.reconcileActionUniverse();
    expect(universe.length).toBeGreaterThan(0);
    for (const fixture of universe) {
      const where = JSON.stringify(fixture);
      const first = plan(fixture, fixture.run, fixture.units);
      const after = apply(fixture.run, first, fixture.units);
      for (const [clause, holds] of Object.entries(CLAUSES))
        strictEqual(holds(fixture, after), true, `${clause}: ${where}`);
      deepStrictEqual(
        plan(fixture, after, fixture.units),
        { _tag: "nothing" },
        `second pass: ${where}`,
      );
      if (fixture.run !== null) {
        const left = apply(fixture.run, orphanPass(fixture, fixture.run), 0);
        strictEqual(orphan(fixture.run, left), true, `orphan: ${where}`);
        deepStrictEqual(
          orphanPass(fixture, left),
          { _tag: "nothing" },
          `orphan second pass: ${where}`,
        );
      }
    }
  });
});

describe("Domain.syncOrder actions", () => {
  const SYNC_ROWS = Result.getOrThrow(
    ActionTable.parseSyncActions(ordersSource),
  );
  const SYNCED_AT = Date.UTC(2026, 9, 1);
  const DAY = 86_400_000;
  const STORED_VERSION = 100;
  const versions = { older: [50], "same or newer": [100, 150] } as const;
  const ages = {
    expired: Domain.retentionCutoff(SYNCED_AT) - DAY,
    kept: Domain.retentionCutoff(SYNCED_AT) + DAY,
  } as const;
  for (const row of SYNC_ROWS)
    it(row.text, () => {
      for (const fixture of ActionTable.expandSyncAction(row))
        for (const updatedAt of versions[fixture.version]) {
          const action = Domain.syncOrder({
            stored:
              fixture.stored === "none" ? null : { updatedAt: STORED_VERSION },
            incoming: {
              updatedAt,
              processedAt: ages[fixture.age],
              syncedAt: SYNCED_AT,
            },
            atCeiling: fixture.ceiling === "at",
          });
          const where = JSON.stringify({ ...fixture, updatedAt });
          strictEqual(action._tag, row.action.tag, where);
          if (action._tag === "write")
            strictEqual(
              action.fresh,
              row.action.note.startsWith("fresh"),
              where,
            );
          if (action._tag === "refuse")
            strictEqual(action.reason, row.action.note.split(";")[0], where);
        }
    });
});

describe("Domain.lineItemState", () => {
  it("lineItemState has one kind per layout", () => {
    const engrave = workflowOf("w1", "Engrave");
    const polish = workflowOf("w2", "Polish");
    const workflows = [polish, engrave];
    const kind = (
      item: Domain.OrderLineItem,
      runs: readonly Domain.RunDetail[],
      offered: readonly Domain.Workflow[] = workflows,
    ) => kindOf(item, runs, offered);
    strictEqual(kind(lineItemOf(), [detailOf("open")]), "open");
    strictEqual(kind(lineItemOf(), [detailOf("done")]), "ended");
    strictEqual(kind(lineItemOf(), [detailOf("closed")]), "ended");
    // A run is the news even when the line went to zero under it.
    strictEqual(
      kind(lineItemOf({ currentQuantity: 0 }), [detailOf("open")]),
      "open",
    );
    strictEqual(kind(lineItemOf({ currentQuantity: 0 }), []), "removed");
    strictEqual(kind(lineItemOf(), [], []), "unmatched");
    strictEqual(kind(lineItemOf(), [detailOf("open", "other")]), "attachable");

    const attachable = stateOf(
      lineItemOf({ productTags: ["engrave", "polish"] }),
      [],
      [polish, engrave, workflowOf("w3", "Rush")],
    );
    if (attachable.kind !== "attachable") throw new Error(attachable.kind);
    strictEqual(attachable.multiMatch, true);
    // Matched first, in the teams' order, then the rest.
    deepStrictEqual(
      attachable.options.map((workflow) => workflow.name),
      ["Polish", "Engrave", "Rush"],
    );

    // A done or closed item keeps its run's tasks as the record and offers
    // every workflow, its own included.
    for (const state of ["done", "closed"] as const) {
      const detail = detailOf(state);
      const ended = stateOf(lineItemOf(), [detail], workflows);
      if (ended.kind !== "ended") throw new Error(ended.kind);
      strictEqual(ended.run.id, detail.run.id);
      deepStrictEqual(ended.tasks, []);
      deepStrictEqual(
        ended.options.map((workflow) => workflow.id),
        [polish.id, engrave.id],
      );
      strictEqual(ended.attachable, true);
      // Nothing left to make: the run stands, and no workflow starts.
      const emptied = stateOf(
        lineItemOf({ currentQuantity: 0 }),
        [detailOf(state)],
        workflows,
      );
      if (emptied.kind !== "ended") throw new Error(emptied.kind);
      strictEqual(emptied.attachable, false);
    }
  });
});

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const ORDER_ID = "gid://shopify/Order/1";
const LINE_ITEM_ID = "gid://shopify/LineItem/1";

const seedTeam = (shop: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      yield* repo.upsertShopSession({
        shop: Schema.decodeUnknownSync(Domain.Shop)(shop),
        shopGid: Schema.decodeUnknownSync(Domain.ShopGid)(
          "gid://shopify/Shop/1",
        ),
        shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
          `agent-${shop}`,
        ),
        scope: null,
        accessTokenExpiresAt: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      return yield* repo.createTeam({
        shop: Schema.decodeUnknownSync(Domain.Shop)(shop),
        name: Schema.decodeUnknownSync(Domain.TeamName)("Bench"),
      });
    }).pipe(Effect.provide(layer)),
  );

const seedOrder = (shop: string) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          const now = Date.now();
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: ORDER_ID,
              legacyId: "1",
              name: "#1001",
              processedAt: now,
              updatedAt: now,
              cancelledAt: null,
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              note: null,
              syncedAt: now,
            },
            lineItems: [lineItemOf({ id: LINE_ITEM_ID, orderId: ORDER_ID })],
            afterWrite: Effect.void,
          });
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              OrderRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

type Who = "M" | "m";
type Call = () => Promise<{ readonly _tag: string }>;

/** One task's recorded progress, as the reset writes it. */
interface Progress {
  readonly startedAt: number | null;
  readonly doneAt: number | null;
}
const IDLE: Progress = { startedAt: null, doneAt: null };

/** A live run's ids. Change workflow replaces the run, so this is re-read after it. */
interface LiveRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly cut: string;
  readonly polish: string;
}

/**
 * The seeded run's two tasks for a fixture, and which one is under test.
 * Cut is step 0 and Polish step 1, so Polish is waiting while Cut is open,
 * and Cut's downstream is Polish. A done task with no downstream start on a
 * done run is Polish: Cut's downstream is done there, which is started.
 */
const tasksFor = (
  fixture: ActionTable.Fixture<Domain.TeamId>,
): {
  readonly target: "cut" | "polish";
  readonly cut: Progress;
  readonly polish: Progress;
} => {
  const { current, startedAt, doneAt, laterStepStarted } = fixture.task;
  const runDone = Domain.runIsDone(fixture.run);
  const done = { startedAt: 1, doneAt: 2 };
  if (doneAt === null)
    return current
      ? { target: "cut", cut: { startedAt, doneAt }, polish: IDLE }
      : { target: "polish", cut: IDLE, polish: IDLE };
  if (laterStepStarted)
    return {
      target: "cut",
      cut: done,
      polish: { startedAt: 3, doneAt: runDone ? 4 : null },
    };
  return runDone
    ? { target: "polish", cut: done, polish: { startedAt: 3, doneAt: 4 } }
    : { target: "cut", cut: done, polish: IDLE };
};

/**
 * Puts the live run into a fixture's state by writing the object's SQLite,
 * every column the fixture touches set from scratch so no fixture inherits
 * the last call's writes. These are states reconcile, Shopify or a replay of
 * callables would produce; writing them is faster and names the state
 * exactly.
 */
const reset = (
  shop: string,
  live: LiveRun,
  teamId: string,
  fixture: ActionTable.Fixture<Domain.TeamId>,
  tasks: { readonly cut: Progress; readonly polish: Progress },
) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) => {
      const sql = state.storage.sql;
      const { order, run: target, item } = fixture;
      const closed = Domain.runIsClosed(target);
      sql.exec(
        "update ShopOrder set cancelledAt = ?, fulfillmentStatus = ? where id = ?",
        order.cancelledAt,
        order.fulfillmentStatus,
        ORDER_ID,
      );
      sql.exec(
        "update OrderLineItem set currentQuantity = ? where id = ?",
        item?.currentQuantity ?? 1,
        LINE_ITEM_ID,
      );
      sql.exec(
        "update Run set state = ?, blockedAt = ?, blockedBy = ?, blockReason = null, closedAt = ?, closedReason = ? where id = ?",
        target.state,
        target.blockedAt,
        target.blockedAt === null ? null : JSON.stringify(MERCHANT),
        closed ? 1 : null,
        closed ? "merchant_cancelled" : null,
        live.runId,
      );
      for (const [id, progress] of [
        [live.cut, tasks.cut],
        [live.polish, tasks.polish],
      ] as const) {
        const started = progress.startedAt !== null;
        const done = progress.doneAt !== null;
        sql.exec(
          "update RunTask set teamId = ?, startedAt = ?, startedByEmail = ?, startedByRole = ?, doneAt = ?, doneByEmail = ?, doneByRole = ? where id = ?",
          teamId,
          progress.startedAt,
          started ? "m1@example.com" : null,
          started ? "member" : null,
          progress.doneAt,
          done ? "m1@example.com" : null,
          done ? "member" : null,
          id,
        );
      }
    },
  );

/** Each callable in a cell map with its cell and actor; an actor with no callable for a cell has no entry. */
const entriesOf = (
  calls: Readonly<Record<string, Partial<Record<Who, Call>>>>,
) =>
  Object.entries(calls).flatMap(([cell, byWho]) =>
    (["M", "m"] as const).flatMap((who) => {
      const call = byWho[who];
      return call === undefined ? [] : [{ cell, who, call }];
    }),
  );

/** The tag a filled cell's callable answers, except where `taskOk` names another. */
const OK = "Ok";
const NOT_ALLOWED = "NotAllowed";

const ACTION_SHOP = "run-actions-refuse.myshopify.com";

describe("ShopAgent refuses what the action set refuses", () => {
  /**
   * Every callable is driven into every expanded row of {@link
   * Domain.runActions}' and {@link Domain.taskActions}' tables, as the
   * merchant and as a member on the run's team, and must answer as the cell
   * says: success on a filled cell, `NotAllowed` on a blank one. The pure
   * half above proves the formula matches the table; this half proves each
   * callable reads that formula with the right inputs in every state. A
   * cell with no callable for an actor (member Cancel, merchant Start) is
   * skipped for that actor; the pure half covers its false side.
   *
   * "v" is not driven here. The pure half proves the formula equals the
   * table for "v", and this half proves each callable reads the formula
   * with the live inputs, which the "m" fixtures already exercise; a "v"
   * fixture would need a second team on the live run for no new proof.
   */
  const setup = async () => {
    const shop = ACTION_SHOP;
    const team = await seedTeam(shop);
    await seedOrder(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const build = async (name: string) => {
      const created = await agent.createWorkflow({
        name,
        tag: name.toLowerCase(),
      });
      if (created._tag !== "Ok") throw new Error(created._tag);
      for (const step of ["Cut", "Polish"])
        await agent.addStep({
          workflowId: created.workflow.id,
          name: step,
          teamId: team.id,
        });
      const applied = await agent.applyDraft({
        workflowId: created.workflow.id,
      });
      if (applied._tag !== "Ok") throw new Error(applied._tag);
      const on = await agent.setWorkflowOn({
        workflowId: created.workflow.id,
        on: true,
      });
      if (on._tag !== "Ok") throw new Error(on._tag);
      return created.workflow.id;
    };
    const workflowIds = [await build("Engrave"), await build("Rush")] as const;
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: workflowIds[0],
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const readLive = async (): Promise<LiveRun> => {
      const [detail] = await agent.merchantListRunsForOrder({
        orderId: ORDER_ID,
      });
      const [cut, polish] = detail?.tasks ?? [];
      if (detail === undefined || cut === undefined || polish === undefined)
        throw new Error("run");
      return {
        runId: detail.run.id,
        workflowId: detail.run.workflowId,
        cut: cut.id,
        polish: polish.id,
      };
    };
    const merchant = await openMerchantSocket(shop);
    const member = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [team.id],
    });
    return {
      shop,
      team,
      agent,
      workflowIds,
      merchant,
      member,
      readLive,
      live: await readLive(),
    };
  };
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(async () => {
    ctx.merchant.close();
    ctx.member.close();
    await env.D1.exec("delete from TeamMember");
    await env.D1.exec("delete from Team");
    await env.D1.exec("delete from Member");
    await env.D1.exec("delete from ShopSession");
  });

  /** The run-level callables by cell. Each answers `Ok` on a filled cell. */
  const runCalls = (runId: string) =>
    entriesOf({
      note: {
        M: () => ctx.merchant.setRunNote({ runId, note: "x" }),
        m: () => ctx.member.setRunNote({ runId, note: "x" }),
      },
      block: {
        M: () => ctx.merchant.blockRun({ runId, reason: null }),
        m: () => ctx.member.blockRun({ runId, reason: null }),
      },
      unblock: {
        M: () => ctx.merchant.unblockRun({ runId }),
        m: () => ctx.member.unblockRun({ runId }),
      },
      cancel: { M: () => ctx.agent.merchantCancelRun({ runId }) },
    });

  const otherWorkflow = () => {
    const other = ctx.workflowIds.find((id) => id !== ctx.live.workflowId);
    if (other === undefined) throw new Error("workflow");
    return other;
  };

  /**
   * Change workflow answers with the attach result, not `NotAllowed`:
   * `OrderClosed` or `NothingToMake` on a blank cell. A successful attach
   * replaces the run, reported as `replaced` unless it was closed, so the
   * live ids are re-read and the fixture applied to the new run.
   */
  const checkChangeWorkflow = async (
    row: ActionTable.Row,
    fixture: ActionTable.Fixture<Domain.TeamId>,
    tasks: { readonly cut: Progress; readonly polish: Progress },
  ) => {
    const attached = await ctx.agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: otherWorkflow(),
    });
    const label = `changeWorkflow by M on ${JSON.stringify(fixture)}`;
    if (!offered(row.cells.changeWorkflow, "M")) {
      expect(["OrderClosed", "NothingToMake"], label).toContain(attached._tag);
      return;
    }
    expect(attached._tag, label).toBe(OK);
    expect(attached._tag === "Ok" && attached.replaced !== null, label).toBe(
      !Domain.runIsClosed(fixture.run),
    );
    ctx.live = await ctx.readLive();
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
  };

  const checkRunRow = async (row: ActionTable.Row) => {
    for (const fixture of ActionTable.expand("runActions", row, {
      teamId: ctx.team.id,
    })) {
      const tasks = Domain.runIsDone(fixture.run)
        ? {
            cut: { startedAt: 1, doneAt: 2 },
            polish: { startedAt: 3, doneAt: 4 },
          }
        : { cut: IDLE, polish: IDLE };
      await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      for (const { cell, who, call } of runCalls(ctx.live.runId)) {
        const result = await call();
        expect(
          result._tag,
          `${cell} by ${who} on ${JSON.stringify(fixture)}`,
        ).toBe(offered(row.cells[cell], who) ? OK : NOT_ALLOWED);
        await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      }
      await checkChangeWorkflow(row, fixture, tasks);
    }
  };

  for (const row of RUN_ROWS)
    it(`callables: ${ActionTable.renderRow("runActions", row)}`, () =>
      checkRunRow(row));

  /** The task callables by cell. */
  const taskCalls = (runTaskId: string) =>
    entriesOf({
      start: { m: () => ctx.member.startTask({ runTaskId }) },
      done: {
        M: () => ctx.merchant.markTaskDone({ runTaskId }),
        m: () => ctx.member.markTaskDone({ runTaskId }),
      },
      putBack: {
        M: () => ctx.merchant.putBackTask({ runTaskId }),
        m: () => ctx.member.putBackTask({ runTaskId }),
      },
      reopen: {
        M: () => ctx.merchant.reopenTask({ runTaskId }),
        m: () => ctx.member.reopenTask({ runTaskId }),
      },
      assign: {
        M: () =>
          ctx.agent.merchantAssignRunTaskTeam({
            runTaskId,
            teamId: ctx.team.id,
          }),
      },
    });

  /** The tag a filled task cell's callable answers: `Ok`, but `Assigned` for `assign`. */
  const taskOk = (cell: string) => (cell === "assign" ? "Assigned" : OK);

  const checkTaskRow = async (row: ActionTable.Row) => {
    for (const fixture of ActionTable.expand("taskActions", row, {
      teamId: ctx.team.id,
    })) {
      const tasks = tasksFor(fixture);
      await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      for (const { cell, who, call } of taskCalls(ctx.live[tasks.target])) {
        const result = await call();
        expect(
          result._tag,
          `${cell} by ${who} on ${tasks.target} in ${JSON.stringify(fixture)}`,
        ).toBe(offered(row.cells[cell], who) ? taskOk(cell) : NOT_ALLOWED);
        await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      }
    }
  };

  for (const row of TASK_ROWS)
    it(`callables: ${ActionTable.renderRow("taskActions", row)}`, () =>
      checkTaskRow(row));

  /** The first fixture of the `taskActions` row with these state words, on an open run with no block. */
  const taskFixture = (state: Readonly<Record<string, string>>) => {
    const fixture = ActionTable.expand(
      "taskActions",
      rowWhere(TASK_ROWS, state),
      {
        teamId: ctx.team.id,
      },
    ).find(
      ({ order, run: target }) =>
        Domain.orderIsOpen(order) &&
        Domain.runIsOpen(target) &&
        !Domain.runIsBlocked(target),
    );
    if (fixture === undefined) throw new Error(JSON.stringify(state));
    return fixture;
  };

  it("a member whose teams hold no task of the run gets nothing, the note included", async () => {
    const fixture = taskFixture({ order: "open", task: "ready" });
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasksFor(fixture));
    deepStrictEqual(
      Domain.runActions(OUTSIDER, OPEN_ORDER, run("open"), [
        { teamId: T, current: true },
      ]),
      {
        note: false,
        block: false,
        unblock: false,
        cancel: false,
        changeWorkflow: false,
      },
    );
    deepStrictEqual(
      Domain.taskActions(OUTSIDER, OPEN_ORDER, run("open"), task()),
      NOTHING,
    );
    strictEqual(
      await ctx.agent.memberGetRun({ runId: ctx.live.runId, teamIds: [] }),
      null,
    );
    const outsider = await openMemberSocket(ctx.shop, {
      memberId: "m3",
      memberEmail: "m3@example.com",
      teamIds: [],
    });
    try {
      const noted = await outsider.setRunNote({
        runId: ctx.live.runId,
        note: "x",
      });
      strictEqual(noted._tag, NOT_ALLOWED);
    } finally {
      outsider.close();
    }
  });

  it("callables: a task on no team refuses the member's Done and takes the merchant's", async () => {
    const fixture = taskFixture({ order: "open", task: "ready" });
    const tasks = tasksFor(fixture);
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
    await runInDurableObject(
      env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(ctx.shop)),
      (_instance, state) => {
        state.storage.sql.exec(
          "update RunTask set teamId = null where id = ?",
          ctx.live.cut,
        );
      },
    );
    const byMember = await ctx.member.markTaskDone({ runTaskId: ctx.live.cut });
    strictEqual(byMember._tag, NOT_ALLOWED);
    const byMerchant = await ctx.merchant.markTaskDone({
      runTaskId: ctx.live.cut,
    });
    strictEqual(byMerchant._tag, OK);
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
  });

  it("Undo is offered to the task's whole team, not only to who pressed Done", async () => {
    const fixture = taskFixture({ task: "done", downstream: "none" });
    const tasks = tasksFor(fixture);
    // The reset records m1 as who pressed Done; m2 is m1's teammate.
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
    const teammate = await openMemberSocket(ctx.shop, {
      memberId: "m2",
      memberEmail: "m2@example.com",
      teamIds: [ctx.team.id],
    });
    try {
      const undone = await teammate.reopenTask({
        runTaskId: ctx.live[tasks.target],
      });
      strictEqual(undone._tag, OK);
    } finally {
      teammate.close();
    }
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
  });
});
