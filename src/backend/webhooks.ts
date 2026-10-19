import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EpochMillis, type ShopKey } from "../domain/platform.ts";
import type { OrderWebhookStatus } from "./shop-actor/orders.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import { Shopify, type ValidatedWebhook, WebhookRejected } from "./shopify.ts";

/**
 * The topics Baton answers, in the storage form `Shopify.validateWebhook` hands on. They are
 * the subscriptions of `shopify.app.toml`; a validated delivery of any other topic is 404.
 */
export const WebhookTopic = Schema.Literals([
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
  "APP_SCOPES_UPDATE",
  "APP_UNINSTALLED",
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_EDITED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
]);
export type WebhookTopic = typeof WebhookTopic.Type;
const decodeTopic = Schema.decodeUnknownOption(WebhookTopic);

/** The `app/scopes_update` payload: the scopes the shop now grants. */
export const ScopesUpdatePayload = Schema.Struct({
  current: Schema.Array(Schema.String),
});
const decodeScopesUpdate = Schema.decodeUnknownEffect(ScopesUpdatePayload);

/**
 * Everything the four order-shaped topics (`orders/create`, `orders/paid`, `orders/cancelled`,
 * `orders/fulfilled`) have in common after `include_fields` trimming, decoded laxly: Shopify may
 * widen the payload at any time.
 *
 * `id` is a REST numeric id that exceeds `Number.MAX_SAFE_INTEGER` for newer shops, so it is
 * only ever used to reconstruct a GID when `admin_graphql_api_id` is missing, which
 * `include_fields` makes unlikely.
 */
export const OrderWebhookPayload = Schema.Struct({
  id: Schema.Number,
  admin_graphql_api_id: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `orders/edited` alone: Shopify's order-editing guide says the payload "reports what the edit
 * changed, not the order's new state", so it carries an `order_edit` object rather than an
 * order. `order_id` is the REST numeric id the GID is built from, small enough to be exact in
 * practice, and compared against nothing. There is no `updated_at`, so an edit always fetches;
 * edits are rare, so that costs nothing worth guarding.
 */
export const OrderEditWebhookPayload = Schema.Struct({
  order_edit: Schema.Struct({ order_id: Schema.Number }),
});

/** Either `orders/*` payload; one that decodes as neither is a 400. */
export const OrdersWebhookPayload = Schema.Union([OrderEditWebhookPayload, OrderWebhookPayload]);
export type OrdersWebhookPayload = typeof OrdersWebhookPayload.Type;
const decodeOrdersPayload = Schema.decodeUnknownEffect(OrdersWebhookPayload);

const decodeUpdatedAt = Schema.decodeUnknownOption(EpochMillis);

/**
 * The GID and the stale-guard value for either payload shape. An edit has no `updated_at`, and
 * `null` is what the actor's version probe reads as "no guard, fetch it"; so is an `updated_at`
 * that is missing, null or not a timestamp.
 */
export const orderRef = (payload: OrdersWebhookPayload) =>
  "order_edit" in payload
    ? {
        orderId: `gid://shopify/Order/${String(payload.order_edit.order_id)}`,
        updatedAt: null,
      }
    : {
        orderId: payload.admin_graphql_api_id ?? `gid://shopify/Order/${String(payload.id)}`,
        updatedAt: Option.getOrNull(decodeUpdatedAt(payload.updated_at)),
      };

/** What one `orders/*` delivery came to; the delivery is answered 200 for each. */
export type OrderWebhookOutcome = "uninstalled" | OrderWebhookStatus;

const ok = HttpServerResponse.empty({ status: 200 });

/**
 * The GDPR/CPRA compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`),
 * required for App Store review and routed to one URI by `compliance_topics`. All three are
 * verified no-ops: a bad HMAC is 401 (`Shopify.validateWebhook`), which is what the compliance
 * requirement asks of an invalid signature, and anything valid is 200.
 *
 * Teardown is `app/uninstalled`'s, run as soon as the tokens are revoked; doing it from the
 * delayed `shop/redact` would risk resurrecting an already-destroyed `ShopActor` just to delete
 * it again.
 *
 * `customers/redact` and `customers/data_request` are no-ops because Baton stores no customer
 * identity fields: no name, email, phone or address, and no `customer` selection in any order
 * query. The order rows it does store are keyed by order and line item, so there is no customer
 * to look one up by. The one caveat, and the reason this is specific rather than a blanket "no
 * customer data": `ShopOrder.note` and a line item's `properties` are free text a buyer may have
 * typed personal details into. They are stored as Shopify sends them and deleted with the shop
 * on `app/uninstalled`, never in response to a per-customer request, which Baton has no key to
 * satisfy. The privacy page says exactly this.
 *
 * `app/uninstalled` is therefore the sole teardown point, and its delivery budget is finite:
 * Shopify retries 8 times over roughly 4 hours. A shop that exhausts it strands its actor: the
 * `ShopSession` row survives, so the shop still reads as installed. Accepted deliberately.
 * Burning all 8 attempts takes a sustained multi-hour failure, so the loss is outage-bound and
 * correlated rather than a steady drip, and a stranded actor bills only storage, with nothing
 * calling it to add requests, rows or duration. It is not silent either: {@link Webhooks}'
 * `handle` logs every failure at Error with shop and topic, and {@link ShopActors}' `destroy`
 * logs `status=failed`, so a burned budget is visible and can be cleaned up by hand.
 *
 * Acting on `shop/redact` as a backstop was considered and rejected. Doing it unconditionally is
 * the resurrection bug above. Guarding on a surviving `ShopSession` row avoids that but trades
 * the cost leak for a correctness risk: Shopify does not document whether `shop/redact` still
 * fires when a merchant reinstalls inside the 48-hour delay, the payload carries no timestamp
 * (`{ shop_id, shop_domain }`), and reinstall is a normal merchant flow, so a reinstalled shop
 * can read as a missed uninstall. Its session would recover on the next OAuth; its actor's
 * storage would not. Keep all three no-ops unless the suppression behavior is confirmed.
 *
 * @see https://shopify.dev/docs/apps/build/webhooks/troubleshoot
 */
const compliance = Effect.succeed(ok);

const make = Effect.gen(function* () {
  const shopify = yield* Shopify;
  const shopSessions = yield* ShopSessionRepository;
  const actors = yield* ShopActors;

  /**
   * Baton's `handleWebhook`: validates `request` (a rejection fails as `WebhookRejected` and
   * `handler` never runs), then runs `handler` under `annotateLogs({ shop, topic })`. The
   * receipt logs at Info before the handler, so a delivery is recorded even if it fails; any
   * failure or defect logs at Error and is re-raised (a tap, not a catch), so the answer is
   * non-2xx and Shopify retries.
   */
  const handle = Effect.fn("Webhooks.handle")(function* <E, R>(
    request: Request,
    handler: (
      webhook: ValidatedWebhook,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const webhook = yield* shopify.validateWebhook(request);
    return yield* Effect.gen(function* () {
      yield* Effect.logInfo(`Webhook received: shop=${webhook.shop} topic=${webhook.topic}`);
      return yield* handler(webhook);
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError(`Webhook failed: shop=${webhook.shop} topic=${webhook.topic}`, cause),
      ),
      Effect.annotateLogs({ shop: webhook.shop, topic: webhook.topic }),
    );
  });

  /**
   * Rewrites the stored scope; a shop with no session row is left without one. A payload without
   * `current` fails as a 400 {@link WebhookRejected}, as {@link ordersWebhook}'s does: a malformed
   * payload does not improve on retry, so a 500 would only burn Shopify's retries.
   */
  const scopesUpdate = Effect.fn("Webhooks.scopesUpdate")(function* (webhook: ValidatedWebhook) {
    const { current } = yield* decodeScopesUpdate(webhook.payload).pipe(
      Effect.mapError(() => new WebhookRejected({ status: 400 })),
    );
    yield* shopSessions.updateScope(webhook.shop, current.join(","));
    return ok;
  });

  /**
   * The real-time half of order intake, all five order topics. The payload is a signal, not the
   * data: REST-shaped, with no product tags or enriched line-item metadata, and trimmed to ids by
   * `include_fields` anyway, so the shop's actor fetches the order it names
   * (`ShopActors.syncOrderWebhook`, one round trip). Shopify's own OMS guidance is exactly this:
   * query the full order after each webhook, and reconcile periodically for the ones that never
   * arrived. The work is awaited inside Shopify's five-second budget. One line per delivery
   * records what it came to ({@link OrderWebhookOutcome}).
   *
   * The `ShopSession` read comes first, and no row means nothing is touched: an uninstalled
   * shop's actor must never be recreated, and any stub call would recreate it, so an order
   * webhook that arrives after `app/uninstalled` (Shopify does not order deliveries) answers
   * 200 with no actor call. Baton had no such guard.
   *
   * A payload that decodes as neither shape fails as a 400 {@link WebhookRejected}, the answer a
   * malformed delivery gets, rather than a 500: the fault is the payload, not Baton. Any other
   * failure propagates to a non-2xx too, so Shopify retries for four hours; subscriptions
   * declared in `shopify.app.toml` are never auto-deleted for consecutive failures, so a bad
   * deploy cannot silently unsubscribe a shop.
   */
  const ordersWebhook = Effect.fn("Webhooks.ordersWebhook")(function* (webhook: ValidatedWebhook) {
    const payload = yield* decodeOrdersPayload(webhook.payload).pipe(
      Effect.mapError(() => new WebhookRejected({ status: 400 })),
    );
    const { shop, topic } = webhook;
    const { orderId, updatedAt } = orderRef(payload);
    const status: OrderWebhookOutcome = Option.isNone(yield* shopSessions.find(shop))
      ? "uninstalled"
      : yield* actors.syncOrderWebhook(shop, { orderId, topic, updatedAt });
    yield* Effect.logInfo(
      `Webhooks.ordersWebhook: shop=${shop} topic=${topic} orderId=${orderId} status=${status}`,
    ).pipe(Effect.annotateLogs({ shop, topic, orderId, status }));
    return ok;
  });

  /**
   * Drains the shop's usage-event outbox before its storage goes.
   *
   * Shopify closes the billing cycle 24 hours after an uninstall and refuses
   * events after that, and the actor's `destroy` deletes the outbox outright — so
   * this is the last moment an order the merchant was already billed for can be
   * reported. Best-effort on purpose: a failed flush must not stop the destroy,
   * because the storage is billed for as long as it exists and Shopify retries
   * this webhook on a non-2xx, which would re-run the teardown rather than the
   * flush alone. The remaining count is logged so an operator can see what was
   * lost.
   */
  const flushUsageEventsAtUninstall = (shop: ShopKey) =>
    Effect.gen(function* () {
      const remaining = yield* actors.flushUsageEvents(shop);
      if (remaining === 0) return;
      yield* Effect.logWarning(
        `webhooks.app.uninstalled: shop=${shop} pending=${String(remaining)}: usage events unsent at uninstall`,
      ).pipe(Effect.annotateLogs({ shop, pending: remaining }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `webhooks.app.uninstalled: shop=${shop}: usage event flush failed`,
          cause,
        ).pipe(Effect.annotateLogs({ shop })),
      ),
    );

  /**
   * `app/uninstalled`. When a merchant uninstalls the app, their OAuth tokens are immediately
   * invalidated. Retaining stale sessions risks conflicting OAuth flows on re-install, so
   * uninstall is the one teardown point for the shop's session and its actor's storage.
   *
   * Deletes the shop's session unconditionally (`ShopSessionRepository.remove`): a single D1 call whether
   * this is the first delivery or a retry after the row is already gone, where a load-then-delete
   * would cost two on the first. The delete cascades to the shop's `Member`, `Team` and
   * `TeamMember` rows; Better Auth's users stay, since a user may belong to other shops.
   *
   * Then destroys the shop's actor (`ShopActors.destroy`) so its storage stops being billed. The
   * destroy failure is deliberately not swallowed: a genuine failure (the actor unreachable, or
   * `deleteAll` hitting its time limit, which is safe to retry until it succeeds) propagates, so
   * the answer is non-2xx and Shopify retries the idempotent teardown rather than leaking
   * storage.
   *
   * The one background path that does not check for the shop's session before touching its
   * actor: after a partial teardown (the session deleted, the destroy failed) the retry finds no
   * session and must still destroy.
   *
   * The shop's usage-event outbox is drained first ({@link flushUsageEventsAtUninstall}).
   */
  const appUninstalled = Effect.fn("Webhooks.appUninstalled")(function* (
    webhook: ValidatedWebhook,
  ) {
    yield* flushUsageEventsAtUninstall(webhook.shop);
    yield* shopSessions.remove(webhook.shop);
    yield* actors.destroy(webhook.shop);
    return ok;
  });

  /** One handler per {@link WebhookTopic}. */
  const dispatch = (webhook: ValidatedWebhook) =>
    Option.match(decodeTopic(webhook.topic), {
      onNone: () =>
        Effect.logWarning(
          `Webhooks.dispatch: shop=${webhook.shop} topic=${webhook.topic}: no handler`,
        ).pipe(Effect.as(HttpServerResponse.empty({ status: 404 }))),
      onSome: (topic) =>
        Match.value(topic).pipe(
          Match.when(
            Match.is("CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"),
            () => compliance,
          ),
          Match.when("APP_SCOPES_UPDATE", () => scopesUpdate(webhook)),
          Match.when("APP_UNINSTALLED", () => appUninstalled(webhook)),
          Match.when(
            Match.is(
              "ORDERS_CREATE",
              "ORDERS_PAID",
              "ORDERS_EDITED",
              "ORDERS_CANCELLED",
              "ORDERS_FULFILLED",
            ),
            () => ordersWebhook(webhook),
          ),
          Match.exhaustive,
        ),
    });

  /**
   * The Backend's `/webhooks/*` branch: {@link handle} over {@link dispatch}. The request goes
   * back to the web `Request` it came from, its body unread, since the HMAC is over the exact
   * raw bytes. A rejection answers its status; any other failure, already logged by `handle`,
   * answers 500.
   */
  const serve = Effect.fn("Webhooks.serve")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    return yield* handle(web, dispatch).pipe(
      Effect.catchTag("WebhookRejected", ({ status }) =>
        Effect.succeed(HttpServerResponse.empty({ status })),
      ),
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
    );
  });

  return { handle, serve };
});

/**
 * Shopify's webhooks, served by the Backend under `/webhooks/`. The Website forwards each
 * request untouched; the HMAC is the only credential, so there is no Origin check.
 */
export class Webhooks extends Context.Service<Webhooks, Effect.Success<typeof make>>()(
  "app/Webhooks",
) {
  static readonly layer = Layer.effect(Webhooks, make);
}
