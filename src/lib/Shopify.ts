import "@shopify/shopify-api/adapters/web-api";
import type { Cause } from "effect";
import type { SqlError } from "effect/unstable/sql";

import * as ShopifyApi from "@shopify/shopify-api";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { causeToErrorMessage } from "@/lib/LayerEx";
import { Repository, type RepositoryError } from "@/lib/Repository";
import { APP_BRIDGE_URL, CDN_URL, POLARIS_URL } from "@/lib/shopifyConstants";

interface ShopifyConfig {
  readonly apiKey: Redacted.Redacted;
  readonly apiSecretKey: Redacted.Redacted;
  readonly appUrl: string;
  /**
   * The three deployment targets the code branches on, independent of which
   * ones `wrangler.jsonc` currently defines — `Env["ENVIRONMENT"]` narrows to
   * whatever is configured today, which would make adding a staging env a type
   * error here rather than a config change.
   */
  readonly environment: "local" | "staging" | "production";
}

export class ShopifyError extends Schema.TaggedError<ShopifyError>()(
  "ShopifyError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ResponseError extends Schema.TaggedError<ResponseError>()(
  "ResponseError",
  {
    response: Schema.instanceOf(Response),
  },
) {}

export class RefreshTokenExpiredError extends Schema.TaggedError<RefreshTokenExpiredError>()(
  "RefreshTokenExpiredError",
  {
    shop: Schema.String,
    refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

class RefreshTokenRejectedError extends Schema.TaggedError<RefreshTokenRejectedError>()(
  "RefreshTokenRejectedError",
  {
    shop: Schema.String,
    refreshToken: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class OfflineSessionNotFoundError extends Schema.TaggedError<OfflineSessionNotFoundError>()(
  "OfflineSessionNotFoundError",
  {
    shop: Schema.String,
  },
) {}

export class OfflineSessionInvalidError extends Schema.TaggedError<OfflineSessionInvalidError>()(
  "OfflineSessionInvalidError",
  {
    shop: Schema.String,
    sessionId: Schema.String,
  },
) {}

interface ShopifyService {
  readonly config: ShopifyConfig;
  readonly authenticateAdmin: Effect.Effect<
    { readonly session: ShopifyApi.Session; readonly shopGid: Domain.ShopGid },
    SqlError.SqlError | RepositoryError | ShopifyError | ResponseError,
    CurrentRequest
  >;
  readonly decodeSessionToken: (
    token: string,
  ) => Effect.Effect<ShopifyApi.JwtPayload, ShopifyError | ResponseError>;
  readonly withShopifyDocumentHeaders: (
    request: Request,
    response: Response,
  ) => Effect.Effect<Response>;
  readonly validateWebhook: (request: Request) => Effect.Effect<
    {
      readonly shop: Domain.Shop;
      readonly topic: string;
      readonly payload: unknown;
      /**
       * `X-Shopify-Webhook-Id`. Shopify retries a delivery 8 times over 4 hours
       * and warns the same webhook may arrive more than once, so a handler that
       * is not naturally idempotent needs this to dedupe. The library surfaces
       * it but does no deduping itself.
       */
      readonly webhookId: string;
      /**
       * `X-Shopify-Triggered-At` as epoch milliseconds, or `null` when the
       * header is absent or unparseable. Deliveries are unordered, and retries
       * replay the original payload, so this is when the event happened — not
       * when it was received.
       */
      readonly triggeredAt: number | null;
    },
    Schema.SchemaError | ShopifyError | ResponseError
  >;
  readonly authenticateFlowAction: (request: Request) => Effect.Effect<
    {
      readonly shop: Domain.Shop;
      readonly payload: unknown;
    },
    Schema.SchemaError | ShopifyError | ResponseError
  >;
  readonly storeShopSession: (
    session: ShopifyApi.Session,
    shopGid: Domain.ShopGid,
  ) => Effect.Effect<void, SqlError.SqlError | ShopifyError>;
  readonly deleteShopSession: (
    shop: Domain.ShopSession["shop"],
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly updateShopSessionScope: ({
    shop,
    scope,
  }: Pick<Domain.ShopSession, "shop" | "scope">) => Effect.Effect<
    void,
    SqlError.SqlError
  >;
  readonly graphql: (
    session: ShopifyApi.Session,
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) => Effect.Effect<
    {
      readonly data?: unknown;
      readonly errors?: { readonly message?: string };
    },
    ShopifyError
  >;
  readonly refreshShopSession: (
    shop: Domain.Shop,
    refreshToken: string,
  ) => Effect.Effect<
    ShopifyApi.Session,
    SqlError.SqlError | ShopifyError | RefreshTokenRejectedError
  >;
  readonly recoverRefreshRace: (
    shop: Domain.Shop,
    rejectedRefreshToken: string,
    cause?: unknown,
  ) => Effect.Effect<
    ShopifyApi.Session,
    | SqlError.SqlError
    | RepositoryError
    | ShopifyError
    | RefreshTokenExpiredError
  >;
  readonly loadShopSession: (shop: Domain.Shop) => Effect.Effect<
    Option.Option<{
      readonly session: ShopifyApi.Session;
      readonly shopGid: Domain.ShopGid;
    }>,
    SqlError.SqlError | RepositoryError | ShopifyError
  >;
  readonly refreshShopSessionIfExpired: (
    session: ShopifyApi.Session,
  ) => Effect.Effect<
    ShopifyApi.Session,
    | SqlError.SqlError
    | RepositoryError
    | ShopifyError
    | OfflineSessionInvalidError
    | RefreshTokenExpiredError
  >;
  readonly ensureShopSession: (
    shop: Domain.Shop,
  ) => Effect.Effect<
    ShopifyApi.Session,
    | SqlError.SqlError
    | RepositoryError
    | OfflineSessionNotFoundError
    | ShopifyError
    | OfflineSessionInvalidError
    | RefreshTokenExpiredError
  >;
  readonly sessionIdFromShop: (
    shop: Domain.ShopSession["shop"],
  ) => Effect.Effect<Domain.SessionId, ShopifyError>;
}

const EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS = 30 * 1000;
const BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
/**
 * Skips a `refresh_token` grant when the refresh token is within this window of
 * its ~90-day expiry, failing `RefreshTokenExpiredError` proactively instead.
 *
 * The proactive check compares Shopify's `refreshTokenExpires` against our local
 * `Clock`. At the boundary, clock skew (our worker vs Shopify) plus the in-flight
 * latency of the grant POST can make Shopify reject an "almost valid" token as
 * expired (`401 invalid_request`). The buffer turns that nondeterministic
 * network race into a clean, typed failure. Sized to cover worst-case skew plus
 * one request round-trip; the cost is negligible because refreshes rotate the
 * token forward ~90 days on every call, so reaching this window at all means the
 * shop has been dormant ~90 days and must re-launch regardless. Tokens that
 * expire between checks are still caught reactively via `RefreshTokenRejectedError`
 * → `recoverRefreshRace`.
 */
const REFRESH_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const REFRESH_TOKEN_TRANSIENT_RETRIES = 3;
/**
 * `recoverRefreshRace` re-reads D1 looking for a refresh winner (a concurrent
 * token exchange or refresh that rotated and stored a new session). The winner
 * is a Shopify round trip plus a D1 write, which plausibly exceeds a second, so
 * the budget (retries × schedule below) must outlast it or the loser gives up
 * before the winner writes and reports a live token as expired. ~1.8s.
 */
const REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES = 6;
const REJECTED_REFRESH_TOKEN_RECOVERY_INTERVAL = "300 millis";
const StoredSessionExpiry = Schema.NullOr(Schema.DateFromMillis);

/**
 * Local `shopify app dev` injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and
 * `HOST`/`APP_URL` into the `shopify.web.toml` dev process. This repo relies on
 * that injection for local dev, so `.env` should not define blank placeholders
 * for those keys because `pnpm dev` sources `.env` into the shell first.
 */
const shopifyConfig = Config.all({
  apiKey: Config.nonEmptyString("SHOPIFY_API_KEY").pipe(
    Config.map(Redacted.make),
  ),
  apiSecretKey: Config.nonEmptyString("SHOPIFY_API_SECRET").pipe(
    Config.map(Redacted.make),
  ),
  appUrl: Config.nonEmptyString("SHOPIFY_APP_URL").pipe(
    Config.orElse(() => Config.nonEmptyString("APP_URL")),
    Config.orElse(() => Config.nonEmptyString("HOST")),
    Config.map((value) =>
      value.startsWith("http://") || value.startsWith("https://")
        ? value
        : `https://${value}`,
    ),
  ),
  environment: Config.literals(
    ["local", "staging", "production"],
    "ENVIRONMENT",
  ).pipe(Config.withDefault("local")),
});

const makeShopifyApi = ({
  apiKey,
  apiSecretKey,
  appUrl,
  environment,
}: ShopifyConfig) => {
  const { host, protocol } = new URL(appUrl);
  return ShopifyApi.shopifyApi({
    apiKey: Redacted.value(apiKey),
    apiSecretKey: Redacted.value(apiSecretKey),
    hostName: host,
    hostScheme: protocol.replace(":", "") as "http" | "https",
    apiVersion: ShopifyApi.ApiVersion.July26,
    isEmbeddedApp: true,
    logger:
      environment === "local"
        ? undefined
        : { level: ShopifyApi.LogSeverity.Warning },
    // Opt into all future flags to silence the "Future flag X is disabled"
    // INFO logs that fire on every isolate boot. customerAddressDefaultFix
    // switches CustomerAddress to `is_default` (no callers in this app);
    // unstable_managedPricingSupport is needed for Shopify App Pricing to
    // allow billing.check() without a billing config. No-op until wired up.
    future: {
      customerAddressDefaultFix: true,
      unstable_managedPricingSupport: true,
    },
  });
};

const shopifyErrorFromCause = (cause: unknown) =>
  new ShopifyError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const tryShopify = <A>(evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: shopifyErrorFromCause });

const tryShopifyPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: shopifyErrorFromCause });

const decodeShopify =
  <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((cause) => new ShopifyError({ message, cause })),
    );

const encodeSessionExpiry = (value: Date | undefined, message: string) =>
  Schema.encodeEffect(StoredSessionExpiry)(value ?? null).pipe(
    Effect.mapError((cause) => new ShopifyError({ message, cause })),
  );

const decodeSessionExpiry = (value: number | null, message: string) =>
  decodeShopify(StoredSessionExpiry, message)(value);

const isInvalidSubjectTokenError = (error: ShopifyError) =>
  error.cause instanceof ShopifyApi.HttpResponseError &&
  (error.cause.response as { readonly code?: number }).code === 400 &&
  (
    error.cause.response as {
      readonly body?: { readonly error?: string } | null;
    }
  ).body?.error === "invalid_subject_token";

/**
 * Classifies a `refresh_token` grant failure as a definitive rejection to route
 * into `recoverRefreshRace`, as opposed to a transient failure to retry.
 *
 * Shopify's documented rejection is `401 invalid_request` ("This request
 * requires an active refresh_token"), but the grant can also surface
 * `400 invalid_subject_token` (library shape) or `invalid_grant` (90-day expiry
 * / revoked). Rather than match one wire string, match the class: any
 * non-transient HTTP response. `HttpThrottlingError` (429) and
 * `HttpInternalError` (5xx) both extend `HttpRetriableError`, which extends
 * `HttpResponseError` (refs/shopify-app-js/packages/apps/shopify-api/lib/error.ts),
 * so `instanceof HttpResponseError` alone would wrongly capture 429/5xx —
 * excluding `HttpRetriableError` is what separates a rejection from a transient.
 * `recoverRefreshRace` self-validates against D1, so a spurious match costs one
 * read while a missed rejection strands the shop until a merchant relaunches.
 */
const isRefreshTokenRejected = (error: ShopifyError) =>
  error.cause instanceof ShopifyApi.HttpResponseError &&
  !(error.cause instanceof ShopifyApi.HttpRetriableError);

/**
 * A `refresh_token` grant failure that must be retried with the *same* refresh
 * token: network errors and timeouts (no `HttpResponseError`) plus `429`/`5xx`
 * (`HttpRetriableError`). Within Shopify's 1-hour replay window a retried
 * refresh returns the same rotated pair, so retrying is safe and idempotent.
 */
const isTransientRefreshError = (error: ShopifyError) =>
  error.cause instanceof ShopifyApi.HttpRetriableError ||
  !(error.cause instanceof ShopifyApi.HttpResponseError);

const setShopifyDocumentHeaders = (headers: Headers, shop: Domain.Shop) => {
  headers.set(
    "Link",
    `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
  );
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors https://${shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;`,
  );
};

const buildDocumentResponseHeaders = (shop: Domain.Shop | null) => {
  const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
  if (shop) {
    setShopifyDocumentHeaders(headers, shop);
  }
  return headers;
};

/**
 * Identifies TanStack's browser RPC transport before applying Shopify's
 * no-bearer document heuristic. The header is only a control-flow hint, never
 * authentication: a caller can forge it, but doing so only selects a 401 over
 * an HTML recovery response. SSR server functions do not carry this header
 * because they execute directly under the outer document request.
 */
const isTanStackServerFnRequest = (request: Request) =>
  request.headers.get("x-tsr-serverFn") === "true";

/**
 * Returns the smallest document App Bridge can use to reconnect an embedded
 * frame to its Admin parent. It serves both the explicit session-token bounce
 * and a full reload of a clean SPA URL that no longer carries embed params.
 */
const renderAppBridgePage = (
  apiKey: string,
  shop: Domain.Shop | null,
): Response =>
  new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script data-api-key="${apiKey}" src="${APP_BRIDGE_URL}"></script></head><body></body></html>`,
    { headers: buildDocumentResponseHeaders(shop) },
  );

/**
 * Resolves an unauthenticated top-level navigation target without turning the
 * exit route into an open redirect. Baton only needs its own origin for return
 * legs and Shopify Admin's App Pricing path for billing. Credentials are
 * rejected so the rendered URL cannot disguise a different authority.
 */
const parseExitIframeDestination = (
  appUrl: string,
  destination: string,
): URL | null => {
  try {
    const url = new URL(destination, appUrl);
    const appOrigin = new URL(appUrl).origin;
    const isAppDestination = url.origin === appOrigin;
    const isPricingDestination =
      url.origin === "https://admin.shopify.com" &&
      /^\/store\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/charges\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/pricing_plans$/u.test(
        url.pathname,
      ) &&
      !url.search &&
      !url.hash;
    return !url.username &&
      !url.password &&
      (isAppDestination || isPricingDestination)
      ? url
      : null;
  } catch {
    return null;
  }
};

/**
 * Escapes `<` in JSON embedded in a classic script. JavaScript string escaping
 * alone is insufficient because the HTML parser recognizes `</script>` before
 * the JavaScript parser sees the quoted value.
 */
const inlineScriptString = (value: string) =>
  JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

const renderExitIframePage = (
  apiKey: string,
  shop: Domain.Shop | null,
  destination: URL,
): Response =>
  new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script data-api-key="${apiKey}" src="${APP_BRIDGE_URL}"></script><script>window.open(${inlineScriptString(destination.toString())}, "_top")</script></head><body></body></html>`,
    { headers: buildDocumentResponseHeaders(shop) },
  );

/**
 * Per-request inputs shared by the `authenticateAdminRequest` stages, derived
 * once by `adminAuthContext`.
 *
 * `shop`/`host` are sanitized query params or `null`; missing or invalid embed
 * context is recoverable and must not throw while this value is built.
 * `sessionToken` prefers the `Authorization` bearer token over the `id_token`
 * query param. `isServerFnRequest` recognizes TanStack's browser transport;
 * `isDocumentRequest` is the remaining no-bearer request shape that may use
 * Shopify's document bounce and App Bridge recovery paths.
 */
interface AdminAuthContext {
  readonly request: Request;
  readonly url: URL;
  readonly shop: Domain.Shop | null;
  readonly host: string | null;
  readonly headerSessionToken: string | undefined;
  readonly searchParamSessionToken: string | null;
  readonly sessionToken: string | null;
  readonly isServerFnRequest: boolean;
  readonly isDocumentRequest: boolean;
}

/**
 * Log for `authenticateAdminRequest` decision points. The message carries the
 * `event` (plus `shop=` when known) for human scanning; the annotations carry
 * the request-shape booleans and any `extra` fields for querying, per the
 * logging conventions.
 *
 * Warning, not Debug, so these survive the deployed log floor (Info off
 * local). A successful authentication emits nothing here, so every line is an
 * auth request that failed or required recovery. Raw URLs are deliberately
 * excluded because document queries can contain `id_token` and server-function
 * queries can contain serialized application input.
 */
const logAuth = (
  ctx: AdminAuthContext,
  event: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  Effect.logWarning(
    ctx.shop
      ? `Shopify.authenticateAdminRequest: event=${event} shop=${ctx.shop}`
      : `Shopify.authenticateAdminRequest: event=${event}`,
  ).pipe(
    Effect.annotateLogs({
      event,
      pathname: ctx.url.pathname,
      method: ctx.request.method,
      hasAuthorizationHeader: Boolean(ctx.headerSessionToken),
      hasShop: Boolean(ctx.shop),
      hasHost: Boolean(ctx.host),
      hasIdToken: Boolean(ctx.searchParamSessionToken),
      isServerFnRequest: ctx.isServerFnRequest,
      isDocumentRequest: ctx.isDocumentRequest,
      isNavigationRequest:
        ctx.request.headers.get("sec-fetch-mode") === "navigate",
      ...extra,
    }),
  );

export class Shopify extends Context.Service<Shopify, ShopifyService>()(
  "Shopify",
) {
  static readonly layerNoDeps: Layer.Layer<
    Shopify,
    Config.ConfigError,
    Repository | Env
  > = Layer.effect(
    Shopify,
    Effect.gen(function* () {
      const repository = yield* Repository;
      const env = yield* CloudflareEnv;
      const config = yield* shopifyConfig;
      const shopify = makeShopifyApi(config);
      const storeShopSession = Effect.fn("Shopify.storeShopSession")(function* (
        session: ShopifyApi.Session,
        shopGid: Domain.ShopGid,
      ) {
        const accessTokenExpiresAt = yield* encodeSessionExpiry(
          session.expires,
          "Invalid access token expiry",
        );
        const refreshTokenExpiresAt = yield* encodeSessionExpiry(
          session.refreshTokenExpires,
          "Invalid refresh token expiry",
        );
        yield* decodeShopify(
          Domain.ShopSession,
          "Invalid shop session payload",
        )({
          shop: session.shop,
          shopGid,
          shopAgentId: env.SHOP_AGENT.idFromName(session.shop).toString(),
          scope: session.scope ?? null,
          accessTokenExpiresAt,
          accessToken: session.accessToken ?? null,
          refreshToken: session.refreshToken ?? null,
          refreshTokenExpiresAt,
          planHandle: null,
          planHandleExpiresAt: null,
        }).pipe(Effect.flatMap(repository.upsertShopSession));
      });

      /**
       * On 401 from Shopify, clears `session.accessToken` and re-stores the row.
       * This does not rescue the current request — the 401 still propagates as
       * `ShopifyError` — but it forces the next `authenticateAdmin` browser
       * request to see `isActive() === false` and fall through to token exchange
       * instead of re-using the dead token. Mirrors the template's
       * `handleClientError` → `invalidateAccessToken` path.
       *
       * Store failures during invalidation are swallowed so the original 401
       * always propagates — matches the template's "invalidate best-effort,
       * always throw the upstream error" behavior.
       */
      const graphql = Effect.fn("Shopify.graphql")(function* (
        session: ShopifyApi.Session,
        query: string,
        options?: { readonly variables?: Record<string, unknown> },
      ) {
        const client = new shopify.clients.Graphql({ session });
        const result = yield* Effect.tryPromise({
          try: () =>
            client.request<unknown>(query, { variables: options?.variables }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tapError((cause) =>
            cause instanceof ShopifyApi.HttpResponseError &&
            // oxlint loses HttpResponseError's default response generic after instanceof narrowing.
            // eslint-disable-next-line typescript-eslint/no-unsafe-member-access
            cause.response.code === 401
              ? Effect.gen(function* () {
                  session.accessToken = undefined;
                  yield* Effect.ignore(
                    Schema.decodeUnknownEffect(Domain.Shop)(session.shop).pipe(
                      Effect.flatMap(repository.clearShopSessionAccessToken),
                    ),
                  );
                })
              : Effect.void,
          ),
          Effect.mapError(shopifyErrorFromCause),
        );
        return result;
      });

      const fetchShopGid = Effect.fn("Shopify.fetchShopGid")(function* (
        session: ShopifyApi.Session,
      ) {
        const { data, errors } = yield* graphql(
          session,
          `
            #graphql
            query ShopGid {
              shop {
                id
              }
            }
          `,
        );
        if (errors)
          return yield* Effect.fail(
            new ShopifyError({
              message: "shop { id } query failed",
              cause: errors,
            }),
          );
        return (yield* decodeShopify(
          Schema.Struct({ shop: Schema.Struct({ id: Domain.ShopGid }) }),
          "Invalid shop { id } response",
        )(data)).shop.id;
      });

      const deleteShopSession = Effect.fn("Shopify.deleteShopSession")(
        (shop: Domain.ShopSession["shop"]) =>
          repository.deleteShopSession(shop),
      );

      const updateShopSessionScope = Effect.fn(
        "Shopify.updateShopSessionScope",
      )(function* ({
        shop,
        scope,
      }: Pick<Domain.ShopSession, "shop" | "scope">) {
        yield* repository.updateShopSessionScope(shop, scope);
      });

      /**
       * Rotates the offline session via the `refresh_token` grant. Partitions
       * every grant failure into the two classes Shopify's contract defines:
       * transient failures (`isTransientRefreshError`) are retried in place with
       * the same token — safe under the 1-hour replay window — while a
       * definitive rejection (`isRefreshTokenRejected`) becomes
       * `RefreshTokenRejectedError` for `recoverRefreshRace` to adjudicate. An
       * exhausted transient (network/`5xx`/`429` that never recovers) escapes as
       * `ShopifyError`; the caller's outer retry (Flow resend) is the backstop.
       */
      const refreshShopSession = Effect.fn("Shopify.refreshShopSession")(
        function* (shop: Domain.Shop, refreshToken: string) {
          const { session } = yield* tryShopifyPromise(() =>
            shopify.auth.refreshToken({ shop, refreshToken }),
          ).pipe(
            Effect.retry({
              while: isTransientRefreshError,
              times: REFRESH_TOKEN_TRANSIENT_RETRIES,
              schedule: Schedule.exponential("500 millis").pipe(
                Schedule.jittered,
              ),
            }),
            Effect.catchIf(isRefreshTokenRejected, (error) =>
              Effect.fail(
                new RefreshTokenRejectedError({
                  shop,
                  refreshToken,
                  cause: error.cause,
                }),
              ),
            ),
          );
          const accessTokenExpiresAt = yield* encodeSessionExpiry(
            session.expires,
            "Invalid refreshed access token expiry",
          );
          const refreshTokenExpiresAt = yield* encodeSessionExpiry(
            session.refreshTokenExpires,
            "Invalid refreshed refresh token expiry",
          );
          yield* repository.updateShopSessionTokens({
            shop,
            accessToken: session.accessToken ?? null,
            accessTokenExpiresAt,
            refreshToken: session.refreshToken ?? null,
            refreshTokenExpiresAt,
          });
          return session;
        },
      );

      /**
       * Loads the offline session for a shop and rehydrates it into a library
       * `ShopifyApi.Session`, returning `Option.none()` when no row exists.
       *
       * D1 keys sessions by `shop` (one offline session per shop) and no longer
       * stores the synthetic `id` column, but `ShopifyApi.Session` still requires
       * an `id`, so it is synthesized as `offline_${shop}` via `sessionIdFromShop`
       * before `fromPropertyArray`. `shopGid` is returned alongside the session
       * (it also rides along as an ignored extra property on the rehydrated
       * `Session`). A row that fails to rehydrate is treated as absent.
       */
      const loadShopSession = Effect.fn("Shopify.loadShopSession")(function* (
        shop: Domain.Shop,
      ) {
        const stored = yield* repository.findShopSession(shop);
        if (Option.isNone(stored)) return Option.none();
        const id = yield* sessionIdFromShop(shop);
        const expires = yield* decodeSessionExpiry(
          stored.value.accessTokenExpiresAt,
          "Invalid stored access token expiry",
        );
        const refreshTokenExpires = yield* decodeSessionExpiry(
          stored.value.refreshTokenExpiresAt,
          "Invalid stored refresh token expiry",
        );
        return yield* tryShopify(
          () =>
            new ShopifyApi.Session({
              id,
              shop: stored.value.shop,
              state: "",
              isOnline: false,
              scope: stored.value.scope ?? undefined,
              expires: expires ?? undefined,
              accessToken: stored.value.accessToken ?? undefined,
              refreshToken: stored.value.refreshToken ?? undefined,
              refreshTokenExpires: refreshTokenExpires ?? undefined,
            }),
        ).pipe(
          Effect.map((session) =>
            Option.some({ session, shopGid: stored.value.shopGid }),
          ),
          Effect.catchTag("ShopifyError", () => Effect.succeed(Option.none())),
        );
      });

      /**
       * Handles Shopify rejecting a one-time refresh token by checking whether this
       * worker lost a refresh race. If D1 now has a different refresh token, another
       * worker (a concurrent refresh, or an `/app` token exchange that retired this
       * token immediately) already rotated and stored the session, so return that
       * winner. If D1 still has the rejected token after the recovery budget, no
       * winner exists and the token is genuinely dead — fail
       * `RefreshTokenExpiredError` with `refreshTokenExpiresAt: null`, the marker
       * that separates this reactive verdict (no timestamp; asserted after failing
       * to find a winner) from the proactive 90-day check, which always carries a
       * real `refreshTokenExpires`.
       */
      const recoverRefreshRace = Effect.fn("Shopify.recoverRefreshRace")(
        function* (
          shop: Domain.Shop,
          rejectedRefreshToken: string,
          cause: unknown = null,
        ) {
          const loadWinner = Effect.gen(function* () {
            const loaded = yield* loadShopSession(shop);
            if (Option.isNone(loaded))
              return yield* Effect.fail(
                new ShopifyError({
                  message: `Missing offline session after rejected refresh token for shop ${shop}`,
                  cause: { rejectedRefreshToken, cause },
                }),
              );
            if (loaded.value.session.refreshToken !== rejectedRefreshToken)
              return loaded.value.session;
            return yield* Effect.fail(
              new RefreshTokenRejectedError({
                shop,
                refreshToken: rejectedRefreshToken,
                cause,
              }),
            );
          });

          return yield* loadWinner.pipe(
            Effect.retry({
              while: (error) => error instanceof RefreshTokenRejectedError,
              times: REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES,
              schedule: Schedule.spaced(
                REJECTED_REFRESH_TOKEN_RECOVERY_INTERVAL,
              ).pipe(Schedule.jittered),
            }),
            Effect.catchTag("RefreshTokenRejectedError", () =>
              Effect.logWarning(
                `Shopify.recoverRefreshRace: shop=${shop} status=dead: no refresh winner found, refresh token is invalid`,
              ).pipe(
                Effect.annotateLogs({ shop, status: "dead" }),
                Effect.andThen(
                  Effect.fail(
                    new RefreshTokenExpiredError({
                      shop,
                      refreshTokenExpiresAt: null,
                      cause,
                    }),
                  ),
                ),
              ),
            ),
          );
        },
      );

      /**
       * Returns a usable offline session for `shop`, refreshing an expiring access
       * token via the `refresh_token` grant when it is expired but the refresh
       * token is still inside its 90-day window. Fails with
       * `RefreshTokenExpiredError` once the refresh token itself has expired (the
       * merchant must re-launch the app) — both proactively, by comparing
       * `refreshTokenExpires` against the clock, and reactively, when the grant
       * rejects the refresh token and `recoverRefreshRace` finds no winner (see
       * `refreshShopSession` and `isRefreshTokenRejected`).
       *
       * Together with `loadShopSession`, this replaces the Shopify template's
       * single `ensureValidOfflineSession(params, shop)` helper
       * (refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-valid-offline-session.ts),
       * split so the load is pure and the refresh state machine owns the
       * `refreshTokenExpires` guard. The template's `ensureOfflineTokenIsNotExpired`
       * does not check `refreshTokenExpires` before refreshing.
       */
      const refreshShopSessionIfExpired = Effect.fn(
        "Shopify.refreshShopSessionIfExpired",
      )(function* (session: ShopifyApi.Session) {
        if (
          session.accessToken &&
          !session.isExpired(BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS)
        )
          return session;
        const shop = yield* decodeShopify(
          Domain.Shop,
          "Invalid shop domain",
        )(session.shop);
        if (!session.refreshToken || !session.refreshTokenExpires)
          return yield* Effect.fail(
            new OfflineSessionInvalidError({ shop, sessionId: session.id }),
          );
        const now = yield* Clock.currentTimeMillis;
        if (
          session.refreshTokenExpires.getTime() -
            REFRESH_TOKEN_EXPIRY_BUFFER_MS <=
          now
        )
          return yield* Effect.fail(
            new RefreshTokenExpiredError({
              shop,
              refreshTokenExpiresAt: session.refreshTokenExpires.getTime(),
              cause: null,
            }),
          );
        return yield* refreshShopSession(shop, session.refreshToken).pipe(
          Effect.catchTag("RefreshTokenRejectedError", (error) =>
            recoverRefreshRace(shop, error.refreshToken, error.cause),
          ),
        );
      });

      /**
       * Returns an offline session for a shop without an incoming browser session
       * token. For background jobs, cron triggers, durable workflows, and queue
       * consumers, use the returned session to call Shopify APIs directly.
       *
       * Fails with `ShopifyError` when no offline session exists for the shop, and
       * with `RefreshTokenExpiredError` when the access token is expired and the
       * refresh token has passed its 90-day window. When an offline session exists
       * but its access token is expiring, `refreshShopSessionIfExpired` refreshes
       * it in place first.
       *
       * Deviates from the template's `unauthenticated.admin(shop)` contract by
       * returning only the session instead of an admin context.
       */
      const ensureShopSession = Effect.fn("Shopify.ensureShopSession")(
        function* (shop: Domain.Shop) {
          const loaded = yield* loadShopSession(shop);
          if (Option.isNone(loaded))
            return yield* Effect.fail(
              new OfflineSessionNotFoundError({ shop }),
            );
          return yield* refreshShopSessionIfExpired(loaded.value.session);
        },
      );

      /**
       * Returns a Response with Shopify document headers applied when needed.
       *
       * Behavior:
       * - Non-HTML responses are returned unchanged.
       * - HTML responses without a valid `shop` query param are returned unchanged.
       * - HTML responses with a valid `shop` are returned as a new Response with
       *   Link preload/preconnect and frame-ancestors CSP headers.
       *
       * Cloudflare Workers documents upstream responses as immutable, so header
       * changes are applied by cloning headers and returning a new Response.
       */
      const withShopifyDocumentHeaders = Effect.fn(
        "Shopify.withShopifyDocumentHeaders",
      )((request: Request, response: Response) =>
        // Lift sync header/response logic into the Effect description so it runs
        // when the Effect is executed by the runtime, not at definition time.
        Effect.sync(() => {
          if (!response.headers.get("content-type")?.startsWith("text/html")) {
            return response;
          }
          const shopParam = new URL(request.url).searchParams.get("shop");
          const sanitizedShop = shopParam
            ? shopify.utils.sanitizeShop(shopParam)
            : null;
          const shop =
            sanitizedShop === null
              ? null
              : Schema.decodeUnknownSync(Domain.Shop)(sanitizedShop);
          if (!shop) {
            return response;
          }
          const headers = new Headers(response.headers);
          setShopifyDocumentHeaders(headers, shop);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }),
      );

      /**
       * Verifies an incoming Shopify webhook by HMAC and parses it. Fails with
       * `ResponseError` for non-POST (405), invalid HMAC (401), or other
       * validation failures (400); on success returns `{ shop, topic, payload }`
       * (topic normalized to the storage form, e.g. `APP_UNINSTALLED`).
       *
       * Replaces the former `authenticateWebhook`, a port of the template's
       * `authenticate.webhook(request)` that also loaded + refreshed the offline
       * session and returned it as `session?`. Webhook authenticity is HMAC-based
       * and independent of OAuth session state, and no handler in this app
       * consumed that session, so validation no longer touches D1 or the token
       * grant. Handlers that need Admin API access call `ensureShopSession(shop)`
       * explicitly — webhooks are triggers, not a data feed, so such handlers
       * re-query Shopify for current state
       * (refs/shopify-docs/docs/apps/build/webhooks.md reconciliation).
       *
       * The three rejection paths (405 non-POST, 401 invalid HMAC, 400 other
       * validation failure) log at `Debug` — deliberately silent in deployed
       * envs (min level `Info`). These are the validator working correctly,
       * rejecting *untrusted external input* on a public URL that draws constant
       * scanner/bot traffic. `Info` is reserved for trusted, validated events
       * (the "Webhook received" log a caller emits after a successful return);
       * `Warning` would imply a fault on our side and fire false alarms on every
       * spoof/scanner hit. Promoting any of these would bury real signal under
       * scanner noise for no actionable gain. The one genuine failure mode behind
       * 401 — a misconfigured API secret making *every* legitimate webhook fail
       * HMAC — is better detected by the *absence* of "Webhook received" logs (or
       * Shopify's webhook delivery-failure dashboard) than by raising a per-
       * request reject log every scanner also trips. If spoof monitoring is ever
       * wanted, raise only the 401 case to `Warning` and accept the noise.
       */
      const validateWebhook = Effect.fn("Shopify.validateWebhook")(function* (
        request: Request,
      ) {
        if (request.method !== "POST") {
          yield* Effect.logDebug(
            "Received a non-POST request for a webhook. Only POST requests are allowed.",
          ).pipe(
            Effect.annotateLogs({
              url: request.url,
              method: request.method,
            }),
          );
          return yield* new ResponseError({
            response: new Response(undefined, {
              status: 405,
              statusText: "Method not allowed",
            }),
          });
        }
        const rawBody = yield* tryShopifyPromise(() => request.text());
        const validation = yield* tryShopifyPromise(() =>
          shopify.webhooks.validate({ rawBody, rawRequest: request }),
        );
        if (!validation.valid) {
          if (
            validation.reason ===
            ShopifyApi.WebhookValidationErrorReason.InvalidHmac
          ) {
            yield* Effect.logDebug("Webhook HMAC validation failed").pipe(
              Effect.annotateLogs({ ...validation }),
            );
            return yield* new ResponseError({
              response: new Response(undefined, {
                status: 401,
                statusText: "Unauthorized",
              }),
            });
          }
          yield* Effect.logDebug("Webhook validation failed").pipe(
            Effect.annotateLogs({ ...validation }),
          );
          return yield* new ResponseError({
            response: new Response(undefined, {
              status: 400,
              statusText: "Bad Request",
            }),
          });
        }
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          validation.domain,
        );
        const payload = yield* tryShopify(() => JSON.parse(rawBody) as unknown);
        const triggeredAt = Date.parse(validation.triggeredAt ?? "");
        return {
          shop,
          topic: validation.topic,
          payload,
          webhookId: validation.webhookId,
          triggeredAt: Number.isNaN(triggeredAt) ? null : triggeredAt,
        } as const;
      });

      const authenticateFlowAction = Effect.fn(
        "Shopify.authenticateFlowAction",
      )(function* (request: Request) {
        if (request.method !== "POST") {
          yield* Effect.logDebug(
            "Received a non-POST request for a Flow action. Only POST requests are allowed.",
          ).pipe(
            Effect.annotateLogs({ url: request.url, method: request.method }),
          );
          return yield* new ResponseError({
            response: new Response(undefined, {
              status: 405,
              statusText: "Method not allowed",
            }),
          });
        }
        const rawBody = yield* tryShopifyPromise(() => request.text());
        const validation = yield* tryShopifyPromise(() =>
          shopify.flow.validate({ rawBody, rawRequest: request }),
        );
        if (!validation.valid) {
          yield* Effect.logDebug("Flow action validation failed").pipe(
            Effect.annotateLogs({ ...validation }),
          );
          return yield* new ResponseError({
            response: new Response(undefined, {
              status: 400,
              statusText: "Bad Request",
            }),
          });
        }
        const payload = yield* tryShopify(() => JSON.parse(rawBody) as unknown);
        const { shopify_domain: shop } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ shopify_domain: Domain.Shop }),
        )(payload);
        return { shop, payload } as const;
      });

      /**
       * Builds a recovery Response for an invalid or expired browser session token.
       *
       * For document requests (no `Authorization` header), returns a 302 to the
       * bounce page (`/auth/session-token`) with a `shopify-reload` param that
       * App Bridge uses to round-trip back to the original URL with a fresh
       * `id_token`. For XHR requests, returns a 401 with the
       * `X-Shopify-Retry-Invalid-Session-Request` header when `retryRequest` is
       * true so App Bridge can retry the request with a fresh session token.
       *
       * The retry header only helps when App Bridge injected the original bearer
       * token; a request that bypassed its fetch interceptor is not retryable by
       * this contract.
       */
      const respondToInvalidSessionToken = (
        request: Request,
        retryRequest: boolean,
      ): Response => {
        if (request.headers.get("authorization")) {
          return new Response(undefined, {
            status: 401,
            headers: retryRequest
              ? { "X-Shopify-Retry-Invalid-Session-Request": "1" }
              : {},
          });
        }
        const url = new URL(request.url);
        const searchParams = url.searchParams;
        searchParams.delete("id_token");
        searchParams.set(
          "shopify-reload",
          `${config.appUrl}${url.pathname}?${searchParams.toString()}`,
        );
        return Response.redirect(
          new URL(
            `/auth/session-token?${searchParams.toString()}`,
            request.url,
          ).toString(),
        );
      };

      /**
       * Derives the `AdminAuthContext` for one request: sanitizes the `shop`
       * and `host` query params via `shopify.utils` (invalid values become
       * `null`, not errors), extracts the session token from the `Authorization`
       * header or `id_token`, and removes TanStack browser RPC from the
       * no-bearer document class before document recovery runs.
       *
       * `sanitizeHost` can throw while decoding syntactically valid base64 into
       * a URL; that is still untrusted invalid input, so it is normalized to the
       * same recoverable `null` state rather than escaping context construction.
       */
      const adminAuthContext = (request: Request): AdminAuthContext => {
        const url = new URL(request.url);
        const shopParam = url.searchParams.get("shop");
        const sanitizedShop = shopParam
          ? shopify.utils.sanitizeShop(shopParam)
          : null;
        const hostParam = url.searchParams.get("host");
        const sanitizedHost = (() => {
          try {
            return hostParam ? shopify.utils.sanitizeHost(hostParam) : null;
          } catch {
            return null;
          }
        })();
        const headerSessionToken = request.headers
          .get("authorization")
          ?.replace("Bearer ", "");
        const searchParamSessionToken = url.searchParams.get("id_token");
        const isServerFnRequest = isTanStackServerFnRequest(request);
        return {
          request,
          url,
          shop:
            sanitizedShop === null
              ? null
              : Schema.decodeUnknownSync(Domain.Shop)(sanitizedShop),
          host: sanitizedHost,
          headerSessionToken,
          searchParamSessionToken,
          sessionToken: headerSessionToken ?? searchParamSessionToken,
          isServerFnRequest,
          isDocumentRequest: !headerSessionToken && !isServerFnRequest,
        };
      };

      /**
       * Shared recovery for an invalid session token: logs the `event` with
       * the recovery response's shape, then fails with a `ResponseError`
       * wrapping `respondToInvalidSessionToken` (retry enabled — App Bridge
       * re-runs the request with a fresh token). Used by both the decode
       * (`decodeAdminToken`) and exchange (`exchangeAndStore`) stages.
       */
      const failInvalidSessionToken = Effect.fn(
        "Shopify.failInvalidSessionToken",
      )(function* (ctx: AdminAuthContext, event: string) {
        const response = respondToInvalidSessionToken(ctx.request, true);
        const location = response.headers.get("location");
        yield* logAuth(ctx, event, {
          status: response.status,
          locationPath: location
            ? new URL(location, config.appUrl).pathname
            : null,
          retryHeader: response.headers.get(
            "X-Shopify-Retry-Invalid-Session-Request",
          ),
        });
        return yield* new ResponseError({ response });
      });

      /**
       * Owns transport and document control flow ahead of token validation.
       *
       * A clean iframe URL is normal after SPA navigation. If that frame later
       * reloads, its navigation has no bearer header and may no longer carry
       * `shop` or `host`. Rendering only App Bridge lets the existing Admin
       * parent re-establish the embedded session; redirecting to the standalone
       * shop-domain login form would strand that form inside the iframe.
       *
       * TanStack browser RPC is identified first and receives 401 when its
       * bearer is absent. Other no-bearer requests follow Shopify's document
       * flow: explicit bounce/exit pages, minimal App Bridge for missing or
       * invalid embed context, Admin embedding when `embedded !== "1"`, then
       * the session-token bounce when `id_token` is absent.
       *
       * Succeeds with void when the request may proceed to token decode;
       * bearer-carrying XHR/RPC requests skip the document guards entirely.
       */
      const resolveDocumentGuards = Effect.fn("Shopify.resolveDocumentGuards")(
        function* (ctx: AdminAuthContext) {
          if (ctx.url.pathname.endsWith("/auth/session-token")) {
            return yield* new ResponseError({
              response: renderAppBridgePage(
                Redacted.value(config.apiKey),
                ctx.shop,
              ),
            });
          }
          if (ctx.url.pathname.endsWith("/auth/exit-iframe")) {
            const destination = parseExitIframeDestination(
              config.appUrl,
              ctx.url.searchParams.get("exitIframe") ?? config.appUrl,
            );
            if (!destination) {
              yield* logAuth(ctx, "reject-exit-iframe-destination");
              return yield* new ResponseError({
                response: new Response("Bad Request", { status: 400 }),
              });
            }
            return yield* new ResponseError({
              response: renderExitIframePage(
                Redacted.value(config.apiKey),
                ctx.shop,
                destination,
              ),
            });
          }
          if (ctx.isServerFnRequest && !ctx.headerSessionToken) {
            yield* logAuth(ctx, "unauthorized-serverfn-missing-session-token");
            return yield* new ResponseError({
              response: new Response("Unauthorized", { status: 401 }),
            });
          }
          if (ctx.isDocumentRequest) {
            if (!ctx.shop || !ctx.host) {
              yield* logAuth(ctx, "render-app-bridge-missing-shop-host");
              return yield* new ResponseError({
                response: renderAppBridgePage(
                  Redacted.value(config.apiKey),
                  ctx.shop,
                ),
              });
            }
            if (ctx.url.searchParams.get("embedded") !== "1") {
              const embeddedUrl = yield* tryShopifyPromise(() =>
                shopify.auth.getEmbeddedAppUrl({ rawRequest: ctx.request }),
              );
              yield* logAuth(ctx, "redirect-embedded-app-url");
              return yield* new ResponseError({
                response: Response.redirect(embeddedUrl),
              });
            }
            if (!ctx.searchParamSessionToken) {
              const searchParams = new URLSearchParams(ctx.url.searchParams);
              searchParams.delete("id_token");
              searchParams.set(
                "shopify-reload",
                `${config.appUrl}${ctx.url.pathname}?${searchParams.toString()}`,
              );
              yield* logAuth(ctx, "redirect-session-token-bounce", {
                bouncePath: "/auth/session-token",
              });
              return yield* new ResponseError({
                response: Response.redirect(
                  new URL(
                    `/auth/session-token?${searchParams.toString()}`,
                    ctx.request.url,
                  ).toString(),
                ),
              });
            }
          }
          return yield* Effect.void;
        },
      );

      /**
       * Validates and decodes the session token: fails with a 401
       * `ResponseError` when no token is present, routes `InvalidJwtError` through
       * `failInvalidSessionToken`, and derives the session shop from the
       * token's `dest` claim. Returns `{ sessionToken, sessionShop }` for
       * the exchange stage.
       */
      const decodeAdminToken = Effect.fn("Shopify.decodeAdminToken")(function* (
        ctx: AdminAuthContext,
      ) {
        const { sessionToken } = ctx;
        if (!sessionToken) {
          yield* logAuth(ctx, "unauthorized-missing-session-token");
          return yield* new ResponseError({
            response: new Response("Unauthorized", { status: 401 }),
          });
        }
        const decoded = yield* tryShopifyPromise(() =>
          shopify.session.decodeSessionToken(sessionToken),
        ).pipe(
          Effect.catchIf(
            (error) => error.cause instanceof ShopifyApi.InvalidJwtError,
            () =>
              failInvalidSessionToken(
                ctx,
                "respond-invalid-session-token-after-decode",
              ),
          ),
        );
        const sessionShop = yield* decodeShopify(
          Domain.Shop,
          "Invalid shop domain",
        )(new URL(decoded.dest).hostname);
        return { sessionToken, sessionShop } as const;
      });

      /**
       * Resolves the offline session for a validated token: returns the
       * stored session when it is still active within
       * `EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS`; otherwise token-exchanges
       * (invalid JWT / invalid subject token recover via
       * `failInvalidSessionToken` — `ctx` is passed only for that), fetches
       * the shop GID only when no prior session exists, and persists the
       * exchanged session before returning `{ session, shopGid }`.
       */
      const exchangeAndStore = Effect.fn("Shopify.exchangeAndStore")(function* (
        ctx: AdminAuthContext,
        sessionShop: Domain.Shop,
        sessionToken: string,
      ) {
        const existing = yield* loadShopSession(sessionShop);
        if (
          Option.isSome(existing) &&
          existing.value.session.isActive(
            undefined,
            EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS,
          )
        ) {
          return existing.value;
        }
        const exchanged = yield* tryShopifyPromise(() =>
          shopify.auth.tokenExchange({
            shop: sessionShop,
            sessionToken,
            requestedTokenType:
              ShopifyApi.RequestedTokenType.OfflineAccessToken,
            expiring: true,
          }),
        ).pipe(
          Effect.catchIf(
            (error) =>
              error.cause instanceof ShopifyApi.InvalidJwtError ||
              isInvalidSubjectTokenError(error),
            () =>
              failInvalidSessionToken(
                ctx,
                "respond-invalid-session-token-after-exchange",
              ),
          ),
        );
        const shopGid = Option.isSome(existing)
          ? existing.value.shopGid
          : yield* fetchShopGid(exchanged.session);
        yield* storeShopSession(exchanged.session, shopGid);
        return { session: exchanged.session, shopGid } as const;
      });

      /**
       * Per-request worker behind the memoized public `authenticateAdmin`: takes
       * an explicit request, whereas callers use the no-arg `authenticateAdmin`
       * (an `Effect.cached` effect that reads `CurrentRequest`, normalizes
       * document-request origins to `appUrl`, and shares one result per request).
       *
       * Supported request shapes:
       * - document/navigation requests using `shop`, `host`, and `id_token` query params
       * - XHR/RPC requests carrying `Authorization: Bearer <session_token>`
       *
       * Behavior:
       * - renders App Bridge bounce/exit pages for `/auth/session-token` and `/auth/exit-iframe`
       * - renders minimal App Bridge when a reloaded iframe lacks embed params
       * - returns 401 for a headerless TanStack browser server-function request
       * - redirects to embedded/bounce routes for the remaining document flow
       * - validates and decodes the session token, derives shop from token payload, loads stored offline session
       * - exchanges token and persists session when no active stored session exists
       *
       * Returns the authenticated offline session `{ session, shopGid }` on
       * success; redirect/bounce/unauthorized document control flow fails with
       * `ResponseError`, unwrapped and thrown at the worker seam.
       */
      const authenticateAdminRequest = Effect.fn(
        "Shopify.authenticateAdminRequest",
      )(function* (request: Request) {
        const ctx = adminAuthContext(request);
        yield* resolveDocumentGuards(ctx);
        const { sessionShop, sessionToken } = yield* decodeAdminToken(ctx);
        return yield* exchangeAndStore(ctx, sessionShop, sessionToken);
      });

      const sessionIdFromShop = Effect.fn("Shopify.sessionIdFromShop")(
        function* (shop: Domain.ShopSession["shop"]) {
          return yield* decodeShopify(
            Domain.SessionId,
            "Invalid session id",
          )(shopify.session.getOfflineId(shop));
        },
      );

      /**
       * Verifies a Shopify session token (HS256 signature + exp/nbf + aud)
       * without the redirect/bounce/token-exchange side effects of
       * `authenticateAdmin`. Use at WebSocket upgrade gates where browser
       * `WebSocket` cannot carry an `Authorization` header and the token
       * arrives via a URL query parameter.
       *
       * Returns the decoded payload on success, or fails with `ResponseError`
       * carrying a 401 for invalid tokens (mapped from Shopify's
       * `InvalidJwtError`).
       */
      const decodeSessionToken = Effect.fn("Shopify.decodeSessionToken")(
        function* (token: string) {
          return yield* tryShopifyPromise(() =>
            shopify.session.decodeSessionToken(token),
          ).pipe(
            Effect.catchIf(
              (error) => error.cause instanceof ShopifyApi.InvalidJwtError,
              () =>
                Effect.fail(
                  new ResponseError({
                    response: new Response("Unauthorized", { status: 401 }),
                  }),
                ),
            ),
          );
        },
      );

      /**
       * Public, per-request memoized authentication — the entry callers use.
       *
       * `Effect.cached` wraps `authenticateAdminRequest`: the first run within a
       * request executes it, every later run replays the cached result. One
       * `ManagedRuntime` is built per HTTP request and shared across `beforeLoad`
       * and each loader/server-fn run, so the otherwise-duplicated auth (JWT
       * verify + D1 load + token exchange) collapses to one call per request. A
       * standalone server-fn request gets its own runtime, hence its own auth.
       *
       * `normalized` rewrites the request origin to `config.appUrl` so the
       * worker's document-branch redirects (session-token bounce / embedded),
       * which are built from `request.url`, target the public app
       * origin rather than whatever origin the worker observed (e.g. `localhost`
       * behind a dev tunnel). It applies only to document requests — those with
       * neither a bearer header nor TanStack's browser-RPC marker. RPC requests
       * pass through untouched even when malformed: rebuilding a non-GET request
       * without its body would corrupt the request before the 401 branch sees it.
       */
      const authenticateAdmin = yield* Effect.cached(
        Effect.gen(function* () {
          const request = yield* CurrentRequest;
          const url = new URL(request.url);
          const normalized =
            request.headers.has("authorization") ||
            isTanStackServerFnRequest(request) ||
            url.origin === new URL(config.appUrl).origin
              ? request
              : new Request(`${config.appUrl}${url.pathname}${url.search}`, {
                  method: request.method,
                  headers: request.headers,
                });
          return yield* authenticateAdminRequest(normalized);
        }),
      );
      return Shopify.of({
        config,
        authenticateAdmin,
        decodeSessionToken,
        withShopifyDocumentHeaders,
        validateWebhook,
        authenticateFlowAction,
        storeShopSession,
        deleteShopSession,
        updateShopSessionScope,
        graphql,
        refreshShopSession,
        recoverRefreshRace,
        loadShopSession,
        refreshShopSessionIfExpired,
        ensureShopSession,
        sessionIdFromShop,
      });
    }),
  );
}

/**
 * Destroys the per-shop ShopAgent Durable Object.
 *
 * Cloudflare Agents' `destroy()` API is intentionally hostile to normal RPC
 * semantics: after deleting alarms and storage, it calls `ctx.abort("destroyed")`
 * to force Durable Object eviction. Effect.tryPromise wraps that abort in a
 * Cause.UnknownError whose `cause` is the original Error("destroyed").
 *
 * Crucially, the SDK `await`s `storage.deleteAll()` BEFORE scheduling that
 * abort. A DO that ever wrote storage (ours can through framework-managed
 * state or alarms) only ceases to exist once `deleteAll()` empties it. So observing the
 * "destroyed" abort is proof `deleteAll()` ran to completion — the DO is empty
 * and gone. We treat it as success and log status=destroyed.
 *
 * Any other failure (e.g. `deleteAll()` hitting its time limit, which "makes
 * progress and is safe to retry until it succeeds") propagates: the webhook
 * returns non-2xx and Shopify retries the idempotent teardown until deleteAll
 * finishes. We log status=failed before re-raising.
 */
export const destroyShopAgent = Effect.fn("destroyShopAgent")(function* (
  shop: Domain.Shop,
) {
  const env = yield* CloudflareEnv;
  yield* Effect.tryPromise(() => env.SHOP_AGENT.getByName(shop).destroy()).pipe(
    Effect.catchIf(
      (error: Cause.UnknownError) =>
        error.cause instanceof Error && error.cause.message === "destroyed",
      () => Effect.void,
    ),
    Effect.tap(() =>
      Effect.logInfo(`destroyShopAgent: shop=${shop} status=destroyed`).pipe(
        Effect.annotateLogs({ shop, status: "destroyed" }),
      ),
    ),
    Effect.tapError((error: Cause.UnknownError) =>
      Effect.logError(
        `destroyShopAgent: shop=${shop} status=failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
      ).pipe(Effect.annotateLogs({ shop, status: "failed" })),
    ),
  );
});

/**
 * Destroys a ShopAgent Durable Object by its REST-listed object id, for the
 * admin orphan-cleanup page.
 *
 * Keyed on id (`idFromString`), never name: an id from the live REST inventory
 * already exists, so `destroy()` can only ever empty something that is already
 * there. `getByName(arbitrary)` could instead fabricate a brand-new identity —
 * the very leak this page exists to catch — so it is deliberately not used.
 *
 * `setName(id)` before `destroy()` is mandatory for an `idFromString` stub.
 * agents' `destroy()` calls `_emit("destroy")` AFTER `deleteAll()`, and `_emit`
 * reads `this.name`. PartyServer resolves `name` from `ctx.id.name` (unset for
 * `idFromString`) or the in-memory/`__ps_name`-persisted fallback; orphans that
 * were never initialized via a named (`getByName`) path have no `__ps_name`
 * record, so after `deleteAll()` wipes storage, `get name` throws — the DO is
 * gone but the RPC rejects with the `.name` error instead of "destroyed".
 * `setName(id)` stashes the id in memory up front so `.name` resolves through
 * the whole teardown (it survives `deleteAll()`), so the normal "destroyed"
 * abort is what surfaces. It does not weaken the id-only guarantee: it only
 * labels the already-resolved `idFromString(id)` stub, never calls `getByName`.
 *
 * `setName`'s `@deprecated` tag is scoped — deprecated only for `getByName`
 * callers where it is redundant; it is the supported bootstrap API for
 * `idFromString`/`newUniqueId` DOs (the runtime error names it as the fix), and
 * there is no non-deprecated alternative short of `getByName`.
 *
 * Shares the "destroyed"-abort handling of `destroyShopAgent`: observing the
 * abort is proof `deleteAll()` ran to completion, so we swallow it as success
 * and log status=destroyed; any other failure propagates after status=failed.
 *
 * Idempotent but does not remove the id from the REST inventory. A successful
 * destroy leaves a "tombstone": the id keeps appearing in `list_objects` with
 * `hasStoredData: false` (the inventory is eventually consistent; Cloudflare
 * documents no GC/TTL for emptied ids). The lag cuts both ways: right after a
 * confirmed destroy the row can still show stale `hasStoredData: true` for a
 * while before flipping to false, so trust the status=destroyed log over the
 * badge rather than re-clicking. An emptied DO bills no storage and
 * ceases to exist on shutdown, so a tombstone is harmless — ignore it. Note
 * that calling this on a tombstone RE-INSTANTIATES the DO: the constructor
 * reruns `runShopAgentMigrations` (writing storage) before `setName`/`destroy`
 * empty it again, so repeated destroys re-create-then-re-empty and never clear
 * the row from the list. Removal happens only when Cloudflare GCs the id. The
 * orphan page guards against this footgun by hiding the Destroy button for rows
 * with `hasStoredData === false` (and dropping them from the diff entirely), so
 * a tombstone is never a destroy target through the UI.
 */
export const destroyShopAgentObjectById = Effect.fn(
  "destroyShopAgentObjectById",
)(function* (id: string) {
  const env = yield* CloudflareEnv;
  const stub = env.SHOP_AGENT.get(env.SHOP_AGENT.idFromString(id));
  yield* Effect.tryPromise(async () => {
    await stub.setName(id);
    await stub.destroy();
  }).pipe(
    Effect.catchIf(
      (error: Cause.UnknownError) =>
        error.cause instanceof Error && error.cause.message === "destroyed",
      () => Effect.void,
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `destroyShopAgentObjectById: id=${id} status=destroyed`,
      ).pipe(Effect.annotateLogs({ id, status: "destroyed" })),
    ),
    Effect.tapError((error: Cause.UnknownError) =>
      Effect.logError(
        `destroyShopAgentObjectById: id=${id} status=failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
      ).pipe(Effect.annotateLogs({ id, status: "failed" })),
    ),
  );
});

/**
 * Uniform webhook handler combinator for the `webhooks.*` routes.
 *
 * Validates the request via `Shopify.validateWebhook`, whose rejection
 * (405/401/400) propagates as `ResponseError` and is unwrapped into the
 * rejection `Response` at the worker seam. On success it wraps the topic-specific
 * `handler` so that, under a single `Effect.annotateLogs({ shop, topic })`
 * scope: a "Webhook received" log fires at `Info` before the body runs (so a
 * delivery is recorded even if the handler later fails), and any failure cause
 * is logged at `Error` with the flattened `cause` — both annotated with `shop`.
 *
 * `Effect.annotateLogs` attaches `shop` + `topic` to every log line emitted by
 * the wrapped effect (receipt log, handler logs, error log) via FiberRef, which
 * is why the error log must live here rather than at the worker seam
 * (`makeRunEffect`), whose `tapCause` runs outside this scope after the
 * annotation FiberRef is restored and so cannot see `shop`. `tapCause` (not a
 * caller-side `tapError`) is used to cover defects as well as typed failures.
 *
 * The cause re-raises (tap, not catch), so a genuine failure still yields a
 * non-2xx response and Shopify retries — and also surfaces once more at the
 * worker seam's generic "Worker effect failed" log (correlated by `cause`).
 */
export const handleWebhook = Effect.fn("handleWebhook")(function* <E, R>(
  handler: (result: {
    readonly shop: Domain.Shop;
    readonly topic: string;
    readonly payload: unknown;
    readonly webhookId: string;
    readonly triggeredAt: number | null;
  }) => Effect.Effect<Response, E, R>,
) {
  const request = yield* CurrentRequest;
  const shopify = yield* Shopify;
  const result = yield* shopify.validateWebhook(request);
  return yield* Effect.gen(function* () {
    yield* Effect.logInfo(
      `Webhook received: shop=${result.shop} topic=${result.topic}`,
    );
    return yield* handler(result);
  }).pipe(
    Effect.tapCause((cause) =>
      Effect.logError(
        `Webhook failed: shop=${result.shop} topic=${result.topic}`,
      ).pipe(Effect.annotateLogs({ cause: causeToErrorMessage(cause) })),
    ),
    Effect.annotateLogs({ shop: result.shop, topic: result.topic }),
  );
});
