import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../contract/shop.ts";
import { type BulkOperation, bulkOperationCompleted } from "../domain/orders.ts";
import {
  bulkOrdersQueryText,
  OrdersBulkOperation,
  type OrdersBulkOperationError,
} from "./orders-bulk-operation.ts";
import {
  BULK_GIVE_UP_MS,
  BULK_POLL_INTERVAL_MS,
  GAVE_UP_MESSAGE,
} from "./orders-sync-constants.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import type { ShopifyUnavailable } from "./shopify.ts";
import type { ShopifyAdminError } from "./shopify-admin.ts";

export interface OrdersSyncParams {
  readonly shop: ShopKey;
}

/** A sync that cannot go on; its message is the merchant sentence ({@link sinkMessage}). */
export class OrdersSyncWorkflowError extends Schema.TaggedError<OrdersSyncWorkflowError>()(
  "OrdersSyncWorkflowError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * The banner's text for a failed sync (rule 15 on `syncOrder`): an
 * {@link OrdersSyncWorkflowError}'s own message is already the merchant
 * sentence, so it goes bare, with no tag prefix; any
 * other failure (a defect) is rendered whole, since there is no sentence to
 * prefer.
 */
export const sinkMessage = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => causeMessage(cause),
    onSome: (error) =>
      error instanceof OrdersSyncWorkflowError ? error.message : causeMessage(cause),
  });

const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) =>
      error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message,
    )
    .join("\n");

/**
 * Still worth waiting for. `CANCELING` is in here on purpose: it is not a
 * terminal status, and Shopify moves through it to `CANCELED` — a poll loop
 * that stopped here would report a finished operation that has not finished.
 */
export const bulkIsActive = ({ status }: BulkOperation) =>
  status === "CREATED" || status === "RUNNING" || status === "CANCELING";

/**
 * The result URL of a finished operation, or `none` when the query matched no
 * orders. `partialDataUrl` is the fallback because a bulk operation that
 * completed after a partial failure still exposes what it did export, and
 * those rows are as valid as any other under the `updatedAt` upsert guard.
 */
export const completedBulkUrl = (operation: BulkOperation) =>
  bulkOperationCompleted(operation)
    ? Effect.succeed(Option.fromNullOr(operation.url ?? operation.partialDataUrl))
    : Effect.fail(
        new OrdersSyncWorkflowError({
          message: `Bulk operation did not complete: ${operation.status}`,
          cause: operation,
        }),
      );

/**
 * The policy of the two Shopify steps (submit and poll), set rather than left to Cloudflare's
 * default (five retries from ten seconds, doubling): a {@link ShopifyUnavailable} is worth a few
 * quick retries, and a sync the merchant waits on should fail inside a minute, not five.
 */
const SHOPIFY_RETRIES = { limit: 3, delay: "2 seconds", backoff: "exponential" } as const;

/**
 * The body of {@link OrdersSyncWorkflow}, exported so a unit test runs it with stubbed steps.
 *
 * Submit the bulk operation, wait for Shopify, hand the file to the shop's actor. Four steps
 * and one loop; every concept the merchant could not predict — a window, a
 * first-run-versus-later rule, a reservation — lives nowhere, because the query is fixed (rule
 * 4 on `syncOrder`) and the actor is the only run tracker (`Orders.syncOpenOrders`).
 *
 * Every step and sleep name is a replay key. The poll loop's are named per attempt
 * (`poll-bulk-orders-3`) because a step name is its cache key: a loop that reused one name
 * would read the first poll's answer on every pass and never see the operation finish. The
 * bound is the attempt count, so the number of steps follows from {@link BULK_GIVE_UP_MS} and
 * {@link BULK_POLL_INTERVAL_MS} rather than from a schedule nobody can hold in their head.
 *
 * A step that dies is terminal and is never retried: a shop with no session
 * (`ensure-session`, the shop is gone), `ReauthorizationRequired` or `OfflineSessionMissing`
 * from Shopify, a mutation Shopify refused, an operation that disappeared. A failed step
 * (`ShopifyUnavailable`, an actor call) is retried by its policy. Either way the step's failure
 * reaches the body as an {@link OrdersSyncWorkflowError} naming the step, so the merchant reads
 * `Step failed: <step>` and the cause goes to the log.
 *
 * `Effect.onError` is the terminal sink, and there are no completion callbacks: the sink
 * step `on-orders-sync-error` calls the actor's `onOrdersSyncError`, which clears the tracking record
 * and writes the banner, before the failure propagates and the instance errors. It runs after
 * a die too: a die ends its own step, not the body. Only a run that dies outside any step, or
 * whose sink itself fails, leaves the record behind, and `SYNC_STALE_MS` covers that.
 */
export const ordersSyncBody = Effect.gen(function* () {
  const sessions = yield* ShopSessionRepository;
  const bulk = yield* OrdersBulkOperation;
  const actors = yield* ShopActors;

  return Effect.fn("OrdersSyncWorkflow.run")(
    function* ({ shop }: OrdersSyncParams) {
      const { instanceId: workflowId } = yield* Cloudflare.Workflows.WorkflowEvent;

      /** A step whose failure, typed or a defect, reaches the body as the merchant sentence. */
      const step = <A, E, R>(
        name: string,
        label: string,
        effect: Effect.Effect<A, E, R>,
        options?: Cloudflare.Workflows.WorkflowStepConfig,
      ) =>
        Cloudflare.Workflows.task(name, effect, options).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new OrdersSyncWorkflowError({
                message: `Step failed: ${label}`,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );

      /**
       * A Shopify step: a session-shaped failure or a refused mutation dies (retrying it only
       * burns the budget), `ShopifyUnavailable` fails and is retried by {@link SHOPIFY_RETRIES}.
       */
      const shopifyStep = <A, R>(
        name: string,
        label: string,
        effect: Effect.Effect<A, ShopifyAdminError | OrdersBulkOperationError, R>,
      ) =>
        step(
          name,
          label,
          effect.pipe(
            Effect.catchIf(
              (error): error is Exclude<typeof error, ShopifyUnavailable> =>
                error._tag !== "ShopifyUnavailable",
              (error) => Effect.die(error),
            ),
          ),
          { retries: SHOPIFY_RETRIES },
        );

      yield* Effect.logInfo(`OrdersSyncWorkflow.run: shop=${shop} workflowId=${workflowId}`);

      yield* step(
        "ensure-session",
        "ensure-session",
        sessions.find(shop).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(new Error(`No offline session for shop ${shop}`)),
              onSome: () => Effect.void,
            }),
          ),
        ),
      );

      const submitted = yield* shopifyStep(
        "run-bulk-orders-query",
        "run-bulk-orders-query",
        // The window start is the submitting step's own clock: the step result is cached, so a
        // replay keeps the window the submitted operation actually ran with.
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          bulk.submit(shop, bulkOrdersQueryText(now)),
        ),
      );

      let operation = submitted;
      for (
        let elapsed = 0;
        elapsed < BULK_GIVE_UP_MS && bulkIsActive(operation);
        elapsed += BULK_POLL_INTERVAL_MS
      ) {
        const attempt = String(elapsed / BULK_POLL_INTERVAL_MS);
        yield* Cloudflare.Workflows.sleep(`wait-for-bulk-orders-${attempt}`, BULK_POLL_INTERVAL_MS);
        operation = yield* shopifyStep(
          `poll-bulk-orders-${attempt}`,
          "poll-bulk-orders",
          bulk.findById(shop, submitted.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.die(
                    new OrdersSyncWorkflowError({
                      message: "Bulk operation disappeared",
                      cause: { id: submitted.id },
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          ),
        );
        yield* Effect.logDebug(
          `OrdersSyncWorkflow.poll: shop=${shop} attempt=${attempt} status=${operation.status}`,
        ).pipe(Effect.annotateLogs({ attempt, status: operation.status }));
      }

      /**
       * Out of patience rather than out of luck: the operation is still
       * running at Shopify, so it is cancelled before this instance goes.
       * The cancel's own failure is swallowed — the merchant is already
       * being told the sync did not finish, and a failed cancel would
       * replace that message with one about a mutation they never made.
       */
      if (bulkIsActive(operation)) {
        yield* Cloudflare.Workflows.task(
          "cancel-bulk-orders",
          bulk.cancel(shop, submitted.id).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `OrdersSyncWorkflow.cancel: shop=${shop} operationId=${submitted.id}: ${causeMessage(cause)}`,
              ).pipe(Effect.annotateLogs({ operationId: submitted.id })),
            ),
          ),
        );
        return yield* Effect.fail(
          new OrdersSyncWorkflowError({ message: GAVE_UP_MESSAGE, cause: operation }),
        );
      }

      const url = yield* completedBulkUrl(operation);
      yield* Option.match(url, {
        onNone: () =>
          step(
            "on-orders-sync-empty",
            "on-orders-sync-empty",
            actors.onOrdersSyncEmpty(shop, { workflowId }),
          ),
        onSome: (url) =>
          /**
           * The counts are dropped from the step result: the actor logs them, and a stub's
           * answer need not survive Cloudflare's serializer.
           */
          step(
            "on-orders-stream",
            "on-orders-stream",
            actors.onOrdersStream(shop, { workflowId, url }).pipe(Effect.asVoid),
          ),
      });

      const objectCount = Number(operation.objectCount);
      yield* Effect.logInfo(
        `OrdersSyncWorkflow.run: shop=${shop} status=complete objectCount=${String(objectCount)}`,
      ).pipe(Effect.annotateLogs({ objectCount }));
    },
    (body, { shop }) =>
      body.pipe(
        Effect.onError((cause) =>
          Effect.gen(function* () {
            const { instanceId: workflowId } = yield* Cloudflare.Workflows.WorkflowEvent;
            const message = sinkMessage(cause);
            yield* Effect.logError(
              `OrdersSyncWorkflow.run: shop=${shop} workflowId=${workflowId} status=failed: ${message}`,
              cause,
            );
            yield* Cloudflare.Workflows.task(
              "on-orders-sync-error",
              actors.onOrdersSyncError(shop, { workflowId, message }),
            );
          }).pipe(
            Effect.catchCause((sinkCause) =>
              Effect.logError(`OrdersSyncWorkflow.run: shop=${shop}: sink failed`, sinkCause),
            ),
          ),
        ),
        Effect.annotateLogs({ shop }),
      ),
  );
});

/**
 * The open-orders sync: a Cloudflare Workflow in the Backend's script, one instance per press,
 * created by the shop's actor (`Orders.syncOpenOrders`) and named by the `workflowId` it
 * recorded. Params `{ shop }`. The body is
 * {@link ordersSyncBody}; its services resolve in the Backend's init, which runs again in any
 * isolate an instance lands in. It reaches the actor through {@link ShopActors.layerFrom}, by
 * identity only, because the actor's implementation yields this class.
 */
export class OrdersSyncWorkflow extends Cloudflare.Workflow<OrdersSyncWorkflow>()(
  "OrdersSyncWorkflow",
  ordersSyncBody.pipe(Effect.provide(ShopActors.layerFrom)),
) {}
