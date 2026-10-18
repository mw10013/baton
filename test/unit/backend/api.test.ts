import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  EmailFromInput,
  MagicLinkRequested,
  type RequestInfo,
} from "../../../src/contract/auth.ts";
import { type ShopKey } from "../../../src/contract/shop.ts";
import { OTHER_SHOP, SEED_SHOP } from "../../seed-shops.ts";
import type { ConnectionCaller, MemberCaller } from "../../../src/contract/shop-actor.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { BackendApi, SignInLimiter } from "../../../src/backend/api.ts";
import { mintSessionToken } from "../../shopify-session-token.ts";
import {
  type MemberRow,
  QuietLogs,
  TEST_SHOPIFY_APP,
  testAuth,
  testMembershipRepository,
  testShopify,
} from "./layers.ts";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import {
  type ListRunsInput,
  type MemberAccess,
  MemberId,
  type OrdersIndexData,
  TeamId,
  TeamName,
  WorkflowName,
  type WorkflowsListData,
} from "../../../src/domain/shop-work.ts";
import { Auth } from "../../../src/backend/auth.ts";
import { SentMail } from "../../../src/backend/mailer.ts";
import { ShopAccess, ShopAccessDenied } from "../../../src/backend/shop-access.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";

const email = Schema.decodeUnknownSync(EmailFromInput);
const decodeRequested = Schema.decodeSync(MagicLinkRequested);

const admin = email("a@a.com");
const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const members: ReadonlyArray<MemberRow> = [
  { id: "mem-1", shop: SEED_SHOP, email: member, createdAt: 1 },
];
const merchant: ConnectionCaller = { role: "merchant" };

/** The seed's row for the seed shop: a stored token that never expires, so no exchange runs. */
const seedSession: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_orders,write_orders",
  accessTokenExpiresAt: 4102444800000,
  accessToken: "shpat_fake_seed_shop",
  refreshToken: "shprt_fake_seed_shop",
  refreshTokenExpiresAt: 4102444800000,
  refreshLeaseUntil: null,
  planHandle: "basic",
  planHandleExpiresAt: 4102444800000,
  planBoundaryAt: null,
};
const snapshot = { count: { value: 3 }, activation: { id: "activation-1" } };

/** A request with only a cookie, as a server function forwards it. */
const withCookie = (cookie: string | undefined): RequestInfo => ({ cookie, ip: undefined });

/**
 * {@link BackendApi} over Better Auth on an in-memory database, fresh per test. `allow` is the
 * rate limiter's answer; `gate` is what {@link ShopAccess} answers every caller.
 */
const TestBackend = ({
  delivery = "inline",
  allow = true,
  gate = Effect.succeed(merchant),
  memberRows = members,
  membershipRepositoryLayer,
  actors = ShopActors.layerTest([], snapshot),
  memberGate = Effect.die("no member gate in this test"),
}: {
  delivery?: "inline" | "mailed";
  allow?: boolean;
  gate?: Effect.Effect<ConnectionCaller, ShopAccessDenied>;
  memberRows?: ReadonlyArray<MemberRow>;
  membershipRepositoryLayer?: Layer.Layer<MembershipRepository>;
  actors?: Layer.Layer<ShopActors>;
  memberGate?: Effect.Effect<
    { readonly caller: MemberCaller; readonly teams: MemberAccess["teams"] },
    ShopAccessDenied
  >;
} = {}) =>
  BackendApi.layer.pipe(
    Layer.provideMerge(
      testAuth({
        members: memberRows,
        ...(membershipRepositoryLayer === undefined ? {} : { membershipRepositoryLayer }),
        actors,
        delivery,
        extra: Layer.mergeAll(
          SignInLimiter.layerTest(allow),
          Layer.succeed(ShopAccess, { resolve: () => gate, resolveMember: () => memberGate }),
          testShopify([seedSession]),
        ),
      }),
    ),
    // A Worker method runs with Alchemy's runtime marker, which the bridge provides per call.
    Layer.provideMerge(RuntimeContext.phantom),
    Layer.provide(QuietLogs),
  );

/** Requests a link for `address` and follows it; returns the cookie header of the new session. */
const signIn = Effect.fn("signIn")(function* (address: typeof member) {
  const api = yield* BackendApi;
  const { auth } = yield* Auth;
  const { link } = decodeRequested(
    yield* api.requestMagicLink(withCookie(undefined), { email: address }),
  );
  const response = yield* auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(Option.getOrThrow(link))),
    ),
    Effect.map(HttpServerResponse.toWeb),
  );
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
});

/** The admin's user row, as the stage's auth seed inserts it; Better Auth's hooks refuse it otherwise. */
const seedAdmin = Effect.gen(function* () {
  const { auth } = yield* Auth;
  const instance = yield* auth.auth;
  const context = yield* Effect.promise(() => instance.$context);
  const now = new Date();
  yield* Effect.promise(() =>
    context.adapter.create({
      model: "user",
      data: {
        name: "Admin",
        email: admin,
        emailVerified: true,
        role: "admin",
        banned: false,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
});

describe("BackendApi sessions", () => {
  it.live("me without a cookie is Unauthorized", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api.me(withCookie(undefined)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("listMembers is Forbidden to a user and answers an admin", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const asMember = yield* signIn(member);
      const error = yield* api.listMembers(withCookie(asMember)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
      yield* seedAdmin;
      const asAdmin = yield* signIn(admin);
      const list = yield* api.listMembers(withCookie(asAdmin));
      assert.deepStrictEqual(
        list.map((row) => row.email),
        [member],
      );
    }).pipe(Effect.provide(TestBackend())),
  );
});

describe("BackendApi.myShops", () => {
  it.live("answers every shop of a member of two, by key, and is Forbidden to an admin", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const asMember = yield* signIn(member);
      assert.deepStrictEqual(yield* api.myShops(withCookie(asMember)), [OTHER_SHOP, SEED_SHOP]);
      yield* seedAdmin;
      const asAdmin = yield* signIn(admin);
      const error = yield* api.myShops(withCookie(asAdmin)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }).pipe(
      Effect.provide(
        TestBackend({
          memberRows: [...members, { id: "mem-3", shop: OTHER_SHOP, email: member, createdAt: 1 }],
        }),
      ),
    ),
  );
});

describe("BackendApi.requestMagicLink", () => {
  it.live("rate-limited is TooManyRequests and sends nothing", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api
        .requestMagicLink({ cookie: undefined, ip: "203.0.113.1" }, { email: member })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "TooManyRequests");
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend({ delivery: "mailed", allow: false }))),
  );

  it.live("a non-member gets the same answer as a member, without a link", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const answer = yield* api.requestMagicLink(withCookie(undefined), { email: stranger });
      assert.deepStrictEqual(answer, { link: null });
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend())),
  );
});

describe("BackendApi.shopSnapshot", () => {
  const key: ShopKey = SEED_SHOP;

  it.live("answers the gate's caller and the actor's snapshot", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const answer = yield* api.shopSnapshot(withCookie(undefined), { key, sessionToken: "t" });
      assert.deepStrictEqual(answer, { caller: merchant, snapshot });
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live.each([
    { status: 401, tag: "Unauthorized" },
    { status: 403, tag: "Forbidden" },
    { status: 404, tag: "NotAShopMember" },
  ] as const)("the gate's $status is $tag", ({ status, tag }) =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api.shopSnapshot(withCookie(undefined), { key }).pipe(Effect.flip);
      assert.strictEqual(error._tag, tag);
    }).pipe(Effect.provide(TestBackend({ gate: Effect.fail(new ShopAccessDenied({ status })) }))),
  );

  it.live("the gate's 503 is a defect", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const exit = yield* api.shopSnapshot(withCookie(undefined), { key }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }).pipe(
      Effect.provide(TestBackend({ gate: Effect.fail(new ShopAccessDenied({ status: 503 })) })),
    ),
  );
});

describe("BackendApi.authenticateAdmin", () => {
  /** A session token for the seed shop, signed by the app `options` names. */
  const tokenFrom = (options: { apiKey: string; apiSecret: string }) =>
    mintSessionToken({ shop: SEED_SHOP, ...options });

  it.live("a stored, active session is reused: the shop comes back and the row is untouched", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* tokenFrom(TEST_SHOPIFY_APP);
      const answer = yield* api.authenticateAdmin(withCookie(undefined), { sessionToken });
      assert.deepStrictEqual(answer, { shop: SEED_SHOP, shopGid: seedSession.shopGid });
      const row = yield* (yield* ShopSessionRepository).find(SEED_SHOP);
      assert.deepStrictEqual(row, Option.some(seedSession));
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("a token signed with another secret is InvalidSessionToken", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* tokenFrom({ ...TEST_SHOPIFY_APP, apiSecret: "other-secret" });
      const error = yield* api
        .authenticateAdmin(withCookie(undefined), { sessionToken })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidSessionToken");
    }).pipe(Effect.provide(TestBackend())),
  );
});

describe("BackendApi orders", () => {
  const page: OrdersIndexData = {
    page: {
      orders: [],
      limit: 25,
      nextCursor: null,
      counts: { no_workflow: 0, not_started: 0, making: 0, made: 0, issues: 0 },
      openOrders: 0,
      matches: null,
    },
    syncState: { inFlight: false, lastError: null },
    teams: [],
  };
  /** The orders index's first page, every order. */
  const input = { limit: 25, cursor: null, q: null, show: "all", team: null } as const;
  /** {@link ShopActors.layerTest} whose `listOrders` answers {@link page}, recording each shop. */
  const listingActors = (listed: Array<ShopKey>) =>
    Layer.effect(
      ShopActors,
      Effect.gen(function* () {
        const base = yield* ShopActors;
        return {
          ...base,
          listOrders: (key: ShopKey) =>
            Effect.sync(() => {
              listed.push(key);
              return page;
            }),
        };
      }),
    ).pipe(Layer.provide(ShopActors.layerTest([], snapshot)));
  const badToken = mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });

  it.live("each refuses a token signed with another secret, touching nothing", () => {
    const listed: Array<ShopKey> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* badToken;
      const error = yield* api
        .listOrders(withCookie(undefined), { sessionToken, ...input })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidSessionToken");
      assert.deepStrictEqual(listed, []);
    }).pipe(Effect.provide(TestBackend({ actors: listingActors(listed) })));
  });

  it.live("each acts for the shop its token names", () => {
    const listed: Array<ShopKey> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
      assert.deepStrictEqual(
        yield* api.listOrders(withCookie(undefined), { sessionToken, ...input }),
        page,
      );
      assert.deepStrictEqual(listed, [SEED_SHOP]);
    }).pipe(Effect.provide(TestBackend({ actors: listingActors(listed) })));
  });

  it.live(
    "listOrders for a shop with no ShopSession is ShopNotInstalled and reads no actor",
    () => {
      const listed: Array<ShopKey> = [];
      return Effect.gen(function* () {
        const api = yield* BackendApi;
        const sessionToken = yield* mintSessionToken({ shop: OTHER_SHOP });
        const error = yield* api
          .listOrders(withCookie(undefined), { sessionToken, ...input })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ShopNotInstalled");
        assert.deepStrictEqual(listed, []);
      }).pipe(Effect.provide(TestBackend({ actors: listingActors(listed) })));
    },
  );
});

describe("BackendApi run loaders", () => {
  const empty: WorkflowsListData = {
    counts: { started_by_you: 0, ready: 0, started_by_others: 0, blocked: 0, done: 0 },
    items: [],
    recent: [],
    matches: null,
  };
  const bench = {
    id: Schema.decodeUnknownSync(TeamId)("team-bench"),
    name: Schema.decodeUnknownSync(TeamName)("Bench"),
  };
  const memberId = Schema.decodeUnknownSync(MemberId)("mem-1");
  const memberGate = Effect.succeed({
    caller: {
      role: "member" as const,
      memberId: "mem-1",
      memberEmail: member,
      teamIds: [bench.id],
      userId: "user-1",
      sessionId: "session-1",
      sessionExpiresAt: Date.now() + 600_000,
    },
    teams: [bench],
  });
  /** {@link ShopActors.layerTest} whose three run reads answer empty, recording each call. */
  const runActors = (calls: Array<string>) =>
    Layer.effect(
      ShopActors,
      Effect.gen(function* () {
        const base = yield* ShopActors;
        return {
          ...base,
          getOrderDetail: (key: ShopKey, input: { readonly legacyId: string }) =>
            Effect.sync(() => {
              calls.push(`getOrderDetail ${key} ${input.legacyId}`);
              return null;
            }),
          listRuns: (key: ShopKey, input: ListRunsInput) =>
            Effect.sync(() => {
              calls.push(`listRuns ${key} ${input.query.team ?? "any"} ${input.teamIds.join(",")}`);
              return empty;
            }),
          getRunPage: (key: ShopKey, input: { readonly runId: string }) =>
            Effect.sync(() => {
              calls.push(`getRunPage ${key} ${input.runId}`);
              return null;
            }),
        };
      }),
    ).pipe(Layer.provide(ShopActors.layerTest([], snapshot)));
  const query = { key: SEED_SHOP, state: "ready", team: null, limit: 25, q: null } as const;

  it.live(
    "orderDetail refuses a token signed with another secret and a shop with no ShopSession, before any actor call",
    () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const api = yield* BackendApi;
        const bad = yield* mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });
        const refused = yield* api
          .orderDetail(withCookie(undefined), { sessionToken: bad, legacyId: "1" })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "InvalidSessionToken");
        const uninstalled = yield* mintSessionToken({ shop: OTHER_SHOP });
        const missing = yield* api
          .orderDetail(withCookie(undefined), { sessionToken: uninstalled, legacyId: "1" })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ShopNotInstalled");
        assert.deepStrictEqual(calls, []);
        const good = yield* mintSessionToken({ shop: SEED_SHOP });
        assert.isNull(
          yield* api.orderDetail(withCookie(undefined), { sessionToken: good, legacyId: "1" }),
        );
        assert.deepStrictEqual(calls, [`getOrderDetail ${SEED_SHOP} 1`]);
      }).pipe(Effect.provide(TestBackend({ actors: runActors(calls) })));
    },
  );

  it.live(
    "workflowsList answers the member, their teams and the list, and resolves the URL's team against the teams",
    () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const api = yield* BackendApi;
        const data = yield* api.workflowsList(withCookie("c"), { ...query, team: bench.id });
        assert.deepStrictEqual(data, {
          memberId,
          memberEmail: member,
          teams: [bench],
          query: { state: "ready", team: bench.id, limit: 25, q: null },
          list: empty,
        });
        const elsewhere = yield* api.workflowsList(withCookie("c"), { ...query, team: "gone" });
        assert.strictEqual(elsewhere.query.team, null);
        assert.deepStrictEqual(calls, [
          `listRuns ${SEED_SHOP} ${bench.id} ${bench.id}`,
          `listRuns ${SEED_SHOP} any ${bench.id}`,
        ]);
      }).pipe(Effect.provide(TestBackend({ actors: runActors(calls), memberGate })));
    },
  );

  it.live("memberWorkflowPage answers the member, their teams and the page", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const data = yield* api.memberWorkflowPage(withCookie("c"), { key: SEED_SHOP, runId: "r" });
      assert.deepStrictEqual(data, {
        memberId,
        memberEmail: member,
        teams: [bench],
        page: null,
      });
      assert.deepStrictEqual(calls, [`getRunPage ${SEED_SHOP} r`]);
    }).pipe(Effect.provide(TestBackend({ actors: runActors(calls), memberGate })));
  });

  it.live.each([
    { status: 401, tag: "Unauthorized" },
    { status: 403, tag: "Forbidden" },
    { status: 404, tag: "NotAShopMember" },
  ] as const)(
    "the member loaders turn the gate's $status into $tag with no actor call",
    ({ status, tag }) => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const api = yield* BackendApi;
        const list = yield* api.workflowsList(withCookie("c"), query).pipe(Effect.flip);
        const page = yield* api
          .memberWorkflowPage(withCookie("c"), { key: SEED_SHOP, runId: "r" })
          .pipe(Effect.flip);
        assert.deepStrictEqual([list._tag, page._tag], [tag, tag]);
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          TestBackend({
            actors: runActors(calls),
            memberGate: Effect.fail(new ShopAccessDenied({ status })),
          }),
        ),
      );
    },
  );

  it.live("the member loaders turn the gate's 503 into a defect with no actor call", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const list = yield* api.workflowsList(withCookie("c"), query).pipe(Effect.exit);
      const page = yield* api
        .memberWorkflowPage(withCookie("c"), { key: SEED_SHOP, runId: "r" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(list) && Cause.hasDies(list.cause));
      assert.isTrue(Exit.isFailure(page) && Cause.hasDies(page.cause));
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        TestBackend({
          actors: runActors(calls),
          memberGate: Effect.fail(new ShopAccessDenied({ status: 503 })),
        }),
      ),
    );
  });
});

describe("BackendApi workflows", () => {
  const index = { workflows: [], nextCursor: null, matches: null };
  const facts = { activeWorkflow: true, run: false };
  /**
   * {@link ShopActors.layerTest} whose workflow reads answer fixed data, recording each call as
   * `<method> <shop>` and the index's input.
   */
  const workflowActors = (calls: Array<string>, inputs: Array<unknown> = []) =>
    Layer.effect(
      ShopActors,
      Effect.gen(function* () {
        const base = yield* ShopActors;
        return {
          ...base,
          listWorkflows: (key: ShopKey, input: unknown) =>
            Effect.sync(() => {
              calls.push(`listWorkflows ${key}`);
              inputs.push(input);
              return index;
            }),
          getWorkflowDetail: (key: ShopKey) =>
            Effect.sync(() => {
              calls.push(`getWorkflowDetail ${key}`);
              return null;
            }),
          workflowSetupFacts: (key: ShopKey) =>
            Effect.sync(() => {
              calls.push(`workflowSetupFacts ${key}`);
              return facts;
            }),
        };
      }),
    ).pipe(Layer.provide(ShopActors.layerTest([], snapshot)));

  /** Every loader method of the workflows screens and the App Home, on `sessionToken`. */
  const everyMethod = (
    api: BackendApi["Service"],
    sessionToken: string,
  ): ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> => [
    api.workflowsPage(withCookie(undefined), { sessionToken, state: null, q: null, after: null }),
    api.workflowDetail(withCookie(undefined), { sessionToken, workflowId: "w-1" }),
    api.setupFacts(withCookie(undefined), { sessionToken }),
  ];

  it.live("each refuses a token signed with another secret, touching nothing", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });
      for (const call of everyMethod(api, sessionToken)) {
        const error = yield* Effect.flip(call);
        assert.strictEqual(error._tag, "InvalidSessionToken");
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(TestBackend({ actors: workflowActors(calls) })));
  });

  it.live("each for a shop with no ShopSession is ShopNotInstalled and reads no actor", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const api = yield* BackendApi;
      const sessionToken = yield* mintSessionToken({ shop: OTHER_SHOP });
      for (const call of everyMethod(api, sessionToken)) {
        const error = yield* Effect.flip(call);
        assert.strictEqual(error._tag, "ShopNotInstalled");
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(TestBackend({ actors: workflowActors(calls) })));
  });

  it.live(
    "workflowsPage pages 50 by the request's after; workflowDetail and setupFacts read the token's shop",
    () => {
      const calls: Array<string> = [];
      const inputs: Array<unknown> = [];
      return Effect.gen(function* () {
        const api = yield* BackendApi;
        const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
        const after = Schema.decodeUnknownSync(WorkflowName)("Mugs");
        assert.deepStrictEqual(
          yield* api.workflowsPage(withCookie(undefined), {
            sessionToken,
            state: "active",
            q: null,
            after,
          }),
          index,
        );
        assert.deepStrictEqual(inputs, [{ limit: 50, cursor: "Mugs", q: null, state: "active" }]);
        assert.strictEqual(
          yield* api.workflowDetail(withCookie(undefined), { sessionToken, workflowId: "w-1" }),
          null,
        );
        // The test D1 holds no team, so D1's half is false; the actor's half comes through.
        assert.deepStrictEqual(yield* api.setupFacts(withCookie(undefined), { sessionToken }), {
          teamWithMember: false,
          activeWorkflow: true,
          run: false,
        });
        assert.deepStrictEqual(calls, [
          `listWorkflows ${SEED_SHOP}`,
          `getWorkflowDetail ${SEED_SHOP}`,
          `workflowSetupFacts ${SEED_SHOP}`,
        ]);
      }).pipe(Effect.provide(TestBackend({ actors: workflowActors(calls, inputs) })));
    },
  );
});

describe("BackendApi members and teams", () => {
  const memberId = Schema.decodeUnknownSync(MemberId)("mem-1");
  const teamId = Schema.decodeUnknownSync(TeamId)("team-unknown");

  /** The real {@link MembershipRepository} over {@link members}, recording each page or detail read. */
  const recordingMembershipRepository = (reads: Array<string>) =>
    Layer.effect(
      MembershipRepository,
      Effect.gen(function* () {
        const base = yield* MembershipRepository;
        const record =
          <Args extends ReadonlyArray<unknown>, A, E>(
            name: string,
            read: (...args: Args) => Effect.Effect<A, E>,
          ) =>
          (...args: Args) =>
            Effect.suspend(() => {
              reads.push(name);
              return read(...args);
            });
        return {
          ...base,
          listMembersPage: record("listMembersPage", base.listMembersPage),
          findMemberDetail: record("findMemberDetail", base.findMemberDetail),
          listTeamsPage: record("listTeamsPage", base.listTeamsPage),
          findTeamDetail: record("findTeamDetail", base.findTeamDetail),
        };
      }),
    ).pipe(Layer.provide(testMembershipRepository(members)));

  /** The four loader reads for `sessionToken`, each settled to its answer or its failure tag. */
  const readAll = (sessionToken: string) =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const request = withCookie(undefined);
      const settle = <A, E extends { readonly _tag: string }>(read: Effect.Effect<A, E>) =>
        read.pipe(
          Effect.map((value) => ({ ok: value as unknown })),
          Effect.catch((error) => Effect.succeed({ failed: error._tag })),
        );
      return [
        yield* settle(api.membersPage(request, { sessionToken, q: null, after: null })),
        yield* settle(api.memberDetail(request, { sessionToken, memberId, teamsAfter: null })),
        yield* settle(api.teamsPage(request, { sessionToken, q: null, after: null })),
        yield* settle(api.teamDetail(request, { sessionToken, teamId, membersAfter: null })),
      ];
    });

  it.live("each refuses a token signed with another secret, reading no member or team", () => {
    const reads: Array<string> = [];
    return Effect.gen(function* () {
      const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });
      assert.deepStrictEqual(
        yield* readAll(sessionToken),
        Array.from({ length: 4 }, () => ({ failed: "InvalidSessionToken" })),
      );
      assert.deepStrictEqual(reads, []);
    }).pipe(
      Effect.provide(
        TestBackend({ membershipRepositoryLayer: recordingMembershipRepository(reads) }),
      ),
    );
  });

  it.live("each reads the shop its token names", () => {
    const reads: Array<string> = [];
    return Effect.gen(function* () {
      const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
      const [membersPage, memberDetail, teamsPage, teamDetail] = yield* readAll(sessionToken);
      const page = membersPage as { ok: { rows: ReadonlyArray<{ email: string }> } };
      assert.deepStrictEqual(
        page.ok.rows.map((row) => row.email),
        ["m1@m.com"],
      );
      const detail = memberDetail as { ok: { member: { email: string }; teamCount: number } };
      assert.strictEqual(detail.ok.member.email, "m1@m.com");
      assert.strictEqual(detail.ok.teamCount, 0);
      assert.deepStrictEqual(teamsPage, { ok: { rows: [], nextCursor: null, matches: null } });
      assert.deepStrictEqual(teamDetail, { ok: null });
      assert.deepStrictEqual(reads, [
        "listMembersPage",
        "findMemberDetail",
        "listTeamsPage",
        "findTeamDetail",
      ]);
    }).pipe(
      Effect.provide(
        TestBackend({ membershipRepositoryLayer: recordingMembershipRepository(reads) }),
      ),
    );
  });

  it.live(
    "each for a shop with no ShopSession is ShopNotInstalled and reads no member or team",
    () => {
      const reads: Array<string> = [];
      return Effect.gen(function* () {
        const sessionToken = yield* mintSessionToken({ shop: OTHER_SHOP });
        assert.deepStrictEqual(
          yield* readAll(sessionToken),
          Array.from({ length: 4 }, () => ({ failed: "ShopNotInstalled" })),
        );
        assert.deepStrictEqual(reads, []);
      }).pipe(
        Effect.provide(
          TestBackend({ membershipRepositoryLayer: recordingMembershipRepository(reads) }),
        ),
      );
    },
  );
});
