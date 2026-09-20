import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import type { ShopAgent } from "@/lib/ShopAgent";

import * as ShopifyApi from "@shopify/shopify-api";
import { AgentWorkflow } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
} from "effect";

import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import {
  causeToErrorMessage,
  makeEnvLayer,
  makeLoggerLayer,
} from "@/lib/LayerEx";
import {
  bulkOrdersQueryText,
  OrdersBulkRepository,
} from "@/lib/OrdersBulkRepository";
import {
  BULK_GIVE_UP_MS,
  BULK_POLL_INTERVAL_MS,
} from "@/lib/orderSyncConstants";
import { Repository } from "@/lib/Repository";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

export interface OrdersSyncParams {
  readonly shop: string;
}

class OrdersSyncWorkflowError extends Schema.TaggedError<OrdersSyncWorkflowError>()(
  "OrdersSyncWorkflowError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * What the merchant is told when Shopify has not finished the export inside
 * {@link BULK_GIVE_UP_MS}. It is the whole of what they can do about it, and
 * re-running is always safe because the query is fixed
 * ({@link bulkOrdersQueryText}).
 */
const GAVE_UP_MESSAGE = "Shopify did not finish the export in time. Try again.";

/**
 * A permanent failure: retrying an expired refresh token or a rejected bulk
 * query only burns the retry budget, so the value has to reach the workflow
 * runtime as a `NonRetryableError` for it to stop retrying the step
 * (https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
 *
 * `Effect.die`, not `Effect.fail`, for the *type*, not the throw: either one
 * rejects `runPromise` with this exact object, since `causeSquash` unwraps
 * `Fail` and `Die` alike. `die` types as `Effect<never, never>`, which makes
 * this usable as a terminal `catchTag` handler that leaves the inner error
 * channel `never`. A `fail` would put `NonRetryableError` into `E` and
 * propagate it through every step wrapper, where nothing can handle it: it is
 * a control signal addressed to the host runtime, not an error this program
 * can recover from. The cost is that a defect bypasses `catchTag`/`catchAll`
 * on its way out, which is the intent here.
 */
const nonRetryable = (message: string) =>
  Effect.die(new NonRetryableError(message));

const toCount = (value: number | string) =>
  typeof value === "string" ? Number(value) : value;

const timedStep = <A, E, R>(
  shop: Domain.Shop,
  name: string,
  effect: Effect.Effect<A, E, R>,
  annotations: Record<string, unknown> = {},
) =>
  Effect.timed(effect).pipe(
    Effect.flatMap(([duration, value]) =>
      Effect.logDebug(
        `OrdersSyncWorkflow.step: shop=${shop} step=${name}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          step: name,
          durationMs: Duration.toMillis(duration),
          ...annotations,
        }),
        Effect.as(value),
      ),
    ),
    Effect.withLogSpan(name),
  );

/**
 * Still worth waiting for. `CANCELING` is in here on purpose: it is not a
 * terminal status, and Shopify moves through it to `CANCELED` — a poll loop
 * that stopped here would report a finished operation that has not finished.
 */
const bulkIsActive = ({ status }: Domain.BulkOperation) =>
  status === "CREATED" || status === "RUNNING" || status === "CANCELING";

/**
 * The result URL of a finished operation, or `none` when the query matched no
 * orders. `partialDataUrl` is the fallback because a bulk operation that
 * completed after a partial failure still exposes what it did export, and
 * those rows are as valid as any other under the `updatedAt` upsert guard.
 */
export const completedBulkUrl = (operation: Domain.BulkOperation) =>
  Domain.bulkOperationCompleted(operation)
    ? Effect.succeed(
        Option.fromNullOr(operation.url ?? operation.partialDataUrl),
      )
    : Effect.fail(
        new OrdersSyncWorkflowError({
          message: `Bulk operation did not complete: ${operation.status}`,
          cause: operation,
        }),
      );

export const pollBulkOrdersQuery = (id: string) =>
  Effect.gen(function* () {
    const found = yield* (yield* OrdersBulkRepository).findById(id);
    return Option.isNone(found)
      ? yield* Effect.fail(
          new OrdersSyncWorkflowError({
            message: "Bulk operation disappeared",
            cause: { id },
          }),
        )
      : found.value;
  });

const provideOrdersBulk = (session: ShopifyApi.Session) =>
  Effect.provide(
    Layer.provide(
      OrdersBulkRepository.layerNoDeps,
      Layer.provide(
        ShopifyAdmin.layerNoDeps,
        Layer.succeed(CurrentShopifySession, session),
      ),
    ),
  );

export const ensureSessionProps = (shop: Domain.Shop) =>
  Effect.gen(function* () {
    const session = yield* (yield* Shopify).ensureShopSession(shop);
    return session.toPropertyArray(true);
  }).pipe(
    Effect.catchTags({
      RefreshTokenExpiredError: (error) =>
        nonRetryable(`Refresh token expired for ${error.shop}`),
      OfflineSessionNotFoundError: (error) =>
        nonRetryable(`No offline session for shop ${error.shop}`),
      OfflineSessionInvalidError: (error) =>
        nonRetryable(`Invalid offline session for shop ${error.shop}`),
    }),
  );

export const submitBulkOrdersQuery = (now: number) =>
  Effect.gen(function* () {
    return yield* (yield* OrdersBulkRepository).submit(
      bulkOrdersQueryText(now),
    );
  }).pipe(
    Effect.catchTag("OrdersBulkRepositoryError", (error) =>
      nonRetryable(error.message),
    ),
  );

export class OrdersSyncWorkflow extends AgentWorkflow<
  ShopAgent,
  OrdersSyncParams
> {
  /**
   * D1 stays on the **primary**: a Workflow has no inbound/outbound
   * `x-d1-bookmark` and no client round trip to save, and the one read it makes
   * is `ensureShopSession`'s refresh path, where a stale replica read could miss
   * a token another actor just rotated and turn a recoverable race into a hard
   * `RefreshTokenExpiredError` — which this workflow treats as permanent. Same
   * reasoning as the Durable Object's own runtime.
   */
  protected makeRuntimeLayer() {
    const envLayer = makeEnvLayer(this.env);
    const repositoryLayer = Layer.provideMerge(
      Repository.layerNoDeps,
      Layer.mergeAll(
        D1Session.layer(this.env.D1),
        Layer.provide(D1Primary.layerNoDeps, envLayer),
        envLayer,
      ),
    );
    return Layer.merge(
      Layer.provideMerge(Shopify.layerNoDeps, repositoryLayer),
      makeLoggerLayer(this.env),
    );
  }

  /**
   * Submit the import, wait for Shopify, hand the file to the object. Four
   * steps and one loop; every concept the merchant could not predict — a
   * window, a first-run-versus-later rule, a reservation — lives nowhere,
   * because the query is fixed and the agent is the only run tracker
   * ({@link ShopAgent.syncOrders}).
   *
   * Two Cloudflare Workflows + Effect constraints dictate this shape, and both
   * are easy to get wrong:
   *
   * 1. **The runtime layer must not be able to fail.** `makeRuntimeLayer()` is
   *    built by the outer `runtime.runPromise`, *outside* any step, and a throw
   *    outside a step ends the instance in `Errored` with no retry — only steps
   *    retry. `ManagedRuntime` also caches a failed build, so even in-step
   *    retries would not rebuild it. The layer therefore provides only binding
   *    and config wrappers; nothing does I/O at build time.
   * 2. **Fallible work only happens inside a step, and step results must be
   *    JSON.** `ensureShopSession` (a D1 read plus a possible token refresh) is
   *    the one fallible setup call, so it is its own retried step, and it
   *    returns the session as a property array — the live `Session` survives the
   *    first pass but rehydrates as a plain object on replay. The session then
   *    reaches later steps as a pure `Layer.succeed` value, so the
   *    session-dependent layer chain never reintroduces a fallible build.
   *
   * The poll loop's steps are named per attempt (`poll-bulk-orders-3`) because
   * a step name is its cache key: a loop that reused one name would read the
   * first poll's answer on every pass and never see the operation finish. The
   * bound is wall-clock, not attempts, so the number of steps follows from
   * {@link BULK_GIVE_UP_MS} and {@link BULK_POLL_INTERVAL_MS} rather than from
   * a schedule nobody can hold in their head.
   *
   * `Effect.onError` is the terminal sink. It fires only once a step has
   * exhausted its retries (or a non-step failure such as `completedBulkUrl`
   * fires), and durably records the message through its own step before the
   * failure propagates — rather than relying on the wrapper's post-throw
   * notification, which is swallowed. `Effect.promise`, not `tryPromise`: an
   * exhausted step becomes a defect that must keep propagating so the instance
   * errors and the agent's `onWorkflowError` still runs.
   */
  async run(
    event: AgentWorkflowEvent<OrdersSyncParams>,
    step: AgentWorkflowStep,
  ) {
    const { shop: shopName } = event.payload;
    const shop = Schema.decodeUnknownSync(Domain.Shop)(shopName);
    const runtime = ManagedRuntime.make(this.makeRuntimeLayer());
    const agent = this.agent;

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo(`OrdersSyncWorkflow.run: shop=${shop}`);

          const sessionProps = yield* timedStep(
            shop,
            "ensure-session",
            Effect.tryPromise({
              try: () =>
                step.do("ensure-session", () =>
                  runtime.runPromise(ensureSessionProps(shop)),
                ),
              catch: (cause) =>
                new OrdersSyncWorkflowError({
                  message: "Step failed: ensure-session",
                  cause,
                }),
            }),
          );
          const session = ShopifyApi.Session.fromPropertyArray(
            sessionProps,
            true,
          );

          const submitted = yield* timedStep(
            shop,
            "run-bulk-orders-query",
            Effect.tryPromise({
              try: () =>
                step.do("run-bulk-orders-query", () =>
                  runtime.runPromise(
                    Effect.gen(function* () {
                      // The window start is the submitting step's own clock:
                      // the step result is cached, so a replay keeps the
                      // window the submitted operation actually ran with.
                      const now = yield* Clock.currentTimeMillis;
                      return yield* submitBulkOrdersQuery(now);
                    }).pipe(provideOrdersBulk(session)),
                  ),
                ),
              catch: (cause) =>
                new OrdersSyncWorkflowError({
                  message: "Step failed: run-bulk-orders-query",
                  cause,
                }),
            }),
          );

          let operation = submitted;
          for (
            let elapsed = 0;
            elapsed < BULK_GIVE_UP_MS && bulkIsActive(operation);
            elapsed += BULK_POLL_INTERVAL_MS
          ) {
            const attempt = String(elapsed / BULK_POLL_INTERVAL_MS);
            yield* Effect.tryPromise(() =>
              step.sleep(
                `wait-for-bulk-orders-${attempt}`,
                BULK_POLL_INTERVAL_MS,
              ),
            );
            operation = yield* timedStep(
              shop,
              `poll-bulk-orders-${attempt}`,
              Effect.tryPromise({
                try: () =>
                  step.do(`poll-bulk-orders-${attempt}`, () =>
                    runtime.runPromise(
                      pollBulkOrdersQuery(submitted.id).pipe(
                        provideOrdersBulk(session),
                        Effect.catchTag("OrdersSyncWorkflowError", (error) =>
                          nonRetryable(error.message),
                        ),
                      ),
                    ),
                  ),
                catch: (cause) =>
                  new OrdersSyncWorkflowError({
                    message: "Step failed: poll-bulk-orders",
                    cause,
                  }),
              }),
              { attempt, status: operation.status },
            );
          }

          /**
           * Out of patience rather than out of luck: the operation is still
           * running at Shopify, so it is cancelled before this instance goes.
           * The cancel's own failure is swallowed — the merchant is already
           * being told the import did not finish, and a failed cancel would
           * replace that message with one about a mutation they never made.
           */
          if (bulkIsActive(operation)) {
            yield* timedStep(
              shop,
              "cancel-bulk-orders",
              Effect.promise(() =>
                step.do("cancel-bulk-orders", () =>
                  runtime.runPromise(
                    Effect.gen(function* () {
                      yield* (yield* OrdersBulkRepository).cancel(submitted.id);
                    }).pipe(
                      provideOrdersBulk(session),
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `OrdersSyncWorkflow.cancel: shop=${shop} operationId=${submitted.id}: ${causeToErrorMessage(cause)}`,
                        ).pipe(
                          Effect.annotateLogs({
                            shop,
                            operationId: submitted.id,
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            return yield* Effect.fail(
              new OrdersSyncWorkflowError({
                message: GAVE_UP_MESSAGE,
                cause: operation,
              }),
            );
          }

          yield* Option.match(yield* completedBulkUrl(operation), {
            onNone: () =>
              timedStep(
                shop,
                "on-orders-sync-empty",
                Effect.tryPromise({
                  try: () =>
                    step.do("on-orders-sync-empty", () =>
                      agent.onOrdersSyncEmpty(),
                    ),
                  catch: (cause) =>
                    new OrdersSyncWorkflowError({
                      message: "Step failed: on-orders-sync-empty",
                      cause,
                    }),
                }),
              ),
            onSome: (url) =>
              timedStep(
                shop,
                "on-orders-stream",
                Effect.tryPromise({
                  /**
                   * The RPC result is deliberately dropped: a Durable Object
                   * stub return is `Serializable & Disposable`, which a step
                   * result may not be, and the counts are already logged by the
                   * object that produced them.
                   */
                  try: () =>
                    step.do("on-orders-stream", async () => {
                      await agent.onOrdersStream({ url });
                    }),
                  catch: (cause) =>
                    new OrdersSyncWorkflowError({
                      message: "Step failed: on-orders-stream",
                      cause,
                    }),
                }),
              ),
          });

          yield* Effect.logInfo(
            `OrdersSyncWorkflow.run: shop=${shop} status=complete objectCount=${String(toCount(operation.objectCount))}`,
          ).pipe(
            Effect.annotateLogs({
              objectCount: toCount(operation.objectCount),
            }),
          );
          return yield* Effect.tryPromise(() => step.reportComplete());
        }).pipe(
          Effect.onError((cause) =>
            timedStep(
              shop,
              "on-orders-sync-error",
              Effect.promise(() =>
                step.do("on-orders-sync-error", () =>
                  agent.onOrdersSyncError({
                    message: causeToErrorMessage(cause),
                  }),
                ),
              ),
            ),
          ),
          Effect.annotateLogs({ shop }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  }
}
