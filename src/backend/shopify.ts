// Registers the library's runtime adapter (fetch, crypto, headers) for workerd; imported once.
import "@shopify/shopify-api/adapters/web-api";
import {
  ApiVersion,
  GraphqlQueryError,
  HttpRequestError,
  HttpResponseError,
  HttpRetriableError,
  InvalidJwtError,
  RequestedTokenType,
  Session,
  shopifyApi,
  WebhookValidationErrorReason,
} from "@shopify/shopify-api";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { InvalidSessionToken, type AdminSession } from "../contract/shop.ts";
import { ShopKey, ShopSessionUpsert, type ShopSession } from "../domain/platform.ts";
import { OfflineSessionMissing, ReauthorizationRequired } from "../contract/shopify.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";

export { OfflineSessionMissing, ReauthorizationRequired };

/** The fake Shopify app's API key (its client ID), bound wherever Shopify CLI is not the parent. */
export const SHOPIFY_API_KEY = "fake-api-key";

/**
 * The fake Shopify app's API secret, bound beside {@link SHOPIFY_API_KEY}. A constant, so a test
 * signs a merchant's session token with it as Shopify would with the real app's; it protects
 * nothing, because no real app uses it.
 */
export const SHOPIFY_API_SECRET_FAKE = "fake-api-secret";

/**
 * How close to its expiry a stored access token may be and still be reused by
 * `authenticateAdmin`; nearer than this, the session token is exchanged again.
 */
const EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS = 30 * 1000;

/**
 * How close to its expiry a stored access token may be and still be returned by
 * `ensureShopSession`; nearer than this, a background caller refreshes it. Five minutes is enough
 * for the caller to finish its Admin calls before the token dies mid-job, and small beside the
 * token's one-hour life, so a refresh happens at most about once an hour per active shop.
 */
const BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * How close to its 90-day expiry a refresh token is treated as already expired, without calling
 * Shopify. The margin absorbs clock skew between this Worker and Shopify plus the grant's own
 * round trip, so a token that is valid when checked is still valid when Shopify reads it.
 */
const REFRESH_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

/**
 * In-place retries of a refresh grant that failed transiently (network, 429, 5xx). The presented
 * refresh token stays usable until its successor is used, so repeating the grant with the same
 * token is safe however many times the first attempt reached Shopify. The backoff
 * (`500 ms` exponential, jittered) totals about 3.5 s, inside {@link REFRESH_LEASE_MS}.
 */
const REFRESH_TOKEN_TRANSIENT_RETRIES = 3;

/**
 * How long one refresh may hold a shop's lease. It covers the worst refresh: the transient
 * backoff of {@link REFRESH_TOKEN_TRANSIENT_RETRIES} plus four round trips. A holder that dies
 * costs the shop at most this long; waiters re-evaluate once it lapses.
 */
const REFRESH_LEASE_MS = 10 * 1000;

/** The pause between reads of the row, jittered ±20%, by a lease waiter and by race recovery. */
const REFRESH_POLL_INTERVAL_MS = 300;

/**
 * Reads of the row `recoverRefreshRace` makes after a rejected refresh token, one poll interval
 * apart (about 1.8 s): long enough for a winner's Shopify round trip plus its D1 write to land.
 */
const REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES = 6;

/** Sleeps one jittered {@link REFRESH_POLL_INTERVAL_MS}. */
const pollDelay = Effect.flatMap(
  Random.nextBetween(REFRESH_POLL_INTERVAL_MS * 0.8, REFRESH_POLL_INTERVAL_MS * 1.2),
  (ms) => Effect.sleep(Duration.millis(ms)),
);

/**
 * Whether a stored row holds an access token that is still good for `buffer` ms at `now`. A
 * token with no recorded expiry is not fresh: every row comes from an `expiring: true`
 * exchange, so a missing expiry is a row not to trust, not a token that never expires.
 * Decided from the row's epoch-ms columns and the Effect clock, not `Session.isExpired`, which
 * reads `Date.now()`, so a test clock drives every branch.
 */
const hasFreshAccessToken = (row: ShopSession, now: number, buffer: number) =>
  row.accessToken !== null &&
  row.accessTokenExpiresAt !== null &&
  row.accessTokenExpiresAt - buffer > now;

/**
 * Shopify could not be reached: the transient retries of a refresh were exhausted (network,
 * 429, 5xx), or a wait for another caller's refresh timed out. The session may be fine. A caller
 * retries later: a webhook answers non-2xx, a Workflow step fails and is retried.
 */
export class ShopifyUnavailable extends Schema.TaggedError<ShopifyUnavailable>()(
  "ShopifyUnavailable",
  { shop: ShopKey, cause: Schema.Defect() },
) {}

/**
 * Shopify answered a refresh grant with 401: the refresh token is dead, or a concurrent
 * exchange or refresh retired it. Never leaves `ensureShopSession`, which looks for the winner.
 * Carries the presented refresh token, so it is never logged or exported.
 */
class RefreshTokenRejected extends Schema.TaggedError<RefreshTokenRejected>()(
  "RefreshTokenRejected",
  { shop: ShopKey, refreshToken: Schema.String },
) {}

/**
 * The Admin API answered 401 to the session's access token: it is dead, or a concurrent exchange
 * retired it. {@link ShopifyAdmin} clears the token and retries once.
 */
export class AdminUnauthorized extends Schema.TaggedError<AdminUnauthorized>()(
  "AdminUnauthorized",
  { shop: ShopKey },
) {}

/**
 * `validateWebhook` refused the request: 405 for a method other than POST, 401 for a bad HMAC,
 * 400 for anything else invalid (an empty body, a missing header, a shop domain that is not a
 * {@link ShopKey}, a body that is not JSON). The caller answers with `status` and nothing else.
 */
export class WebhookRejected extends Schema.TaggedError<WebhookRejected>()("WebhookRejected", {
  status: Schema.Literals([400, 401, 405]),
}) {}

/**
 * A webhook that passed `validateWebhook`. `topic` is the library's storage form
 * (`APP_UNINSTALLED`, `ORDERS_CREATE`), not the header's `app/uninstalled`.
 */
export interface ValidatedWebhook {
  readonly shop: ShopKey;
  readonly topic: string;
  readonly payload: unknown;
  readonly webhookId: string;
}

const decodeWebhookShop = Schema.decodeUnknownOption(ShopKey);
const decodeWebhookPayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Every way `ensureShopSession` fails; anything else is a defect. */
export type EnsureShopSessionError =
  | OfflineSessionMissing
  | ReauthorizationRequired
  | ShopifyUnavailable;

/** How a refresh grant failed. Order matters: `HttpRetriableError` extends `HttpResponseError`. */
const classifyGrantFailure = (failure: unknown) =>
  Match.value(failure).pipe(
    Match.when(Match.instanceOf(HttpRetriableError), () => "transient" as const),
    Match.when(Match.instanceOf(HttpResponseError), (error) =>
      Match.value(error.response.code).pipe(
        Match.when(401, () => "rejected" as const),
        Match.orElse(() => "failed" as const),
      ),
    ),
    // No response at all (a network failure), or a body that is not JSON (an edge's 502 page).
    Match.orElse(() => "transient" as const),
  );

/** The `error` field of a Shopify error body, for the log; the request body is never logged. */
const decodeErrorField = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

/**
 * A refreshed session with everything a stored pair needs. The library leaves the refresh token
 * unset when the response lacks `refresh_token_expires_in`, which would strand the shop, so a
 * missing field is a defect and the row stays as it was.
 */
const RefreshedSession = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires: Schema.Date,
  refreshToken: Schema.NonEmptyString,
  refreshTokenExpires: Schema.Date,
});
const decodeRefreshedSession = Schema.decodeUnknownEffect(RefreshedSession);

/** The claims `decodeSessionToken` hands on, as the library returns them. */
const DecodedClaims = Schema.Struct({ dest: Schema.String, exp: Schema.Number });
const decodeClaims = Schema.decodeUnknownEffect(DecodedClaims);

/** A shop domain from a session token's `dest` (`https://<shop>`). */
const ShopFromDest = Schema.URLFromString.pipe(
  Schema.decodeTo(
    ShopKey,
    SchemaTransformation.transform({
      decode: (url) => url.hostname,
      encode: (shop) => new URL(`https://${shop}`),
    }),
  ),
);
const decodeShopFromDest = Schema.decodeUnknownEffect(ShopFromDest);

/** Epoch ms in a row, a `Date` on the library's `Session`. */
const StoredExpiry = Schema.NullOr(Schema.DateFromMillis);
const decodeExpiry = Schema.decodeUnknownEffect(StoredExpiry);
const encodeExpiry = Schema.encodeUnknownEffect(StoredExpiry);

/** The query whose answer {@link ShopGidResponse} decodes. */
const SHOP_GID_QUERY = `#graphql
  query ShopGid {
    shop {
      id
    }
  }`;

/** The `shop { id }` answer, the shop's Admin API id. */
const ShopGidResponse = Schema.Struct({
  shop: Schema.Struct({ id: Schema.NonEmptyString }),
});
const decodeShopGidResponse = Schema.decodeUnknownEffect(ShopGidResponse);
const decodeUpsert = Schema.decodeUnknownEffect(ShopSessionUpsert);

/**
 * Shopify refused the session token in a token exchange: an HTTP 400 whose body names `invalid_subject_token`.
 */
const InvalidSubjectToken = Schema.Struct({
  code: Schema.Literal(400),
  body: Schema.Struct({ error: Schema.Literal("invalid_subject_token") }),
});
const isInvalidSubjectToken = Schema.is(InvalidSubjectToken);

/** A library call that may reject, its rejection kept as the defect's cause. */
const tryShopify = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause });

const make = (options: {
  readonly apiKey: string;
  readonly apiSecret: Redacted.Redacted<string>;
  readonly appUrl: string;
}) =>
  Effect.gen(function* () {
    const shopSessions = yield* ShopSessionRepository;
    // Built on first use, so planning the stack, where the bindings are absent, never builds it.
    const api = yield* Effect.cached(
      Effect.sync(() => {
        const { host, protocol } = new URL(options.appUrl);
        return shopifyApi({
          apiKey: options.apiKey,
          apiSecretKey: Redacted.value(options.apiSecret),
          hostName: host,
          hostScheme: protocol === "http:" ? "http" : "https",
          apiVersion: ApiVersion.October26,
          isEmbeddedApp: true,
          // Every future flag on, which silences the library's "Future flag X is disabled" log
          // on every isolate start; neither changes a path this app uses.
          future: { customerAddressDefaultFix: true, unstable_managedPricingSupport: true },
        });
      }),
    );
    const decodeSessionToken = Effect.fn("Shopify.decodeSessionToken")(
      function* (token: string) {
        const shopify = yield* api;
        const payload = yield* tryShopify(() => shopify.session.decodeSessionToken(token));
        return yield* decodeClaims(payload).pipe(Effect.orDie);
      },
      Effect.catch((cause) =>
        cause instanceof InvalidJwtError
          ? Effect.fail(new InvalidSessionToken())
          : Effect.die(cause),
      ),
    );

    /**
     * The shop a merchant's session token names (its `dest`), with no session read and no
     * exchange: what a merchant's call needs to find its shop's actor. A token that does not
     * verify is {@link InvalidSessionToken}.
     */
    const sessionTokenShop = Effect.fn("Shopify.sessionTokenShop")(function* (token: string) {
      const { dest } = yield* decodeSessionToken(token);
      return yield* decodeShopFromDest(dest).pipe(Effect.orDie);
    });

    /** A stored row as the library's offline `Session`. */
    const sessionOf = Effect.fn("Shopify.sessionOf")(function* (row: ShopSession) {
      const shopify = yield* api;
      const expires = yield* decodeExpiry(row.accessTokenExpiresAt).pipe(Effect.orDie);
      const refreshTokenExpires = yield* decodeExpiry(row.refreshTokenExpiresAt).pipe(Effect.orDie);
      return new Session({
        id: shopify.session.getOfflineId(row.shop),
        shop: row.shop,
        state: "",
        isOnline: false,
        scope: row.scope ?? undefined,
        expires: expires ?? undefined,
        accessToken: row.accessToken ?? undefined,
        refreshToken: row.refreshToken ?? undefined,
        refreshTokenExpires: refreshTokenExpires ?? undefined,
      });
    });

    /** The row, or {@link OfflineSessionMissing}. */
    const requireRow = (shop: ShopKey) =>
      shopSessions.find(shop).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new OfflineSessionMissing({ shop })),
            onSome: Effect.succeed,
          }),
        ),
      );

    /**
     * One refresh grant with `presented`. Transient failures (network, 429, 5xx, a body that is
     * not JSON) are retried in place with the same token; 401 is {@link RefreshTokenRejected};
     * any other status is a configuration defect, logged at Error with the status and Shopify's
     * `error` field.
     */
    const grant = Effect.fn("Shopify.grant")(function* (shop: ShopKey, presented: string) {
      const shopify = yield* api;
      return yield* tryShopify(() =>
        shopify.auth.refreshToken({ shop, refreshToken: presented }),
      ).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          times: REFRESH_TOKEN_TRANSIENT_RETRIES,
          while: (failure) => classifyGrantFailure(failure) === "transient",
        }),
        Effect.catch((failure) =>
          Match.value(classifyGrantFailure(failure)).pipe(
            Match.when("transient", () =>
              Effect.fail(new ShopifyUnavailable({ shop, cause: failure })),
            ),
            Match.when("rejected", () =>
              Effect.fail(new RefreshTokenRejected({ shop, refreshToken: presented })),
            ),
            Match.when("failed", () =>
              Effect.gen(function* () {
                const { code, body } =
                  failure instanceof HttpResponseError
                    ? failure.response
                    : { code: undefined, body: undefined };
                const reason = Option.match(decodeErrorField(body), {
                  onNone: () => "none",
                  onSome: ({ error }) => error,
                });
                yield* Effect.logError(
                  `Shopify.grant: refresh failed shop=${shop} status=${code} error=${reason}`,
                );
                return yield* Effect.die(failure);
              }),
            ),
            Match.exhaustive,
          ),
        ),
      );
    });

    /**
     * After a rejected refresh token: waits for a winner, a row whose refresh token is no longer
     * `rejected`, put there by a concurrent refresh or by an exchange that retired it. With none
     * after {@link REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES} polls, the token is dead; the row is
     * left as it is, so the next exchange repairs it.
     */
    const recoverRefreshRace = Effect.fn("Shopify.recoverRefreshRace")(function* (
      shop: ShopKey,
      rejected: string,
    ) {
      for (let attempt = 0; attempt <= REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES; attempt++) {
        if (attempt > 0) yield* pollDelay;
        const row = yield* requireRow(shop);
        if (row.refreshToken !== rejected) return yield* sessionOf(row);
      }
      yield* Effect.logWarning(`Shopify.recoverRefreshRace: shop=${shop} status=dead`);
      return yield* Effect.fail(
        new ReauthorizationRequired({
          shop,
          reason: "refresh-token-rejected",
          refreshTokenExpiresAt: null,
        }),
      );
    });

    /**
     * Runs the grant with `presented`, the lease holder's job: stores the new pair with a
     * compare-and-swap on `presented`. A lost swap means an exchange or a refresh stored a pair
     * first; that row is adopted. A 401 goes to {@link recoverRefreshRace}.
     */
    const refresh = Effect.fn("Shopify.refresh")(
      function* (row: ShopSession, presented: string) {
        const { shop } = row;
        const { session } = yield* grant(shop, presented);
        const refreshed = yield* decodeRefreshedSession(session).pipe(Effect.orDie);
        const tokens = {
          accessToken: refreshed.accessToken,
          accessTokenExpiresAt: refreshed.expires.getTime(),
          refreshToken: refreshed.refreshToken,
          refreshTokenExpiresAt: refreshed.refreshTokenExpires.getTime(),
        };
        const won = yield* shopSessions.rotateTokens(shop, presented, tokens);
        if (!won) return yield* sessionOf(yield* requireRow(shop));
        yield* Effect.log(`Shopify.ensureShopSession: refreshed shop=${shop}`);
        // `scope` is not rewritten by a refresh, so the stored scope stands.
        return yield* sessionOf({ ...row, ...tokens, refreshLeaseUntil: null });
      },
      Effect.catchTag("RefreshTokenRejected", (rejected) =>
        recoverRefreshRace(rejected.shop, rejected.refreshToken),
      ),
    );

    /**
     * Polls the row while another caller holds the refresh lease. Answers the session once the
     * refresh token differs from `presented` and the access token is fresh, and `None` once the
     * lease has lapsed with nothing fresh, when the caller should evaluate again. Gives up with
     * {@link ShopifyUnavailable} after the lease plus the recovery budget.
     */
    const waitForRefresh = Effect.fn("Shopify.waitForRefresh")(function* (
      shop: ShopKey,
      presented: string,
    ) {
      const deadline =
        (yield* Clock.currentTimeMillis) +
        REFRESH_LEASE_MS +
        REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES * REFRESH_POLL_INTERVAL_MS;
      for (;;) {
        yield* pollDelay;
        const row = yield* requireRow(shop);
        const now = yield* Clock.currentTimeMillis;
        if (
          row.refreshToken !== presented &&
          hasFreshAccessToken(row, now, BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS)
        )
          return Option.some(yield* sessionOf(row));
        if (row.refreshLeaseUntil === null || row.refreshLeaseUntil <= now) return Option.none();
        if (now >= deadline)
          return yield* Effect.fail(
            new ShopifyUnavailable({
              shop,
              cause: new Error("timed out waiting for another refresh of the shop"),
            }),
          );
      }
    });

    /** {@link ensureShopSession}; `takeovers` bounds how often a lapsed lease sends it round again. */
    const ensureWith: (
      shop: ShopKey,
      takeovers: number,
    ) => Effect.Effect<Session, EnsureShopSessionError> = Effect.fn("Shopify.ensureShopSession")(
      function* (shop: ShopKey, takeovers: number) {
        const row = yield* requireRow(shop);
        const now = yield* Clock.currentTimeMillis;
        if (hasFreshAccessToken(row, now, BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS))
          return yield* sessionOf(row);
        const { refreshToken, refreshTokenExpiresAt } = row;
        if (refreshToken === null || refreshTokenExpiresAt === null)
          return yield* Effect.fail(
            new ReauthorizationRequired({
              shop,
              reason: "no-refresh-token",
              refreshTokenExpiresAt: null,
            }),
          );
        if (refreshTokenExpiresAt - REFRESH_TOKEN_EXPIRY_BUFFER_MS <= now)
          return yield* Effect.fail(
            new ReauthorizationRequired({
              shop,
              reason: "refresh-token-expired",
              refreshTokenExpiresAt,
            }),
          );
        const until = now + REFRESH_LEASE_MS;
        if (yield* shopSessions.acquireRefreshLease(shop, now, until))
          return yield* refresh(row, refreshToken).pipe(
            Effect.ensuring(shopSessions.releaseRefreshLease(shop, until)),
          );
        const waited = yield* waitForRefresh(shop, refreshToken);
        if (Option.isSome(waited)) return waited.value;
        if (takeovers > 0) return yield* ensureWith(shop, takeovers - 1);
        return yield* Effect.fail(
          new ShopifyUnavailable({
            shop,
            cause: new Error("another refresh of the shop lapsed without a result"),
          }),
        );
      },
    );

    /**
     * A usable offline `Session` for `shop`, with no merchant
     * present. A stored access token with more than five minutes left is returned as it is;
     * otherwise it is refreshed through the `refresh_token` grant. At most one refresh per shop
     * runs at a time, serialized by the row's lease (Shopify asks for one store at a time, and
     * two grants from one token can leave one caller holding a token the other replaced); a
     * caller that finds the lease taken waits for the result. The write is a compare-and-swap,
     * so a concurrent exchange always wins over a refresh. A lease that lapses without a result
     * sends a waiter round once more before it gives up. Fails with {@link EnsureShopSessionError};
     * anything else is a defect. Callers never hold the returned session across calls, since
     * the next refresh retires its token.
     */
    const ensureShopSession = (shop: ShopKey) => ensureWith(shop, 1);

    /** The shop's Admin API id, asked for once, on first install. */
    const fetchShopGid = Effect.fn("Shopify.fetchShopGid")(function* (session: Session) {
      const shopify = yield* api;
      const client = new shopify.clients.Graphql({ session });
      const { data, errors } = yield* tryShopify(() =>
        client.request<unknown>(SHOP_GID_QUERY),
      ).pipe(Effect.orDie);
      if (errors !== undefined)
        return yield* Effect.die(new Error("shop { id } query failed", { cause: errors }));
      return (yield* decodeShopGidResponse(data).pipe(Effect.orDie)).shop.id;
    });

    /**
     * One Admin GraphQL call as `session`, answering the response's `data`. The library's client
     * throws rather than returning `errors`, so a 401 is {@link AdminUnauthorized}; 429, 5xx and a
     * failure to reach Shopify are {@link ShopifyUnavailable}; GraphQL errors and any other
     * status are defects. The client does no retrying: the caller owns that.
     */
    const adminRequest = Effect.fn("Shopify.adminRequest")(function* (
      shop: ShopKey,
      session: Session,
      query: string,
      variables: Record<string, unknown> | undefined,
    ) {
      const shopify = yield* api;
      const client = new shopify.clients.Graphql({ session });
      const { data } = yield* tryShopify(() => client.request<unknown>(query, { variables })).pipe(
        Effect.catch((failure) =>
          Match.value(failure).pipe(
            Match.when(Match.instanceOf(HttpRetriableError), () =>
              Effect.fail(new ShopifyUnavailable({ shop, cause: failure })),
            ),
            Match.when(Match.instanceOf(HttpRequestError), () =>
              Effect.fail(new ShopifyUnavailable({ shop, cause: failure })),
            ),
            Match.when(Match.instanceOf(HttpResponseError), (error) =>
              error.response.code === 401
                ? Effect.fail(new AdminUnauthorized({ shop }))
                : Effect.die(failure),
            ),
            Match.when(Match.instanceOf(GraphqlQueryError), () => Effect.die(failure)),
            Match.orElse(() => Effect.die(failure)),
          ),
        ),
      );
      return data;
    });

    /**
     * While the shop's refresh lease is live, polls the row until its access token is fresh for
     * the exchange's buffer or the lease lapses, which bounds the wait by the lease's remaining
     * time. Answers the latest row, or None if it was deleted meanwhile.
     */
    const waitForLeaseToEnd = Effect.fn("Shopify.waitForLeaseToEnd")(function* (shop: ShopKey) {
      for (;;) {
        yield* pollDelay;
        const found = yield* shopSessions.find(shop);
        if (Option.isNone(found)) return found;
        const now = yield* Clock.currentTimeMillis;
        const row = found.value;
        if (
          hasFreshAccessToken(row, now, EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS) ||
          row.refreshLeaseUntil === null ||
          row.refreshLeaseUntil <= now
        )
          return found;
      }
    });

    /**
     * Resolves a session token to a stored session, without the HTTP responses: the
     * Website turns `InvalidSessionToken` into App Bridge's retry or the session-token bounce.
     * A stored access token that is still fresh is reused and Shopify is not called; otherwise the
     * session token is exchanged for an expiring offline access token and the row upserted. Scope
     * is not compared, so a stored session stays reusable across a scope change until it expires.
     * Shopify forbids acquiring and refreshing a store's token at once, so while a refresh holds
     * the shop's lease this waits for it, up to the lease, and reuses its result if that is fresh.
     * An exchange retires every other token of the shop, so its write is unconditional and a
     * refresh's compare-and-swap write loses to it; it never takes the lease, so a merchant does
     * not queue behind a background job. Any failure other than a refused token is a defect.
     */
    const authenticateAdmin = Effect.fn("Shopify.authenticateAdmin")(
      function* (sessionToken: string) {
        const shop = yield* sessionTokenShop(sessionToken);
        const stored = yield* shopSessions.find(shop);
        const leased = yield* Effect.map(
          Clock.currentTimeMillis,
          (now) =>
            Option.isSome(stored) &&
            !hasFreshAccessToken(stored.value, now, EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS) &&
            stored.value.refreshLeaseUntil !== null &&
            stored.value.refreshLeaseUntil > now,
        );
        const existing = leased ? yield* waitForLeaseToEnd(shop) : stored;
        if (
          Option.isSome(existing) &&
          hasFreshAccessToken(
            existing.value,
            yield* Clock.currentTimeMillis,
            EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS,
          )
        )
          return { shop, shopGid: existing.value.shopGid } satisfies AdminSession;

        const shopify = yield* api;
        const { session } = yield* tryShopify(() =>
          shopify.auth.tokenExchange({
            shop,
            sessionToken,
            requestedTokenType: RequestedTokenType.OfflineAccessToken,
            expiring: true,
          }),
        ).pipe(
          Effect.catch((cause) =>
            cause instanceof InvalidJwtError ||
            (cause instanceof HttpResponseError && isInvalidSubjectToken(cause.response))
              ? Effect.fail(new InvalidSessionToken())
              : Effect.die(cause),
          ),
        );
        const shopGid = Option.isSome(existing)
          ? existing.value.shopGid
          : yield* fetchShopGid(session);
        const row = yield* decodeUpsert({
          shop,
          shopGid,
          shopActorId: shop,
          scope: session.scope ?? null,
          accessTokenExpiresAt: yield* encodeExpiry(session.expires ?? null),
          accessToken: session.accessToken ?? null,
          refreshToken: session.refreshToken ?? null,
          refreshTokenExpiresAt: yield* encodeExpiry(session.refreshTokenExpires ?? null),
        }).pipe(Effect.orDie);
        yield* shopSessions.upsert(row);
        yield* Effect.log(`Shopify.authenticateAdmin: exchanged shop=${shop}`);
        return { shop, shopGid } satisfies AdminSession;
      },
      Effect.catchTag("SchemaError", Effect.die),
    );

    /**
     * Verifies a webhook by HMAC over its raw body and parses it, or
     * fails with {@link WebhookRejected}. It reads no session: authenticity is the HMAC alone, and
     * a handler that needs the Admin API calls `ensureShopSession` itself, since a webhook is a
     * trigger to re-query Shopify, not a data feed. `request`'s body is read here, once.
     *
     * Every rejection logs at Debug, silent in deployed stages (minimum level Info). They are
     * the validator working: the URL is public and draws constant scanner traffic, so Info is
     * kept for validated events (`Webhook received`) and Warning would imply a fault of ours
     * on every spoof. A misconfigured secret, which fails every real delivery with 401, shows as
     * the absence of `Webhook received` lines and in Shopify's delivery-failure dashboard. If
     * spoof monitoring is ever wanted, raise only the 401 to Warning and accept the noise.
     */
    const validateWebhook = Effect.fn("Shopify.validateWebhook")(function* (request: Request) {
      if (request.method !== "POST") {
        yield* Effect.logDebug(
          "Received a non-POST request for a webhook. Only POST requests are allowed.",
        ).pipe(Effect.annotateLogs({ url: request.url, method: request.method }));
        return yield* new WebhookRejected({ status: 405 });
      }
      const shopify = yield* api;
      const rawBody = yield* tryShopify(() => request.text()).pipe(Effect.orDie);
      const validation = yield* tryShopify(() =>
        shopify.webhooks.validate({ rawBody, rawRequest: request }),
      ).pipe(Effect.orDie);
      if (!validation.valid) {
        const invalidHmac = validation.reason === WebhookValidationErrorReason.InvalidHmac;
        yield* Effect.logDebug(
          invalidHmac ? "Webhook HMAC validation failed" : "Webhook validation failed",
        ).pipe(Effect.annotateLogs({ ...validation }));
        return yield* new WebhookRejected({ status: invalidHmac ? 401 : 400 });
      }
      const shop = decodeWebhookShop(validation.domain);
      const payload = decodeWebhookPayload(rawBody);
      if (Option.isNone(shop) || Option.isNone(payload)) {
        yield* Effect.logDebug(
          `Webhook validation failed: the ${Option.isNone(shop) ? "shop domain" : "body"} does not decode`,
        ).pipe(Effect.annotateLogs({ topic: validation.topic, domain: validation.domain }));
        return yield* new WebhookRejected({ status: 400 });
      }
      return {
        shop: shop.value,
        topic: validation.topic,
        payload: payload.value,
        webhookId: validation.webhookId,
      } satisfies ValidatedWebhook;
    });

    return {
      validateWebhook,
      decodeSessionToken,
      sessionTokenShop,
      authenticateAdmin,
      ensureShopSession,
      adminRequest,
    };
  });

/**
 * The Backend's Shopify app, over `@shopify/shopify-api`. `decodeSessionToken` is the library's:
 * an HS256 signature under the app's API secret (`SHOPIFY_API_SECRET`), `aud` equal to the
 * app's API key (`SHOPIFY_API_KEY`), `exp` and `nbf` with ten seconds of clock tolerance.
 * `authenticateAdmin` exchanges a session token for the shop's offline access token and keeps it
 * in {@link ShopSessionRepository}. The key and secret are the real app's under `shopify app dev` and
 * fakes elsewhere ({@link SHOPIFY_API_SECRET_FAKE}), where only a token a test signs verifies and
 * the seeded rows stand in for exchanges.
 */
export class Shopify extends Context.Service<Shopify, Effect.Success<ReturnType<typeof make>>>()(
  "app/Shopify",
) {
  /** Over a literal key, secret and app URL, for tests. */
  static readonly layerWith = (options: Parameters<typeof make>[0]) =>
    Layer.effect(Shopify, make(options));

  /**
   * Over `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL`, which the stack binds to
   * the Backend. They are absent while the stack is planned, when nothing calls Shopify; a
   * running Worker without them is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.String("SHOPIFY_API_KEY"));
      const apiSecret = yield* Config.option(Config.Redacted("SHOPIFY_API_SECRET"));
      const appUrl = yield* Config.option(Config.String("SHOPIFY_APP_URL"));
      if (
        globalThis.__ALCHEMY_RUNTIME__ &&
        (Option.isNone(apiKey) || Option.isNone(apiSecret) || Option.isNone(appUrl))
      )
        return yield* Effect.die(
          new Error("the Shopify API key, secret and app URL are not bound"),
        );
      return Shopify.layerWith({
        apiKey: Option.getOrElse(apiKey, () => ""),
        apiSecret: Option.getOrElse(apiSecret, () => Redacted.make("")),
        appUrl: Option.getOrElse(appUrl, () => ""),
      });
    }),
  );
}
