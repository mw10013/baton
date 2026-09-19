import { strictEqual } from "@effect/vitest/utils";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";

/**
 * The App Events client against a recorded transport.
 *
 * Two of these titles are facts about Shopify's live API that its own
 * documentation contradicts, both measured on 2026-09-19 and both silent
 * failures in production — the API answers `202` to everything, so an event
 * that never leaves is indistinguishable from one that bills. They are pinned
 * here so a future refactor cannot quietly reintroduce either.
 */
interface Recorded {
  readonly url: string;
  readonly userAgent: string | null;
  readonly body: string;
}

const clientLayer = (
  recorded: Recorded[],
  respond: (url: string) => Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : "";
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

const anEvent = (): Domain.UsageEvent => ({
  shopGid: Schema.decodeUnknownSync(Domain.ShopGid)("gid://shopify/Shop/1"),
  eventHandle: Domain.USAGE_METER_ORDER,
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
        ShopifyAppEvents.layerNoDeps,
        clientLayer(recorded, respond),
      ),
    ),
  );

/** The token body Shopify actually returns: no `scope`, no `expires_in`. */
const LIVE_TOKEN_BODY = { access_token: "tok_live", token_type: "bearer" };

const respondOk = (url: string) =>
  url.includes("/auth/access_token")
    ? json(LIVE_TOKEN_BODY)
    : new Response(null, { status: 202 });

describe("ShopifyAppEvents", () => {
  it("sends a User-Agent on every request", async () => {
    const recorded: Recorded[] = [];
    await Effect.runPromise(run(sendOne(), recorded, respondOk));
    strictEqual(recorded.length, 2);
    for (const request of recorded)
      strictEqual(
        (request.userAgent ?? "").startsWith("Baton/"),
        true,
        `${request.url} must carry a User-Agent`,
      );
  });

  it("accepts a token response that omits expires_in", async () => {
    const recorded: Recorded[] = [];
    await Effect.runPromise(
      run(
        Effect.gen(function* () {
          const events = yield* ShopifyAppEvents;
          yield* events.send(anEvent());
          yield* events.send(anEvent());
        }),
        recorded,
        respondOk,
      ),
    );
    // One token, then two events: the fallback lifetime has to be long enough
    // that the second send reuses the first token rather than re-minting.
    let tokenRequests = 0;
    for (const request of recorded)
      if (request.url.includes("/auth/access_token")) tokenRequests += 1;
    strictEqual(tokenRequests, 1);
  });

  it("posts the event under the meter handle with its idempotency key", async () => {
    const recorded: Recorded[] = [];
    await Effect.runPromise(run(sendOne(), recorded, respondOk));
    const event = recorded.find((request) => request.url.includes("/events"));
    const body = JSON.parse(event?.body ?? "{}") as Record<string, unknown>;
    strictEqual(body.event_handle, Domain.USAGE_METER_ORDER);
    strictEqual(body.idempotency_key, "gid://shopify/Order/1#count");
    strictEqual(body.shop_id, "gid://shopify/Shop/1");
    strictEqual((body.attributes as { value: number }).value, 1);
    strictEqual(body.timestamp, "2026-09-19T20:30:00.000Z");
  });

  it("carries the refusal reason into the error a caller records", async () => {
    const recorded: Recorded[] = [];
    const error = await Effect.runPromise(
      Effect.flip(
        run(sendOne(), recorded, (url) =>
          url.includes("/auth/access_token")
            ? new Response("<!DOCTYPE html>blocked", { status: 403 })
            : new Response(null, { status: 202 }),
        ),
      ),
    );
    strictEqual(error.message.includes("status=403"), true);
    strictEqual(error.message.includes("blocked"), true);
  });

  it("never puts a token body's values in the error it reports", async () => {
    const recorded: Recorded[] = [];
    const error = await Effect.runPromise(
      Effect.flip(
        run(sendOne(), recorded, (url) =>
          url.includes("/auth/access_token")
            ? json({ token_type: "bearer", access_token_typo: "tok_secret" })
            : new Response(null, { status: 202 }),
        ),
      ),
    );
    strictEqual(error.message.includes("access_token_typo"), true);
    strictEqual(error.message.includes("tok_secret"), false);
  });
});
