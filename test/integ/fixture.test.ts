import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { ShopKey } from "../../src/domain/platform.ts";
import {
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_REVOKED,
} from "../../src/contract/shop-actor.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { addToFixture, connectAs, dev, email, nextCloseCode, signIn } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * `LoadFixture` and `AddToFixture` against a real Backend, D1 and actor: a load replaces one
 * shop's rows, answers the counts it reads back, refuses a shop with no session, revokes the
 * members it replaced, and leaves every other shop alone; an add writes beside the rows, and a
 * clash in either store writes nothing.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("fixture"),
});

/**
 * A fresh stage per file, destroyed afterwards (see `auth.test.ts`), so this file's loads never
 * reach another file and `seed/test.sql`'s rows need no restoring.
 */
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const m1 = email("m1@m.com");
const m2 = email("m2@m.com");

const data = Schema.decodeUnknownSync(ShopFixtureData)({
  members: ["m1@m.com", "fixture-a@e2e.test", "fixture-b@e2e.test"],
  teams: [
    { name: "Engraving", members: ["m1@m.com", "fixture-a@e2e.test"] },
    { name: "Nobody", members: [] },
  ],
  workflows: [
    {
      name: "Engrave",
      tag: "engraved",
      tasks: [
        { name: "Cut", team: "Engraving" },
        { name: "Engrave", team: "Engraving" },
      ],
      draft: { tasks: [{ name: "Cut", team: null }] },
    },
    { name: "Off", tag: "off", tasks: [] },
  ],
  orders: [
    {
      n: 1201,
      after: { fulfillmentStatus: "FULFILLED" },
      lineItems: [{ title: "Board", quantity: 1, tags: ["engraved"] }],
    },
    {
      n: 1202,
      note: "Gift",
      lineItems: [
        {
          title: "Board",
          quantity: 2,
          tags: ["engraved"],
          properties: [{ key: "a", value: null }],
        },
        { title: "Card", quantity: 1, tags: [] },
      ],
    },
  ],
});

const load = (backendUrl: string, shop: ShopKey) =>
  dev(backendUrl, (client) => client.LoadFixture({ shop, fixture: data }));

/** `AddToFixture` with only the parts named, decoded as a fixture. */
const add = (backendUrl: string, shop: ShopKey, parts: object) =>
  addToFixture(
    backendUrl,
    shop,
    Schema.decodeUnknownSync(ShopFixtureData)({
      members: [],
      teams: [],
      workflows: [],
      orders: [],
      ...parts,
    }),
  );

const counts = { members: 3, teams: 2, workflows: 2, orders: 2, lineItems: 3 };

test(
  "LoadFixture revokes the shop's replaced members and leaves other shops alone",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    // First in the file, while `seed/test.sql`'s members are still there, and signed in before
    // the load: once it drops m2 from its one shop, m2 could not sign in at all.
    const m1Cookie = yield* signIn(backendUrl, m1);
    const m2Cookie = yield* signIn(backendUrl, m2);
    yield* Effect.gen(function* () {
      const before = yield* connectAs(backendUrl, SEED_SHOP, { cookie: m2Cookie });
      yield* before.client.MemberWhoAmI();
      yield* load(backendUrl, SEED_SHOP);
      assert.strictEqual(yield* nextCloseCode(before.closes), CONNECTION_CLOSE_REVOKED);
      // The reconnect goes back through the gate, and m2 is no longer a member.
      assert.strictEqual(yield* nextCloseCode(before.closes), CONNECTION_CLOSE_NOT_A_MEMBER);
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      const other = yield* connectAs(backendUrl, OTHER_SHOP, { cookie: m1Cookie });
      assert.strictEqual((yield* other.client.MemberWhoAmI()).role, "member");
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      const refused = yield* connectAs(backendUrl, OTHER_SHOP, { cookie: m2Cookie });
      assert.strictEqual(yield* nextCloseCode(refused.closes), CONNECTION_CLOSE_NOT_A_MEMBER);
    }).pipe(Effect.scoped);
  }),
);

test(
  "LoadFixture replaces a shop's rows, again and again, and answers the counts",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    assert.deepStrictEqual(yield* load(backendUrl, SEED_SHOP), counts);
    assert.deepStrictEqual(yield* load(backendUrl, SEED_SHOP), counts);
  }),
);

test(
  "LoadFixture fails with ShopNotInstalled for a shop with no session",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const shop = Schema.decodeUnknownSync(ShopKey)("not-installed.myshopify.com");
    const error = yield* load(backendUrl, shop).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ShopNotInstalled");
  }),
);

test(
  "AddToFixture adds beside the shop's rows; a clash in D1 or the actor writes nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    assert.deepStrictEqual(yield* load(backendUrl, SEED_SHOP), counts);
    const added = yield* add(backendUrl, SEED_SHOP, {
      members: ["added-a@e2e.test"],
      teams: [{ name: "Added", members: ["added-a@e2e.test"] }],
      workflows: [{ name: "Added", tag: "added", tasks: [{ name: "Do", team: "Added" }] }],
      orders: [{ n: 1301, lineItems: [{ title: "Card", quantity: 1, tags: ["added"] }] }],
    });
    assert.deepStrictEqual(added, { members: 4, teams: 3, workflows: 3, orders: 3, lineItems: 4 });

    const email = yield* add(backendUrl, SEED_SHOP, { members: ["m1@m.com"] }).pipe(Effect.flip);
    assert.strictEqual(email._tag, "FixtureConflict");
    const team = yield* add(backendUrl, SEED_SHOP, {
      members: ["team-a@e2e.test"],
      teams: [{ name: "Engraving", members: [] }],
    }).pipe(Effect.flip);
    assert.strictEqual(team._tag, "FixtureConflict");

    // The actor's clash: D1's pre-read passes, the actor refuses, and neither store is written,
    // so the same member then adds cleanly.
    for (const workflow of [
      { name: "Engrave", tag: "fresh", tasks: [] },
      { name: "Fresh", tag: "engraved", tasks: [] },
    ]) {
      const clash = yield* add(backendUrl, SEED_SHOP, {
        members: ["clash-a@e2e.test"],
        workflows: [workflow],
      }).pipe(Effect.flip);
      assert.strictEqual(clash._tag, "FixtureConflict");
    }
    const order = yield* add(backendUrl, SEED_SHOP, {
      members: ["clash-a@e2e.test"],
      orders: [{ n: 1201, lineItems: [] }],
    }).pipe(Effect.flip);
    assert.strictEqual(order._tag, "FixtureConflict");
    assert.deepStrictEqual(yield* add(backendUrl, SEED_SHOP, { members: ["clash-a@e2e.test"] }), {
      members: 5,
      teams: 3,
      workflows: 3,
      orders: 3,
      lineItems: 4,
    });
  }),
);

test(
  "AddToFixture fails with ShopNotInstalled for a shop with no session",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const shop = Schema.decodeUnknownSync(ShopKey)("not-installed.myshopify.com");
    const error = yield* add(backendUrl, shop, { members: ["x@e2e.test"] }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ShopNotInstalled");
  }),
);
