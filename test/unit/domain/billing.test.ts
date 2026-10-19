import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import {
  adminShopEntitlements,
  adminShopPlanCache,
  entitlementsOfPlan,
  membersAtCeiling,
  planOfHandle,
  provisionalCycleStart,
  seatEventValue,
  usageEventIsExpired,
} from "../../../src/domain/billing.ts";
import { ShopLimits } from "../../../src/domain/platform.ts";

describe("Domain.seatEventValue", () => {
  it("the seat event value is the member count past the cycle's high-water mark, and zero when not past it", () => {
    strictEqual(seatEventValue(4, 3), 1);
    strictEqual(seatEventValue(6, 3), 3);
    strictEqual(seatEventValue(5, 0), 5);
    strictEqual(seatEventValue(3, 3), 0);
    strictEqual(seatEventValue(2, 4), 0);
  });
});

describe("Domain.membersAtCeiling", () => {
  it("a shop is at its ceiling when the member count has reached maxMembers", () => {
    const { maxMembers } = ShopLimits;
    strictEqual(membersAtCeiling(maxMembers - 1), false);
    strictEqual(membersAtCeiling(maxMembers), true);
    strictEqual(membersAtCeiling(maxMembers + 1), true);
  });
});

describe("Domain.provisionalCycleStart", () => {
  it("the provisional cycle starts at the first instant of the UTC month, whatever the hour", () => {
    strictEqual(provisionalCycleStart(Date.UTC(2026, 9, 18, 13, 45)), Date.UTC(2026, 9, 1));
    strictEqual(provisionalCycleStart(Date.UTC(2026, 9, 1)), Date.UTC(2026, 9, 1));
    strictEqual(
      provisionalCycleStart(Date.UTC(2026, 11, 31, 23, 59, 59, 999)),
      Date.UTC(2026, 11, 1),
    );
  });
});

describe("Domain.usageEventIsExpired", () => {
  it("a usage event expires when it is dated before the cycle's start, and not at the start itself", () => {
    strictEqual(usageEventIsExpired(999, 1000), true);
    strictEqual(usageEventIsExpired(1000, 1000), false);
    strictEqual(usageEventIsExpired(1001, 1000), false);
  });
});

describe("Domain.planOfHandle", () => {
  it("each plan handle normalizes to its tier, and each tier grants its own entitlements", () => {
    strictEqual(planOfHandle("baton-basic"), "basic");
    strictEqual(planOfHandle("baton-pro"), "pro");
    deepStrictEqual(entitlementsOfPlan("basic"), { ordersPerCycle: 200, membersIncluded: 3 });
    deepStrictEqual(entitlementsOfPlan("pro"), { ordersPerCycle: 1500, membersIncluded: 10 });
  });
});

describe("Domain.adminShopPlanCache", () => {
  const NOW = 10_000;

  it("a row with no deadline and no handle was never fetched", () => {
    deepStrictEqual(adminShopPlanCache({ planHandle: null, planHandleExpiresAt: null }, NOW), {
      _tag: "NeverFetched",
    });
  });

  it("a null handle inside its deadline is a verified absence of an app subscription", () => {
    const cache = adminShopPlanCache({ planHandle: null, planHandleExpiresAt: NOW + 1 }, NOW);
    deepStrictEqual(cache, { _tag: "Unsubscribed" });
    strictEqual(adminShopEntitlements(cache), null);
  });

  it("an allowlisted handle inside its deadline is subscribed and grants its tier", () => {
    const cache = adminShopPlanCache(
      { planHandle: "baton-pro", planHandleExpiresAt: NOW + 1 },
      NOW,
    );
    deepStrictEqual(cache, { _tag: "Subscribed", handle: "baton-pro", plan: "pro" });
    deepStrictEqual(adminShopEntitlements(cache), entitlementsOfPlan("pro"));
  });

  it("a past deadline, or a handle with no deadline, is stale and grants nothing whatever the handle", () => {
    const past = adminShopPlanCache({ planHandle: "baton-pro", planHandleExpiresAt: NOW }, NOW);
    deepStrictEqual(past, { _tag: "Stale", handle: "baton-pro" });
    strictEqual(adminShopEntitlements(past), null);
    deepStrictEqual(
      adminShopPlanCache({ planHandle: "baton-basic", planHandleExpiresAt: null }, NOW),
      { _tag: "Stale", handle: "baton-basic" },
    );
  });

  it("a handle outside the allowlist inside its deadline is unrecognized and keeps the stored string", () => {
    const cache = adminShopPlanCache(
      { planHandle: "baton-enterprise", planHandleExpiresAt: NOW + 1 },
      NOW,
    );
    deepStrictEqual(cache, { _tag: "Unrecognized", handle: "baton-enterprise" });
    strictEqual(adminShopEntitlements(cache), null);
  });
});
