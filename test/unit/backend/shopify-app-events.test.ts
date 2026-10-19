import { describe, it } from "@effect/vitest";
import { strictEqual } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ShopifyAppEvents } from "../../../src/backend/shopify-app-events.ts";
import { USAGE_METER_ORDER, type UsageEvent } from "../../../src/domain/billing.ts";
import { ShopGid } from "../../../src/domain/platform.ts";

/**
 * The App Events client against a recorded transport: legacy `shopify-app-events.test.ts`'s
 * cases, titles unchanged.
 *
 * Two of these titles are facts about Shopify's live API that its own documentation
 * contradicts (the `User-Agent` and the token body without `expires_in`), measured 2026-09-19
 * and again 2026-10-18, and both silent failures in production. They are pinned here so a
 * refactor cannot quietly reintroduce either.
 */
interface Recorded {
  readonly url: string;
  readonly userAgent: string | null;
  readonly body: string;
}

const clientLayer = (recorded: Recorded[], respond: (url: string) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        recorded.push({
          url: url.toString(),
          userAgent: request.headers["user-agent"] ?? null,
          body,
        });
        return HttpClientResponse.fromWeb(request, respond(url.toString()));
      }),
    ),
  );

const json = (value: unknown) => Response.json(value);

const anEvent = (): UsageEvent => ({
  shopGid: Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1"),
  eventHandle: USAGE_METER_ORDER,
  occurredAt: Date.UTC(2026, 8, 19, 20, 30),
  idempotencyKey: "gid://shopify/Order/1#count",
  value: 1,
});

const sendOne = () =>
  Effect.gen(function* () {
    yield* (yield* ShopifyAppEvents).send(anEvent());
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, ShopifyAppEvents>,
  recorded: Recorded[],
  respond: (url: string) => Response,
) =>
  effect.pipe(
    Effect.provide(
      Layer.provide(
        ShopifyAppEvents.layerWith({
          apiKey: "key",
          apiSecret: Redacted.make("secret"),
          appHandle: "baton-local",
        }),
        clientLayer(recorded, respond),
      ),
    ),
  );

/** The token body Shopify actually returns: no `scope`, no `expires_in`. */
const LIVE_TOKEN_BODY = { access_token: "tok_live", token_type: "bearer" };

const respondOk = (url: string) =>
  url.includes("/auth/access_token") ? json(LIVE_TOKEN_BODY) : new Response(null, { status: 202 });

describe("ShopifyAppEvents", () => {
  it.effect("sends a User-Agent on every request", () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = [];
      yield* run(sendOne(), recorded, respondOk);
      strictEqual(recorded.length, 2);
      for (const request of recorded)
        strictEqual(
          (request.userAgent ?? "").startsWith("Baton/"),
          true,
          `${request.url} must carry a User-Agent`,
        );
    }),
  );

  it.effect("accepts a token response that omits expires_in", () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = [];
      yield* run(
        Effect.gen(function* () {
          const events = yield* ShopifyAppEvents;
          yield* events.send(anEvent());
          yield* events.send(anEvent());
        }),
        recorded,
        respondOk,
      );
      // One token, then two events: the fallback lifetime has to be long enough
      // that the second send reuses the first token rather than re-minting.
      strictEqual(
        recorded.filter((request) => request.url.includes("/auth/access_token")).length,
        1,
      );
    }),
  );

  it.effect("posts the event under the meter handle with its idempotency key", () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = [];
      yield* run(sendOne(), recorded, respondOk);
      const event = recorded.find((request) => request.url.includes("/events"));
      const body = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            event_handle: Schema.String,
            idempotency_key: Schema.String,
            shop_id: Schema.String,
            timestamp: Schema.String,
            attributes: Schema.Struct({ value: Schema.Number }),
          }),
        ),
      )(event?.body ?? "{}");
      strictEqual(body.event_handle, USAGE_METER_ORDER);
      strictEqual(body.idempotency_key, "gid://shopify/Order/1#count");
      strictEqual(body.shop_id, "gid://shopify/Shop/1");
      strictEqual(body.attributes.value, 1);
      strictEqual(body.timestamp, "2026-09-19T20:30:00.000Z");
    }),
  );

  it.effect("carries the refusal reason into the error a caller records", () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = [];
      const error = yield* Effect.flip(
        run(sendOne(), recorded, (url) =>
          url.includes("/auth/access_token")
            ? new Response("<!DOCTYPE html>blocked", { status: 403 })
            : new Response(null, { status: 202 }),
        ),
      );
      strictEqual(error.message.includes("status=403"), true);
      strictEqual(error.message.includes("blocked"), true);
      // The events endpoint's refusal carries Shopify's reason the same way.
      const refused = yield* Effect.flip(
        run(sendOne(), [], (url) =>
          url.includes("/auth/access_token")
            ? json(LIVE_TOKEN_BODY)
            : Response.json(
                { success: false, errors: [{ code: "not_installed" }] },
                { status: 403 },
              ),
        ),
      );
      strictEqual(refused.message.includes("status=403"), true);
      strictEqual(refused.message.includes("not_installed"), true);
    }),
  );

  it.effect("never puts a token body's values in the error it reports", () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = [];
      const error = yield* Effect.flip(
        run(sendOne(), recorded, (url) =>
          url.includes("/auth/access_token")
            ? json({ token_type: "bearer", access_token_typo: "tok_secret" })
            : new Response(null, { status: 202 }),
        ),
      );
      strictEqual(error.message.includes("access_token_typo"), true);
      strictEqual(error.message.includes("tok_secret"), false);
    }),
  );
});
