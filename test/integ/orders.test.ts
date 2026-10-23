import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { MemberRpcs, ORDERS_KEY, ShopActorRpcs } from "../../src/contract/shop-actor.ts";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopLimits, ShopKey } from "../../src/domain/platform.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import { Email } from "../../src/contract/auth.ts";
import {
  dev,
  integ,
  openAs,
  orderSyncAnswer,
  scriptGraphql,
  storeByWebhook,
  syncOrderAs,
} from "./actor-clients.ts";
import { deliverWebhook } from "../shopify-webhook.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The shop actor's orders against a real Backend and actor: orders arrive as production gets
 * them, by signed `orders/*` webhook with the order scripted into the fake Shopify, which the
 * actor fetches itself; the merchant's `MerchantListOrders`, `MerchantSyncOrder` and their
 * notices; the stub reads `getOrder` and `listOrders`; and the retention sweep the actor runs
 * after a fetch when due. The repository's own rules are unit tests over the same schema.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("orders"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** A shop `seed/test.sql` gives no `ShopSession`. */
const UNINSTALLED_SHOP = Schema.decodeUnknownSync(ShopKey)("uninstalled-shop.myshopify.com");

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;

/** The orders index's input keys for every stored order: no search, Show all, any team. */
const EVERY_ORDER = { q: null, show: "all", team: null } as const;
const lineItemId = (n: number) => `gid://shopify/LineItem/${String(n)}`;

/** An order as Shopify answers it, at `updatedAt`; a recent `processedAt`, so retention keeps it. */
const aNode = (n: number, updatedAt: number, overrides: Partial<OrderNode> = {}): OrderNode => ({
  id: orderId(n),
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: Date.now() - 86_400_000 + n,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  ...overrides,
});

const aLineItemNode = (n: number, overrides: Partial<LineItemNode> = {}): LineItemNode => ({
  id: lineItemId(n),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: ["engraved"] },
  ...overrides,
});

/** Empties `shop`'s orders (and its members and teams): a load of an empty fixture. */
const reset = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({ shop, fixture: { members: [], teams: [], workflows: [], orders: [] } }),
    );
  });

/** Arranges `order` with `lineItems` in `shop`'s actor by webhook ({@link storeByWebhook}). */
const store = (shop: ShopKey, order: OrderNode, lineItems: ReadonlyArray<LineItemNode>) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* storeByWebhook(backendUrl, shop, order, lineItems);
  });

/**
 * Sync from Shopify on `order`'s id with the fake answering `order` and `lineItems`: the
 * one-order fetch with no version probe, so the upsert's own guard decides.
 */
const syncAnswering = (shop: ShopKey, order: OrderNode, lineItems: ReadonlyArray<LineItemNode>) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, [orderSyncAnswer(order, lineItems)]);
    return yield* syncOrderAs(backendUrl, shop, order.id);
  });

const read = (shop: ShopKey, id: string) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* integ(backendUrl, (c) => c.GetOrder({ shop, orderId: id }));
  });

/**
 * A signed order webhook for `id` at `updatedAt` (null: an edit, no version), the fake answering
 * `answer` if the actor fetches; the GraphQL calls the delivery made.
 */
const webhook = (shop: ShopKey, id: string, updatedAt: number | null, answer: unknown) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, [answer]);
    const status = yield* deliverWebhook(`${backendUrl}/webhooks/orders`, "orders/paid", shop, {
      id: 0,
      admin_graphql_api_id: id,
      updated_at: updatedAt === null ? null : new Date(updatedAt).toISOString(),
    });
    assert.strictEqual(status, 200);
    return (yield* integ(backendUrl, (c) => c.ShopifyCalls({}))).filter(
      ({ route }) => route === "graphql",
    ).length;
  });

test(
  "a webhook stores the order Shopify answered, and getOrder reads it back with its items",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(1, 2000, { note: "Rush" }), [
      aLineItemNode(1, { customAttributes: [{ key: "text", value: "Hello" }] }),
      aLineItemNode(2, { product: null }),
    ]);
    const detail = yield* read(SEED_SHOP, orderId(1));
    assert.isNotNull(detail);
    if (detail === null) return;
    assert.strictEqual(detail.order.name, "#1001");
    assert.strictEqual(detail.order.note, "Rush");
    assert.strictEqual(detail.order.fullyPaid, true);
    assert.isAbove(detail.order.syncedAt, 0);
    assert.deepStrictEqual(
      detail.lineItems.map(({ id, productTags, properties }) => ({ id, productTags, properties })),
      [
        {
          id: lineItemId(1),
          productTags: ["engraved"],
          properties: [{ key: "text", value: "Hello" }],
        },
        { id: lineItemId(2), productTags: [], properties: [] },
      ],
    );
    assert.isNull(yield* read(SEED_SHOP, orderId(99)));
  }),
);

test(
  "a multi-statement write completes under the actor's transaction",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const items = Array.from({ length: 40 }, (_, i) => aLineItemNode(100 + i));
    yield* store(SEED_SHOP, aNode(2, 2000), items).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual((yield* read(SEED_SHOP, orderId(2)))?.lineItems.length, 40);
  }),
);

/** Sync from Shopify has no version probe, so each copy reaches the upsert's own guard. */
test(
  "the upsert's version guard on Sync from Shopify: an older copy is skipped, the same version rewritten, a newer one replaces the items",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(3, 2000), [aLineItemNode(1)]);
    const stored = { _tag: "Stored" } as const;
    assert.deepStrictEqual(
      yield* syncAnswering(SEED_SHOP, aNode(3, 1000, { name: "#STALE" }), [aLineItemNode(9)]),
      stored,
    );
    assert.strictEqual((yield* read(SEED_SHOP, orderId(3)))?.order.name, "#1003");

    assert.deepStrictEqual(
      yield* syncAnswering(SEED_SHOP, aNode(3, 2000, { note: "same version" }), [aLineItemNode(1)]),
      stored,
    );
    assert.strictEqual((yield* read(SEED_SHOP, orderId(3)))?.order.note, "same version");

    assert.deepStrictEqual(
      yield* syncAnswering(SEED_SHOP, aNode(3, 3000), [aLineItemNode(2), aLineItemNode(3)]),
      stored,
    );
    assert.deepStrictEqual(
      (yield* read(SEED_SHOP, orderId(3)))?.lineItems.map(({ id }) => id),
      [lineItemId(2), lineItemId(3)],
    );
  }),
);

test(
  "a webhook skips a version not newer than the row, and fetches a newer one, an edit and a new order",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(4, 2000), []);
    const gone = { data: { order: null } };
    assert.strictEqual(yield* webhook(SEED_SHOP, orderId(4), 1999, gone), 0);
    assert.strictEqual(yield* webhook(SEED_SHOP, orderId(4), 2000, gone), 0);
    assert.strictEqual(yield* webhook(SEED_SHOP, orderId(4), 2001, gone), 1);
    assert.strictEqual(yield* webhook(SEED_SHOP, orderId(4), null, gone), 1);
    assert.strictEqual(yield* webhook(SEED_SHOP, orderId(5), 1, gone), 1);
  }),
);

test(
  "an item's properties past 8 KB are not stored and the order syncs",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const kept = { key: "text", value: "Hello" };
    yield* store(SEED_SHOP, aNode(6, 2000), [
      aLineItemNode(1, {
        customAttributes: [
          kept,
          { key: "proof", value: "x".repeat(ShopLimits.maxPropertiesBytesPerItem) },
          { key: "after", value: "small" },
        ],
      }),
    ]);
    const detail = yield* read(SEED_SHOP, orderId(6));
    assert.strictEqual(detail?.lineItems.length, 1);
    assert.deepStrictEqual(detail?.lineItems[0]?.properties, [kept]);
  }),
);

/**
 * The ceiling is reached with real rows: `LoadFixture` stores {@link ShopLimits.maxOpenOrders}
 * open orders, so no limit is lowered for the test. "Before the fetch" is a webhook for a new
 * order, which asks Shopify nothing; "by the write" is Sync from Shopify on a new order, which
 * has no probe, so the upsert refuses it (and still answers `Stored`).
 */
test(
  "at the order ceiling a new order is refused before the fetch and by the write, and a stored one still updates",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({
        shop: OTHER_SHOP,
        fixture: {
          members: [],
          teams: [],
          workflows: [],
          orders: Array.from({ length: ShopLimits.maxOpenOrders }, (_, i) => ({
            n: i + 1,
            lineItems: [],
          })),
        },
      }),
    );
    const newOrder = aNode(7, 2000);
    assert.strictEqual(yield* webhook(OTHER_SHOP, orderId(7), 1, orderSyncAnswer(newOrder, [])), 0);
    assert.deepStrictEqual(yield* syncAnswering(OTHER_SHOP, newOrder, []), { _tag: "Stored" });
    assert.isNull(yield* read(OTHER_SHOP, orderId(7)));

    const fixtureOrder = "gid://shopify/Order/fixture-1";
    const fulfilled = aNode(1, Date.now() + 60_000, {
      id: fixtureOrder,
      displayFulfillmentStatus: "FULFILLED",
    });
    assert.strictEqual(
      yield* webhook(OTHER_SHOP, fixtureOrder, fulfilled.updatedAt, orderSyncAnswer(fulfilled, [])),
      1,
    );
    assert.strictEqual(
      (yield* read(OTHER_SHOP, fixtureOrder))?.order.fulfillmentStatus,
      "FULFILLED",
    );
    // Fulfilling one made room for one.
    assert.strictEqual(yield* webhook(OTHER_SHOP, orderId(7), 1, orderSyncAnswer(newOrder, [])), 1);
    assert.isNotNull(yield* read(OTHER_SHOP, orderId(7)));
  }),
  { timeout: 60_000 },
);

test(
  "a merchant socket is told ORDERS_KEY when an order changes, and nothing on a same-version rewrite",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      yield* syncAnswering(SEED_SHOP, aNode(8, 2000), [aLineItemNode(1)]);
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });

      yield* syncAnswering(SEED_SHOP, aNode(8, 2000), [aLineItemNode(1)]);
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
    }).pipe(Effect.scoped);
  }),
);

test(
  "the dev door's RemoveOrder deletes a stored order with its items and publishes, once",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(9, 2000), [aLineItemNode(1), aLineItemNode(2)]);
    yield* store(SEED_SHOP, aNode(10, 2000), [aLineItemNode(3)]);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      const removed = yield* dev(backendUrl, (c) =>
        c.RemoveOrder({ shop: SEED_SHOP, orderId: orderId(9) }),
      );
      assert.deepStrictEqual(removed, { removed: true });
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });
      assert.isNull(yield* read(SEED_SHOP, orderId(9)));
      assert.isNotNull(yield* read(SEED_SHOP, orderId(10)));
      const { page } = yield* merchant.client.MerchantListOrders({
        limit: 25,
        cursor: null,
        ...EVERY_ORDER,
      });
      assert.deepStrictEqual(
        page.orders.map(({ order }) => order.id),
        [orderId(10)],
      );

      const again = yield* dev(backendUrl, (c) =>
        c.RemoveOrder({ shop: SEED_SHOP, orderId: orderId(9) }),
      );
      assert.deepStrictEqual(again, { removed: false });
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantListOrders and listOrders page newest first through a keyset cursor",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    // Two orders in one millisecond: the id breaks the tie, newest id first.
    const at = Date.now() - 86_400_000;
    yield* store(SEED_SHOP, aNode(11, 1, { processedAt: at }), [aLineItemNode(11)]);
    yield* store(SEED_SHOP, aNode(12, 1, { processedAt: at + 10 }), []);
    yield* store(SEED_SHOP, aNode(13, 1, { processedAt: at + 10 }), []);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      const { page: first } = yield* merchant.client.MerchantListOrders({
        limit: 2,
        cursor: null,
        ...EVERY_ORDER,
      });
      assert.deepStrictEqual(
        first.orders.map(({ order }) => order.id),
        [orderId(13), orderId(12)],
      );
      assert.strictEqual(first.nextCursor, `${String(at + 10)}:${orderId(12)}`);
      const { page: second } = yield* integ(backendUrl, (c) =>
        c.ListOrders({ shop: SEED_SHOP, limit: 2, cursor: first.nextCursor, ...EVERY_ORDER }),
      );
      assert.deepStrictEqual(
        second.orders.map(({ order, itemUnits }) => [order.id, itemUnits]),
        [[orderId(11), 1]],
      );
      assert.strictEqual(second.nextCursor, null);
    }).pipe(Effect.scoped);
  }),
);

const DAY = 86_400_000;

/** Order `n` as Shopify's `OrderSync` answers it, with one line item. */
const orderSyncBody = (n: number, updatedAt: number) =>
  orderSyncAnswer(aNode(n, updatedAt), [aLineItemNode(n)]);

/** The fake's next GraphQL answers, with its call log cleared. */
const script = (bodies: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, bodies);
  });

/** Sync from Shopify on `id`: `MerchantSyncOrder` on a merchant socket to `shop`. */
const syncOrder = (shop: ShopKey, id: string) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* syncOrderAs(backendUrl, shop, id);
  });

/** `LoadFixture` with only `orders`, as order numbers with no items; `ShopUsage` starts over. */
const loadOrders = (shop: ShopKey, numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({
        shop,
        fixture: {
          members: [],
          teams: [],
          workflows: [],
          orders: numbers.map((n) => ({ n, lineItems: [] })),
        },
      }),
    );
  });

const fixtureOrderId = (n: number) => `gid://shopify/Order/fixture-${String(n)}`;

/**
 * Rewrites fixture order `n` at its own version with a `processedAt` past retention, by Sync from
 * Shopify with the fake answering that copy: an order already stored keeps taking writes however
 * old it is (the retention rule refuses only a new one), and the same version changes nothing a
 * screen shows. The only way an expired row reaches a real actor, since no fixture order is older
 * than a year; a webhook at the same version would be stale and fetch nothing.
 */
const age = (shop: ShopKey, n: number) =>
  Effect.gen(function* () {
    const stored = yield* read(shop, fixtureOrderId(n));
    assert.isNotNull(stored);
    return yield* syncAnswering(
      shop,
      aNode(n, stored?.order.updatedAt ?? 0, {
        id: fixtureOrderId(n),
        processedAt: Date.now() - (ShopLimits.orderRetentionDays + 1) * DAY,
      }),
      [],
    );
  });

const listedIds = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { page } = yield* integ(backendUrl, (c) =>
      c.ListOrders({ shop, limit: 50, cursor: null, ...EVERY_ORDER }),
    );
    return page.orders.map(({ order }) => order.id).toSorted();
  });

test(
  "the one-order sync answers Gone for an order Shopify no longer has and leaves the stored row",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* script([orderSyncBody(21, 2000), { data: { order: null } }]);
    assert.deepStrictEqual(yield* syncOrder(SEED_SHOP, orderId(21)), { _tag: "Stored" });
    const before = yield* read(SEED_SHOP, orderId(21));
    assert.strictEqual(before?.lineItems.length, 1);
    assert.deepStrictEqual(yield* syncOrder(SEED_SHOP, orderId(21)), { _tag: "Gone" });
    assert.deepStrictEqual(yield* read(SEED_SHOP, orderId(21)), before);
  }),
);

test(
  "Sync this order publishes when it changed something, and nothing when it did not",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* script([orderSyncBody(22, 2000), orderSyncBody(22, 2000)]);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      yield* syncOrder(SEED_SHOP, orderId(22));
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });
      // The same version again: no row moves, so no notice.
      yield* syncOrder(SEED_SHOP, orderId(22));
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
    }).pipe(Effect.scoped);
  }),
);

/**
 * The gate refuses a socket to a shop with no `ShopSession`, so this is the row deleted while a
 * socket stays open: the forged-caller route opens one anyway.
 */
test(
  "Sync from Shopify on a shop whose ShopSession is gone is OfflineSessionMissing and asks Shopify nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script([]);
    const error = yield* Effect.flip(syncOrder(UNINSTALLED_SHOP, orderId(23)));
    assert.strictEqual(error._tag, "OfflineSessionMissing");
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
  }),
);

/**
 * {@link age} writes the expired row through the actor's one-order fetch, not behind the actor's
 * back, on a fresh `ShopUsage` (`lastSweepAt` null), so that very write's sweep deletes it.
 */
test(
  "a webhook whose sweep deletes an order publishes and the orders index stops showing it",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* loadOrders(SEED_SHOP, [1, 2]);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      assert.deepStrictEqual(yield* age(SEED_SHOP, 2), { _tag: "Stored" });
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });
    }).pipe(Effect.scoped);
    assert.isNull(yield* read(SEED_SHOP, fixtureOrderId(2)));
    assert.deepStrictEqual(yield* listedIds(SEED_SHOP), [fixtureOrderId(1)]);
  }),
);

/**
 * The first write sweeps (nothing) and records `lastSweepAt`; the second, inside
 * `ShopLimits.sweepIntervalMs`, leaves an expired row standing.
 */
test(
  "a write inside the sweep interval sweeps nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* loadOrders(SEED_SHOP, [1]);
    yield* store(SEED_SHOP, aNode(24, 2000), []);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      assert.deepStrictEqual(yield* age(SEED_SHOP, 1), { _tag: "Stored" });
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
    }).pipe(Effect.scoped);
    const aged = yield* read(SEED_SHOP, fixtureOrderId(1));
    assert.isBelow(
      aged?.order.processedAt ?? Infinity,
      Date.now() - ShopLimits.orderRetentionDays * DAY,
    );
    assert.deepStrictEqual(
      yield* listedIds(SEED_SHOP),
      [fixtureOrderId(1), orderId(24)].toSorted(),
    );
  }),
);

test(
  "the orders screen's BackendApi methods refuse a bad token and answer for a good one",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(21, 1), [aLineItemNode(21)]);
    const bad = yield* mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });
    const good = yield* mintSessionToken({ shop: SEED_SHOP });
    const uninstalled = yield* mintSessionToken({ shop: UNINSTALLED_SHOP });
    yield* script([]);
    yield* integ(backendUrl, (c) =>
      Effect.gen(function* () {
        const refusal = yield* c
          .ApiListOrders({ sessionToken: bad, limit: 25, cursor: null, ...EVERY_ORDER })
          .pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "InvalidSessionToken");
        const { page } = yield* c.ApiListOrders({
          sessionToken: good,
          limit: 25,
          cursor: null,
          ...EVERY_ORDER,
        });
        assert.deepStrictEqual(
          page.orders.map(({ order, itemUnits }) => [order.id, itemUnits]),
          [[orderId(21), 1]],
        );
        const notInstalled = yield* c
          .ApiListOrders({ sessionToken: uninstalled, limit: 25, cursor: null, ...EVERY_ORDER })
          .pipe(Effect.flip);
        assert.strictEqual(notInstalled._tag, "ShopNotInstalled");
      }),
    );
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
  }),
);

test(
  "a member socket is refused MerchantListOrders",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const member = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-orders",
        memberEmail: Schema.decodeUnknownSync(Email)("orders@m.com"),
        teamIds: [],
        userId: "user-orders",
        sessionId: "session-orders",
        sessionExpiresAt: Date.now() + 600_000,
      });
      const error = yield* member.client
        .MerchantListOrders({ limit: 25, cursor: null, ...EVERY_ORDER })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member socket is refused MerchantSyncOrder",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script([]);
    yield* Effect.gen(function* () {
      const member = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-orders-one",
        memberEmail: Schema.decodeUnknownSync(Email)("orders-one@m.com"),
        teamIds: [],
        userId: "user-orders-one",
        sessionId: "session-orders-one",
        sessionExpiresAt: Date.now() + 600_000,
      });
      const error = yield* member.client
        .MerchantSyncOrder({ orderId: orderId(32) })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
  }),
);

/**
 * `onOrdersStream`, `onOrdersSyncEmpty` and `onOrdersSyncError` are stub methods, which only the
 * Backend's Workflow holds, so no browser procedure carries them. The two sync buttons are the
 * merchant procedures `MerchantSyncOpenOrders` and `MerchantSyncOrder`, which a member's socket
 * is `Forbidden`, as it is the sync's status, and no Shopify call is made.
 */
test(
  "the stream's callbacks are no socket procedure, and the two sync buttons refuse a member",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const procedures = [...ShopActorRpcs.requests.keys()];
    for (const name of ["OnOrdersStream", "OnOrdersSyncEmpty", "OnOrdersSyncError", "Webhook"])
      assert.deepStrictEqual(
        procedures.filter((tag) => tag.endsWith(name)),
        [],
        `${name} is not a socket procedure`,
      );
    assert.deepStrictEqual(
      [...MemberRpcs.requests.keys()].filter((tag) => tag.includes("Sync")),
      [],
    );
    const sessionId = "session-orders-sync";
    yield* Effect.gen(function* () {
      const member = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-orders-sync",
        memberEmail: Schema.decodeUnknownSync(Email)("orders-sync@m.com"),
        teamIds: [],
        userId: "user-orders-sync",
        sessionId,
        sessionExpiresAt: Date.now() + 600_000,
      });
      const errors = [
        yield* member.client.MerchantSyncStatus().pipe(Effect.flip),
        yield* member.client.MerchantSyncOpenOrders().pipe(Effect.flip),
        yield* member.client.MerchantSyncOrder({ orderId: orderId(31) }).pipe(Effect.flip),
      ];
      assert.deepStrictEqual(
        errors.map((error) => error._tag),
        ["Forbidden", "Forbidden", "Forbidden"],
      );
    }).pipe(Effect.scoped);
    yield* script([]);
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
  }),
);
