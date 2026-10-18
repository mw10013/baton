import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/contract/shop.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_HEADER,
  ORDERS_KEY,
} from "../../src/contract/shop-actor.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import {
  authOrigin,
  type Credential,
  connect,
  connectAs,
  addToFixture,
  dev,
  email,
  nextCloseCode,
  openAs,
  signIn,
  socketUrl,
} from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend with `ShopActor` into workerd and drives the actor as browsers do,
 * straight at the Backend (no Website or Vite in front): sockets named by the gate on their
 * upgrade, the gate's refusals as close codes, the role split, and revocation, displacement
 * and session expiry closing the right sockets.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("shopactor"),
});

/** A fresh stage per file, destroyed afterwards; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const key = SEED_SHOP;
const otherShop = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
const m1 = email("m1@m.com");
const m2 = email("m2@m.com");

/** A browser's socket through the gate, open once its first call is answered. */
const open = (backendUrl: string, credential: Credential) =>
  Effect.gen(function* () {
    const socket = yield* connectAs(backendUrl, key, credential);
    yield* "cookie" in credential ? socket.client.MemberWhoAmI() : socket.client.MerchantWhoAmI();
    return socket;
  });

/** A merchant's Shopify session token for a shop, signed with the fake app's secret. */
const merchantToken = (shop: ShopKey = key) => mintSessionToken({ shop });

/** One page of a state of the workflows list, every team. */
const listOf = (state: ShopWork.WorkflowsListState) => ({
  query: Schema.decodeUnknownSync(ShopWork.RunQuery)({
    team: null,
    state,
    limit: ShopWork.RUN_PAGE,
    q: null,
  }),
});

/** The orders index's first page, every order. */
const EVERY_ORDER = Schema.decodeUnknownSync(ShopWork.ListOrdersInput)({
  limit: 25,
  cursor: null,
  q: null,
  show: "all",
  team: null,
});

/** No close arrives within a moment. */
const assertOpen = (closes: Queue.Dequeue<unknown>) =>
  Effect.gen(function* () {
    yield* Effect.sleep("500 millis");
    assert.isTrue(Option.isNone(yield* Queue.poll(closes)), "the socket stayed open");
  });

test(
  "two sockets share one actor: a write on one notifies both",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    // A member of its own on a team with one ready task, so the write is a run's.
    const sharer = email("share@e2e.test");
    yield* addToFixture(
      backendUrl,
      key,
      Schema.decodeUnknownSync(ShopFixtureData)({
        members: [sharer],
        teams: [{ name: "Share", members: [sharer] }],
        workflows: [{ name: "Share", tag: "share", tasks: [{ name: "Cut", team: "Share" }] }],
        orders: [{ n: 7001, lineItems: [{ title: "Ring", quantity: 1, tags: ["share"] }] }],
      }),
    );
    const cookie = yield* signIn(backendUrl, sharer);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie });
      const ready = yield* a.client.MemberListRuns(listOf("ready"));
      const task = ready.items[0]?.tasks[0];
      if (task === undefined) return yield* Effect.die(new Error("no ready task"));
      const started = yield* a.client.MemberStartTask({ runTaskId: task.id });
      assert.deepStrictEqual(started, { _tag: "Ok" });

      const notice = yield* PubSub.take(b.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });
      const mine = yield* b.client.MemberListRuns(listOf("started_by_you"));
      assert.deepStrictEqual([mine.counts.ready, mine.counts.started_by_you], [0, 1]);
    }).pipe(Effect.scoped);
  }),
);

test(
  "roles: a merchant reads the orders index and a member may not; a member reads the workflows list and a merchant may not",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    const token = yield* merchantToken();
    yield* Effect.gen(function* () {
      const merchant = yield* open(backendUrl, { token });
      const member = yield* open(backendUrl, { cookie });
      assert.deepStrictEqual(yield* merchant.client.MerchantWhoAmI(), { role: "merchant" });
      yield* merchant.client.MerchantListOrders(EVERY_ORDER);
      yield* member.client.MemberListRuns(listOf("ready"));
      for (const error of [
        yield* member.client.MerchantListOrders(EVERY_ORDER).pipe(Effect.flip),
        yield* member.client.MerchantWhoAmI().pipe(Effect.flip),
        yield* merchant.client.MemberListRuns(listOf("ready")).pipe(Effect.flip),
      ])
        assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
  }),
);

test(
  "a forged connection header on the browser's upgrade is dropped by the gate",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const socket = yield* connect(socketUrl(backendUrl, key), {
        cookie,
        [CONNECTION_HEADER]: JSON.stringify({ role: "merchant" }),
      });
      const caller = yield* socket.client.MemberWhoAmI();
      assert.strictEqual(caller.role, "member");
      assert.strictEqual(caller.role === "member" && caller.memberEmail, m1);
      const error = yield* socket.client.MerchantListOrders(EVERY_ORDER).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
  }),
);

test(
  "sign-out closes only that session's sockets with 3401",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const first = yield* signIn(backendUrl, m1);
    const second = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie: first });
      const b = yield* open(backendUrl, { cookie: second });
      const origin = yield* authOrigin(backendUrl, m1);
      const signOut = yield* HttpClient.execute(
        HttpClientRequest.post(`${backendUrl}/api/auth/sign-out`).pipe(
          HttpClientRequest.setHeaders({ cookie: first, origin }),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(signOut.status, 200);
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      yield* assertOpen(b.closes);
    }).pipe(Effect.scoped);
  }),
);

test(
  "RemoveMember closes the member's sockets with 3401 and the gate then refuses it with 4404",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const removed = email("integ-removed@e2e.test");
    yield* addToFixture(backendUrl, key, { members: [removed] });
    const cookie = yield* signIn(backendUrl, removed);
    const other = yield* signIn(backendUrl, m2);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie: other });
      const result = yield* dev(backendUrl, (c) => c.RemoveMember({ shop: key, email: removed }));
      assert.deepStrictEqual(result, { removed: true, closed: 1 });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
      // The reconnect goes back through the gate, which no longer finds the member.
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_NOT_A_MEMBER);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      yield* assertOpen(b.closes);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member's third socket displaces the oldest with 4409; merchants are not capped",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    const token = yield* merchantToken();
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie });
      const c = yield* open(backendUrl, { cookie });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_DISPLACED);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      assert.strictEqual((yield* c.client.MemberWhoAmI()).role, "member");
      yield* assertOpen(b.closes);

      const merchants = [
        yield* open(backendUrl, { token }),
        yield* open(backendUrl, { token }),
        yield* open(backendUrl, { token }),
      ];
      for (const merchant of merchants) {
        assert.deepStrictEqual(yield* merchant.client.MerchantWhoAmI(), { role: "merchant" });
        yield* assertOpen(merchant.closes);
      }
    }).pipe(Effect.scoped);
  }),
);

test(
  "a socket whose session has expired is closed with 3401 on its next message",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const socket = yield* openAs(backendUrl, key, {
        role: "member",
        memberId: "mem-1",
        memberEmail: m1,
        teamIds: [],
        userId: "user-expired",
        sessionId: "session-expired",
        sessionExpiresAt: Date.now() - 1,
      });
      yield* socket.client.MemberWhoAmI().pipe(Effect.forkScoped);
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
);

test(
  "the gate: 4401, 4403 and 4404 close a refused upgrade, an expired merchant token included",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const admin = yield* signIn(backendUrl, email("a@a.com"));
    const member2 = yield* signIn(backendUrl, m2);
    const otherShopToken = yield* merchantToken(otherShop);
    const closeCode = (shop: ShopKey, credential?: Credential) =>
      Effect.gen(function* () {
        const socket = yield* connect(
          socketUrl(backendUrl, shop, credential),
          credential !== undefined && "cookie" in credential ? { cookie: credential.cookie } : {},
        );
        return yield* nextCloseCode(socket.closes);
      }).pipe(Effect.scoped);

    assert.strictEqual(yield* closeCode(key), CONNECTION_CLOSE_UNAUTHENTICATED, "no session");
    assert.strictEqual(
      yield* closeCode(key, { cookie: admin }),
      CONNECTION_CLOSE_FORBIDDEN,
      "admin",
    );
    assert.strictEqual(
      yield* closeCode(otherShop, { cookie: member2 }),
      CONNECTION_CLOSE_NOT_A_MEMBER,
      "not a member of that shop",
    );
    assert.strictEqual(
      yield* closeCode(key, { token: otherShopToken }),
      CONNECTION_CLOSE_FORBIDDEN,
      "a token for another shop",
    );
    assert.strictEqual(
      yield* closeCode(key, { token: "bad" }),
      CONNECTION_CLOSE_UNAUTHENTICATED,
      "a bad token",
    );
    assert.strictEqual(
      yield* closeCode(key, { token: yield* mintSessionToken({ shop: key, expiresIn: -60 }) }),
      CONNECTION_CLOSE_UNAUTHENTICATED,
      "an expired token",
    );
  }),
);

test(
  "anything but an upgrade under /api/actor/<key> is 426; a path naming no key is 404",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const get = yield* HttpClient.get(`${backendUrl}/api/actor/${key}`);
    assert.strictEqual(get.status, 426);
    const post = yield* HttpClient.execute(
      HttpClientRequest.post(`${backendUrl}/api/actor/${key}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    assert.strictEqual(post.status, 426);
    const none = yield* HttpClient.get(`${backendUrl}/api/actor/NOT-A-KEY`);
    assert.strictEqual(none.status, 404);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
