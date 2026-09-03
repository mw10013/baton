import { Context, Effect, Layer, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";

/**
 * `retryable` and `overloaded` mirror the flags Cloudflare's Durable Object
 * infrastructure sets on errors it throws across the stub boundary
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/):
 * `retryable` marks a transient infra fault safe to retry with backoff;
 * `overloaded` marks a DO where "retrying will worsen the overload" and must
 * not be retried immediately. They are copied into typed fields (defaulting
 * false — user-code throws and result-decode failures carry neither) because
 * `cause` is an opaque `Schema.Defect()`, and a caller that wants to answer an
 * overloaded object with `429` + `Retry-After` instead of the default `500`
 * needs a typed refinement to branch on.
 */
export class ShopAgentClientError extends Schema.TaggedError<ShopAgentClientError>()(
  "ShopAgentClientError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
    overloaded: Schema.Boolean,
  },
) {}

/**
 * Typed Effect facade over ShopAgent Durable Object RPC for routes and server
 * functions — the `ShopifyAdmin.graphqlDecode` counterpart for DO calls.
 *
 * DO RPC structured-clones return values across the stub boundary, stripping
 * class identity and any compile-time guarantee, so an
 * `Effect.tryPromise<T>(() => stub.method())` type parameter is an unchecked
 * assertion. Every result is instead decoded against its `Domain` schema. Stub
 * lookup, error tagging, and result decoding live here once instead of at each
 * call site.
 *
 * Both failure modes — an RPC rejection and a result-decode failure — converge
 * on {@link ShopAgentClientError}, transient by contract: callers let it
 * propagate and the worker seam renders it a `500`. Its `cause` chain is walked
 * by `causeToErrorMessage`, so diagnostics render the same as the bare
 * `UnknownError` path this replaces.
 *
 * `shop` is `string`, not `Domain.Shop`: server functions pass the library
 * session's `session.shop` (a plain string, validated at auth), and the stub
 * name seam needs no more.
 *
 * `Shopify.ts`'s internal `SHOP_AGENT` uses (`idFromName`, uninstall `destroy`,
 * stub-by-id) stay raw: none decodes a wire result, and routing them through
 * this service would invert the layer graph.
 */
export class ShopAgentClient extends Context.Service<
  ShopAgentClient,
  {
    readonly getShopInfo: (
      shop: string,
    ) => Effect.Effect<Domain.ShopInfo, ShopAgentClientError>;
    readonly listQueue: (
      shop: string,
      input: Domain.ListQueueInput,
    ) => Effect.Effect<readonly Domain.QueueItem[], ShopAgentClientError>;
    readonly completeStep: (
      shop: string,
      input: Domain.CompleteStepInput,
    ) => Effect.Effect<Domain.RunResult, ShopAgentClientError>;
    readonly dismissFlag: (
      shop: string,
      input: Domain.DismissFlagInput,
    ) => Effect.Effect<Domain.RunResult, ShopAgentClientError>;
  }
>()("ShopAgentClient") {
  static readonly layerNoDeps = Layer.effect(
    ShopAgentClient,
    Effect.gen(function* () {
      const env = yield* CloudflareEnv;
      const call = <A>(
        name: string,
        schema: Schema.ConstraintDecoder<A>,
        shop: string,
        run: (
          stub: ReturnType<Env["SHOP_AGENT"]["getByName"]>,
        ) => Promise<unknown>,
      ) =>
        Effect.tryPromise({
          try: () => run(env.SHOP_AGENT.getByName(shop)),
          catch: (cause) => {
            const retryable =
              (cause as { readonly retryable?: unknown } | null)?.retryable ===
              true;
            const overloaded =
              (cause as { readonly overloaded?: unknown } | null)
                ?.overloaded === true;
            return new ShopAgentClientError({
              message: `ShopAgent.${name} call failed: retryable=${String(retryable)} overloaded=${String(overloaded)}`,
              cause,
              retryable,
              overloaded,
            });
          },
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(schema)(value).pipe(
              Effect.mapError(
                (cause) =>
                  new ShopAgentClientError({
                    message: `ShopAgent.${name} result validation failed`,
                    cause,
                    retryable: false,
                    overloaded: false,
                  }),
              ),
            ),
          ),
        );
      /**
       * `Schema.toType`: the object already decoded these rows, so the wire
       * value is the decoded shape (`customAttributes` an array, not JSON
       * text) and must be validated on that side. `ShopInfo` has no transforms
       * and needs no such care.
       */
      const queueItems = Schema.toType(Schema.Array(Domain.QueueItem));
      return ShopAgentClient.of({
        getShopInfo: Effect.fn("ShopAgentClient.getShopInfo")((shop: string) =>
          call("getShopInfo", Domain.ShopInfo, shop, (stub) =>
            stub.getShopInfo(),
          ),
        ),
        listQueue: Effect.fn("ShopAgentClient.listQueue")(
          (shop: string, input: Domain.ListQueueInput) =>
            call("listQueue", queueItems, shop, (stub) =>
              stub.listQueue(input),
            ),
        ),
        completeStep: Effect.fn("ShopAgentClient.completeStep")(
          (shop: string, input: Domain.CompleteStepInput) =>
            call("completeStep", Domain.RunResult, shop, (stub) =>
              stub.completeStep(input),
            ),
        ),
        dismissFlag: Effect.fn("ShopAgentClient.dismissFlag")(
          (shop: string, input: Domain.DismissFlagInput) =>
            call("dismissFlag", Domain.RunResult, shop, (stub) =>
              stub.dismissFlag(input),
            ),
        ),
      });
    }),
  );
}
