import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { type Rpc, type RpcGroup, RpcMiddleware, RpcServer } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { CONNECTION_CLOSE_FORBIDDEN, ConnectionCaller } from "../contract/shop-actor.ts";
import { layerStrictJson } from "./strict-serialization.ts";
// Alchemy's internal transport; patches/ adds the exports entry the package lacks.
import * as RpcWebSocket from "alchemy/Cloudflare/RpcWebSocket";

/**
 * Who is on a socket, written into its attachment when the socket is accepted: the caller the
 * Backend's gate resolved, and when the socket was accepted, which
 * orders a member's sockets for displacement.
 */
export const SocketIdentity = Schema.Struct({
  caller: ConnectionCaller,
  connectedAt: Schema.Number,
});
export type SocketIdentity = typeof SocketIdentity.Type;

/**
 * A socket's attachment as the actor reads it: only its own `shopActor` key. Alchemy's
 * transport keeps its record beside it under its own key and rewrites it by spreading the
 * previous attachment, so `shopActor` survives those writes and a hibernation.
 */
const Attachment = Schema.Struct({ shopActor: Schema.optional(SocketIdentity) });
const decodeAttachment = Schema.decodeUnknownOption(Attachment);

/**
 * The identity of the socket whose message is being dispatched, provided around the
 * transport's dispatch. The RPC server runs each call with the dispatching fiber's context,
 * so a middleware reads it there; it is absent everywhere else.
 */
export class ConnectionIdentity extends Context.Service<ConnectionIdentity, SocketIdentity>()(
  "app/ConnectionIdentity",
) {}

/**
 * The identity a socket being accepted gets, and where the accepted socket is recorded.
 * Present only inside {@link ActorSocket}'s `fetch`, which is the only place a socket is
 * accepted.
 */
class PendingAccept extends Context.Service<
  PendingAccept,
  { readonly identity: SocketIdentity; accepted: Option.Option<Cloudflare.Workers.WebSocket> }
>()("app/PendingAccept") {}

/** Keeps the object alive until each call's fiber ends; Alchemy's `RpcDurableObject` does the same. */
class RequestLifetime extends RpcMiddleware.Service<RequestLifetime>()("app/RequestLifetime") {}

/** Reason sent with {@link CONNECTION_CLOSE_FORBIDDEN} to a socket with no identity. */
const UNIDENTIFIED_REASON = "unidentified connection";

/**
 * Effect RPC on a Durable Object's hibernating sockets, with the caller's identity fixed at
 * accept. Alchemy's `RpcDurableObject` accepts the socket before any of the object's code sees
 * the upgrade, and cannot host schemaless methods beside its RPC; this reuses its internal
 * transport and adds the identity at accept and on each message.
 *
 * - `fetch(identity)` accepts the upgrade in hand: the identity goes into the socket's
 *   attachment and `onAccept`'s tags onto the socket, before the RPC transport records it.
 * - `webSocketMessage` reads the identity back from the attachment (cached per activation), hands
 *   it to `beforeDispatch`, which may close the socket and decline, and dispatches with
 *   {@link ConnectionIdentity} provided. A socket with no identity is closed with
 *   {@link CONNECTION_CLOSE_FORBIDDEN}.
 *
 * Payloads are decoded by {@link layerStrictJson}.
 *
 * Built once per activation, in the object's inner Effect.
 *
 * @see node_modules/alchemy/src/Cloudflare/Workers/RpcWebSocket.ts `make`
 * @see node_modules/alchemy/src/Cloudflare/Workers/RpcDurableObject.ts `makeHandlers`
 */
export const make = Effect.fn("ActorSocket.make")(function* <Rpcs extends Rpc.Any, RH>(options: {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly handlers: Layer.Layer<Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs>, never, RH>;
  readonly onAccept: (identity: SocketIdentity) => { readonly tags: ReadonlyArray<string> };
  readonly beforeDispatch: (
    identity: SocketIdentity,
    socket: Cloudflare.Workers.WebSocket,
  ) => Effect.Effect<boolean>;
}) {
  const state = yield* Cloudflare.DurableObjectState;
  const runtime = yield* RuntimeContext;
  const decorated: Cloudflare.DurableObjectState["Service"] = {
    ...state,
    acceptWebSocket: (ws, tags) =>
      Effect.gen(function* () {
        const pending = yield* Effect.serviceOption(PendingAccept);
        if (Option.isNone(pending))
          return yield* Effect.die(new Error("a socket was accepted outside ActorSocket.fetch"));
        const { identity } = pending.value;
        yield* state.acceptWebSocket(ws, [...(tags ?? []), ...options.onAccept(identity).tags]);
        ws.serializeAttachment({ ...ws.deserializeAttachment<object>(), shopActor: identity });
        pending.value.accepted = Option.some(ws);
      }),
  };

  // The protocol outlives the constructor's temporary layer scope.
  return yield* Effect.acquireUseRelease(
    Scope.make(),
    (instanceScope) =>
      Effect.gen(function* () {
        const memoMap = Layer.makeMemoMapUnsafe();
        const context = yield* Layer.buildWithMemoMap(options.handlers, memoMap, instanceScope);
        const lifetime = Layer.succeed(RequestLifetime, (effect) =>
          Effect.withFiber((fiber) =>
            // RpcServer sends Exit before finalization and drops sends after disconnect.
            state
              .waitUntil(Fiber.await(fiber))
              .pipe(Effect.provideService(RuntimeContext, runtime), Effect.andThen(effect)),
          ),
        );
        const transport = yield* RpcWebSocket.make.pipe(
          Effect.provideService(Cloudflare.DurableObjectState, decorated),
          Effect.provide(layerStrictJson),
        );
        yield* Layer.buildWithMemoMap(
          RpcServer.layer(options.group.middleware(RequestLifetime)).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeedContext(context),
                lifetime,
                Layer.succeed(RpcServer.Protocol, transport.protocol),
              ),
            ),
          ),
          memoMap,
          instanceScope,
        );

        /** Identities by raw socket, for this activation only; rebuilt from attachments after a wake. */
        const identities = new WeakMap<Cloudflare.Workers.RawWebSocket, SocketIdentity>();
        const identityOf = (socket: Cloudflare.Workers.WebSocket) =>
          Effect.sync(() => {
            const cached = identities.get(socket.ws);
            if (cached !== undefined) return Option.some(cached);
            const identity = Option.flatMap(
              decodeAttachment(socket.deserializeAttachment<unknown>()),
              ({ shopActor }) => Option.fromUndefinedOr(shopActor),
            );
            if (Option.isSome(identity)) identities.set(socket.ws, identity.value);
            return identity;
          });

        const fetch = (identity: SocketIdentity) =>
          Effect.gen(function* () {
            const pending = PendingAccept.of({ identity, accepted: Option.none() });
            const response = yield* transport.fetch.pipe(
              Effect.provideService(PendingAccept, pending),
            );
            return { response, socket: pending.accepted };
          });

        const webSocketMessage = (
          socket: Cloudflare.Workers.WebSocket,
          message: string | ArrayBuffer,
        ) =>
          Effect.gen(function* () {
            const identity = yield* identityOf(socket);
            if (Option.isNone(identity))
              return yield* socket.close(CONNECTION_CLOSE_FORBIDDEN, UNIDENTIFIED_REASON);
            if (!(yield* options.beforeDispatch(identity.value, socket))) return;
            yield* transport
              .webSocketMessage(socket, message)
              .pipe(Effect.provideService(ConnectionIdentity, identity.value));
          });

        return {
          fetch,
          webSocketMessage,
          webSocketClose: (socket: Cloudflare.Workers.WebSocket) =>
            Effect.sync(() => identities.delete(socket.ws)).pipe(
              Effect.andThen(transport.webSocketClose(socket)),
            ),
          webSocketError: (socket: Cloudflare.Workers.WebSocket, error: unknown) =>
            Effect.sync(() => identities.delete(socket.ws)).pipe(
              Effect.andThen(transport.webSocketError(socket, error)),
            ),
        };
      }),
    (instanceScope, exit) =>
      Exit.isFailure(exit) ? Scope.close(instanceScope, exit) : Effect.void,
  );
});
