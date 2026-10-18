import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Orders from "../../../src/domain/orders.ts";
import * as Platform from "../../../src/domain/platform.ts";
import * as ShopWork from "../../../src/domain/shop-work.ts";

const order = (overrides: Partial<Orders.ShopOrder> = {}): Orders.ShopOrder => ({
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
  runs: Partial<ShopWork.RunCounts>,
  overrides: Partial<Orders.ShopOrder> = {},
  multiMatchItems = 0,
): ShopWork.OrderRow => ({
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
  started: 0,
} satisfies ShopWork.RunCounts;

describe("Domain.orderPosition", () => {
  const cases: readonly [string, ShopWork.OrderRow, ShopWork.OrderPosition][] = [
    ["no run on any item, not fully paid, is unpaid", row(NONE, { fullyPaid: false }), "unpaid"],
    ["no run on any item, fully paid, is no workflow", row(NONE), "no_workflow"],
    [
      "an open run with no started task and no done run is not started",
      row({ open: 2 }),
      "not_started",
    ],
    ["an open run with a started task is making", row({ open: 2, started: 1 }), "making"],
    [
      "an open run beside a done run is making, whatever the open run's tasks say",
      row({ open: 1, done: 1 }),
      "making",
    ],
    [
      "a blocked untouched run is not started",
      row({ open: 1, started: 0, blocked: 1 }),
      "not_started",
    ],
    [
      "a multi-match item does not move the position: one item chosen, another waiting",
      row({ open: 1, started: 1 }, {}, 1),
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
      strictEqual(ShopWork.orderPosition(input), expected);
    });
});

describe("Domain.orderIssues", () => {
  it("an order with no run and no multi-match item has no issue", () => {
    deepStrictEqual(ShopWork.orderIssues(row(NONE)), []);
    deepStrictEqual(ShopWork.orderIssues(row(NONE, { fullyPaid: false })), []);
    deepStrictEqual(ShopWork.orderIssues(row({ open: 1 })), []);
    deepStrictEqual(ShopWork.orderIssues(row({ done: 1 })), []);
    deepStrictEqual(ShopWork.orderIssues(row(NONE, {}, 1)), ["multi_match"]);
  });

  it("multi-match: an item two workflows match", () => {
    deepStrictEqual(ShopWork.orderIssues(row({ open: 1 }, {}, 1)), ["multi_match"]);
  });

  it("a multi-match item on an unpaid order is an issue", () => {
    deepStrictEqual(ShopWork.orderIssues(row(NONE, { fullyPaid: false }, 1)), ["multi_match"]);
  });

  it("unassigned: an open run has an unassigned open task", () => {
    deepStrictEqual(ShopWork.orderIssues({ ...row({ open: 1 }), unassigned: true }), [
      "unassigned",
    ]);
  });

  it("blocked: an open run is blocked", () => {
    deepStrictEqual(ShopWork.orderIssues(row({ open: 1, blocked: 1 })), ["blocked"]);
  });

  it("an order can be blocked and choosing at once, in row order", () => {
    deepStrictEqual(
      ShopWork.orderIssues({
        ...row({ open: 2, blocked: 1 }, {}, 1),
        unassigned: true,
      }),
      ["multi_match", "unassigned", "blocked"],
    );
  });

  it("a fulfilled or cancelled order has no issues", () => {
    const troubled = (overrides: Partial<Orders.ShopOrder>) => ({
      ...row({ open: 1, blocked: 1 }, overrides, 1),
      unassigned: true,
    });
    deepStrictEqual(ShopWork.orderIssues(troubled({ fulfillmentStatus: "FULFILLED" })), []);
    deepStrictEqual(ShopWork.orderIssues(troubled({ cancelledAt: 1 })), []);
    deepStrictEqual(ShopWork.orderIssues(row(NONE, { fulfillmentStatus: "FULFILLED" })), []);
  });
});

const run = (
  state: ShopWork.RunState,
  blocked = false,
  startedAt: number | null = null,
): ShopWork.Run => ({
  id: Schema.decodeUnknownSync(ShopWork.RunId)("r"),
  workflowId: Schema.decodeUnknownSync(ShopWork.WorkflowId)("w"),
  workflowName: Schema.decodeUnknownSync(ShopWork.WorkflowName)("W"),
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
  startedAt,
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
  it("counts open, done, blocked-open and started-open the way the index SQL does, and closed runs not at all", () => {
    deepStrictEqual(
      ShopWork.runCounts([
        run("open"),
        run("open", true),
        run("open", false, 1),
        run("done", false, 1),
        run("closed", false, 1),
        run("closed"),
      ]),
      { open: 3, done: 1, blocked: 1, started: 1 },
    );
  });
});

const lineItem = (
  id: string,
  productTags: readonly string[],
  currentQuantity = 1,
): Orders.OrderLineItem => ({
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

const TEAMS = [{ id: Schema.decodeUnknownSync(ShopWork.TeamId)("t") }];

/** A workflow tagged `tag`, one task on team `t` unless `teamId` says otherwise. */
const detailOf = (
  tag: string,
  state: ShopWork.WorkflowState = "active",
  teamId: string | null = "t",
): ShopWork.WorkflowDetail => {
  const id = Schema.decodeUnknownSync(ShopWork.WorkflowId)(tag);
  return {
    workflow: {
      id,
      name: Schema.decodeUnknownSync(ShopWork.WorkflowName)(tag),
      tag: Schema.decodeUnknownSync(ShopWork.WorkflowTag)(tag),
      state,
      updatedAt: 0,
    },
    tasks: [
      {
        id: Schema.decodeUnknownSync(ShopWork.WorkflowTaskId)(`${tag}-task`),
        position: 1,
        step: 1,
        name: Schema.decodeUnknownSync(ShopWork.TaskName)("Task"),
        teamId: teamId === null ? null : Schema.decodeUnknownSync(ShopWork.TeamId)(teamId),
        instructions: null,
      },
    ],
  };
};

const DETAILS = [detailOf("w1"), detailOf("w2")];

const runOn = (lineItemId: string, state: ShopWork.RunState): ShopWork.Run => ({
  ...run(state),
  lineItemId,
});

describe("Domain.multiMatchItems", () => {
  /**
   * The same three conditions `OrderRepository`'s `MULTI_MATCH_ITEM` spells out
   * in SQL. A `done` run counts on purpose: a done item does not get a
   * second route, so it is not a decision anyone is waiting on. A cancelled
   * run is deleted (`ShopWork.RunState`), so a cancel makes the item a
   * decision again with no rule of its own: the "two matches and no run"
   * case below.
   */
  it("counts items with two matches, units to make, and no run", () => {
    const multiMatchItems = (
      lineItems: readonly Orders.OrderLineItem[],
      runs: readonly ShopWork.Run[],
    ) => ShopWork.multiMatchItems(lineItems, runs, DETAILS, TEAMS).length;
    strictEqual(multiMatchItems([lineItem("a", ["w1", "w2"])], []), 1, "two matches and no run");
    strictEqual(multiMatchItems([lineItem("a", ["w1"])], []), 0, "one match is not a decision");
    strictEqual(multiMatchItems([lineItem("a", ["w1", "w2"], 0)], []), 0, "nothing left to make");
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

  it("a match needs an eligible workflow: an inactive workflow or one with an unassigned task is not a match", () => {
    const details = [detailOf("w1"), detailOf("w2", "inactive"), detailOf("w3", "active", null)];
    strictEqual(
      ShopWork.multiMatchItems([lineItem("a", ["w1", "w2", "w3"])], [], details, TEAMS).length,
      0,
    );
    deepStrictEqual(
      ShopWork.matchedWorkflows(lineItem("a", ["w1", "w2", "w3"]), details, TEAMS).map(
        ({ workflow }) => workflow.tag,
      ),
      ["w1"],
    );
  });
});

/** A stored `tasks` document of `[id, step]` pairs, every other field fixed. */
const stored = (...tasks: readonly (readonly [id: string, step: number])[]): string =>
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
  const decode = Schema.decodeUnknownOption(ShopWork.WorkflowTasks);

  it("fills position from the index and drops it again on encode", () => {
    const tasks = Schema.decodeUnknownSync(ShopWork.WorkflowTasks)(
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
      Schema.encodeSync(ShopWork.WorkflowTasks)(tasks),
      stored(["a", 1], ["b", 1], ["c", 2]),
    );
  });

  it("refuses a gap, a decrease, a duplicate id and a list past maxTasks", () => {
    strictEqual(decode(stored(["a", 1], ["b", 3]))._tag, "None", "a gap");
    strictEqual(decode(stored(["a", 1], ["b", 2], ["c", 1]))._tag, "None", "a decrease");
    strictEqual(decode(stored(["a", 2]))._tag, "None", "not from 1");
    strictEqual(decode(stored(["a", 1], ["a", 2]))._tag, "None", "a duplicate id");
    const full = Array.from(
      { length: Platform.WorkflowLimits.maxTasks + 1 },
      (_, index) => [`t${String(index)}`, index + 1] as const,
    );
    strictEqual(decode(stored(...full))._tag, "None", "past maxTasks");
    strictEqual(decode(stored(...full.slice(0, Platform.WorkflowLimits.maxTasks)))._tag, "Some");
  });
});

/** A workflow as the Workflow select names it, id and name both `tag`. */
const nameRow = (tag: string): ShopWork.WorkflowNameRow => ({
  id: Schema.decodeUnknownSync(ShopWork.WorkflowId)(tag),
  name: Schema.decodeUnknownSync(ShopWork.WorkflowName)(tag),
});

describe("Domain.lineItemState options", () => {
  it("options are the item's matches, then the order's other matches, then the other workflows, each once", () => {
    const state = ShopWork.lineItemState(
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
    const decode = Schema.decodeUnknownOption(ShopWork.TaskInstructions);
    strictEqual(decode("x".repeat(ShopWork.TASK_INSTRUCTIONS_MAX_LENGTH))._tag, "Some");
    strictEqual(decode("x".repeat(ShopWork.TASK_INSTRUCTIONS_MAX_LENGTH + 1))._tag, "None");
  });
});

describe("Domain.matchesTag", () => {
  it("a product tag matches the workflow's tag exactly: case and surrounding space make another tag", () => {
    const detail = detailOf("engraving");
    strictEqual(ShopWork.matchesTag(detail, lineItem("a", ["engraving"])), true);
    strictEqual(ShopWork.matchesTag(detail, lineItem("a", ["Engraving"])), false);
    strictEqual(ShopWork.matchesTag(detail, lineItem("a", [" engraving "])), false);
    strictEqual(Schema.decodeUnknownSync(ShopWork.WorkflowTag)(" Engraving "), "Engraving");
  });
});

/**
 * The copy is the contract between the order page, the Done or closed view and the
 * workflow page, which all read the reason from one function
 * ({@link ShopWork.ClosedReason}).
 */
describe("closedReasonText", () => {
  it("each closed reason reads as one sentence, and only the merchant's own cancel depends on who reads it", () => {
    const merchant = ShopWork.ClosedReason.literals.map((reason) =>
      ShopWork.closedReasonText(reason, "merchant"),
    );
    const member = ShopWork.ClosedReason.literals.map((reason) =>
      ShopWork.closedReasonText(reason, "member"),
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
): ShopWork.RunListItem => ({
  run: {
    ...run("open", overrides.blocked ?? false),
    id: Schema.decodeUnknownSync(ShopWork.RunId)(id),
    orderName: `#${id}`,
    orderProcessedAt,
  },
  tasks: [
    {
      id: Schema.decodeUnknownSync(ShopWork.RunTaskId)(`${id}-s`),
      runId: Schema.decodeUnknownSync(ShopWork.RunId)(id),
      position: 1,
      step: 1,
      name: Schema.decodeUnknownSync(ShopWork.TaskName)("Cut"),
      teamId: Schema.decodeUnknownSync(ShopWork.TeamId)("t"),
      teamName: Schema.decodeUnknownSync(ShopWork.TeamName)("T"),
      startedAt: overrides.startedBy === undefined ? null : 1,
      startedByEmail:
        overrides.startedBy === undefined
          ? null
          : Schema.decodeUnknownSync(Platform.Email)(`${overrides.startedBy}@example.com`),
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
): Pick<ShopWork.RunListTask, "startedAt" | "startedByEmail" | "startedByRole"> => {
  if (startedBy === undefined)
    return { startedAt: null, startedByEmail: null, startedByRole: null };
  if (startedBy === "?") return { startedAt: 1, startedByEmail: null, startedByRole: null };
  if (startedBy === "merchant")
    return { startedAt: 1, startedByEmail: null, startedByRole: "merchant" };
  return {
    startedAt: 1,
    startedByEmail: Schema.decodeUnknownSync(Platform.Email)(`${startedBy}@example.com`),
    startedByRole: "member",
  };
};

const withTasks = (
  tasks: readonly (readonly [name: string, team: string, startedBy?: string])[],
  block: { readonly reason: string | null } | null = null,
): ShopWork.RunListItem => {
  const item = runListItem("1", 0, { blocked: block !== null });
  const [base] = item.tasks;
  const [first, ...rest] = tasks.map(([name, team, startedBy], index) => ({
    ...base,
    id: Schema.decodeUnknownSync(ShopWork.RunTaskId)(`t${String(index)}`),
    position: index + 2,
    step: 2,
    name: Schema.decodeUnknownSync(ShopWork.TaskName)(name),
    teamName: Schema.decodeUnknownSync(ShopWork.TeamName)(team),
    ...starterOf(startedBy),
  }));
  if (first === undefined) throw new Error("withTasks: no tasks");
  return {
    ...item,
    run: {
      ...item.run,
      workflowName: Schema.decodeUnknownSync(ShopWork.WorkflowName)("Signet ring"),
      blockReason:
        block?.reason === null || block === null
          ? null
          : Schema.decodeUnknownSync(ShopWork.BlockReason)(block.reason),
    },
    tasks: [first, ...rest],
    stepCount: 3,
  };
};

const ME = Schema.decodeUnknownSync(Platform.Email)("me@example.com");

/** The task lines as the row prints them: `Name (Team) · State`. */
const taskLines = (
  item: ShopWork.RunListItem,
  showTeam: boolean,
  state: ShopWork.WorkflowsListState | null,
) =>
  ShopWork.runRowLines(item, { memberEmail: ME, showTeam, state }).tasks.map(
    (task) =>
      `${task.name}${task.team === null ? "" : ` (${task.team})`}${task.state === null ? "" : ` · ${task.state}`}`,
  );

const blockOf = (item: ShopWork.RunListItem, state: ShopWork.WorkflowsListState | null) =>
  ShopWork.runRowLines(item, { memberEmail: ME, showTeam: false, state }).block;

describe("Domain.actorLabel", () => {
  it("the merchant sees their own work as you, a member sees it as Merchant", () => {
    const merchant: ShopWork.ActorDisplay = { role: "merchant" };
    const member: ShopWork.ActorDisplay = {
      role: "member",
      email: Schema.decodeUnknownSync(Platform.Email)("ana@example.com"),
    };
    strictEqual(ShopWork.actorLabel(merchant, "merchant"), "You");
    strictEqual(ShopWork.actorLabel(merchant, "member"), "Merchant");
    strictEqual(ShopWork.actorLabel(member, "merchant"), "ana@example.com");
    strictEqual(ShopWork.actorLabel(member, "member"), "ana@example.com");
  });
});

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
    deepStrictEqual(taskLines(one, true, "ready"), ["Stamp monogram (Engraving)"]);
    deepStrictEqual(taskLines(shared, false, "ready"), ["Stamp monogram", "Engrave initials"]);
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
    deepStrictEqual(taskLines(merchant, false, "started_by_others"), ["Cut · Started by Merchant"]);
    deepStrictEqual(taskLines(unknown, false, "started_by_others"), ["Cut · Started"]);
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

  it("the recipe line is step k of n, after the workflow name when it differs from the item, on every open row whatever its state", () => {
    const recipe = (item: ShopWork.RunListItem) =>
      ShopWork.runRowLines(item, {
        memberEmail: ME,
        showTeam: false,
        state: null,
      }).recipe;
    const joined = (item: ShopWork.RunListItem) => {
      const { workflow, step } = recipe(item);
      return workflow === null ? step : `${workflow} · ${step}`;
    };
    strictEqual(joined(withTasks([["Cut", "Cutting"]])), "Signet ring · Step 2 of 3");
    strictEqual(
      joined(withTasks([["Cut", "Cutting"]], { reason: "x" })),
      "Signet ring · Step 2 of 3",
    );
  });
});

const namesItem = (workflowName: string, lineItemTitle: string) =>
  ShopWork.workflowNamesItem({ workflowName, lineItemTitle });

describe("Domain.workflowNamesItem", () => {
  it("the workflow name is on the row only when it differs from the item title", () => {
    const recipe = (workflowName: string) => {
      const item = withTasks([["Cut", "Cutting"]]);
      return ShopWork.runRowLines(
        {
          ...item,
          run: {
            ...item.run,
            workflowName: Schema.decodeUnknownSync(ShopWork.WorkflowName)(workflowName),
          },
        },
        { memberEmail: ME, showTeam: false, state: null },
      ).recipe;
    };
    deepStrictEqual(recipe("Ring"), { workflow: null, step: "Step 2 of 3" });
    deepStrictEqual(recipe("Signet ring, rush"), {
      workflow: "Signet ring, rush",
      step: "Step 2 of 3",
    });
  });

  it("the comparison ignores case and surrounding spaces", () => {
    strictEqual(namesItem(" signet RING ", "Signet ring"), true);
    strictEqual(namesItem("Signet ring", "  signet ring"), true);
    strictEqual(namesItem("Signet  ring", "Signet ring"), false);
    strictEqual(namesItem("Signet ring · Gold", "Signet ring"), false);
  });
});

describe("Domain.rowShowsTeam", () => {
  const TEAM = Schema.decodeUnknownSync(ShopWork.TeamId)("t");
  const Q = Schema.decodeUnknownSync(ShopWork.ListSearch)("ring");
  it("a row names its team when the member is on more than one team and the list is not narrowed to one, or the list is a search", () => {
    strictEqual(ShopWork.rowShowsTeam(1, null, null), false);
    strictEqual(ShopWork.rowShowsTeam(1, null, Q), false);
    strictEqual(ShopWork.rowShowsTeam(2, null, null), true);
    strictEqual(ShopWork.rowShowsTeam(2, TEAM, null), false);
    strictEqual(ShopWork.rowShowsTeam(2, TEAM, Q), true);
  });
});

const item = (variantTitle: string | null, quantity: number) => ({
  lineItemTitle: "Signet ring",
  variantTitle,
  quantity,
});

describe("Domain.itemTitle", () => {
  it("line one is the item title, then the variant, then ×n when there is more than one to make", () => {
    strictEqual(ShopWork.itemTitle(item(null, 1)), "Signet ring");
    strictEqual(ShopWork.itemTitle(item("Gold", 1)), "Signet ring · Gold");
    strictEqual(ShopWork.itemTitle(item("Gold", 2)), "Signet ring · Gold ×2");
    strictEqual(ShopWork.itemTitle(item(null, 1200)), "Signet ring ×1,200");
  });
});

const runIds = (items: readonly ShopWork.RunListItem[]) =>
  items.map((item) => item.run.id).join(",");

describe("Domain.listStateOf", () => {
  it("a blocked run is in blocked; then started by you, then started by others, then ready", () => {
    strictEqual(
      ShopWork.listStateOf(runListItem("blocked-mine", 40, { blocked: true, startedBy: "me" }), ME),
      "blocked",
    );
    strictEqual(
      ShopWork.listStateOf(runListItem("mine", 20, { startedBy: "me" }), ME),
      "started_by_you",
    );
    strictEqual(
      ShopWork.listStateOf(runListItem("theirs", 5, { startedBy: "them" }), ME),
      "started_by_others",
    );
    strictEqual(ShopWork.listStateOf(runListItem("early-next", 10), ME), "ready");
  });
});

const withLine = (item: ShopWork.RunListItem, lineItemId: string) => ({
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
        ].toSorted(ShopWork.byAge),
      ),
      "z-first-line,a-same-age,b-same-age,late-next",
    );
  });
});

describe("Domain.runHasRecord", () => {
  it("a run has a record when a task is started or done, the run is blocked, or it has a note", () => {
    const idle = { startedAt: null, doneAt: null };
    const clean = { blockedAt: null, note: null };
    strictEqual(ShopWork.runHasRecord(clean, [idle, idle]), false);
    strictEqual(ShopWork.runHasRecord({ ...clean, note: "" }, [idle]), false);
    strictEqual(ShopWork.runHasRecord(clean, [{ startedAt: 1, doneAt: null }, idle]), true);
    strictEqual(ShopWork.runHasRecord(clean, [{ startedAt: 1, doneAt: 2 }, idle]), true);
    strictEqual(ShopWork.runHasRecord({ ...clean, blockedAt: 1 }, [idle]), true);
    strictEqual(ShopWork.runHasRecord({ ...clean, note: "x" }, [idle]), true);
  });
});

describe("Domain.sameRunQuery", () => {
  const query: ShopWork.RunQuery = {
    team: null,
    state: "started_by_you",
    limit: ShopWork.RUN_PAGE,
    q: null,
  };

  it("is structural, and every field counts", () => {
    strictEqual(ShopWork.sameRunQuery(query, { ...query }), true);
    strictEqual(
      ShopWork.sameRunQuery(query, {
        ...query,
        team: Schema.decodeUnknownSync(ShopWork.TeamId)("team-a"),
      }),
      false,
    );
    strictEqual(ShopWork.sameRunQuery(query, { ...query, state: "done" }), false);
    strictEqual(
      ShopWork.sameRunQuery(query, {
        ...query,
        q: Schema.decodeUnknownSync(ShopWork.ListSearch)("ring"),
      }),
      false,
    );
    strictEqual(
      ShopWork.sameRunQuery(query, {
        ...query,
        limit: ShopWork.RUN_PAGE + 1,
      }),
      false,
    );
  });
});

/** `ShopWork.searchTerm` over raw text, decoded first because the term takes a `ListSearch`. */
const search = (q: string) => ShopWork.searchTerm(Schema.decodeUnknownSync(ShopWork.ListSearch)(q));

describe("Domain.searchTerm", () => {
  const decode = Schema.decodeUnknownOption(ShopWork.ListSearch);
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
    for (const q of ["#", "##", " # ", "", "  "]) strictEqual(decode(q)._tag, "None", q);
    strictEqual(decode("#1")._tag, "Some");
  });
  it("a word prefix matches the start of a word in the title, the variant or the SKU, ASCII case folded", () => {
    const item = {
      orderName: "#1001",
      title: "Signet ring",
      variantTitle: "Rose gold",
      sku: "RING-9",
    };
    const matches = (q: string) => ShopWork.searchMatches(search(q), item);
    strictEqual(matches("sig"), true);
    strictEqual(matches("RING"), true);
    strictEqual(matches("gold"), true);
    strictEqual(matches("ring-9"), true);
    strictEqual(matches("net"), false);
    strictEqual(matches("1001"), true);
    strictEqual(matches("100"), false);
  });
  it("prefixPatterns escapes like syntax", () => {
    deepStrictEqual(ShopWork.prefixPatterns(String.raw`50%_\x`), [
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
  const decode = Schema.decodeUnknownOption(ShopWork.SeedOrdersInput);
  it("refuses `done` beside `advance`, on the order and on one item", () => {
    strictEqual(decode(seedOrdersInput({ done: true, advance: 1 }))._tag, "None");
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
    strictEqual(decode(seedOrdersInput({ advance: 2, started: true }))._tag, "Some");
  });
});

describe("Domain.SeedOrdersInput placedDaysAgo", () => {
  const decode = Schema.decodeUnknownOption(ShopWork.SeedOrdersInput);
  it("a seeded order's placedDaysAgo stays under the retention age", () => {
    const limit = Platform.ShopLimits.orderRetentionDays;
    strictEqual(decode(seedOrdersInput({ placedDaysAgo: 0 }))._tag, "Some");
    strictEqual(decode(seedOrdersInput({ placedDaysAgo: limit - 1 }))._tag, "Some");
    strictEqual(decode(seedOrdersInput({ placedDaysAgo: limit }))._tag, "None");
    strictEqual(decode(seedOrdersInput({ placedDaysAgo: -1 }))._tag, "None");
  });
});

describe("Domain.runIsOpen / Domain.runIsDone / Domain.runIsClosed", () => {
  it("open is stored as open; done is the last task's Done; closed is ended by something else", () => {
    deepStrictEqual(
      ShopWork.RunState.literals.map((state) => ShopWork.runIsOpen(run(state))),
      [true, false, false],
    );
    deepStrictEqual(
      ShopWork.RunState.literals.map((state) => ShopWork.runIsDone(run(state))),
      [false, true, false],
    );
    deepStrictEqual(
      ShopWork.RunState.literals.map((state) => ShopWork.runIsClosed(run(state))),
      [false, false, true],
    );
  });
});

/** A task's two timestamps, all `ShopWork.runIsUnstarted` reads. */
const progressOf = (startedAt: number | null, doneAt: number | null) => ({
  startedAt,
  doneAt,
});

describe("Domain.runIsUnstarted", () => {
  const task = progressOf;
  it("unstarted is no task started or done", () => {
    strictEqual(ShopWork.runIsUnstarted([task(null, null), task(null, null)]), true);
    strictEqual(ShopWork.runIsUnstarted([task(null, null), task(1, null)]), false);
    strictEqual(ShopWork.runIsUnstarted([task(null, null), task(null, 1)]), false);
    strictEqual(ShopWork.runIsUnstarted([]), true);
  });
});

const TEAM = Schema.decodeUnknownSync(ShopWork.TeamId)("t");
const OTHER_TEAM = Schema.decodeUnknownSync(ShopWork.TeamId)("u");

const taskRow = (
  overrides: Partial<
    Pick<ShopWork.RunTaskRow, "teamId" | "current" | "startedAt" | "doneAt" | "laterStepStarted">
  > = {},
): Pick<
  ShopWork.RunTaskRow,
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

const OPEN_ORDER: Orders.OrderState = {
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
};

/** The member-side action set on an open order: the rules below are about the run and the task, not the order ({@link ShopWork.taskActions}). */
const memberActions = (
  runState: Parameters<typeof ShopWork.taskActions>[2],
  task: Parameters<typeof ShopWork.taskActions>[3],
  teamIds: readonly ShopWork.TeamId[],
) =>
  ShopWork.taskActions(
    {
      role: "member",
      memberId: Schema.decodeUnknownSync(ShopWork.MemberId)("m"),
      email: Schema.decodeUnknownSync(Platform.Email)("m@example.com"),
      teamIds,
    },
    OPEN_ORDER,
    runState,
    task,
  );

describe("Domain.taskActions", () => {
  it("a done run's last task is reopenable while nothing downstream started", () => {
    deepStrictEqual(
      memberActions(run("done"), taskRow({ current: false, startedAt: 1, doneAt: 2 }), [TEAM]),
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
      memberActions(run("open", true), taskRow({ current: false, startedAt: 1, doneAt: 2 }), [
        TEAM,
      ]),
      { ...NOTHING, reopen: true },
    );
  });

  it("a task on another team offers nothing", () => {
    deepStrictEqual(memberActions(run("open"), taskRow(), [OTHER_TEAM]), NOTHING);
    deepStrictEqual(memberActions(run("open"), taskRow({ teamId: null }), [TEAM]), NOTHING);
  });

  it("Start is offered only before the task is started; Done while it is ready", () => {
    deepStrictEqual(memberActions(run("open"), taskRow(), [TEAM]), {
      start: true,
      done: true,
      putBack: false,
      reopen: false,
      assign: false,
    });
    deepStrictEqual(memberActions(run("open"), taskRow({ startedAt: 1 }), [TEAM]), {
      start: false,
      done: true,
      putBack: true,
      reopen: false,
      assign: false,
    });
    deepStrictEqual(memberActions(run("open"), taskRow({ current: false }), [TEAM]), {
      ...NOTHING,
    });
  });
});

describe("Domain.taskActions Put back", () => {
  it("Put back is offered wherever Done is, and only on a started task", () => {
    strictEqual(memberActions(run("open"), taskRow({ startedAt: 1 }), [TEAM]).putBack, true);
    strictEqual(memberActions(run("open"), taskRow(), [TEAM]).putBack, false);
    strictEqual(
      memberActions(run("open"), taskRow({ current: false, startedAt: 1 }), [TEAM]).putBack,
      false,
    );
  });

  it("a block hides Put back", () => {
    strictEqual(memberActions(run("open", true), taskRow({ startedAt: 1 }), [TEAM]).putBack, false);
  });

  it("a started task on another team offers no Put back", () => {
    strictEqual(memberActions(run("open"), taskRow({ startedAt: 1 }), [OTHER_TEAM]).putBack, false);
  });

  it("a done task offers no Put back", () => {
    strictEqual(
      memberActions(run("open"), taskRow({ current: false, startedAt: 1, doneAt: 2 }), [TEAM])
        .putBack,
      false,
    );
  });
});

describe("Domain.runIsBlocked", () => {
  it("a run is blocked exactly when a person's block stands on it", () => {
    strictEqual(ShopWork.runIsBlocked(run("open")), false);
    strictEqual(ShopWork.runIsBlocked(run("open", true)), true);
  });
});

const runTask = (position: number, step: number, done: boolean): ShopWork.RunTask => ({
  id: Schema.decodeUnknownSync(ShopWork.RunTaskId)(`s${String(position)}`),
  runId: Schema.decodeUnknownSync(ShopWork.RunId)("r"),
  position,
  step,
  name: Schema.decodeUnknownSync(ShopWork.TaskName)(`Task ${String(position)}`),
  teamId: TEAM,
  teamName: Schema.decodeUnknownSync(ShopWork.TeamName)("T"),
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
    strictEqual(ShopWork.runIsVisibleTo(tasks, [TEAM]), true);
    strictEqual(ShopWork.runIsVisibleTo(tasks, ["other"]), false);
    // An unassigned task is on nobody's list.
    strictEqual(ShopWork.runIsVisibleTo([unassigned], [TEAM]), false);
  });
});

/** `ShopWork.taskStateOf` on positional arguments, for a table of cases. */
const stateOf = (current: boolean, startedAt: number | null, doneAt: number | null) =>
  ShopWork.taskStateOf({ current, startedAt, doneAt });

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
      ShopWork.currentTasks(run("open"), tasks).map((task) => task.position),
      [2, 3],
    );
    deepStrictEqual(
      ShopWork.currentTasks(run("open"), [runTask(1, 1, false), runTask(2, 2, false)]).map(
        (task) => task.position,
      ),
      [1],
    );
  });

  it("a run that is not open has no current task", () => {
    deepStrictEqual(ShopWork.currentTasks(run("done"), [runTask(1, 1, true)]), []);
  });
});

describe("Domain.OrdersCursor", () => {
  const decode = Schema.decodeUnknownOption(ShopWork.OrdersCursor);
  it("a cursor is `<processedAt>:<id>`, so text that is not one is refused rather than read as page one", () => {
    strictEqual(decode("1700000000000:gid://shopify/Order/1")._tag, "Some");
    strictEqual(decode("nonsense")._tag, "None");
    strictEqual(decode(":gid://shopify/Order/1")._tag, "None");
    strictEqual(decode("1700000000000:")._tag, "None");
  });
});

describe("Domain.TeamName", () => {
  it("a team name is at most 32 characters, half a task name", () => {
    const decode = Schema.decodeUnknownExit(ShopWork.TeamName);
    strictEqual(ShopWork.TEAM_NAME_MAX_LENGTH, 32);
    strictEqual(ShopWork.TEAM_NAME_MAX_LENGTH * 2, ShopWork.NAME_MAX_LENGTH);
    strictEqual(decode("a".repeat(32))._tag, "Success");
    strictEqual(decode(` ${"a".repeat(32)} `)._tag, "Success");
    strictEqual(decode("a".repeat(33))._tag, "Failure");
  });
});

describe("the orders index's sync state", () => {
  it("no sync count reaches a screen: the orders index carries whether one runs and the last error", () => {
    deepStrictEqual(Object.keys(Orders.OrdersSyncStatus.fields).toSorted(), [
      "inFlight",
      "lastError",
    ]);
    strictEqual(ShopWork.OrdersIndexData.fields.syncState, Orders.OrdersSyncStatus);
  });
});

describe("Domain workflow schemas", () => {
  const name = Schema.decodeUnknownSync(ShopWork.WorkflowName);
  const tag = Schema.decodeUnknownSync(ShopWork.WorkflowTag);

  it("WorkflowTag trims and keeps case", () => {
    strictEqual(tag("  Engraving "), "Engraving");
  });

  it("WorkflowTag refuses a comma, which Shopify's tag field splits on", () => {
    strictEqual(
      Option.isNone(Schema.decodeUnknownOption(ShopWork.WorkflowTag)("cut, engrave")),
      true,
    );
  });

  it("WorkflowTag rejects blank and over-long values", () => {
    strictEqual(Option.isNone(Schema.decodeUnknownOption(ShopWork.WorkflowTag)("   ")), true);
    strictEqual(
      Option.isNone(Schema.decodeUnknownOption(ShopWork.WorkflowTag)("x".repeat(256))),
      true,
    );
  });

  it("names trim and reject empty or over-long values", () => {
    strictEqual(name("  Engrave  "), "Engrave");
    strictEqual(Option.isNone(Schema.decodeUnknownOption(ShopWork.WorkflowName)("   ")), true);
    strictEqual(Option.isNone(Schema.decodeUnknownOption(ShopWork.TaskName)("x".repeat(65))), true);
  });
});

describe("workflow callable inputs", () => {
  it("callable inputs reject excess properties", () => {
    strictEqual(
      Option.isNone(
        Schema.decodeUnknownOption(ShopWork.CreateWorkflowInput)(
          { name: "W", tag: "w", extra: 1 },
          { onExcessProperty: "error" },
        ),
      ),
      true,
    );
  });
});
