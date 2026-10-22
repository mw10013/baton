import { assert, describe, it } from "@effect/vitest";

import { ALT_LIMIT, LISTING_SHOTS } from "../../../../scripts/lib/listing-screenshots.ts";

describe("LISTING_SHOTS", () => {
  it("keeps every alt text within the listing form's limit", () => {
    for (const { id, alt } of LISTING_SHOTS) {
      assert.isAtMost([...alt].length, ALT_LIMIT, id);
      assert.isAbove(alt.length, 0, id);
    }
  });

  it("has unique ids, files and alt texts", () => {
    for (const key of ["id", "file", "alt"] as const)
      assert.strictEqual(
        new Set(LISTING_SHOTS.map((shot) => shot[key])).size,
        LISTING_SHOTS.length,
      );
  });

  it("has between three and six desktop shots", () => {
    const desktop = LISTING_SHOTS.filter(({ kind }) => kind === "desktop").length;
    assert.isAtLeast(desktop, 3);
    assert.isAtMost(desktop, 6);
  });
});
