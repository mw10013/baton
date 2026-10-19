import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/contract/shop.ts";
import { ConnectionCaller } from "../../src/contract/shop-actor.ts";
import { BackendApi } from "../../src/backend/api.ts";
import { Auth } from "../../src/backend/auth.ts";
import {
  backendBody,
  backendProps,
  forwardedUpgrade,
  isUpgrade,
  provideBackend,
  upgradeRequired,
} from "../../src/backend/backend.ts";
import { MagicLinkDelivery } from "../../src/backend/magic-link-delivery.ts";
import { MembershipRepository } from "../../src/backend/membership-repository.ts";
import ShopActor from "../../src/backend/shop-actor/tag.ts";
import { ShopActors } from "../../src/backend/shop-actors.ts";
import { AppEventsFake } from "./app-events-fake.ts";
import { PartnerFake } from "./partner-fake.ts";
import { ShopSessionRepository } from "../../src/backend/shop-session-repository.ts";
import { SubscriptionPlan } from "../../src/backend/subscription-plan.ts";
import { IntegHandlers, IntegRpcs } from "./rpcs.ts";
import { ShopifyFake } from "./shopify-fake.ts";

/** `/api/integ/actor/<key>` split on `/`; see {@link TestBackend}. */
const ForgedActorPath = Schema.Tuple([
  Schema.Literal(""),
  Schema.Literal("api"),
  Schema.Literal("integ"),
  Schema.Literal("actor"),
  ShopKey,
]);
const decodeForgedActorPath = Schema.decodeUnknownOption(ForgedActorPath);
const decodeCaller = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCaller));

/**
 * The Backend as integ deploys it: the production Backend's own wiring ({@link backendBody},
 * inside the same {@link provideBackend}, so these handlers share its services, such as the links
 * Better Auth hands to `MagicLinkDelivery`), with integ's own doors in front of its `fetch`:
 *
 * - {@link IntegRpcs} on `/api/integ`;
 * - `/api/integ/actor/<key>`, an upgrade forwarded to the actor as whatever {@link ConnectionCaller}
 *   the JSON in `x-test-caller` names, skipping the gate, so a test opens a socket as an identity
 *   no sign-in produces, such as an expired session; 404 when the header does not decode;
 * - {@link AppEventsFake} and {@link PartnerFake} in place of the App Events and Partner APIs,
 *   passed to {@link provideBackend} as the Backend's billing clients;
 * - {@link ShopifyFake} in place of the Shopify library's fetch, installed after the shared
 *   wiring so it is the one the library calls;
 * - `/api/integ/bulk/<n>`, the next bulk result file scripted into {@link ShopifyFake}: the URL a
 *   scripted `bulkOperation` names, which the shop's actor fetches over the network.
 *
 * Its own logical id keeps its bundle and logs apart from the dev server's `Backend`; nothing in
 * `src/` imports it, so the production bundle never carries it.
 */
export default class TestBackend extends Cloudflare.Worker<TestBackend>()(
  "TestBackend",
  { ...backendProps, main: import.meta.filename },
  provideBackend(
    Effect.gen(function* () {
      const base = yield* backendBody;
      const actors = yield* ShopActor;
      const services = yield* Effect.context<
        | AppEventsFake
        | PartnerFake
        | ShopSessionRepository
        | SubscriptionPlan
        | Auth
        | BackendApi
        | MagicLinkDelivery
        | MembershipRepository
        | ShopifyFake
        | ShopActors
      >();
      const shopifyFake = yield* ShopifyFake;
      // Built per request, inside the request's scope, as the Backend's own RPC servers are.
      const integ = RpcServer.toHttpEffect(IntegRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(IntegHandlers, RpcSerialization.layerNdjson).pipe(
            Layer.provide(Layer.succeedContext(services)),
          ),
        ),
      );

      const fetch = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { pathname } = new URL(request.url, "http://backend");
        if (pathname === "/api/integ" || pathname === "/api/integ/") return yield* yield* integ;
        if (pathname.startsWith("/api/integ/bulk/"))
          return HttpServerResponse.fromWeb(yield* shopifyFake.takeBulk);
        const forged = decodeForgedActorPath(pathname.split("/"));
        if (Option.isSome(forged)) {
          const key = forged.value[4];
          const caller = decodeCaller(request.headers["x-test-caller"]);
          if (Option.isNone(caller)) return HttpServerResponse.empty({ status: 404 });
          if (!isUpgrade(request)) return upgradeRequired;
          return yield* actors
            .getByName(key)
            .fetch(forwardedUpgrade(request, `/api/actor/${key}`, caller.value));
        }
        return yield* base.fetch;
      });
      // Spread first, so the `BackendApi` methods stay beside the new `fetch`.
      return { ...base, fetch };
    }).pipe(Effect.provide(ShopifyFake.layer)),
    Layer.mergeAll(AppEventsFake.layer, PartnerFake.layer),
  ),
) {}
