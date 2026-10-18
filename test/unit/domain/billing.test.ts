import { describe, it } from "@effect/vitest";
import { strictEqual } from "@effect/vitest/utils";
import { membersAtCeiling } from "../../../src/domain/billing.ts";
import { ShopLimits } from "../../../src/domain/platform.ts";

describe("Domain.membersAtCeiling", () => {
  it("a shop is at its ceiling when the member count has reached maxMembers", () => {
    const { maxMembers } = ShopLimits;
    strictEqual(membersAtCeiling(maxMembers - 1), false);
    strictEqual(membersAtCeiling(maxMembers), true);
    strictEqual(membersAtCeiling(maxMembers + 1), true);
  });
});
