import type * as ShopifyApi from "@shopify/shopify-api";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import {
  orderSyncQuery,
  OrderSyncResponse,
  orderSyncVariables,
  toOrderLineItem,
  toShopOrder,
} from "@/lib/OrderSync";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

import { ShopAgentHost } from "./Host.ts";

/**
 * `ShopifyAdmin` is the one stack the object's runtime cannot hold.
 * `ShopifyAdmin.layerNoDeps` closes over a concrete session at build time, and
 * `ManagedRuntime` memoizes what it builds — so a runtime-level `ShopifyAdmin`
 * would pin whichever offline token was live when the Durable Object was
 * constructed and keep using it after `Shopify.refreshShopSessionIfExpired` had
 * rotated it, on an instance that lives for hours. Built per call instead, from
 * the session `ensureShopSession` just returned. `Shopify`, the stack's
 * other requirement, is ambient and resolves from the runtime.
 */
const shopifyAdminLayer = (session: ShopifyApi.Session) =>
  Layer.provide(
    ShopifyAdmin.layerNoDeps,
    Layer.succeed(CurrentShopifySession, session),
  );

const make = Effect.gen(function* () {
  const host = yield* ShopAgentHost;

  /**
   * Fetches one order from the Admin API and merges it into SQLite. Shared by
   * the webhook path and the manual resync; `source` is the only difference,
   * and it is logged, not acted on.
   *
   * A `null` order is not a failure: by the time a delivery is handled the
   * order may already be deleted, and Shopify answers with `null` rather than
   * an error. Logged and skipped so the webhook still returns 2xx instead of
   * being retried for four hours against an order that no longer exists.
   *
   * `reconciler` loads what the per-order reconcile needs and returns it; it
   * runs after the fetch and before the upsert's transaction opens, and the
   * function it returns is the upsert's `afterWrite`. The caller supplies
   * it, so this module never reads shop work. `ceilingReleased` is the
   * reconcile's word that its closes released the open-run ceiling, handed
   * back for the caller to act on outside the transaction.
   */
  const fetchAndUpsertOrder = <E, E2, R2>(
    {
      orderId,
      source,
    }: {
      readonly orderId: string;
      readonly source: Domain.OrderSyncSource;
    },
    reconciler: Effect.Effect<
      (
        order: Domain.ShopOrder,
      ) => Effect.Effect<{ readonly ceilingReleased: boolean }, E>,
      E2,
      R2
    >,
  ) =>
    Effect.gen(function* () {
      const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(host.shop());
      const session = yield* (yield* Shopify).ensureShopSession(shop);
      const { order } = yield* ShopifyAdmin.pipe(
        Effect.flatMap((admin) =>
          admin.graphqlDecode(OrderSyncResponse, orderSyncQuery, {
            variables: orderSyncVariables(orderId),
          }),
        ),
        Effect.provide(shopifyAdminLayer(session)),
      );
      if (order === null) {
        yield* Effect.logWarning(
          `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId}: order not found`,
        ).pipe(Effect.annotateLogs({ shop, orderId, source }));
        return { written: false, ceilingReleased: false };
      }
      const lineItemsTruncated = order.lineItems.pageInfo.hasNextPage;
      if (lineItemsTruncated)
        yield* Effect.logError(
          `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} limit=${String(Domain.ShopLimits.maxLineItemsPerOrder)}: line items truncated`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            orderId,
            source,
            limit: Domain.ShopLimits.maxLineItemsPerOrder,
          }),
        );
      const reconcile = yield* reconciler;
      const shopOrder = toShopOrder({
        node: order,
        syncedAt: yield* Clock.currentTimeMillis,
        lineItemsTruncated,
      });
      const { written, afterWrite } =
        yield* (yield* OrderRepository).upsertOrder({
          order: shopOrder,
          lineItems: order.lineItems.nodes.map((node) =>
            toOrderLineItem(order.id, node),
          ),
          afterWrite: reconcile(shopOrder),
        });
      yield* Effect.logInfo(
        `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} source=${source} written=${String(written)}`,
      ).pipe(Effect.annotateLogs({ shop, orderId, source, written }));
      return {
        written,
        ceilingReleased: Option.exists(
          afterWrite,
          (after) => after.ceilingReleased,
        ),
      };
    });

  return { fetchAndUpsertOrder };
});

/**
 * What the object does with an order as Shopify's thing: fetch one and
 * store it. The object map is on {@link ShopAgentHost}.
 */
export class OrdersAgent extends Context.Service<
  OrdersAgent,
  Effect.Success<typeof make>
>()("OrdersAgent") {
  static readonly layer = Layer.effect(OrdersAgent, make);
}
