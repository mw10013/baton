import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Email } from "../contract/auth.ts";
import { DevRpcs, type ShopSessionView } from "../contract/dev.ts";
import { ShopNotInstalled } from "../contract/fixture.ts";
import type { ShopKey } from "../contract/shop.ts";
import { Fixtures } from "./fixture.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";

const devProcedures = Effect.gen(function* () {
  const members = yield* MembershipRepository;
  const actors = yield* ShopActors;
  const sessions = yield* ShopSessionRepository;

  const removeMember = Effect.fn("Dev.removeMember")(function* (shop: ShopKey, email: Email) {
    const removed = yield* members.deleteMember({ shop, email }).pipe(Effect.option);
    if (Option.isNone(removed)) return { removed: false, closed: 0 };
    // Baton's rule on `MembershipRepository`: the edit is followed by a revoke on the shop's actor. A failed
    // revoke is logged and answers `closed: 0`, which a test sees.
    const { closed } = yield* actors.revoke(shop, "member", removed.value);
    return { removed: true, closed };
  });

  /** The shop's session is checked first, so a shop that is not installed gets no actor. */
  const removeOrder = Effect.fn("Dev.removeOrder")(function* (shop: ShopKey, orderId: string) {
    if (Option.isNone(yield* sessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    return yield* actors.removeOrder(shop, orderId);
  });

  const getShopSession = Effect.fn("Dev.getShopSession")(function* (shop: ShopKey) {
    return Option.match(yield* sessions.find(shop), {
      onNone: () => null,
      onSome: ({
        shopGid,
        scope,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        refreshLeaseUntil,
      }): ShopSessionView => ({
        shopGid,
        scope,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        refreshLeaseUntil,
      }),
    });
  });

  const expireShopSession = Effect.fn("Dev.expireShopSession")(function* (
    shop: ShopKey,
    refreshToken: "keep" | "invalidate",
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sessions.expireAccessToken(
      shop,
      now - 1000,
      refreshToken === "invalidate" ? `shprt_invalid_${crypto.randomUUID()}` : undefined,
    );
    return {};
  });

  return { removeMember, removeOrder, getShopSession, expireShopSession };
});

export const DevHandlers = DevRpcs.toLayer(
  Effect.gen(function* () {
    const fixtures = yield* Fixtures;
    const dev = yield* devProcedures;
    return DevRpcs.of({
      LoadFixture: ({ shop, fixture }) => fixtures.load(shop, fixture),
      AddToFixture: ({ shop, fixture }) => fixtures.add(shop, fixture),
      RemoveMember: ({ shop, email }) => dev.removeMember(shop, email),
      RemoveOrder: ({ shop, orderId }) => dev.removeOrder(shop, orderId),
      GetShopSession: ({ shop }) => dev.getShopSession(shop),
      ExpireShopSession: ({ shop, refreshToken }) => dev.expireShopSession(shop, refreshToken),
    });
  }),
);
