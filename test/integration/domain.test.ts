import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import { flagBody, flagHeading, flagTone } from "@/components/MemberRun";
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
  closedAt: null,
  financialStatus: "PAID",
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  customAttributes: [],
  lineItemsTruncated: false,
  syncedAt: 0,
  syncSource: "webhook",
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
  flagged: 0,
  blocked: 0,
} satisfies Domain.RunCounts;

describe("Domain.productionState", () => {
  const cases: readonly [
    string,
    Domain.OrderRow,
    Domain.ProductionState | null,
  ][] = [
    ["open runs", row({ open: 1, done: 1, flagged: 0 }), "in_production"],
    [
      "an ambiguous item does not move the position: one item chosen, another waiting",
      row({ open: 1, done: 0, flagged: 0 }, {}, 1),
      "in_production",
    ],
    [
      "all done, unfulfilled",
      row({ open: 0, done: 2, flagged: 0 }),
      "ready_to_ship",
    ],
    [
      "all done, unpaid after an edit",
      row({ open: 0, done: 2, flagged: 0 }, { fullyPaid: false }),
      "ready_to_ship",
    ],
    [
      "fulfilled with runs open",
      row({ open: 1, done: 0, flagged: 1 }, { fulfillmentStatus: "FULFILLED" }),
      "shipped",
    ],
    [
      "fulfilled, all done",
      row({ open: 0, done: 1, flagged: 0 }, { fulfillmentStatus: "FULFILLED" }),
      "shipped",
    ],
    [
      "fulfilled, no runs (history the window sync pulls in)",
      row(NONE, { fulfillmentStatus: "FULFILLED" }),
      "shipped",
    ],
    [
      "cancelled with runs",
      row({ open: 1, done: 0, flagged: 1 }, { cancelledAt: 1 }),
      "cancelled",
    ],
    ["cancelled, no runs", row(NONE, { cancelledAt: 1 }), "cancelled"],
  ];
  for (const [label, input, expected] of cases)
    it(label, () => {
      strictEqual(Domain.productionState(input), expected);
    });

  it("an open order with no runs is null whether or not it is paid", () => {
    strictEqual(Domain.productionState(row(NONE)), null);
    strictEqual(Domain.productionState(row(NONE, { fullyPaid: false })), null);
    strictEqual(Domain.productionState(row(NONE, {}, 1)), null);
  });
});

describe("Domain.orderNeeds", () => {
  it("no_workflow: paid, open, no live run and no ambiguous item", () => {
    deepStrictEqual(Domain.orderNeeds(row(NONE)), ["no_workflow"]);
    deepStrictEqual(Domain.orderNeeds(row(NONE, { fullyPaid: false })), []);
    deepStrictEqual(Domain.orderNeeds(row({ open: 1 })), []);
    deepStrictEqual(Domain.orderNeeds(row({ done: 1 })), []);
    deepStrictEqual(Domain.orderNeeds(row(NONE, {}, 1)), ["choose_workflow"]);
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

  it("changed: an open run carries a reconcile flag", () => {
    deepStrictEqual(Domain.orderNeeds(row({ open: 1, flagged: 1 })), [
      "changed",
    ]);
  });

  it("an order can be blocked and choosing at once, in row order", () => {
    deepStrictEqual(
      Domain.orderNeeds({
        ...row({ open: 2, blocked: 1, flagged: 1 }, {}, 1),
        attention: true,
      }),
      ["choose_workflow", "team", "blocked", "changed"],
    );
  });

  it("a shipped or cancelled order has no needs", () => {
    const troubled = (overrides: Partial<Domain.ShopOrder>) => ({
      ...row({ open: 1, blocked: 1, flagged: 1 }, overrides, 1),
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

const run = (
  status: Domain.RunStatus,
  flag: Domain.RunFlag | null,
): Domain.WorkflowRun => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowRunId)("r"),
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
  customAttributes: [],
  source: "tag",
  status,
  flag,
  flagAt: null,
  flagDetail: null,
  note: null,
  createdAt: 0,
  updatedAt: 0,
  cancelledAt: null,
});

describe("Domain.runCounts", () => {
  /**
   * The two flag counters are disjoint and both ignore terminal runs: a done
   * run keeps whatever flag it carried, and counting it would leave an alarm
   * on a row where nothing is open to act on.
   */
  it("counts open, done, blocked-open, and reconcile-flagged-open the way the index SQL does", () => {
    const counts = Domain.runCounts([
      run("pending", null),
      run("active", "blocked"),
      run("active", "item_removed"),
      run("done", "item_removed"),
      run("cancelled", "order_cancelled"),
    ]);
    strictEqual(counts.open, 3);
    strictEqual(counts.done, 1);
    strictEqual(counts.flagged, 1);
    strictEqual(counts.blocked, 1);
  });
});

const lineItem = (
  id: string,
  matchedWorkflowIds: readonly string[],
  currentQuantity = 1,
): Domain.OrderLineItem => ({
  id,
  orderId: "o",
  productId: null,
  variantId: null,
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity,
  productTags: [],
  matchedWorkflowIds: matchedWorkflowIds.map((id) =>
    Schema.decodeUnknownSync(Domain.WorkflowId)(id),
  ),
  customAttributes: [],
  requiresShipping: true,
});

const runOn = (
  lineItemId: string,
  status: Domain.RunStatus,
): Domain.WorkflowRun => ({ ...run(status, null), lineItemId });

describe("Domain.ambiguousItems", () => {
  /**
   * The same three conditions `OrderRepository`'s `AMBIGUOUS_ITEM` spells out
   * in SQL. `done` counts as live on purpose: a finished item does not get a
   * second route, so it is not a decision anyone is waiting on.
   */
  it("counts items with two matches, units to make, and no live run", () => {
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
        [runOn("a", "pending")],
      ),
      0,
      "a live run owns the item",
    );
    strictEqual(
      Domain.ambiguousItems(
        [lineItem("a", ["w1", "w2"])],
        [runOn("a", "done")],
      ),
      0,
      "done is live: a finished item gets no second route",
    );
    strictEqual(
      Domain.ambiguousItems(
        [lineItem("a", ["w1", "w2"])],
        [runOn("a", "cancelled")],
      ),
      1,
      "a cancel makes it a decision again",
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
 * One fact, once: the heading names the flag and the body carries only the
 * detail, so no body repeats its own heading and two of them are empty. The
 * table is here rather than in a route test because the copy is the contract
 * between the run list and the work page, which share one banner.
 */
describe("flagHeading / flagBody / flagTone", () => {
  const cases: readonly [
    Domain.RunFlag,
    string,
    string | null,
    "critical" | "warning",
  ][] = [
    ["blocked", "Blocked", null, "critical"],
    ["quantity_changed", "Quantity changed", "From 0 to 1.", "warning"],
    [
      "item_removed",
      "No longer needed",
      "Removed or refunded in Shopify.",
      "warning",
    ],
    ["order_cancelled", "Order cancelled", null, "critical"],
    ["order_fulfilled", "Already shipped", "Fulfilled in Shopify.", "warning"],
  ];
  for (const [flag, heading, body, tone] of cases)
    it(`${flag} reads "${heading}"`, () => {
      const flagged = run("active", flag);
      strictEqual(flagHeading(flagged), heading);
      strictEqual(flagBody(flagged), body);
      strictEqual(flagTone(flagged), tone);
    });

  it("a blocked run's body is the reason as typed, with no prefix; an unflagged run has no banner", () => {
    const reason = Schema.decodeUnknownSync(Domain.BlockReason)(
      "Crest file missing\nAsked the customer",
    );
    strictEqual(
      flagBody({ ...run("active", "blocked"), flagDetail: { reason } }),
      "Crest file missing\nAsked the customer",
    );
    strictEqual(flagHeading(run("active", null)), null);
    strictEqual(flagBody(run("active", null)), null);
    strictEqual(flagTone(run("active", null)), null);
  });
});

const runListItem = (
  id: string,
  orderProcessedAt: number,
  overrides: {
    readonly flag?: Domain.RunFlag;
    readonly startedBy?: string;
    /** Defaults to `<startedBy>@example.com`; name it to make the id and the email disagree. */
    readonly startedByEmail?: string;
  } = {},
): Domain.RunListItem => ({
  run: {
    ...run("active", overrides.flag ?? null),
    id: Schema.decodeUnknownSync(Domain.WorkflowRunId)(id),
    orderName: `#${id}`,
    orderProcessedAt,
  },
  tasks: [
    {
      id: Schema.decodeUnknownSync(Domain.WorkflowRunTaskId)(`${id}-s`),
      runId: Schema.decodeUnknownSync(Domain.WorkflowRunId)(id),
      position: 1,
      step: 1,
      name: Schema.decodeUnknownSync(Domain.TaskName)("Cut"),
      teamId: Schema.decodeUnknownSync(Domain.TeamId)("t"),
      teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
      startedAt: overrides.startedBy === undefined ? null : 1,
      startedBy:
        overrides.startedBy === undefined
          ? null
          : Schema.decodeUnknownSync(Domain.MemberId)(overrides.startedBy),
      startedByEmail:
        overrides.startedBy === undefined
          ? null
          : Schema.decodeUnknownSync(Domain.Email)(
              overrides.startedByEmail ?? `${overrides.startedBy}@example.com`,
            ),
      startedByRole: overrides.startedBy === undefined ? null : "member",
    },
  ],
  stepCount: 1,
});

const withTasks = (
  tasks: readonly (readonly [name: string, team: string])[],
): Domain.RunListItem => {
  const item = runListItem("1", 0);
  const [base] = item.tasks;
  const [first, ...rest] = tasks.map(([name, team], index) => ({
    ...base,
    id: Schema.decodeUnknownSync(Domain.WorkflowRunTaskId)(`t${String(index)}`),
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
  it("a member row lists every ready task by name, then step k of n, and names a team per task only when they differ", () => {
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
  it("a flag first, then mine, then a teammate's, then untouched", () => {
    strictEqual(
      Domain.tierOf(
        runListItem("flagged-mine", 40, { flag: "blocked", startedBy: "me" }),
        ME,
      ),
      "attention",
    );
    strictEqual(
      Domain.tierOf(runListItem("mine", 20, { startedBy: "me" }), ME),
      "mine",
    );
    strictEqual(
      Domain.tierOf(runListItem("theirs", 5, { startedBy: "them" }), ME),
      "inProgress",
    );
    strictEqual(Domain.tierOf(runListItem("early-next", 10), ME), "upNext");
  });

  /**
   * The re-added member: removing and re-adding an address mints a new
   * `Member.id`, so the row taken before that carries an id the connection no
   * longer has. The email is the snapshot that survives, and the work is still
   * theirs.
   */
  it("keeps a task under Mine when the id changed but the email did not", () => {
    strictEqual(
      Domain.tierOf(
        runListItem("re-added", 20, {
          startedBy: "old-id",
          startedByEmail: "me@example.com",
        }),
        ME,
      ),
      "mine",
    );
    strictEqual(
      Domain.tierOf(runListItem("someone-else", 10, { startedBy: "them" }), ME),
      "inProgress",
    );
  });
});

const withLine = (item: Domain.RunListItem, lineItemId: string) => ({
  ...item,
  run: { ...item.run, lineItemId },
});

describe("Domain.byAge", () => {
  it("oldest order first, then line item, then run id", () => {
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

describe("Domain.runIsOpen / Domain.runIsLive", () => {
  it("open is pending or active; live is anything but cancelled", () => {
    const statuses: readonly Domain.RunStatus[] = [
      "pending",
      "active",
      "done",
      "cancelled",
    ];
    deepStrictEqual(
      statuses.map((status) => Domain.runIsOpen(run(status, null))),
      [true, true, false, false],
    );
    deepStrictEqual(
      statuses.map((status) => Domain.runIsLive(run(status, null))),
      [true, true, true, false],
    );
  });
});

const TEAM = Schema.decodeUnknownSync(Domain.TeamId)("t");
const OTHER_TEAM = Schema.decodeUnknownSync(Domain.TeamId)("u");

const taskView = (
  overrides: Partial<
    Pick<
      Domain.RunTaskView,
      "teamId" | "ready" | "startedAt" | "completedAt" | "undoBlockedBy"
    >
  > = {},
): Pick<
  Domain.RunTaskView,
  "teamId" | "ready" | "startedAt" | "completedAt" | "undoBlockedBy"
> => ({
  teamId: TEAM,
  ready: true,
  startedAt: null,
  completedAt: null,
  undoBlockedBy: null,
  ...overrides,
});

const NOTHING = {
  start: false,
  done: false,
  putBack: false,
  undo: null,
};

describe("Domain.taskActions", () => {
  it("a done run's last task is undoable while nothing downstream started", () => {
    deepStrictEqual(
      Domain.taskActions(
        run("done", null),
        taskView({ ready: false, startedAt: 1, completedAt: 2 }),
        [TEAM],
      ),
      { ...NOTHING, undo: { blockedBy: null } },
    );
  });

  it("reopening a task is refused once any task in a later step has started, naming the blocker", () => {
    const blocker: Domain.UndoBlocker = {
      taskName: Schema.decodeUnknownSync(Domain.TaskName)("Polish"),
      teamName: Schema.decodeUnknownSync(Domain.TeamName)("Finishing"),
    };
    deepStrictEqual(
      Domain.taskActions(
        run("active", null),
        taskView({
          ready: false,
          startedAt: 1,
          completedAt: 2,
          undoBlockedBy: blocker,
        }),
        [TEAM],
      ),
      { ...NOTHING, undo: { blockedBy: blocker } },
    );
  });

  it("a cancelled run offers no actions", () => {
    deepStrictEqual(
      Domain.taskActions(run("cancelled", null), taskView(), [TEAM]),
      NOTHING,
    );
    deepStrictEqual(
      Domain.taskActions(
        run("cancelled", null),
        taskView({ ready: false, startedAt: 1, completedAt: 2 }),
        [TEAM],
      ),
      NOTHING,
    );
  });

  it("a flag hides Start and Done but not Undo", () => {
    deepStrictEqual(
      Domain.taskActions(run("active", "blocked"), taskView(), [TEAM]),
      { ...NOTHING },
    );
    deepStrictEqual(
      Domain.taskActions(
        run("active", "item_removed"),
        taskView({ ready: false, startedAt: 1, completedAt: 2 }),
        [TEAM],
      ),
      { ...NOTHING, undo: { blockedBy: null } },
    );
  });

  it("a task on another team offers nothing", () => {
    deepStrictEqual(
      Domain.taskActions(run("active", null), taskView(), [OTHER_TEAM]),
      NOTHING,
    );
    deepStrictEqual(
      Domain.taskActions(run("active", null), taskView({ teamId: null }), [
        TEAM,
      ]),
      NOTHING,
    );
  });

  it("Start is offered only before the task is started; Done while it is ready", () => {
    deepStrictEqual(
      Domain.taskActions(run("pending", null), taskView(), [TEAM]),
      {
        start: true,
        done: true,
        putBack: false,
        undo: null,
      },
    );
    deepStrictEqual(
      Domain.taskActions(run("active", null), taskView({ startedAt: 1 }), [
        TEAM,
      ]),
      { start: false, done: true, putBack: true, undo: null },
    );
    deepStrictEqual(
      Domain.taskActions(run("active", null), taskView({ ready: false }), [
        TEAM,
      ]),
      { ...NOTHING },
    );
  });
});

describe("Domain.taskActions Put back", () => {
  it("Put back is offered wherever Done is, and only on a started task", () => {
    strictEqual(
      Domain.taskActions(run("active", null), taskView({ startedAt: 1 }), [
        TEAM,
      ]).putBack,
      true,
    );
    strictEqual(
      Domain.taskActions(run("pending", null), taskView(), [TEAM]).putBack,
      false,
    );
    strictEqual(
      Domain.taskActions(
        run("active", null),
        taskView({ ready: false, startedAt: 1 }),
        [TEAM],
      ).putBack,
      false,
    );
  });

  it("a flag hides Put back", () => {
    strictEqual(
      Domain.taskActions(run("active", "blocked"), taskView({ startedAt: 1 }), [
        TEAM,
      ]).putBack,
      false,
    );
  });

  it("a started task on another team offers no Put back", () => {
    strictEqual(
      Domain.taskActions(run("active", null), taskView({ startedAt: 1 }), [
        OTHER_TEAM,
      ]).putBack,
      false,
    );
  });

  it("a finished task offers no Put back", () => {
    strictEqual(
      Domain.taskActions(
        run("active", null),
        taskView({ ready: false, startedAt: 1, completedAt: 2 }),
        [TEAM],
      ).putBack,
      false,
    );
  });
});

describe("Domain.runIsFlagged / runIsBlocked / flagIsReconcile", () => {
  it("blocked is the person's flag; every other flag is reconcile's; null is neither", () => {
    strictEqual(Domain.runIsFlagged(run("active", null)), false);
    strictEqual(Domain.runIsFlagged(run("active", "blocked")), true);
    strictEqual(Domain.runIsFlagged(run("active", "item_removed")), true);
    strictEqual(Domain.runIsBlocked(run("active", "blocked")), true);
    strictEqual(Domain.runIsBlocked(run("active", "item_removed")), false);
    strictEqual(Domain.flagIsReconcile("blocked"), false);
    for (const flag of Domain.RunFlag.literals)
      if (flag !== "blocked") strictEqual(Domain.flagIsReconcile(flag), true);
  });
});

const runTask = (
  position: number,
  step: number,
  completed: boolean,
): Domain.WorkflowRunTask => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowRunTaskId)(
    `s${String(position)}`,
  ),
  runId: Schema.decodeUnknownSync(Domain.WorkflowRunId)("r"),
  position,
  step,
  name: Schema.decodeUnknownSync(Domain.TaskName)(`Task ${String(position)}`),
  teamId: TEAM,
  teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
  instructions: null,
  startedAt: completed ? 1 : null,
  startedBy: null,
  startedByEmail: null,
  startedByRole: null,
  completedAt: completed ? 2 : null,
  completedBy: null,
  completedByEmail: null,
  completedByRole: null,
  reopenedAt: null,
  reopenedByRole: null,
  reopenedByEmail: null,
});

describe("Domain.runIsVisibleTo", () => {
  it("a member's access to a run is any task of it on one of their teams, ready or not", () => {
    const unassigned = { ...runTask(2, 2, false), teamId: null };
    const tasks = [runTask(1, 1, true), unassigned];
    strictEqual(Domain.runIsVisibleTo(tasks, [TEAM]), true);
    strictEqual(Domain.runIsVisibleTo(tasks, ["other"]), false);
    // An unassigned task is on nobody's list.
    strictEqual(Domain.runIsVisibleTo([unassigned], [TEAM]), false);
  });
});

describe("Domain.readyTasks", () => {
  it("a task is ready when open and no task of an earlier step is open; every task of a step is ready together", () => {
    const tasks = [
      runTask(1, 1, true),
      runTask(2, 2, false),
      runTask(3, 2, false),
      runTask(4, 3, false),
    ];
    deepStrictEqual(
      Domain.readyTasks(run("active", null), tasks).map(
        (task) => task.position,
      ),
      [2, 3],
    );
    deepStrictEqual(
      Domain.readyTasks(run("active", null), [
        runTask(1, 1, false),
        runTask(2, 2, false),
      ]).map((task) => task.position),
      [1],
    );
  });

  it("a run that is not open has no ready task", () => {
    const tasks = [runTask(1, 1, false)];
    deepStrictEqual(Domain.readyTasks(run("cancelled", null), tasks), []);
    deepStrictEqual(
      Domain.readyTasks(run("done", null), [runTask(1, 1, true)]),
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
