import { Context, Effect, Layer, Schema } from "effect";

import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import { Shopify, ShopifyError } from "@/lib/Shopify";

export class ShopifyAdmin extends Context.Service<
  ShopifyAdmin,
  {
    readonly graphql: (
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) => Effect.Effect<
      {
        readonly data?: unknown;
        readonly errors?: { readonly message?: string };
      },
      ShopifyError
    >;
    readonly graphqlDecode: <A>(
      schema: Schema.ConstraintDecoder<A>,
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) => Effect.Effect<A, ShopifyError>;
  }
>()("ShopifyAdmin") {
  static readonly layerNoDeps: Layer.Layer<
    ShopifyAdmin,
    never,
    Shopify | CurrentShopifySession
  > = Layer.effect(
    ShopifyAdmin,
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const session = yield* CurrentShopifySession;
      const graphql = Effect.fn("ShopifyAdmin.graphql")(
        (
          query: string,
          options?: { readonly variables?: Record<string, unknown> },
        ) => shopify.graphql(session, query, options),
      );
      const graphqlDecode = Effect.fn("ShopifyAdmin.graphqlDecode")(function* <
        A,
      >(
        schema: Schema.ConstraintDecoder<A>,
        query: string,
        options?: { readonly variables?: Record<string, unknown> },
      ) {
        const { data, errors } = yield* graphql(query, options);
        if (errors)
          yield* Effect.fail(
            new ShopifyError({
              message: errors.message ?? "Admin GraphQL request failed",
              cause: errors,
            }),
          );
        return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
          Effect.mapError(
            (cause) =>
              new ShopifyError({
                message: "Admin GraphQL response validation failed",
                cause,
              }),
          ),
        );
      });
      return ShopifyAdmin.of({ graphql, graphqlDecode });
    }),
  );
}
