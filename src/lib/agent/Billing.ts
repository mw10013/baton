import { Clock, Context, Effect, Layer } from "effect";

import * as Domain from "@/lib/Domain";
import { causeToErrorMessage } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";

import { ShopAgentHost } from "./Host.ts";

/**
 * Records the shop's billing cycle (`OrderRepository.setBillingCycle`).
 *
 * Does not flush, though a new cycle queues its first seat event: the
 * revalidation reconciles next, against meter readings taken before this
 * push, and a flush here would drain the pending units that explain the
 * gap. {@link reconcileUsage} flushes after its check.
 */
const setBillingCycle = (cycle: Domain.BillingCycleInput) =>
  Effect.gen(function* () {
    yield* (yield* OrderRepository).setBillingCycle(cycle);
  });

const make = Effect.gen(function* () {
  const host = yield* ShopAgentHost;

  /**
   * One pass over the usage-event outbox, logged and never raised.
   *
   * Every caller is a request whose real work has already succeeded — a webhook
   * that stored an order, an open-orders sync that finished its stream, a merchant's
   * Attach, Sync from Shopify or workflow edit that created runs, an uninstall that is
   * about to delete everything — and none of them may fail because a billing
   * event could not go out.
   *
   * **Every path that creates a run sends the queue after its write commits**
   * (the "then sent" of the triggers table on `Domain.ShopUsage`), so an order
   * counted near a cycle's end goes out inside that cycle rather than waiting
   * for the next webhook. The paths: the webhook and open-orders syncs, Attach
   * ("attaching a workflow sends the usage event it queued"), every workflow
   * edit through `ShopWorkAgent`'s `reconcileAllNow` ("turning a workflow on
   * sends the usage events for the orders it counted"), Sync from Shopify ("syncing
   * one order sends the usage queue, even when the sync fails") and the seed. A
   * cycle push is sent by the reconcile push that follows it
   * ({@link reconcileUsage}). Never inside a transaction: it does
   * network I/O. The rows survive a failure, so the next
   * order's flush retries them, and `ShopUsage.pendingUsageEvents` is what makes
   * a queue that never drains visible on the admin page.
   */
  const flushUsageEvents = Effect.fn("ShopAgent.flushUsageEvents")(
    function* () {
      const shop = host.shop();
      const repository = yield* OrderRepository;
      const flush = yield* repository.flushUsageEvents(shop).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `ShopAgent.flushUsageEvents: shop=${shop}: ${causeToErrorMessage(cause)}`,
          ).pipe(
            Effect.annotateLogs({ shop, cause: causeToErrorMessage(cause) }),
            // The real queue, not zero: the uninstall path reports this number
            // as what Shopify was never told, and a flush that failed outright
            // is the case where that number matters most.
            Effect.andThen(
              repository
                .getUsage()
                .pipe(Effect.map((usage) => usage.pendingUsageEvents)),
            ),
            Effect.map((remaining) => ({ sent: 0, remaining })),
            Effect.catchCause(() => Effect.succeed({ sent: 0, remaining: 0 })),
          ),
        ),
      );
      if (flush.sent > 0 || flush.remaining > 0)
        yield* Effect.logInfo(
          `ShopAgent.flushUsageEvents: shop=${shop} sent=${String(flush.sent)} pending=${String(flush.remaining)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            sent: flush.sent,
            pending: flush.remaining,
          }),
        );
      return flush;
    },
  );

  /**
   * What the Worker compares against the shop's plan: the object counts, the
   * Worker owns the ceilings ({@link Domain.Entitlements}).
   *
   * The stored row is authoritative and nothing is rolled forward in the
   * returned value: the cycle boundary is Shopify's, not a clock this object
   * can read, and the counting path
   * (`OrderRepository.upsertOrder`) is the one place that may move it. A shop
   * whose cycle has ended but has synced nothing since shows the finished
   * cycle's count until either an order or a plan revalidation arrives —
   * which is the truth, because Shopify has not billed the next cycle yet
   * either.
   */
  const getUsage = Effect.gen(function* () {
    return {
      ...(yield* (yield* OrderRepository).getUsage()),
      databaseSize: yield* host.databaseSize,
    } satisfies Domain.ShopUsage;
  });

  /**
   * Reports the D1 member count after a member add
   * (`OrderRepository.recordMemberCount`), then sends the queue. The caller is
   * the members page's add, and the members are D1's, so the object cannot
   * count it. Answers the units queued.
   */
  const recordMemberCount = (count: Domain.RecordMemberCountInput) =>
    Effect.gen(function* () {
      const queued = yield* (yield* OrderRepository).recordMemberCount(
        count,
        yield* Clock.currentTimeMillis,
      );
      yield* flushUsageEvents();
      return queued;
    });

  /**
   * Stores Shopify's meter readings beside the local counts and logs each
   * meter whose two disagree by more than the outbox can explain. Orders compare
   * `ordersThisCycle`, members compare `seatsThisCycle`, each by
   * {@link Domain.meterDiverges}.
   *
   * Nothing is corrected. The App Events API answers `202` to an event it will
   * later refuse, so a divergence is the *only* evidence that a shop's usage
   * is not being billed, and quietly moving the local number to match would
   * erase it.
   *
   * Flushes after the check, not before: the readings predate anything sent
   * now, so the check needs the pending units still queued. This is what
   * sends a new cycle's first seat event without waiting for the next order
   * or member add, and what first sends events queued before the shop had a
   * `shopGid`.
   */
  const reconcileUsage = (readings: Domain.ReconcileUsageInput) =>
    Effect.gen(function* () {
      const shop = host.shop();
      const usage = yield* (yield* OrderRepository).reconcileUsage(readings);
      const meters = [
        {
          meter: Domain.USAGE_METER_ORDER,
          local: usage.ordersThisCycle,
          shopify: readings.orders,
          pending: usage.pendingOrderUnits,
        },
        {
          meter: Domain.USAGE_METER_MEMBER,
          local: usage.seatsThisCycle,
          shopify: readings.members,
          pending: usage.pendingMemberUnits,
        },
      ];
      for (const { meter, local, shopify, pending } of meters)
        if (
          shopify !== null &&
          Domain.meterDiverges({ local, shopify, pending })
        )
          yield* Effect.logWarning(
            `ShopAgent.reconcileUsage: shop=${shop} meter=${meter} local=${String(local)} shopify=${String(shopify)} pending=${String(pending)}: metered usage diverges`,
          ).pipe(Effect.annotateLogs({ shop, meter, local, shopify, pending }));
      yield* flushUsageEvents();
    });

  return {
    flushUsageEvents: flushUsageEvents(),
    getUsage,
    setBillingCycle,
    recordMemberCount,
    reconcileUsage,
  };
});

/**
 * The object's billing: usage, the billing cycle, the member count and the
 * usage-event flush. The object map is on {@link ShopAgentHost}.
 */
export class BillingAgent extends Context.Service<
  BillingAgent,
  Effect.Success<typeof make>
>()("BillingAgent") {
  static readonly layer = Layer.effect(BillingAgent, make);
}
