import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import source from "@/lib/Domain.ts?raw";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";

import * as ActionTable from "../../scripts/lib/spec.ts";
import { openMemberSocket, openMerchantSocket } from "./agent-socket";

/**
 * The action matrices on `Domain.runActions` and `Domain.taskActions`, read
 * out of their JSDoc in `Domain.ts` rather than copied here, one test per
 * row, titled with the row rendered back so a failing test names the cell.
 * The second half drives every `ShopAgent` callable into every row's state
 * and asserts it answers as the cell says: the page and the server read one
 * function, and these are the proof that the server does.
 */

const RUN_ROWS = Result.getOrThrow(ActionTable.parse(source, "runActions"));
const TASK_ROWS = Result.getOrThrow(ActionTable.parse(source, "taskActions"));

const T = Schema.decodeUnknownSync(Domain.TeamId)("t");
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

const run = (status: Domain.RunStatus, blocked = false) => ({
  status,
  blockedAt: blocked ? 1 : null,
});

const BLOCKER: Domain.ReopenBlocker = {
  taskName: Schema.decodeUnknownSync(Domain.TaskName)("Polish"),
  teamName: Schema.decodeUnknownSync(Domain.TeamName)("Finishing"),
};

/** Whether a cell offers the action to "M" or "m". `blocker` is offered to both. */
const offered = (cell: ActionTable.Cell | undefined, who: "M" | "m") =>
  cell === "blocker" || (cell ?? "").split(" ").includes(who);

/** The `reopen` field a cell says `who` gets: `null` when not offered, otherwise the blocker, `null` meaning the button. */
const reopenOf = (cell: ActionTable.Cell | undefined, who: "M" | "m") => {
  if (!offered(cell, who)) return null;
  return { blockedBy: cell === "blocker" ? BLOCKER : null };
};

/** The result object a row's cells say `who` gets. */
const expectedOf = (row: ActionTable.Row, who: "M" | "m") =>
  Object.fromEntries(
    Object.entries(row.cells).map(([field, cell]) => [
      field,
      field === "reopen" ? reopenOf(cell, who) : offered(cell, who),
    ]),
  );

const CONTEXT = { teamId: T, blocker: BLOCKER };

describe("Domain.runActions matrix", () => {
  for (const row of RUN_ROWS)
    it(ActionTable.renderRow("runActions", row), () => {
      for (const fixture of ActionTable.expand("runActions", row, CONTEXT)) {
        const { order, run: state, task, item } = fixture;
        deepStrictEqual(
          Domain.runActions(MERCHANT, order, state, [task], item),
          expectedOf(row, "M"),
        );
        deepStrictEqual(
          Domain.runActions(MEMBER, order, state, [task], item),
          expectedOf(row, "m"),
        );
      }
    });

  it("without the item, Change workflow is not offered", () => {
    strictEqual(
      Domain.runActions(MERCHANT, OPEN_ORDER, run("active"), [
        { teamId: T, current: true },
      ]).changeWorkflow,
      false,
    );
  });

  it("a member whose team holds no current task gets only the note, and only if the run is theirs to see", () => {
    const tasks = [{ teamId: T, current: false }];
    deepStrictEqual(
      Domain.runActions(MEMBER, OPEN_ORDER, run("active", true), tasks),
      {
        note: true,
        block: false,
        editReason: false,
        unblock: false,
        cancel: false,
        changeWorkflow: false,
      },
    );
    strictEqual(
      Domain.runActions(OUTSIDER, OPEN_ORDER, run("active"), tasks).note,
      false,
    );
  });
});

const task = (
  overrides: Partial<
    Pick<
      Domain.RunTaskView,
      "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
    >
  > = {},
) => ({
  teamId: T,
  current: true,
  startedAt: null,
  doneAt: null,
  reopenBlockedBy: null,
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

  it("a task on none of the member's teams offers the member nothing", () => {
    deepStrictEqual(
      Domain.taskActions(OUTSIDER, OPEN_ORDER, run("active"), task()),
      {
        start: false,
        done: false,
        putBack: false,
        reopen: null,
        assign: false,
      },
    );
  });
});

const workflowOf = (id: string, name: string): Domain.Workflow => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  name: Schema.decodeUnknownSync(Domain.WorkflowName)(name),
  tag: Schema.decodeUnknownSync(Domain.WorkflowTag)(name.toLowerCase()),
  activatedAt: 0,
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
  matchedWorkflowIds: [],
  properties: [],
  ...overrides,
});

const detailOf = (
  status: Domain.RunStatus,
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
    status,
    blockedAt: null,
    blockReason: null,
    blockedBy: null,
    quantityChangedFrom: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    closedAt: status === "closed" ? 1 : null,
    closedReason: status === "closed" ? "merchant_cancelled" : null,
  },
  tasks: [],
});

const kindOf = (
  item: Domain.OrderLineItem,
  runs: readonly Domain.RunDetail[],
  offered: readonly Domain.Workflow[],
) => Domain.lineItemState(item, runs, offered).kind;

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
    strictEqual(kind(lineItemOf(), [detailOf("active")]), "open");
    strictEqual(kind(lineItemOf(), [detailOf("done")]), "done");
    strictEqual(kind(lineItemOf(), [detailOf("closed")]), "closed");
    // A run is the news even when the line went to zero under it.
    strictEqual(
      kind(lineItemOf({ currentQuantity: 0 }), [detailOf("active")]),
      "open",
    );
    strictEqual(kind(lineItemOf({ currentQuantity: 0 }), []), "removed");
    strictEqual(kind(lineItemOf(), [], []), "unmatched");
    strictEqual(kind(lineItemOf(), [detailOf("active", "other")]), "startable");

    const startable = Domain.lineItemState(
      lineItemOf({ matchedWorkflowIds: [engrave.id, polish.id] }),
      [],
      [polish, engrave, workflowOf("w3", "Rush")],
    );
    if (startable.kind !== "startable") throw new Error(startable.kind);
    strictEqual(startable.ambiguous, true);
    // Matched first, in the roster's order, then the rest.
    deepStrictEqual(
      startable.options.map((workflow) => workflow.name),
      ["Polish", "Engrave", "Rush"],
    );

    // A closed item keeps its run's tasks as the record and offers every
    // workflow, the closed one included.
    const closedDetail = detailOf("closed");
    const closed = Domain.lineItemState(
      lineItemOf(),
      [closedDetail],
      workflows,
    );
    if (closed.kind !== "closed") throw new Error(closed.kind);
    strictEqual(closed.run.id, closedDetail.run.id);
    deepStrictEqual(closed.tasks, []);
    deepStrictEqual(
      closed.options.map((workflow) => workflow.id),
      [polish.id, engrave.id],
    );
    strictEqual(closed.startable, true);
    // Nothing left to make: the closed run stands, and no workflow starts.
    const emptied = Domain.lineItemState(
      lineItemOf({ currentQuantity: 0 }),
      [detailOf("closed")],
      workflows,
    );
    if (emptied.kind !== "closed") throw new Error(emptied.kind);
    strictEqual(emptied.startable, false);
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
              lineItemsTruncated: false,
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
  fixture: ActionTable.Fixture<Domain.TeamId, Domain.ReopenBlocker>,
): {
  readonly target: "cut" | "polish";
  readonly cut: Progress;
  readonly polish: Progress;
} => {
  const { current, startedAt, doneAt, reopenBlockedBy } = fixture.task;
  const runDone = Domain.runIsDone(fixture.run);
  const done = { startedAt: 1, doneAt: 2 };
  if (doneAt === null)
    return current
      ? { target: "cut", cut: { startedAt, doneAt }, polish: IDLE }
      : { target: "polish", cut: IDLE, polish: IDLE };
  if (reopenBlockedBy !== null)
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
  fixture: ActionTable.Fixture<Domain.TeamId, Domain.ReopenBlocker>,
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
        "update Run set status = ?, blockedAt = ?, blockedBy = ?, blockReason = null, closedAt = ?, closedReason = ?, quantityChangedFrom = null where id = ?",
        target.status,
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
          "update RunTask set teamId = ?, startedAt = ?, startedByEmail = ?, startedByRole = ?, doneAt = ?, doneByEmail = ?, doneByRole = ?, reopenedAt = null, reopenedByRole = null, reopenedByEmail = null where id = ?",
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
      const on = await agent.setWorkflowActive({
        workflowId: created.workflow.id,
        active: true,
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
      editReason: {
        M: () => ctx.merchant.setBlockReason({ runId, reason: "x" }),
        m: () => ctx.member.setBlockReason({ runId, reason: "x" }),
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
   * `ItemDone`, `OrderClosed` or `NothingToMake` on a blank cell. A
   * successful attach replaces the run, so the live ids are re-read and the
   * fixture applied to the new run.
   */
  const checkChangeWorkflow = async (
    row: ActionTable.Row,
    fixture: ActionTable.Fixture<Domain.TeamId, Domain.ReopenBlocker>,
    tasks: { readonly cut: Progress; readonly polish: Progress },
  ) => {
    const attached = await ctx.agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: otherWorkflow(),
    });
    const label = `changeWorkflow by M on ${JSON.stringify(fixture)}`;
    if (!offered(row.cells.changeWorkflow, "M")) {
      expect(["ItemDone", "OrderClosed", "NothingToMake"], label).toContain(
        attached._tag,
      );
      return;
    }
    expect(attached._tag, label).toBe(OK);
    expect(attached._tag === "Ok" && attached.replaced, label).not.toBe(null);
    ctx.live = await ctx.readLive();
    await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
  };

  const checkRunRow = async (row: ActionTable.Row) => {
    for (const fixture of ActionTable.expand("runActions", row, {
      teamId: ctx.team.id,
      blocker: BLOCKER,
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
      // On a closed run attach is the closed item's picker, whose rule is
      // `Domain.lineItemState`, not this table, so it is not called there.
      if (!Domain.runIsClosed(fixture.run))
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

  /**
   * The tag a filled task cell's callable answers. Two are not `Ok`:
   * `assign` answers `Assigned`, and a `blocker` cell under `reopen` answers
   * `ReopenBlocked`, because the table says the button is drawn with that
   * sentence and the callable refuses for the downstream start rather than
   * the action set.
   */
  const taskOk = (cell: string, value: ActionTable.Cell | undefined) => {
    if (cell === "assign") return "Assigned";
    if (value === "blocker") return "ReopenBlocked";
    return OK;
  };

  const checkTaskRow = async (row: ActionTable.Row) => {
    for (const fixture of ActionTable.expand("taskActions", row, {
      teamId: ctx.team.id,
      blocker: BLOCKER,
    })) {
      const tasks = tasksFor(fixture);
      await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      for (const { cell, who, call } of taskCalls(ctx.live[tasks.target])) {
        const result = await call();
        expect(
          result._tag,
          `${cell} by ${who} on ${tasks.target} in ${JSON.stringify(fixture)}`,
        ).toBe(
          offered(row.cells[cell], who)
            ? taskOk(cell, row.cells[cell])
            : NOT_ALLOWED,
        );
        await reset(ctx.shop, ctx.live, ctx.team.id, fixture, tasks);
      }
    }
  };

  for (const row of TASK_ROWS)
    it(`callables: ${ActionTable.renderRow("taskActions", row)}`, () =>
      checkTaskRow(row));
});
