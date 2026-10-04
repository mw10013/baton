import { describe, expect, it } from "vitest";

import { instrumentationIsOn } from "@/lib/CloudflareEnv";

describe("instrumentation", () => {
  it("instrumentationIsOn is on for local and staging and off for production", () => {
    expect(instrumentationIsOn("local")).toBe(true);
    expect(instrumentationIsOn("staging")).toBe(true);
    expect(instrumentationIsOn("production")).toBe(false);
  });
});
