/**
 * The shop actor's billing meter over its SQLite: the counted order, the billing cycle, the seat
 * mark and the usage-event outbox.
 *
 * @module
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  type BillingCycleInput,
  provisionalCycleStart,
  seatEventValue,
  USAGE_METER_MEMBER,
  USAGE_METER_ORDER,
  UsageEvent,
} from "../../domain/billing.ts";
import { ShopGid, ShopLimits } from "../../domain/platform.ts";
import { ShopifyAppEvents } from "../shopify-app-events.ts";
import type { Transaction } from "./transaction.ts";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, or a missing
 * `ShopUsage` row — kept distinct from `SqlError.SqlError`.
 */
export class UsageRepositoryError extends Schema.TaggedError<UsageRepositoryError>()(
  "UsageRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The `ShopUsage` row as stored. `ShopUsage` in Billing is this plus
 * `databaseSize`, which only the actor can read (`makeBilling`'s `getUsage`).
 *
 * The row holds everything the Backend needs to compare this shop against its
 * plan without the actor knowing what the plan is: the billing cycle's
 * counted orders, when the order ceiling last refused something and how many
 * open orders it carries, and when retention last swept.
 */
export const ShopUsageRow = Schema.Struct({
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  lastSweepAt: Schema.NullOr(Schema.Number),
  seatsThisCycle: Schema.Number,
  pendingUsageEvents: Schema.Number,
  openOrders: Schema.Number,
});
export type ShopUsageRow = typeof ShopUsageRow.Type;

/**
 * The cycle columns as the counting path reads them, plus the shop GID a usage
 * event has to be addressed to. Deliberately not {@link ShopUsageRow}: this is
 * read inside the run write's transaction on every count, so it stays one narrow
 * row rather than the counter report the merchant surfaces ask for.
 */
const ShopUsageCycle = Schema.Struct({
  shopGid: Schema.NullOr(Schema.String),
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
  seatsThisCycle: Schema.Number,
});

/**
 * The order's one billing idempotency key, capped at 64 characters. Derived
 * from the order id alone, never from a clock: an order is billed once and a
 * replayed flush must not bill it again. A Shopify order GID is around 30
 * characters, so this stays well inside the cap.
 *
 * One of two key shapes in the outbox; the other is {@link seatKey}.
 */
const countKey = (orderId: string) => `${orderId}#count`;

/**
 * A seat event's idempotency key: unique per cycle and per high-water mark
 * (`seatEventValue` in Billing), so a replayed revalidation with the same
 * member count is a no-op at the row level even if the mark comparison were
 * raced. `seat#` plus two integers stays far inside the 64-character cap.
 * Built by `setBillingCycle`.
 */
const seatKey = (cycleStartAt: number, mark: number) =>
  `seat#${String(cycleStartAt)}#${String(mark)}`;

/** One usage-event row waiting in the outbox; `value` is `UsageEvent`'s. `orderId` is null on a seat event. */
export const UsageEventRow = Schema.Struct({
  idempotencyKey: Schema.String,
  eventHandle: Schema.String,
  orderId: Schema.NullOr(Schema.String),
  value: UsageEvent.fields.value,
  occurredAt: Schema.Number,
  attempts: Schema.Number,
});
export type UsageEventRow = typeof UsageEventRow.Type;

/** What one `flushUsageEvents` pass did. */
export interface UsageFlush {
  readonly sent: number;
  readonly remaining: number;
}

/**
 * The meter over the actor's `sql`, built once per activation. `countOrder` runs inside its
 * caller's transaction; `setBillingCycle` opens its own under `transaction`; `flushUsageEvents`
 * runs outside every transaction.
 */
export const makeUsageRepository = (sql: SqlClient.SqlClient, transaction: Transaction) => {
  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, message: string) =>
    (rows: unknown) =>
      Schema.decodeUnknownEffect(schema)(rows).pipe(
        Effect.mapError((cause) => new UsageRepositoryError({ message, cause })),
      );

  const decodeCycle = decode(Schema.Array(ShopUsageCycle), "Invalid ShopUsage row");

  const readCycle = () =>
    sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle, seatsThisCycle from ShopUsage where id = 1`.pipe(
      Effect.flatMap(decodeCycle),
    );

  /**
   * Orders whose `countedAt` is at or after `since`: what a cycle
   * starting there is worth, the `recounted` of the triggers table on
   * `ShopUsage` in Billing.
   *
   * Correct only while a cycle is a month or less (the table's second
   * assumption). `countedAt` is a single timestamp per order, so an order
   * counted in *any* earlier cycle still inside `since` would be counted
   * again — which cannot happen for consecutive monthly cycles, where
   * everything before the new start belongs to a cycle that has closed. A
   * yearly cycle would break it; nothing in code enforces that, because
   * the plan's interval lives in the Partner Dashboard, which offers usage
   * meters on monthly plans only.
   */
  const countedSince = (since: number) =>
    sql`select count(*) from ShopOrder where countedAt >= ${since}`.values.pipe(
      Effect.map(([row]) => Number(row?.[0] ?? 0)),
    );

  /**
   * The cycle this write counts against, rolling the stored one forward
   * when the write lands past its end: the "first count past the cycle
   * end" row on `ShopUsage` in Billing.
   *
   * The rollover rides the counting path rather than a clock: a quiet
   * shop's stored cycle may lag by cycles, and the only moment that can
   * matter is the first order of a new one — which is exactly here. The
   * rolled-forward cycle is deliberately open-ended (`cycleEndAt` null):
   * only Shopify knows where the next cycle really ends, and the next
   * revalidation's `setBillingCycle` lands the exact answer, within a day
   * at the latest (`revalidateStalePlans`).
   *
   * A shop with no cycle at all opens a provisional one
   * (`provisionalCycleStart` in Billing) rather than skipping the count:
   * an order can arrive before the first plan revalidation, and an unmetered
   * order is a billing error, not a rounding one.
   */
  const currentCycle = Effect.fn("UsageRepository.currentCycle")(function* (now: number) {
    const [stored] = yield* readCycle();
    if (stored === undefined)
      return yield* Effect.fail(
        new UsageRepositoryError({
          message: "ShopUsage row is missing",
          cause: null,
        }),
      );
    if (stored.cycleStartAt === null) {
      const cycleStartAt = provisionalCycleStart(now);
      yield* sql`
        update ShopUsage
        set cycleStartAt = ${cycleStartAt}, ordersThisCycle = 0,
            seatsThisCycle = 0
        where id = 1
      `;
      return {
        shopGid: stored.shopGid,
        cycleStartAt,
        ordersThisCycle: 0,
        seatsThisCycle: 0,
      };
    }
    if (stored.cycleEndAt !== null && now >= stored.cycleEndAt) {
      // Recounted from the rows, as `setBillingCycle` does, so both ways a
      // cycle can start state one rule: the count is the orders counted
      // at or after the start. The seat mark starts at zero: the actor
      // cannot count the members, so the next `setBillingCycle` sends the
      // whole of it into the new cycle.
      const count = yield* countedSince(stored.cycleEndAt);
      yield* sql`
        update ShopUsage
        set cycleStartAt = cycleEndAt, cycleEndAt = null,
            ordersThisCycle = ${count},
            seatsThisCycle = 0
        where id = 1
      `;
      return {
        shopGid: stored.shopGid,
        cycleStartAt: stored.cycleEndAt,
        ordersThisCycle: count,
        seatsThisCycle: 0,
      };
    }
    return { ...stored, cycleStartAt: stored.cycleStartAt };
  });

  /**
   * `or ignore`, so re-queuing a key Shopify has already been told about is
   * a no-op rather than a second charge. The row carries no shop: the shop
   * is the actor, and `ShopUsage.shopGid` is read once at flush time.
   * A fixture order never gets here: the fixture writes it counted at `0`
   * (`fixtureRows`), before any run.
   */
  const queueUsageEvent = (input: {
    readonly idempotencyKey: string;
    readonly eventHandle: string;
    readonly orderId: string | null;
    readonly value: number;
    readonly occurredAt: number;
  }) =>
    sql`
      insert or ignore into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt)
      values (${input.idempotencyKey}, ${input.eventHandle}, ${input.orderId}, ${input.value}, ${input.occurredAt})
    `;

  /**
   * The billing meter, and the whole of it: an order is worth one unit the
   * first time Baton creates a run for it, and nothing ever gives that back.
   *
   * Called by `makeRunRepository`'s `insertRun` — the single door through
   * which a run is created — so the predicate is "Baton created a run on this
   * order", not "the order looks billable". That is deliberately narrower
   * than paid: a paid order no workflow matches costs the merchant nothing,
   * and an order Baton only ever displayed was never work it carried.
   *
   * `countedAt is null` in the `update` is the entire idempotency story. A
   * second run on the same order changes no row, so no counter moves and no
   * event is queued; the same holds for a reconcile that re-creates runs
   * after a cancellation. The `#count` key is the same on every replay, so even
   * a queue that slipped through would bill once. The mark lives on the
   * order row, so only deleting the order removes it, and `upsertOrder`
   * refuses to bring back an order retention deleted
   * (`ShopLimits.orderRetentionDays`).
   *
   * Runs inside the caller's transaction — the actor's SQLite refuses
   * nested ones — so the marker, the counter and the outbox row cannot come
   * apart. Storage only: no network and no D1 inside that transaction. `now`
   * is the caller's clock, and it dates the usage event, which Shopify
   * accepts only inside the merchant's open billing cycle.
   *
   * Resolves the cycle before it increments, so a run created by hand on a
   * quiet shop past its cycle end counts into the new cycle rather than the
   * outgoing one. A missing `ShopUsage` row is a defect in the schema, not a
   * billing condition, and is a die rather than an error the run paths would
   * have to carry.
   */
  const countOrder = Effect.fn("UsageRepository.countOrder")(function* (
    orderId: string,
    now: number,
  ) {
    // The cycle is resolved before the marker is written: a roll-forward
    // recounts from `countedAt`, so a marker written first would be
    // counted by the recount and again by the increment below.
    yield* currentCycle(now).pipe(Effect.catchTag("UsageRepositoryError", Effect.die));
    const counted =
      yield* sql`update ShopOrder set countedAt = ${now} where id = ${orderId} and countedAt is null returning id`;
    if (counted.length === 0) return;
    yield* sql`update ShopUsage set ordersThisCycle = ordersThisCycle + 1 where id = 1`;
    yield* queueUsageEvent({
      idempotencyKey: countKey(orderId),
      eventHandle: USAGE_METER_ORDER,
      orderId,
      value: 1,
      occurredAt: now,
    });
  });

  /**
   * Raises the seat mark to `size` inside the caller's transaction and
   * queues the rise; `seatEventValue` in Billing is the rule.
   */
  const raiseSeatMark = Effect.fn("UsageRepository.raiseSeatMark")(function* (input: {
    readonly cycleStartAt: number;
    readonly highWater: number;
    readonly size: number;
    readonly occurredAt: number;
  }) {
    const value = seatEventValue(input.size, input.highWater);
    if (value === 0) return 0;
    yield* sql`update ShopUsage set seatsThisCycle = ${input.size} where id = 1`;
    yield* queueUsageEvent({
      idempotencyKey: seatKey(input.cycleStartAt, input.size),
      eventHandle: USAGE_METER_MEMBER,
      orderId: null,
      value,
      occurredAt: input.occurredAt,
    });
    return value;
  });

  const decodeUsage = decode(Schema.Array(ShopUsageRow), "Invalid ShopUsage row");

  /** The stored counters; `databaseSize` is the actor's to add (`makeBilling`'s `getUsage`). */
  const getUsage = Effect.fn("UsageRepository.getUsage")(function* () {
    const [usage] = yield* decodeUsage(
      yield* sql`
        select cycleStartAt, cycleEndAt, ordersThisCycle, ordersLimitedAt,
               lastSweepAt, seatsThisCycle,
               (select count(*) from UsageEvent
                where cycleStartAt is null or occurredAt >= cycleStartAt) as pendingUsageEvents,
               openOrders
        from ShopUsage where id = 1
      `,
    );
    if (usage === undefined)
      return yield* Effect.fail(
        new UsageRepositoryError({
          message: "ShopUsage row is missing",
          cause: null,
        }),
      );
    return usage;
  });

  /**
   * Records the shop's billing cycle (`BillingCycleInput` in Billing). What it
   * does to the counts and the queue is the three "cycle pushed" rows on
   * `ShopUsage`; the mechanics are here.
   *
   * A changed `cycleStartAt` is a new cycle: the order count is recounted
   * from rows, and the seat mark is reset to the member count
   * (`input.memberCount`), queued as the
   * cycle's first seat event dated `cycleStartAt`. The value is the member count,
   * not the overage, because the seat meter starts every cycle at zero and
   * the plan's tiers price it (`AppSubscription` in Billing). On a shop no push
   * had addressed yet, every event dated before the start is dropped too.
   *
   * An unchanged start writes the columns and leaves the count alone, which
   * is what makes it safe to call on every revalidation. It still raises the
   * seat mark to a member count past it (`seatEventValue`): the
   * revalidation is the mark's one writer, so a member added since the last
   * one is billed here, and a cycle the counting path rolled forward on its
   * own, which starts with no mark, gets its mark here.
   *
   * `shopGid` is stored here rather than derived because addressing a usage
   * event at Shopify needs it and the actor has no other source.
   *
   * Answers whether the order count or the cycle changed, which is what a
   * screen showing the meter re-reads on.
   */
  const setBillingCycle = Effect.fn("UsageRepository.setBillingCycle")(function* (
    input: BillingCycleInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* transaction(
      Effect.gen(function* () {
        const [stored] = yield* readCycle();
        const changed = stored?.cycleStartAt !== input.cycleStartAt;
        const unaddressed = stored?.shopGid === null;
        yield* sql`
          update ShopUsage
          set shopGid = ${input.shopGid},
              cycleStartAt = ${input.cycleStartAt},
              cycleEndAt = ${input.cycleEndAt}
          where id = 1
        `;
        if (!changed) {
          yield* raiseSeatMark({
            cycleStartAt: input.cycleStartAt,
            highWater: stored?.seatsThisCycle ?? 0,
            size: input.memberCount,
            occurredAt: now,
          });
          return stored?.cycleEndAt !== input.cycleEndAt;
        }
        /**
         * A new cycle is recounted from the rows rather than zeroed.
         * The actor may already have counted orders into a provisional
         * cycle, or into the one it rolled forward on its own, and those
         * orders were billed — zeroing would make the merchant-facing
         * count disagree with the invoice for the rest of the cycle.
         * Orders counted before the new start belong to a closed cycle
         * and drop out, which is what a cycle change means.
         */
        const count = yield* countedSince(input.cycleStartAt);
        yield* sql`
          update ShopUsage
          set ordersThisCycle = ${count}
          where id = 1
        `;
        /**
         * Events queued while the shop could not be addressed — before
         * any cycle was pushed, or through a trial, when Shopify
         * reports no billing cycle — belong to no billing cycle: their
         * orders were just recounted out, and sending them into the
         * first real cycle would bill work the cycle never carried. Only then: once a shop has been addressed, an event
         * that misses its cycle is a real loss, deleted and logged by
         * the next flush (`usageEventIsExpired` in Billing).
         */
        if (unaddressed)
          yield* sql`delete from UsageEvent where occurredAt < ${input.cycleStartAt}`;
        /** The new cycle's seat mark is the member count, sent whole. */
        yield* sql`update ShopUsage set seatsThisCycle = 0 where id = 1`;
        yield* raiseSeatMark({
          cycleStartAt: input.cycleStartAt,
          highWater: 0,
          size: input.memberCount,
          occurredAt: input.cycleStartAt,
        });
        return true;
      }),
    );
  });

  /**
   * One pass over the usage-event outbox: at most `ShopLimits.sweepBatch`
   * live rows, oldest first, each sent and then deleted or marked. Rows dated
   * before the current cycle can never be sent
   * (`usageEventIsExpired` in Billing): the pass deletes them first, up to the
   * same batch, and logs each.
   *
   * Deliberately outside every transaction — it does network I/O, and
   * the actor's SQLite transactions must not await anything but storage.
   * `ShopifyAppEvents` is a requirement of the *effect* rather than of the
   * repository, so the repository stays constructible from a bare SQLite client
   * and only the callers that flush have to provide the client.
   *
   * An event that is merely sent proves nothing: a row is
   * deleted only once Shopify has accepted the request, and a refusal leaves
   * it with its `attempts` and `lastError` (Shopify's reason) for an operator to read.
   * `idempotencyKey` is the row's key: a replayed flush must not bill twice, and
   * re-queuing a key already stored is a no-op by construction.
   */
  const flushUsageEvents = Effect.fn("UsageRepository.flushUsageEvents")(function* (shop: string) {
    const appEvents = yield* ShopifyAppEvents;
    const [usage] = yield* readCycle();
    const shopGid = usage?.shopGid ?? null;
    const cycleStartAt = usage?.cycleStartAt ?? null;
    if (shopGid === null || cycleStartAt === null) {
      const [pending] = yield* sql`select count(*) from UsageEvent`.values;
      const remaining = Number(pending?.[0] ?? 0);
      // Nothing is dropped: the events keep their rows and go out on
      // the first flush after a plan revalidation has named the shop.
      if (remaining > 0)
        yield* Effect.logDebug(
          `UsageRepository.flushUsageEvents: shop=${shop} status=no-shop-gid pending=${String(remaining)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            status: "no-shop-gid",
            pending: remaining,
          }),
        );
      return { sent: 0, remaining } satisfies UsageFlush;
    }
    // A row dated before the cycle has expired
    // (`usageEventIsExpired`): it can never be sent, so it is
    // deleted here, and the log line is its record.
    const expired = yield* sql<{
      readonly idempotencyKey: string;
      readonly eventHandle: string;
    }>`
      delete from UsageEvent
      where idempotencyKey in (
        select idempotencyKey from UsageEvent
        where occurredAt < ${cycleStartAt}
        order by occurredAt
        limit ${ShopLimits.sweepBatch}
      )
      returning idempotencyKey, eventHandle
    `;
    yield* Effect.forEach(
      expired,
      ({ idempotencyKey, eventHandle }) =>
        Effect.logWarning(
          `UsageRepository.flushUsageEvents: shop=${shop} idempotencyKey=${idempotencyKey} eventHandle=${eventHandle}: expired before it was sent, deleted`,
        ).pipe(Effect.annotateLogs({ shop, idempotencyKey, eventHandle })),
      { discard: true },
    );
    const [pending] = yield* sql`
      select count(*) from UsageEvent where occurredAt >= ${cycleStartAt}
    `.values;
    const remaining = Number(pending?.[0] ?? 0);
    const rows = yield* decode(
      Schema.Array(UsageEventRow),
      "Invalid UsageEvent rows",
    )(
      yield* sql`
        select idempotencyKey, eventHandle, orderId, value, occurredAt, attempts
        from UsageEvent
        where occurredAt >= ${cycleStartAt}
        order by occurredAt, rowid
        limit ${ShopLimits.sweepBatch}
      `,
    );
    const gid = yield* decode(ShopGid, "Invalid shopGid")(shopGid);
    let sent = 0;
    for (const row of rows) {
      /**
       * Per row, never in bulk: one refused event must not hold back
       * the rest, and the API takes one event per request anyway. The
       * failure is recorded on the row rather than raised, because the
       * caller is a webhook or an open-orders sync whose real work succeeded —
       * a billing event that has not gone out yet is an operator signal
       * (`ShopUsage.pendingUsageEvents`), not a reason to fail a sync.
       */
      const failure = yield* appEvents
        .send({
          shopGid: gid,
          eventHandle: row.eventHandle,
          occurredAt: row.occurredAt,
          idempotencyKey: row.idempotencyKey,
          value: row.value,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.message.slice(0, 200))),
        );
      if (failure === null) {
        yield* sql`delete from UsageEvent where idempotencyKey = ${row.idempotencyKey}`;
        sent += 1;
      } else {
        yield* sql`
          update UsageEvent
          set attempts = attempts + 1, lastError = ${failure}
          where idempotencyKey = ${row.idempotencyKey}
        `;
        // Logged as well as stored. `lastError` is a column no surface
        // renders, and a meter that silently stops billing is the one
        // failure mode this whole outbox exists to make visible.
        yield* Effect.logWarning(
          `UsageRepository.flushUsageEvents: shop=${shop} idempotencyKey=${row.idempotencyKey} attempts=${String(row.attempts + 1)}: ${failure}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            idempotencyKey: row.idempotencyKey,
            attempts: row.attempts + 1,
            error: failure,
          }),
        );
      }
    }
    return { sent, remaining: remaining - sent } satisfies UsageFlush;
  });

  return { countOrder, setBillingCycle, flushUsageEvents, getUsage };
};

/** The actor's billing meter; see {@link makeUsageRepository}. */
export type UsageRepository = ReturnType<typeof makeUsageRepository>;
