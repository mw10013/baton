/**
 * `LoadFixture` against a running server's `/api/dev`, for any caller with a fixture to load: the
 * dev fixture's script and e2e setup alike. It imports neither the dev fixture nor Shopify CLI's
 * store helpers, so a caller carries only what it loads.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { DevRpcs } from "../../src/contract/dev.ts";
import type { ShopFixtureData } from "../../src/contract/fixture.ts";
import type { ShopKey } from "../../src/domain/platform.ts";

/**
 * `LoadFixture` with `data` for `shop` on the server whose `/api/dev` is `url`. A shop that is
 * not installed yet is asked again every two seconds, up to `wait`, for a caller that has just
 * opened the app in a browser (only an embedded load writes the `ShopSession` it needs); with a
 * zero `wait` it fails with `ShopNotInstalled` at once.
 */
export const loadFixtureWhenInstalled = (
  url: string,
  shop: ShopKey,
  data: ShopFixtureData,
  wait: Duration.Duration,
) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(DevRpcs);
    return yield* client.LoadFixture({ shop, fixture: data });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Duration.isZero(wait)
      ? (effect) => effect
      : Effect.retry({
          while: (error) => error._tag === "ShopNotInstalled",
          schedule: Schedule.spaced("2 seconds").pipe(
            Schedule.upTo({ duration: wait }),
            Schedule.tap(({ attempt }) =>
              attempt === 1
                ? Console.log(`wait  ${shop} is not installed yet: waiting for the app to load`)
                : Effect.void,
            ),
          ),
        }),
  );
