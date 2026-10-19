import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../domain/platform.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import { ReauthorizationRequired, Shopify, type EnsureShopSessionError } from "./shopify.ts";

/** The options of one Admin GraphQL call. */
export interface GraphqlOptions {
  readonly variables?: Record<string, unknown> | undefined;
}

/** What an Admin call can fail with; anything else, a GraphQL error included, is a defect. */
export type ShopifyAdminError = EnsureShopSessionError;

const make = Effect.gen(function* () {
  const shopify = yield* Shopify;
  const shopSessions = yield* ShopSessionRepository;

  /**
   * One attempt: the freshly ensured session's call. A 401 clears that call's access token, only
   * if it is still the stored one, and, while `retry` allows, runs again through
   * `ensureShopSession`, which refreshes the now-missing token.
   */
  const attempt = (
    shop: ShopKey,
    query: string,
    options: GraphqlOptions | undefined,
    retry: boolean,
  ): Effect.Effect<unknown, ShopifyAdminError> =>
    Effect.gen(function* () {
      const session = yield* shopify.ensureShopSession(shop);
      return yield* shopify.adminRequest(shop, session, query, options?.variables).pipe(
        Effect.catchTag("AdminUnauthorized", () =>
          Effect.gen(function* () {
            if (session.accessToken !== undefined)
              yield* shopSessions.clearAccessToken(shop, session.accessToken);
            if (retry) return yield* attempt(shop, query, options, false);
            return yield* Effect.fail(
              new ReauthorizationRequired({
                shop,
                reason: "refresh-token-rejected",
                refreshTokenExpiresAt: null,
              }),
            );
          }),
        ),
      );
    });

  const graphql = Effect.fn("ShopifyAdmin.graphql")(function* (
    shop: ShopKey,
    query: string,
    options?: GraphqlOptions,
  ) {
    return { data: yield* attempt(shop, query, options, true) };
  });

  const graphqlDecode = Effect.fn("ShopifyAdmin.graphqlDecode")(function* <S extends Schema.Top>(
    shop: ShopKey,
    schema: S & { readonly DecodingServices: never },
    query: string,
    options?: GraphqlOptions,
  ) {
    const { data } = yield* graphql(shop, query, options);
    return yield* Schema.decodeUnknownEffect(schema)(data).pipe(Effect.orDie);
  });

  return { graphql, graphqlDecode };
});

/**
 * The Backend's Admin API client: a call takes a shop, never a session, and ensures the shop's
 * offline session first ({@link Shopify}'s `ensureShopSession`), so it refreshes an expiring token
 * with no merchant present. A session is never held between calls, so a token that a refresh or an
 * exchange has since replaced can never be used: the cost is one D1 row read per call, which the
 * call needs anyway for the first Admin call of any job. A 401 from the Admin API clears the
 * token that got it, only if it is still the stored one, and retries once through a refresh;
 * a second 401 fails {@link ReauthorizationRequired}.
 *
 * Failures are {@link ShopifyAdminError}. GraphQL `errors`, a response that does not decode and
 * any status the call cannot act on are defects.
 */
export class ShopifyAdmin extends Context.Service<ShopifyAdmin, Effect.Success<typeof make>>()(
  "app/ShopifyAdmin",
) {
  static readonly layer = Layer.effect(ShopifyAdmin, make);
}
