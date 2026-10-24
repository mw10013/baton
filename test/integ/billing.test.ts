import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import type { ShopKey } from "../../src/domain/platform.ts";
import {
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_REVOKED,
} from "../../src/contract/shop-actor.ts";
import { entitlementsOfPlan, provisionalCycleStart } from "../../src/domain/billing.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import { deliverWebhook } from "../shopify-webhook.ts";
import {
  addToFixture,
  connectAs,
  type Credential,
  dev,
  editingAt,
  email,
  integ,
  nextCloseCode,
  openAs,
  signIn,
  storeByWebhook,
} from "./actor-clients.ts";
import { fakePlanSelectionHref, type PartnerAnswer } from "./partner-fake.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * Billing against a real Backend, D1 and actor: the meter counts a run's order, the fixture leaves
 * it alone, the usage read is the merchant's; the plan's first-render reads; a revalidation
 * pushing the billing cycle, whose seat event and the counted orders reach App Events; the gate's
 * `402` for a merchant and a member of a lapsed shop, and every socket revoked on a lapse; the
 * uninstall's flush before the destroy. The Partner and App Events APIs are the test Backend's
 * fakes (`ScriptPartner`, `AppEventsSent`). The cases run in order and share `SEED_SHOP`'s plan:
 * a case that lapses it restores it.
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

/** The current UTC month as a billing cycle. */
const thisMonth = () => {
  const start = provisionalCycleStart(Date.now());
  const date = new Date(start);
  return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
};

const script = (shop: ShopKey, answer: PartnerAnswer) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* integ(backendUrl, (c) => c.ScriptPartner({ shop, answer }));
  });

const subscribedThisMonth = (handle: "baton-basic" | "baton-pro" = "baton-pro"): PartnerAnswer => {
  const { start, end } = thisMonth();
  return { _tag: "Subscribed", handle, cycleStartAt: start, boundaryAt: end };
};

const revalidate = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  return yield* integ(backendUrl, (c) => c.RevalidateStalePlans({}));
});

const sent = (refuse?: boolean) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* integ(backendUrl, (c) => c.AppEventsSent(refuse === undefined ? {} : { refuse }));
  });

test(
  "the home page's plan read answers the plan's included numbers, the usage and the member count",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* addToFixture(backendUrl, SEED_SHOP, { members: [email("plan-a@billing.test")] });
    const { emails } = yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
    const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
    const home = yield* integ(backendUrl, (c) => c.ApiHomePlan({ sessionToken }));
    assert.strictEqual(home._tag, "Subscribed");
    if (home._tag !== "Subscribed") return;
    assert.deepStrictEqual(home.entitlements, entitlementsOfPlan("pro"));
    assert.strictEqual(home.memberCount, emails.length);
    assert.strictEqual(home.usage.ordersThisCycle, 1);
    const usage = yield* integ(backendUrl, (c) => c.ApiUsage({ sessionToken }));
    assert.strictEqual(usage.ordersThisCycle, 1);
    assert.strictEqual(usage.ordersLimitedAt, null);
  }),
  { timeout: 60_000 },
);

test(
  "a revalidation pushes the billing cycle into the actor, whose seat event and queued order reach App Events",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { emails } = yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
    yield* sent();
    yield* script(SEED_SHOP, subscribedThisMonth());
    const summary = yield* revalidate;
    assert.isAtLeast(summary.shops, 1);
    assert.strictEqual(summary.failed, 0);
    const events = yield* sent();
    const { start, end } = thisMonth();
    const seat = events.find(
      (event) => event.idempotencyKey === `seat#${String(start)}#${String(emails.length)}`,
    );
    assert.strictEqual(seat?.value, emails.length);
    // The order the first case counted before the shop could be addressed, dated inside the cycle.
    assert.strictEqual(
      events.some((event) => event.idempotencyKey === "gid://shopify/Order/1#count"),
      true,
    );
    const usage = yield* usageOf(SEED_SHOP);
    assert.strictEqual(usage.cycleStartAt, start);
    assert.strictEqual(usage.cycleEndAt, end);
    assert.strictEqual(usage.pendingUsageEvents, 0);
  }),
  { timeout: 60_000 },
);

test(
  "an Attach on a shop with a billing cycle sends the order's usage event to App Events",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* storeByWebhook(backendUrl, SEED_SHOP, aNode(2), [aLineItemNode(2, ["untagged"])]);
    yield* Effect.gen(function* () {
      const { client } = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      const team = yield* client.MerchantCreateTeam({
        name: Schema.decodeUnknownSync(ShopWork.TeamName)("Attachers"),
      });
      const created = yield* client.MerchantCreateWorkflow(
        Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput)({ name: "Attach", tag: "attach" }),
      );
      if (created._tag !== "Ok") return yield* Effect.die(new Error(created._tag));
      const workflowId = created.workflow.id;
      yield* client.MerchantAddStep(
        Schema.decodeUnknownSync(ShopWork.AddStepInput)({
          ...(yield* editingAt(backendUrl, SEED_SHOP, workflowId)),
          name: "Do it",
          teamId: team.id,
        }),
      );
      yield* client.MerchantApplyDraft(yield* editingAt(backendUrl, SEED_SHOP, workflowId));
      yield* client.MerchantSetWorkflowState(
        Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput)({ workflowId, state: "active" }),
      );
      yield* sent();
      const attached = yield* client.MerchantAttachWorkflow(
        Schema.decodeUnknownSync(ShopWork.AttachWorkflowInput)({
          lineItemId: "gid://shopify/LineItem/2",
          workflowId,
        }),
      );
      assert.strictEqual(attached._tag, "Ok");
    }).pipe(Effect.scoped);
    const events = yield* sent();
    assert.deepStrictEqual(
      events.map(({ idempotencyKey, value }) => ({ idempotencyKey, value })),
      [{ idempotencyKey: "gid://shopify/Order/2#count", value: 1 }],
    );
  }),
  { timeout: 60_000 },
);

/** The first close code a socket through the gate meets, for `credential`. */
const gateClose = (shop: ShopKey, credential: Credential) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const socket = yield* connectAs(backendUrl, shop, credential);
    return yield* nextCloseCode(socket.closes);
  }).pipe(Effect.scoped);

test(
  "402s a member of a shop whose app subscription lapsed",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, email("m1@m.com"));
    yield* addToFixture(backendUrl, SEED_SHOP, { members: [email("m1@m.com")] }).pipe(
      Effect.ignore,
    );
    yield* script(SEED_SHOP, { _tag: "None" });
    assert.strictEqual(yield* gateClose(SEED_SHOP, { cookie }), CONNECTION_CLOSE_PAYMENT_REQUIRED);
    // The merchant's socket meets the same answer, and so does the home page's read.
    const token = yield* mintSessionToken({ shop: SEED_SHOP });
    assert.strictEqual(yield* gateClose(SEED_SHOP, { token }), CONNECTION_CLOSE_PAYMENT_REQUIRED);
    assert.deepStrictEqual(
      yield* integ(backendUrl, (c) => c.ApiHomePlan({ sessionToken: token })),
      { _tag: "Unsubscribed", href: fakePlanSelectionHref(SEED_SHOP) },
    );
    yield* script(SEED_SHOP, subscribedThisMonth());
  }),
  { timeout: 60_000 },
);

/**
 * Seats past the plan's included count are billed, not refused, so the gate
 * has nothing to say about them.
 */
test(
  "forwards a member past the plan's included seats",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script(SEED_SHOP, subscribedThisMonth("baton-basic"));
    const included = entitlementsOfPlan("basic").membersIncluded;
    const past = Array.from({ length: included + 1 }, (_, n) =>
      email(`seat-${String(n)}@billing.test`),
    );
    yield* addToFixture(backendUrl, SEED_SHOP, { members: past });
    const cookie = yield* signIn(backendUrl, past[included] ?? email("none@billing.test"));
    yield* Effect.gen(function* () {
      const socket = yield* connectAs(backendUrl, SEED_SHOP, { cookie });
      const me = yield* socket.client.MemberWhoAmI();
      assert.strictEqual(me.role, "member");
    }).pipe(Effect.scoped);
    yield* script(SEED_SHOP, subscribedThisMonth());
  }),
  { timeout: 60_000 },
);

test(
  "revokes every connection on the shop for a lapse",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, email("m1@m.com"));
    const token = yield* mintSessionToken({ shop: SEED_SHOP });
    yield* Effect.gen(function* () {
      const merchant = yield* connectAs(backendUrl, SEED_SHOP, { token });
      yield* merchant.client.MerchantWhoAmI();
      const member = yield* connectAs(backendUrl, SEED_SHOP, { cookie });
      yield* member.client.MemberWhoAmI();
      yield* script(SEED_SHOP, { _tag: "None" });
      yield* revalidate;
      assert.strictEqual(yield* nextCloseCode(merchant.closes), CONNECTION_CLOSE_REVOKED);
      assert.strictEqual(yield* nextCloseCode(member.closes), CONNECTION_CLOSE_REVOKED);
      // Each reconnect asks the gate again, which now answers the lapse.
      assert.strictEqual(yield* nextCloseCode(merchant.closes), CONNECTION_CLOSE_PAYMENT_REQUIRED);
      assert.strictEqual(yield* nextCloseCode(member.closes), CONNECTION_CLOSE_PAYMENT_REQUIRED);
    }).pipe(Effect.scoped);
    yield* script(SEED_SHOP, subscribedThisMonth());
  }),
  { timeout: 60_000 },
);

const listQuery = { state: "ready", team: null, limit: ShopWork.RUN_PAGE, q: null } as const;

/** The member loaders' first reads, for the member `cookie` names, on `SEED_SHOP`. */
const memberReads = (cookie: string) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return [
      yield* integ(backendUrl, (c) =>
        c.ApiWorkflowsList({ cookie, key: SEED_SHOP, ...listQuery }),
      ).pipe(
        Effect.as("ok"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      ),
      yield* integ(backendUrl, (c) =>
        c.ApiMemberWorkflowPage({ cookie, key: SEED_SHOP, runId: "none" }),
      ).pipe(
        Effect.as("ok"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      ),
    ];
  });

test(
  "requireMember admits every member of a subscribed shop",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script(SEED_SHOP, subscribedThisMonth("baton-basic"));
    const emails = Array.from(
      { length: entitlementsOfPlan("basic").membersIncluded + 1 },
      (_, index) => email(`admit-${String(index)}@billing.test`),
    );
    yield* addToFixture(backendUrl, SEED_SHOP, { members: emails });
    for (const address of emails)
      assert.deepStrictEqual(yield* memberReads(yield* signIn(backendUrl, address)), ["ok", "ok"]);
    yield* script(SEED_SHOP, subscribedThisMonth());
  }),
  { timeout: 120_000 },
);

/**
 * A member of a shop whose app subscription lapsed is refused `PaymentRequired`, which the member
 * loaders turn into the lapsed page, and only a member: a stranger still gets `NotAShopMember`,
 * because the gate checks membership before the plan, so a lapse is never disclosed to someone
 * who does not belong to the shop.
 */
test(
  "redirects a member of a lapsed shop to the lapsed page",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const member = email("lapsed@billing.test");
    yield* addToFixture(backendUrl, SEED_SHOP, { members: [member] });
    const stranger = email("stranger@billing.test");
    yield* addToFixture(backendUrl, OTHER_SHOP, { members: [stranger] });
    const cookie = yield* signIn(backendUrl, member);
    const strangerCookie = yield* signIn(backendUrl, stranger);
    yield* script(SEED_SHOP, { _tag: "None" });
    assert.deepStrictEqual(yield* memberReads(cookie), ["PaymentRequired", "PaymentRequired"]);
    assert.deepStrictEqual(yield* memberReads(strangerCookie), [
      "NotAShopMember",
      "NotAShopMember",
    ]);
    yield* script(SEED_SHOP, subscribedThisMonth());
  }),
  { timeout: 60_000 },
);

test(
  "uninstall sends the shop's queued usage events before it destroys the actor",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* load(OTHER_SHOP);
    yield* script(OTHER_SHOP, subscribedThisMonth());
    yield* revalidate;
    yield* sent(true);
    // Counted while App Events refuses: the order's event stays queued.
    yield* storeByWebhook(backendUrl, OTHER_SHOP, aNode(3), [aLineItemNode(3, ["board"])]);
    assert.strictEqual((yield* usageOf(OTHER_SHOP)).pendingUsageEvents, 1);
    yield* sent(false);
    const status = yield* deliverWebhook(
      `${backendUrl}/webhooks/app/uninstalled`,
      "app/uninstalled",
      OTHER_SHOP,
      { id: 2, domain: OTHER_SHOP },
    );
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      (yield* sent()).map(({ idempotencyKey }) => idempotencyKey),
      ["gid://shopify/Order/3#count"],
    );
  }),
  { timeout: 60_000 },
);
