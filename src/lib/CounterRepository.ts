import type { SqlError } from "effect/unstable/sql";

import type * as Domain from "@/lib/Domain";

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant ("storage gave me bytes I can't turn into a valid
 * domain object"). Deliberately distinct from `SqlError.SqlError`, which
 * surfaces raw: query execution is the driver's concern, storage→domain
 * decoding is this repository's.
 */
export class CounterRepositoryError extends Schema.TaggedError<CounterRepositoryError>()(
  "CounterRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const CounterRow = Schema.Struct({
  count: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
});

/**
 * The skeleton's stand-in for a real per-shop domain, living in the Durable
 * Object's private SQLite (`ctx.storage`) rather than in D1.
 *
 * A single row under a `check (id = 1)` primary key: the constraint is what
 * makes "the shop's counter" a schema fact instead of a convention, so a second
 * row cannot be inserted by a future writer that forgot. Replace the table and
 * the two methods; keep the shape — a `SqlClient`-requiring `Layer` built over
 * the DO's storage, decoding every read through a `Domain` schema.
 */
export class CounterRepository extends Context.Service<
  CounterRepository,
  {
    readonly get: () => Effect.Effect<
      Domain.Counter,
      SqlError.SqlError | CounterRepositoryError
    >;
    /**
     * Increments and returns the new value in one statement, so concurrent
     * bumps cannot read-modify-write over each other. `updatedAt` is passed in
     * rather than read from SQLite's clock: the caller holds the `Clock`, and a
     * test can move it.
     */
    readonly bump: (
      updatedAt: number,
    ) => Effect.Effect<
      Domain.Counter,
      SqlError.SqlError | CounterRepositoryError
    >;
  }
>()("CounterRepository") {
  static readonly layer: Layer.Layer<
    CounterRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    CounterRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const decodeRow = (rows: readonly unknown[]) =>
        Schema.decodeUnknownEffect(CounterRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) =>
              new CounterRepositoryError({
                message: "Invalid Counter row",
                cause,
              }),
          ),
        );

      return CounterRepository.of({
        get: Effect.fn("CounterRepository.get")(function* () {
          return yield* decodeRow(
            yield* sql`select count, updatedAt from Counter where id = 1`,
          );
        }),
        bump: Effect.fn("CounterRepository.bump")(function* (
          updatedAt: number,
        ) {
          return yield* decodeRow(
            yield* sql`
              update Counter
              set count = count + 1, updatedAt = ${updatedAt}
              where id = 1
              returning count, updatedAt
            `,
          );
        }),
      });
    }),
  );
}
