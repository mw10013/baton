import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
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
  AdminShopRequest,
  PlanRefreshFailed,
  SHOP_SESSIONS_PAGE_SIZE,
  ShopSessionsPageRequest,
  type AdminShopData,
  type ShopSessionsPageData,
} from "../contract/admin.ts";
import { AdminAuthenticated, HomePlan, PaymentRequired, PlanRequest } from "../contract/billing.ts";
import { AuthenticateAdminInput, NotAShopMember, ShopAccessInput } from "../contract/shop.ts";
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
import { ListOrdersRequest, OrderDetailRequest } from "../contract/orders.ts";
import {
  MemberWorkflowPageRequest,
  type MemberWorkflowPageData,
  WorkflowsListRequest,
  type WorkflowsListPageData,
} from "../contract/workflows-list.ts";
import {
  SetupFactsRequest,
  WORKFLOWS_PAGE_SIZE,
  WorkflowDetailRequest,
  WorkflowsPageRequest,
} from "../contract/workflows.ts";
import { adminShopEntitlements, adminShopPlanCache } from "../domain/billing.ts";
import { Email, userIsAdmin } from "../domain/platform.ts";
import { MemberId, type RunQuery, type SetupFacts, TeamId } from "../domain/shop-work.ts";
import { ShopActors } from "./shop-actors.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { sessionFromCookie } from "./auth.ts";
import { SignInLimit } from "./resources.ts";
import { ShopAccess } from "./shop-access.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import { Shopify } from "./shopify.ts";
import { planSelectionExitIframeHref, ShopifyPartner } from "./shopify-partner.ts";
import { resolveEntitlements, SubscriptionPlan } from "./subscription-plan.ts";

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
const decodeAccessInput = Schema.decodeUnknownEffect(ShopAccessInput);
const decodeAuthenticateAdminInput = Schema.decodeUnknownEffect(AuthenticateAdminInput);
const decodeListOrdersRequest = Schema.decodeUnknownEffect(ListOrdersRequest);
const decodeMembersPageRequest = Schema.decodeUnknownEffect(MembersPageRequest);
const decodeMemberDetailRequest = Schema.decodeUnknownEffect(MemberDetailRequest);
const decodeTeamsPageRequest = Schema.decodeUnknownEffect(TeamsPageRequest);
const decodeTeamDetailRequest = Schema.decodeUnknownEffect(TeamDetailRequest);
const decodeWorkflowsPageRequest = Schema.decodeUnknownEffect(WorkflowsPageRequest);
const decodeWorkflowDetailRequest = Schema.decodeUnknownEffect(WorkflowDetailRequest);
const decodeSetupFactsRequest = Schema.decodeUnknownEffect(SetupFactsRequest);
const decodeOrderDetailRequest = Schema.decodeUnknownEffect(OrderDetailRequest);
const decodeWorkflowsListRequest = Schema.decodeUnknownEffect(WorkflowsListRequest);
const decodeMemberWorkflowPageRequest = Schema.decodeUnknownEffect(MemberWorkflowPageRequest);
/** The gate's member as the actor's run reads take them; the caller's fields cross unbranded. */
const decodeMemberIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ memberId: MemberId, memberEmail: Email, teamIds: Schema.Array(TeamId) }),
);
const encodeAdminAuthenticated = Schema.encodeSync(AdminAuthenticated);
const encodeHomePlan = Schema.encodeSync(HomePlan);
const decodePlanRequest = Schema.decodeUnknownEffect(PlanRequest);
const encodeMagicLinkRequested = Schema.encodeSync(MagicLinkRequested);
const decodeShopSessionsPageRequest = Schema.decodeUnknownEffect(ShopSessionsPageRequest);
const decodeAdminShopRequest = Schema.decodeUnknownEffect(AdminShopRequest);

const make = Effect.gen(function* () {
  const authService = yield* Auth;
  const { auth, maySignIn } = authService;
  const delivery = yield* MagicLinkDelivery;
  const members = yield* MembershipRepository;
  const limiter = yield* SignInLimiter;
  const gate = yield* ShopAccess;
  const actors = yield* ShopActors;
  const shopify = yield* Shopify;
  const shopSessions = yield* ShopSessionRepository;
  const plans = yield* SubscriptionPlan;
  const shopifyPartner = yield* ShopifyPartner;

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
        body: { email, callbackURL: returnTo ?? "/login-callback", errorCallbackURL: "/sign-in" },
        headers: new Headers(),
      })
      .pipe(Effect.orDie);
    return encodeMagicLinkRequested({ link: yield* delivery.take(email) });
  });

  const me = Effect.fn("BackendApi.me")(function* (request: RequestInfo) {
    return (yield* session(request)).me;
  });

  /**
   * The signed-in admin, or why not: `Unauthorized` signed out, `Forbidden` for anyone else. Every
   * admin method starts here, so none trusts the Website's own guard.
   */
  const requireAdmin = Effect.fn("BackendApi.requireAdmin")(function* (request: RequestInfo) {
    const { me } = yield* session(request);
    if (!userIsAdmin(me)) return yield* new Forbidden();
    return me;
  });

  const listMembers = Effect.fn("BackendApi.listMembers")(function* (request: RequestInfo) {
    yield* requireAdmin(request);
    return yield* members.list();
  });

  /** The admin console's Shops list: one page of redacted `ShopSession` rows and the read's time. */
  const shopSessionsPage = Effect.fn("BackendApi.shopSessionsPage")(function* (
    request: RequestInfo,
    payload: ShopSessionsPageRequest,
  ) {
    yield* requireAdmin(request);
    const input = yield* decodeShopSessionsPageRequest(payload).pipe(Effect.orDie);
    const page = yield* shopSessions.getRedactedPage({ ...input, limit: SHOP_SESSIONS_PAGE_SIZE });
    const data: ShopSessionsPageData = { page, now: yield* Clock.currentTimeMillis };
    return data;
  });

  /**
   * The admin console's shop page in one call: the shop's redacted `ShopSession` row, the plan
   * cached on it, the actor's usage and the D1 member count.
   *
   * The D1 read is not incidental: every ceiling shown derives from the plan, which only D1
   * knows, and the actor deliberately stores no limits. It is the same join the App Home makes,
   * one shop over.
   *
   * A missing row is the honest answer for an uninstalled shop, since uninstall deletes it, and
   * it is answered *before* the usage read, so viewing an arbitrary path cannot create an empty
   * actor (`getByName` creates the object it names).
   *
   * The plan is decoded from the row, never resolved: `SubscriptionPlan.resolve` calls the
   * Partner API and rewrites D1 on a miss, which would make viewing the page mutate the shop it
   * reports on. {@link refreshPlan} is how an admin asks for that, deliberately.
   */
  const adminShop = Effect.fn("BackendApi.adminShop")(function* (
    request: RequestInfo,
    payload: AdminShopRequest,
  ) {
    yield* requireAdmin(request);
    const { shop } = yield* decodeAdminShopRequest(payload).pipe(Effect.orDie);
    const shopSession = yield* shopSessions.findRedacted(shop);
    if (Option.isNone(shopSession)) {
      const notFound: AdminShopData = { _tag: "NotFound" };
      return notFound;
    }
    const plan = adminShopPlanCache(shopSession.value, yield* Clock.currentTimeMillis);
    const { usage, memberCount } = yield* Effect.all(
      { usage: actors.getUsage(shop), memberCount: members.countMembers(shop) },
      { concurrency: "unbounded" },
    );
    const found: AdminShopData = {
      _tag: "Found",
      shopSession: shopSession.value,
      plan,
      entitlements: adminShopEntitlements(plan),
      usage,
      memberCount,
    };
    return found;
  });

  /**
   * Refresh plan: one Partner API read that rewrites the shop's cached plan entry
   * (`SubscriptionPlan.refresh`).
   *
   * A method of its own, reached only by the shop page's POST, never by a loader: it is the only
   * write on the page, and it changes what the enforcement path decides for a live shop (a
   * changed handle revokes every socket of the shop). It exists because a cache that disagrees
   * with Shopify is otherwise uncorrectable before its deadline, the exact situation an admin is
   * in when a merchant reports an upgrade or a payment that did not take effect.
   *
   * Both outcomes are success: no app subscription writes a null handle under a fresh deadline,
   * the verified-absence state, not a failure. Only a read that failed is {@link PlanRefreshFailed}.
   */
  const refreshPlan = Effect.fn("BackendApi.refreshPlan")(function* (
    request: RequestInfo,
    payload: AdminShopRequest,
  ) {
    yield* requireAdmin(request);
    const { shop } = yield* decodeAdminShopRequest(payload).pipe(Effect.orDie);
    yield* plans
      .refresh(shop)
      .pipe(
        Effect.catchTag("SubscriptionPlanError", ({ message }) =>
          Effect.logWarning(`refreshPlan: shop=${shop}: ${message}`).pipe(
            Effect.annotateLogs({ shop }),
            Effect.andThen(Effect.fail(new PlanRefreshFailed({ message }))),
          ),
        ),
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
   * The gate alone, for a shop layout's loader: who the socket will say this browser is, or why
   * not. The gate's refusal maps to the failure the layout renders; an unavailable gate is a
   * defect. No actor call: each page under the layout reads its own data.
   */
  const shopAccess = Effect.fn("BackendApi.shopAccess")(
    function* (request: RequestInfo, payload: ShopAccessInput) {
      const { cookie } = yield* decodeRequest(request).pipe(Effect.orDie);
      const { key, sessionToken } = yield* decodeAccessInput(payload).pipe(Effect.orDie);
      yield* Effect.log(`Backend.shopAccess: shop=${key}`); // used to count calls in the dev log
      return yield* gate.resolve({ key, cookie, sessionToken });
    },
    Effect.catchTag("ShopAccessDenied", ({ status }) =>
      Match.value(status).pipe(
        Match.when(401, () => Effect.fail(new Unauthorized())),
        Match.when(402, () => Effect.fail(new PaymentRequired())),
        Match.when(403, () => Effect.fail(new Forbidden())),
        Match.when(404, () => Effect.fail(new NotAShopMember())),
        Match.when(503, () => Effect.die(new Error("the actor gate is unavailable"))),
        Match.exhaustive,
      ),
    ),
  );

  /**
   * The embedded App Home's admin and its plan: the session token is the credential, so the
   * request is ignored; see `Shopify.authenticateAdmin`. After authenticating, the plan is
   * re-read when `billingRedirect` says Shopify's billing redirect brought the merchant back
   * (`SubscriptionPlan.refresh`), and resolved otherwise. `Subscribed` carries the Manage plan
   * URL and nothing about the plan; `Unsubscribed` carries the plan selection href. A plan that
   * could not be read fails the call (a defect, the error page), never `Unsubscribed`.
   */
  const authenticateAdmin = Effect.fn("BackendApi.authenticateAdmin")(function* (
    _request: RequestInfo,
    payload: AuthenticateAdminInput,
  ) {
    const { sessionToken, billingRedirect } = yield* decodeAuthenticateAdminInput(payload).pipe(
      Effect.orDie,
    );
    const admin = yield* shopify.authenticateAdmin(sessionToken);
    const status = yield* (
      billingRedirect ? plans.refresh(admin.shop) : plans.resolve(admin.shop)
    ).pipe(Effect.orDie);
    const planSelectionUrl = shopifyPartner.planSelectionUrl(admin.shop);
    const answer: AdminAuthenticated = Match.value(status).pipe(
      Match.tagsExhaustive({
        Subscribed: () => ({
          _tag: "Subscribed" as const,
          ...admin,
          managePlanUrl: planSelectionUrl,
        }),
        Unsubscribed: () => ({
          _tag: "Unsubscribed" as const,
          href: planSelectionExitIframeHref(planSelectionUrl, admin.shop),
        }),
      }),
    );
    return encodeAdminAuthenticated(answer);
  });

  /**
   * The home page's **Your plan**, its first render: the plan resolved again (legacy's
   * `resolveEntitlements`, a separate request from `/app`'s gate), the actor's usage and the D1
   * member count. The plan is compared on the screen through its included numbers and never
   * named. A plan that could not be read is a defect.
   */
  const homePlan = Effect.fn("BackendApi.homePlan")(function* (
    _request: RequestInfo,
    payload: PlanRequest,
  ) {
    const { sessionToken } = yield* decodePlanRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    const answer: HomePlan = yield* resolveEntitlements(shop).pipe(
      Effect.flatMap((entitlements) =>
        Effect.all(
          { usage: actors.getUsage(shop), memberCount: members.countMembers(shop) },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(({ usage, memberCount }) => ({
            _tag: "Subscribed" as const,
            entitlements,
            usage,
            memberCount,
          })),
        ),
      ),
      Effect.catchTag("PlanUnsubscribed", ({ href }) =>
        Effect.succeed({ _tag: "Unsubscribed" as const, href }),
      ),
      Effect.catchTag("SubscriptionPlanError", Effect.die),
      Effect.provideService(SubscriptionPlan, plans),
      Effect.provideService(ShopifyPartner, shopifyPartner),
    );
    return encodeHomePlan(answer);
  });

  /**
   * The orders index's usage, its first render: the actor's `ShopUsage` (the order ceiling's
   * flag is what the page shows). A separate read from `listOrders`, so the home page, which
   * shares that read, does not read usage twice.
   */
  const usage = Effect.fn("BackendApi.usage")(function* (
    _request: RequestInfo,
    payload: PlanRequest,
  ) {
    const { sessionToken } = yield* decodePlanRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    return yield* actors.getUsage(shop);
  });

  /**
   * Manage plan's press: `SubscriptionPlan.expectChange` (the plan deadline pulled to minutes,
   * then the usage queue sent). Its failure is a defect; the button opens the pricing page
   * either way.
   */
  const expectPlanChange = Effect.fn("BackendApi.expectPlanChange")(function* (
    _request: RequestInfo,
    payload: PlanRequest,
  ) {
    const { sessionToken } = yield* decodePlanRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    yield* plans.expectChange(shop).pipe(Effect.orDie);
  });

  /**
   * The shop a merchant's screen read is for: the session token verified, never exchanged, as
   * on {@link listOrders}, and a shop with no `ShopSession` refused as {@link ShopNotInstalled}
   * before any `MembershipRepository` read.
   */
  const installedShop = Effect.fn("BackendApi.installedShop")(function* (sessionToken: string) {
    const shop = yield* shopify.sessionTokenShop(sessionToken);
    if (Option.isNone(yield* shopSessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    return shop;
  });

  /**
   * The orders index, its first render: one page of the shop's orders with their run facts,
   * counts and sync state (`OrdersIndexData`). The
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
    const { sessionToken, ...input } = yield* decodeListOrdersRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    return yield* actors.listOrders(shop, input);
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

  /**
   * The workflows index's first render: one page of the shop's workflows, read in the actor
   * (definitions live there) with its live teams. The request is ignored; the session token is
   * the credential ({@link installedShop}), and a shop with no `ShopSession` never wakes its actor.
   */
  const workflowsPage = Effect.fn("BackendApi.workflowsPage")(function* (
    _request: RequestInfo,
    payload: WorkflowsPageRequest,
  ) {
    const { sessionToken, state, q, after } = yield* decodeWorkflowsPageRequest(payload).pipe(
      Effect.orDie,
    );
    const shop = yield* installedShop(sessionToken);
    return yield* actors.listWorkflows(shop, {
      limit: WORKFLOWS_PAGE_SIZE,
      cursor: after,
      q,
      state,
    });
  });

  /** The workflow page's and the editor's first render, as {@link workflowsPage}; `null` is no such workflow. */
  const workflowDetail = Effect.fn("BackendApi.workflowDetail")(function* (
    _request: RequestInfo,
    payload: WorkflowDetailRequest,
  ) {
    const { sessionToken, workflowId } = yield* decodeWorkflowDetailRequest(payload).pipe(
      Effect.orDie,
    );
    const shop = yield* installedShop(sessionToken);
    return yield* actors.getWorkflowDetail(shop, { workflowId });
  });

  /**
   * The App Home's setup guide: D1's half (a team with a member) and the actor's (an active
   * workflow, a run) read together, as legacy's loader did in one `Effect.all`. Never live: the
   * guide is loader data. The request is ignored, as on {@link workflowsPage}.
   */
  const setupFacts = Effect.fn("BackendApi.setupFacts")(function* (
    _request: RequestInfo,
    payload: SetupFactsRequest,
  ) {
    const { sessionToken } = yield* decodeSetupFactsRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    const [teamWithMember, workflowFacts] = yield* Effect.all(
      [members.teamWithMemberExists(shop), actors.workflowSetupFacts(shop)],
      { concurrency: "unbounded" },
    );
    const facts: SetupFacts = { teamWithMember, ...workflowFacts };
    return facts;
  });

  /**
   * The order page, its first render: the order with its items, runs, matched and other
   * workflows and the shop's teams (`OrderPageData`), or null when the order is not stored.
   * The token is only verified, as on {@link listOrders}, and a shop with no `ShopSession` is
   * {@link ShopNotInstalled} with no actor call.
   */
  const orderDetail = Effect.fn("BackendApi.orderDetail")(function* (
    _request: RequestInfo,
    payload: OrderDetailRequest,
  ) {
    const { sessionToken, legacyId } = yield* decodeOrderDetailRequest(payload).pipe(Effect.orDie);
    const shop = yield* installedShop(sessionToken);
    return yield* actors.getOrderDetail(shop, { legacyId });
  });

  /**
   * The member gate for the member screens' loaders (`ShopAccess.resolveMember`): the member and
   * their teams, decoded once for the actor's run reads. Refusals as {@link shopAccess}'s:
   * 401 is `Unauthorized`, 403 `Forbidden`, 404 `NotAShopMember`, and an unavailable gate is a
   * defect; each before any actor call.
   */
  const memberOf = Effect.fn("BackendApi.memberOf")(
    function* (request: RequestInfo, key: WorkflowsListRequest["key"]) {
      const { cookie } = yield* decodeRequest(request).pipe(Effect.orDie);
      const { caller, teams } = yield* gate.resolveMember({ key, cookie });
      const identity = yield* decodeMemberIdentity(caller).pipe(Effect.orDie);
      return { ...identity, teams };
    },
    Effect.catchTag("ShopAccessDenied", ({ status }) =>
      Match.value(status).pipe(
        Match.when(401, () => Effect.fail(new Unauthorized())),
        Match.when(402, () => Effect.fail(new PaymentRequired())),
        Match.when(403, () => Effect.fail(new Forbidden())),
        Match.when(404, () => Effect.fail(new NotAShopMember())),
        Match.when(503, () => Effect.die(new Error("the actor gate is unavailable"))),
        Match.exhaustive,
      ),
    ),
  );

  /**
   * The workflows list, its first render. `team` is the URL's text, resolved against the
   * member's teams: a team the member is not on reads as any team rather than an empty list.
   * The query as resolved comes back beside the list, so its rows seed the socket query of
   * exactly that query.
   */
  const workflowsList = Effect.fn("BackendApi.workflowsList")(function* (
    request: RequestInfo,
    payload: WorkflowsListRequest,
  ) {
    const { key, state, team, limit, q } = yield* decodeWorkflowsListRequest(payload).pipe(
      Effect.orDie,
    );
    const { memberId, memberEmail, teamIds, teams } = yield* memberOf(request, key);
    const query: RunQuery = {
      team: teams.find((candidate) => candidate.id === team)?.id ?? null,
      state,
      limit,
      q,
    };
    const list = yield* actors.listRuns(key, { teamIds, memberEmail, query });
    const data: WorkflowsListPageData = { memberId, memberEmail, teams, query, list };
    return data;
  });

  /**
   * The member's workflow page, its first render: `page` is null for a run that is not there or
   * holds no task of the member's teams, one answer for both.
   */
  const memberWorkflowPage = Effect.fn("BackendApi.memberWorkflowPage")(function* (
    request: RequestInfo,
    payload: MemberWorkflowPageRequest,
  ) {
    const { key, runId } = yield* decodeMemberWorkflowPageRequest(payload).pipe(Effect.orDie);
    const { memberId, memberEmail, teamIds, teams } = yield* memberOf(request, key);
    const page = yield* actors.getRunPage(key, { runId, teamIds });
    const data: MemberWorkflowPageData = { memberId, memberEmail, teams, page };
    return data;
  });

  return {
    hello,
    shout,
    requestMagicLink,
    me,
    listMembers,
    shopSessionsPage,
    adminShop,
    refreshPlan,
    myShops,
    shopAccess,
    authenticateAdmin,
    homePlan,
    usage,
    expectPlanChange,
    listOrders,
    orderDetail,
    workflowsList,
    memberWorkflowPage,
    membersPage,
    memberDetail,
    teamsPage,
    teamDetail,
    workflowsPage,
    workflowDetail,
    setupFacts,
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
