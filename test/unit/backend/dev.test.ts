import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../../src/contract/auth.ts";
import { DevRpcs } from "../../../src/contract/dev.ts";
import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { ShopKey } from "../../../src/contract/shop.ts";
import { SEED_SHOP } from "../../seed-shops.ts";
import { DevHandlers } from "../../../src/backend/dev.ts";
import { type ActorFixtureRows, Fixtures } from "../../../src/backend/fixture.ts";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { type MemberRow, QuietLogs, testMembershipRepository, testShopify } from "./layers.ts";

const email = Schema.decodeUnknownSync(EmailFromInput);
const decodeFixture = Schema.decodeUnknownSync(ShopFixtureData);
/** A fixture with only the parts named; the rest empty. */
const fixture = (parts: object) =>
  decodeFixture({ members: [], teams: [], workflows: [], orders: [], ...parts });

const member = email("m1@m.com");
const otherShop = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
const session: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_orders,read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};
const members: ReadonlyArray<MemberRow> = [
  { id: "mem-1", shop: SEED_SHOP, email: member, createdAt: 1 },
];

/**
 * {@link DevHandlers} over in-memory members, sessions and actors, fresh per test. `revoked`,
 * `added` and `removedOrders` record what the handlers asked of the actors.
 */
const harness = () => {
  const revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }> = [];
  const added: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [];
  const removedOrders: Array<{ key: ShopKey; orderId: string }> = [];
  const layer = DevHandlers.pipe(
    Layer.provideMerge(Fixtures.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        testMembershipRepository(members),
        ShopActors.layerTest(revoked, [], added, removedOrders),
        testShopify([session]),
      ),
    ),
    Layer.provide(RuntimeContext.phantom),
    Layer.provide(QuietLogs),
  );
  return { revoked, added, removedOrders, layer };
};

describe("DevRpcs", () => {
  it.live("RemoveMember removes a member once and revokes", () => {
    const { revoked, layer } = harness();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const removed = yield* client.RemoveMember({ shop: SEED_SHOP, email: member });
      assert.isTrue(removed.removed);
      assert.deepStrictEqual(revoked, [{ key: SEED_SHOP, by: "member", id: "mem-1" }]);
      const gone = yield* client.RemoveMember({ shop: SEED_SHOP, email: member });
      assert.isFalse(gone.removed);
      assert.strictEqual(revoked.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("RemoveOrder removes the order from an installed shop's actor, and from no other", () => {
    const { removedOrders, layer } = harness();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const orderId = "gid://shopify/Order/1";
      assert.deepStrictEqual(yield* client.RemoveOrder({ shop: SEED_SHOP, orderId }), {
        removed: true,
      });
      const error = yield* client.RemoveOrder({ shop: otherShop, orderId }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ShopNotInstalled");
      assert.deepStrictEqual(removedOrders, [{ key: SEED_SHOP, orderId }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("GetShopSession returns the non-secret fields, or null for a shop without one", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const found = yield* client.GetShopSession({ shop: SEED_SHOP });
      assert.deepStrictEqual(found, {
        shopGid: "gid://shopify/Shop/1",
        scope: "read_orders,read_products",
        accessTokenExpiresAt: 1_900_000_000_000,
        refreshTokenExpiresAt: 1_900_000_000_000,
        refreshLeaseUntil: null,
      });
      assert.notInclude(JSON.stringify(found), "secret");
      assert.isNull(yield* client.GetShopSession({ shop: otherShop }));
    }).pipe(Effect.provide(harness().layer)),
  );

  it.live("ExpireShopSession ages the token; invalidate also replaces the refresh token", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const before = Date.now();
      yield* client.ExpireShopSession({ shop: SEED_SHOP, refreshToken: "keep" });
      const kept = yield* client.GetShopSession({ shop: SEED_SHOP });
      assert.isBelow(kept?.accessTokenExpiresAt ?? Infinity, before);
      assert.strictEqual(kept?.refreshTokenExpiresAt, 1_900_000_000_000);
      const sessions = yield* ShopSessionRepository;
      const row = (yield* sessions.find(SEED_SHOP)).pipe(Option.getOrThrow);
      assert.strictEqual(row.refreshToken, "shprt_secret_refresh");
      yield* client.ExpireShopSession({ shop: SEED_SHOP, refreshToken: "invalidate" });
      const invalid = (yield* sessions.find(SEED_SHOP)).pipe(Option.getOrThrow);
      assert.match(invalid.refreshToken ?? "", /^shprt_invalid_/u);
    }).pipe(Effect.provide(harness().layer)),
  );
});

describe("AddToFixture", () => {
  const data = fixture({
    members: ["added-a@e2e.test", "added-b@e2e.test"],
    teams: [{ name: "Added", members: ["added-a@e2e.test"] }],
    workflows: [{ name: "Added", tag: "added", tasks: [] }],
  });

  it.live("adds beside the shop's rows, revoking nobody", () => {
    const { revoked, added, layer } = harness();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const counts = yield* client.AddToFixture({ shop: SEED_SHOP, fixture: data });
      assert.deepStrictEqual(counts, {
        members: 3,
        teams: 1,
        workflows: 1,
        orders: 0,
        lineItems: 0,
      });
      const rows = yield* (yield* MembershipRepository).list();
      assert.deepStrictEqual(
        rows.map((row) => row.email),
        ["added-a@e2e.test", "added-b@e2e.test", "m1@m.com"],
      );
      assert.isTrue(rows.some((row) => row.id === "mem-1"));
      assert.deepStrictEqual(
        added.map(({ key, rows }) => [key, rows.workflows.map((workflow) => workflow.name)]),
        [[SEED_SHOP, ["Added"]]],
      );
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with FixtureConflict on an existing email, writing nothing", () => {
    const { added, layer } = harness();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const error = yield* client
        .AddToFixture({
          shop: SEED_SHOP,
          fixture: fixture({ members: ["new@e2e.test", "m1@m.com"] }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "FixtureConflict");
      assert.strictEqual(error._tag === "FixtureConflict" && error.shop, SEED_SHOP);
      assert.strictEqual((yield* (yield* MembershipRepository).list()).length, 1);
      assert.deepStrictEqual(added, []);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with ShopNotInstalled for a shop with no session, writing nothing", () => {
    const { added, layer } = harness();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DevRpcs);
      const error = yield* client
        .AddToFixture({ shop: otherShop, fixture: data })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ShopNotInstalled");
      assert.strictEqual((yield* (yield* MembershipRepository).list()).length, 1);
      assert.deepStrictEqual(added, []);
    }).pipe(Effect.provide(layer));
  });
});
