import { Context, Effect, Layer, Schedule, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class KVError extends Schema.TaggedError<KVError>()("KVError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const RETRYABLE_ERROR_SIGNALS = [
  "network connection lost",
  "daemondown",
  "kv put failed: 429 too many requests",
] as const;

/**
 * 1s-base exponential backoff, jittered, at most 2 retries. The 1s base is
 * deliberate: KV enforces 1 write/sec/key, so retrying a 429 sooner would just
 * hit the rate limit again. Retrying puts unconditionally is safe because KV
 * puts are idempotent last-write-wins; the retryable signals are transient
 * runtime failures (connection loss, daemon restart) plus the per-key write
 * 429.
 */
const transientRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.setInputType<KVError>(),
  Schedule.while(({ input }) => {
    const message = input.message.toLowerCase();
    return RETRYABLE_ERROR_SIGNALS.some((signal) => message.includes(signal));
  }),
  Schedule.upTo({ times: 2 }),
);

const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new KVError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError(`KV operation failed: ${error.message}`).pipe(
        Effect.annotateLogs({ error }),
      ),
    ),
    Effect.retry(transientRetrySchedule),
  );

export class KV extends Context.Service<
  KV,
  {
    readonly get: (key: string) => Effect.Effect<string | null, KVError>;
    readonly put: (
      key: string,
      value: string,
      options?: KVNamespacePutOptions,
    ) => Effect.Effect<void, KVError>;
    readonly delete: (key: string) => Effect.Effect<void, KVError>;
  }
>()("KV") {
  static readonly layerNoDeps = Layer.effect(
    KV,
    Effect.gen(function* () {
      const { KV: kv } = yield* CloudflareEnv;
      const get = Effect.fn("KV.get")(function* (key: string) {
        return yield* tryKV(() => kv.get(key));
      });
      const put = Effect.fn("KV.put")(function* (
        key: string,
        value: string,
        options?: KVNamespacePutOptions,
      ) {
        return yield* tryKV(() => kv.put(key, value, options));
      });
      const del = Effect.fn("KV.delete")(function* (key: string) {
        return yield* tryKV(() => kv.delete(key));
      });
      return KV.of({ get, put, delete: del });
    }),
  );
}
