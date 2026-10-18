import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../../../src/contract/shop.ts";
import { memberLanding } from "../../../../src/web/client/session.ts";

const shop = Schema.decodeUnknownSync(ShopKey);

describe("login-callback", () => {
  it("sends a one-shop member to their workflows list and a two-shop member to /shop", () => {
    const one = shop("one.myshopify.com");
    assert.strictEqual(memberLanding([one]), "/shop/one.myshopify.com/workflows");
    assert.strictEqual(memberLanding([one, shop("two.myshopify.com")]), "/shop");
    assert.strictEqual(memberLanding([]), "/shop");
  });
});
