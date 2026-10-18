import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Forbidden,
  MagicLinkInput,
  MagicLinkRequested,
  RequestInfo,
  TooManyRequests,
  Unauthorized,
} from "../contract/auth.ts";
import {
  AdminSession,
  AuthenticateAdminInput,
  NotAShopMember,
  ShopSnapshotInput,
} from "../contract/shop.ts";
import { ShoutInput } from "../contract/playground.ts";
import { ShopNotInstalled } from "../contract/fixture.ts";
import {
  DETAILS_PAGE_SIZE,
  INDEX_PAGE_SIZE,
  MemberDetailRequest,
  MembersPageRequest,
  TeamDetailRequest,
  TeamsPageRequest,
} from "../contract/members.ts";
import { ListOrdersRequest } from "../contract/orders.ts";
import { ShopActors } from "./shop-actors.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Members } from "./members.ts";
import { sessionFromCookie } from "./auth.ts";
import { SignInLimit } from "./resources.ts";
import { ShopAccess } from "./shop-access.ts";
import { ShopSessions } from "./shop-sessions.ts";
import { Shopify } from "./shopify.ts";

/**
 * The {@link SignInLimit} client. Yielding the binding attaches it to the Worker, so the layer
 * is built in the Worker's init.
 */
export class SignInLimiter extends Context.Service<SignInLimiter, Cloudflare.RateLimitClient>()(
  "app/SignInLimiter",
) {
  static readonly layer = Layer.effect(
    SignInLimiter,
    Effect.gen(function* () {
      return yield* SignInLimit;
    }),
  );

  /** A limiter that always answers `success`, for tests. */
  static readonly layerTest = (success: boolean) =>
    Layer.succeed(SignInLimiter, {
      raw: Effect.die("SignInLimiter has no raw binding off the Worker"),
      limit: () => Effect.succeed({ success }),
    });

  /**
   * A limiter that admits everyone. Under `alchemy dev` no client IP arrives, so every request
   * would share one key and a few sign-ins would lock everyone out.
   */
  static readonly layerOpen = SignInLimiter.layerTest(true);
}

/**
 * The arguments of each method, decoded again on arrival: the binding carries plain data, and a
 * server function that already validated it is the only caller, so a value that does not decode
 * is a defect.
 */
const decodeRequest = Schema.decodeUnknownEffect(RequestInfo);
const decodeShout = Schema.decodeUnknownEffect(ShoutInput);
const decodeMagicLinkInput = Schema.decodeUnknownEffect(MagicLinkInput);
const decodeSnapshotInput = Schema.decodeUnknownEffect(ShopSnapshotInput);
const decodeAuthenticateAdminInput = Schema.decodeUnknownEffect(AuthenticateAdminInput);
const decodeListOrdersRequest = Schema.decodeUnknownEffect(ListOrdersRequest);
const decodeMembersPageRequest = Schema.decodeUnknownEffect(MembersPageRequest);
const decodeMemberDetailRequest = Schema.decodeUnknownEffect(MemberDetailRequest);
const decodeTeamsPageRequest = Schema.decodeUnknownEffect(TeamsPageRequest);
const decodeTeamDetailRequest = Schema.decodeUnknownEffect(TeamDetailRequest);
const encodeAdminSession = Schema.encodeSync(AdminSession);
const encodeMagicLinkRequested = Schema.encodeSync(MagicLinkRequested);

const make = Effect.gen(function* () {
  const authService = yield* Auth;
  const { auth, maySignIn } = authService;
  const delivery = yield* MagicLinkDelivery;
  const members = yield* Members;
  const limiter = yield* SignInLimiter;
  const shopAccess = yield* ShopAccess;
  const actors = yield* ShopActors;
  const shopify = yield* Shopify;
  const shopSessions = yield* ShopSessions;

  /** The signed-in user and session from the request's cookie; see {@link sessionFromCookie}. */
  const session = (request: RequestInfo) =>
    decodeRequest(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ cookie }) => sessionFromCookie(cookie)),
      Effect.provideService(Auth, authService),
    );

  const hello = Effect.fn("BackendApi.hello")(function* (_request: RequestInfo) {
    yield* Effect.log("Backend.Hello"); // used to count calls in the dev log
    const now = yield* DateTime.now;
    return { message: "Hello from the backend Worker.", servedAt: DateTime.formatIso(now) };
  });

  const shout = Effect.fn("BackendApi.shout")(function* (
    _request: RequestInfo,
    payload: ShoutInput,
  ) {
    const { input } = yield* decodeShout(payload).pipe(Effect.orDie);
    yield* Effect.log("Backend.Shout");
    return { input, output: input.toUpperCase() };
  });

  /**
   * A non-member gets the same reply as a member, minus the link: the caller must not learn who
   * may sign in. A Better Auth failure stays a defect for the same reason. Better Auth requires
   * a `Headers` object here but reads none of it on this path: it skips its form CSRF check when
   * called without a request, and its own rate limit is off.
   */
  const requestMagicLink = Effect.fn("BackendApi.requestMagicLink")(function* (
    request: RequestInfo,
    payload: MagicLinkInput,
  ) {
    const { ip } = yield* decodeRequest(request).pipe(Effect.orDie);
    const { email, returnTo } = yield* decodeMagicLinkInput(payload).pipe(Effect.orDie);
    const { success } = yield* limiter.limit({ key: ip ?? "unknown" }).pipe(Effect.orDie);
    if (!success) return yield* new TooManyRequests();
    if (!(yield* maySignIn(email))) {
      yield* Effect.logInfo("sign-in requested for a non-member");
      return encodeMagicLinkRequested({ link: Option.none() });
    }
    yield* auth.api
      .signInMagicLink({
        body: { email, callbackURL: returnTo ?? "/shop", errorCallbackURL: "/sign-in" },
        headers: new Headers(),
      })
      .pipe(Effect.orDie);
    return encodeMagicLinkRequested({ link: yield* delivery.take(email) });
  });

  const me = Effect.fn("BackendApi.me")(function* (request: RequestInfo) {
    return (yield* session(request)).me;
  });

  const listMembers = Effect.fn("BackendApi.listMembers")(function* (request: RequestInfo) {
    const { me } = yield* session(request);
    return yield* Match.value(me.role).pipe(
      Match.when("admin", () => members.list()),
      Match.orElse(() => Effect.fail(new Forbidden())),
    );
  });

  /**
   * The shops the signed-in member has a `Member` row in, for the member's own list. An admin is
   * never a member, so it is Forbidden.
   */
  const myShops = Effect.fn("BackendApi.myShops")(function* (request: RequestInfo) {
    const { me } = yield* session(request);
    return yield* Match.value(me.role).pipe(
      Match.when("user", () => members.listShopsOf(me.email)),
      Match.orElse(() => Effect.fail(new Forbidden())),
    );
  });

  /**
   * The gate, then the actor's snapshot: the shop page's first data and who the socket will
   * say this browser is. The gate's refusal maps to the failure the page renders; an
   * unavailable gate is a defect.
   */
  const shopSnapshot = Effect.fn("BackendApi.shopSnapshot")(
    function* (request: RequestInfo, payload: ShopSnapshotInput) {
      const { cookie } = yield* decodeRequest(request).pipe(Effect.orDie);
      const { key, sessionToken } = yield* decodeSnapshotInput(payload).pipe(Effect.orDie);
      yield* Effect.log(`Backend.shopSnapshot: shop=${key}`); // used to count calls in the dev log
      const caller = yield* shopAccess.resolve({ key, cookie, sessionToken });
      const snapshot = yield* actors.snapshot(key);
      return { caller, snapshot };
    },
    Effect.catchTag("ShopAccessDenied", ({ status }) =>
      Match.value(status).pipe(
        Match.when(401, () => Effect.fail(new Unauthorized())),
        Match.when(403, () => Effect.fail(new Forbidden())),
        Match.when(404, () => Effect.fail(new NotAShopMember())),
        Match.when(503, () => Effect.die(new Error("the actor gate is unavailable"))),
        Match.exhaustive,
      ),
    ),
  );

  /**
   * The embedded App Home's admin: the session token is the credential, so the request is
   * ignored; see `Shopify.authenticateAdmin`.
   */
  const authenticateAdmin = Effect.fn("BackendApi.authenticateAdmin")(function* (
    _request: RequestInfo,
    payload: AuthenticateAdminInput,
  ) {
    const { sessionToken } = yield* decodeAuthenticateAdminInput(payload).pipe(Effect.orDie);
    return encodeAdminSession(yield* shopify.authenticateAdmin(sessionToken));
  });

  /**
   * The shop a merchant's screen read is for: the session token verified, never exchanged, as
   * on {@link listOrders}, and a shop with no `ShopSession` refused as {@link ShopNotInstalled}
   * before any `Members` read.
   */
  const installedShop = Effect.fn("BackendApi.installedShop")(function* (sessionToken: string) {
    const shop = yield* shopify.sessionTokenShop(sessionToken);
    if (Option.isNone(yield* shopSessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    return shop;
  });

  /**
   * The merchant's orders screen, its first render: one page of the shop's stored orders. The
   * session token names the shop and is only verified (`Shopify.sessionTokenShop`), never
   * exchanged: the App Home's guard exchanged it when the page loaded, and a call per screen
   * read must not cost a token exchange. The request is ignored, as on
   * {@link authenticateAdmin}. A shop with no `ShopSession` is {@link ShopNotInstalled} and its
   * actor is not touched, so a token outliving an uninstall never recreates it.
   */
  const listOrders = Effect.fn("BackendApi.listOrders")(function* (
    _request: RequestInfo,
    payload: ListOrdersRequest,
  ) {
    const { sessionToken, limit, cursor } = yield* decodeListOrdersRequest(payload).pipe(
      Effect.orDie,
    );
    const shop = yield* installedShop(sessionToken);
    return yield* actors.listOrders(shop, { limit, cursor });
  });

  /**
   * The members index's first render: one page of the shop's members, read from D1 here
   * without waking the actor, as legacy's loader read it in the Worker. The request is
   * ignored; the session token is the credential ({@link installedShop}).
   */
  const membersPage = Effect.fn("BackendApi.membersPage")(function* (
    _request: RequestInfo,
    payload: MembersPageRequest,
  ) {
    const { sessionToken, q, after } = yield* decodeMembersPageRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    return yield* members.listMembersPage({ shop, limit: INDEX_PAGE_SIZE, after, q });
  });

  /** The member page's first render, as {@link membersPage}; `null` is no such member. */
  const memberDetail = Effect.fn("BackendApi.memberDetail")(function* (
    _request: RequestInfo,
    payload: MemberDetailRequest,
  ) {
    const { sessionToken, memberId, teamsAfter } = yield* decodeMemberDetailRequest(payload).pipe(
      Effect.orDie,
    );
    const shop = yield* installedShop(sessionToken);
    return Option.getOrNull(
      yield* members.findMemberDetail({
        shop,
        id: memberId,
        teamsAfter,
        limit: DETAILS_PAGE_SIZE,
      }),
    );
  });

  /** The teams index's first render, as {@link membersPage}. */
  const teamsPage = Effect.fn("BackendApi.teamsPage")(function* (
    _request: RequestInfo,
    payload: TeamsPageRequest,
  ) {
    const { sessionToken, q, after } = yield* decodeTeamsPageRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    return yield* members.listTeamsPage({ shop, limit: INDEX_PAGE_SIZE, after, q });
  });

  /** The team page's first render, as {@link membersPage}; `null` is no such team. */
  const teamDetail = Effect.fn("BackendApi.teamDetail")(function* (
    _request: RequestInfo,
    payload: TeamDetailRequest,
  ) {
    const { sessionToken, teamId, membersAfter } = yield* decodeTeamDetailRequest(payload).pipe(
      Effect.orDie,
    );
    const shop = yield* installedShop(sessionToken);
    return Option.getOrNull(
      yield* members.findTeamDetail({
        shop,
        id: teamId,
        membersAfter,
        limit: DETAILS_PAGE_SIZE,
      }),
    );
  });

  return {
    hello,
    shout,
    requestMagicLink,
    me,
    listMembers,
    myShops,
    shopSnapshot,
    authenticateAdmin,
    listOrders,
    membersPage,
    memberDetail,
    teamsPage,
    teamDetail,
  };
});

/**
 * The Backend's methods for the Website, returned by the Worker beside `fetch` and called
 * schemaless over the service binding. Each takes the {@link RequestInfo} its server function
 * forwards first, and each that needs the visitor checks the session itself; nothing the
 * Website worked out about the visitor is trusted.
 *
 * The binding carries plain data only, so a method answers with JSON-plain values and the
 * server function uses them as typed; a schema whose type is not JSON-plain (an `Option`, a
 * `DateTime`) is encoded here and decoded in its server function, as `requestMagicLink` does
 * with {@link MagicLinkRequested}. A typed failure crosses as a plain `{ _tag, ...fields }`
 * object, which the server function decodes back into its class.
 */
export class BackendApi extends Context.Service<BackendApi, Effect.Success<typeof make>>()(
  "app/BackendApi",
) {
  static readonly layer = Layer.effect(BackendApi, make);
}
