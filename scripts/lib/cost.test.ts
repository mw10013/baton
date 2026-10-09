import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cost,
  DEFAULT_SHOP,
  PRESETS,
  shopOfPreset,
  storageBytes,
} from "./cost.ts";

void test("every line is marginal: a shop with nothing moving costs only the sweep's reads", () => {
  const report = cost({
    ...DEFAULT_SHOP,
    members: 0,
    merchants: 0,
    openOrders: 0,
    newOrdersPerMonth: 0,
  });
  assert.ok(report.totalUsd < 0.001);
  assert.equal(report.publishesPerMonth, 0);
});

void test("the total is the sum of its lines", () => {
  const report = cost(DEFAULT_SHOP);
  const sum = report.lines.reduce((acc, l) => acc + l.usd, 0);
  assert.ok(Math.abs(sum - report.totalUsd) < 1e-9);
});

void test("a member costs more than nothing and less than a dollar at every preset", () => {
  for (const name of Object.keys(PRESETS)) {
    const report = cost(shopOfPreset(name));
    assert.ok(report.marginalMemberUsd > 0, name);
    assert.ok(report.marginalMemberUsd < 1, name);
  }
});

void test("cost and load rise monotonically up the preset ladder", () => {
  const order = ["solo", "small", "medium", "large", "ceiling", "stress"];
  const reports = order.map((name) => cost(shopOfPreset(name)));
  for (let i = 1; i < reports.length; i++) {
    assert.ok(reports[i].totalUsd > reports[i - 1].totalUsd, order[i]);
    assert.ok(
      reports[i].peakObjectBusyShare >= reports[i - 1].peakObjectBusyShare,
      order[i],
    );
  }
});

void test("storage holds a year of orders and stays far under the 10 GB object limit at the ceiling", () => {
  const ceiling = shopOfPreset("ceiling");
  const bytes = storageBytes(ceiling);
  assert.ok(bytes > 100e6);
  assert.ok(bytes < 1e9);
  assert.ok(cost(ceiling).storageShare < 0.1);
});
