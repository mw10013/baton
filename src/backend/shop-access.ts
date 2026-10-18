import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../contract/shop.ts";
import type { ConnectionCaller } from "../contract/shop-actor.ts";
import { Auth } from "./auth.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { sessionFromCookie } from "./auth.ts";
import { AuthDb } from "./resources.ts";
import { Shopify } from "./shopify.ts";

/**
 * The gate's refusal, as the HTTP status Baton's gate answers with. Internal to the Backend:
 * the upgrade route turns it into a close code, `BackendApi.shopSnapshot` into a typed failure.
 */
export class ShopAccessDenied extends Schema.TaggedError<ShopAccessDenied>()("ShopAccessDenied", {
  status: Schema.Literals([401, 403, 404, 503]),
}) {}

const decodeShops = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ shop: Schema.String })),
);

const denied = (status: ShopAccessDenied["status"]) =>
  Effect.fail(new ShopAccessDenied({ status }));

const make = Effect.gen(function* () {
  const auth = yield* Auth;
  const members = yield* MembershipRepository;
  const shopify = yield* Shopify;
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const sql = yield* SQL.D1(d1);

  const shopExists = Effect.fn("ShopAccess.shopExists")(function* (shop: ShopKey) {
    const rows = yield* decodeShops(yield* sql`select shop from ShopSession where shop = ${shop}`);
    return rows.length > 0;
  }, Effect.orDie);

  const merchant = Effect.fn("ShopAccess.merchant")(function* (key: ShopKey, token: string) {
    const decoded = yield* shopify
      .decodeSessionToken(token)
      .pipe(Effect.catchTag("InvalidSessionToken", () => denied(401)));
    if (new URL(decoded.dest).hostname !== key) return yield* denied(403);
    // Baton resolves the shop's subscription plan here and answers 402 for a lapsed one; plans
    // come with the Shopify slice.
    if (!(yield* shopExists(key))) return yield* denied(404);
    return { role: "merchant" } satisfies ConnectionCaller;
  });

  const member = Effect.fn("ShopAccess.member")(function* (
    key: ShopKey,
    cookie: string | undefined,
  ) {
    const session = yield* sessionFromCookie(cookie).pipe(
      Effect.provideService(Auth, auth),
      Effect.catchTag("Unauthorized", () => denied(401)),
    );
    if (session.me.role === "admin") return yield* denied(403);
    const access = yield* members.findMemberAccess({ shop: key, email: session.me.email });
    if (Option.isNone(access)) return yield* denied(404);
    return {
      role: "member",
      memberId: access.value.memberId,
      memberEmail: session.me.email,
      teamIds: access.value.teams.map((team) => team.id),
      userId: session.me.id,
      sessionId: session.sessionId,
      sessionExpiresAt: session.sessionExpiresAt,
    } satisfies ConnectionCaller;
  });

  const resolve = Effect.fn("ShopAccess.resolve")(
    function* (input: {
      readonly key: ShopKey;
      readonly cookie: string | undefined;
      readonly sessionToken: string | undefined;
    }) {
      const caller: ConnectionCaller =
        input.sessionToken === undefined
          ? yield* member(input.key, input.cookie)
          : yield* merchant(input.key, input.sessionToken);
      return caller;
    },
    // A D1 failure is a defect everywhere below; here it is 503, so an outage never reads as
    // "not yours" and the browser retries instead of giving up.
    Effect.catchDefect((defect) =>
      Effect.logError("ShopAccess.resolve: lookup failed", defect).pipe(
        Effect.andThen(denied(503)),
      ),
    ),
    Effect.provide(RuntimeContext.phantom),
  );

  return { resolve };
});

/**
 * Baton's gate (`authorizeShopAgentRequest` and `authorizeShopAgentMember` in one): who may
 * open a shop's actor, decided from the credential the caller presents.
 *
 * - A Shopify session token selects the merchant branch: a bad token is 401, a token for
 *   another shop 403, a shop with no `ShopSession` row 404; otherwise a merchant.
 * - Otherwise the member branch, on the Better Auth cookie: no session is 401, an admin 403
 *   (the admin role is never a member), no `Member` row for this shop 404, the same answer
 *   as a shop that does not exist; otherwise a member, with its teams and session.
 * - A failure that is not an answer (D1 unreachable) is 503.
 */
export class ShopAccess extends Context.Service<ShopAccess, Effect.Success<typeof make>>()(
  "app/ShopAccess",
) {
  static readonly layer = Layer.effect(ShopAccess, make);
}
