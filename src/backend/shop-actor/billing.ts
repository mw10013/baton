/**
 * The billing application service: the actor's usage, billing cycle and usage-event flush over `makeUsageRepository`. Built once per
 * activation.
 *
 * @module
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ShopKey } from "../../domain/platform.ts";
import { ORDERS_KEY } from "../../contract/shop-actor.ts";
import type { BillingCycleInput, ShopUsage } from "../../domain/billing.ts";
import { ShopifyAppEvents } from "../shopify-app-events.ts";
import type { UsageFlush, UsageRepository } from "./usage-repository.ts";

/** A cause as one line per error, for a log line that must not carry a stack. */
const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) =>
      error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message,
    )
    .join("\n");

/**
 * The service over the actor's meter. `notify` is the actor's (the runs service's, which clears
 * its memos first); `databaseSize` reads the actor's storage size at call time.
 */
export const makeBilling = Effect.fnUntraced(function* <R>({
  usageRepository,
  notify,
  shop,
  databaseSize,
}: {
  readonly usageRepository: UsageRepository;
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
  readonly shop: ShopKey;
  readonly databaseSize: Effect.Effect<number>;
}) {
  const appEvents = yield* ShopifyAppEvents;

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
   * (the "then sent" of the triggers table on `ShopUsage` in Billing), so an order
   * counted near a cycle's end goes out inside that cycle rather than waiting
   * for the next webhook. The paths: the webhook and open-orders syncs, Attach
   * ("attaching a workflow sends the usage event it queued"), every workflow
   * edit through the runs service's reconcile all ("turning a workflow on
   * sends the usage events for the orders it counted"), Sync from Shopify ("syncing
   * one order sends the usage queue, even when the sync fails") and the fixture. A
   * cycle push sends it after its own write ({@link setBillingCycle}). Never
   * inside a transaction: it does
   * network I/O. The rows survive a failure, so the next
   * order's flush retries them, and `ShopUsage.pendingUsageEvents` is what makes
   * a queue that never drains visible on the admin page.
   */
  const flushUsageEvents: Effect.Effect<UsageFlush> = Effect.gen(function* () {
    const flush = yield* usageRepository.flushUsageEvents(shop).pipe(
      Effect.provideService(ShopifyAppEvents, appEvents),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Billing.flushUsageEvents: shop=${shop}: ${causeMessage(cause)}`).pipe(
          Effect.annotateLogs({ shop, cause: causeMessage(cause) }),
          // The real queue, not zero: the uninstall path reports this number
          // as what Shopify was never told, and a flush that failed outright
          // is the case where that number matters most.
          Effect.andThen(
            usageRepository.getUsage().pipe(Effect.map((usage) => usage.pendingUsageEvents)),
          ),
          Effect.map((remaining): UsageFlush => ({ sent: 0, remaining })),
          Effect.catchCause(() => Effect.succeed<UsageFlush>({ sent: 0, remaining: 0 })),
        ),
      ),
    );
    if (flush.sent > 0 || flush.remaining > 0)
      yield* Effect.logInfo(
        `Billing.flushUsageEvents: shop=${shop} sent=${String(flush.sent)} pending=${String(flush.remaining)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          sent: flush.sent,
          pending: flush.remaining,
        }),
      );
    return flush;
  }).pipe(Effect.withSpan("Billing.flushUsageEvents"));

  /**
   * What the Backend compares against the shop's plan: the actor counts, the
   * Backend owns the ceilings (`Entitlements` in Billing).
   *
   * The stored row is authoritative and nothing is rolled forward in the
   * returned value: the cycle boundary is Shopify's, not a clock this actor
   * can read, and the counting path
   * (`makeUsageRepository`'s `countOrder`) is the one place that may move it. A shop
   * whose cycle has ended but has counted nothing since shows the finished
   * cycle's count until either an order or a plan revalidation arrives —
   * which is the truth, because Shopify has not billed the next cycle yet
   * either.
   */
  const getUsage = Effect.fn("Billing.getUsage")(function* () {
    return {
      ...(yield* usageRepository.getUsage()),
      databaseSize: yield* databaseSize,
    } satisfies ShopUsage;
  });

  /**
   * Records the shop's billing cycle (`makeUsageRepository`'s `setBillingCycle`),
   * notifies {@link ORDERS_KEY} when the count or the cycle changed, so an open home page's
   * meter re-reads, then sends the queue: a new cycle's first seat event, a rise in the seat
   * mark, and anything queued before the shop had a `shopGid` go out now rather than at the
   * next order.
   */
  const setBillingCycle = Effect.fn("Billing.setBillingCycle")(function* (
    cycle: BillingCycleInput,
  ) {
    const changed = yield* usageRepository.setBillingCycle(cycle);
    if (changed) yield* notify([ORDERS_KEY]);
    yield* flushUsageEvents;
  });

  return { flushUsageEvents, getUsage, setBillingCycle };
});

/** The actor's billing service; see {@link makeBilling}. */
export type Billing = Effect.Success<ReturnType<typeof makeBilling>>;
