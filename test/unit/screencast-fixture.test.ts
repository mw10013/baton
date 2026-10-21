import { assert, describe, it } from "@effect/vitest";

import {
  SCREENCAST_ORDER,
  SCREENCAST_TAG,
  SCREENCAST_WORKFLOW,
  screencastFixture,
} from "../../screencast-fixture.ts";
import { missingOrders } from "../../scripts/lib/stores.ts";
import { suggestedTag } from "../../src/web/components/workflow-shared.ts";

describe("screencastFixture", () => {
  it("leaves Baton empty and the store one product", () => {
    const { products, storeOrders, members, teams, workflows, orders } = screencastFixture;
    assert.deepStrictEqual(
      [
        products.length,
        storeOrders.length,
        members.length,
        teams.length,
        workflows.length,
        orders.length,
      ],
      [1, 0, 0, 0, 0, 0],
    );
  });

  it("tags the product with the tag Create workflow suggests for the take's name", () => {
    assert.strictEqual(SCREENCAST_TAG, suggestedTag(SCREENCAST_WORKFLOW));
    assert.deepStrictEqual(screencastFixture.products[0]?.tags, [SCREENCAST_TAG]);
  });

  it("orders a variant the product has", () => {
    const [product] = screencastFixture.products;
    for (const line of SCREENCAST_ORDER.lines) {
      assert.strictEqual(line.handle, product?.handle);
      assert.isTrue(product?.variants.some(({ value }) => value === line.value));
    }
  });
});

describe("missingOrders", () => {
  const order = (tags: readonly string[], cancelledAt: string | null = null) => ({
    id: "gid://shopify/Order/1",
    name: "#1001",
    tags,
    cancelledAt,
  });

  it("names the table's orders with no open order carrying their tag", () => {
    const wanted = [
      { tag: "seed-a", lines: [] },
      { tag: "seed-b", lines: [] },
    ];
    assert.deepStrictEqual(
      missingOrders([order(["seed", "seed-a"]), order(["seed", "seed-b"], "2026-10-21")], wanted),
      [wanted[1]],
    );
  });

  it("finds nothing missing from an empty table", () => {
    assert.deepStrictEqual(missingOrders([order(["seed", "seed-a"])], []), []);
  });
});
