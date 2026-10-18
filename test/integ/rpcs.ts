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
import { InvalidSessionToken, NotAShopMember, ShopKey } from "../../src/contract/shop.ts";
import {
  MemberWorkflowPageData,
  MemberWorkflowPageRequest,
  WorkflowsListPageData,
  WorkflowsListRequest,
} from "../../src/contract/workflows-list.ts";
import { ListOrdersRequest, OrderDetailRequest } from "../../src/contract/orders.ts";
import {
  SetupFactsRequest,
  WorkflowDetailRequest,
  WorkflowsPageRequest,
} from "../../src/contract/workflows.ts";
import {
  ListOrdersInput,
  OrderPageData,
  OrdersIndexData,
  SetupFacts,
  WorkflowPageData,
  WorkflowsIndexData,
} from "../../src/domain/shop-work.ts";
import { BackendApi } from "../../src/backend/api.ts";
import { OrderDetail } from "../../src/domain/orders.ts";
import { ShopNotInstalled } from "../../src/contract/fixture.ts";
import { ShopActors } from "../../src/backend/shop-actors.ts";
import { ShopifyFake } from "./shopify-fake.ts";

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
 * - `ShopIdentityNames` answers the emails of `shop`'s `Member` rows and the names of its `Team`
 *   rows, read from D1 alone ({@link MembershipRepository}' `identityNames`), so it never reaches the actor.
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
    error: Schema.Union([Unauthorized, Forbidden, NotAShopMember]),
  }),
  Rpc.make("ApiMemberWorkflowPage", {
    payload: { cookie: Schema.String, ...MemberWorkflowPageRequest.fields },
    success: MemberWorkflowPageData,
    error: Schema.Union([Unauthorized, Forbidden, NotAShopMember]),
  }),
  Rpc.make("ShopIdentityNames", {
    payload: { shop: ShopKey },
    success: Schema.Struct({ emails: Schema.Array(Email), teams: Schema.Array(Schema.String) }),
  }),
);

export const IntegHandlers = IntegRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const shopifyFake = yield* ShopifyFake;
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
      ShopIdentityNames: ({ shop }) => members.identityNames(shop),
    });
  }),
);
