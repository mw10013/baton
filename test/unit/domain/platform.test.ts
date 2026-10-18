import { describe, it } from "@effect/vitest";
import { strictEqual } from "@effect/vitest/utils";
import * as Schema from "effect/Schema";
import {
  BoundedId,
  formatKilobytes,
  formatNumber,
  formatStatus,
  retentionCutoff,
  ShopLimits,
  userIsAdmin,
} from "../../../src/domain/platform.ts";

describe("formatStatus", () => {
  it("prints a Shopify status enum as the admin does", () => {
    strictEqual(formatStatus("PARTIALLY_REFUNDED"), "Partially refunded");
    strictEqual(formatStatus("PAID"), "Paid");
  });
});

describe("formatNumber", () => {
  it("groups digits the en-US way and prints no fraction", () => {
    strictEqual(formatNumber(0), "0");
    strictEqual(formatNumber(1200), "1,200");
    strictEqual(formatNumber(1_234_567), "1,234,567");
    strictEqual(formatNumber(2.4), "2");
    strictEqual(formatNumber(2.6), "3");
  });
});

describe("formatKilobytes", () => {
  it("prints whole kilobytes of 1,024 bytes", () => {
    strictEqual(formatKilobytes(ShopLimits.maxPropertiesBytesPerItem), "8 KB");
    strictEqual(formatKilobytes(1024), "1 KB");
    strictEqual(formatKilobytes(1024 * 1200), "1,200 KB");
  });
});

describe("retentionCutoff", () => {
  it("is the retention window in days before now", () => {
    const now = Date.UTC(2026, 9, 17);
    strictEqual(retentionCutoff(now), now - 365 * 86_400_000);
    strictEqual(retentionCutoff(now), Date.UTC(2025, 9, 17));
  });
});

describe("userIsAdmin", () => {
  it("only the admin role is an admin", () => {
    strictEqual(userIsAdmin({ role: "admin" }), true);
    strictEqual(userIsAdmin({ role: "user" }), false);
    strictEqual(userIsAdmin({ role: null }), false);
    strictEqual(userIsAdmin({}), false);
  });
});

describe("BoundedId", () => {
  it("an id is non-empty and at most 128 characters", () => {
    const decode = Schema.decodeUnknownExit(BoundedId);
    strictEqual(decode("a")._tag, "Success");
    strictEqual(decode("a".repeat(128))._tag, "Success");
    strictEqual(decode("")._tag, "Failure");
    strictEqual(decode("a".repeat(129))._tag, "Failure");
  });
});
