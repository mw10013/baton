import { strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";

const order = (
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.ShopOrder => ({
  id: "gid://shopify/Order/1",
  legacyId: "1",
  name: "#1001",
  createdAt: 0,
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

const row = (
  runs: Domain.RunCounts,
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.OrderRow => ({ order: order(overrides), itemUnits: 1, runs });

const NONE = { open: 0, done: 0, flagged: 0 };

describe("Domain.productionState", () => {
  const cases: readonly [
    string,
    Domain.OrderRow,
    Domain.ProductionState | null,
  ][] = [
    ["paid, no runs", row(NONE), "not_routed"],
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
      "fulfilled, no runs",
      row(NONE, { fulfillmentStatus: "FULFILLED" }),
      "not_routed",
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
  it("counts open, done, and flagged-open the way the index SQL does", () => {
    const counts = Domain.runCounts([
      run("pending", null),
      run("active", "blocked"),
      run("done", "item_added"),
      run("cancelled", "order_cancelled"),
    ]);
    strictEqual(counts.open, 2);
    strictEqual(counts.done, 1);
    strictEqual(counts.flagged, 1);
  });
});
