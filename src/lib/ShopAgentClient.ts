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
 *   tasks a team owns, the member's workflows list) goes through a route `loader` — via
 *   `Repository` for D1 rows, via this service for Durable Object rows. The
 *   page paints during SSR, and its own mutations refresh it with
 *   `router.invalidate()`. The route's server function is the module-private
 *   `getLoaderData` (the rule below), so a route never invents a bespoke
 *   fetch name.
 * - **Operational state other actors change underneath the page** (orders,
 *   which webhooks, the bulk sync stream, and members' task actions all
 *   write) goes through the `/app` socket via `useSubscribedQuery` — the
 *   subscribe pattern, described end to end on `Domain.Subscription`. All of
 *   it, or none — a socket `useQuery` outside that cycle never refetches,
 *   which is the bug that moved `listTeamWorkflows` from the socket to this
 *   service.
 *
 * **Loader data.** `<RoutePrefix>LoaderData` names the data contract for a
 * route's loader, owned by that route. The prefix derives mechanically from
 * the route id — tail segment (`admin.shop.$shop` → `AdminShop`), parent +
 * `Index` for index routes (`app.index` → `AppIndex`), extended leftward on
 * collision — never from UX vocabulary. Ownership, not exclusivity: socket
 * refetches, api routes, and tests may consume a contract as-is, but only the
 * owning route drives its shape; the route's server fn binds to it as the
 * module-private `getLoaderData`, one fixed name per route so nobody has to
 * coin a fetch name per page. When another consumer needs the shape to
 * change, promote the contract to a domain-named type instead of bending it.
 * The type lives in its route, module-private, above its `getLoaderData`;
 * `scripts/rules-lint.ts` refuses a `LoaderData` export anywhere else.
 *
 * The `@callable()` set on `ShopAgent` is exactly what the browser may reach
 * over the socket; a read that only loaders need is plain RPC and lives here.
 *
 * The member's workflows list is the rule's clearest case, and the reason the five member
 * mutations are *not* here: `listRuns` is the SSR paint and stays on this
 * path, while Start, Done, Note, Block, and Unblock became `@callable()` once
 * `/shop/*` got a socket. Their privileged inputs did not become less
 * privileged — they moved from a Worker-resolved argument to
 * `Domain.ConnectionState` on the connection, which the same `requireMember`
 * check populates at connect.
 */
export class ShopAgentClient extends Context.Service<
  ShopAgentClient,
  {
    readonly listRuns: (
      shop: string,
      input: Domain.ListRunsInput,
    ) => Effect.Effect<Domain.WorkflowsListData, ShopAgentClientError>;
    /** The workflow page's loader read; `null` is "not yours or not there", one answer on purpose. */
    readonly memberGetRun: (
      shop: string,
      input: Domain.GetRunForMemberInput,
    ) => Effect.Effect<Domain.RunPageData | null, ShopAgentClientError>;
    readonly listTeamWorkflows: (
      shop: string,
      input: Domain.TeamIdInput,
    ) => Effect.Effect<readonly Domain.TeamWorkflow[], ShopAgentClientError>;
    readonly countTasksByTeam: (
      shop: string,
    ) => Effect.Effect<readonly Domain.TeamTaskCounts[], ShopAgentClientError>;
    readonly listAllTeamWorkflows: (
      shop: string,
    ) => Effect.Effect<
      readonly Domain.TeamWorkflowByTeam[],
      ShopAgentClientError
    >;
    readonly listOrders: (
      shop: string,
      input: Domain.ListOrdersInput,
    ) => Effect.Effect<Domain.OrdersIndexData, ShopAgentClientError>;
    readonly getOrderDetail: (
      shop: string,
      input: Domain.GetOrderDetailInput,
    ) => Effect.Effect<Domain.OrderPageData | null, ShopAgentClientError>;
    /**
     * The quota surfaces' loader read. `@callable()` on the object as well, for
     * the socket; both are the same method, since usage is read by a page that
     * paints server-side and by one that refreshes on order pushes.
     */
    readonly getUsage: (
      shop: string,
    ) => Effect.Effect<Domain.ShopUsage, ShopAgentClientError>;
    readonly listWorkflows: (
      shop: string,
    ) => Effect.Effect<readonly Domain.WorkflowSummary[], ShopAgentClientError>;
    readonly getWorkflowDetail: (
      shop: string,
      input: Domain.WorkflowIdInput,
    ) => Effect.Effect<Domain.WorkflowPageData | null, ShopAgentClientError>;
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
    /**
     * Pushes the shop's billing cycle into the object
     * (`ShopAgent.setBillingCycle`). The object cannot learn it on its own:
     * it lives on the app subscription, which only the Worker's Partner client
     * reads. It is a date range rather than an entitlement — the object still
     * never learns what the plan grants.
     */
    readonly setBillingCycle: (
      shop: string,
      input: Domain.BillingCycleInput,
    ) => Effect.Effect<void, ShopAgentClientError>;
    /**
     * Reports the member count after a member add (`ShopAgent.recordMemberCount`).
     * Answers the units queued.
     */
    readonly recordMemberCount: (
      shop: string,
      input: Domain.RecordMemberCountInput,
    ) => Effect.Effect<number, ShopAgentClientError>;
    /**
     * Hands the object Shopify's own meter quantities so the divergence from the
     * local count is observable (`ShopAgent.checkMeters`, which says why
     * nothing is corrected from it).
     */
    readonly checkMeters: (
      shop: string,
      input: Domain.MeterQuantitiesInput,
    ) => Effect.Effect<void, ShopAgentClientError>;
    /**
     * Drains the object's usage-event outbox now rather than on the next order
     * (`ShopAgent.flushUsageEvents`). Called by the uninstall webhook and by
     * `SubscriptionPlan.expectChange`.
     */
    readonly flushUsageEvents: (
      shop: string,
    ) => Effect.Effect<number, ShopAgentClientError>;
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
       * value is the decoded shape (`lineItemProperties` an array, not JSON
       * text) and must be validated on that side.
       */
      const workflowsListData = Schema.toType(Domain.WorkflowsListData);
      const runPageData = Schema.toType(Schema.NullOr(Domain.RunPageData));
      const teamWorkflows = Schema.toType(Schema.Array(Domain.TeamWorkflow));
      const teamTaskCounts = Schema.toType(Schema.Array(Domain.TeamTaskCounts));
      const teamWorkflowsByTeam = Schema.toType(
        Schema.Array(Domain.TeamWorkflowByTeam),
      );
      const ordersIndexData = Schema.toType(Domain.OrdersIndexData);
      const orderDetail = Schema.toType(Schema.NullOr(Domain.OrderPageData));
      const usage = Schema.toType(Domain.ShopUsage);
      const workflows = Schema.toType(Schema.Array(Domain.WorkflowSummary));
      const workflowDetail = Schema.toType(
        Schema.NullOr(Domain.WorkflowPageData),
      );
      return ShopAgentClient.of({
        listRuns: Effect.fn("ShopAgentClient.listRuns")(
          (shop: string, input: Domain.ListRunsInput) =>
            call("listRuns", workflowsListData, shop, (stub) =>
              stub.listRuns(input),
            ),
        ),
        memberGetRun: Effect.fn("ShopAgentClient.memberGetRun")(
          (shop: string, input: Domain.GetRunForMemberInput) =>
            call("memberGetRun", runPageData, shop, (stub) =>
              stub.memberGetRun(input),
            ),
        ),
        listTeamWorkflows: Effect.fn("ShopAgentClient.listTeamWorkflows")(
          (shop: string, input: Domain.TeamIdInput) =>
            call("listTeamWorkflows", teamWorkflows, shop, (stub) =>
              stub.listTeamWorkflows(input),
            ),
        ),
        countTasksByTeam: Effect.fn("ShopAgentClient.countTasksByTeam")(
          (shop: string) =>
            call("countTasksByTeam", teamTaskCounts, shop, (stub) =>
              stub.countTasksByTeam(),
            ),
        ),
        listAllTeamWorkflows: Effect.fn("ShopAgentClient.listAllTeamWorkflows")(
          (shop: string) =>
            call("listAllTeamWorkflows", teamWorkflowsByTeam, shop, (stub) =>
              stub.listAllTeamWorkflows(),
            ),
        ),
        listOrders: Effect.fn("ShopAgentClient.listOrders")(
          (shop: string, input: Domain.ListOrdersInput) =>
            call("listOrders", ordersIndexData, shop, (stub) =>
              stub.listOrders(input),
            ),
        ),
        getOrderDetail: Effect.fn("ShopAgentClient.getOrderDetail")(
          (shop: string, input: Domain.GetOrderDetailInput) =>
            call("getOrderDetail", orderDetail, shop, (stub) =>
              stub.getOrderDetail(input),
            ),
        ),
        getUsage: Effect.fn("ShopAgentClient.getUsage")((shop: string) =>
          call("getUsage", usage, shop, (stub) => stub.getUsage()),
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
        setBillingCycle: Effect.fn("ShopAgentClient.setBillingCycle")(
          (shop: string, input: Domain.BillingCycleInput) =>
            call("setBillingCycle", Schema.Void, shop, (stub) =>
              stub.setBillingCycle(input),
            ),
        ),
        recordMemberCount: Effect.fn("ShopAgentClient.recordMemberCount")(
          (shop: string, input: Domain.RecordMemberCountInput) =>
            call("recordMemberCount", Schema.Number, shop, (stub) =>
              stub.recordMemberCount(input),
            ),
        ),
        checkMeters: Effect.fn("ShopAgentClient.checkMeters")(
          (shop: string, input: Domain.MeterQuantitiesInput) =>
            call("checkMeters", Schema.Void, shop, (stub) =>
              stub.checkMeters(input),
            ),
        ),
        flushUsageEvents: Effect.fn("ShopAgentClient.flushUsageEvents")(
          (shop: string) =>
            call("flushUsageEvents", Schema.Number, shop, (stub) =>
              stub.flushUsageEvents(),
            ),
        ),
      });
    }),
  );
}
