import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { ListSearch, TeamId } from "../../src/domain/shop-work.ts";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import {
  addToFixture,
  dev,
  email,
  integ,
  openAs,
  signIn,
  storeByWebhook,
} from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import type { RowCounts } from "./rpcs.ts";
import Stack from "./stack.ts";

/**
 * The rows-read probe: Cloudflare's billed rows read and written, per query path, on a shop the
 * size of a busy one. Not a test: `vp run probe:rows-read` runs it, and only with
 * `ROWS_READ_PROBE` does the integ project include it. It writes each run to
 * `.logs/probe/rows-read/`, and `vp run probe:rows-read:report` prints the newest runs as one
 * table with their spread.
 *
 * Each path is bracketed by `TakeRowCounts`, so a path's rows are every statement the Backend
 * and the shop's actor ran for it, in D1 and the actor's SQLite. It proves the tallies count
 * against two statements whose rows are known: D1's `listShopsOf` seeks its email in the
 * `Member (email, shop)` index and steps its one entry plus the next, which ends the range, and
 * the actor's open-order count reads the one `ShopUsage` row.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("rowsread"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const TEAMS = [
  "Cutting",
  "Engraving",
  "Sanding",
  "Finishing",
  "Packing",
  "QA",
  "Printing",
  "Sewing",
] as const;
const MEMBERS = Array.from(
  { length: 50 },
  (_, i) => `worker${String(i + 1).padStart(2, "0")}@probe.test`,
);
/** Member `i` is on team `i % 8`, and every third member on a second team too. */
const teamsOfMember = (i: number) =>
  i % 3 === 0 ? [TEAMS[i % 8], TEAMS[(i + 3) % 8]] : [TEAMS[i % 8]];
const ACTIVE_WORKFLOWS = 6;
const OPEN_ORDERS = 2400;
const FULFILLED_ORDERS = 300;
const FIRST_ORDER = 1001;
const BULK_ORDERS = 50;
/** Every tenth order's third item carries the inactive workflow's tag, for the activation. */
const INACTIVE_TAG = "embroidered";

const fixture = Schema.decodeUnknownSync(ShopFixtureData)({
  members: MEMBERS,
  teams: TEAMS.map((name) => ({
    name,
    members: MEMBERS.filter((_, i) => teamsOfMember(i).includes(name)),
  })),
  workflows: [
    ...Array.from({ length: ACTIVE_WORKFLOWS }, (_, j) => ({
      name: `Line ${String(j + 1)}`,
      tag: `line-${String(j + 1)}`,
      tasks: [
        { name: "Prep", team: TEAMS[j % 8] },
        { name: "Make", team: TEAMS[(j + 1) % 8] },
        { name: "Finish", team: TEAMS[(j + 2) % 8], step: 2 },
        { name: "Pack", team: "Packing" },
      ],
    })),
    {
      name: "Embroider",
      state: "inactive",
      tag: INACTIVE_TAG,
      tasks: [
        { name: "Hoop", team: "Sewing" },
        { name: "Stitch", team: "Sewing" },
      ],
    },
  ],
  orders: Array.from({ length: OPEN_ORDERS + FULFILLED_ORDERS }, (_, i) => {
    const progress =
      i % 10 === 1
        ? { done: true, by: MEMBERS[i % 50] }
        : i % 10 === 2 || i % 10 === 3
          ? { advance: 1, started: true, by: MEMBERS[i % 50] }
          : i % 10 === 4
            ? { advance: 1, blocked: "Waiting on stock", by: MEMBERS[i % 50] }
            : i % 10 === 5
              ? { started: true }
              : {};
    return {
      n: FIRST_ORDER + i,
      placedDaysAgo: i % 60,
      ...(i % 9 === 0 ? { fulfillmentStatus: "FULFILLED" } : {}),
      ...progress,
      lineItems: [
        {
          title: "Walnut cutting board",
          variantTitle: "Large",
          sku: `WCB-${String(i % 40)}`,
          quantity: 1,
          tags: [`line-${String((i % ACTIVE_WORKFLOWS) + 1)}`],
        },
        {
          title: "Maple coaster set",
          sku: `MCS-${String(i % 25)}`,
          quantity: 2,
          tags: [`line-${String(((i + 1) % ACTIVE_WORKFLOWS) + 1)}`],
        },
        {
          title: "Linen tea towel",
          quantity: 1,
          tags: i % 10 === 0 ? [INACTIVE_TAG] : [],
        },
      ],
    };
  }),
});

/** Forty members of another shop, so D1 holds more than the probed shop's identity. */
const otherShop = {
  members: Array.from({ length: 40 }, (_, i) =>
    email(`other${String(i + 1).padStart(2, "0")}@probe.test`),
  ),
};

/** One measured path: its rows in each database. */
interface Measurement {
  readonly path: string;
  readonly actor: RowCounts;
  readonly d1: RowCounts;
}

const take = (backendUrl: string) => integ(backendUrl, (c) => c.TakeRowCounts({}));

const measurements: Array<Measurement> = [];

/** `effect`'s rows, recorded as `path`; the tallies are taken first so only its rows count. */
const measure = <A, E, R>(backendUrl: string, path: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* take(backendUrl);
    const value = yield* effect;
    const { actor, d1 } = yield* take(backendUrl);
    assert.strictEqual(actor.unmetered + d1.unmetered, 0, `${path}: every statement metered`);
    measurements.push({ path, actor, d1 });
    return value;
  });

const orderNode = (n: number): OrderNode => ({
  id: `gid://shopify/Order/${String(n)}`,
  legacyResourceId: String(n),
  name: `#${String(n)}`,
  processedAt: Date.now() - 3_600_000,
  updatedAt: Date.now() - 60_000,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
});

const lineItemNodes = (n: number): ReadonlyArray<LineItemNode> =>
  [1, 2, 3].map((k) => ({
    id: `gid://shopify/LineItem/${String(n * 10 + k)}`,
    title: k === 1 ? "Walnut cutting board" : k === 2 ? "Maple coaster set" : "Linen tea towel",
    variantTitle: null,
    sku: null,
    quantity: 1,
    currentQuantity: 1,
    customAttributes: [],
    product: { tags: k === 3 ? [] : [`line-${String(((n + k) % ACTIVE_WORKFLOWS) + 1)}`] },
  }));

/** Order `n` as `BulkOrdersQuery` flattens it: the order line, then its items' lines. */
const bulkLines = (n: number) => {
  const node = orderNode(n);
  return [
    JSON.stringify({
      __typename: "Order",
      ...node,
      processedAt: new Date(node.processedAt).toISOString(),
      updatedAt: new Date(node.updatedAt).toISOString(),
    }),
    ...lineItemNodes(n).map((item) =>
      JSON.stringify({ __typename: "LineItem", ...item, __parentId: node.id }),
    ),
  ];
};

const search = Schema.decodeUnknownSync(ListSearch);
const MAKING = { limit: 25, q: null, show: null, team: null } as const;

/** Writes the run where `vp run probe:rows-read:report` reads it. */
const record = () => {
  mkdirSync(".logs/probe/rows-read", { recursive: true });
  const file = `.logs/probe/rows-read/${new Date().toISOString().replaceAll(":", "-")}.json`;
  writeFileSync(file, JSON.stringify(measurements, null, 2));
};

test(
  "rows read per query path",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) => c.LoadFixture({ shop: SEED_SHOP, fixture }));
    yield* addToFixture(backendUrl, OTHER_SHOP, otherShop);
    // Sessions and verifications for the sweep to scan: twenty sign-ins, ten links never used.
    for (const address of MEMBERS.slice(0, 20)) yield* signIn(backendUrl, email(address));
    for (const address of MEMBERS.slice(20, 30))
      yield* integ(backendUrl, (c) => c.IssueMagicLink({ email: email(address) }));

    // The tallies count: the email is in one shop, so the seek steps two index entries.
    yield* measure(
      backendUrl,
      "calibration: D1 listShopsOf (index seek, one shop)",
      integ(backendUrl, (c) => c.ListShopsOf({ email: email(MEMBERS[0] ?? "") })),
    );
    const calibration = measurements.at(-1);
    assert.strictEqual(calibration?.d1.rowsRead, 2, "D1 reads the email's entry and the next");

    const first = yield* measure(
      backendUrl,
      "1a listOrders Making, first page (cold)",
      integ(backendUrl, (c) => c.ListOrders({ shop: SEED_SHOP, cursor: null, ...MAKING })),
    );
    assert.strictEqual(first.page.orders.length, 25, "a full first page");
    yield* measure(
      backendUrl,
      "1b listOrders Making, second page (cursor)",
      integ(backendUrl, (c) =>
        c.ListOrders({ shop: SEED_SHOP, cursor: first.page.nextCursor, ...MAKING }),
      ),
    );
    yield* measure(
      backendUrl,
      "1c listOrders Making, first page again (memo)",
      integ(backendUrl, (c) => c.ListOrders({ shop: SEED_SHOP, cursor: null, ...MAKING })),
    );
    const newOrder = FIRST_ORDER + OPEN_ORDERS + FULFILLED_ORDERS;
    yield* measure(
      backendUrl,
      "2a webhook orders/create, one new order (3 items)",
      storeByWebhook(backendUrl, SEED_SHOP, orderNode(newOrder), lineItemNodes(newOrder)),
    );
    // The actor's tallies count: the order ceiling reads the one `ShopUsage` row per check.
    const openCount = measurements
      .at(-1)
      ?.actor.statements.find(({ sql }) => sql.startsWith("select openOrders from ShopUsage"));
    assert.isAbove(openCount?.runs ?? 0, 0, "the webhook checks the order ceiling");
    assert.strictEqual(
      openCount?.rowsRead,
      openCount?.runs,
      "the actor reads one row per open-order count",
    );
    yield* measure(
      backendUrl,
      "2c webhook orders/updated, the new order fulfilled",
      storeByWebhook(
        backendUrl,
        SEED_SHOP,
        { ...orderNode(newOrder), displayFulfillmentStatus: "FULFILLED", updatedAt: Date.now() },
        lineItemNodes(newOrder),
      ),
    );
    yield* measure(
      backendUrl,
      "1d listOrders Making, first page after the webhook's notice",
      integ(backendUrl, (c) => c.ListOrders({ shop: SEED_SHOP, cursor: null, ...MAKING })),
    );

    const bulk = Array.from({ length: BULK_ORDERS }, (_, i) => newOrder + 1 + i);
    yield* integ(backendUrl, (c) =>
      c.ScriptShopify({
        replies: [{ route: "bulk", status: 200, body: bulk.flatMap(bulkLines).join("\n") }],
      }),
    );
    yield* measure(
      backendUrl,
      `2b bulk sync, ${String(BULK_ORDERS)} new orders (onOrdersStream)`,
      integ(backendUrl, (c) =>
        c.OrdersStream({
          shop: SEED_SHOP,
          workflowId: "probe-sync",
          url: `${backendUrl}/api/integ/bulk/1`,
        }),
      ),
    );
    const lastBulk = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: orderNode(bulk.at(-1) ?? 0).id }),
    );
    assert.isNotNull(lastBulk, "the bulk sync stored its orders");

    const detail = yield* measure(
      backendUrl,
      "3 getOrderDetail by legacy id",
      integ(backendUrl, (c) => c.GetOrderDetail({ shop: SEED_SHOP, legacyId: "fixture-2500" })),
    );
    assert.isNotNull(detail, "the order is stored");

    const usage = yield* measure(
      backendUrl,
      "4 getUsage",
      integ(backendUrl, (c) => c.GetUsage({ shop: SEED_SHOP })),
    );
    const open = yield* integ(backendUrl, (c) =>
      c.ListOrders({ shop: SEED_SHOP, cursor: null, ...MAKING }),
    );
    assert.strictEqual(
      usage.openOrders,
      OPEN_ORDERS + BULK_ORDERS,
      "the open-order count after one order created and fulfilled and a bulk sync",
    );
    assert.strictEqual(usage.openOrders, open.page.openOrders, "usage agrees with the orders page");

    const teamIds = first.teams
      .filter((team) => teamsOfMember(0).includes(team.name as (typeof TEAMS)[number]))
      .map((team) => Schema.decodeUnknownSync(TeamId)(team.id));
    // The member's open runs are memoized per team set, so only the first read is cold; the
    // Done counts and rows (`listRecent`) are read on every call.
    const listRunsCases = [
      ["started_by_you", "5a listRuns, one member, started_by_you (cold)"],
      ["ready", "5b listRuns, one member, ready (open runs memoized)"],
      ["done", "5c listRuns, one member, done (open runs memoized)"],
    ] as const;
    for (const [state, path] of listRunsCases) {
      const runs = yield* measure(
        backendUrl,
        path,
        integ(backendUrl, (c) =>
          c.ListRuns({
            shop: SEED_SHOP,
            teamIds,
            memberEmail: email(MEMBERS[0] ?? ""),
            query: { team: null, state, limit: 25, q: null },
          }),
        ),
      );
      assert.isAbove(runs.counts[state], 0, `${path}: the member has runs`);
    }

    const byNumber = yield* measure(
      backendUrl,
      "7a listOrders search, order number",
      integ(backendUrl, (c) =>
        c.ListOrders({ shop: SEED_SHOP, ...MAKING, cursor: null, q: search("#2500") }),
      ),
    );
    assert.strictEqual(byNumber.page.orders.length, 1, "the order number finds its order");
    yield* measure(
      backendUrl,
      "7b listOrders search, item text",
      integ(backendUrl, (c) =>
        c.ListOrders({ shop: SEED_SHOP, ...MAKING, cursor: null, q: search("coaster") }),
      ),
    );

    const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
    const workflows = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsPage({ sessionToken, state: null, q: null, after: null }),
    );
    const embroider = workflows.workflows.find((workflow) => workflow.tag === INACTIVE_TAG);
    assert.isDefined(embroider, "the inactive workflow is listed");
    yield* Effect.gen(function* () {
      const { client } = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* client.MerchantListOrders({ cursor: null, ...MAKING });
      yield* measure(
        backendUrl,
        "6 reconcileAll, activating one workflow",
        client.MerchantSetWorkflowState({ workflowId: embroider?.id ?? "", state: "active" }),
      );
    }).pipe(Effect.scoped);

    yield* measure(
      backendUrl,
      "8a D1 listShopsOf, one email",
      integ(backendUrl, (c) => c.ListShopsOf({ email: email(MEMBERS[0] ?? "") })),
    );
    yield* measure(
      backendUrl,
      "8b D1 sweepExpiredAuth",
      integ(backendUrl, (c) => c.SweepExpiredAuth({})),
    );
    record();
  }),
  900_000,
);
