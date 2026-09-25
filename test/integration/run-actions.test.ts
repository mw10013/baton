import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";

import { openMemberSocket, openMerchantSocket } from "./agent-socket";

/**
 * The action matrices on `Domain.runActions` and `Domain.taskActions`, one
 * test per row, titled with the row's label from the JSDoc table so a failing
 * test names the cell. The second half drives the `ShopAgent` callables into
 * the blank cells and asserts they refuse: the page and the server read one
 * function, and these are the proof that the server does.
 */

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
const CANCELLED_ORDER: Domain.OrderState = {
  cancelledAt: 1,
  fulfillmentStatus: "UNFULFILLED",
};
const FULFILLED_ORDER: Domain.OrderState = {
  cancelledAt: null,
  fulfillmentStatus: "FULFILLED",
};

const run = (status: Domain.RunStatus, flag: Domain.RunFlag | null) => ({
  status,
  flag,
});

/** The run's one task, ready exactly when the run is open. */
const tasksOf = (status: Domain.RunStatus) => [
  { teamId: T, ready: status === "pending" || status === "active" },
];

type Cell = "" | "M" | "M m";

/** The line item as the merchant's callers pass it: units still to make, unless a row says otherwise. */
const ITEM = { currentQuantity: 1 };

const RUN_MATRIX: readonly (readonly [
  label: string,
  order: Domain.OrderState,
  run: ReturnType<typeof run>,
  cells: Record<keyof Domain.RunActions, Cell>,
])[] = [
  [
    "open, no flag",
    OPEN_ORDER,
    run("active", null),
    {
      note: "M m",
      block: "M m",
      editReason: "",
      liftFlag: "",
      cancel: "M",
      changeWorkflow: "M",
    },
  ],
  [
    "open, blocked",
    OPEN_ORDER,
    run("active", "blocked"),
    {
      note: "M m",
      block: "",
      editReason: "M m",
      liftFlag: "M m",
      cancel: "M",
      changeWorkflow: "M",
    },
  ],
  [
    "open, reconcile flag",
    OPEN_ORDER,
    run("active", "item_removed"),
    {
      note: "M m",
      block: "",
      editReason: "",
      liftFlag: "M m",
      cancel: "M",
      changeWorkflow: "M",
    },
  ],
  [
    "done, no flag",
    OPEN_ORDER,
    run("done", null),
    {
      note: "M m",
      block: "",
      editReason: "",
      liftFlag: "",
      cancel: "",
      changeWorkflow: "",
    },
  ],
  [
    "done, quantity flag",
    OPEN_ORDER,
    run("done", "quantity_changed"),
    {
      note: "M m",
      block: "",
      editReason: "",
      liftFlag: "M",
      cancel: "",
      changeWorkflow: "",
    },
  ],
  [
    "order closed",
    CANCELLED_ORDER,
    run("active", "order_cancelled"),
    {
      note: "M m",
      block: "",
      editReason: "",
      liftFlag: "M m",
      cancel: "M",
      changeWorkflow: "",
    },
  ],
];

const expected = (cells: Record<string, Cell>, who: "M" | "m") =>
  Object.fromEntries(
    Object.entries(cells).map(([field, cell]) => [
      field,
      cell.split(" ").includes(who),
    ]),
  );

describe("Domain.runActions matrix", () => {
  for (const [label, order, state, cells] of RUN_MATRIX)
    it(label, () => {
      const tasks = tasksOf(state.status);
      deepStrictEqual(
        Domain.runActions(MERCHANT, order, state, tasks, ITEM),
        expected(cells, "M"),
      );
      deepStrictEqual(
        Domain.runActions(MEMBER, order, state, tasks, ITEM),
        expected(cells, "m"),
      );
    });

  it("open, nothing to make", () => {
    const cells = {
      note: "M m",
      block: "M m",
      editReason: "",
      liftFlag: "",
      cancel: "M",
      changeWorkflow: "",
    } as const;
    const state = run("active", null);
    const tasks = tasksOf("active");
    const zero = { currentQuantity: 0 };
    deepStrictEqual(
      Domain.runActions(MERCHANT, OPEN_ORDER, state, tasks, zero),
      expected(cells, "M"),
    );
    deepStrictEqual(
      Domain.runActions(MEMBER, OPEN_ORDER, state, tasks, zero),
      expected(cells, "m"),
    );
  });

  it("without the line item, Change workflow is not offered", () => {
    strictEqual(
      Domain.runActions(
        MERCHANT,
        OPEN_ORDER,
        run("active", null),
        tasksOf("active"),
      ).changeWorkflow,
      false,
    );
  });

  it("a member whose team holds no ready task gets only the note, and only if the run is theirs to see", () => {
    const tasks = [{ teamId: T, ready: false }];
    deepStrictEqual(
      Domain.runActions(MEMBER, OPEN_ORDER, run("active", "blocked"), tasks),
      {
        note: true,
        block: false,
        editReason: false,
        liftFlag: false,
        cancel: false,
        changeWorkflow: false,
      },
    );
    strictEqual(
      Domain.runActions(OUTSIDER, OPEN_ORDER, run("active", null), tasks).note,
      false,
    );
  });

  it("a fulfilled order is closed the same way as a cancelled one", () => {
    deepStrictEqual(
      Domain.runActions(
        MERCHANT,
        FULFILLED_ORDER,
        run("active", "order_fulfilled"),
        tasksOf("active"),
        ITEM,
      ),
      expected(RUN_MATRIX[5]?.[3] ?? {}, "M"),
    );
  });

  it("a cancelled marker offers nothing", () => {
    for (const actor of [MERCHANT, MEMBER])
      deepStrictEqual(
        Domain.runActions(actor, OPEN_ORDER, run("cancelled", null), []),
        {
          note: false,
          block: false,
          editReason: false,
          liftFlag: false,
          cancel: false,
          changeWorkflow: false,
        },
      );
  });
});

const BLOCKER: Domain.UndoBlocker = {
  taskName: Schema.decodeUnknownSync(Domain.TaskName)("Polish"),
  teamName: Schema.decodeUnknownSync(Domain.TeamName)("Finishing"),
};

const task = (
  overrides: Partial<
    Pick<
      Domain.RunTaskView,
      "ready" | "startedAt" | "completedAt" | "undoBlockedBy"
    >
  > = {},
) => ({
  teamId: T,
  ready: true,
  startedAt: null,
  completedAt: null,
  undoBlockedBy: null,
  ...overrides,
});

interface TaskCell {
  readonly M: Domain.TaskActions;
  readonly m: Domain.TaskActions;
}

const NOTHING: Domain.TaskActions = {
  start: false,
  done: false,
  putBack: false,
  reopen: null,
  reassign: false,
};

const TASK_MATRIX: readonly (readonly [
  label: string,
  cases: readonly (readonly [
    order: Domain.OrderState,
    run: ReturnType<typeof run>,
    task: ReturnType<typeof task>,
  ])[],
  cells: TaskCell,
])[] = [
  [
    "run open, no flag, task ready, not started",
    [[OPEN_ORDER, run("pending", null), task()]],
    {
      M: { ...NOTHING, done: true, reassign: true },
      m: { ...NOTHING, start: true, done: true },
    },
  ],
  [
    "run open, no flag, task ready, started",
    [[OPEN_ORDER, run("active", null), task({ startedAt: 1 })]],
    {
      M: { ...NOTHING, done: true, putBack: true, reassign: true },
      m: { ...NOTHING, done: true, putBack: true },
    },
  ],
  [
    "run open, no flag, task waiting",
    [[OPEN_ORDER, run("active", null), task({ ready: false })]],
    { M: { ...NOTHING, reassign: true }, m: NOTHING },
  ],
  [
    "run open, flagged, any open task",
    [
      [OPEN_ORDER, run("active", "blocked"), task({ startedAt: 1 })],
      [OPEN_ORDER, run("active", "item_removed"), task()],
    ],
    { M: { ...NOTHING, reassign: true }, m: NOTHING },
  ],
  [
    "run open or done, task completed, no downstream start",
    [
      [
        OPEN_ORDER,
        run("active", null),
        task({ ready: false, startedAt: 1, completedAt: 2 }),
      ],
      [
        OPEN_ORDER,
        run("done", "quantity_changed"),
        task({ ready: false, startedAt: 1, completedAt: 2 }),
      ],
    ],
    {
      M: { ...NOTHING, reopen: { blockedBy: null } },
      m: { ...NOTHING, reopen: { blockedBy: null } },
    },
  ],
  [
    "run open or done, task completed, downstream started",
    [
      [
        OPEN_ORDER,
        run("active", null),
        task({
          ready: false,
          startedAt: 1,
          completedAt: 2,
          undoBlockedBy: BLOCKER,
        }),
      ],
    ],
    {
      M: { ...NOTHING, reopen: { blockedBy: BLOCKER } },
      m: { ...NOTHING, reopen: { blockedBy: BLOCKER } },
    },
  ],
  [
    "order closed",
    [
      [CANCELLED_ORDER, run("active", null), task({ startedAt: 1 })],
      [
        FULFILLED_ORDER,
        run("done", null),
        task({ ready: false, startedAt: 1, completedAt: 2 }),
      ],
    ],
    { M: NOTHING, m: NOTHING },
  ],
];

describe("Domain.taskActions matrix", () => {
  for (const [label, cases, cells] of TASK_MATRIX)
    it(label, () => {
      for (const [order, state, view] of cases) {
        deepStrictEqual(
          Domain.taskActions(MERCHANT, order, state, view),
          cells.M,
        );
        deepStrictEqual(
          Domain.taskActions(MEMBER, order, state, view),
          cells.m,
        );
      }
    });

  it("a task on none of the member's teams offers the member nothing", () => {
    deepStrictEqual(
      Domain.taskActions(OUTSIDER, OPEN_ORDER, run("active", null), task()),
      NOTHING,
    );
  });
});

const workflowOf = (id: string, name: string): Domain.Workflow => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  name: Schema.decodeUnknownSync(Domain.WorkflowName)(name),
  tag: Schema.decodeUnknownSync(Domain.WorkflowTag)(name.toLowerCase()),
  activatedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});

const lineItemOf = (
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: "li",
  orderId: "o",
  productId: null,
  variantId: null,
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  productTags: [],
  matchedWorkflowIds: [],
  properties: [],
  requiresShipping: true,
  ...overrides,
});

const detailOf = (
  status: Domain.RunStatus,
  lineItemId = "li",
): Domain.WorkflowRunDetail => ({
  run: {
    id: Schema.decodeUnknownSync(Domain.WorkflowRunId)("r"),
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
    source: "tag",
    status,
    flag: null,
    flagAt: null,
    flagDetail: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    cancelledAt: status === "cancelled" ? 1 : null,
  },
  tasks: [],
});

const kindOf = (
  item: Domain.OrderLineItem,
  runs: readonly Domain.WorkflowRunDetail[],
  offered: readonly Domain.Workflow[],
) => Domain.lineItemState(item, runs, offered).kind;

describe("Domain.lineItemState", () => {
  it("lineItemState has one kind per layout", () => {
    const engrave = workflowOf("w1", "Engrave");
    const polish = workflowOf("w2", "Polish");
    const workflows = [polish, engrave];
    const kind = (
      item: Domain.OrderLineItem,
      runs: readonly Domain.WorkflowRunDetail[],
      offered: readonly Domain.Workflow[] = workflows,
    ) => kindOf(item, runs, offered);
    strictEqual(kind(lineItemOf(), [detailOf("pending")]), "running");
    strictEqual(kind(lineItemOf(), [detailOf("active")]), "running");
    strictEqual(kind(lineItemOf(), [detailOf("done")]), "finished");
    strictEqual(kind(lineItemOf(), [detailOf("cancelled")]), "cancelled");
    // A run is the news even when the line went to zero under it.
    strictEqual(
      kind(lineItemOf({ currentQuantity: 0 }), [detailOf("active")]),
      "running",
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

    // A cancelled item offers every workflow, the cancelled one included.
    const cancelled = Domain.lineItemState(
      lineItemOf(),
      [detailOf("cancelled")],
      workflows,
    );
    if (cancelled.kind !== "cancelled") throw new Error(cancelled.kind);
    deepStrictEqual(
      cancelled.options.map((workflow) => workflow.id),
      [polish.id, engrave.id],
    );
    strictEqual(cancelled.startable, true);
    // Nothing left to make: the cancelled line stands, and no workflow starts.
    const emptied = Domain.lineItemState(
      lineItemOf({ currentQuantity: 0 }),
      [detailOf("cancelled")],
      workflows,
    );
    if (emptied.kind !== "cancelled") throw new Error(emptied.kind);
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

afterEach(async () => {
  await env.D1.exec("delete from TeamMember");
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from Member");
  await env.D1.exec("delete from ShopSession");
});

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
              closedAt: null,
              financialStatus: "PAID",
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              note: null,
              lineItemsTruncated: false,
              syncedAt: now,
              syncSource: "manual",
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

/** Writes the object's SQLite directly: the states reconcile or Shopify would produce, without a webhook. */
const exec = (shop: string, query: string, ...bindings: unknown[]) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) => {
      state.storage.sql.exec(query, ...bindings);
    },
  );

const NOT_ALLOWED = { _tag: "NotAllowed" };

describe("ShopAgent refuses what the action set refuses", () => {
  it("every blank cell of the run and task matrices is refused by its callable", async () => {
    const shop = "run-actions-refuse.myshopify.com";
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
      return created.workflow;
    };
    const engrave = await build("Engrave");
    const rush = await build("Rush");
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: engrave.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;
    const [detail] = await agent.merchantListRunsForOrder({
      orderId: ORDER_ID,
    });
    const [cut, polish] = detail?.tasks ?? [];
    if (cut === undefined || polish === undefined) throw new Error("tasks");
    const merchant = await openMerchantSocket(shop);
    const member = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [team.id],
    });

    // open, no flag: no reason to edit, no flag to lift; the waiting task
    // takes no Done.
    expect(await merchant.setBlockReason({ runId, reason: "x" })).toEqual(
      NOT_ALLOWED,
    );
    expect(await merchant.dismissFlag({ runId })).toEqual(NOT_ALLOWED);
    expect(await member.setBlockReason({ runId, reason: "x" })).toEqual(
      NOT_ALLOWED,
    );
    expect(await merchant.completeTask({ runTaskId: polish.id })).toEqual(
      NOT_ALLOWED,
    );
    expect(await member.startTask({ runTaskId: polish.id })).toEqual(
      NOT_ALLOWED,
    );

    // open, blocked: no second Block; no work under the hold.
    expect(await merchant.blockRun({ runId, reason: null })).toEqual({
      _tag: "Ok",
    });
    expect(await merchant.blockRun({ runId, reason: null })).toEqual(
      NOT_ALLOWED,
    );
    expect(await member.blockRun({ runId, reason: null })).toEqual(NOT_ALLOWED);
    expect(await member.startTask({ runTaskId: cut.id })).toEqual(NOT_ALLOWED);
    expect(await merchant.completeTask({ runTaskId: cut.id })).toEqual(
      NOT_ALLOWED,
    );

    // open, reconcile flag: Block would overwrite it, and there is no reason.
    await exec(
      shop,
      "update WorkflowRun set flag = 'item_removed', flagDetail = null where id = ?",
      runId,
    );
    expect(await merchant.blockRun({ runId, reason: null })).toEqual(
      NOT_ALLOWED,
    );
    expect(await merchant.setBlockReason({ runId, reason: "x" })).toEqual(
      NOT_ALLOWED,
    );
    expect(await member.dismissFlag({ runId })).toEqual({ _tag: "Ok" });

    // open, nothing to make: the line went to zero, so no workflow replaces
    // the run; the units come back before the next row.
    await exec(
      shop,
      "update OrderLineItem set currentQuantity = 0 where id = ?",
      LINE_ITEM_ID,
    );
    const onEmpty = await agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: rush.id,
    });
    strictEqual(onEmpty._tag, "NothingToMake");
    await exec(
      shop,
      "update OrderLineItem set currentQuantity = 1 where id = ?",
      LINE_ITEM_ID,
    );

    // done: nothing but the note and Reopen.
    expect(await member.completeTask({ runTaskId: cut.id })).toEqual({
      _tag: "Ok",
    });
    expect(await member.completeTask({ runTaskId: polish.id })).toEqual({
      _tag: "Ok",
    });
    expect(await agent.merchantCancelRun({ runId })).toEqual(NOT_ALLOWED);
    expect(await merchant.blockRun({ runId, reason: null })).toEqual(
      NOT_ALLOWED,
    );
    expect(
      await agent.merchantAssignRunTaskTeam({
        runTaskId: cut.id,
        teamId: team.id,
      }),
    ).toEqual(NOT_ALLOWED);
    const change = await agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: rush.id,
    });
    strictEqual(change._tag, "ItemDone");
    expect(await merchant.setRunNote({ runId, note: "after" })).toEqual({
      _tag: "Ok",
    });

    // done, quantity flag: the merchant lifts it; a member has no ready task.
    await exec(
      shop,
      `update WorkflowRun set flag = 'quantity_changed', flagDetail = '{"from":1,"to":1}' where id = ?`,
      runId,
    );
    expect(await member.dismissFlag({ runId })).toEqual(NOT_ALLOWED);
    expect(await merchant.dismissFlag({ runId })).toEqual({ _tag: "Ok" });

    // order closed: Polish reopened first so the run is open again, then
    // Shopify cancels the order. Only the note, the lift and Cancel remain.
    expect(await merchant.uncompleteTask({ runTaskId: polish.id })).toEqual({
      _tag: "Ok",
    });
    await exec(
      shop,
      "update ShopOrder set cancelledAt = ? where id = ?",
      Date.now(),
      ORDER_ID,
    );
    expect(await merchant.completeTask({ runTaskId: polish.id })).toEqual(
      NOT_ALLOWED,
    );
    expect(await member.startTask({ runTaskId: polish.id })).toEqual(
      NOT_ALLOWED,
    );
    expect(await member.uncompleteTask({ runTaskId: cut.id })).toEqual(
      NOT_ALLOWED,
    );
    expect(await merchant.blockRun({ runId, reason: null })).toEqual(
      NOT_ALLOWED,
    );
    expect(
      await agent.merchantAssignRunTaskTeam({
        runTaskId: polish.id,
        teamId: team.id,
      }),
    ).toEqual(NOT_ALLOWED);
    const onClosed = await agent.merchantAttachWorkflow({
      lineItemId: LINE_ITEM_ID,
      workflowId: rush.id,
    });
    strictEqual(onClosed._tag, "OrderClosed");
    expect(await member.setRunNote({ runId, note: "closed" })).toEqual({
      _tag: "Ok",
    });
    expect(await agent.merchantCancelRun({ runId })).toEqual({ _tag: "Ok" });

    // The cancelled marker: every run write finds nothing to act on.
    expect(await merchant.setRunNote({ runId, note: "x" })).toEqual({
      _tag: "NotFound",
    });
    expect(await merchant.dismissFlag({ runId })).toEqual({
      _tag: "NotFound",
    });
    merchant.close();
    member.close();
  });
});
