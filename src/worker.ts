import { isNotFound, isRedirect } from "@tanstack/react-router";
import serverEntry from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";
import {
  Cause,
  Effect,
  Layer,
  Context,
  ManagedRuntime,
  Match,
  Option,
  Schema,
} from "effect";
import * as Exit from "effect/Exit";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { D1Bookmark } from "@/lib/D1Bookmark";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { Email } from "@/lib/Email";
import { KV } from "@/lib/KV";
import {
  causeToErrorMessage,
  makeEnvLayer,
  makeLoggerLayer,
  tryPromisePassthrough,
} from "@/lib/LayerEx";
import { requireMember } from "@/lib/MemberAccess";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { ResponseError, Shopify } from "@/lib/Shopify";
import { ShopifyPartner } from "@/lib/ShopifyPartner";
import { SubscriptionPlan } from "@/lib/SubscriptionPlan";
export { ShopAgent } from "@/lib/ShopAgent";
export { OrdersSyncWorkflow } from "@/lib/OrdersSyncWorkflow";

const makeAppLayer = (
  env: Env,
  request: Request,
  d1Session: D1DatabaseSession,
) => {
  const envLayer = makeEnvLayer(env);
  const d1PrimaryLayer = Layer.provide(D1Primary.layerNoDeps, envLayer);
  const repositoryLayer = Layer.provideMerge(
    Repository.layerNoDeps,
    Layer.mergeAll(D1Session.layer(d1Session), d1PrimaryLayer, envLayer),
  );
  const requestLayer = Layer.succeedContext(
    Context.make(CurrentRequest, request),
  );
  const shopifyLayer = Layer.provideMerge(
    Shopify.layerNoDeps,
    Layer.merge(repositoryLayer, requestLayer),
  );
  const shopifyPartnerLayer = Layer.provideMerge(
    ShopifyPartner.layer,
    envLayer,
  );
  const shopAgentClientLayer = Layer.provideMerge(
    ShopAgentClient.layerNoDeps,
    envLayer,
  );
  const d1BookmarkLayer = Layer.succeed(
    D1Bookmark,
    D1Bookmark.of({ current: Effect.sync(() => d1Session.getBookmark()) }),
  );
  const subscriptionPlanLayer = Layer.provideMerge(
    SubscriptionPlan.layerNoDeps,
    Layer.mergeAll(repositoryLayer, shopifyPartnerLayer, shopAgentClientLayer),
  );
  const kvLayer = Layer.provideMerge(KV.layerNoDeps, envLayer);
  const emailLayer = Layer.provideMerge(Email.layerNoDeps, envLayer);
  const authLayer = Layer.provideMerge(
    Auth.layerNoDeps,
    Layer.mergeAll(kvLayer, repositoryLayer, emailLayer, envLayer),
  );
  return Layer.mergeAll(
    repositoryLayer,
    shopifyLayer,
    shopifyPartnerLayer,
    subscriptionPlanLayer,
    shopAgentClientLayer,
    requestLayer,
    authLayer,
    kvLayer,
    emailLayer,
    d1BookmarkLayer,
    makeLoggerLayer(env),
  );
};

/**
 * Builds a per-request `ManagedRuntime` and returns a `runEffect` function for
 * HTTP request handlers (fetch, server functions).
 *
 * `ManagedRuntime` memoizes the layer build so services (`D1`,
 * `Repository`, `Shopify`, …) are constructed once per request and reused
 * across every `runEffect` call within that request, rather than being rebuilt
 * on each invocation.
 *
 * The per-request D1 session (`env.D1.withSession`) sets the read-replica
 * constraint by request class:
 *
 * - **Interactive with bookmark** — the client sent `x-d1-bookmark` (carried by
 *   the custom `serverFns.fetch`): anchor to it for sequential consistency (each
 *   read is at least as fresh as that bookmark → read-your-own-writes across
 *   requests).
 * - **Interactive SSR** — a top-level document load that can't carry a request
 *   header: fall back to `"first-unconstrained"` (serve the first query from any,
 *   possibly stale, replica) for the latency win. Safe because D1 holds only
 *   `ShopSession`, self-healing auth plumbing — a stale read degrades to at worst a
 *   redundant token exchange, never wrong data or a security hole — and SSR
 *   reseeds a fresh bookmark each load.
 * - **Background / server-to-server** — webhooks (`/webhooks/*`, `isBackground`),
 *   where Shopify is the caller so there is no inbound bookmark and no human RTT
 *   to save: use `"first-primary"` so any read-modify-write sees the latest, not
 *   a lagging replica. No webhook handler reads D1 today, so this is a standing
 *   guarantee for the first one that does rather than a live requirement — kept
 *   because webhooks carry authoritative state changes, and a handler that reads
 *   stale, decides wrongly, and returns 2xx is recorded as delivered and never
 *   retried. Neither replica benefit applies here: nothing is waiting on the
 *   latency, and webhook volume is per-lifecycle, not per-action.
 *
 * Both `"first-*"` values are only *starting constraints*;
 * `d1Session.getBookmark()` (surfaced via the `D1Bookmark` service) returns the
 * real bookmark after the first query.
 *
 * `runEffect` uses `runPromiseExit` instead of `runPromise` so it can inspect
 * failures before deciding what to throw. It has two jobs at this boundary:
 * preserve HTTP control flow, and turn ordinary Effect failures into useful
 * TanStack-serializable diagnostics.
 *
 * Raw `Response` values, `ResponseError` (Shopify's control-flow Responses in
 * the error channel, unwrapped to their `response` here), TanStack `redirect`,
 * and TanStack `notFound` objects are thrown as-is after `Cause.squash` so
 * TanStack Start can route them correctly: a raw `Response` gets
 * `X_TSS_RAW_RESPONSE` set by `server-functions-handler` and returned to the
 * client unchanged; redirect and notFound objects go through TanStack's
 * serialization/control-flow paths. `Cause.squash` priority (first `Fail` →
 * first `Die`) aligns with HTTP control flow because there is exactly one
 * HTTP-relevant value in the Cause for these cases. Control-flow causes skip
 * the "Worker effect failed" log: they are routing, not faults, and webhook
 * validation rejections on the public `/webhooks/*` URL are deliberately
 * Debug-silent (see `Shopify.validateWebhook`).
 *
 * `Cause.squash` returns `unknown`: the first typed failure, first defect, or a
 * synthetic interrupt/empty-cause `Error`. That value can be an `Error`, string,
 * plain object, Effect `TaggedError`, Shopify result object, or anything else
 * user code failed/died with. After HTTP control flow is detected, `runEffect`
 * intentionally does not throw `squashed`.
 *
 * TanStack Start server functions serialize thrown `Error`s through the
 * router-core `ShallowErrorPlugin`, which keeps ONLY `.message`. `.name`,
 * `._tag`, `.stack`, `.cause`, and custom properties are stripped, then the
 * client reconstructs `new Error(message)`. Effect v4 app errors intentionally
 * carry useful root detail in `.cause`, while `UnknownError` from unannotated
 * `Effect.tryPromise` is just a generic wrapper whose cause is usually the
 * useful part.
 *
 * Non-control-flow failures are therefore converted to a fresh `Error` whose
 * message is a compact rendering of `Cause.prettyErrors(exit.cause)`: error
 * names/messages plus nested `[cause]` chains, but not server stacks.
 * `prettyErrors` normalizes arbitrary failures/defects into `Error` values, so
 * strings, primitives, plain objects, `Error` subclasses, and nested causes all
 * contribute useful diagnostic text. This preserves details like schema paths
 * without duplicating stack output in the browser/runtime.
 */
const httpControlFlow = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause);
  const unwrapped =
    squashed instanceof ResponseError ? squashed.response : squashed;
  return unwrapped instanceof Response ||
    isRedirect(unwrapped) ||
    isNotFound(unwrapped)
    ? unwrapped
    : undefined;
};

const makeRunEffect = (env: Env, request: Request) => {
  const isBackground = new URL(request.url).pathname.startsWith("/webhooks/");
  const d1Session = env.D1.withSession(
    request.headers.get("x-d1-bookmark") ??
      (isBackground ? "first-primary" : "first-unconstrained"),
  );
  const appLayer = makeAppLayer(env, request, d1Session);
  const managedRuntime = ManagedRuntime.make(appLayer);
  const runEffect = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
  ): Promise<A> => {
    const exit = await managedRuntime.runPromiseExit(
      effect.pipe(
        Effect.tapCause((cause) => {
          if (httpControlFlow(cause) !== undefined) return Effect.void;
          const rendered = causeToErrorMessage(cause);
          return Effect.logError(`Worker effect failed: ${rendered}`).pipe(
            Effect.annotateLogs({
              cause: rendered,
              method: request.method,
              pathname: new URL(request.url).pathname,
            }),
          );
        }),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const controlFlow = httpControlFlow(exit.cause);
    if (controlFlow !== undefined)
      // oxlint-disable-next-line only-throw-error -- redirect is a Response, notFound is a plain object; TanStack expects these thrown as-is
      throw controlFlow;
    throw new Error(causeToErrorMessage(exit.cause));
  };
  return { runEffect, managedRuntime };
};

const withD1BookmarkHeader = (response: Response) =>
  D1Bookmark.current.pipe(
    Effect.map((bookmark) => {
      if (!bookmark) return response;
      const headers = new Headers(response.headers);
      headers.set("x-d1-bookmark", bookmark);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );

/**
 * Selects `/app` document loads for authentication at the HTTP boundary.
 *
 * The app route also authenticates in a server function so client navigation
 * can enforce auth. During SSR, however, a nonredirect Shopify recovery
 * `Response` thrown from that server function is treated as serializable RPC
 * data. A minimal App Bridge document contains a native `Response` body and
 * cannot be serialized, producing a 500 instead of recovery.
 *
 * Preflighting only no-bearer GETs under `/app` lets the Worker return document
 * control flow directly. Successful auth is not duplicated: `Shopify` caches
 * `authenticateAdmin` inside this per-request `ManagedRuntime`, so the route's
 * later server-function call reuses the same result. TanStack browser RPC is
 * excluded by path and marker and remains on the server-function transport.
 */
const isShopifyAppDocumentRequest = (request: Request) => {
  const { pathname } = new URL(request.url);
  return (
    request.method === "GET" &&
    !request.headers.has("authorization") &&
    request.headers.get("x-tsr-serverFn") !== "true" &&
    (pathname === "/app" || pathname.startsWith("/app/"))
  );
};

/**
 * Per-request context injected by `serverEntry.fetch` and typed via Start's
 * `Register.server.requestContext`.
 *
 * Server functions consume this through `context` in handlers
 * (`createServerFn(...).handler(({ context }) => ...)`), so per-request
 * runtime data is available without importing
 * `@tanstack/react-start/server`.
 *
 * Why avoid that import in route modules: `@tanstack/react-start/server` is a
 * barrel that re-exports SSR stream/runtime modules, which pull Node builtins
 * (`node:stream`, `node:stream/web`, `node:async_hooks`) into the client build
 * graph and can trigger Rollup errors like:
 * `"Readable" is not exported by "__vite-browser-external"`.
 *
 * References:
 * - Import Protection (why imports can stay alive):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/import-protection#common-pitfall-why-some-imports-stay-alive
 * - Server Entry Point request context (this pattern):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point#request-context
 */
export interface ServerContext {
  runEffect: ReturnType<typeof makeRunEffect>["runEffect"];
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: ServerContext };
  }
}

/**
 * Headers the WebSocket handshake itself needs, and the only ones
 * {@link rebuildRequest} carries forward.
 *
 * `x-partykit-namespace` rides along because `routePartykitRequest` sets it
 * *before* calling this gate and the request the gate returns is the one
 * forwarded to the Durable Object
 * (`refs/partykit/packages/partyserver/src/index.ts`).
 */
const FORWARDED_HANDSHAKE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "x-partykit-namespace",
] as const;

/**
 * The request the gate forwards to `ShopAgent`, carrying the identity it just
 * resolved as `x-baton-*` headers (`Domain.ConnectionState`).
 *
 * Built from an empty `Headers` rather than a copy of the inbound ones, and
 * that is the whole point: a browser cannot set headers on a WebSocket
 * upgrade, but a non-browser client can, so copying them forward would let a
 * caller present `x-baton-role: merchant` alongside a member cookie and pick
 * their own role. Rebuilding means the object can only ever see what this
 * function wrote. The cookie and `Authorization` are dropped for the same
 * reason in reverse: the object has no business holding credentials it cannot
 * verify.
 *
 * `new Request(url, …)` rather than `new Request(request, …)` so the headers
 * stay mutable — partyserver sets `x-partykit-props` on the returned request
 * after this hook runs, and an immutable header list would throw there.
 */
const rebuildRequest = (
  request: Request,
  batonHeaders: Readonly<Record<string, string>>,
) => {
  const headers = new Headers();
  for (const name of FORWARDED_HANDSHAKE_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(batonHeaders))
    headers.set(name, value);
  return new Request(request.url, { method: request.method, headers });
};

/**
 * The member half of the gate: no session token means the caller is a
 * `/shop/*` tab, whose only credential is the better-auth cookie the browser
 * sends automatically on a same-origin upgrade.
 *
 * The status codes mirror the member area's HTTP guards exactly, because the
 * socket must not become a side channel that answers a question a page load
 * refuses to: no session → `401` (the page redirects to `/login`); an operator
 * → `403` (the page bounces to `/admin`; the operator role is cross-tenant and
 * by invariant never a member, so it gets no connection role at all); not a
 * member of this shop → `404`, the same "no such shop" the page returns, so a
 * stranger cannot distinguish a shop they lack access to from one that does
 * not exist; a member of a shop whose subscription lapsed → `402`, the same
 * answer the merchant gate gives.
 *
 * A failure that is not an authorization answer — D1 unreachable — is `503`
 * rather than `404`: the browser retries a socket, and reporting "not yours"
 * for an outage would evict a legitimate member's tab.
 */
const authorizeShopAgentMember = Effect.fn("authorizeShopAgentMember")(
  function* (request: Request, urlShop: string | null) {
    const auth = yield* Auth;
    const sessionContext = yield* auth.getSession(request.headers);
    if (Option.isNone(sessionContext))
      return new Response("Unauthorized", { status: 401 });
    if (Domain.userIsAdmin(sessionContext.value.user))
      return new Response("Forbidden", { status: 403 });
    if (!urlShop) return new Response("Not Found", { status: 404 });
    const email = sessionContext.value.user.email;
    return yield* requireMember({ shop: urlShop, email }).pipe(
      Effect.map((access) =>
        rebuildRequest(request, {
          [Domain.CONNECTION_ROLE_HEADER]: "member",
          [Domain.CONNECTION_MEMBER_ID_HEADER]: access.memberId,
          [Domain.CONNECTION_MEMBER_EMAIL_HEADER]: email,
          [Domain.CONNECTION_TEAM_IDS_HEADER]: access.teams
            .map((team) => team.id)
            .join(","),
        }),
      ),
      // A malformed shop segment is "no such shop", not a fault.
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(new Response("Not Found", { status: 404 })),
      ),
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause);
        if (isNotFound(squashed))
          return Effect.succeed(new Response("Not Found", { status: 404 }));
        // `requireMember` answers a lapsed subscription with a redirect to
        // the member lapsed page; on a socket that is the merchant gate's 402.
        if (isRedirect(squashed))
          return Effect.succeed(
            new Response("Payment Required", { status: 402 }),
          );
        return Effect.logError(
          `authorizeShopAgentMember: shop=${urlShop}: membership lookup failed`,
        ).pipe(
          Effect.annotateLogs({
            shop: urlShop,
            cause: causeToErrorMessage(cause),
          }),
          Effect.as(new Response("Service Unavailable", { status: 503 })),
        );
      }),
    );
  },
);

/**
 * Pre-upgrade/pre-request authorization gate for `/agents/shop-agent/{shop}`.
 *
 * Two populations reach the same object over the same URL and the gate is the
 * only place that can tell them apart, because it is the only place that sees
 * a credential: a **merchant** presents a Shopify session token, a **member**
 * presents a better-auth cookie. The presence of a token selects the branch —
 * a member has no way to mint one (only App Bridge inside the Shopify admin
 * can) — and the cookie branch is {@link authorizeShopAgentMember}. Whichever
 * branch succeeds returns a {@link rebuildRequest}, so the object learns who
 * is on the connection from headers only this gate can have written; see
 * `Domain.ConnectionState` for what it does with them.
 *
 * Browser `WebSocket` upgrades cannot carry custom headers, so the client
 * passes the Shopify session token via the URL query (`?token=…`); HTTP
 * requests carry it as `Authorization: Bearer …` (auto-injected by App
 * Bridge for same-origin fetches). The gate accepts either.
 *
 * `decodeSessionToken` (not `authenticateAdmin`) is the right primitive
 * here: it validates HS256 signature + `exp`/`nbf` + `aud` without the
 * redirect/bounce/token-exchange side effects designed for HTTP document
 * flows. Its `ResponseError` (401) is recovered into the success channel
 * because `routeAgentRequest`'s onBeforeConnect/onBeforeRequest contract
 * expects a returned `Response`, not a rejected promise.
 *
 * Scope check: the URL instance name (third path segment) is user-supplied,
 * so it is compared against `decoded.dest`'s hostname, which is signed by
 * Shopify against the app's API secret.
 *
 * Subscription check: a socket is authenticated once at connect and never
 * re-authed, so without a gate here a merchant who lapses mid-session keeps
 * their open tab working until it reconnects. Running it at the gate rather
 * than per RPC costs one resolution per connection — which recurs roughly
 * every 5 min on an idle tab, since Cloudflare's edge closes a silent
 * WebSocket after ~300s and the browser reconnects. That churn bounds the
 * lapsed-merchant window to minutes rather than to the tab's lifetime, and it
 * is why this path must stay cheap. A plan that cannot be
 * resolved fails the connection rather than allowing it — the browser retries,
 * and `/app` surfaces the same outage as an error anyway.
 */
const authorizeShopAgentRequest = Effect.fn("authorizeShopAgentRequest")(
  function* (request: Request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const urlShop = segments[2] ?? null;
    const token =
      url.searchParams.get("token") ??
      request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return yield* authorizeShopAgentMember(request, urlShop);

    const shopify = yield* Shopify;
    const subscriptionPlan = yield* SubscriptionPlan;
    return yield* shopify.decodeSessionToken(token).pipe(
      Effect.flatMap((decoded) => {
        const tokenShop = new URL(decoded.dest).hostname;
        return !urlShop || urlShop !== tokenShop
          ? Effect.succeed(new Response("Forbidden", { status: 403 }))
          : Schema.decodeUnknownEffect(Domain.Shop)(tokenShop).pipe(
              Effect.flatMap(subscriptionPlan.resolve),
              Effect.map((status) =>
                Match.value(status).pipe(
                  Match.tagsExhaustive({
                    Subscribed: () =>
                      rebuildRequest(request, {
                        [Domain.CONNECTION_ROLE_HEADER]: "merchant",
                      }),
                    Unsubscribed: () =>
                      new Response("Payment Required", { status: 402 }),
                  }),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logError(
                  `authorizeShopAgentRequest: shop=${tokenShop}: plan resolution failed`,
                ).pipe(
                  Effect.annotateLogs({
                    shop: tokenShop,
                    cause: causeToErrorMessage(cause),
                  }),
                  Effect.as(
                    new Response("Service Unavailable", { status: 503 }),
                  ),
                ),
              ),
            );
      }),
      Effect.catchTag("ResponseError", ({ response }) =>
        Effect.succeed(response),
      ),
    );
  },
);

export default {
  async fetch(request, env, ctx) {
    const { runEffect, managedRuntime } = makeRunEffect(env, request);
    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: (req) => runEffect(authorizeShopAgentRequest(req)),
      onBeforeRequest: (req) => runEffect(authorizeShopAgentRequest(req)),
    });
    if (routed) {
      ctx.waitUntil(managedRuntime.dispose());
      return routed;
    }
    const responsePromise = runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const authResponse = isShopifyAppDocumentRequest(request)
          ? yield* shopify.authenticateAdmin.pipe(
              Effect.as(null),
              Effect.catchTag("ResponseError", ({ response }) =>
                Effect.succeed(response),
              ),
            )
          : null;
        const response =
          authResponse ??
          (yield* tryPromisePassthrough(async () =>
            serverEntry.fetch(request, {
              context: {
                runEffect,
              },
            }),
          ));
        /**
         * Shopify encapsulates document response policy here: HTML gate,
         * shop-param sanitization, and the Cloudflare immutable-response
         * clone/new-Response pattern for header updates.
         */
        const documentResponse = yield* shopify.withShopifyDocumentHeaders(
          request,
          response,
        );
        return yield* withD1BookmarkHeader(documentResponse);
      }),
    );
    // Keep the isolate alive until services are torn down after the response is sent.
    // Ideally: responsePromise.finally(() => managedRuntime.dispose()), but finally's callback
    // is typed () => void and dispose() returns Promise<void>, triggering no-misused-promises.
    // .then(dispose, dispose) is equivalent and returns Promise<void> so waitUntil types correctly.
    const dispose = () => managedRuntime.dispose();
    ctx.waitUntil(responsePromise.then(dispose, dispose));
    return responsePromise;
  },
} satisfies ExportedHandler<Env>;
