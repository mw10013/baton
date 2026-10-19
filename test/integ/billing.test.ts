import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import type { ShopKey } from "../../src/contract/shop.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import { dev, email, integ, openAs, storeByWebhook } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * Billing against a real Backend and actor: the meter counts a run's order, the fixture leaves
 * it alone, and the usage read is the merchant's. The App Events API is the test Backend's
 * fake (`AppEventsSent` reads what it accepted).
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("billing"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const fixture = Schema.decodeUnknownSync(ShopFixtureData);

/** One team, `Bench`, and an active workflow on it matching `board`. */
const boardFixture = fixture({
  members: [],
  teams: [{ name: "Bench", members: [] }],
  workflows: [{ name: "Board", tag: "board", tasks: [{ name: "Cut", team: "Bench" }] }],
  orders: [],
});

const load = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) => c.LoadFixture({ shop, fixture: boardFixture }));
  });

const aNode = (n: number): OrderNode => ({
  id: `gid://shopify/Order/${String(n)}`,
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: Date.now() - 86_400_000 + n,
  updatedAt: Date.now(),
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
});

const aLineItemNode = (n: number, tags: ReadonlyArray<string>): LineItemNode => ({
  id: `gid://shopify/LineItem/${String(n)}`,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: [...tags] },
});

/** The shop's usage, as the merchant's socket reads it. */
const usageOf = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { client } = yield* openAs(backendUrl, shop, { role: "merchant" });
    return yield* client.MerchantGetUsage();
  }).pipe(Effect.scoped);

test(
  "reseeding leaves the usage counter unchanged",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* load(SEED_SHOP);
    // An order a sync stored, whose first run the fixture's workflow creates: counted once.
    yield* storeByWebhook(backendUrl, SEED_SHOP, aNode(1), [aLineItemNode(1, ["board"])]);
    const counted = yield* usageOf(SEED_SHOP);
    assert.strictEqual(counted.ordersThisCycle, 1);
    yield* load(SEED_SHOP);
    yield* load(SEED_SHOP);
    const after = yield* usageOf(SEED_SHOP);
    assert.strictEqual(after.ordersThisCycle, 1);
    assert.strictEqual(after.cycleStartAt, counted.cycleStartAt);
    assert.strictEqual(after.pendingUsageEvents, counted.pendingUsageEvents);
    // Nothing named the shop, so nothing was sent.
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.AppEventsSent({})), []);
  }),
  { timeout: 60_000 },
);

test(
  "MerchantGetUsage is refused to a member",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { client } = yield* openAs(backendUrl, SEED_SHOP, {
      role: "member",
      memberId: "m-usage",
      memberEmail: email("usage@billing.test"),
      teamIds: [],
      userId: "user-usage",
      sessionId: "session-usage",
      sessionExpiresAt: Date.now() + 600_000,
    });
    const refused = yield* client.MerchantGetUsage().pipe(Effect.flip);
    assert.strictEqual(refused._tag, "Forbidden");
  }).pipe(Effect.scoped),
  { timeout: 60_000 },
);
