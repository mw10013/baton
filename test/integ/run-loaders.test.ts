import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { RUN_PAGE } from "../../src/domain/shop-work.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import { addToFixture, dev, email, integ, signIn } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The order page's and the member screens' first paints, as the Website's loaders reach them
 * (`ApiOrderDetail`, `ApiWorkflowsList`, `ApiMemberWorkflowPage`), over a fixture whose orders
 * carry progress: the merchant's token or the member's cookie names who reads, and the member's
 * teams come from the gate, never the payload.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("runloaders"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const fixture = Schema.decodeUnknownSync(ShopFixtureData);

const ANA = "ana@run-loaders.test";
const BEN = "ben@run-loaders.test";

/**
 * Ana on Bench, Ben on Idle; Engrave (two tasks on Bench); order 501's ring started by Ana,
 * order 502's ring at its second task.
 */
const WORK = fixture({
  members: [ANA, BEN],
  teams: [
    { name: "Bench", members: [ANA] },
    { name: "Idle", members: [BEN] },
  ],
  workflows: [
    {
      name: "Engrave",
      tag: "engrave",
      tasks: [
        { name: "Cut", team: "Bench" },
        { name: "Polish", team: "Bench" },
      ],
    },
  ],
  orders: [
    {
      n: 501,
      lineItems: [
        { title: "Ring", quantity: 1, tags: ["engrave"], progress: { started: true, by: ANA } },
      ],
    },
    {
      n: 502,
      lineItems: [{ title: "Band", quantity: 2, tags: ["engrave"], progress: { advance: 1 } }],
    },
  ],
});

/** The shop emptied and given {@link WORK}; Ana's and Ben's cookies. */
const arrange = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  yield* dev(backendUrl, (c) =>
    c.LoadFixture({
      shop: SEED_SHOP,
      fixture: { members: [], teams: [], workflows: [], orders: [] },
    }),
  );
  yield* addToFixture(backendUrl, SEED_SHOP, WORK);
  return {
    backendUrl,
    ana: yield* signIn(backendUrl, email(ANA)),
    ben: yield* signIn(backendUrl, email(BEN)),
  };
});

const listQuery = { state: "ready", team: null, limit: RUN_PAGE, q: null } as const;

test(
  "the order page's loader answers the order with its runs, and null for an order not stored",
  Effect.gen(function* () {
    const { backendUrl } = yield* arrange;
    const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
    const page = yield* integ(backendUrl, (c) =>
      c.ApiOrderDetail({ sessionToken, legacyId: "fixture-501" }),
    );
    assert.isNotNull(page);
    assert.strictEqual(page?.order.name, "#501");
    assert.deepStrictEqual(
      page?.runs.map(({ run, tasks }) => [
        run.workflowName,
        tasks.map((task) => task.startedAt !== null),
      ]),
      [["Engrave", [true, false]]],
    );
    assert.deepStrictEqual(page?.teams.map(({ name }) => name).toSorted(), ["Bench", "Idle"]);
    assert.isNull(
      yield* integ(backendUrl, (c) => c.ApiOrderDetail({ sessionToken, legacyId: "fixture-9" })),
    );
  }),
);

test(
  "the workflows list's loader answers the member, their teams and their teams' work",
  Effect.gen(function* () {
    const { backendUrl, ana, ben } = yield* arrange;
    const forAna = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: ana, key: SEED_SHOP, ...listQuery, state: "started_by_you" }),
    );
    assert.strictEqual(forAna.memberEmail, ANA);
    assert.deepStrictEqual(
      forAna.teams.map(({ name }) => name),
      ["Bench"],
    );
    assert.deepStrictEqual(
      forAna.list.items.map(({ run }) => run.orderName),
      ["#501"],
    );
    assert.strictEqual(forAna.list.counts.ready, 1, "order 502's Polish is Ready for Bench");
    const forBen = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: ben, key: SEED_SHOP, ...listQuery }),
    );
    assert.deepStrictEqual(forBen.list.items, []);
    // A team the member is not on reads as any team.
    const narrowed = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({
        cookie: ben,
        key: SEED_SHOP,
        ...listQuery,
        team: forAna.teams[0]?.id ?? null,
      }),
    );
    assert.strictEqual(narrowed.query.team, null);
  }),
);

test(
  "the member's workflow page's loader answers the page for a member on its team and null for one who is not",
  Effect.gen(function* () {
    const { backendUrl, ana, ben } = yield* arrange;
    const list = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: ana, key: SEED_SHOP, ...listQuery, state: "started_by_you" }),
    );
    const runId = list.list.items[0]?.run.id ?? "";
    const forAna = yield* integ(backendUrl, (c) =>
      c.ApiMemberWorkflowPage({ cookie: ana, key: SEED_SHOP, runId }),
    );
    assert.strictEqual(forAna.page?.run.id, runId);
    assert.deepStrictEqual(
      forAna.page?.tasks.map(({ name, current }) => [name, current]),
      [
        ["Cut", true],
        ["Polish", false],
      ],
    );
    const forBen = yield* integ(backendUrl, (c) =>
      c.ApiMemberWorkflowPage({ cookie: ben, key: SEED_SHOP, runId }),
    );
    assert.isNull(forBen.page);
    assert.deepStrictEqual(
      forBen.teams.map(({ name }) => name),
      ["Idle"],
    );
  }),
);

test(
  "is gated by membership like the shop page",
  Effect.gen(function* () {
    const { backendUrl, ana } = yield* arrange;
    const list = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: ana, key: SEED_SHOP, ...listQuery }),
    );
    assert.strictEqual(list.memberEmail, ANA);
    const page = yield* integ(backendUrl, (c) =>
      c.ApiMemberWorkflowPage({ cookie: ana, key: SEED_SHOP, runId: "none" }),
    );
    assert.isNull(page.page);
    const elsewhere = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: ana, key: OTHER_SHOP, ...listQuery }).pipe(Effect.flip),
    );
    assert.strictEqual(elsewhere._tag, "NotAShopMember");
    const elsewherePage = yield* integ(backendUrl, (c) =>
      c.ApiMemberWorkflowPage({ cookie: ana, key: OTHER_SHOP, runId: "none" }).pipe(Effect.flip),
    );
    assert.strictEqual(elsewherePage._tag, "NotAShopMember");
    const signedOut = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsList({ cookie: "", key: SEED_SHOP, ...listQuery }).pipe(Effect.flip),
    );
    assert.strictEqual(signedOut._tag, "Unauthorized");
  }),
);
