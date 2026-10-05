import { Context, type Effect } from "effect";

/**
 * What every module under `src/lib/agent/` needs from the `ShopAgent` object
 * itself: its identity and its fan-out. The host is built once per instance
 * in the constructor, from `this`; a module never touches a connection, the
 * Agents SDK or `this`, and reaches all three through here.
 *
 * The object map. The class in `src/lib/ShopAgent.ts` is the callable
 * surface, the role guard, the runtime, the connections and the orders sync
 * wiring; what the object does per context is a service in one file here.
 * `scripts/rules-lint.ts` holds the `may import` column (`OBJECT_MAP`), and
 * nothing outside the class and this folder imports a file here.
 *
 * | file            | holds                                                                                        | may import under `agent/` |
 * | --------------- | -------------------------------------------------------------------------------------------- | ------------------------- |
 * | `Host.ts`       | `ShopAgentHost`: what every module needs from the object itself                              | nothing                   |
 * | `Billing.ts`    | `BillingAgent`: usage, the billing cycle, the usage-event flush                              | `Host`                    |
 * | `Orders.ts`     | `OrdersAgent`: fetch and upsert one order                                                    | `Host`                    |
 * | `ShopWork.ts`   | `ShopWorkAgent`: workflows, drafts, runs, tasks, teams, the orders index, reconcile, seed    | `Host`, `Billing`         |
 *
 * Shop work importing Billing is the one crossing, one symbol wide:
 * `BillingAgent.flushUsageEvents`, because every path that creates a run
 * sends the usage queue (the triggers table on `Domain.ShopUsage`), and
 * shop work's reconcile is where runs are created. The class's sync wiring
 * is the other place the contexts meet: store (orders), reconcile
 * (shop work), flush (billing), publish (host).
 *
 * One row per source of orders. `store` is the orders write, whose rules are
 * the sync tables on `Domain.syncOrder`; `reconcile` is
 * the shape from the triggers table on `Domain.reconcileItem`, `reconcile` or
 * `reconcile all`; `flush` is when the usage queue is sent. Every row
 * publishes to every connection; the sites table on `ShopAgent.publish` is
 * the full list of writes that publish and when. No `pinned by`: the rows
 * are wiring, covered by the webhook, stream and ceiling suites by scenario.
 *
 * | source                        | store                                             | reconcile                          | flush                 |
 * | ----------------------------- | ------------------------------------------------- | ---------------------------------- | --------------------- |
 * | order webhook                 | `Domain.syncOrder`: fetch one; version skip first | reconcile, inside the upsert       | after the order       |
 * | open-orders sync (the stream) | `Domain.syncOrder`: each streamed order           | reconcile each, inside its upsert  | once after the stream |
 * | one-order sync (the button)   | `Domain.syncOrder`: fetch one; no skip            | reconcile, inside the upsert       | after the order       |
 * | workflow and team verbs       | —                                                 | reconcile all                      | after the pass        |
 * | seed (dev)                    | upsert each                                       | reconcile each, then reconcile all | after                 |
 */
export class ShopAgentHost extends Context.Service<
  ShopAgentHost,
  {
    /**
     * The shop domain, `this.name`. A function, read at call time and never
     * while a layer is built: the SDK sets the name after construction, and
     * the runtime is first built inside the constructor.
     */
    readonly shop: () => string;
    /** The object's publish to every connection; the rule is the class's `publish`. */
    readonly publish: Effect.Effect<void>;
    /** Closes these members' connections; the class's `closeMemberConnections`. */
    readonly closeMemberConnections: (
      memberIds: readonly string[],
    ) => Effect.Effect<void>;
    /** The object's SQLite size in bytes. */
    readonly databaseSize: Effect.Effect<number>;
    /** Whether a fresh tracking row says an open-orders sync is running at `now`; read, never refreshed. */
    readonly syncInFlight: (now: number) => Effect.Effect<boolean>;
  }
>()("ShopAgentHost") {}
