import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type { ShopKey } from "../../contract/shop.ts";
import type { OrdersSyncResult, SyncOrderResult } from "../../domain/orders.ts";
import { ShopLimits } from "../../domain/platform.ts";
import { ORDERS_KEY, SYNC_KEY } from "../../contract/shop-actor.ts";
import {
  OrderSyncResponse,
  orderSyncQuery,
  orderSyncVariables,
  toOrderLineItems,
  toShopOrder,
} from "../order-sync.ts";
import { ShopifyUnavailable } from "../shopify.ts";
import type { ShopifyAdmin } from "../shopify-admin.ts";
import type { OrderRepository } from "./order-repository.ts";
import type { Transaction } from "./transaction.ts";
import type { OrdersSyncParams } from "../orders-sync-workflow.ts";

/**
 * The part of Alchemy's handle on `OrdersSyncWorkflow` the orders application service calls: `create`, one instance
 * per press. A failed create is a defect, as Alchemy's handle has it.
 */
export interface OrdersSyncWorkflows {
  readonly create: (options: {
    readonly id: string;
    readonly params: OrdersSyncParams;
  }) => Effect.Effect<unknown>;
}

/** What one `orders/*` delivery came to in the actor; the delivery is answered 200 for each. */
export type OrderWebhookStatus = "stale" | "refused" | "gone" | "stored";

/**
 * Legacy's `OrdersAgent` (`agent/Orders.ts`): what the shop's actor does with an order as
 * Shopify's thing, fetching one from the Admin API itself and storing it, and starting the
 * open-orders sync. Built once per activation over the actor's repository and transaction, the
 * Backend's `ShopifyAdmin` (which ensures, and so refreshes, the offline session on every call),
 * the actor's handle on the sync Workflow, its `notify` and its shop.
 *
 * No Admin call runs inside the repository's transaction: the transaction closes the object's
 * input gate, behind which a timer never fires, and the refresh's retries and lease poll are
 * timers. Every method fetches first and writes after, as legacy did. The input gate opens
 * during the fetch, so a webhook may interleave with a bulk stream or another webhook; the
 * per-order transactions and the version guard keep that harmless.
 */
export const makeOrders = <R>({
  repository,
  transaction,
  admin,
  ordersSync,
  notify,
  shop,
}: {
  readonly repository: OrderRepository;
  readonly transaction: Transaction;
  readonly admin: (typeof ShopifyAdmin)["Service"];
  readonly ordersSync: OrdersSyncWorkflows;
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
  readonly shop: ShopKey;
}) => {
  /**
   * Legacy's `fetchAndUpsertOrder`: one `OrderSync` query for `orderId`, then the upsert. A
   * `null` order is not a failure: by the time a delivery is handled the order may already be
   * deleted, and Shopify answers `null` rather than an error, so it is logged and answered as
   * `gone`, storing nothing. A page cut short by `hasNextPage` is stored as is and logged at
   * Error (the rule is on `orderSyncQuery`).
   *
   * After the upsert, the retention pass, rate-limited by `lastSweepAt` rather than run on every
   * delivery (`ShopLimits.sweepIntervalMs`): a busy shop must not pay for a batch of deletes per
   * webhook. Notifies {@link ORDERS_KEY} when the order row moved or the sweep deleted a row, and
   * only then: a sweep is a write the screens show even when the order did not change, and a
   * rewrite of the same version shows nothing new (rule 17).
   */
  const fetchAndUpsertOrder = Effect.fn("Orders.fetchAndUpsertOrder")(function* (orderId: string) {
    const { order } = yield* admin.graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, {
      variables: orderSyncVariables(orderId),
    });
    if (order === null) {
      yield* Effect.logWarning(
        `Orders.fetchAndUpsertOrder: shop=${shop} orderId=${orderId}: order not found`,
      ).pipe(Effect.annotateLogs({ shop, orderId }));
      return { _tag: "Gone" } as const;
    }
    if (order.lineItems.pageInfo.hasNextPage)
      yield* Effect.logError(
        `Orders.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} limit=${String(ShopLimits.maxLineItemsPerOrder)}: line items truncated`,
      ).pipe(Effect.annotateLogs({ shop, orderId, limit: ShopLimits.maxLineItemsPerOrder }));
    const { lineItems, ...node } = order;
    const upsert = yield* repository.upsertOrder({
      order: toShopOrder({ node, syncedAt: yield* Clock.currentTimeMillis }),
      lineItems: yield* toOrderLineItems({ shop, orderId: node.id, nodes: lineItems.nodes }),
    });
    const { written, fresh, changed, refused } = upsert;
    yield* Effect.logInfo(
      `Orders.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} written=${String(written)} changed=${String(changed)}`,
    ).pipe(Effect.annotateLogs({ shop, orderId, written, changed, refused }));
    const now = yield* Clock.currentTimeMillis;
    const lastSweepAt = yield* repository.lastSweepAt();
    const swept =
      lastSweepAt === null || now - lastSweepAt >= ShopLimits.sweepIntervalMs
        ? yield* repository.sweepExpiredOrders({ now })
        : { orders: 0, runs: 0 };
    const sweptAny = swept.orders > 0 || swept.runs > 0;
    if (sweptAny)
      yield* Effect.logInfo(
        `Orders.fetchAndUpsertOrder: shop=${shop} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)}`,
      ).pipe(Effect.annotateLogs({ shop, sweptOrders: swept.orders, sweptRuns: swept.runs }));
    if (changed || sweptAny) yield* notify([ORDERS_KEY]);
    return { _tag: "Upserted", written, fresh, changed, refused } as const;
  });

  /**
   * Legacy's `ShopAgent.syncOrderWebhook`, one round trip for one delivery: the version probe
   * and, for an order not stored, the ceiling (`OrderRepository.orderVersion`), then, only for
   * `Fetch`, {@link fetchAndUpsertOrder}. The topic decides nothing (rule 1 on `syncOrder`); a
   * payload no newer than the row spends no Admin call (rule 2). The upsert's own version guard
   * makes a write racing between the probe and the store harmless. A refusal notifies nothing:
   * it stored no order.
   *
   * Every refusal is a business answer and succeeds. An `EnsureShopSessionError` fails, so the
   * delivery is non-2xx and Shopify retries, as legacy did: the Backend read the shop's
   * `ShopSession` before calling, so `OfflineSessionMissing` here means the row was deleted since
   * (an uninstall racing this delivery), and the retry finds no row and answers 200.
   *
   * The billing seam: the usage flush after a webhook write goes here, after the upsert.
   */
  const syncOrderWebhook = Effect.fn("Orders.syncOrderWebhook")(function* ({
    orderId,
    updatedAt,
  }: {
    readonly orderId: string;
    readonly topic: string;
    readonly updatedAt: number | null;
  }) {
    const version = yield* repository.orderVersion({
      orderId,
      updatedAt,
      now: yield* Clock.currentTimeMillis,
    });
    const status: OrderWebhookStatus | "fetch" = yield* Match.value(version).pipe(
      Match.tagsExhaustive({
        Stale: () =>
          Effect.logInfo(
            `Orders.syncOrderWebhook: shop=${shop} orderId=${orderId} status=stale`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "stale" }),
            Effect.as("stale" as const),
          ),
        Refused: ({ openOrders }) => {
          const limit = ShopLimits.maxOpenOrders;
          return Effect.logError(
            `Orders.syncOrderWebhook: shop=${shop} orderId=${orderId} status=order-ceiling openOrders=${String(openOrders)} limit=${String(limit)}`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "order-ceiling", openOrders, limit }),
            Effect.as("refused" as const),
          );
        },
        Fetch: () =>
          Effect.logInfo(
            `Orders.syncOrderWebhook: shop=${shop} orderId=${orderId} status=fetch`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "fetch" }),
            Effect.as("fetch" as const),
          ),
      }),
    );
    if (status !== "fetch") return status;
    const fetched = yield* fetchAndUpsertOrder(orderId);
    return Match.value(fetched).pipe(
      Match.tagsExhaustive({
        Gone: (): OrderWebhookStatus => "gone",
        Upserted: ({ refused }): OrderWebhookStatus => (refused ? "refused" : "stored"),
      }),
    );
  });

  /**
   * Sync from Shopify on one order, legacy's `syncOrder`: {@link fetchAndUpsertOrder} without
   * the version probe, since a merchant pressing the button is asking for the fetch and the
   * upsert's own version guard still protects the row.
   *
   * `Gone` when Shopify answers null for the order (the stored row stays, the rule on
   * `SyncOrderResult`); otherwise `Stored`, a ceiling refusal of an order not stored included,
   * as legacy answered: its result knew only gone or not, and the refusal is the ceiling banner's
   * to show, not this button's.
   *
   * The billing seam: the usage flush after a one-order sync goes here, whether or not the fetch
   * succeeded.
   */
  const syncOrder = Effect.fn("Orders.syncOrder")(function* ({
    orderId,
  }: {
    readonly orderId: string;
  }) {
    const fetched = yield* fetchAndUpsertOrder(orderId);
    const status = Match.value(fetched).pipe(
      Match.tagsExhaustive({
        Gone: () => "gone" as const,
        Upserted: ({ refused }) => (refused ? ("refused" as const) : ("stored" as const)),
      }),
    );
    yield* Effect.logInfo(
      `Orders.syncOrder: shop=${shop} orderId=${orderId} status=${status}`,
    ).pipe(Effect.annotateLogs({ shop, orderId, status }));
    const result: SyncOrderResult = status === "gone" ? { _tag: "Gone" } : { _tag: "Stored" };
    return result;
  });

  /**
   * Sync open orders, legacy's `ShopAgent.syncOpenOrders`: the start's rules are
   * `OrderRepository.beginSync`, in its own transaction, under a fresh instance id; this logs
   * them and, only on `Started`, notifies {@link SYNC_KEY} and creates the `OrdersSyncWorkflow`
   * instance of that id, outside the transaction. The record is written before the instance
   * exists, which is what legacy's `syncStarting` did: a second press in between answers
   * `InFlight`.
   *
   * A create that fails ends the sync it recorded with the same repository calls the Workflow's
   * error sink makes (`onOrdersSyncError`): the record is cleared, which re-enables the button at
   * once rather than after `SYNC_STALE_MS`, and the failure's message becomes the banner; then it
   * notifies {@link SYNC_KEY} and fails `ShopifyUnavailable`, carrying the create's failure.
   */
  const syncOpenOrders = Effect.fn("Orders.syncOpenOrders")(function* () {
    const workflowId = yield* Effect.sync(() => crypto.randomUUID());
    const start = yield* repository.beginSync({
      workflowId,
      now: yield* Clock.currentTimeMillis,
    });
    if (start._tag !== "InFlight" && start.stale !== null)
      yield* Effect.logWarning(
        `Orders.syncOpenOrders: shop=${shop} workflowId=${String(start.stale.workflowId)}: tracking record stale, cleared`,
      ).pipe(Effect.annotateLogs({ shop, workflowId: start.stale.workflowId }));
    const result: OrdersSyncResult = yield* Match.value(start).pipe(
      Match.tagsExhaustive({
        InFlight: () =>
          Effect.logInfo(`Orders.syncOpenOrders: shop=${shop} status=in-flight`).pipe(
            Effect.annotateLogs({ shop, status: "in-flight" }),
            Effect.as({ _tag: "InFlight" } as const),
          ),
        Refused: ({ openOrders }) => {
          const limit = ShopLimits.maxOpenOrders;
          return Effect.logError(
            `Orders.syncOpenOrders: shop=${shop} status=order-ceiling openOrders=${String(openOrders)} limit=${String(limit)}`,
          ).pipe(
            Effect.annotateLogs({ shop, status: "order-ceiling", openOrders, limit }),
            Effect.as({ _tag: "Refused" } as const),
          );
        },
        Started: () =>
          Effect.logInfo(
            `Orders.syncOpenOrders: shop=${shop} status=started workflowId=${workflowId}`,
          ).pipe(
            Effect.annotateLogs({ shop, status: "started", workflowId }),
            Effect.andThen(notify([SYNC_KEY])),
            Effect.as({ _tag: "Started" } as const),
          ),
      }),
    );
    if (result._tag !== "Started") return result;
    yield* ordersSync.create({ id: workflowId, params: { shop } }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          const message = error instanceof Error ? error.message : String(error);
          yield* Effect.logError(
            `Orders.syncOpenOrders: shop=${shop} workflowId=${workflowId} status=create-failed: ${message}`,
          ).pipe(Effect.annotateLogs({ shop, workflowId, status: "create-failed" }));
          const cleared = yield* transaction(
            Effect.gen(function* () {
              const cleared = yield* repository.clearSyncTracking({ workflowId });
              if (cleared) yield* repository.setSyncErrorIfEmpty({ error: message });
              return cleared;
            }),
          );
          if (cleared) yield* notify([SYNC_KEY]);
          return yield* new ShopifyUnavailable({ shop, cause: error });
        }),
      ),
    );
    return result;
  });

  return { fetchAndUpsertOrder, syncOrderWebhook, syncOrder, syncOpenOrders };
};

export type Orders<R = never> = ReturnType<typeof makeOrders<R>>;
