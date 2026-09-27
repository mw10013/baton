import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import { closedReasonText } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";

const order = (
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.ShopOrder => ({
  id: "gid://shopify/Order/1",
  legacyId: "1",
  name: "#1001",
  processedAt: 0,
  updatedAt: 0,
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  lineItemsTruncated: false,
  syncedAt: 0,
  ...overrides,
});

/** `Partial` runs: a case spells out just the counters it turns on. */
const row = (
  runs: Partial<Domain.RunCounts>,
  overrides: Partial<Domain.ShopOrder> = {},
  ambiguousItems = 0,
): Domain.OrderRow => ({
  order: order(overrides),
  itemUnits: 1,
  runs: { ...NONE, ...runs },
  attention: false,
  waitingOn: [],
  ambiguousItems,
});

const NONE = {
  open: 0,
  done: 0,
  blocked: 0,
  closed: 0,
} satisfies Domain.RunCounts;

describe("Domain.productionState", () => {
  const cases: readonly [string, Domain.OrderRow, Domain.ProductionState][] = [
    ["no open and no done run is to make", row(NONE), "to_make"],
    ["any open run is making", row({ open: 1, done: 1 }), "making"],
    [
      "an ambiguous item does not move the position: one item chosen, another waiting",
      row({ open: 1 }, {}, 1),
      "making",
    ],
    ["only done runs is made", row({ done: 2 }), "made"],
    [
      "made stays made when an edit leaves the order unpaid",
      row({ done: 2 }, { fullyPaid: false }),
      "made",
    ],
    [
      "a fulfilled order is fulfilled whatever its runs say",
      row({ done: 1, closed: 1 }, { fulfillmentStatus: "FULFILLED" }),
      "fulfilled",
    ],
    [
      "a fulfilled order with no runs is fulfilled (history the window sync pulls in)",
      row(NONE, { fulfillmentStatus: "FULFILLED" }),
      "fulfilled",
    ],
    [
      "a cancelled order is cancelled whatever its runs say",
      row({ closed: 1 }, { cancelledAt: 1 }),
      "cancelled",
    ],
    [
      "cancelled wins over fulfilled",
      row(NONE, { cancelledAt: 1, fulfillmentStatus: "FULFILLED" }),
      "cancelled",
    ],
  ];
  for (const [label, input, expected] of cases)
    it(label, () => {
      strictEqual(Domain.productionState(input), expected);
    });

  it("an open order with no runs is to make whether or not it is paid", () => {
    strictEqual(
      Domain.productionState(row(NONE, { fullyPaid: false })),
      "to_make",
    );
    strictEqual(Domain.productionState(row(NONE, {}, 1)), "to_make");
  });

  it("an order whose runs are all closed reads to make", () => {
    strictEqual(Domain.productionState(row({ closed: 2 })), "to_make");
  });
});

describe("Domain.orderNeeds", () => {
  it("no_workflow: paid, open, no run and no ambiguous item", () => {
    deepStrictEqual(Domain.orderNeeds(row(NONE)), ["no_workflow"]);
    deepStrictEqual(Domain.orderNeeds(row(NONE, { fullyPaid: false })), []);
    deepStrictEqual(Domain.orderNeeds(row({ open: 1 })), []);
    deepStrictEqual(Domain.orderNeeds(row({ done: 1 })), []);
    deepStrictEqual(Domain.orderNeeds(row(NONE, {}, 1)), ["choose_workflow"]);
  });

  it("an item whose run closed counts as decided: no no_workflow need", () => {
    deepStrictEqual(Domain.orderNeeds(row({ closed: 1 })), []);
  });

  it("choose_workflow: an ambiguous item on an order that can start runs", () => {
    deepStrictEqual(Domain.orderNeeds(row({ open: 1 }, {}, 1)), [
      "choose_workflow",
    ]);
    deepStrictEqual(Domain.orderNeeds(row(NONE, { fullyPaid: false }, 1)), []);
  });

  it("team: the order needs attention", () => {
    deepStrictEqual(
      Domain.orderNeeds({ ...row({ open: 1 }), attention: true }),
      ["team"],
    );
  });

  it("blocked: an open run is blocked", () => {
    deepStrictEqual(Domain.orderNeeds(row({ open: 1, blocked: 1 })), [
      "blocked",
    ]);
  });

  it("an order can be blocked and choosing at once, in row order", () => {
    deepStrictEqual(
      Domain.orderNeeds({
        ...row({ open: 2, blocked: 1 }, {}, 1),
        attention: true,
      }),
      ["choose_workflow", "team", "blocked"],
    );
  });

  it("a fulfilled or cancelled order has no needs", () => {
    const troubled = (overrides: Partial<Domain.ShopOrder>) => ({
      ...row({ open: 1, blocked: 1 }, overrides, 1),
      attention: true,
    });
    deepStrictEqual(
      Domain.orderNeeds(troubled({ fulfillmentStatus: "FULFILLED" })),
      [],
    );
    deepStrictEqual(Domain.orderNeeds(troubled({ cancelledAt: 1 })), []);
    deepStrictEqual(
      Domain.orderNeeds(row(NONE, { fulfillmentStatus: "FULFILLED" })),
      [],
    );
  });
});

const run = (status: Domain.RunStatus, blocked = false): Domain.Run => ({
  id: Schema.decodeUnknownSync(Domain.RunId)("r"),
  workflowId: Schema.decodeUnknownSync(Domain.WorkflowId)("w"),
  workflowName: Schema.decodeUnknownSync(Domain.WorkflowName)("W"),
  orderId: "o",
  orderName: "#1",
  orderProcessedAt: 0,
  lineItemId: "li",
  lineItemTitle: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  lineItemProperties: [],
  status,
  blockedAt: blocked ? 1 : null,
  blockReason: null,
  blockedBy: null,
  quantityChangedFrom: null,
  note: null,
  createdAt: 0,
  updatedAt: 0,
  closedAt: status === "closed" ? 1 : null,
  closedReason: status === "closed" ? "fulfilled" : null,
});

describe("Domain.runCounts", () => {
  it("counts open, done, blocked-open and closed the way the index SQL does", () => {
    deepStrictEqual(
      Domain.runCounts([
        run("active"),
        run("active", true),
        run("active"),
        run("done"),
        run("closed"),
        run("closed"),
      ]),
      { open: 3, done: 1, blocked: 1, closed: 2 },
    );
  });
});

const lineItem = (
  id: string,
  matchedWorkflowIds: readonly string[],
  currentQuantity = 1,
): Domain.OrderLineItem => ({
  id,
  orderId: "o",
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity,
  productTags: [],
  matchedWorkflowIds: matchedWorkflowIds.map((id) =>
    Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  ),
  properties: [],
});

const runOn = (lineItemId: string, status: Domain.RunStatus): Domain.Run => ({
  ...run(status),
  lineItemId,
});

describe("Domain.ambiguousItems", () => {
  /**
   * The same three conditions `OrderRepository`'s `AMBIGUOUS_ITEM` spells out
   * in SQL. A `done` run counts on purpose: a done item does not get a
   * second route, so it is not a decision anyone is waiting on. A cancelled
   * run is deleted (`Domain.RunStatus`), so a cancel makes the item a
   * decision again with no rule of its own: the "two matches and no run"
   * case below.
   */
  it("counts items with two matches, units to make, and no run", () => {
    strictEqual(
      Domain.ambiguousItems([lineItem("a", ["w1", "w2"])], []),
      1,
      "two matches and no run",
    );
    strictEqual(
      Domain.ambiguousItems([lineItem("a", ["w1"])], []),
      0,
      "one match is not a decision",
    );
    strictEqual(
      Domain.ambiguousItems([lineItem("a", ["w1", "w2"], 0)], []),
      0,
      "nothing left to make",
    );
    strictEqual(
      Domain.ambiguousItems(
        [lineItem("a", ["w1", "w2"])],
        [runOn("a", "active")],
      ),
      0,
      "a run owns the item",
    );
    strictEqual(
      Domain.ambiguousItems(
        [lineItem("a", ["w1", "w2"])],
        [runOn("a", "done")],
      ),
      0,
      "a done run owns the item: a done item gets no second route",
    );
    strictEqual(
      Domain.ambiguousItems(
        [lineItem("a", ["w1", "w2"]), lineItem("b", ["w1", "w2"])],
        [runOn("b", "active")],
      ),
      1,
      "per item, not per order",
    );
  });
});

/**
 * The copy is the contract between the order page, the Recent tab and the
 * workflow page, which all read the reason from one function
 * ({@link Domain.ClosedReason}).
 */
describe("closedReasonText", () => {
  it("each closed reason reads as one sentence, and only the merchant's own cancel depends on who reads it", () => {
    const merchant = Domain.ClosedReason.literals.map((reason) =>
      closedReasonText(reason, "merchant"),
    );
    const member = Domain.ClosedReason.literals.map((reason) =>
      closedReasonText(reason, "member"),
    );
    deepStrictEqual(merchant, [
      "Fulfilled in Shopify",
      "Order cancelled in Shopify",
      "Item removed or refunded in Shopify",
      "Cancelled by you",
    ]);
    deepStrictEqual(member, [
      "Fulfilled in Shopify",
      "Order cancelled in Shopify",
      "Item removed or refunded in Shopify",
      "Cancelled by the merchant",
    ]);
  });
});

const runListItem = (
  id: string,
  orderProcessedAt: number,
  overrides: {
    readonly blocked?: boolean;
    /** The starter's email local part: `<startedBy>@example.com`. */
    readonly startedBy?: string;
  } = {},
): Domain.RunListItem => ({
  run: {
    ...run("active", overrides.blocked ?? false),
    id: Schema.decodeUnknownSync(Domain.RunId)(id),
    orderName: `#${id}`,
    orderProcessedAt,
  },
  tasks: [
    {
      id: Schema.decodeUnknownSync(Domain.RunTaskId)(`${id}-s`),
      runId: Schema.decodeUnknownSync(Domain.RunId)(id),
      position: 1,
      step: 1,
      name: Schema.decodeUnknownSync(Domain.TaskName)("Cut"),
      teamId: Schema.decodeUnknownSync(Domain.TeamId)("t"),
      teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
      startedAt: overrides.startedBy === undefined ? null : 1,
      startedByEmail:
        overrides.startedBy === undefined
          ? null
          : Schema.decodeUnknownSync(Domain.Email)(
              `${overrides.startedBy}@example.com`,
            ),
      startedByRole: overrides.startedBy === undefined ? null : "member",
    },
  ],
  stepCount: 1,
  order: { cancelledAt: null, fulfillmentStatus: "UNFULFILLED" },
});

const withTasks = (
  tasks: readonly (readonly [name: string, team: string])[],
): Domain.RunListItem => {
  const item = runListItem("1", 0);
  const [base] = item.tasks;
  const [first, ...rest] = tasks.map(([name, team], index) => ({
    ...base,
    id: Schema.decodeUnknownSync(Domain.RunTaskId)(`t${String(index)}`),
    position: index + 2,
    step: 2,
    name: Schema.decodeUnknownSync(Domain.TaskName)(name),
    teamName: Schema.decodeUnknownSync(Domain.TeamName)(team),
  }));
  if (first === undefined) throw new Error("withTasks: no tasks");
  return { ...item, tasks: [first, ...rest], stepCount: 3 };
};
const line = (item: Domain.RunListItem, showTeam: boolean) => {
  const { names, step } = Domain.runRowLine(item, showTeam);
  return `${names} · ${step}`;
};

describe("Domain.runRowLine", () => {
  it("a member row lists every current task by name, then step k of n, and names a team per task only when they differ", () => {
    const one = withTasks([["Stamp monogram", "Engraving"]]);
    const shared = withTasks([
      ["Stamp monogram", "Engraving"],
      ["Engrave initials", "Engraving"],
    ]);
    const split = withTasks([
      ["Stamp monogram", "Engraving"],
      ["Engrave initials", "Finishing"],
    ]);
    strictEqual(line(one, false), "Stamp monogram · Step 2 of 3");
    strictEqual(line(one, true), "Stamp monogram · Step 2 of 3 · Engraving");
    strictEqual(
      line(shared, true),
      "Stamp monogram · Engrave initials · Step 2 of 3 · Engraving",
    );
    strictEqual(
      line(shared, false),
      "Stamp monogram · Engrave initials · Step 2 of 3",
    );
    strictEqual(
      line(split, true),
      "Stamp monogram (Engraving) · Engrave initials (Finishing) · Step 2 of 3",
    );
    strictEqual(
      line(split, false),
      "Stamp monogram (Engraving) · Engrave initials (Finishing) · Step 2 of 3",
    );
  });
});

const runIds = (items: readonly Domain.RunListItem[]) =>
  items.map((item) => item.run.id).join(",");

const ME = Schema.decodeUnknownSync(Domain.Email)("me@example.com");

describe("Domain.tierOf", () => {
  it("a blocked run is in blocked; then mine, then a teammate's, then untouched", () => {
    strictEqual(
      Domain.tierOf(
        runListItem("blocked-mine", 40, { blocked: true, startedBy: "me" }),
        ME,
      ),
      "blocked",
    );
    strictEqual(
      Domain.tierOf(runListItem("mine", 20, { startedBy: "me" }), ME),
      "mine",
    );
    strictEqual(
      Domain.tierOf(runListItem("theirs", 5, { startedBy: "them" }), ME),
      "teammates",
    );
    strictEqual(Domain.tierOf(runListItem("early-next", 10), ME), "upNext");
  });
});

const withLine = (item: Domain.RunListItem, lineItemId: string) => ({
  ...item,
  run: { ...item.run, lineItemId },
});

describe("Domain.byAge", () => {
  it("oldest order first, then item, then run id", () => {
    strictEqual(
      runIds(
        [
          runListItem("late-next", 30),
          withLine(runListItem("b-same-age", 10), "line-2"),
          withLine(runListItem("z-first-line", 10), "line-1"),
          withLine(runListItem("a-same-age", 10), "line-2"),
        ].toSorted(Domain.byAge),
      ),
      "z-first-line,a-same-age,b-same-age,late-next",
    );
  });
});

describe("Domain.sameRunQuery", () => {
  const query: Domain.RunQuery = {
    team: null,
    tab: "mine",
    limit: Domain.RUN_PAGE,
  };

  it("is structural, and every field counts", () => {
    strictEqual(Domain.sameRunQuery(query, { ...query }), true);
    strictEqual(
      Domain.sameRunQuery(query, {
        ...query,
        team: Schema.decodeUnknownSync(Domain.TeamId)("team-a"),
      }),
      false,
    );
    strictEqual(Domain.sameRunQuery(query, { ...query, tab: "done" }), false);
    strictEqual(
      Domain.sameRunQuery(query, {
        ...query,
        limit: Domain.RUN_PAGE + 1,
      }),
      false,
    );
  });
});

describe("Domain.OrderSearch", () => {
  const decode = Schema.decodeUnknownOption(Domain.OrderSearch);
  it("normalises 1001, #1001, and padded #1001 to #1001", () => {
    for (const q of ["1001", "#1001", " #1001 ", "##1001"])
      strictEqual(Domain.normaliseOrderSearch(q), "#1001");
  });
  it("refuses # alone, which would normalise to a prefix every order shares", () => {
    for (const q of ["#", "##", " # ", "", "  "])
      strictEqual(decode(q)._tag, "None", q);
    strictEqual(decode("#1")._tag, "Some");
  });
});

/** One seeded order, with the keys under test spread over the minimum a row needs. */
const seedOrdersInput = (order: Record<string, unknown>) => ({
  memberId: "m1",
  memberEmail: "lead@m.com",
  orders: [{ n: 1, lineItems: [], ...order }],
});

describe("Domain.SeedOrdersInput", () => {
  const decode = Schema.decodeUnknownOption(Domain.SeedOrdersInput);
  it("refuses `done` beside `advance`, on the order and on one item", () => {
    strictEqual(
      decode(seedOrdersInput({ done: true, advance: 1 }))._tag,
      "None",
    );
    strictEqual(
      decode(
        seedOrdersInput({
          lineItems: [
            {
              title: "Board",
              quantity: 1,
              progress: { done: true, advance: 1 },
            },
          ],
        }),
      )._tag,
      "None",
    );
    strictEqual(decode(seedOrdersInput({ done: true }))._tag, "Some");
    strictEqual(
      decode(seedOrdersInput({ advance: 2, started: true }))._tag,
      "Some",
    );
  });
});

describe("Domain.runIsOpen / Domain.runIsDone / Domain.runIsClosed", () => {
  it("open is active; done is the last task's Done; closed is ended by something else", () => {
    deepStrictEqual(
      Domain.RunStatus.literals.map((status) => Domain.runIsOpen(run(status))),
      [true, false, false],
    );
    deepStrictEqual(
      Domain.RunStatus.literals.map((status) => Domain.runIsDone(run(status))),
      [false, true, false],
    );
    deepStrictEqual(
      Domain.RunStatus.literals.map((status) =>
        Domain.runIsClosed(run(status)),
      ),
      [false, false, true],
    );
  });
});

/** A task's two timestamps, all `Domain.runIsUnstarted` reads. */
const progressOf = (startedAt: number | null, doneAt: number | null) => ({
  startedAt,
  doneAt,
});

describe("Domain.runIsUnstarted", () => {
  const task = progressOf;
  it("unstarted is no task started or done", () => {
    strictEqual(
      Domain.runIsUnstarted([task(null, null), task(null, null)]),
      true,
    );
    strictEqual(
      Domain.runIsUnstarted([task(null, null), task(1, null)]),
      false,
    );
    strictEqual(
      Domain.runIsUnstarted([task(null, null), task(null, 1)]),
      false,
    );
    strictEqual(Domain.runIsUnstarted([]), true);
  });
});

const TEAM = Schema.decodeUnknownSync(Domain.TeamId)("t");
const OTHER_TEAM = Schema.decodeUnknownSync(Domain.TeamId)("u");

const taskView = (
  overrides: Partial<
    Pick<
      Domain.RunTaskView,
      "teamId" | "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
    >
  > = {},
): Pick<
  Domain.RunTaskView,
  "teamId" | "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
> => ({
  teamId: TEAM,
  current: true,
  startedAt: null,
  doneAt: null,
  reopenBlockedBy: null,
  ...overrides,
});

const NOTHING = {
  start: false,
  done: false,
  putBack: false,
  reopen: null,
  assign: false,
};

const OPEN_ORDER: Domain.OrderState = {
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
};

/** The member-side action set on an open order: the rules below are about the run and the task, not the order ({@link Domain.taskActions}). */
const memberActions = (
  runState: Parameters<typeof Domain.taskActions>[2],
  task: Parameters<typeof Domain.taskActions>[3],
  teamIds: readonly Domain.TeamId[],
) =>
  Domain.taskActions(
    {
      role: "member",
      memberId: Schema.decodeUnknownSync(Domain.MemberId)("m"),
      email: Schema.decodeUnknownSync(Domain.Email)("m@example.com"),
      teamIds,
    },
    OPEN_ORDER,
    runState,
    task,
  );

describe("Domain.taskActions", () => {
  it("a done run's last task is reopenable while nothing downstream started", () => {
    deepStrictEqual(
      memberActions(
        run("done"),
        taskView({ current: false, startedAt: 1, doneAt: 2 }),
        [TEAM],
      ),
      { ...NOTHING, reopen: { blockedBy: null } },
    );
  });

  it("reopening a task is refused once any task in a later step has started, naming the blocker", () => {
    const blocker: Domain.ReopenBlocker = {
      taskName: Schema.decodeUnknownSync(Domain.TaskName)("Polish"),
      teamName: Schema.decodeUnknownSync(Domain.TeamName)("Finishing"),
    };
    deepStrictEqual(
      memberActions(
        run("active"),
        taskView({
          current: false,
          startedAt: 1,
          doneAt: 2,
          reopenBlockedBy: blocker,
        }),
        [TEAM],
      ),
      { ...NOTHING, reopen: { blockedBy: blocker } },
    );
  });

  it("a block hides Start and Done but not Reopen", () => {
    deepStrictEqual(memberActions(run("active", true), taskView(), [TEAM]), {
      ...NOTHING,
    });
    deepStrictEqual(
      memberActions(
        run("active", true),
        taskView({ current: false, startedAt: 1, doneAt: 2 }),
        [TEAM],
      ),
      { ...NOTHING, reopen: { blockedBy: null } },
    );
  });

  it("a task on another team offers nothing", () => {
    deepStrictEqual(
      memberActions(run("active"), taskView(), [OTHER_TEAM]),
      NOTHING,
    );
    deepStrictEqual(
      memberActions(run("active"), taskView({ teamId: null }), [TEAM]),
      NOTHING,
    );
  });

  it("Start is offered only before the task is started; Done while it is ready", () => {
    deepStrictEqual(memberActions(run("active"), taskView(), [TEAM]), {
      start: true,
      done: true,
      putBack: false,
      reopen: null,
      assign: false,
    });
    deepStrictEqual(
      memberActions(run("active"), taskView({ startedAt: 1 }), [TEAM]),
      {
        start: false,
        done: true,
        putBack: true,
        reopen: null,
        assign: false,
      },
    );
    deepStrictEqual(
      memberActions(run("active"), taskView({ current: false }), [TEAM]),
      { ...NOTHING },
    );
  });
});

describe("Domain.taskActions Put back", () => {
  it("Put back is offered wherever Done is, and only on a started task", () => {
    strictEqual(
      memberActions(run("active"), taskView({ startedAt: 1 }), [TEAM]).putBack,
      true,
    );
    strictEqual(
      memberActions(run("active"), taskView(), [TEAM]).putBack,
      false,
    );
    strictEqual(
      memberActions(run("active"), taskView({ current: false, startedAt: 1 }), [
        TEAM,
      ]).putBack,
      false,
    );
  });

  it("a block hides Put back", () => {
    strictEqual(
      memberActions(run("active", true), taskView({ startedAt: 1 }), [TEAM])
        .putBack,
      false,
    );
  });

  it("a started task on another team offers no Put back", () => {
    strictEqual(
      memberActions(run("active"), taskView({ startedAt: 1 }), [OTHER_TEAM])
        .putBack,
      false,
    );
  });

  it("a done task offers no Put back", () => {
    strictEqual(
      memberActions(
        run("active"),
        taskView({ current: false, startedAt: 1, doneAt: 2 }),
        [TEAM],
      ).putBack,
      false,
    );
  });
});

describe("Domain.runIsBlocked", () => {
  it("a run is blocked exactly when a person's block stands on it", () => {
    strictEqual(Domain.runIsBlocked(run("active")), false);
    strictEqual(Domain.runIsBlocked(run("active", true)), true);
  });
});

const runTask = (
  position: number,
  step: number,
  done: boolean,
): Domain.RunTask => ({
  id: Schema.decodeUnknownSync(Domain.RunTaskId)(`s${String(position)}`),
  runId: Schema.decodeUnknownSync(Domain.RunId)("r"),
  position,
  step,
  name: Schema.decodeUnknownSync(Domain.TaskName)(`Task ${String(position)}`),
  teamId: TEAM,
  teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
  instructions: null,
  startedAt: done ? 1 : null,
  startedByEmail: null,
  startedByRole: null,
  doneAt: done ? 2 : null,
  doneByEmail: null,
  doneByRole: null,
  reopenedAt: null,
  reopenedByRole: null,
  reopenedByEmail: null,
});

describe("Domain.runIsVisibleTo", () => {
  it("a member's access to a run is any task of it on one of their teams, current or not", () => {
    const unassigned = { ...runTask(2, 2, false), teamId: null };
    const tasks = [runTask(1, 1, true), unassigned];
    strictEqual(Domain.runIsVisibleTo(tasks, [TEAM]), true);
    strictEqual(Domain.runIsVisibleTo(tasks, ["other"]), false);
    // An unassigned task is on nobody's list.
    strictEqual(Domain.runIsVisibleTo([unassigned], [TEAM]), false);
  });
});

/** `Domain.taskStateOf` on positional arguments, for a table of cases. */
const stateOf = (
  current: boolean,
  startedAt: number | null,
  doneAt: number | null,
) => Domain.taskStateOf({ current, startedAt, doneAt });

describe("Domain.taskStateOf", () => {
  const state = stateOf;
  it("a task is done, else started, else ready when current, else waiting; a started task on a closed run still reads started", () => {
    strictEqual(state(false, 1, 2), "done");
    strictEqual(state(true, 1, null), "started");
    strictEqual(state(false, 1, null), "started");
    strictEqual(state(true, null, null), "ready");
    strictEqual(state(false, null, null), "waiting");
  });
});

describe("Domain.currentTasks", () => {
  it("a task is current when open and no task of an earlier step is open; every task of a step is current together", () => {
    const tasks = [
      runTask(1, 1, true),
      runTask(2, 2, false),
      runTask(3, 2, false),
      runTask(4, 3, false),
    ];
    deepStrictEqual(
      Domain.currentTasks(run("active"), tasks).map((task) => task.position),
      [2, 3],
    );
    deepStrictEqual(
      Domain.currentTasks(run("active"), [
        runTask(1, 1, false),
        runTask(2, 2, false),
      ]).map((task) => task.position),
      [1],
    );
  });

  it("a run that is not open has no current task", () => {
    deepStrictEqual(
      Domain.currentTasks(run("done"), [runTask(1, 1, true)]),
      [],
    );
  });
});

describe("Domain.seatEventValue", () => {
  it("the seat event value is the roster past the cycle's high-water mark, and zero when not past it", () => {
    strictEqual(Domain.seatEventValue(4, 3), 1);
    strictEqual(Domain.seatEventValue(6, 3), 3);
    strictEqual(Domain.seatEventValue(5, 0), 5);
    strictEqual(Domain.seatEventValue(3, 3), 0);
    strictEqual(Domain.seatEventValue(2, 4), 0);
  });
});

describe("Domain.rosterAtCeiling", () => {
  it("a shop is at its ceiling when the roster has reached maxMembers", () => {
    const { maxMembers } = Domain.ShopLimits;
    strictEqual(Domain.rosterAtCeiling(maxMembers - 1), false);
    strictEqual(Domain.rosterAtCeiling(maxMembers), true);
    strictEqual(Domain.rosterAtCeiling(maxMembers + 1), true);
  });
});

describe("Domain.cycleAtOrderCeiling", () => {
  it("the cycle is at its ceiling when the count has reached maxOrdersPerCycle", () => {
    const { maxOrdersPerCycle } = Domain.ShopLimits;
    strictEqual(Domain.cycleAtOrderCeiling(maxOrdersPerCycle - 1), false);
    strictEqual(Domain.cycleAtOrderCeiling(maxOrdersPerCycle), true);
    strictEqual(Domain.cycleAtOrderCeiling(maxOrdersPerCycle + 1), true);
  });
});

describe("Domain.orderIsSeeded", () => {
  it("a seeded order is one whose id carries the fixture prefix", () => {
    strictEqual(
      Domain.orderIsSeeded(`${Domain.SEED_ORDER_ID_PREFIX}1001`),
      true,
    );
    strictEqual(Domain.orderIsSeeded("gid://shopify/Order/1001"), false);
  });
});

describe("Domain.OrdersCursor", () => {
  const decode = Schema.decodeUnknownOption(Domain.OrdersCursor);
  it("a cursor is `<processedAt>:<id>`, so text that is not one is refused rather than read as page one", () => {
    strictEqual(decode("1700000000000:gid://shopify/Order/1")._tag, "Some");
    strictEqual(decode("nonsense")._tag, "None");
    strictEqual(decode(":gid://shopify/Order/1")._tag, "None");
    strictEqual(decode("1700000000000:")._tag, "None");
  });
});
