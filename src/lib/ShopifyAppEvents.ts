import type * as Domain from "@/lib/Domain";

import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

export class ShopifyAppEventsError extends Schema.TaggedError<ShopifyAppEventsError>()(
  "ShopifyAppEventsError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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
const tokenBodyKeys = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? Object.keys(parsed).join(",")
      : typeof parsed;
  } catch {
    return "<not json>";
  }
};

/**
 * Only `access_token` is required, because only `access_token` is actually
 * returned. Shopify's tutorials document a body of
 * `{ access_token, scope, expires_in }`, but the live endpoint answered
 * `{ access_token, token_type }` on 2026-09-19 — no `scope`, no `expires_in`.
 * Requiring the documented shape fails every mint, so the lifetime falls back
 * to {@link TOKEN_DEFAULT_LIFETIME_MS}, and an `expires_in` that does appear is
 * honoured.
 */
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  /** Seconds, when present. */
  expires_in: Schema.optional(Schema.NullOr(Schema.Number)),
});

/**
 * Sends billing events to Shopify's App Events API.
 *
 * Separate from `ShopifyPartner` even though both talk to Shopify about
 * billing, because they are opposite directions with different credentials:
 * the Partner API *reads* a contract with a Partner API token, and this
 * *writes* usage with the app's own Client ID and Secret. Nothing here reads
 * anything back — the API answers `202` to an event it will later refuse, so
 * the only confirmation that exists is the metered quantity the Partner client
 * reads on the next revalidation.
 *
 * Lives in the Durable Object's layer rather than the Worker's: the outbox it
 * drains is the object's own table, and the events are per-order facts the
 * object is the only one to know about.
 */
export class ShopifyAppEvents extends Context.Service<
  ShopifyAppEvents,
  {
    /**
     * Posts one event and succeeds only on a 2xx.
     *
     * Success means Shopify received the request, never that the event was
     * billable: a handle that matches no meter, a timestamp outside the cycle,
     * and a shop with no contract all answer `202` and show up only in the Dev
     * Dashboard log. The caller deletes its outbox row on success for that
     * reason — there is nothing better to wait for — and the divergence check
     * against the metered quantity is what catches the rest.
     */
    readonly send: (
      event: Domain.UsageEvent,
    ) => Effect.Effect<void, ShopifyAppEventsError>;
  }
>()("ShopifyAppEvents") {
  static readonly layerNoDeps = Layer.effect(
    ShopifyAppEvents,
    Effect.gen(function* () {
      const { apiKey, apiSecret, apiVersion, appHandle } = yield* Config.all({
        apiKey: Config.nonEmptyString("SHOPIFY_API_KEY"),
        apiSecret: Config.nonEmptyString("SHOPIFY_API_SECRET").pipe(
          Config.map(Redacted.make),
        ),
        apiVersion: Config.nonEmptyString("SHOPIFY_APP_EVENTS_API_VERSION"),
        appHandle: Config.nonEmptyString("SHOPIFY_APP_HANDLE"),
      });
      const endpoint = `https://api.shopify.com/app/${apiVersion}/events`;

      /**
       * `User-Agent` is mandatory, not cosmetic. Cloudflare Workers' `fetch`
       * sends none, and `api.shopify.com` answers a request without one with a
       * `403` and an HTML body from its edge — before the API sees the
       * credentials at all. Measured against the live endpoint on 2026-09-19:
       * identical request with a UA `400`s on the merits, without one `403`s.
       * The handle is in it so the requests are attributable in Shopify's logs.
       */
      const baseClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader("User-Agent", `Baton/${appHandle}`),
        ),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        HttpClient.retryTransient({
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          times: 2,
        }),
      );
      /** The token endpoint's refusals are read, not thrown; see {@link mintToken}. */
      const tokenClient = baseClient;
      const client = baseClient.pipe(HttpClient.filterStatusOk);

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

      /**
       * The cached bearer token and when it stops being usable. One token per
       * object instance is right: it authenticates the *app*, not a shop, and
       * the object is single-threaded, so there is no race to guard and nothing
       * shop-specific to leak between cycles.
       */
      const cached = yield* Ref.make<{
        readonly token: string;
        readonly expiresAt: number;
      } | null>(null);

      /**
       * Deliberately not behind `filterStatusOk`: this endpoint answers a
       * refusal with `{ error, error_description }`, and that body is the whole
       * diagnosis — a bare "403" cannot tell an operator whether the app lacks
       * the App Events grant, the secret has rotated, or the credentials are
       * for the wrong app. The body carries no secret, only Shopify's reason.
       */
      const mintToken = Effect.fn("ShopifyAppEvents.mintToken")(function* () {
        const raw = yield* HttpClientRequest.post(TOKEN_ENDPOINT).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: apiKey,
            client_secret: Redacted.value(apiSecret),
            grant_type: "client_credentials",
          }),
          tokenClient.execute,
          Effect.mapError(appEventsError("App Events token request failed")),
        );
        if (raw.status < 200 || raw.status >= 300) {
          const detail = yield* raw.text.pipe(
            Effect.orElseSucceed(() => "<unreadable body>"),
          );
          return yield* new ShopifyAppEventsError({
            message: `App Events token request refused: status=${String(raw.status)}: ${detail.slice(0, 200)}`,
            cause: null,
          });
        }
        const response = yield* HttpClientResponse.schemaBodyJson(
          TokenResponse,
        )(raw).pipe(
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

      const token = Effect.fn("ShopifyAppEvents.token")(function* (
        force: boolean,
      ) {
        const entry = yield* Ref.get(cached);
        const now = yield* Clock.currentTimeMillis;
        return entry === null ||
          force ||
          entry.expiresAt - TOKEN_REFRESH_SKEW_MS <= now
          ? yield* mintToken()
          : entry.token;
      });

      const post = (event: Domain.UsageEvent, bearer: string) =>
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${bearer}`),
          HttpClientRequest.bodyJsonUnsafe({
            shop_id: event.shopGid,
            event_handle: event.eventHandle,
            timestamp: new Date(event.occurredAt).toISOString(),
            idempotency_key: event.idempotencyKey,
            attributes: { value: event.value },
          }),
          client.execute,
          Effect.asVoid,
        );

      const send = Effect.fn("ShopifyAppEvents.send")(function* (
        event: Domain.UsageEvent,
      ) {
        yield* Effect.annotateCurrentSpan({
          eventHandle: event.eventHandle,
          idempotencyKey: event.idempotencyKey,
        });
        // One retry on a fresh token, and only on a fresh token: a `401` is the
        // one failure a caller can fix by trying again immediately, because it
        // means the cached token was revoked or expired early rather than that
        // the event was wrong. Every other status is left to `retryTransient`
        // and then to the caller's outbox.
        yield* post(event, yield* token(false)).pipe(
          Effect.catchTag("HttpClientError", (error) =>
            error.response?.status === 401
              ? Effect.flatMap(token(true), (fresh) => post(event, fresh))
              : Effect.fail(error),
          ),
          Effect.mapError(appEventsError("App Events request failed")),
        );
      });

      return ShopifyAppEvents.of({ send });
    }),
  );
}
