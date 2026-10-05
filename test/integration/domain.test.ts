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

  it("multi-match: an item two workflows match", () => {
    deepStrictEqual(Domain.orderIssues(row({ open: 1 }, {}, 1)), [
      "multi_match",
    ]);
  });

  it("a multi-match item on an unpaid order is an issue", () => {
    deepStrictEqual(Domain.orderIssues(row(NONE, { fullyPaid: false }, 1)), [
      "multi_match",
    ]);
  });

  it("unassigned: an open run has an unassigned open task", () => {
    deepStrictEqual(
      Domain.orderIssues({ ...row({ open: 1 }), unassigned: true }),
      ["unassigned"],
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
    ) => Domain.multiMatchItems(lineItems, runs, DETAILS, TEAMS).length;
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
        [lineItem("a", ["w1", "w2", "w3"])],
        [],
        details,
        TEAMS,
      ).length,
      0,
    );
    deepStrictEqual(
      Domain.matchedWorkflows(
        lineItem("a", ["w1", "w2", "w3"]),
        details,
        TEAMS,
      ).map(({ workflow }) => workflow.tag),
      ["w1"],
    );
  });
});

/** A stored `tasks` document of `[id, step]` pairs, every other field fixed. */
const stored = (
  ...tasks: readonly (readonly [id: string, step: number])[]
): string =>
  JSON.stringify(
    tasks.map(([id, step]) => ({
      id,
      step,
      name: "Task",
      teamId: null,
      instructions: null,
    })),
  );

describe("Domain.WorkflowTasks", () => {
  const decode = Schema.decodeUnknownOption(Domain.WorkflowTasks);

  it("fills position from the index and drops it again on encode", () => {
    const tasks = Schema.decodeUnknownSync(Domain.WorkflowTasks)(
      stored(["a", 1], ["b", 1], ["c", 2]),
    );
    deepStrictEqual(
      tasks.map((task) => [task.id, task.position, task.step]),
      [
        ["a", 1, 1],
        ["b", 2, 1],
        ["c", 3, 2],
      ],
    );
    strictEqual(
      Schema.encodeSync(Domain.WorkflowTasks)(tasks),
      stored(["a", 1], ["b", 1], ["c", 2]),
    );
  });

  it("refuses a gap, a decrease, a duplicate id and a list past maxTasks", () => {
    strictEqual(decode(stored(["a", 1], ["b", 3]))._tag, "None", "a gap");
    strictEqual(
      decode(stored(["a", 1], ["b", 2], ["c", 1]))._tag,
      "None",
      "a decrease",
    );
    strictEqual(decode(stored(["a", 2]))._tag, "None", "not from 1");
    strictEqual(
      decode(stored(["a", 1], ["a", 2]))._tag,
      "None",
      "a duplicate id",
    );
    const full = Array.from(
      { length: Domain.WorkflowLimits.maxTasks + 1 },
      (_, index) => [`t${String(index)}`, index + 1] as const,
    );
    strictEqual(decode(stored(...full))._tag, "None", "past maxTasks");
    strictEqual(
      decode(stored(...full.slice(0, Domain.WorkflowLimits.maxTasks)))._tag,
      "Some",
    );
  });
});

/** A workflow as the Workflow select names it, id and name both `tag`. */
const nameRow = (tag: string): Domain.WorkflowNameRow => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowId)(tag),
  name: Schema.decodeUnknownSync(Domain.WorkflowName)(tag),
});

describe("Domain.lineItemState options", () => {
  it("options are the item's matches, then the order's other matches, then the other workflows, each once", () => {
    const state = Domain.lineItemState(
      lineItem("a", ["w2"]),
      [],
      [detailOf("w1"), detailOf("w2")],
      [nameRow("w1"), nameRow("w3")],
      TEAMS,
    );
    if (state.kind !== "attachable") throw new Error(state.kind);
    deepStrictEqual(
      state.options.map(({ name }) => name),
      ["w2", "w1", "w3"],
    );
    deepStrictEqual(state.matched, [nameRow("w2").id]);
  });
});

describe("Domain.TaskInstructions", () => {
  it("TaskInstructions refuses 501 characters and accepts 500", () => {
    const decode = Schema.decodeUnknownOption(Domain.TaskInstructions);
    strictEqual(
      decode("x".repeat(Domain.TASK_INSTRUCTIONS_MAX_LENGTH))._tag,
      "Some",
    );
    strictEqual(
      decode("x".repeat(Domain.TASK_INSTRUCTIONS_MAX_LENGTH + 1))._tag,
      "None",
    );
  });
});

describe("Domain.matchesTag", () => {
  it("a product tag matches the workflow's tag exactly: case and surrounding space make another tag", () => {
    const detail = detailOf("engraving");
    strictEqual(Domain.matchesTag(detail, lineItem("a", ["engraving"])), true);
    strictEqual(Domain.matchesTag(detail, lineItem("a", ["Engraving"])), false);
    strictEqual(
      Domain.matchesTag(detail, lineItem("a", [" engraving "])),
      false,
    );
    strictEqual(
      Schema.decodeUnknownSync(Domain.WorkflowTag)(" Engraving "),
      "Engraving",
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

/**
 * A row at step 2 of 3 of workflow "Signet ring", one entry per task:
 * `[name, team, starter]`, the starter an email local part, `"merchant"`, a
 * starter with no known actor (`"?"`), or absent for a ready task.
 */
const starterOf = (
  startedBy: string | undefined,
): Pick<
  Domain.RunListTask,
  "startedAt" | "startedByEmail" | "startedByRole"
> => {
  if (startedBy === undefined)
    return { startedAt: null, startedByEmail: null, startedByRole: null };
  if (startedBy === "?")
    return { startedAt: 1, startedByEmail: null, startedByRole: null };
  if (startedBy === "merchant")
    return { startedAt: 1, startedByEmail: null, startedByRole: "merchant" };
  return {
    startedAt: 1,
    startedByEmail: Schema.decodeUnknownSync(Domain.Email)(
      `${startedBy}@example.com`,
    ),
    startedByRole: "member",
  };
};

const withTasks = (
  tasks: readonly (readonly [name: string, team: string, startedBy?: string])[],
  block: { readonly reason: string | null } | null = null,
): Domain.RunListItem => {
  const item = runListItem("1", 0, { blocked: block !== null });
  const [base] = item.tasks;
  const [first, ...rest] = tasks.map(([name, team, startedBy], index) => ({
    ...base,
    id: Schema.decodeUnknownSync(Domain.RunTaskId)(`t${String(index)}`),
    position: index + 2,
    step: 2,
    name: Schema.decodeUnknownSync(Domain.TaskName)(name),
    teamName: Schema.decodeUnknownSync(Domain.TeamName)(team),
    ...starterOf(startedBy),
  }));
  if (first === undefined) throw new Error("withTasks: no tasks");
  return {
    ...item,
    run: {
      ...item.run,
      workflowName: Schema.decodeUnknownSync(Domain.WorkflowName)(
        "Signet ring",
      ),
      blockReason:
        block?.reason === null || block === null
          ? null
          : Schema.decodeUnknownSync(Domain.BlockReason)(block.reason),
    },
    tasks: [first, ...rest],
    stepCount: 3,
  };
};

const ME = Schema.decodeUnknownSync(Domain.Email)("me@example.com");

/** The task lines as the row prints them: `Name (Team) · State`. */
const taskLines = (
  item: Domain.RunListItem,
  showTeam: boolean,
  state: Domain.WorkflowsListState | null,
) =>
  Domain.runRowLines(item, { memberEmail: ME, showTeam, state }).tasks.map(
    (task) =>
      `${task.name}${task.team === null ? "" : ` (${task.team})`}${task.state === null ? "" : ` · ${task.state}`}`,
  );

const blockOf = (
  item: Domain.RunListItem,
  state: Domain.WorkflowsListState | null,
) =>
  Domain.runRowLines(item, { memberEmail: ME, showTeam: false, state }).block;

describe("Domain.runRowLines", () => {
  it("a row has one line per current task, in position order", () => {
    deepStrictEqual(
      taskLines(
        withTasks([
          ["Stamp monogram", "Engraving"],
          ["Engrave initials", "Engraving"],
        ]),
        false,
        "ready",
      ),
      ["Stamp monogram", "Engrave initials"],
    );
  });

  it("a task's team is printed after it when the list shows teams or when the row's tasks are on more than one team", () => {
    const one = withTasks([["Stamp monogram", "Engraving"]]);
    const shared = withTasks([
      ["Stamp monogram", "Engraving"],
      ["Engrave initials", "Engraving"],
    ]);
    const split = withTasks([
      ["Stamp monogram", "Engraving"],
      ["Engrave initials", "Finishing"],
    ]);
    deepStrictEqual(taskLines(one, false, "ready"), ["Stamp monogram"]);
    deepStrictEqual(taskLines(one, true, "ready"), [
      "Stamp monogram (Engraving)",
    ]);
    deepStrictEqual(taskLines(shared, false, "ready"), [
      "Stamp monogram",
      "Engrave initials",
    ]);
    deepStrictEqual(taskLines(shared, true, "ready"), [
      "Stamp monogram (Engraving)",
      "Engrave initials (Engraving)",
    ]);
    deepStrictEqual(taskLines(split, false, "ready"), [
      "Stamp monogram (Engraving)",
      "Engrave initials (Finishing)",
    ]);
  });

  it("a task line never repeats the state the filter already says", () => {
    const mine = withTasks([["Cut", "Cutting", "me"]]);
    const theirs = withTasks([["Cut", "Cutting", "them"]]);
    const merchant = withTasks([["Cut", "Cutting", "merchant"]]);
    const unknown = withTasks([["Cut", "Cutting", "?"]]);
    const ready = withTasks([["Cut", "Cutting"]]);
    deepStrictEqual(taskLines(mine, false, "started_by_you"), ["Cut"]);
    deepStrictEqual(taskLines(theirs, false, "started_by_others"), [
      "Cut · Started by them@example.com",
    ]);
    deepStrictEqual(taskLines(merchant, false, "started_by_others"), [
      "Cut · Started by Merchant",
    ]);
    deepStrictEqual(taskLines(unknown, false, "started_by_others"), [
      "Cut · Started",
    ]);
    deepStrictEqual(taskLines(ready, false, "ready"), ["Cut"]);
  });

  it("each task on a parallel step prints its own state", () => {
    const row = withTasks([
      ["Stamp monogram", "Engraving", "them"],
      ["Stitch spine", "Engraving", "me"],
      ["Emboss cover", "Engraving"],
    ]);
    deepStrictEqual(taskLines(row, false, "started_by_you"), [
      "Stamp monogram · Started by them@example.com",
      "Stitch spine",
      "Emboss cover · Ready",
    ]);
  });

  it("under a search every task line prints its state", () => {
    const row = withTasks([
      ["Stamp monogram", "Engraving", "them"],
      ["Stitch spine", "Engraving", "me"],
      ["Emboss cover", "Engraving"],
      ["Gild edges", "Engraving", "?"],
    ]);
    deepStrictEqual(taskLines(row, false, null), [
      "Stamp monogram · Started by them@example.com",
      "Stitch spine · Started by you",
      "Emboss cover · Ready",
      "Gild edges · Started",
    ]);
  });

  it("a block is the run's, said once: its tasks print no state, and the block line drops what the Blocked filter says", () => {
    const reason = withTasks(
      [
        ["Cut", "Cutting", "me"],
        ["Polish", "Cutting"],
      ],
      {
        reason: "Waiting on stone",
      },
    );
    const bare = withTasks([["Cut", "Cutting"]], { reason: null });
    deepStrictEqual(taskLines(reason, false, null), ["Cut", "Polish"]);
    strictEqual(blockOf(reason, null), "Blocked · Waiting on stone");
    strictEqual(blockOf(reason, "blocked"), "Waiting on stone");
    strictEqual(blockOf(bare, null), "Blocked");
    strictEqual(blockOf(bare, "blocked"), null);
    strictEqual(blockOf(withTasks([["Cut", "Cutting"]]), null), null);
  });

  it("the recipe line is the workflow name and step k of n, on every open row whatever its state", () => {
    const recipe = (item: Domain.RunListItem) =>
      Domain.runRowLines(item, {
        memberEmail: ME,
        showTeam: false,
        state: null,
      }).recipe;
    const joined = (item: Domain.RunListItem) => {
      const { workflow, step } = recipe(item);
      return `${workflow} · ${step}`;
    };
    strictEqual(
      joined(withTasks([["Cut", "Cutting"]])),
      "Signet ring · Step 2 of 3",
    );
    strictEqual(
      joined(withTasks([["Cut", "Cutting"]], { reason: "x" })),
      "Signet ring · Step 2 of 3",
    );
  });
});

describe("Domain.rowShowsTeam", () => {
  const TEAM = Schema.decodeUnknownSync(Domain.TeamId)("t");
  const Q = Schema.decodeUnknownSync(Domain.ListSearch)("ring");
  it("a row names its team when the member is on more than one team and the list is not narrowed to one, or the list is a search", () => {
    strictEqual(Domain.rowShowsTeam(1, null, null), false);
    strictEqual(Domain.rowShowsTeam(1, null, Q), false);
    strictEqual(Domain.rowShowsTeam(2, null, null), true);
    strictEqual(Domain.rowShowsTeam(2, TEAM, null), false);
    strictEqual(Domain.rowShowsTeam(2, TEAM, Q), true);
  });
});

const item = (variantTitle: string | null, quantity: number) => ({
  lineItemTitle: "Signet ring",
  variantTitle,
  quantity,
});

describe("Domain.itemTitle", () => {
  it("line one is the item title, then the variant, then ×n when there is more than one to make", () => {
    strictEqual(Domain.itemTitle(item(null, 1)), "Signet ring");
    strictEqual(Domain.itemTitle(item("Gold", 1)), "Signet ring · Gold");
    strictEqual(Domain.itemTitle(item("Gold", 2)), "Signet ring · Gold ×2");
    strictEqual(Domain.itemTitle(item(null, 1200)), "Signet ring ×1,200");
  });
});

const runIds = (items: readonly Domain.RunListItem[]) =>
  items.map((item) => item.run.id).join(",");

describe("Domain.listStateOf", () => {
  it("a blocked run is in blocked; then started by you, then started by others, then ready", () => {
    strictEqual(
      Domain.listStateOf(
        runListItem("blocked-mine", 40, { blocked: true, startedBy: "me" }),
        ME,
      ),
      "blocked",
    );
    strictEqual(
      Domain.listStateOf(runListItem("mine", 20, { startedBy: "me" }), ME),
      "started_by_you",
    );
    strictEqual(
      Domain.listStateOf(runListItem("theirs", 5, { startedBy: "them" }), ME),
      "started_by_others",
    );
    strictEqual(Domain.listStateOf(runListItem("early-next", 10), ME), "ready");
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

describe("Domain.runHasRecord", () => {
  it("a run has a record when a task is started or done, the run is blocked, or it has a note", () => {
    const idle = { startedAt: null, doneAt: null };
    const clean = { blockedAt: null, note: null };
    strictEqual(Domain.runHasRecord(clean, [idle, idle]), false);
    strictEqual(Domain.runHasRecord({ ...clean, note: "" }, [idle]), false);
    strictEqual(
      Domain.runHasRecord(clean, [{ startedAt: 1, doneAt: null }, idle]),
      true,
    );
    strictEqual(
      Domain.runHasRecord(clean, [{ startedAt: 1, doneAt: 2 }, idle]),
      true,
    );
    strictEqual(Domain.runHasRecord({ ...clean, blockedAt: 1 }, [idle]), true);
    strictEqual(Domain.runHasRecord({ ...clean, note: "x" }, [idle]), true);
  });
});

describe("Domain.sameRunQuery", () => {
  const query: Domain.RunQuery = {
    team: null,
    state: "started_by_you",
    limit: Domain.RUN_PAGE,
    q: null,
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
    strictEqual(Domain.sameRunQuery(query, { ...query, state: "done" }), false);
    strictEqual(
      Domain.sameRunQuery(query, {
        ...query,
        q: Schema.decodeUnknownSync(Domain.ListSearch)("ring"),
      }),
      false,
    );
    strictEqual(
      Domain.sameRunQuery(query, {
        ...query,
        limit: Domain.RUN_PAGE + 1,
      }),
      false,
    );
  });
});

/** `Domain.searchTerm` over raw text, decoded first because the term takes a `ListSearch`. */
const search = (q: string) =>
  Domain.searchTerm(Schema.decodeUnknownSync(Domain.ListSearch)(q));

describe("Domain.searchTerm", () => {
  const decode = Schema.decodeUnknownOption(Domain.ListSearch);
  it("digits with an optional # are an order number", () => {
    for (const q of ["1001", "#1001", " #1001 ", "##1001"])
      deepStrictEqual(search(q), {
        kind: "orderName",
        name: "#1001",
      });
  });
  it("anything else is a word prefix", () => {
    for (const q of ["sig", "Signet ring", "SKU-9", "#ring", "10 karat"])
      strictEqual(search(q).kind, "prefix", q);
    deepStrictEqual(search(" ring "), {
      kind: "prefix",
      text: "ring",
    });
  });
  it("# alone is refused by ListSearch", () => {
    for (const q of ["#", "##", " # ", "", "  "])
      strictEqual(decode(q)._tag, "None", q);
    strictEqual(decode("#1")._tag, "Some");
  });
  it("a word prefix matches the start of a word in the title, the variant or the SKU, ASCII case folded", () => {
    const item = {
      orderName: "#1001",
      title: "Signet ring",
      variantTitle: "Rose gold",
      sku: "RING-9",
    };
    const matches = (q: string) => Domain.searchMatches(search(q), item);
    strictEqual(matches("sig"), true);
    strictEqual(matches("RING"), true);
    strictEqual(matches("gold"), true);
    strictEqual(matches("ring-9"), true);
    strictEqual(matches("net"), false);
    strictEqual(matches("1001"), true);
    strictEqual(matches("100"), false);
  });
  it("prefixPatterns escapes like syntax", () => {
    deepStrictEqual(Domain.prefixPatterns(String.raw`50%_\x`), [
      String.raw`50\%\_\\x%`,
      String.raw`% 50\%\_\\x%`,
    ]);
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
      "teamId" | "current" | "startedAt" | "doneAt" | "laterStepStarted"
    >
  > = {},
): Pick<
  Domain.RunTaskRow,
  "teamId" | "current" | "startedAt" | "doneAt" | "laterStepStarted"
> => ({
  teamId: TEAM,
  current: true,
  startedAt: null,
  doneAt: null,
  laterStepStarted: false,
  ...overrides,
});

const NOTHING = {
  start: false,
  done: false,
  putBack: false,
  reopen: false,
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
      { ...NOTHING, reopen: true },
    );
  });

  it("reopening a task is refused once any task in a later step has started", () => {
    deepStrictEqual(
      memberActions(
        run("open"),
        taskRow({
          current: false,
          startedAt: 1,
          doneAt: 2,
          laterStepStarted: true,
        }),
        [TEAM],
      ),
      NOTHING,
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
      { ...NOTHING, reopen: true },
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
      reopen: false,
      assign: false,
    });
    deepStrictEqual(
      memberActions(run("open"), taskRow({ startedAt: 1 }), [TEAM]),
      {
        start: false,
        done: true,
        putBack: true,
        reopen: false,
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

describe("Domain.openOrdersAtCeiling", () => {
  it("the shop is at its order ceiling when the open orders have reached maxOpenOrders", () => {
    const { maxOpenOrders } = Domain.ShopLimits;
    strictEqual(Domain.openOrdersAtCeiling(maxOpenOrders - 1), false);
    strictEqual(Domain.openOrdersAtCeiling(maxOpenOrders), true);
    strictEqual(Domain.openOrdersAtCeiling(maxOpenOrders + 1), true);
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
