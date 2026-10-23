/**
 * What only integ may do, served by the test Backend on `/api/integ`: the contract and its
 * handlers together, because nothing in `src/` may import either.
 *
 * @module
 */
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { Email, Forbidden, ReturnPath, Unauthorized } from "../../src/contract/auth.ts";
import { Auth } from "../../src/backend/auth.ts";
import { MagicLinkDelivery } from "../../src/backend/magic-link-delivery.ts";
import { MembershipRepository } from "../../src/backend/membership-repository.ts";
import { InvalidSessionToken, NotAShopMember } from "../../src/contract/shop.ts";
import { ShopGid, ShopKey } from "../../src/domain/platform.ts";
import {
  MemberWorkflowPageData,
  MemberWorkflowPageRequest,
  WorkflowsListPageData,
  WorkflowsListRequest,
} from "../../src/contract/workflows-list.ts";
import { ListOrdersRequest, OrderDetailRequest } from "../../src/contract/orders.ts";
import { takeRowCounts } from "../../src/backend/row-counts.ts";
import {
  SetupFactsRequest,
  WorkflowDetailRequest,
  WorkflowsPageRequest,
} from "../../src/contract/workflows.ts";
import {
  GetOrderDetailInput,
  ListOrdersInput,
  ListRunsInput,
  OrderPageData,
  OrdersIndexData,
  WorkflowsListData,
  SetupFacts,
  WorkflowPageData,
  WorkflowsIndexData,
} from "../../src/domain/shop-work.ts";
import { BackendApi } from "../../src/backend/api.ts";
import { ShopUsage, UsageEvent } from "../../src/domain/billing.ts";
import { OrderDetail } from "../../src/domain/orders.ts";
import { ShopNotInstalled } from "../../src/contract/fixture.ts";
import { ShopActors } from "../../src/backend/shop-actors.ts";
import { AppEventsFake } from "./app-events-fake.ts";
import { PartnerAnswer, PartnerFake } from "./partner-fake.ts";
import { HomePlan, PaymentRequired, PlanRequest } from "../../src/contract/billing.ts";
import { ShopSessionRepository } from "../../src/backend/shop-session-repository.ts";
import { revalidateStalePlans, SubscriptionPlan } from "../../src/backend/subscription-plan.ts";
import { ShopifyFake } from "./shopify-fake.ts";
import { SEED_SHOP } from "../seed-shops.ts";

/**
 * One scripted answer of the fake Shopify HTTP layer: which endpoint it answers, and how. A
 * `bulk` reply's `body` is a bulk result file, a string of JSONL.
 */
export const ShopifyFakeReply = Schema.Struct({
  route: Schema.Literals(["token", "graphql", "bulk"]),
  status: Schema.Int,
  body: Schema.Unknown,
});
export type ShopifyFakeReply = typeof ShopifyFakeReply.Type;

/**
 * One call the fake Shopify HTTP layer served. `refreshToken` is a stable label for the refresh
 * token a `refresh_token` grant presented (`refresh-1` for the first distinct token it saw), never
 * the token, so the same label twice means a retry with the same token.
 */
export const ShopifyFakeCall = Schema.Struct({
  route: Schema.Literals(["token", "graphql", "bulk"]),
  grantType: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
});
export type ShopifyFakeCall = typeof ShopifyFakeCall.Type;

/** One statement's rows, as `takeRowCounts` tallies them. */
const StatementCounts = Schema.Struct({
  sql: Schema.String,
  runs: Schema.Number,
  rowsRead: Schema.Number,
  rowsWritten: Schema.Number,
  rowsReturned: Schema.Number,
});

/** One database's rows, as `takeRowCounts` tallies them. */
export const RowCounts = Schema.Struct({
  runs: Schema.Number,
  rowsRead: Schema.Number,
  rowsWritten: Schema.Number,
  rowsReturned: Schema.Number,
  unmetered: Schema.Number,
  statements: Schema.Array(StatementCounts),
});
export type RowCounts = typeof RowCounts.Type;

/**
 * The integ procedures.
 *
 * - `IssueMagicLink` is `BackendApi.requestMagicLink` without the rate limit or the non-member
 *   silence, handing the link back, because integ has no page to read it from; an address that
 *   could not sign in, or a stage that mails its links, is a defect.
 * - `ScriptShopify` replaces {@link ShopifyFake}'s queued replies (a reply per call to its token
 *   or GraphQL endpoint, in order; an empty queue answers with defaults) and clears its call log;
 *   `ShopifyCalls` answers the calls it served since, as {@link ShopifyFakeCall}, and clears them.
 * - `GetOrder` and `ListOrders` are the {@link ShopActors} methods of the same names on `shop`'s
 *   actor, as the Backend calls them. A test arranges an order the way production gets one: a
 *   signed `orders/*` webhook with the order scripted into {@link ShopifyFake}.
 * - `SyncFailed` is the {@link ShopActors} method `onOrdersSyncError` on `shop`'s actor: a sync's
 *   end as a late caller reports it.
 * - `ApiListOrders` is the `BackendApi` method the orders screen's loader calls, with an empty
 *   request, because integ has no Website to call it over the binding.
 * - `ApiWorkflowsPage`, `ApiWorkflowDetail` and `ApiSetupFacts` are the `BackendApi` methods the
 *   workflows screens' and the App Home's loaders call, as `ApiListOrders`; `ApiOrderDetail` is
 *   the order page's, the same way.
 * - `ApiWorkflowsList` and `ApiMemberWorkflowPage` are the `BackendApi` methods the member
 *   screens' loaders call. Their payload carries the member's session `cookie`, which the
 *   request would carry, because the test Backend has no request to read it from.
 * - `ScriptPartner` sets {@link PartnerFake}'s answer for `shop` (its `ShopSession`'s GID) and makes
 *   the shop's cached plan stale, keeping its handle, so the next gate, `/app` load or
 *   `RevalidateStalePlans` re-reads it as a real expiry would. A shop with no row is a defect.
 * - `RevalidateStalePlans` runs the daily cron's body (`revalidateStalePlans`) and answers its counts.
 * - `ApiHomePlan` and `ApiUsage` are the home page's and the orders index's `BackendApi` reads, as
 *   `ApiListOrders`.
 * - `AppEventsSent` answers the usage events {@link AppEventsFake} accepted since the last call,
 *   oldest first, and clears them: what the actor's flush sent to App Events. `refuse` sets
 *   whether the fake refuses every send from then on.
 * - `ShopIdentityNames` answers the emails of `shop`'s `Member` rows and the names of its `Team`
 *   rows, read from D1 alone ({@link MembershipRepository}' `identityNames`), so it never reaches the actor.
 * - `TakeRowCounts` answers the rows read and written since the last take, per database and per
 *   statement, and starts new tallies (`takeRowCounts`). The rows-read probe brackets each path
 *   with it; the other procedures here are the paths it measures that no other procedure reaches:
 *   `GetOrderDetail`, `ListRuns`, `GetUsage` and `OrdersStream` are the {@link ShopActors}
 *   methods (`OrdersStream` is `onOrdersStream`, the bulk sync's last step), and `ListShopsOf`
 *   and `SweepExpiredAuth` (the daily cron's sweep) the {@link MembershipRepository} methods.
 *   `EvictActor` ends `shop`'s actor's activation and keeps its storage (`ShopActors.evict`), so
 *   the probe's next call runs in a fresh activation, as after a hibernation.
 * - `SetShopSession` gives `shop` a `ShopSession` row, a copy of the seed shop's, or deletes it
 *   (`present: false`) and leaves the shop's actor alone, as an uninstall does in between its
 *   delete and its destroy.
 */
export const IntegRpcs = RpcGroup.make(
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
  Rpc.make("ScriptShopify", {
    payload: { replies: Schema.Array(ShopifyFakeReply) },
    success: Schema.Struct({}),
  }),
  Rpc.make("ShopifyCalls", {
    payload: {},
    success: Schema.Array(ShopifyFakeCall),
  }),
  Rpc.make("GetOrder", {
    payload: { shop: ShopKey, orderId: Schema.String },
    success: Schema.NullOr(OrderDetail),
  }),
  Rpc.make("ListOrders", {
    payload: { shop: ShopKey, ...ListOrdersInput.fields },
    success: OrdersIndexData,
  }),
  Rpc.make("SyncFailed", {
    payload: { shop: ShopKey, workflowId: Schema.String, message: Schema.String },
    success: Schema.Struct({}),
  }),
  Rpc.make("ApiListOrders", {
    payload: ListOrdersRequest,
    success: OrdersIndexData,
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiWorkflowsPage", {
    payload: WorkflowsPageRequest,
    success: WorkflowsIndexData,
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiWorkflowDetail", {
    payload: WorkflowDetailRequest,
    success: Schema.NullOr(WorkflowPageData),
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiSetupFacts", {
    payload: SetupFactsRequest,
    success: SetupFacts,
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiOrderDetail", {
    payload: OrderDetailRequest,
    success: Schema.NullOr(OrderPageData),
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiWorkflowsList", {
    payload: { cookie: Schema.String, ...WorkflowsListRequest.fields },
    success: WorkflowsListPageData,
    error: Schema.Union([Unauthorized, PaymentRequired, Forbidden, NotAShopMember]),
  }),
  Rpc.make("ApiMemberWorkflowPage", {
    payload: { cookie: Schema.String, ...MemberWorkflowPageRequest.fields },
    success: MemberWorkflowPageData,
    error: Schema.Union([Unauthorized, PaymentRequired, Forbidden, NotAShopMember]),
  }),
  Rpc.make("ScriptPartner", {
    payload: { shop: ShopKey, answer: PartnerAnswer },
    success: Schema.Struct({}),
  }),
  Rpc.make("RevalidateStalePlans", {
    payload: {},
    success: Schema.Struct({ shops: Schema.Number, failed: Schema.Number }),
  }),
  Rpc.make("ApiHomePlan", {
    payload: PlanRequest,
    success: HomePlan,
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("ApiUsage", {
    payload: PlanRequest,
    success: ShopUsage,
    error: Schema.Union([InvalidSessionToken, ShopNotInstalled]),
  }),
  Rpc.make("AppEventsSent", {
    payload: { refuse: Schema.optional(Schema.Boolean) },
    success: Schema.Array(UsageEvent),
  }),
  Rpc.make("ShopIdentityNames", {
    payload: { shop: ShopKey },
    success: Schema.Struct({ emails: Schema.Array(Email), teams: Schema.Array(Schema.String) }),
  }),
  Rpc.make("TakeRowCounts", {
    payload: {},
    success: Schema.Struct({ actor: RowCounts, d1: RowCounts }),
  }),
  Rpc.make("GetOrderDetail", {
    payload: { shop: ShopKey, ...GetOrderDetailInput.fields },
    success: Schema.NullOr(OrderPageData),
  }),
  Rpc.make("ListRuns", {
    payload: { shop: ShopKey, ...ListRunsInput.fields },
    success: WorkflowsListData,
  }),
  Rpc.make("GetUsage", { payload: { shop: ShopKey }, success: ShopUsage }),
  Rpc.make("OrdersStream", {
    payload: { shop: ShopKey, workflowId: Schema.String, url: Schema.String },
    success: Schema.Struct({}),
  }),
  Rpc.make("ListShopsOf", { payload: { email: Email }, success: Schema.Array(ShopKey) }),
  Rpc.make("SweepExpiredAuth", { payload: {}, success: Schema.Struct({}) }),
  Rpc.make("EvictActor", { payload: { shop: ShopKey }, success: Schema.Struct({}) }),
  Rpc.make("SetShopSession", {
    payload: { shop: ShopKey, present: Schema.Boolean },
    success: Schema.Struct({}),
  }),
);

const decodeHomePlan = Schema.decodeUnknownSync(HomePlan);

export const IntegHandlers = IntegRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const shopifyFake = yield* ShopifyFake;
    const appEventsFake = yield* AppEventsFake;
    const partnerFake = yield* PartnerFake;
    const shopSessions = yield* ShopSessionRepository;
    const plans = yield* SubscriptionPlan;
    const actors = yield* ShopActors;
    const members = yield* MembershipRepository;
    const api = yield* BackendApi;
    const noRequest = { cookie: undefined, ip: undefined };

    return IntegRpcs.of({
      IssueMagicLink: ({ email, returnTo }, { headers }) =>
        Effect.gen(function* () {
          if (!(yield* maySignIn(email)))
            return yield* Effect.die(new Error(`${email} is neither a user nor a member`));
          yield* auth.api
            .signInMagicLink({
              body: {
                email,
                callbackURL: returnTo ?? "/login-callback",
                errorCallbackURL: "/sign-in",
              },
              headers: new Headers(headers),
            })
            .pipe(Effect.orDie);
          const link = yield* delivery.take(email);
          if (Option.isNone(link))
            return yield* Effect.die(new Error(`no link for ${email}: the stage mails its links`));
          return { link: link.value };
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      ScriptShopify: ({ replies }) => shopifyFake.script(replies).pipe(Effect.as({})),
      ShopifyCalls: () => shopifyFake.takeCalls,
      GetOrder: ({ shop, orderId }) => actors.getOrder(shop, orderId),
      ListOrders: ({ shop, ...input }) => actors.listOrders(shop, input),
      SyncFailed: ({ shop, ...input }) => actors.onOrdersSyncError(shop, input).pipe(Effect.as({})),
      ApiListOrders: (payload) => api.listOrders(noRequest, payload),
      ApiWorkflowsPage: (payload) => api.workflowsPage(noRequest, payload),
      ApiWorkflowDetail: (payload) => api.workflowDetail(noRequest, payload),
      ApiSetupFacts: (payload) => api.setupFacts(noRequest, payload),
      ApiOrderDetail: (payload) => api.orderDetail(noRequest, payload),
      ApiWorkflowsList: ({ cookie, ...payload }) =>
        api.workflowsList({ cookie, ip: undefined }, payload),
      ApiMemberWorkflowPage: ({ cookie, ...payload }) =>
        api.memberWorkflowPage({ cookie, ip: undefined }, payload),
      ScriptPartner: ({ shop, answer }) =>
        Effect.gen(function* () {
          const row = yield* shopSessions.find(shop);
          if (Option.isNone(row)) return yield* Effect.die(new Error(`no ShopSession for ${shop}`));
          yield* partnerFake.script(row.value.shopGid, answer);
          yield* shopSessions.updatePlan({
            shop,
            planHandle: row.value.planHandle,
            planHandleExpiresAt: 0,
            planBoundaryAt: row.value.planBoundaryAt,
          });
          return {};
        }),
      RevalidateStalePlans: () =>
        revalidateStalePlans().pipe(
          Effect.provideService(ShopSessionRepository, shopSessions),
          Effect.provideService(SubscriptionPlan, plans),
        ),
      ApiHomePlan: (payload) => api.homePlan(noRequest, payload).pipe(Effect.map(decodeHomePlan)),
      ApiUsage: (payload) => api.usage(noRequest, payload),
      AppEventsSent: ({ refuse }) => appEventsFake.takeSent(refuse),
      ShopIdentityNames: ({ shop }) => members.identityNames(shop),
      TakeRowCounts: () => Effect.sync(takeRowCounts),
      GetOrderDetail: ({ shop, ...input }) => actors.getOrderDetail(shop, input),
      ListRuns: ({ shop, ...input }) => actors.listRuns(shop, input),
      GetUsage: ({ shop }) => actors.getUsage(shop),
      OrdersStream: ({ shop, ...input }) => actors.onOrdersStream(shop, input).pipe(Effect.as({})),
      ListShopsOf: ({ email }) => members.listShopsOf(email),
      SweepExpiredAuth: () => members.sweepExpiredAuth().pipe(Effect.as({})),
      EvictActor: ({ shop }) => actors.evict(shop).pipe(Effect.as({})),
      SetShopSession: ({ shop, present }) =>
        Effect.gen(function* () {
          if (!present) return yield* shopSessions.remove(shop).pipe(Effect.as({}));
          const seed = yield* shopSessions.find(SEED_SHOP);
          if (Option.isNone(seed)) return yield* Effect.die(new Error("no seeded ShopSession"));
          yield* shopSessions.upsert({
            ...seed.value,
            shop,
            shopGid: Schema.decodeUnknownSync(ShopGid)(`gid://shopify/Shop/${shop}`),
            shopActorId: shop,
          });
          return {};
        }),
    });
  }),
);
