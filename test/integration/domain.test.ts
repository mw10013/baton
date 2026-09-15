import { strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { tierQueue } from "@/lib/queueTiers";
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
  syncedAt: 0,
  syncSource: "webhook",
  ...overrides,
});

/** `Partial` runs: `productionState` reads only `open` and `done`, so a case spells out just the counters it turns on. */
const row = (
  runs: Partial<Domain.RunCounts>,
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.OrderRow => ({
  order: order(overrides),
  itemUnits: 1,
  runs: { ...NONE, ...runs },
  attention: false,
  waitingOn: [],
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
  lineItemId: null,
  lineItemTitle: null,
  variantTitle: null,
  sku: null,
  quantity: null,
  customAttributes: null,
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
      run("done", "item_added"),
      run("cancelled", "order_cancelled"),
    ]);
    strictEqual(counts.open, 3);
    strictEqual(counts.done, 1);
    strictEqual(counts.flagged, 1);
    strictEqual(counts.blocked, 1);
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
      ownedStep(Domain.ORDER_WORKFLOW_ID, "Order workflow", "workflow", "Pack"),
    ]);
    strictEqual(
      grouped
        .map(
          (w) =>
            `${w.workflowName}:${w.draftOnly ? "draft" : "live"}:${w.href}`,
        )
        .join("|"),
      "Order workflow:live:/app/order-workflow|pendant:draft:/app/workflows/w2|Ring:live:/app/workflows/w1",
    );
    strictEqual(groupUsedBy([]).length, 0);
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
  items: [],
});

const runIds = (items: readonly Domain.QueueItem[]) =>
  items.map((item) => item.run.id).join(",");

const ME = Schema.decodeUnknownSync(Domain.Email)("me@example.com");

describe("tierQueue", () => {
  it("flag first, then mine, then a teammate's, then untouched; oldest order first within a tier", () => {
    const tiers = tierQueue(
      [
        queueItem("late-next", 30),
        queueItem("mine", 20, { startedBy: "me" }),
        queueItem("early-next", 10),
        queueItem("theirs", 5, { startedBy: "them" }),
        queueItem("flagged-mine", 40, { flag: "blocked", startedBy: "me" }),
      ],
      ME,
    );
    strictEqual(runIds(tiers.attention), "flagged-mine");
    strictEqual(runIds(tiers.mine), "mine");
    strictEqual(runIds(tiers.inProgress), "theirs");
    strictEqual(runIds(tiers.upNext), "early-next,late-next");
  });

  /**
   * The re-added member: removing and re-adding an address mints a new
   * `Member.id`, so the row taken before that carries an id the connection no
   * longer has. The email is the snapshot that survives, and the work is still
   * theirs.
   */
  it("keeps a step under Mine when the id changed but the email did not", () => {
    const tiers = tierQueue(
      [
        queueItem("re-added", 20, {
          startedBy: "old-id",
          startedByEmail: "me@example.com",
        }),
        queueItem("someone-else", 10, { startedBy: "them" }),
      ],
      ME,
    );
    strictEqual(runIds(tiers.mine), "re-added");
    strictEqual(runIds(tiers.inProgress), "someone-else");
  });
});
