import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../../src/contract/auth.ts";
import { FIXTURE_ORDER_PREFIX, ShopFixtureData } from "../../../src/contract/fixture.ts";
import { ShopKey } from "../../../src/contract/shop.ts";
import { type ActorFixtureRows, Fixtures, fixtureRows } from "../../../src/backend/fixture.ts";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { type MemberRow, testMembershipRepository } from "./layers.ts";

const shopKey = Schema.decodeUnknownSync(ShopKey);
const email = Schema.decodeUnknownSync(EmailFromInput);
const shop = shopKey("fixture-shop.myshopify.com");
const otherShop = shopKey("other-shop.myshopify.com");

const session: ShopSessionRow = {
  shop,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: shop,
  scope: null,
  accessTokenExpiresAt: null,
  accessToken: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

const data = Schema.decodeUnknownSync(ShopFixtureData)({
  members: ["ana@example.com", "ben@example.com"],
  teams: [
    { name: "Engraving", members: ["ana@example.com"] },
    { name: "Nobody", members: [] },
  ],
  workflows: [
    {
      name: "Clock",
      tag: "wall-clock",
      tasks: [
        { name: "Cut face", team: "Engraving", step: 1 },
        { name: "Engrave numerals", team: "Engraving", step: 1 },
        { name: "Assemble", team: "Engraving" },
      ],
      draft: { tasks: [{ name: "Assemble", team: null }] },
    },
    { name: "Unassigned", tag: "unassigned", tasks: [{ name: "Do it", team: null }] },
    { name: "Empty", tag: "empty", tasks: [] },
    { name: "Off", state: "inactive", tag: "off", tasks: [{ name: "Do it", team: "Engraving" }] },
  ],
  orders: [
    {
      n: 1201,
      placedDaysAgo: 2,
      after: { fulfillmentStatus: "FULFILLED" },
      lineItems: [{ title: "Board", quantity: 1, tags: ["board"], progress: { done: true } }],
    },
    {
      n: 1202,
      unpaid: true,
      note: "Gift",
      after: { cancelled: true, lineItems: [{ position: 2, currentQuantity: 0 }] },
      lineItems: [
        { title: "Ring", variantTitle: "Gold", sku: "SR-GOLD", quantity: 1, tags: [] },
        {
          title: "Blanket",
          quantity: 2,
          currentQuantity: 1,
          tags: ["blanket"],
          properties: [{ key: "Name", value: "Mia" }],
        },
      ],
    },
  ],
});

const NOW = 1_000_000_000_000;

/** Ids `id-1`, `id-2`, … in the order they are minted. */
const counter = () => {
  let next = 0;
  return () => `id-${(next += 1)}`;
};

const StoredTasks = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      step: Schema.Number,
      name: Schema.String,
      teamId: Schema.NullOr(Schema.String),
      instructions: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeTasks = Schema.decodeUnknownSync(StoredTasks);

describe("fixtureRows", () => {
  const { identity, actor } = fixtureRows(data, NOW, counter());
  const [clock, unassigned, empty, off] = actor.workflows;

  it("mints member and team ids first and points edges and tasks at them", () => {
    assert.deepStrictEqual(
      identity.members.map(({ id, email }) => [id, email]),
      [
        ["id-1", "ana@example.com"],
        ["id-2", "ben@example.com"],
      ],
    );
    assert.deepStrictEqual(
      identity.teams.map(({ id, name }) => [id, name]),
      [
        ["id-3", "Engraving"],
        ["id-4", "Nobody"],
      ],
    );
    assert.deepStrictEqual(identity.teamMembers, [
      { teamId: "id-3", memberId: "id-1", createdAt: NOW },
    ]);
    assert.deepStrictEqual(
      decodeTasks(clock?.tasks).map(({ teamId }) => teamId),
      ["id-3", "id-3", "id-3"],
    );
  });

  it("numbers steps: a task without one follows the previous", () => {
    assert.deepStrictEqual(
      decodeTasks(clock?.tasks).map(({ step }) => step),
      [1, 1, 2],
    );
    assert.deepStrictEqual(
      decodeTasks(clock?.draftTasks).map(({ teamId }) => teamId),
      [null],
    );
    assert.strictEqual(unassigned?.draftTasks, null);
  });

  it("defaults the state: active only with tasks that all have a team", () => {
    assert.deepStrictEqual(
      [clock, unassigned, empty, off].map((workflow) => workflow?.state),
      ["active", "inactive", "inactive", "inactive"],
    );
  });

  it("gives fixture orders their prefixed ids and stores them as placed", () => {
    const [fulfilled, cancelled] = actor.orders;
    assert.strictEqual(fulfilled?.id, `gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1201`);
    assert.strictEqual(fulfilled?.legacyId, `${FIXTURE_ORDER_PREFIX}1201`);
    assert.strictEqual(fulfilled?.name, "#1201");
    assert.strictEqual(fulfilled?.fulfillmentStatus, "UNFULFILLED");
    assert.strictEqual(fulfilled?.cancelledAt, null);
    assert.strictEqual(fulfilled?.processedAt, NOW - 2 * 86_400_000);
    assert.strictEqual(cancelled?.cancelledAt, null);
    assert.strictEqual(cancelled?.fulfillmentStatus, "UNFULFILLED");
    assert.strictEqual(cancelled?.fullyPaid, 0);
    assert.strictEqual(cancelled?.note, "Gift");
    assert.strictEqual(cancelled?.processedAt, NOW + 1);
    assert.deepStrictEqual(
      actor.orders.map(({ countedAt }) => countedAt),
      [0, 0],
    );
  });

  it("builds line items by position, as placed", () => {
    assert.deepStrictEqual(
      actor.lineItems.map(({ id, currentQuantity, sku }) => [id, currentQuantity, sku]),
      [
        [`gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1201/line-1`, 1, null],
        [`gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1202/line-1`, 1, "SR-GOLD"],
        [`gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1202/line-2`, 1, null],
      ],
    );
    assert.strictEqual(actor.lineItems[2]?.properties, '[{"key":"Name","value":"Mia"}]');
    assert.strictEqual(actor.lineItems[2]?.productTags, '["blanket"]');
  });

  it("carries each order's after, each item's progress and the members as the actor's work", () => {
    const order1201 = `gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1201`;
    const order1202 = `gid://shopify/Order/${FIXTURE_ORDER_PREFIX}1202`;
    assert.deepStrictEqual(actor.work, [
      {
        orderId: order1201,
        items: [{ lineItemId: `${order1201}/line-1`, workflowId: null, progress: { done: true } }],
        after: { fulfillmentStatus: "FULFILLED" },
      },
      {
        orderId: order1202,
        items: [
          { lineItemId: `${order1202}/line-1`, workflowId: null, progress: {} },
          { lineItemId: `${order1202}/line-2`, workflowId: null, progress: {} },
        ],
        after: { cancelled: true, lineItems: [{ position: 2, currentQuantity: 0 }] },
      },
    ]);
    assert.deepStrictEqual(actor.members, [
      { memberId: "id-1", email: "ana@example.com", teamIds: ["id-3"] },
      { memberId: "id-2", email: "ben@example.com", teamIds: [] },
    ]);
  });
});

describe("Fixtures.load", () => {
  const prior: ReadonlyArray<MemberRow> = [
    { id: "old-1", shop, email: email("old@example.com"), createdAt: 0 },
    { id: "old-2", shop, email: email("ana@example.com"), createdAt: 0 },
    { id: "other-1", shop: otherShop, email: email("ana@example.com"), createdAt: 0 },
  ];

  const harness = (sessions: ReadonlyArray<ShopSessionRow>) => {
    const revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }> = [];
    const loaded: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [];
    const layer = Fixtures.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ShopSessionRepository.layerTest(sessions),
          testMembershipRepository(prior),
          ShopActors.layerTest(revoked, loaded),
        ),
      ),
    );
    return { revoked, loaded, layer };
  };

  it.effect("fails with ShopNotInstalled when the shop has no session, writing nothing", () => {
    const { loaded, layer } = harness([]);
    return Effect.gen(function* () {
      const error = yield* (yield* Fixtures).load(shop, data).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ShopNotInstalled");
      assert.strictEqual(error.shop, shop);
      assert.strictEqual(loaded.length, 0);
      assert.strictEqual((yield* (yield* MembershipRepository).list()).length, prior.length);
    }).pipe(Effect.provide(layer));
  });

  it.effect("replaces only the named shop's rows and answers the counts", () => {
    const { loaded, layer } = harness([session]);
    return Effect.gen(function* () {
      const counts = yield* (yield* Fixtures).load(shop, data);
      assert.deepStrictEqual(counts, {
        members: 2,
        teams: 2,
        workflows: 4,
        orders: 2,
        lineItems: 3,
      });
      const members = yield* MembershipRepository;
      const rows = yield* members.list();
      assert.deepStrictEqual(
        rows.filter((row) => String(row.shop) === shop).map((row) => row.email),
        ["ana@example.com", "ben@example.com"],
      );
      assert.deepStrictEqual(
        rows.filter((row) => String(row.shop) === otherShop).map((row) => row.id),
        ["other-1"],
      );
      const ana = yield* members.findMember({ shop, email: email("ana@example.com") });
      assert.isTrue(Option.isSome(ana) && ana.value.id !== "old-2");
      assert.deepStrictEqual(
        loaded.map(({ key }) => key),
        [shop],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("revokes every member it replaced, and no one else", () => {
    const { revoked, layer } = harness([session]);
    return Effect.gen(function* () {
      yield* (yield* Fixtures).load(shop, data);
      assert.deepStrictEqual(
        revoked
          .map(({ key, by, id }) => [key, by, id])
          .toSorted((a, b) => a[2]!.localeCompare(b[2]!)),
        [
          [shop, "member", "old-1"],
          [shop, "member", "old-2"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});
