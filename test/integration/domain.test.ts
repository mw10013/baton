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
  multiMatchItems = 0,
): Domain.OrderRow => ({
  order: order(overrides),
  itemUnits: 1,
  runs: { ...NONE, ...runs },
  unassigned: false,
  emptyTeam: false,
  waitingOn: [],
  multiMatchItems,
});

const NONE = {
  open: 0,
  done: 0,
  blocked: 0,
} satisfies Domain.RunCounts;

describe("Domain.orderPosition", () => {
  const cases: readonly [string, Domain.OrderRow, Domain.OrderPosition][] = [
    ["no open and no done run is not started", row(NONE), "not_started"],
    ["any open run is making", row({ open: 1, done: 1 }), "making"],
    [
      "a multi-match item does not move the position: one item chosen, another waiting",
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
      row({ done: 1 }, { fulfillmentStatus: "FULFILLED" }),
      "fulfilled",
    ],
    [
      "a fulfilled order with no runs is fulfilled (history the open-orders sync pulls in)",
      row(NONE, { fulfillmentStatus: "FULFILLED" }),
      "fulfilled",
    ],
    [
      "a cancelled order is cancelled whatever its runs say",
      row({ open: 1 }, { cancelledAt: 1 }),
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
      strictEqual(Domain.orderPosition(input), expected);
    });

  it("an open order with no runs is not started whether or not it is paid", () => {
    strictEqual(
      Domain.orderPosition(row(NONE, { fullyPaid: false })),
      "not_started",
    );
    strictEqual(Domain.orderPosition(row(NONE, {}, 1)), "not_started");
  });
});

describe("Domain.orderIssues", () => {
  it("an order with no run and no multi-match item has no issue", () => {
    deepStrictEqual(Domain.orderIssues(row(NONE)), []);
    deepStrictEqual(Domain.orderIssues(row(NONE, { fullyPaid: false })), []);
    deepStrictEqual(Domain.orderIssues(row({ open: 1 })), []);
    deepStrictEqual(Domain.orderIssues(row({ done: 1 })), []);
    deepStrictEqual(Domain.orderIssues(row(NONE, {}, 1)), ["multi_match"]);
  });

  it("multi-match: an item two workflows match, on an order that can create runs", () => {
    deepStrictEqual(Domain.orderIssues(row({ open: 1 }, {}, 1)), [
      "multi_match",
    ]);
    deepStrictEqual(Domain.orderIssues(row(NONE, { fullyPaid: false }, 1)), []);
  });

  it("unassigned: an open run has an unassigned open task", () => {
    deepStrictEqual(
      Domain.orderIssues({ ...row({ open: 1 }), unassigned: true }),
      ["unassigned"],
    );
  });

  it("empty team: an open run has a current task on a team with no members", () => {
    deepStrictEqual(
      Domain.orderIssues({ ...row({ open: 1 }), emptyTeam: true }),
      ["empty_team"],
    );
  });

  it("an order with both team faults carries both issues, unassigned first", () => {
    deepStrictEqual(
      Domain.orderIssues({
        ...row({ open: 2 }),
        unassigned: true,
        emptyTeam: true,
      }),
      ["unassigned", "empty_team"],
    );
  });

  it("blocked: an open run is blocked", () => {
    deepStrictEqual(Domain.orderIssues(row({ open: 1, blocked: 1 })), [
      "blocked",
    ]);
  });

  it("an order can be blocked and choosing at once, in row order", () => {
    deepStrictEqual(
      Domain.orderIssues({
        ...row({ open: 2, blocked: 1 }, {}, 1),
        unassigned: true,
      }),
      ["multi_match", "unassigned", "blocked"],
    );
  });

  it("a fulfilled or cancelled order has no issues", () => {
    const troubled = (overrides: Partial<Domain.ShopOrder>) => ({
      ...row({ open: 1, blocked: 1 }, overrides, 1),
      unassigned: true,
      emptyTeam: true,
    });
    deepStrictEqual(
      Domain.orderIssues(troubled({ fulfillmentStatus: "FULFILLED" })),
      [],
    );
    deepStrictEqual(Domain.orderIssues(troubled({ cancelledAt: 1 })), []);
    deepStrictEqual(
      Domain.orderIssues(row(NONE, { fulfillmentStatus: "FULFILLED" })),
      [],
    );
  });
});

const run = (state: Domain.RunState, blocked = false): Domain.Run => ({
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
  state,
  blockedAt: blocked ? 1 : null,
  blockReason: null,
  blockedBy: null,
  quantityChangedFrom: null,
  note: null,
  createdAt: 0,
  updatedAt: 0,
  closedAt: state === "closed" ? 1 : null,
  closedReason: state === "closed" ? "fulfilled" : null,
});

describe("Domain.runCounts", () => {
  it("counts open, done and blocked-open the way the index SQL does, and closed runs not at all", () => {
    deepStrictEqual(
      Domain.runCounts([
        run("open"),
        run("open", true),
        run("open"),
        run("done"),
        run("closed"),
        run("closed"),
      ]),
      { open: 3, done: 1, blocked: 1 },
    );
  });
});

const lineItem = (
  id: string,
  productTags: readonly string[],
  currentQuantity = 1,
): Domain.OrderLineItem => ({
  id,
  orderId: "o",
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity,
  productTags,
  properties: [],
});

const TEAMS = [{ id: Schema.decodeUnknownSync(Domain.TeamId)("t") }];

/** A workflow tagged `tag`, one task on team `t` unless `teamId` says otherwise. */
const detailOf = (
  tag: string,
  state: Domain.WorkflowState = "on",
  teamId: string | null = "t",
): Domain.WorkflowDetail => {
  const id = Schema.decodeUnknownSync(Domain.WorkflowId)(tag);
  return {
    workflow: {
      id,
      name: Schema.decodeUnknownSync(Domain.WorkflowName)(tag),
      tag: Schema.decodeUnknownSync(Domain.WorkflowTag)(tag),
      state,
      updatedAt: 0,
    },
    tasks: [
      {
        id: Schema.decodeUnknownSync(Domain.WorkflowTaskId)(`${tag}-task`),
        workflowId: id,
        position: 1,
        step: 1,
        name: Schema.decodeUnknownSync(Domain.TaskName)("Task"),
        teamId:
          teamId === null
            ? null
            : Schema.decodeUnknownSync(Domain.TeamId)(teamId),
        instructions: null,
      },
    ],
  };
};

const DETAILS = [detailOf("w1"), detailOf("w2")];

const runOn = (lineItemId: string, state: Domain.RunState): Domain.Run => ({
  ...run(state),
  lineItemId,
});

const PAID = { fullyPaid: true, cancelledAt: null };

describe("Domain.multiMatchItems", () => {
  /**
   * The same three conditions `OrderRepository`'s `MULTI_MATCH_ITEM` spells out
   * in SQL. A `done` run counts on purpose: a done item does not get a
   * second route, so it is not a decision anyone is waiting on. A cancelled
   * run is deleted (`Domain.RunState`), so a cancel makes the item a
   * decision again with no rule of its own: the "two matches and no run"
   * case below.
   */
  it("counts items with two matches, units to make, and no run", () => {
    const multiMatchItems = (
      lineItems: readonly Domain.OrderLineItem[],
      runs: readonly Domain.Run[],
    ) => Domain.multiMatchItems(PAID, lineItems, runs, DETAILS, TEAMS).length;
    strictEqual(
      multiMatchItems([lineItem("a", ["w1", "w2"])], []),
      1,
      "two matches and no run",
    );
    strictEqual(
      multiMatchItems([lineItem("a", ["w1"])], []),
      0,
      "one match is not a decision",
    );
    strictEqual(
      multiMatchItems([lineItem("a", ["w1", "w2"], 0)], []),
      0,
      "nothing left to make",
    );
    strictEqual(
      multiMatchItems([lineItem("a", ["w1", "w2"])], [runOn("a", "open")]),
      0,
      "a run owns the item",
    );
    strictEqual(
      multiMatchItems([lineItem("a", ["w1", "w2"])], [runOn("a", "done")]),
      0,
      "a done run owns the item: a done item gets no second route",
    );
    strictEqual(
      multiMatchItems(
        [lineItem("a", ["w1", "w2"]), lineItem("b", ["w1", "w2"])],
        [runOn("b", "open")],
      ),
      1,
      "per item, not per order",
    );
  });

  it("a match needs an eligible workflow: an off workflow or one with an unassigned task is not a match", () => {
    const details = [
      detailOf("w1"),
      detailOf("w2", "off"),
      detailOf("w3", "on", null),
    ];
    strictEqual(
      Domain.multiMatchItems(
        PAID,
        [lineItem("a", ["w1", "w2", "w3"])],
        [],
        details,
        TEAMS,
      ).length,
      0,
    );
    deepStrictEqual(
      Domain.matchedWorkflows(lineItem("a", ["W1 "]), details, TEAMS).map(
        ({ workflow }) => workflow.tag,
      ),
      ["w1"],
    );
  });

  it("multi-match counts only on an order that can create runs", () => {
    const items = [lineItem("a", ["w1", "w2"])];
    strictEqual(
      Domain.multiMatchItems(PAID, items, [], DETAILS, TEAMS).length,
      1,
      "paid",
    );
    strictEqual(
      Domain.multiMatchItems(
        { fullyPaid: false, cancelledAt: null },
        items,
        [],
        DETAILS,
        TEAMS,
      ).length,
      0,
      "unpaid: not choosing until it pays",
    );
  });
});

/**
 * The copy is the contract between the order page, the Done or closed view and the
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
    ...run("open", overrides.blocked ?? false),
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

describe("Domain.viewOf", () => {
  it("a blocked run is in blocked; then mine, then a teammate's, then untouched", () => {
    strictEqual(
      Domain.viewOf(
        runListItem("blocked-mine", 40, { blocked: true, startedBy: "me" }),
        ME,
      ),
      "blocked",
    );
    strictEqual(
      Domain.viewOf(runListItem("mine", 20, { startedBy: "me" }), ME),
      "mine",
    );
    strictEqual(
      Domain.viewOf(runListItem("theirs", 5, { startedBy: "them" }), ME),
      "teammates",
    );
    strictEqual(Domain.viewOf(runListItem("early-next", 10), ME), "upNext");
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
    view: "mine",
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
    strictEqual(Domain.sameRunQuery(query, { ...query, view: "done" }), false);
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
  it("open is stored as open; done is the last task's Done; closed is ended by something else", () => {
    deepStrictEqual(
      Domain.RunState.literals.map((state) => Domain.runIsOpen(run(state))),
      [true, false, false],
    );
    deepStrictEqual(
      Domain.RunState.literals.map((state) => Domain.runIsDone(run(state))),
      [false, true, false],
    );
    deepStrictEqual(
      Domain.RunState.literals.map((state) => Domain.runIsClosed(run(state))),
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

const taskRow = (
  overrides: Partial<
    Pick<
      Domain.RunTaskRow,
      "teamId" | "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
    >
  > = {},
): Pick<
  Domain.RunTaskRow,
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
        taskRow({ current: false, startedAt: 1, doneAt: 2 }),
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
        run("open"),
        taskRow({
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
    deepStrictEqual(memberActions(run("open", true), taskRow(), [TEAM]), {
      ...NOTHING,
    });
    deepStrictEqual(
      memberActions(
        run("open", true),
        taskRow({ current: false, startedAt: 1, doneAt: 2 }),
        [TEAM],
      ),
      { ...NOTHING, reopen: { blockedBy: null } },
    );
  });

  it("a task on another team offers nothing", () => {
    deepStrictEqual(
      memberActions(run("open"), taskRow(), [OTHER_TEAM]),
      NOTHING,
    );
    deepStrictEqual(
      memberActions(run("open"), taskRow({ teamId: null }), [TEAM]),
      NOTHING,
    );
  });

  it("Start is offered only before the task is started; Done while it is ready", () => {
    deepStrictEqual(memberActions(run("open"), taskRow(), [TEAM]), {
      start: true,
      done: true,
      putBack: false,
      reopen: null,
      assign: false,
    });
    deepStrictEqual(
      memberActions(run("open"), taskRow({ startedAt: 1 }), [TEAM]),
      {
        start: false,
        done: true,
        putBack: true,
        reopen: null,
        assign: false,
      },
    );
    deepStrictEqual(
      memberActions(run("open"), taskRow({ current: false }), [TEAM]),
      { ...NOTHING },
    );
  });
});

describe("Domain.taskActions Put back", () => {
  it("Put back is offered wherever Done is, and only on a started task", () => {
    strictEqual(
      memberActions(run("open"), taskRow({ startedAt: 1 }), [TEAM]).putBack,
      true,
    );
    strictEqual(memberActions(run("open"), taskRow(), [TEAM]).putBack, false);
    strictEqual(
      memberActions(run("open"), taskRow({ current: false, startedAt: 1 }), [
        TEAM,
      ]).putBack,
      false,
    );
  });

  it("a block hides Put back", () => {
    strictEqual(
      memberActions(run("open", true), taskRow({ startedAt: 1 }), [TEAM])
        .putBack,
      false,
    );
  });

  it("a started task on another team offers no Put back", () => {
    strictEqual(
      memberActions(run("open"), taskRow({ startedAt: 1 }), [OTHER_TEAM])
        .putBack,
      false,
    );
  });

  it("a done task offers no Put back", () => {
    strictEqual(
      memberActions(
        run("open"),
        taskRow({ current: false, startedAt: 1, doneAt: 2 }),
        [TEAM],
      ).putBack,
      false,
    );
  });
});

describe("Domain.runIsBlocked", () => {
  it("a run is blocked exactly when a person's block stands on it", () => {
    strictEqual(Domain.runIsBlocked(run("open")), false);
    strictEqual(Domain.runIsBlocked(run("open", true)), true);
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
      Domain.currentTasks(run("open"), tasks).map((task) => task.position),
      [2, 3],
    );
    deepStrictEqual(
      Domain.currentTasks(run("open"), [
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
  it("the seat event value is the member count past the cycle's high-water mark, and zero when not past it", () => {
    strictEqual(Domain.seatEventValue(4, 3), 1);
    strictEqual(Domain.seatEventValue(6, 3), 3);
    strictEqual(Domain.seatEventValue(5, 0), 5);
    strictEqual(Domain.seatEventValue(3, 3), 0);
    strictEqual(Domain.seatEventValue(2, 4), 0);
  });
});

describe("Domain.membersAtCeiling", () => {
  it("a shop is at its ceiling when the member count has reached maxMembers", () => {
    const { maxMembers } = Domain.ShopLimits;
    strictEqual(Domain.membersAtCeiling(maxMembers - 1), false);
    strictEqual(Domain.membersAtCeiling(maxMembers), true);
    strictEqual(Domain.membersAtCeiling(maxMembers + 1), true);
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

describe("Domain.OrdersCursor", () => {
  const decode = Schema.decodeUnknownOption(Domain.OrdersCursor);
  it("a cursor is `<processedAt>:<id>`, so text that is not one is refused rather than read as page one", () => {
    strictEqual(decode("1700000000000:gid://shopify/Order/1")._tag, "Some");
    strictEqual(decode("nonsense")._tag, "None");
    strictEqual(decode(":gid://shopify/Order/1")._tag, "None");
    strictEqual(decode("1700000000000:")._tag, "None");
  });
});

describe("Domain.TeamName", () => {
  it("a team name is at most 32 characters, half a task name", () => {
    const decode = Schema.decodeUnknownExit(Domain.TeamName);
    strictEqual(Domain.TEAM_NAME_MAX_LENGTH, 32);
    strictEqual(Domain.TEAM_NAME_MAX_LENGTH * 2, Domain.NAME_MAX_LENGTH);
    strictEqual(decode("a".repeat(32))._tag, "Success");
    strictEqual(decode(` ${"a".repeat(32)} `)._tag, "Success");
    strictEqual(decode("a".repeat(33))._tag, "Failure");
  });
});

describe("the orders index's sync state", () => {
  it("no sync count reaches a screen: the orders index carries whether one runs and the last error", () => {
    deepStrictEqual(Object.keys(Domain.OrdersSyncStatus.fields).toSorted(), [
      "inFlight",
      "lastError",
    ]);
    strictEqual(
      Domain.OrdersIndexData.fields.syncState,
      Domain.OrdersSyncStatus,
    );
  });
});
