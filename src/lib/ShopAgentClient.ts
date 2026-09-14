import { Context, Effect, Layer, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";

/**
 * `retryable` and `overloaded` mirror the flags Cloudflare's Durable Object
 * infrastructure sets on errors it throws across the stub boundary
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/):
 * `retryable` marks a transient infra fault safe to retry with backoff;
 * `overloaded` marks a DO where "retrying will worsen the overload" and must
 * not be retried immediately. They are copied into typed fields (defaulting
 * false — user-code throws and result-decode failures carry neither) because
 * `cause` is an opaque `Schema.Defect()`, and a caller that wants to answer an
 * overloaded object with `429` + `Retry-After` instead of the default `500`
 * needs a typed refinement to branch on.
 */
export class ShopAgentClientError extends Schema.TaggedError<ShopAgentClientError>()(
  "ShopAgentClientError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
    overloaded: Schema.Boolean,
  },
) {}

/**
 * Typed Effect facade over ShopAgent Durable Object RPC for routes and server
 * functions — the `ShopifyAdmin.graphqlDecode` counterpart for DO calls.
 *
 * DO RPC structured-clones return values across the stub boundary, stripping
 * class identity and any compile-time guarantee, so an
 * `Effect.tryPromise<T>(() => stub.method())` type parameter is an unchecked
 * assertion. Every result is instead decoded against its `Domain` schema. Stub
 * lookup, error tagging, and result decoding live here once instead of at each
 * call site.
 *
 * Both failure modes — an RPC rejection and a result-decode failure — converge
 * on {@link ShopAgentClientError}, transient by contract: callers let it
 * propagate and the worker seam renders it a `500`. Its `cause` chain is walked
 * by `causeToErrorMessage`, so diagnostics render the same as the bare
 * `UnknownError` path this replaces.
 *
 * `shop` is `string`, not `Domain.Shop`: server functions pass the library
 * session's `session.shop` (a plain string, validated at auth), and the stub
 * name seam needs no more.
 *
 * `Shopify.ts`'s internal `SHOP_AGENT` uses (`idFromName`, uninstall `destroy`,
 * stub-by-id) stay raw: none decodes a wire result, and routing them through
 * this service would invert the layer graph.
 *
 * ## Loader reads versus socket reads
 *
 * This service is the seam for the *loader* half of a two-idiom rule, and the
 * rule is the reason a method appears here rather than as `@callable()` on
 * the object:
 *
 * - **Configuration a page reads and one person edits** (members, teams, the
 *   steps a team owns, the member queue) goes through a route `loader` — via
 *   `Repository` for D1 rows, via this service for Durable Object rows. The
 *   page paints during SSR, and its own mutations refresh it with
 *   `router.invalidate()`. The route's server function is the module-private
 *   `getLoaderData` (see `Domain.AdminShopLoaderData` for the contract
 *   naming), so a route never invents a bespoke fetch name.
 * - **Operational state other actors change underneath the page** (orders,
 *   which webhooks, the bulk sync stream, and members' step actions all
 *   write) goes through the `/app` socket via `useSubscribedQuery` — the
 *   subscribe pattern, described end to end on `Domain.Subscription`. All of
 *   it, or none — a socket `useQuery` outside that cycle never refetches,
 *   which is the bug that moved `listStepsOwnedBy` from the socket to this
 *   service.
 *
 * The `@callable()` set on `ShopAgent` is exactly what the browser may reach
 * over the socket; a read that only loaders need is plain RPC and lives here.
 *
 * The member queue is the rule's clearest case, and the reason the five member
 * mutations are *not* here: `listQueue` is the SSR paint and stays on this
 * path, while Start, Done, Note, Block, and Dismiss became `@callable()` once
 * `/shop/*` got a socket. Their privileged inputs did not become less
 * privileged — they moved from a Worker-resolved argument to
 * `Domain.ConnectionState` on the connection, which the same `requireMember`
 * check populates at connect.
 */
export class ShopAgentClient extends Context.Service<
  ShopAgentClient,
  {
    readonly listQueue: (
      shop: string,
      input: Domain.ListQueueInput,
    ) => Effect.Effect<readonly Domain.QueueItem[], ShopAgentClientError>;
    readonly listStepsOwnedBy: (
      shop: string,
      input: Domain.TeamIdInput,
    ) => Effect.Effect<readonly Domain.OwnedStep[], ShopAgentClientError>;
    readonly countStepsByTeam: (
      shop: string,
    ) => Effect.Effect<readonly Domain.TeamStepCounts[], ShopAgentClientError>;
    readonly listOwnedSteps: (
      shop: string,
    ) => Effect.Effect<readonly Domain.OwnedStepByTeam[], ShopAgentClientError>;
    readonly listOrders: (
      shop: string,
      input: Domain.ListOrdersInput,
    ) => Effect.Effect<Domain.OrdersView, ShopAgentClientError>;
    readonly getOrderDetail: (
      shop: string,
      input: Domain.GetOrderDetailInput,
    ) => Effect.Effect<Domain.OrderDetailView | null, ShopAgentClientError>;
    /** Item workflows only; the order workflow is read by `getWorkflowDetail` with `Domain.ORDER_WORKFLOW_ID`. */
    readonly listWorkflows: (
      shop: string,
    ) => Effect.Effect<
      readonly Domain.ItemWorkflowSummary[],
      ShopAgentClientError
    >;
    readonly getWorkflowDetail: (
      shop: string,
      input: Domain.WorkflowIdInput,
    ) => Effect.Effect<Domain.WorkflowDetailView | null, ShopAgentClientError>;
    /**
     * Not a read: the one write on this path. Every merchant edit that changes
     * who a member is or which teams they work on ends with this call, because
     * a member's open socket carries a connect-time copy of that answer
     * (`Domain.ConnectionState`) and nothing else would correct it before the
     * next reconnect.
     */
    readonly revokeMemberConnections: (
      shop: string,
      input: Domain.RevokeMemberConnectionsInput,
    ) => Effect.Effect<void, ShopAgentClientError>;
    /**
     * The subscription counterpart: `SubscriptionPlan` calls this when a
     * revalidation flips a shop to `Unsubscribed`, so every open socket —
     * merchant and member — reconnects through the gate and is refused.
     */
    readonly revokeAllConnections: (
      shop: string,
    ) => Effect.Effect<void, ShopAgentClientError>;
  }
>()("ShopAgentClient") {
  static readonly layerNoDeps = Layer.effect(
    ShopAgentClient,
    Effect.gen(function* () {
      const env = yield* CloudflareEnv;
      const call = <A>(
        name: string,
        schema: Schema.ConstraintDecoder<A>,
        shop: string,
        run: (
          stub: ReturnType<Env["SHOP_AGENT"]["getByName"]>,
        ) => Promise<unknown>,
      ) =>
        Effect.tryPromise({
          try: () => run(env.SHOP_AGENT.getByName(shop)),
          catch: (cause) => {
            const retryable =
              (cause as { readonly retryable?: unknown } | null)?.retryable ===
              true;
            const overloaded =
              (cause as { readonly overloaded?: unknown } | null)
                ?.overloaded === true;
            return new ShopAgentClientError({
              message: `ShopAgent.${name} call failed: retryable=${String(retryable)} overloaded=${String(overloaded)}`,
              cause,
              retryable,
              overloaded,
            });
          },
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(schema)(value).pipe(
              Effect.mapError(
                (cause) =>
                  new ShopAgentClientError({
                    message: `ShopAgent.${name} result validation failed`,
                    cause,
                    retryable: false,
                    overloaded: false,
                  }),
              ),
            ),
          ),
        );
      /**
       * `Schema.toType`: the object already decoded these rows, so the wire
       * value is the decoded shape (`customAttributes` an array, not JSON
       * text) and must be validated on that side.
       */
      const queueItems = Schema.toType(Schema.Array(Domain.QueueItem));
      const ownedSteps = Schema.toType(Schema.Array(Domain.OwnedStep));
      const teamStepCounts = Schema.toType(Schema.Array(Domain.TeamStepCounts));
      const ownedStepsByTeam = Schema.toType(
        Schema.Array(Domain.OwnedStepByTeam),
      );
      const ordersView = Schema.toType(Domain.OrdersView);
      const orderDetail = Schema.toType(Schema.NullOr(Domain.OrderDetailView));
      const workflows = Schema.toType(Schema.Array(Domain.ItemWorkflowSummary));
      const workflowDetail = Schema.toType(
        Schema.NullOr(Domain.WorkflowDetailView),
      );
      return ShopAgentClient.of({
        listQueue: Effect.fn("ShopAgentClient.listQueue")(
          (shop: string, input: Domain.ListQueueInput) =>
            call("listQueue", queueItems, shop, (stub) =>
              stub.listQueue(input),
            ),
        ),
        listStepsOwnedBy: Effect.fn("ShopAgentClient.listStepsOwnedBy")(
          (shop: string, input: Domain.TeamIdInput) =>
            call("listStepsOwnedBy", ownedSteps, shop, (stub) =>
              stub.listStepsOwnedBy(input),
            ),
        ),
        countStepsByTeam: Effect.fn("ShopAgentClient.countStepsByTeam")(
          (shop: string) =>
            call("countStepsByTeam", teamStepCounts, shop, (stub) =>
              stub.countStepsByTeam(),
            ),
        ),
        listOwnedSteps: Effect.fn("ShopAgentClient.listOwnedSteps")(
          (shop: string) =>
            call("listOwnedSteps", ownedStepsByTeam, shop, (stub) =>
              stub.listOwnedSteps(),
            ),
        ),
        listOrders: Effect.fn("ShopAgentClient.listOrders")(
          (shop: string, input: Domain.ListOrdersInput) =>
            call("listOrders", ordersView, shop, (stub) =>
              stub.listOrders(input),
            ),
        ),
        getOrderDetail: Effect.fn("ShopAgentClient.getOrderDetail")(
          (shop: string, input: Domain.GetOrderDetailInput) =>
            call("getOrderDetail", orderDetail, shop, (stub) =>
              stub.getOrderDetail(input),
            ),
        ),
        listWorkflows: Effect.fn("ShopAgentClient.listWorkflows")(
          (shop: string) =>
            call("listWorkflows", workflows, shop, (stub) =>
              stub.listWorkflows(),
            ),
        ),
        getWorkflowDetail: Effect.fn("ShopAgentClient.getWorkflowDetail")(
          (shop: string, input: Domain.WorkflowIdInput) =>
            call("getWorkflowDetail", workflowDetail, shop, (stub) =>
              stub.getWorkflowDetail(input),
            ),
        ),
        revokeMemberConnections: Effect.fn(
          "ShopAgentClient.revokeMemberConnections",
        )((shop: string, input: Domain.RevokeMemberConnectionsInput) =>
          call("revokeMemberConnections", Schema.Void, shop, (stub) =>
            stub.revokeMemberConnections(input),
          ),
        ),
        revokeAllConnections: Effect.fn("ShopAgentClient.revokeAllConnections")(
          (shop: string) =>
            call("revokeAllConnections", Schema.Void, shop, (stub) =>
              stub.revokeAllConnections(),
            ),
        ),
      });
    }),
  );
}
