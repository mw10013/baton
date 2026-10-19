import { NodeSocket } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { type Email, EmailFromInput } from "../../src/contract/auth.ts";
import type { ShopKey } from "../../src/contract/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_CLOSE_UNINSTALLED,
  type ConnectionCaller,
  type Notice,
  NoticeFrame,
  ShopActorRpcs,
} from "../../src/contract/shop-actor.ts";
import { DevRpcs } from "../../src/contract/dev.ts";
import type { ShopFixtureData } from "../../src/contract/fixture.ts";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { deliverWebhook } from "../shopify-webhook.ts";
import { IntegRpcs } from "./rpcs.ts";

/**
 * Clients for the integ tests, straight at the Backend (no Website or Vite in front): Better
 * Auth sign-in, `DevRpcs` and `IntegRpcs`, and the actor's socket as a browser opens it.
 */

export const email = Schema.decodeUnknownSync(EmailFromInput);

/** One call against the Backend's `DevRpcs`. */
export const dev = <A, E>(
  backendUrl: string,
  f: (
    client: RpcClient.FromGroup<typeof DevRpcs, RpcClientError.RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* RpcClient.make(DevRpcs));
  }).pipe(Effect.scoped, Effect.provide(Test.rpcClientLayer(`${backendUrl}/api/dev`)));

/** One call against the test Backend's `IntegRpcs`. */
export const integ = <A, E>(
  backendUrl: string,
  f: (
    client: RpcClient.FromGroup<typeof IntegRpcs, RpcClientError.RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* RpcClient.make(IntegRpcs));
  }).pipe(Effect.scoped, Effect.provide(Test.rpcClientLayer(`${backendUrl}/api/integ`)));

/** `AddToFixture` with only the parts named; the rest empty. */
export const addToFixture = (backendUrl: string, shop: ShopKey, parts: Partial<ShopFixtureData>) =>
  dev(backendUrl, (client) =>
    client.AddToFixture({
      shop,
      fixture: { members: [], teams: [], workflows: [], orders: [], ...parts },
    }),
  );

/** A magic link for `address` from `IssueMagicLink`. */
const magicLink = (backendUrl: string, address: Email) =>
  integ(backendUrl, (c) => c.IssueMagicLink({ email: address })).pipe(
    Effect.map(({ link }) => new URL(link)),
  );

/** Signs in through an inline magic link and returns the session cookie. */
export const signIn = (backendUrl: string, address: Email) =>
  Effect.gen(function* () {
    const url = yield* magicLink(backendUrl, address);
    const verify = yield* HttpClient.get(url).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    assert.strictEqual(verify.status, 302);
    return Cookies.toCookieHeader(verify.cookies);
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * The origin Better Auth trusts (the stack's `AUTH_ORIGIN`), read off a magic link rather than
 * assumed to be the Backend's URL; a POST to Better Auth with a cookie must name it as its
 * `Origin`.
 */
export const authOrigin = (backendUrl: string, address: Email) =>
  magicLink(backendUrl, address).pipe(Effect.map((url) => url.origin));

/** How a browser proves itself to the Backend: a member's cookie or a merchant's token. */
export type Credential = { readonly cookie: string } | { readonly token: string };

/** The socket URL a browser opens for a shop: the merchant's token, if any, in the query. */
export const socketUrl = (backendUrl: string, key: ShopKey, credential?: Credential) => {
  const url = new URL(`/api/actor/${key}`, backendUrl.replace(/^http/u, "ws"));
  if (credential !== undefined && "token" in credential)
    url.searchParams.set("token", credential.token);
  return url.toString();
};

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/** The close codes a browser does not reconnect after; the test socket stops on them too. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_UNINSTALLED,
]);
const isTerminal = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" && TERMINAL_CODES.has(error.reason.code);

/** Node's WebSocket constructor, sending `headers` in every handshake. */
const withHeaders = (headers: Record<string, string>) =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const make = yield* Socket.WebSocketConstructor;
      return (url: string) => make(url, { headers });
    }),
  ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

/**
 * One browser's socket to a shop's actor: `headers` in the handshake (a member's cookie, or
 * anything a test forges), notice frames taken out onto `received`, and Effect RPC on the
 * rest. Every socket error is offered to `closes`, which is how a test sees the code a socket
 * was closed with; the protocol then reconnects on its own, except after a code a browser
 * treats as terminal. Lives in the caller's scope.
 */
export const connect = (url: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const notices = yield* PubSub.unbounded<Notice>();
    const closes = yield* Queue.unbounded<Socket.SocketError>();
    const socket = Layer.effect(
      Socket.Socket,
      Effect.gen(function* () {
        const inner = yield* Socket.makeWebSocket(url);
        const pullFiltered = (pull: Socket.Reader["pull"]): Socket.Reader["pull"] =>
          Effect.gen(function* () {
            while (true) {
              const rest: Array<Uint8Array | string> = [];
              for (const frame of yield* pull) {
                const notice = typeof frame === "string" ? decodeNotice(frame) : Option.none();
                if (Option.isSome(notice)) yield* PubSub.publish(notices, notice.value);
                else rest.push(frame);
              }
              if (Arr.isArrayNonEmpty(rest)) return rest;
            }
          });
        return Socket.make({
          writer: inner.writer,
          reader: Effect.map(inner.reader, (reader) => ({
            ...reader,
            pull: pullFiltered(reader.pull),
          })),
        });
      }),
    );
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryPolicy: Schedule.spaced("200 millis").pipe(
            Schedule.setInputType<Socket.SocketError>(),
            Schedule.tap(({ input }) => Queue.offer(closes, input)),
            Schedule.while(({ input }) => !isTerminal(input)),
          ),
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
        Layer.provide(withHeaders(headers)),
      ),
    );
    const client = yield* RpcClient.make(ShopActorRpcs).pipe(Effect.provideContext(protocol));
    const received = yield* PubSub.subscribe(notices);
    return { client, received, closes };
  });

/** A browser's socket through the gate, with its credential as the browser sends it. */
export const connectAs = (backendUrl: string, key: ShopKey, credential: Credential) =>
  connect(
    socketUrl(backendUrl, key, credential),
    "cookie" in credential ? { cookie: credential.cookie } : {},
  );

/**
 * A socket opened as any caller through the test Backend's forged-caller route, skipping the
 * gate: how a test gets an identity no sign-in produces, such as an expired session.
 */
export const openAs = (backendUrl: string, key: ShopKey, caller: ConnectionCaller) =>
  connect(new URL(`/api/integ/actor/${key}`, backendUrl.replace(/^http/u, "ws")).toString(), {
    "x-test-caller": JSON.stringify(caller),
  });

/** The server's frame answering request `"1"`, its exit still encoded. */
const decodeExitFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.Literal("Exit"),
      requestId: Schema.Literal("1"),
      exit: Schema.Unknown,
    }),
  ),
);

/**
 * One procedure request written as a raw frame on a forged socket (see {@link openAs}), and the
 * encoded exit the actor answers it with. For a payload {@link connect}'s client cannot send:
 * the client encodes from the payload's type, so it drops a key the schema does not declare.
 */
export const rawRequestAs = (
  backendUrl: string,
  key: ShopKey,
  caller: ConnectionCaller,
  request: { readonly tag: string; readonly payload: unknown },
) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(
      new URL(`/api/integ/actor/${key}`, backendUrl.replace(/^http/u, "ws")).toString(),
    );
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(JSON.stringify({ _tag: "Request", id: "1", headers: [], ...request }));
    while (true) {
      for (const frame of yield* reader.pull) {
        const exit = typeof frame === "string" ? decodeExitFrame(frame) : Option.none();
        if (Option.isSome(exit)) return exit.value.exit;
      }
    }
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.provide(withHeaders({ "x-test-caller": JSON.stringify(caller) })),
  );

/** The next close code a socket saw, within a few seconds. */
export const nextCloseCode = (closes: Queue.Dequeue<Socket.SocketError>) =>
  Queue.take(closes).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((error) => (error.reason._tag === "SocketCloseError" ? error.reason.code : -1)),
  );

/**
 * Shopify's `OrderSync` answer for `node` with `lineItems`, as the wire carries it (ISO dates),
 * for a test to script into the fake.
 */
export const orderSyncAnswer = (node: OrderNode, lineItems: ReadonlyArray<LineItemNode>) => ({
  data: {
    order: {
      ...node,
      processedAt: new Date(node.processedAt).toISOString(),
      updatedAt: new Date(node.updatedAt).toISOString(),
      cancelledAt: node.cancelledAt === null ? null : new Date(node.cancelledAt).toISOString(),
      lineItems: { pageInfo: { hasNextPage: false }, nodes: lineItems },
    },
  },
});

/** Replaces the fake's queues with GraphQL answers `bodies`, in order, clearing its call log. */
export const scriptGraphql = (backendUrl: string, bodies: ReadonlyArray<unknown>) =>
  integ(backendUrl, (c) =>
    c.ScriptShopify({ replies: bodies.map((body) => ({ route: "graphql", status: 200, body })) }),
  );

/**
 * Arranges an order the way production gets one: the fake scripted to answer `node` with
 * `lineItems`, then a signed `orders/create` naming it with no `updated_at`, so the actor always
 * fetches it. Fails the test unless the delivery answers 200. Clears the fake's call log.
 */
export const storeByWebhook = (
  backendUrl: string,
  shop: ShopKey,
  node: OrderNode,
  lineItems: ReadonlyArray<LineItemNode>,
) =>
  Effect.gen(function* () {
    yield* scriptGraphql(backendUrl, [orderSyncAnswer(node, lineItems)]);
    const status = yield* deliverWebhook(`${backendUrl}/webhooks/orders`, "orders/create", shop, {
      id: 0,
      admin_graphql_api_id: node.id,
      updated_at: null,
    });
    assert.strictEqual(status, 200);
    yield* integ(backendUrl, (c) => c.ShopifyCalls({}));
  });

/** Sync from Shopify on `orderId`: `MerchantSyncOrder` on a forged merchant socket to `shop`. */
export const syncOrderAs = (backendUrl: string, shop: ShopKey, orderId: string) =>
  Effect.gen(function* () {
    const { client } = yield* openAs(backendUrl, shop, { role: "merchant" });
    return yield* client.MerchantSyncOrder({ orderId });
  }).pipe(Effect.scoped);
