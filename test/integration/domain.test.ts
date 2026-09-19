import { strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import { flagBody, flagHeading, flagTone } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { groupUsedBy } from "@/lib/usedBy";

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
  tags: [],
  note: null,
  customAttributes: [],
  lineItemsComplete: true,
  lineItemsTruncated: false,
  syncedAt: 0,
  syncSource: "webhook",
  ...overrides,
});

/** `Partial` runs: `productionState` reads only `open` and `done`, so a case spells out just the counters it turns on. */
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
    ["paid, no runs", row(NONE), "no_workflow"],
    ["unpaid, no runs", row(NONE, { fullyPaid: false }), null],
    ["open runs", row({ open: 1, done: 1, flagged: 0 }), "in_production"],
    [
      "paid, one ambiguous item, no runs",
      row(NONE, {}, 1),
      "multiple_workflows",
    ],
    [
      "ambiguous outranks in_production: one item chosen, another waiting",
      row({ open: 1, done: 0, flagged: 0 }, {}, 1),
      "multiple_workflows",
    ],
    [
      "ambiguous outranks ready_to_ship",
      row({ open: 0, done: 2, flagged: 0 }, {}, 1),
      "multiple_workflows",
    ],
    [
      "unpaid cannot start, so an ambiguity is not yet a decision",
      row(NONE, { fullyPaid: false }, 1),
      null,
    ],
    [
      "fulfilled outranks ambiguous",
      row(NONE, { fulfillmentStatus: "FULFILLED" }, 1),
      "shipped",
    ],
    [
      "cancelled outranks ambiguous",
      row(NONE, { cancelledAt: 1 }, 1),
      "cancelled",
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
  unfulfilledQuantity = 1,
): Domain.OrderLineItem => ({
  id,
  orderId: "o",
  productId: null,
  variantId: null,
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  unfulfilledQuantity,
  nonFulfillableQuantity: 0,
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

const ownedStep = (
  workflowId: string,
  workflowName: string,
  side: "workflow" | "draft",
  stepName: string,
): Domain.OwnedStep => ({
  workflowId: Schema.decodeUnknownSync(Domain.WorkflowId)(workflowId),
  workflowName: Schema.decodeUnknownSync(Domain.WorkflowName)(workflowName),
  workflowTag: Schema.decodeUnknownSync(Domain.WorkflowTag)(
    workflowName.toLowerCase(),
  ),
  side,
  stepName: Schema.decodeUnknownSync(Domain.StepName)(stepName),
});

describe("groupUsedBy", () => {
  it("groups steps by workflow, sorted by name, draft-only when no live step", () => {
    const grouped = groupUsedBy([
      ownedStep("w2", "pendant", "draft", "Cast"),
      ownedStep("w1", "Ring", "workflow", "Engrave"),
      ownedStep("w1", "Ring", "draft", "Engrave"),
      ownedStep("w2", "pendant", "draft", "Polish"),
    ]);
    strictEqual(
      grouped
        .map(
          (w) =>
            `${w.workflowName}:${w.workflowTag}:${w.draftOnly ? "draft" : "live"}:${w.href}`,
        )
        .join("|"),
      "pendant:pendant:draft:/app/workflows/w2|Ring:ring:live:/app/workflows/w1",
    );
    strictEqual(groupUsedBy([]).length, 0);
  });
});

/**
 * One fact, once: the heading names the flag and the body carries only the
 * detail, so no body repeats its own heading and two of them are empty. The
 * table is here rather than in a route test because the copy is the contract
 * between the queue card and the work page, which share one banner.
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
      "Removed, refunded, or shipped in Shopify.",
      "warning",
    ],
    ["order_cancelled", "Order cancelled", null, "critical"],
    ["order_deleted", "Order deleted", null, "critical"],
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
    const reason = Schema.decodeUnknownSync(Domain.StepNote)(
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

const queueItem = (
  id: string,
  orderProcessedAt: number,
  overrides: {
    readonly flag?: Domain.RunFlag;
    readonly startedBy?: string;
    /** Defaults to `<startedBy>@example.com`; name it to make the id and the email disagree. */
    readonly startedByEmail?: string;
  } = {},
): Domain.QueueItem => ({
  run: {
    ...run("active", overrides.flag ?? null),
    id: Schema.decodeUnknownSync(Domain.WorkflowRunId)(id),
    orderName: `#${id}`,
    orderProcessedAt,
  },
  steps: [
    {
      id: Schema.decodeUnknownSync(Domain.WorkflowRunStepId)(`${id}-s`),
      runId: Schema.decodeUnknownSync(Domain.WorkflowRunId)(id),
      position: 1,
      stage: 1,
      name: Schema.decodeUnknownSync(Domain.StepName)("Cut"),
      teamId: Schema.decodeUnknownSync(Domain.TeamId)("t"),
      teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
      instructions: null,
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
      completedAt: null,
      completedBy: null,
      completedByEmail: null,
      note: null,
      startedByRole: overrides.startedBy === undefined ? null : "member",
      completedByRole: null,
      reopenedAt: null,
      reopenedByRole: null,
      reopenedByEmail: null,
      noteByRole: null,
      siblings: [],
    },
  ],
  stageCount: 1,
  note: null,
});

const runIds = (items: readonly Domain.QueueItem[]) =>
  items.map((item) => item.run.id).join(",");

const ME = Schema.decodeUnknownSync(Domain.Email)("me@example.com");

describe("Domain.tierOf", () => {
  it("a flag first, then mine, then a teammate's, then untouched", () => {
    strictEqual(
      Domain.tierOf(
        queueItem("flagged-mine", 40, { flag: "blocked", startedBy: "me" }),
        ME,
      ),
      "attention",
    );
    strictEqual(
      Domain.tierOf(queueItem("mine", 20, { startedBy: "me" }), ME),
      "mine",
    );
    strictEqual(
      Domain.tierOf(queueItem("theirs", 5, { startedBy: "them" }), ME),
      "inProgress",
    );
    strictEqual(Domain.tierOf(queueItem("early-next", 10), ME), "upNext");
  });

  /**
   * The re-added member: removing and re-adding an address mints a new
   * `Member.id`, so the row taken before that carries an id the connection no
   * longer has. The email is the snapshot that survives, and the work is still
   * theirs.
   */
  it("keeps a step under Mine when the id changed but the email did not", () => {
    strictEqual(
      Domain.tierOf(
        queueItem("re-added", 20, {
          startedBy: "old-id",
          startedByEmail: "me@example.com",
        }),
        ME,
      ),
      "mine",
    );
    strictEqual(
      Domain.tierOf(queueItem("someone-else", 10, { startedBy: "them" }), ME),
      "inProgress",
    );
  });
});

const withLine = (item: Domain.QueueItem, lineItemId: string) => ({
  ...item,
  run: { ...item.run, lineItemId },
});

describe("Domain.byAge", () => {
  it("oldest order first, then line item, then run id", () => {
    strictEqual(
      runIds(
        [
          queueItem("late-next", 30),
          withLine(queueItem("b-same-age", 10), "line-2"),
          withLine(queueItem("z-first-line", 10), "line-1"),
          withLine(queueItem("a-same-age", 10), "line-2"),
        ].toSorted(Domain.byAge),
      ),
      "z-first-line,a-same-age,b-same-age,late-next",
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
              tags: [],
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
