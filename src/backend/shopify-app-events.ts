import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { UsageEvent } from "../domain/billing.ts";

export class ShopifyAppEventsError extends Schema.TaggedError<ShopifyAppEventsError>()(
  "ShopifyAppEventsError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The App Events API version, pinned in code. `2026-10` measured 2026-10-18: a custom event for
 * an installed shop answered `202 {"success":true}`.
 */
export const APP_EVENTS_API_VERSION = "2026-10";

const TOKEN_ENDPOINT = "https://api.shopify.com/auth/access_token";

/**
 * Refresh this long before the token's stated expiry.
 *
 * Tokens live an hour, and the cost of minting one early is a single extra
 * request; the cost of using one that expires mid-flight is a `401` on a
 * billable event. A minute would do — five is slack for a flush that queues
 * behind a slow batch.
 */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Assumed token lifetime when the response omits `expires_in`, which is what
 * the live endpoint does. Shopify's own documentation says tokens expire after
 * 60 minutes, so an hour is their number, not a guess; a `401` on a send mints
 * a fresh one anyway, so being wrong here costs one retry.
 */
const TOKEN_DEFAULT_LIFETIME_MS = 60 * 60 * 1000;

/** The body's shape, for a diagnostic that cannot leak a token: keys only, never values. */
const tokenBodyKeys = (text: string): string =>
  Option.match(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
      text,
    ),
    { onNone: () => "<not a json object>", onSome: (body) => Object.keys(body).join(",") },
  );

/**
 * Only `access_token` is required, because only `access_token` is actually
 * returned. Shopify's tutorials document a body of
 * `{ access_token, scope, expires_in }`, but the live endpoint answered
 * `{ access_token, token_type }` on 2026-09-19 and again on 2026-10-18 — no
 * `scope`, no `expires_in`. Requiring the documented shape fails every mint,
 * so the lifetime falls back to {@link TOKEN_DEFAULT_LIFETIME_MS}, and an
 * `expires_in` that does appear is honoured.
 */
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  /** Seconds, when present. */
  expires_in: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** The app whose usage is sent: its own Client ID and secret, and its handle for the `User-Agent`. */
export interface ShopifyAppEventsOptions {
  readonly apiKey: string;
  readonly apiSecret: Redacted.Redacted<string>;
  readonly appHandle: string;
}

/** A send that answered a status; the body is Shopify's reason. */
class Refused extends Schema.TaggedError<Refused>()("Refused", {
  status: Schema.Number,
  detail: Schema.String,
}) {}

const make = Effect.fn("ShopifyAppEvents.make")(function* ({
  apiKey,
  apiSecret,
  appHandle,
}: ShopifyAppEventsOptions) {
  const endpoint = `https://api.shopify.com/app/${APP_EVENTS_API_VERSION}/events`;

  /**
   * `User-Agent` is mandatory, not cosmetic. Cloudflare Workers' `fetch`
   * sends none, and `api.shopify.com` answers a request without one with a
   * `403` and an HTML body from its edge — before the API sees the
   * credentials at all. Measured against the live endpoint on 2026-09-19:
   * identical request with a UA `400`s on the merits, without one `403`s.
   * The handle is in it so the requests are attributable in Shopify's logs.
   *
   * Both endpoints' refusals are read, not thrown: the token endpoint answers
   * one with `{ error, error_description }` and the events endpoint with
   * `{ success: false, error, errors[] }` (measured 2026-10-18: `403` with
   * `code: "not_installed"` for a shop without the app), and that body is the
   * whole diagnosis. It carries no secret, only Shopify's reason.
   */
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", `Baton/${appHandle}`)),
    HttpClient.mapRequest(HttpClientRequest.acceptJson),
    HttpClient.retryTransient({
      schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
      times: 2,
    }),
  );

  /**
   * The underlying failure is folded into the message, not left only in
   * `cause`: the caller records this string on the outbox row and logs it,
   * and "App Events request failed" on its own tells an operator nothing
   * about whether the credential, the version, or the handle is wrong.
   */
  const appEventsError = (message: string) => (cause: unknown) =>
    new ShopifyAppEventsError({
      message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    });

  const bodyText = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(Effect.orElseSucceed(() => "<unreadable body>"));

  /**
   * The cached bearer token and when it stops being usable. One token per
   * instance is right: it authenticates the *app*, not a shop, and the actor
   * is single-threaded, so there is no race to guard and nothing
   * shop-specific to leak between cycles.
   */
  const cached = yield* Ref.make<{
    readonly token: string;
    readonly expiresAt: number;
  } | null>(null);

  const mintToken = Effect.fn("ShopifyAppEvents.mintToken")(function* () {
    const raw = yield* HttpClientRequest.post(TOKEN_ENDPOINT).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_id: apiKey,
        client_secret: Redacted.value(apiSecret),
        grant_type: "client_credentials",
      }),
      client.execute,
      Effect.mapError(appEventsError("App Events token request failed")),
    );
    if (raw.status < 200 || raw.status >= 300) {
      const detail = yield* bodyText(raw);
      return yield* new ShopifyAppEventsError({
        message: `App Events token request refused: status=${String(raw.status)}: ${detail.slice(0, 200)}`,
        cause: null,
      });
    }
    const response = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(raw).pipe(
      /**
       * The *keys* of the body, never its values: a body that failed to
       * decode may still carry a live token, and a log line is the last
       * place it should end up. Keys alone say which field is missing,
       * which is the whole question.
       */
      Effect.catchCause(() =>
        Effect.flatMap(
          raw.text.pipe(Effect.orElseSucceed(() => "")),
          (text) =>
            new ShopifyAppEventsError({
              message: `App Events token response invalid: status=${String(raw.status)} keys=${tokenBodyKeys(text)}`,
              cause: null,
            }),
        ),
      ),
    );
    const entry = {
      token: response.access_token,
      expiresAt:
        (yield* Clock.currentTimeMillis) +
        (response.expires_in === undefined || response.expires_in === null
          ? TOKEN_DEFAULT_LIFETIME_MS
          : response.expires_in * 1000),
    };
    yield* Ref.set(cached, entry);
    return entry.token;
  });

  const token = Effect.fn("ShopifyAppEvents.token")(function* (force: boolean) {
    const entry = yield* Ref.get(cached);
    const now = yield* Clock.currentTimeMillis;
    return entry === null || force || entry.expiresAt - TOKEN_REFRESH_SKEW_MS <= now
      ? yield* mintToken()
      : entry.token;
  });

  const post = (event: UsageEvent, bearer: string) =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${bearer}`),
        HttpClientRequest.bodyJsonUnsafe({
          shop_id: event.shopGid,
          event_handle: event.eventHandle,
          timestamp: new Date(event.occurredAt).toISOString(),
          idempotency_key: event.idempotencyKey,
          attributes: { value: event.value },
        }),
        client.execute,
      );
      if (response.status >= 200 && response.status < 300) return;
      return yield* new Refused({ status: response.status, detail: yield* bodyText(response) });
    });

  const send = Effect.fn("ShopifyAppEvents.send")(function* (event: UsageEvent) {
    yield* Effect.annotateCurrentSpan({
      eventHandle: event.eventHandle,
      idempotencyKey: event.idempotencyKey,
    });
    // One retry on a fresh token, and only on a fresh token: a `401` is the
    // one failure a caller can fix by trying again immediately, because it
    // means the cached token was revoked or expired early rather than that
    // the event was wrong. Every other status is left to the caller's outbox.
    yield* post(event, yield* token(false)).pipe(
      Effect.catchTag("Refused", (refused) =>
        refused.status === 401
          ? Effect.flatMap(token(true), (fresh) => post(event, fresh))
          : Effect.fail(refused),
      ),
      Effect.catchTags({
        Refused: ({ status, detail }) =>
          Effect.fail(
            new ShopifyAppEventsError({
              message: `App Events request refused: status=${String(status)}: ${detail.slice(0, 200)}`,
              cause: null,
            }),
          ),
        HttpClientError: appEventsError("App Events request failed"),
      }),
    );
  });

  return { send };
});

/**
 * Sends billing events to Shopify's App Events API.
 *
 * Separate from `ShopifyPartner` even though both talk to Shopify about
 * billing, because they are opposite directions with different credentials: the
 * Partner API *reads* an app subscription with a Partner API token, and this
 * *writes* usage with the app's own Client ID and Secret. Nothing here reads
 * anything back but the answer to each request.
 *
 * A Backend service the actor's runtime provides, as `ShopifyAdmin` is: the
 * outbox it drains is the actor's own table, and the events are per-order
 * facts only the actor knows about.
 */
export class ShopifyAppEvents extends Context.Service<
  ShopifyAppEvents,
  {
    /**
     * Posts one event and succeeds only on a 2xx.
     *
     * Success means Shopify received the request. A refusal Shopify can
     * name at once is a non-2xx with its reason (measured 2026-10-18: a shop
     * without the app is `403 not_installed`), carried in the error's
     * message. An event for an installed shop under a handle that matches no
     * meter still answers `202` (measured 2026-10-18) and shows up only in
     * the Dev Dashboard log. The caller deletes its outbox row on success for
     * that reason: there is nothing better to wait for.
     */
    readonly send: (event: UsageEvent) => Effect.Effect<void, ShopifyAppEventsError>;
  }
>()("app/ShopifyAppEvents") {
  /** Over literal credentials and a caller's `HttpClient`, for tests. */
  static readonly layerWith = (options: ShopifyAppEventsOptions) =>
    Layer.effect(ShopifyAppEvents, make(options));

  /**
   * Over `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (the `Shopify` binding) and
   * `SHOPIFY_APP_HANDLE`, with `fetch`. As `Shopify.layer`: absent while the
   * stack is planned, when nothing sends; a running Worker without them is
   * broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.String("SHOPIFY_API_KEY"));
      const apiSecret = yield* Config.option(Config.Redacted("SHOPIFY_API_SECRET"));
      const appHandle = yield* Config.option(Config.String("SHOPIFY_APP_HANDLE"));
      if (
        globalThis.__ALCHEMY_RUNTIME__ &&
        (Option.isNone(apiKey) || Option.isNone(apiSecret) || Option.isNone(appHandle))
      )
        return yield* Effect.die(
          new Error("the Shopify API key, secret and app handle are not bound"),
        );
      return ShopifyAppEvents.layerWith({
        apiKey: Option.getOrElse(apiKey, () => ""),
        apiSecret: Option.getOrElse(apiSecret, () => Redacted.make("")),
        appHandle: Option.getOrElse(appHandle, () => ""),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
