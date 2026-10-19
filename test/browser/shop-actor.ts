import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { onTestFinished } from "vite-plus/test";
import {
  ConnectionMiddleware,
  CurrentCaller,
  RequireMember,
  RequireMerchant,
  ShopActorRpcs,
} from "../../src/contract/shop-actor.ts";
import { ShopActorClient } from "../../src/web/client/shop-actor-client.ts";

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ShopActorRpcs>>;

/** Dies on any RPC a test did not give a handler, so a test names every call its component makes. */
const unexpected = Object.fromEntries(
  [...ShopActorRpcs.requests.keys()].map((tag) => [tag, () => Effect.die(`unexpected ${tag}`)]),
) as unknown as Handlers;

/**
 * The actor's middlewares with no socket: every role check passes, so a test reaches every
 * handler it names, and the caller is a placeholder no test handler reads (a who-am-I test
 * gives its own answer). Roles are the actor's concern and are tested against it in integ.
 */
const roleMiddlewares = Layer.mergeAll(
  Layer.succeed(ConnectionMiddleware)(
    ConnectionMiddleware.of((effect) =>
      Effect.provideService(effect, CurrentCaller, { role: "merchant" }),
    ),
  ),
  Layer.succeed(RequireMember)(RequireMember.of((effect) => effect)),
  Layer.succeed(RequireMerchant)(RequireMerchant.of((effect) => effect)),
);

/** {@link ShopActorClient} over the given handlers, in memory: no socket, notice tap or actor. */
export const shopActorClientLayer = (handlers: Partial<Handlers>) =>
  Layer.effect(ShopActorClient, RpcTest.makeClient(ShopActorRpcs, { flatten: true })).pipe(
    Layer.provide(ShopActorRpcs.toLayer({ ...unexpected, ...handlers })),
    Layer.provide(roleMiddlewares),
  );

/**
 * A registry whose {@link ShopActorClient} atoms run on {@link shopActorClientLayer}, disposed
 * when the test finishes.
 */
export const shopTestRegistry = (handlers: Partial<Handlers>) => {
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(ShopActorClient.runtime.layer, shopActorClientLayer(handlers)),
    ],
  });
  onTestFinished(() => registry.dispose());
  return registry;
};
