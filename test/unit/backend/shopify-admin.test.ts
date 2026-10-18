import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SEED_SHOP } from "../../seed-shops.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { ShopifyAdmin } from "../../../src/backend/shopify-admin.ts";
import { QuietLogs, testShopify } from "./layers.ts";
import { accessTokenBody, jsonResponse, withShopifyStub } from "./shopify-stub.ts";

const MINUTE = 60 * 1000;

const rowAt = (now: number): ShopSessionRow => ({
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_orders",
  accessTokenExpiresAt: now + 60 * MINUTE,
  accessToken: "shpat_old",
  refreshToken: "shprt_old",
  refreshTokenExpiresAt: now + 30 * 24 * 60 * MINUTE,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
});

const QUERY = "query ShopGid { shop { id } }";
const ShopId = Schema.Struct({ shop: Schema.Struct({ id: Schema.String }) });
const graphqlOk = (id: string) => jsonResponse(200, { data: { shop: { id } } });

/** The real clock and a fresh row per test: the stub's replies are real promises. */
const live = (
  name: string,
  body: Effect.Effect<void, unknown, ShopifyAdmin | ShopSessionRepository>,
) =>
  it.live(
    name,
    () =>
      body.pipe(
        Effect.provide(
          ShopifyAdmin.layer.pipe(Layer.provideMerge(testShopify([rowAt(Date.now())]))),
        ),
        Effect.provide(QuietLogs),
      ),
    { timeout: 8000 },
  );

const admin = Effect.service(ShopifyAdmin);

describe("ShopifyAdmin", () => {
  live(
    "graphqlDecode decodes the answer",
    withShopifyStub(
      () => graphqlOk("gid://shopify/Shop/9"),
      (calls) =>
        Effect.gen(function* () {
          const shopId = yield* (yield* admin).graphqlDecode(SEED_SHOP, ShopId, QUERY);
          assert.strictEqual(shopId.shop.id, "gid://shopify/Shop/9");
          assert.strictEqual(calls.length, 1);
        }),
    ),
  );

  live(
    "an answer that does not decode is a defect",
    withShopifyStub(
      () => jsonResponse(200, { data: { shop: {} } }),
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit((yield* admin).graphqlDecode(SEED_SHOP, ShopId, QUERY));
          assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
        }),
    ),
  );

  live(
    "GraphQL errors are a defect",
    withShopifyStub(
      () => jsonResponse(200, { errors: [{ message: "Throttled" }] }),
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit((yield* admin).graphql(SEED_SHOP, QUERY));
          assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
        }),
    ),
  );

  live(
    "a 503 is ShopifyUnavailable",
    withShopifyStub(
      () => jsonResponse(503, { errors: "down" }),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* admin).graphql(SEED_SHOP, QUERY));
          assert.strictEqual(error._tag, "ShopifyUnavailable");
        }),
    ),
  );

  live(
    "a 401 clears the token and retries once through a refresh: Admin 401, grant, Admin 200",
    withShopifyStub(
      (call, attempt) =>
        call.grantType === "refresh_token"
          ? jsonResponse(200, accessTokenBody())
          : attempt === 0
            ? jsonResponse(401, { errors: "Unauthorized" })
            : graphqlOk("gid://shopify/Shop/1"),
      (calls) =>
        Effect.gen(function* () {
          const { data } = yield* (yield* admin).graphql(SEED_SHOP, QUERY);
          assert.deepStrictEqual(data, { shop: { id: "gid://shopify/Shop/1" } });
          assert.deepStrictEqual(
            calls.map((call) => (call.grantType === undefined ? "admin" : call.grantType)),
            ["admin", "refresh_token", "admin"],
          );
          const row = Option.getOrThrow(yield* (yield* ShopSessionRepository).find(SEED_SHOP));
          assert.strictEqual(row.accessToken, "shpat_new");
        }),
    ),
  );

  live(
    "a second 401 is ReauthorizationRequired",
    withShopifyStub(
      (call) =>
        call.grantType === "refresh_token"
          ? jsonResponse(200, accessTokenBody())
          : jsonResponse(401, { errors: "Unauthorized" }),
      (calls) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* admin).graphql(SEED_SHOP, QUERY));
          assert.strictEqual(error._tag, "ReauthorizationRequired");
          assert.strictEqual(calls.length, 3);
        }),
    ),
  );
});
