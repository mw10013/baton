import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ShopKey } from "../../src/domain/platform.ts";
import type { ShopifyFakeCall, ShopifyFakeReply } from "./rpcs.ts";

type Route = ShopifyFakeReply["route"];

/** The routes the Shopify library's fetch reaches; `bulk` is served by the test Backend itself. */
type LibraryRoute = Exclude<Route, "bulk">;

/** A route as the library's URLs spell it: `/admin/oauth/access_token`. */
const TokenPath = Schema.Tuple([
  Schema.Literal(""),
  Schema.Literal("admin"),
  Schema.Literal("oauth"),
  Schema.Literal("access_token"),
]).pipe(
  Schema.decodeTo(
    Schema.Literal("token"),
    SchemaTransformation.transform({
      decode: () => "token" as const,
      encode: () => ["", "admin", "oauth", "access_token"] as const,
    }),
  ),
);

/** `/admin/api/<version>/graphql.json`. */
const GraphqlPath = Schema.Tuple([
  Schema.Literal(""),
  Schema.Literal("admin"),
  Schema.Literal("api"),
  Schema.String,
  Schema.Literal("graphql.json"),
]).pipe(
  Schema.decodeTo(
    Schema.Literal("graphql"),
    SchemaTransformation.transform({
      decode: () => "graphql" as const,
      encode: (): readonly ["", "admin", "api", string, "graphql.json"] => [
        "",
        "admin",
        "api",
        "version",
        "graphql.json",
      ],
    }),
  ),
);

const decodeRoute = Schema.decodeUnknownOption(Schema.Union([TokenPath, GraphqlPath]));
const decodeShop = Schema.decodeUnknownOption(ShopKey);

/** The fields of a token endpoint request the fake reads. */
const TokenRequest = Schema.fromJsonString(
  Schema.Struct({
    grant_type: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
  }),
);
const decodeTokenRequest = Schema.decodeUnknownOption(TokenRequest);

/** The shop id the fake's GraphQL endpoint answers when nothing is scripted. */
export const FAKE_SHOP_GID = "gid://shopify/Shop/0";

const unscripted = (reason: string) => Response.json({ error: reason }, { status: 599 });

const make = Effect.sync(() => {
  const queues: Record<Route, Array<ShopifyFakeReply>> = { token: [], graphql: [], bulk: [] };
  let calls: Array<ShopifyFakeCall> = [];
  const refreshTokenLabels = new Map<string, string>();

  /** The label of a presented refresh token: stable per token, and not the token. */
  const labelOf = (refreshToken: string) => {
    const known = refreshTokenLabels.get(refreshToken);
    if (known !== undefined) return known;
    const label = `refresh-${refreshTokenLabels.size + 1}`;
    refreshTokenLabels.set(refreshToken, label);
    return label;
  };

  const defaultReply = (route: LibraryRoute) =>
    route === "token"
      ? Response.json({
          access_token: `shpat_fake_${crypto.randomUUID()}`,
          expires_in: 3600,
          refresh_token: `shprt_fake_${crypto.randomUUID()}`,
          refresh_token_expires_in: 7_776_000,
          scope: "read_orders,write_orders",
        })
      : Response.json({ data: { shop: { id: FAKE_SHOP_GID } } });

  const fake = (url: string, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const route = decodeRoute(target.pathname.split("/"));
    if (Option.isNone(decodeShop(target.hostname)) || Option.isNone(route))
      return Promise.resolve(
        unscripted(`unscripted request to ${target.origin}${target.pathname}`),
      );
    const request =
      route.value === "token" && typeof init?.body === "string"
        ? decodeTokenRequest(init.body)
        : Option.none();
    const grantType = Option.flatMapNullishOr(request, (body) => body.grant_type);
    const refreshToken = Option.flatMapNullishOr(request, (body) => body.refresh_token);
    calls.push({
      route: route.value,
      ...(Option.isSome(grantType) ? { grantType: grantType.value } : {}),
      ...(Option.isSome(refreshToken) ? { refreshToken: labelOf(refreshToken.value) } : {}),
    });
    const scripted = queues[route.value].shift();
    return Promise.resolve(
      scripted === undefined
        ? defaultReply(route.value)
        : Response.json(scripted.body, { status: scripted.status }),
    );
  };

  setAbstractFetchFunc(fake as never);

  return {
    /** Replaces both queues and clears the call log. */
    script: (replies: ReadonlyArray<ShopifyFakeReply>) =>
      Effect.sync(() => {
        queues.token = replies.filter((reply) => reply.route === "token");
        queues.graphql = replies.filter((reply) => reply.route === "graphql");
        queues.bulk = replies.filter((reply) => reply.route === "bulk");
        calls = [];
        refreshTokenLabels.clear();
      }),
    /**
     * The next scripted bulk file, as the response the test Backend serves for it: the reply's
     * `body`, a string of JSONL, as text. An empty queue answers 404. Recorded as a `bulk` call.
     */
    takeBulk: Effect.sync(() => {
      calls.push({ route: "bulk" });
      const scripted = queues.bulk.shift();
      return scripted === undefined
        ? new Response("no bulk file scripted", { status: 404 })
        : new Response(typeof scripted.body === "string" ? scripted.body : "", {
            status: scripted.status,
            headers: { "content-type": "application/jsonl" },
          });
    }),
    /** The calls served since the last script or read, which it clears. */
    takeCalls: Effect.sync(() => {
      const taken = calls;
      calls = [];
      return taken;
    }),
  };
});

/**
 * The fake Shopify HTTP layer, for the test Backend only. The library's only HTTP seam is one
 * module-global fetch per isolate, so building this layer (once, in the test Backend's init)
 * replaces it with a function that answers `https://<shop>.myshopify.com`'s token endpoint and
 * Admin GraphQL endpoint from replies a test scripts through `ScriptShopify`, and records what it
 * served. A `bulk` reply is a bulk operation's result file, which the Shopify library never
 * fetches: the shop's actor does, from the URL a scripted `bulkOperation` names, so the test
 * Backend serves the queue itself on `/api/integ/bulk/<n>` ({@link ShopifyFake}'s `takeBulk`).
 * The last install wins, so the test Backend builds it after the shared wiring, whose
 * Shopify library installs its own on import. An empty queue answers a default: fresh tokens (an
 * hour, ninety days) for the token endpoint, and {@link FAKE_SHOP_GID} for GraphQL, which has no
 * database to read the shop's real id from. Anything else is answered 599 and never reaches the
 * network.
 */
export class ShopifyFake extends Context.Service<ShopifyFake, Effect.Success<typeof make>>()(
  "app/ShopifyFake",
) {
  static readonly layer = Layer.effect(ShopifyFake, make);
}
