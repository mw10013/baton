import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  EmailFromInput,
  MagicLinkRequested,
  ReturnPath,
  type RequestInfo,
} from "../../../src/contract/auth.ts";
import { type ShopKey } from "../../../src/contract/shop.ts";
import { SEED_SHOP } from "../../seed-shops.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { BackendApi, SignInLimiter } from "../../../src/backend/api.ts";
import { MagicLinkDelivery } from "../../../src/backend/magic-link-delivery.ts";
import {
  makeD1Test,
  type MemberRow,
  QuietLogs,
  seedD1,
  TEST_ORIGIN,
  testAuth,
  testShopify,
} from "./layers.ts";
import { Members } from "../../../src/backend/members.ts";
import { Auth } from "../../../src/backend/auth.ts";
import { SentMail } from "../../../src/backend/mailer.ts";
import { ShopAccess } from "../../../src/backend/shop-access.ts";

const ORIGIN = TEST_ORIGIN;
const email = Schema.decodeUnknownSync(EmailFromInput);
const returnPath = Schema.decodeUnknownSync(ReturnPath);
const decodeRequested = Schema.decodeSync(MagicLinkRequested);

/** A request with only a cookie, as a server function forwards it. */
const withCookie = (cookie: string | undefined): RequestInfo => ({ cookie, ip: undefined });

const admin = email("a@a.com");
const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const member2 = email("m2@m.com");
/** Baton's `Member` rows. The admin has none: it is a user row with the role `admin`. */
const members: ReadonlyArray<MemberRow> = [
  { id: "mem-1", shop: SEED_SHOP, email: member, createdAt: 1 },
  { id: "mem-2", shop: SEED_SHOP, email: member2, createdAt: 2 },
];

/** What the Better Auth hooks asked the actors to revoke; cleared by the tests that read it. */
const revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }> = [];

/**
 * {@link BackendApi} over Better Auth on an in-memory database, fresh per test.
 * `delivery` is the stage's {@link MagicLinkDelivery} choice; `allow` is the rate limiter's
 * answer. The test owns every effect of the Backend, the logger included: `Info` is dropped,
 * so only a warning or error reaches the test output.
 */
const TestBackend = ({
  delivery,
  allow = true,
  membersLayer,
}: {
  delivery: "inline" | "mailed";
  allow?: boolean;
  membersLayer?: Layer.Layer<Members>;
}) =>
  BackendApi.layer.pipe(
    Layer.provideMerge(
      testAuth({
        members,
        ...(membersLayer === undefined ? {} : { membersLayer }),
        actors: ShopActors.layerTest(revoked),
        delivery,
        extra: Layer.mergeAll(
          SignInLimiter.layerTest(allow),
          Layer.succeed(ShopAccess, { resolve: () => Effect.die("ShopAccess needs D1") }),
          testShopify(),
        ),
      }),
    ),
    // A Worker method runs with Alchemy's runtime marker, which the bridge provides per call.
    Layer.provideMerge(RuntimeContext.phantom),
    Layer.provide(QuietLogs),
  );

/** Serves one web `Request` through Better Auth's routes, as the Worker's `fetch` would. */
const serve = Effect.fn("serve")(function* (request: Request) {
  const { auth } = yield* Auth;
  const response = yield* auth.fetch.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.provide(RuntimeContext.phantom),
  );
  return HttpServerResponse.toWeb(response);
});

const toCookieHeader = (setCookies: ReadonlyArray<string>) =>
  setCookies.map((cookie) => cookie.split(";")[0]).join("; ");

/** Requests a link for `address` and follows it; returns the cookie header of the new session. */
const signIn = Effect.fn("signIn")(function* (address: typeof member, returnTo = "/shop") {
  const api = yield* BackendApi;
  const { link } = decodeRequested(
    yield* api.requestMagicLink(withCookie(undefined), {
      email: address,
      returnTo: returnPath(returnTo),
    }),
  );
  assert.isTrue(Option.isSome(link), "inline delivery returns the link");
  const response = yield* serve(new Request(Option.getOrThrow(link)));
  assert.strictEqual(response.status, 302);
  assert.strictEqual(new URL(response.headers.get("location") ?? "").pathname, returnTo);
  return toCookieHeader(response.headers.getSetCookie());
});

/**
 * Inserts the admin's user row, as the stage's auth seed does. Straight through the
 * adapter, because Better Auth's create hooks refuse an address with no `Member` row.
 */
const seedAdmin = Effect.gen(function* () {
  const { auth } = yield* Auth;
  const instance = yield* auth.auth.pipe(Effect.provide(RuntimeContext.phantom));
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

describe("magic-link sign-in (inline delivery)", () => {
  it.live.each([
    { address: member, role: "user" },
    { address: admin, role: "admin" },
  ])("a member signs in as a new user; the seeded admin keeps its role (%#)", ({ address, role }) =>
    Effect.gen(function* () {
      yield* seedAdmin;
      const cookie = yield* signIn(address);
      const api = yield* BackendApi;
      const me = yield* api.me(withCookie(cookie));
      assert.strictEqual(me.email, address);
      assert.strictEqual(me.role, role);
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("a non-member gets no link and no mail", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const { link } = decodeRequested(
        yield* api.requestMagicLink(withCookie(undefined), { email: stranger }),
      );
      assert.isTrue(Option.isNone(link));
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("a non-member's link, obtained directly, is refused at verify", () =>
    Effect.gen(function* () {
      const { auth } = yield* Auth;
      const { take } = yield* MagicLinkDelivery;
      yield* auth.api
        .signInMagicLink({
          body: { email: stranger, callbackURL: "/shop" },
          headers: new Headers(),
        })
        .pipe(Effect.provide(RuntimeContext.phantom));
      const link = yield* take(stranger);
      const response = yield* serve(new Request(Option.getOrThrow(link)));
      assert.strictEqual(response.status, 302);
      const location = new URL(response.headers.get("location") ?? "");
      assert.strictEqual(location.searchParams.get("error"), "not_invited");
      assert.deepStrictEqual(response.headers.getSetCookie(), [], "no session was created");
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("sign-out ends the session and revokes its sockets on the member's shops", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn(member);
      revoked.length = 0;
      const api = yield* BackendApi;
      const response = yield* serve(
        new Request(`${ORIGIN}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        }),
      );
      assert.strictEqual(response.status, 200);
      const error = yield* api.me(withCookie(cookie)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
      assert.deepStrictEqual(
        revoked.map(({ key, by }) => ({ key, by })),
        [{ key: SEED_SHOP, by: "session" }],
      );
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );
});

describe("expired-auth sweep", () => {
  /**
   * The link request carries the sweep: `Auth`'s `sendMagicLink` runs `sweepExpiredAuth` on D1
   * before it delivers. Better Auth itself runs on the in-memory adapter here, so the expired
   * rows are seeded straight into the test D1 the Backend's `Members` reads.
   */
  it.live("sweeps expired Session and Verification rows on the way out", () =>
    Effect.gen(function* () {
      const { db, raw } = yield* makeD1Test;
      seedD1(db, { shops: [], members });
      const expired = new Date(Date.UTC(2000, 0, 1)).toISOString();
      db.prepare(
        "insert into user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'M', 'm1@m.com', 0, '', '')",
      ).run();
      db.prepare(
        "insert into session (id, expiresAt, token, createdAt, updatedAt, userId) values ('s-old', ?, 't-old', '', '', 'u1')",
      ).run(expired);
      db.prepare(
        "insert into verification (id, identifier, value, expiresAt, createdAt, updatedAt) values ('v-old', 'x', 'y', ?, '', '')",
      ).run(expired);
      yield* Effect.gen(function* () {
        const api = yield* BackendApi;
        yield* api.requestMagicLink(withCookie(undefined), { email: member });
      }).pipe(
        Effect.provide(TestBackend({ delivery: "inline", membersLayer: Members.layerWith(raw) })),
      );
      assert.strictEqual(db.prepare("select count(*) as n from session").get()?.n, 0);
      assert.strictEqual(db.prepare("select count(*) as n from verification").get()?.n, 0);
    }),
  );
});

describe("magic-link sign-in (mail delivery)", () => {
  it.live("a member is mailed the link and gets none back", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const { link } = decodeRequested(
        yield* api.requestMagicLink(withCookie(undefined), { email: member }),
      );
      assert.isTrue(Option.isNone(link));
      const [mail, ...rest] = yield* Ref.get(yield* SentMail);
      assert.deepStrictEqual(rest, []);
      assert.strictEqual(mail?.to, member);
      assert.include(mail?.text, `${ORIGIN}/api/auth/magic-link/verify?token=`);
    }).pipe(Effect.provide(TestBackend({ delivery: "mailed" }))),
  );
});
