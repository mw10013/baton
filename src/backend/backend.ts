import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Schema from "effect/Schema";
import { ShopKey } from "../contract/shop.ts";
import {
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_TRY_AGAIN,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_HEADER,
  ConnectionCaller,
} from "../contract/shop-actor.ts";
import { DevRpcs } from "../contract/dev.ts";
import { ShopActors } from "./shop-actors.ts";
import { BackendApi, SignInLimiter } from "./api.ts";
import { Auth } from "./auth.ts";
import { DevHandlers } from "./dev.ts";
import { Fixtures } from "./fixture.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { OrdersBulkOperation } from "./orders-bulk-operation.ts";
import { OrdersSyncWorkflow } from "./orders-sync-workflow.ts";
import { Mailer } from "./mailer.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { AuthDb } from "./resources.ts";
import { ShopAccess, type ShopAccessDenied } from "./shop-access.ts";
import { Shopify } from "./shopify.ts";
import { ShopifyAdmin } from "./shopify-admin.ts";
import { ShopifyAppEvents } from "./shopify-app-events.ts";
import { ShopifyPartner } from "./shopify-partner.ts";
import { revalidateStalePlans, SubscriptionPlan } from "./subscription-plan.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import { workerNameOf } from "./stage.ts";
import { Webhooks } from "./webhooks.ts";
import { ShopActorLive } from "./shop-actor.ts";
import ShopActor from "./shop-actor/tag.ts";

/** Under `alchemy dev` the limiter is open; see {@link SignInLimiter.layerOpen}. */
const signInLimiter = Layer.unwrap(
  Effect.map(Alchemy.ALCHEMY_DEV, (dev) => (dev ? SignInLimiter.layerOpen : SignInLimiter.layer)),
);

/**
 * `/api/actor/<key>` split on `/`, optionally with a trailing slash, where the key decodes as
 * {@link ShopKey}. A tuple rejects extra segments.
 */
const ActorPath = Schema.Union([
  Schema.Tuple([Schema.Literal(""), Schema.Literal("api"), Schema.Literal("actor"), ShopKey]),
  Schema.Tuple([
    Schema.Literal(""),
    Schema.Literal("api"),
    Schema.Literal("actor"),
    ShopKey,
    Schema.Literal(""),
  ]),
]);
const decodeActorPath = Schema.decodeUnknownOption(ActorPath);

/** The shop key of an {@link ActorPath}; None for any other path. */
const actorKeyFromPath = (pathname: string): Option.Option<ShopKey> =>
  Option.map(decodeActorPath(pathname.split("/")), (segments) => segments[3]);

/** Whether a path is addressed to an actor at all, so one that names no {@link ShopKey} is 404. */
const isActorPath = (pathname: string) =>
  pathname === "/api/actor" || pathname.startsWith("/api/actor/");

/**
 * The headers a WebSocket handshake itself needs: the only ones an upgrade forwarded to the
 * actor keeps (Baton's list, without its PartyKit namespace header, which nothing here uses).
 */
const FORWARDED_HANDSHAKE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
] as const;

const encodeConnectionHeader = Schema.encodeSync(Schema.fromJsonString(ConnectionCaller));

/** The gate's refusal as the close code the browser reads, with a short reason. */
const refusalClose = (status: ShopAccessDenied["status"]) =>
  Match.value(status).pipe(
    Match.when(401, () => ({ code: CONNECTION_CLOSE_UNAUTHENTICATED, reason: "unauthenticated" })),
    Match.when(402, () => ({
      code: CONNECTION_CLOSE_PAYMENT_REQUIRED,
      reason: "payment required",
    })),
    Match.when(403, () => ({ code: CONNECTION_CLOSE_FORBIDDEN, reason: "forbidden" })),
    Match.when(404, () => ({ code: CONNECTION_CLOSE_NOT_A_MEMBER, reason: "not a member" })),
    Match.when(503, () => ({ code: CONNECTION_CLOSE_TRY_AGAIN, reason: "try again" })),
    Match.exhaustive,
  );

/**
 * Accepts an upgrade the gate refused and closes it at once with {@link refusalClose}'s code. A
 * refused handshake reaches a browser's `WebSocket` only as a bare 1006 with no status, and the
 * Website's dev server drops it altogether, so the answer travels as a close code instead.
 */
const refuseUpgrade = (status: ShopAccessDenied["status"]) =>
  Effect.sync(() => {
    const { code, reason } = refusalClose(status);
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(code, reason);
    return HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(new Response(null, { status: 101, webSocket: pair[0] })),
    );
  });

/**
 * The upgrade the actor sees: rebuilt from nothing but {@link FORWARDED_HANDSHAKE_HEADERS} and
 * {@link CONNECTION_HEADER} naming `caller`. The cookie, `authorization`, the merchant's
 * `?token=` and any incoming `x-actor-*` header never reach the actor, so a browser cannot name
 * itself.
 */
export const forwardedUpgrade = (
  request: HttpServerRequest.HttpServerRequest,
  pathname: string,
  caller: ConnectionCaller,
) => {
  const headers = new Headers();
  for (const name of FORWARDED_HANDSHAKE_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers.set(name, value);
  }
  headers.set(CONNECTION_HEADER, encodeConnectionHeader(caller));
  return HttpServerRequest.fromWeb(
    new Request(new URL(pathname, "http://backend"), { method: "GET", headers }),
  );
};

export const isUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" && request.headers.upgrade?.toLowerCase() === "websocket";

export const upgradeRequired = HttpServerResponse.empty({
  status: 426,
  headers: { upgrade: "websocket" },
});

/**
 * The Backend Worker's props, every one but `main`: each entry, the production one and the integ
 * harness's, sets its own `main` to its own file, which is what Alchemy bundles.
 */
export const backendProps = {
  name: Output.fromEffect(Effect.map(Alchemy.Stage, (stage) => workerNameOf(stage, "backend"))),
  workersDev: false,
  // Only reached through the service binding, so any free port will do.
  dev: { port: 0 },
  compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
};

/**
 * The Backend's init: built once per isolate, it answers `fetch` and {@link BackendApi}'s
 * methods, which the Website's server functions call over the `BACKEND` service binding and
 * which the binding carries schemaless. Run it only through {@link provideBackend}.
 *
 * `fetch` serves Better Auth's routes under `/api/auth`, Shopify's webhooks under `/webhooks/`
 * ({@link Webhooks}), {@link DevRpcs} on `/api/dev`, and the actor's sockets; anything else is
 * 404.
 *
 * It hosts {@link ShopActor} and forwards a WebSocket upgrade on `/api/actor/<key>` (see
 * {@link actorKeyFromPath}) to the actor named by the key, after {@link ShopAccess}, the gate,
 * has resolved the browser: the forwarded request names the caller in {@link CONNECTION_HEADER}
 * (see {@link forwardedUpgrade}), and a refusal is a socket closed at once with a close code
 * (see {@link refuseUpgrade}). Anything but an upgrade there is 426: there is no HTTP RPC into
 * the actor. A path under `/api/actor/` that names no key is 404.
 *
 * It also hosts {@link OrdersSyncWorkflow}. Nothing here creates an instance; the shop's actor
 * does, over the handle its own outer phase yields. The yield here is for the class export: at
 * runtime this init does not run the actor's outer phase (only at plan, against a mock state),
 * so without it an isolate where no actor has activated would have no Workflow class to run an
 * instance in. Alchemy memoizes by logical id, so the two yields are one Workflow.
 *
 * {@link DevRpcs} on `/api/dev` exists only with the `DEV_ENDPOINT` binding; see there.
 *
 * It runs the daily plan check on a cron, `17 4 * * *` ({@link revalidateStalePlans}).
 */
export const backendBody = Effect.gen(function* () {
  // Built once per isolate. Yielding the bindings here attaches them to the Worker.
  const { auth } = yield* Auth;
  const actors = yield* ShopActor;
  yield* OrdersSyncWorkflow;
  const shopAccess = yield* ShopAccess;
  const api = yield* BackendApi;
  const webhooks = yield* Webhooks;
  const services = yield* Effect.context<
    MembershipRepository | ShopifyAdmin | ShopActors | ShopSessionRepository
  >();
  const planServices = yield* Effect.context<ShopSessionRepository | SubscriptionPlan>();
  // The daily plan check (`revalidateStalePlans`). The event source swallows a handler's failure,
  // so the failure is logged here.
  yield* Cloudflare.Workers.cron("17 4 * * *", () =>
    revalidateStalePlans().pipe(
      Effect.provide(planServices),
      Effect.catchCause((cause) => Effect.logError("scheduled.revalidatePlans", cause)),
    ),
  );
  const devEndpoint = Option.isSome(yield* Config.option(Config.String("DEV_ENDPOINT")));
  // The RPC server is built per request, inside the request's scope (workerd pins I/O to
  // the request that created it).
  const dev = devEndpoint
    ? Option.some(
        RpcServer.toHttpEffect(DevRpcs).pipe(
          Effect.provide(
            Layer.mergeAll(DevHandlers, RpcSerialization.layerNdjson).pipe(
              Layer.provide(Fixtures.layer),
              Layer.provide(Layer.succeedContext(services)),
            ),
          ),
        ),
      )
    : Option.none();

  /**
   * The actor branch: the gate on the upgrade, then the upgrade forwarded as the caller it
   * resolved. A merchant's Shopify session token arrives as `?token=`, Baton's form for a
   * socket; a member is resolved from the cookie.
   */
  const forwardToActor = Effect.fn("Backend.forwardToActor")(function* (
    key: ShopKey,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (!isUpgrade(request)) return upgradeRequired;
    const url = new URL(request.url, "http://backend");
    const caller = yield* shopAccess
      .resolve({
        key,
        cookie: request.headers.cookie,
        sessionToken: Option.getOrUndefined(Option.fromNullishOr(url.searchParams.get("token"))),
      })
      .pipe(Effect.result);
    if (caller._tag === "Failure") return yield* refuseUpgrade(caller.failure.status);
    return yield* actors
      .getByName(key)
      .fetch(forwardedUpgrade(request, url.pathname, caller.success));
  });

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { pathname } = new URL(request.url, "http://backend");
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return yield* auth.fetch;
    if (pathname.startsWith("/webhooks/")) return yield* webhooks.serve(request);
    if (isActorPath(pathname))
      return yield* Option.match(actorKeyFromPath(pathname), {
        onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        onSome: (key) => forwardToActor(key, request),
      });
    // Effect's HTTP RPC client posts to its URL with a trailing slash.
    if (pathname === "/api/dev" || pathname === "/api/dev/")
      return Option.isSome(dev)
        ? yield* yield* dev.value
        : HttpServerResponse.empty({ status: 404 });
    return HttpServerResponse.empty({ status: 404 });
  });
  return { fetch, ...api };
});

/**
 * The Backend's clients of Shopify's billing APIs, which only Shopify answers: the production
 * entry passes the real ones, and the test Backend its fakes, so a fake never reaches the
 * production bundle.
 */
export type ShopifyBilling = ShopifyAppEvents | ShopifyPartner;

/**
 * Provides everything {@link backendBody} needs, `billing` included (whose extra services, a
 * test's fakes, reach `effect` too). An entry that serves more
 * than the body runs its own handlers inside the same call, so they get the very service
 * instances the body has (the magic links Better Auth handed to `MagicLinkDelivery`, for one); a
 * second build would make a second set.
 */
export const provideBackend = <A, E, R, B = never>(
  effect: Effect.Effect<A, E, R>,
  billing: Layer.Layer<ShopifyBilling | B>,
) =>
  effect.pipe(
    Effect.provide(BackendApi.layer),
    Effect.provide(Webhooks.layer),
    Effect.provide(ShopAccess.layer),
    Effect.provide(SubscriptionPlan.layer),
    Effect.provide(Auth.layer),
    Effect.provide(ShopActors.layer),
    Effect.provide(ShopActorLive),
    Effect.provide(MagicLinkDelivery.layer),
    Effect.provide(OrdersBulkOperation.layer),
    Effect.provide(
      Layer.mergeAll(
        billing,
        MembershipRepository.layer,
        Mailer.layer,
        signInLimiter,
        ShopifyAdmin.layer.pipe(
          Layer.provideMerge(Shopify.layer.pipe(Layer.provideMerge(ShopSessionRepository.layer))),
        ),
      ),
    ),
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  );

/** The Backend's init as the production entry runs it: {@link backendBody}, provided. */
export const makeBackend = () =>
  provideBackend(backendBody, Layer.mergeAll(ShopifyAppEvents.layer, ShopifyPartner.layer));
