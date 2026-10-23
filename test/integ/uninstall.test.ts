import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { CONNECTION_CLOSE_UNINSTALLED } from "../../src/contract/shop-actor.ts";
import type { ShopKey } from "../../src/domain/platform.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { signWebhook } from "../shopify-webhook.ts";
import { dev, email, integ, nextCloseCode, openAs, storeByWebhook } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * `app/uninstalled` against the real Backend, D1 and actor, on a stage of its own so the shop it
 * tears down is no other file's: the session and its cascade go, the actor's sockets close
 * terminally, its storage goes, and a later delivery does not bring the actor back. Local
 * workerd writes storage synchronously, so this cannot show a delete lost to a reset before
 * `storage.sync()`; only staging can.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("uninstall"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** POSTs a signed `topic` delivery of `payload` for `shop`; the status. */
const deliver = (
  backendUrl: string,
  path: string,
  topic: string,
  payload: unknown,
  shop: ShopKey = SEED_SHOP,
) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${backendUrl}${path}`).pipe(
        HttpClientRequest.setHeaders(yield* signWebhook(topic, shop, body)),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );
    return response.status;
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Every file of the actors' local storage on this file's stage, by name, with its size and
 * modification time: one SQLite database per actor beside `metadata.sqlite`, under the directory
 * Alchemy names after the script and the class. An actor's file is named after the actor, so a
 * recreated actor reuses it; what shows a recreation is the write its migration makes.
 */
const actorStorage = (backendName: string) => {
  const directory = join(".alchemy", "local", `${backendName}-ShopActor`);
  return Object.fromEntries(
    readdirSync(directory).map((file) => {
      const { size, mtimeMs } = statSync(join(directory, file));
      return [file, `${String(size)}@${String(mtimeMs)}`];
    }),
  );
};

const ORDER_ID = "gid://shopify/Order/1";

/**
 * The late `orders/create` leaves the storage files untouched and calls no Shopify, so it
 * created nothing. `GetOrder` goes last: it reaches the actor by name with no guard of its own,
 * so it is refused by the actor itself, and the files stay untouched again.
 */
test(
  "uninstall deletes the shop row, its members and teams, and destroys the object",
  Effect.gen(function* () {
    const { backendUrl, backendName } = yield* stack;
    yield* storeByWebhook(
      backendUrl,
      SEED_SHOP,
      {
        id: ORDER_ID,
        legacyResourceId: "1",
        name: "#1001",
        processedAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        cancelledAt: null,
        displayFulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
      },
      [],
    );
    assert.isNotNull(
      yield* integ(backendUrl, (c) => c.GetOrder({ shop: SEED_SHOP, orderId: ORDER_ID })),
    );
    const before = yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
    assert.isNotEmpty(before.emails);
    assert.isNotEmpty(before.teams);

    yield* Effect.gen(function* () {
      const socket = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-1",
        memberEmail: email("m1@m.com"),
        teamIds: [],
        userId: "user-1",
        sessionId: "session-1",
        sessionExpiresAt: Date.now() + 60_000,
      });
      yield* socket.client.MemberWhoAmI();
      assert.strictEqual(
        yield* deliver(backendUrl, "/webhooks/app/uninstalled", "app/uninstalled", {
          id: 1,
          domain: SEED_SHOP,
        }),
        200,
      );
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_UNINSTALLED);
    }).pipe(Effect.scoped);

    assert.isNull(yield* dev(backendUrl, (c) => c.GetShopSession({ shop: SEED_SHOP })));
    assert.deepStrictEqual(
      yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP })),
      { emails: [], teams: [] },
    );
    const afterUninstall = actorStorage(backendName);

    yield* integ(backendUrl, (c) => c.ScriptShopify({ replies: [] }));
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/orders", "orders/create", {
        id: 2,
        admin_graphql_api_id: "gid://shopify/Order/2",
        updated_at: new Date().toISOString(),
      }),
      200,
    );
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
    assert.deepStrictEqual(actorStorage(backendName), afterUninstall);

    const read = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: ORDER_ID }),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(read), "a read after uninstall is refused");
    assert.deepStrictEqual(actorStorage(backendName), afterUninstall);
  }),
);

/**
 * The orders sync Workflow's last step, replayed after the shop's uninstall: a step the destroy
 * aborted is retried, and its bulk file's URL still answers. The shop's object must not come
 * back holding the orders.
 */
test(
  "an orders stream after uninstall stores nothing",
  Effect.gen(function* () {
    const { backendUrl, backendName } = yield* stack;
    yield* storeByWebhook(
      backendUrl,
      OTHER_SHOP,
      {
        id: "gid://shopify/Order/10",
        legacyResourceId: "10",
        name: "#1010",
        processedAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        cancelledAt: null,
        displayFulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
      },
      [],
    );
    assert.strictEqual(
      yield* deliver(
        backendUrl,
        "/webhooks/app/uninstalled",
        "app/uninstalled",
        { id: 2, domain: OTHER_SHOP },
        OTHER_SHOP,
      ),
      200,
    );
    assert.isNull(yield* dev(backendUrl, (c) => c.GetShopSession({ shop: OTHER_SHOP })));
    const afterUninstall = actorStorage(backendName);

    const order = {
      __typename: "Order",
      id: "gid://shopify/Order/11",
      legacyResourceId: "11",
      name: "#1011",
      processedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      cancelledAt: null,
      displayFulfillmentStatus: "UNFULFILLED",
      fullyPaid: true,
      note: null,
    };
    yield* integ(backendUrl, (c) =>
      c.ScriptShopify({ replies: [{ route: "bulk", status: 200, body: JSON.stringify(order) }] }),
    );
    const stream = yield* integ(backendUrl, (c) =>
      c.OrdersStream({
        shop: OTHER_SHOP,
        workflowId: "after-uninstall",
        url: `${backendUrl}/api/integ/bulk/1`,
      }),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(stream), "the orders stream after uninstall is refused");
    assert.deepStrictEqual(
      actorStorage(backendName),
      afterUninstall,
      "the orders stream after uninstall left the object's storage untouched",
    );
  }),
);
