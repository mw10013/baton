import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShopKey } from "../domain/platform.ts";
import type {
  GetOrderDetailInput,
  ListOrdersInput,
  ListRunsInput,
  TeamId,
} from "../domain/shop-work.ts";
import * as Match from "effect/Match";
import { FixtureConflict } from "../contract/fixture.ts";
import type { ListWorkflowsInput } from "../domain/shop-work.ts";
import type { ActorFixtureRows } from "./fixture.ts";
import type { Dependencies } from "alchemy";
import ShopActor, { ABORT_EVICTED, ABORT_UNINSTALLED, type RevokeInput } from "./shop-actor/tag.ts";
import type { BillingCycleInput } from "../domain/billing.ts";

/**
 * `ShopActors.destroy`'s reading of the stub call. The actor's abort
 * lands mid-call, so a successful destroy rejects: the stub fails with an `RpcCallError` whose
 * cause is workerd's reset, an `Error` with message {@link ABORT_UNINSTALLED} (and
 * `durableObjectReset: true`). That rejection, and only that, is success: the abort comes after
 * `deleteAll`, so seeing it proves the storage is gone. A call that answers before its abort
 * lands is success too. Anything else (the actor unreachable, or `deleteAll` hitting its time
 * limit, which is safe to retry until it succeeds) logs `status=failed` and propagates, so the
 * uninstall answers non-2xx and Shopify retries.
 *
 * The stub types its methods' errors as `never`, but the rejection arrives as a typed failure,
 * so this reads the cause.
 */
export const settleDestroy = (key: ShopKey, call: Effect.Effect<void>) =>
  call.pipe(
    Effect.catchCause((cause) =>
      isAbort(Cause.squash(cause), ABORT_UNINSTALLED) ? Effect.void : Effect.failCause(cause),
    ),
    Effect.tap(() =>
      Effect.logInfo(`ShopActors.destroy: shop=${key} status=destroyed`).pipe(
        Effect.annotateLogs({ shop: key, status: "destroyed" }),
      ),
    ),
    Effect.tapCause((cause) =>
      Effect.logError(
        `ShopActors.destroy: shop=${key} status=failed: ${messageOf(Cause.squash(cause))}`,
      ).pipe(Effect.annotateLogs({ shop: key, status: "failed" })),
    ),
  );

/** Whether `error` is the stub call's rejection by the actor's own abort with `reason`. */
const isAbort = (error: unknown, reason: string) =>
  error instanceof Cloudflare.RpcCallError &&
  error.cause instanceof Error &&
  error.cause.message === reason;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const make = <R>(namespace: Effect.Effect<Effect.Success<typeof ShopActor>, never, R>) =>
  Effect.gen(function* () {
    const actors = yield* namespace;

    /**
     * `revoke` on a shop's actor. Best effort: a failure is logged and counts as nothing closed,
     * because the edit that called for it is already written and a stale socket is bounded by
     * its session's expiry (a member's) or by the next connect's gate (`"all"`).
     */
    const revoke = Effect.fn("ShopActors.revoke")(function* (key: ShopKey, input: RevokeInput) {
      return yield* actors
        .getByName(key)
        .revoke(input)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`ShopActors.revoke: shop=${key} by=${input.by}`, cause).pipe(
              Effect.annotateLogs({ shop: key, by: input.by }),
              Effect.as({ closed: 0 }),
            ),
          ),
        );
    });

    /**
     * The shop's usage; see `getUsage` on {@link ShopActor}. Call it only for an installed shop:
     * any stub call recreates an uninstalled shop's actor.
     */
    const getUsage = Effect.fn("ShopActors.getUsage")(function* (key: ShopKey) {
      return yield* actors.getByName(key).getUsage();
    });

    /** Records the shop's billing cycle; see `setBillingCycle` on {@link ShopActor}. */
    const setBillingCycle = Effect.fn("ShopActors.setBillingCycle")(function* (
      key: ShopKey,
      input: BillingCycleInput,
    ) {
      yield* actors.getByName(key).setBillingCycle(input);
    });

    /**
     * Drains the shop's usage outbox and answers what is left; see `flushUsageEvents` on
     * {@link ShopActor}.
     */
    const flushUsageEvents = Effect.fn("ShopActors.flushUsageEvents")(function* (key: ShopKey) {
      return yield* actors.getByName(key).flushUsageEvents();
    });

    /** Replaces the shop's work with `rows`; see `loadFixture` on {@link ShopActor}. */
    const loadFixture = Effect.fn("ShopActors.loadFixture")(function* (
      key: ShopKey,
      rows: ActorFixtureRows,
    ) {
      return yield* actors.getByName(key).loadFixture(rows);
    });

    /**
     * Adds `rows` beside the shop's work; see `addFixture` on {@link ShopActor}. Its `Conflict`
     * answer is {@link FixtureConflict}.
     */
    const addFixture = Effect.fn("ShopActors.addFixture")(function* (
      key: ShopKey,
      rows: ActorFixtureRows,
    ) {
      const answer = yield* actors.getByName(key).addFixture(rows);
      return yield* Match.value(answer).pipe(
        Match.tagsExhaustive({
          Added: ({ counts }) => Effect.succeed(counts),
          Conflict: ({ reason }) => Effect.fail(new FixtureConflict({ shop: key, reason })),
        }),
      );
    });

    /** Applies a fixture's work to its runs; see `applyFixture` on {@link ShopActor}. */
    const applyFixture = Effect.fn("ShopActors.applyFixture")(function* (
      key: ShopKey,
      rows: ActorFixtureRows,
      caller: "loadFixture" | "addToFixture",
    ) {
      yield* actors.getByName(key).applyFixture({ rows, caller });
    });

    /** Deletes one stored order; see `removeOrder` on {@link ShopActor}. */
    const removeOrder = Effect.fn("ShopActors.removeOrder")(function* (
      key: ShopKey,
      orderId: string,
    ) {
      return yield* actors.getByName(key).removeOrder({ orderId });
    });

    /**
     * One `orders/*` delivery for an installed shop; see `syncOrderWebhook` on {@link ShopActor}.
     * Call it only after reading the shop's `ShopSession`: any stub call recreates an uninstalled
     * shop's actor.
     */
    const syncOrderWebhook = Effect.fn("ShopActors.syncOrderWebhook")(function* (
      key: ShopKey,
      input: {
        readonly orderId: string;
        readonly topic: string;
        readonly updatedAt: number | null;
      },
    ) {
      return yield* actors.getByName(key).syncOrderWebhook(input);
    });

    /** One stored order with its items, or null. */
    const getOrder = Effect.fn("ShopActors.getOrder")(function* (key: ShopKey, orderId: string) {
      return yield* actors.getByName(key).getOrder({ orderId });
    });

    /** One page of the shop's orders index; see `listOrders` on {@link ShopActor}. */
    const listOrders = Effect.fn("ShopActors.listOrders")(function* (
      key: ShopKey,
      input: ListOrdersInput,
    ) {
      return yield* actors.getByName(key).listOrders(input);
    });

    /** The order page's read, or null; see `getOrderDetail` on {@link ShopActor}. */
    const getOrderDetail = Effect.fn("ShopActors.getOrderDetail")(function* (
      key: ShopKey,
      input: GetOrderDetailInput,
    ) {
      return yield* actors.getByName(key).getOrderDetail(input);
    });

    /** The workflows list for a member the gate resolved; see `listRuns` on {@link ShopActor}. */
    const listRuns = Effect.fn("ShopActors.listRuns")(function* (
      key: ShopKey,
      input: ListRunsInput,
    ) {
      return yield* actors.getByName(key).listRuns(input);
    });

    /** The member's workflow page, or null; see `getRunPage` on {@link ShopActor}. */
    const getRunPage = Effect.fn("ShopActors.getRunPage")(function* (
      key: ShopKey,
      input: { readonly runId: string; readonly teamIds: ReadonlyArray<TeamId> },
    ) {
      return yield* actors.getByName(key).getRunPage(input);
    });

    /** One page of the shop's workflows index; see `listWorkflows` on {@link ShopActor}. */
    const listWorkflows = Effect.fn("ShopActors.listWorkflows")(function* (
      key: ShopKey,
      input: ListWorkflowsInput,
    ) {
      return yield* actors.getByName(key).listWorkflows(input);
    });

    /** One workflow with its tasks, draft and the shop's teams, or null. */
    const getWorkflowDetail = Effect.fn("ShopActors.getWorkflowDetail")(function* (
      key: ShopKey,
      input: { readonly workflowId: string },
    ) {
      return yield* actors.getByName(key).getWorkflowDetail(input);
    });

    /** The actor's half of the shop's setup facts. */
    const workflowSetupFacts = Effect.fn("ShopActors.workflowSetupFacts")(function* (key: ShopKey) {
      return yield* actors.getByName(key).workflowSetupFacts();
    });

    /** Streams a completed export into the shop; see `onOrdersStream` on {@link ShopActor}. */
    const onOrdersStream = Effect.fn("ShopActors.onOrdersStream")(function* (
      key: ShopKey,
      input: { readonly workflowId: string; readonly url: string },
    ) {
      return yield* actors.getByName(key).onOrdersStream(input);
    });

    /** Ends a sync that found nothing; see `onOrdersSyncEmpty` on {@link ShopActor}. */
    const onOrdersSyncEmpty = Effect.fn("ShopActors.onOrdersSyncEmpty")(function* (
      key: ShopKey,
      input: { readonly workflowId: string },
    ) {
      yield* actors.getByName(key).onOrdersSyncEmpty(input);
    });

    /** Ends a sync that failed; see `onOrdersSyncError` on {@link ShopActor}. */
    const onOrdersSyncError = Effect.fn("ShopActors.onOrdersSyncError")(function* (
      key: ShopKey,
      input: { readonly workflowId: string; readonly message: string },
    ) {
      yield* actors.getByName(key).onOrdersSyncError(input);
    });

    /** Destroys the shop's actor; see `destroy` on {@link ShopActor} and {@link settleDestroy}. */
    const destroy = Effect.fn("ShopActors.destroy")(function* (key: ShopKey) {
      yield* settleDestroy(key, actors.getByName(key).destroy());
    });

    /**
     * Ends the shop's actor's activation, keeping its storage; see `evict` on {@link ShopActor}.
     * The abort lands mid-call, so its rejection is success, as for {@link settleDestroy}.
     */
    const evict = Effect.fn("ShopActors.evict")(function* (key: ShopKey) {
      yield* actors
        .getByName(key)
        .evict()
        .pipe(
          Effect.catchCause((cause) =>
            isAbort(Cause.squash(cause), ABORT_EVICTED) ? Effect.void : Effect.failCause(cause),
          ),
        );
    });

    return {
      destroy,
      evict,
      revoke,
      getUsage,
      setBillingCycle,
      flushUsageEvents,
      loadFixture,
      addFixture,
      applyFixture,
      removeOrder,
      syncOrderWebhook,
      getOrder,
      listOrders,
      getOrderDetail,
      listRuns,
      getRunPage,
      listWorkflows,
      getWorkflowDetail,
      workflowSetupFacts,
      onOrdersStream,
      onOrdersSyncEmpty,
      onOrdersSyncError,
    };
  });

/**
 * The Backend's own calls on a shop's actor: schemaless methods on its stub, which only the
 * Backend holds. A browser reaches the actor only through its socket.
 */
export class ShopActors extends Context.Service<
  ShopActors,
  Effect.Success<ReturnType<typeof make>>
>()("app/ShopActors") {
  /** Over the actor's own binding, which needs {@link ShopActor}'s implementation layer. */
  static readonly layer = Layer.effect(ShopActors, make(ShopActor));

  /**
   * Over `ShopActor.from` the Worker it runs in, the identity-only binding, which needs no
   * implementation: the orders sync Workflow's, since the actor's implementation yields the
   * Workflow. It resolves to the same namespace as {@link ShopActors.layer}. The cast: the
   * running Worker's service type cannot name the classes its script hosts.
   */
  static readonly layerFrom = Layer.effect(
    ShopActors,
    make(
      ShopActor.from(
        Effect.map(Cloudflare.Worker, (worker) => worker as unknown as Dependencies<ShopActor>),
      ),
    ),
  );

  /**
   * Records each revoke and closes nothing (`"all"` with an empty `id`), records each billing
   * cycle push in `cycles`, answers an empty shop's usage and a flush that leaves nothing, records
   * each fixture load in `loaded` and each fixture add in `added`, answering the counts of its
   * rows (it never finds a clash), applies no fixture work, and records each order removal in `removedOrders`, answering
   * that there was one. Its order, workflow and sync methods, `destroy` and `evict` die: a test that reaches them
   * overrides them.
   */
  static readonly layerTest = (
    revoked: Array<{ key: ShopKey; by: RevokeInput["by"]; id: string }>,
    loaded: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
    added: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
    removedOrders: Array<{ key: ShopKey; orderId: string }> = [],
    cycles: Array<{ key: ShopKey; input: BillingCycleInput }> = [],
  ) =>
    Layer.succeed(ShopActors, {
      revoke: (key, input) =>
        Effect.sync(() => {
          revoked.push({ key, by: input.by, id: input.by === "all" ? "" : input.id });
          return { closed: 0 };
        }),
      getUsage: () =>
        Effect.succeed({
          cycleStartAt: null,
          cycleEndAt: null,
          ordersThisCycle: 0,
          ordersLimitedAt: null,
          databaseSize: 0,
          openOrders: 0,
          lastSweepAt: null,
          pendingUsageEvents: 0,
          seatsThisCycle: 0,
        }),
      setBillingCycle: (key, input) =>
        Effect.sync(() => {
          cycles.push({ key, input });
        }),
      flushUsageEvents: () => Effect.succeed(0),
      loadFixture: (key, rows) =>
        Effect.sync(() => {
          loaded.push({ key, rows });
          return {
            workflows: rows.workflows.length,
            orders: rows.orders.length,
            lineItems: rows.lineItems.length,
          };
        }),
      addFixture: (key, rows) =>
        Effect.sync(() => {
          added.push({ key, rows });
          return {
            workflows: rows.workflows.length,
            orders: rows.orders.length,
            lineItems: rows.lineItems.length,
          };
        }),
      applyFixture: () => Effect.void,
      removeOrder: (key, orderId) =>
        Effect.sync(() => {
          removedOrders.push({ key, orderId });
          return { removed: true };
        }),
      syncOrderWebhook: () => Effect.die(new Error("ShopActors.layerTest: syncOrderWebhook")),
      getOrder: () => Effect.die(new Error("ShopActors.layerTest: getOrder")),
      listOrders: () => Effect.die(new Error("ShopActors.layerTest: listOrders")),
      getOrderDetail: () => Effect.die(new Error("ShopActors.layerTest: getOrderDetail")),
      listRuns: () => Effect.die(new Error("ShopActors.layerTest: listRuns")),
      getRunPage: () => Effect.die(new Error("ShopActors.layerTest: getRunPage")),
      listWorkflows: () => Effect.die(new Error("ShopActors.layerTest: listWorkflows")),
      getWorkflowDetail: () => Effect.die(new Error("ShopActors.layerTest: getWorkflowDetail")),
      workflowSetupFacts: () => Effect.die(new Error("ShopActors.layerTest: workflowSetupFacts")),
      onOrdersStream: () => Effect.die(new Error("ShopActors.layerTest: onOrdersStream")),
      onOrdersSyncEmpty: () => Effect.die(new Error("ShopActors.layerTest: onOrdersSyncEmpty")),
      onOrdersSyncError: () => Effect.die(new Error("ShopActors.layerTest: onOrdersSyncError")),
      destroy: () => Effect.die(new Error("ShopActors.layerTest: destroy")),
      evict: () => Effect.die(new Error("ShopActors.layerTest: evict")),
    });
}
