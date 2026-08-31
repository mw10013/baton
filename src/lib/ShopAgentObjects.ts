import { Config, Context, Effect, Layer, Redacted, Schema, flow } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

export class ShopAgentObjectsError extends Schema.TaggedError<ShopAgentObjectsError>()(
  "ShopAgentObjectsError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const Namespace = Schema.Struct({
  id: Schema.String,
  class: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  script: Schema.optional(Schema.String),
});

const NamespacesResponse = Schema.Struct({
  result: Schema.Array(Namespace),
});

/**
 * One Durable Object as returned by Cloudflare's `list_objects` REST endpoint.
 *
 * Field optionality mirrors Cloudflare's OpenAPI `workers_object` schema
 * (vendored at
 * `refs/workers-sdk/packages/miniflare/src/workers/local-explorer/openapi.local.json`):
 * that schema declares no `required` array, so per OpenAPI `id`, `name`, and
 * `hasStoredData` are ALL optional in the contract.
 *
 * - `id` — deliberately tightened to required here: it is the join key against
 *   `Session.shopAgentId`, so a row without it is useless to us.
 * - `name` — spec: "Name of the Durable Object instance, if created via
 *   idFromName()". Absent for DOs addressed by `idFromString`/`newUniqueId`,
 *   which is why prod orphan rows typically carry no name.
 * - `hasStoredData` — spec: "Whether the Durable Object has stored data."
 *   Optional with no documented condition for when it is omitted, so `undefined`
 *   is a genuine third state and must not be coerced to `true`/`false`.
 */
export const ShopAgentObject = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  hasStoredData: Schema.optional(Schema.Boolean),
});

export type ShopAgentObject = typeof ShopAgentObject.Type;

const ObjectsResponse = Schema.Struct({
  result: Schema.Array(ShopAgentObject),
  result_info: Schema.optional(
    Schema.Struct({ cursor: Schema.optional(Schema.String) }),
  ),
});

const DEFAULT_LIMIT = 25;

export class ShopAgentObjects extends Context.Service<
  ShopAgentObjects,
  {
    readonly list: (options: {
      readonly cursor?: string;
      readonly limit?: number;
    }) => Effect.Effect<
      {
        readonly objects: readonly ShopAgentObject[];
        readonly cursor: string | undefined;
      },
      ShopAgentObjectsError
    >;
  }
>()("ShopAgentObjects") {
  static readonly layer = Layer.effect(
    ShopAgentObjects,
    Effect.gen(function* () {
      const environment = yield* Config.string("ENVIRONMENT");
      const isLocal = environment === "local";
      const targetScript =
        environment === "production" ? "baton" : `baton-${environment}`;
      const baseUrl = isLocal
        ? `http://localhost:${yield* Config.string("PORT")}/cdn-cgi/explorer/api`
        : `https://api.cloudflare.com/client/v4/accounts/${yield* Config.nonEmptyString("CLOUDFLARE_ACCOUNT_ID")}`;
      const apiToken = isLocal
        ? undefined
        : yield* Config.nonEmptyString("CLOUDFLARE_WORKERS_API_TOKEN").pipe(
            Config.map(Redacted.make),
          );

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(baseUrl),
            HttpClientRequest.acceptJson,
            apiToken
              ? HttpClientRequest.bearerToken(apiToken)
              : (request) => request,
          ),
        ),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ times: 3 }),
      );

      const namespaceId = client
        .get("/workers/durable_objects/namespaces")
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(NamespacesResponse)),
          Effect.mapError(
            (cause) =>
              new ShopAgentObjectsError({
                message: "Failed to resolve ShopAgent namespace",
                cause,
              }),
          ),
          Effect.flatMap(({ result }) => {
            const namespace = result.find(
              (entry) =>
                entry.class === "ShopAgent" &&
                (isLocal || entry.script === targetScript),
            );
            return namespace
              ? Effect.succeed(namespace.id)
              : Effect.fail(
                  new ShopAgentObjectsError({
                    message: "ShopAgent namespace not found",
                    cause: result,
                  }),
                );
          }),
          Effect.withSpan("ShopAgentObjects.namespaceId"),
        );

      const list = Effect.fn("ShopAgentObjects.list")(function* ({
        cursor,
        limit = DEFAULT_LIMIT,
      }: {
        readonly cursor?: string;
        readonly limit?: number;
      }) {
        yield* Effect.annotateCurrentSpan({ cursor: cursor ?? "", limit });
        const id = yield* namespaceId;
        const { result, result_info } = yield* client
          .get(`/workers/durable_objects/namespaces/${id}/objects`, {
            urlParams: cursor
              ? { limit: String(limit), cursor }
              : { limit: String(limit) },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ObjectsResponse)),
            Effect.tapErrorTag("HttpClientError", (cause) =>
              cause.response
                ? cause.response.text.pipe(
                    Effect.catch(() => Effect.succeed("")),
                    Effect.flatMap((body) =>
                      Effect.logError(
                        `ShopAgentObjects.list: Cloudflare API failed status=${String(cause.response?.status ?? "unknown")}`,
                      ).pipe(
                        Effect.annotateLogs({
                          status: cause.response?.status,
                          body: body.slice(0, 4000),
                          requestUrl: cause.request.url,
                          urlParams: [...cause.request.urlParams],
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
            Effect.mapError(
              (cause) =>
                new ShopAgentObjectsError({
                  message: "Failed to list ShopAgent objects",
                  cause,
                }),
            ),
          );
        return {
          objects: result,
          cursor:
            result.length >= limit &&
            result_info?.cursor &&
            result_info.cursor.length > 0
              ? result_info.cursor
              : undefined,
        };
      });

      return ShopAgentObjects.of({ list });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
