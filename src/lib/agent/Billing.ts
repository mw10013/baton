import type * as Domain from "@/lib/Domain";

import { Context, Effect, Layer } from "effect";

import { causeToErrorMessage } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";

import { ShopAgentHost } from "./Host.ts";

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
   * edit through `ShopWorkAgent` ("turning a workflow on
   * sends the usage events for the orders it counted"), Sync from Shopify ("syncing
   * one order sends the usage queue, even when the sync fails") and the seed. A
   * cycle push sends it after its own write ({@link setBillingCycle}). Never
   * inside a transaction: it does
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
   * Records the shop's billing cycle (`OrderRepository.setBillingCycle`),
   * then sends the queue: a new cycle's first seat event, a rise in the seat
   * mark, and anything queued before the shop had a `shopGid` go out now
   * rather than at the next order.
   */
  const setBillingCycle = (cycle: Domain.BillingCycleInput) =>
    Effect.gen(function* () {
      yield* (yield* OrderRepository).setBillingCycle(cycle);
      yield* flushUsageEvents();
    });

  return {
    flushUsageEvents: flushUsageEvents(),
    getUsage,
    setBillingCycle,
  };
});

/**
 * The object's billing: usage, the billing cycle and the usage-event
 * flush. The object map is on {@link ShopAgentHost}.
 */
export class BillingAgent extends Context.Service<
  BillingAgent,
  Effect.Success<typeof make>
>()("BillingAgent") {
  static readonly layer = Layer.effect(BillingAgent, make);
}
